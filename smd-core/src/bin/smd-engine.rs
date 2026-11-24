//! Headless typesetter and binary-safe portable-note CLI. Never emits assets by default.
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use smd_core::{portable::{self, PortableDocument}, PdfOptions};
use std::{collections::HashMap, io::{self, Read, Write}, path::{Path, PathBuf}};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportRequest { content: String, #[serde(default)] assets: HashMap<String, String>, #[serde(default)] options: PdfOptions }
#[derive(Deserialize)]
struct FormatMarker { format: Option<String> }

fn read_note(path: &Path) -> Result<(String, Option<PortableDocument>)> {
    if std::fs::metadata(path)?.len() > portable::MAX_FILE as u64 { bail!("Note exceeds 120 MB"); }
    let mut raw = Vec::new();
    std::fs::File::open(path)?.take(portable::MAX_FILE as u64 + 1).read_to_end(&mut raw)?;
    if raw.len() > portable::MAX_FILE { bail!("Note exceeds 120 MB"); }
    if raw.starts_with(&[0x1f, 0x8b]) {
        let note = PortableDocument::decode_bytes(&raw)?;
        return Ok((note.markdown.clone(), Some(note)));
    }
    let mut content = String::from_utf8(raw)?;
    if content.starts_with('\u{feff}') { content.drain(..3); }
    // Content, not extension, distinguishes old text SMD from portable SMD.
    let extension = path.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
    // Ignore other JSON fields during probing: do not allocate a second copy
    // of every asset just to recognize a provider-renamed envelope.
    let portable = content.trim_start().starts_with('{') && (
        serde_json::from_str::<FormatMarker>(&content).ok().is_some_and(|header| matches!(header.format.as_deref(), Some("supermd-smd" | "supermd-fmd")))
        || matches!(extension.as_str(), "smd" | "fmd") && content.contains("\"format\"")
    );
    if portable { let note = PortableDocument::decode(&content)?; Ok((note.markdown.clone(), Some(note))) }
    else { Ok((content, None)) }
}
fn atomic_write(path: &Path, data: &[u8]) -> Result<()> {
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let name = path.file_name().context("Expected an output filename")?.to_string_lossy();
    let temp = parent.join(format!(".{name}.{}.tmp", std::process::id()));
    let mut created = false;
    let result = (|| { let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp)?; created = true; file.write_all(data)?; file.sync_all()?; std::fs::rename(&temp, path)?; Ok(()) })();
    if result.is_err() && created { let _ = std::fs::remove_file(temp); } result
}
fn write_new_atomic(path: &Path, data: &[u8]) -> Result<()> {
    if std::fs::symlink_metadata(path).is_ok() { bail!("Output exists; choose an empty destination or another folder"); }
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let name = path.file_name().context("Expected an output filename")?.to_string_lossy();
    let temp = parent.join(format!(".{name}.{}.{}.tmp", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()));
    let mut created = false;
    let result = (|| -> Result<()> {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
        created = true;
        file.write_all(data)?;
        file.sync_all()?;
        drop(file);
        match std::fs::hard_link(&temp, path) {
            Ok(()) => { let _ = std::fs::remove_file(&temp); created = false; Ok(()) }
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => bail!("Output exists; choose an empty destination or another folder"),
            Err(err) => Err(err.into()),
        }
    })();
    if created { let _ = std::fs::remove_file(&temp); }
    result
}
fn unpack_note(input_path: &Path, note: &PortableDocument, output_dir: &Path) -> Result<PathBuf> {
    note.validate()?;
    let stem = input_path.file_stem().and_then(|s| s.to_str()).map(str::trim)
        .filter(|s| !s.is_empty() && *s != "." && *s != ".." && s.len() <= 236 && !s.chars().any(|c| c.is_control() || matches!(c, '/' | '\\')))
        .unwrap_or("Note");
    let md_name = format!("{stem}.md");
    if std::path::Path::new(&md_name).components().count() != 1 { bail!("Invalid unpacked Markdown filename"); }
    let mut probe = Some(output_dir);
    let mut existing_ancestor: Option<&Path> = None;
    while let Some(current) = probe {
        let candidate = if current.as_os_str().is_empty() { Path::new(".") } else { current };
        match std::fs::symlink_metadata(candidate) {
            Ok(meta) => {
                if meta.file_type().is_symlink() { bail!("Refusing to unpack through a symlink"); }
                if candidate == output_dir && !meta.is_dir() { bail!("Output path exists and is not a directory"); }
                if candidate != output_dir && !meta.is_dir() { bail!("Output parent path is not a directory"); }
                existing_ancestor = Some(candidate);
                break;
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => probe = current.parent(),
            Err(err) => return Err(err.into()),
        }
    }
    if let Some(ancestor) = existing_ancestor {
        if let Ok(suffix) = output_dir.strip_prefix(ancestor) {
            if suffix.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
                bail!("Refusing to unpack through parent or non-normal path components");
            }
        }
    }
    let out_existed = std::fs::symlink_metadata(output_dir).is_ok();
    let md_target = output_dir.join(&md_name);
    if out_existed && std::fs::symlink_metadata(&md_target).is_ok() {
        bail!("Output exists; choose an empty destination or another folder");
    }
    let mut staged_assets: Vec<(PathBuf, Vec<u8>)> = Vec::with_capacity(note.assets.len());
    let mut seen_paths = std::collections::HashSet::new();
    seen_paths.insert(md_name.to_ascii_lowercase());
    let assets_dir = output_dir.join("assets");
    let assets_existed = out_existed && std::fs::symlink_metadata(&assets_dir).is_ok();
    if assets_existed {
        let meta = std::fs::symlink_metadata(&assets_dir)?;
        if meta.file_type().is_symlink() { bail!("Refusing to unpack through a symlink"); }
        if !meta.is_dir() { bail!("Assets path exists and is not a directory"); }
    }
    for (name, data) in &note.assets {
        if !portable::asset_name(name) { bail!("Unsafe portable asset name: {name}"); }
        let rel = Path::new(name);
        if rel.components().count() != 2 || !rel.components().all(|c| matches!(c, std::path::Component::Normal(_))) {
            bail!("Unsafe portable asset path: {name}");
        }
        if !seen_paths.insert(name.to_ascii_lowercase()) { bail!("Conflicting unpacked asset path: {name}"); }
        let target = output_dir.join(rel);
        if out_existed && std::fs::symlink_metadata(&target).is_ok() {
            bail!("Output exists; choose an empty destination or another folder");
        }
        let (_mime, bytes) = portable::image_bytes(data)?;
        staged_assets.push((target, bytes));
    }
    if !out_existed { std::fs::create_dir_all(output_dir)?; }
    if std::fs::symlink_metadata(output_dir)?.file_type().is_symlink() { bail!("Refusing to unpack through a symlink"); }
    let canonical_root = output_dir.canonicalize()?;
    let mut created_files: Vec<PathBuf> = Vec::new();
    let mut created_assets_dir = false;
    let write_result = (|| -> Result<()> {
        if !staged_assets.is_empty() {
            if !assets_existed { std::fs::create_dir(&assets_dir)?; created_assets_dir = true; }
            if std::fs::symlink_metadata(&assets_dir)?.file_type().is_symlink() { bail!("Refusing to unpack through a symlink"); }
            let canonical_assets = assets_dir.canonicalize()?;
            if !canonical_assets.starts_with(&canonical_root) || canonical_assets.parent() != Some(canonical_root.as_path()) {
                bail!("Asset directory escapes output directory");
            }
        }
        for (target, bytes) in &staged_assets {
            let parent = target.parent().context("Missing asset directory")?.canonicalize()?;
            if !parent.starts_with(&canonical_root) { bail!("Asset target escapes output directory"); }
            write_new_atomic(target, bytes)?;
            created_files.push(target.clone());
        }
        if md_target.parent().context("Missing output directory")?.canonicalize()? != canonical_root {
            bail!("Markdown target escapes output directory");
        }
        write_new_atomic(&md_target, note.markdown.as_bytes())?;
        created_files.push(md_target.clone());
        Ok(())
    })();
    if let Err(err) = write_result {
        for file in created_files.into_iter().rev() { let _ = std::fs::remove_file(file); }
        if created_assets_dir { let _ = std::fs::remove_dir(&assets_dir); }
        if !out_existed { let _ = std::fs::remove_dir(output_dir); }
        return Err(err);
    }
    Ok(md_target)
}
fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("help");
    if command == "validate-theme" {
        let mut input=String::new();io::stdin().take(smd_core::theme::MAX_THEME as u64+1).read_to_string(&mut input)?;
        println!("{}",smd_core::theme::response(&input));return Ok(());
    }
    if command == "help" || command == "--help" { println!("Super MD native engine\n\nread NOTE [--offset N] [--limit N]   Markdown only; default 16000 chars\ninspect NOTE                       Format, counts, asset names; no bytes\nassets NOTE                        Image names, MIME and decoded size\nextract NOTE ASSET OUTPUT           Write one asset to a file (no stdout bytes)\nunpack NOTE OUTPUT_DIR              Extract Markdown and assets into a folder\npack INPUT OUTPUT.smd              Offline portable note with local images\nexport INPUT OUTPUT.pdf             Native Typst PDF (no browser print)\nexport-json OUTPUT.pdf              Prepared content/assets/options from stdin\nvalidate-theme                     Validate theme JSON from stdin\ndoctor                             Report engine capabilities\n\nNo command auto-runs Python or downloads URLs. Existing text .smd and .fmd are readable."); return Ok(()); }
    if command == "doctor" { println!("{{\"engine\":\"typst-mitex\",\"browserPrint\":false,\"portable\":\"supermd-smd\",\"legacyFmd\":true,\"automaticPythonExecution\":false}}"); return Ok(()); }
    if command == "export-json" {
        let output = args.get(1).context("Expected PDF output path")?;
        let mut input = String::new(); io::stdin().take(portable::MAX_FILE as u64 + 1).read_to_string(&mut input)?;
        if input.len() > portable::MAX_FILE { bail!("Export request exceeds 120 MB"); }
        let request: ExportRequest = serde_json::from_str(&input)?;
        let assets = request.assets.into_iter().map(|(name,data)| Ok((name,STANDARD.decode(data)?))).collect::<Result<HashMap<_,_>>>()?;
        atomic_write(Path::new(output), &smd_core::export(&request.content, &request.options, &assets)?)?;
        println!("{}", serde_json::json!({"output": output})); return Ok(());
    }
    let path = PathBuf::from(args.get(1).context("Expected note path")?);
    let (markdown, note) = read_note(&path)?;
    match command {
        "read" => {
            let option = |name: &str, default: usize| -> Result<usize> { args.iter().position(|x| x == name).map(|i| args.get(i+1).context("Missing option value")?.parse().context("Invalid character offset/limit")).unwrap_or(Ok(default)) };
            let offset = option("--offset",0)?; let limit = option("--limit",16000)?.min(100000);
            print!("{}", markdown.chars().skip(offset).take(limit).collect::<String>());
            if markdown.chars().count() > offset + limit { eprintln!("\nMore text available: use --offset {} --limit {}",offset+limit,limit); }
        }
        "inspect" | "assets" => {
            let assets = note.as_ref().map(|n| n.assets.iter().map(|(name,data)| { let (mime, bytes) = portable::image_bytes(data).expect("validated"); serde_json::json!({"name":name,"mime":mime,"bytes":bytes.len()}) }).collect::<Vec<_>>()).unwrap_or_default();
            if command == "assets" { println!("{}",serde_json::to_string_pretty(&assets)?); }
            else { println!("{}",serde_json::to_string_pretty(&serde_json::json!({"format":note.as_ref().map(|n| n.format.as_str()).unwrap_or("markdown"),"version":note.as_ref().map(|n| n.version),"characters":markdown.chars().count(),"assets":assets}))?); }
        }
        "extract" => {
            let name = args.get(2).context("Expected asset name")?; let output = args.get(3).context("Expected output filename")?;
            let data = note.as_ref().context("This note is not portable")?.assets.get(name).context("No such asset")?;
            if Path::new(output).exists() { bail!("Output exists; choose another filename"); }
            atomic_write(Path::new(output), &portable::image_bytes(data)?.1)?;
            println!("{}",serde_json::json!({"output":output,"asset":name}));
        }
        "unpack" => {
            if args.len() != 3 { bail!("Expected usage: smd-engine unpack NOTE OUTPUT_DIR"); }
            let output_dir = Path::new(args.get(2).context("Expected output directory")?);
            let portable_note = note.as_ref().context("This note is not portable")?;
            let markdown_path = unpack_note(&path, portable_note, output_dir)?;
            println!("{}", serde_json::json!({"output": output_dir, "markdown": markdown_path, "assets": portable_note.assets.len()}));
        }
        "pack" => {
            let output = args.get(2).context("Expected output .smd path")?;
            let root = path.canonicalize()?.parent().context("No containing folder")?.to_path_buf();
            let packed = portable::pack(&markdown, |source| {
                if let Some(data) = note.as_ref().and_then(|n| n.assets.get(source)) { return Ok(data.clone()); }
                if source.starts_with("data:") { portable::image_bytes(source)?; return Ok(source.to_owned()); }
                if source.contains("://") { bail!("Remote image requires explicit download in the app: {source}"); }
                let local = root.join(percent_encoding::percent_decode_str(source).decode_utf8()?.as_ref()).canonicalize()?;
                if !local.starts_with(&root) { bail!("Image is outside the note folder"); }
                if std::fs::metadata(&local)?.len() > portable::MAX_IMAGE as u64 { bail!("Image exceeds 25 MB"); }
                let mime = portable::asset_mime(local.to_str().context("Invalid image path")?).context("Unsupported image type")?;
                Ok(format!("data:{mime};base64,{}",STANDARD.encode(std::fs::read(local)?)))
            })?;
            atomic_write(Path::new(output),&packed.encode_compressed()?)?;
            println!("{}",serde_json::json!({"output":output,"assets":packed.assets.len()}));
        }
        "export" => {
            let output = args.get(2).context("Expected PDF output path")?; let mut assets = HashMap::new();
            let root = path.canonicalize()?.parent().context("No containing folder")?.to_path_buf();
            for source in smd_core::image_sources(&markdown) {
                let bytes = if let Some(data) = note.as_ref().and_then(|n| n.assets.get(&source)) { portable::image_bytes(data)?.1 }
                else if source.starts_with("data:") { portable::image_bytes(&source)?.1 }
                else {
                    if source.contains("://") { bail!("Remote image requires explicit download in the app: {source}"); }
                    let file = root.join(percent_encoding::percent_decode_str(&source).decode_utf8()?.as_ref()).canonicalize()?;
                    if !file.starts_with(&root) { bail!("Image is outside the note folder"); }
                    if std::fs::metadata(&file)?.len() > portable::MAX_IMAGE as u64 { bail!("Image exceeds 25 MB"); }
                    std::fs::read(file)?
                }; assets.insert(source,bytes);
            }
            atomic_write(Path::new(output),&smd_core::export(&markdown,&PdfOptions::default(),&assets)?)?;
            println!("{}",serde_json::json!({"output":output}));
        }
        _ => bail!("Unknown command. Run smd-engine --help"),
    }
    Ok(())
}
fn main() { if let Err(error) = run() { eprintln!("{error:#}"); std::process::exit(1); } }
