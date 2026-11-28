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
fn is_reserved_windows_name(name: &str) -> bool {
    let base = name
        .trim()
        .trim_end_matches(['.', ' '])
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ');
    matches!(
        base.to_ascii_uppercase().as_str(),
        "CON" | "PRN" | "AUX" | "NUL"
            | "COM0" | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6" | "COM7" | "COM8" | "COM9"
            | "LPT0" | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9"
            | "COM\u{00b9}" | "COM\u{00b2}" | "COM\u{00b3}"
            | "LPT\u{00b9}" | "LPT\u{00b2}" | "LPT\u{00b3}"
            | "CONIN$" | "CONOUT$" | "CLOCK$"
    )
}
fn is_portable_filename_component(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 240
        && name != "."
        && name != ".."
        && !name.ends_with(['.', ' '])
        && !name.chars().any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        && !is_reserved_windows_name(name)
}
fn portable_markdown_stem(input_path: &Path) -> String {
    let raw = input_path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') { '-' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']);
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." || trimmed.len() > 236 || is_reserved_windows_name(trimmed) {
        "Note".to_string()
    } else {
        trimmed.to_string()
    }
}
fn resolve_macos_system_alias(path: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        for (alias_str, canonical_str) in [("/var", "/private/var"), ("/tmp", "/private/tmp"), ("/etc", "/private/etc")] {
            let alias = Path::new(alias_str);
            let canonical = Path::new(canonical_str);
            if path.starts_with(alias)
                && std::fs::symlink_metadata(alias).is_ok_and(|m| m.file_type().is_symlink())
                && alias.canonicalize().ok() == canonical.canonicalize().ok()
            {
                if let Ok(rest) = path.strip_prefix(alias) {
                    return if rest.as_os_str().is_empty() {
                        canonical.to_path_buf()
                    } else {
                        canonical.join(rest)
                    };
                }
            }
        }
    }
    path.to_path_buf()
}
fn inspect_destination_path(output_dir: &Path) -> Result<(PathBuf, Vec<PathBuf>)> {
    if output_dir.as_os_str().is_empty() {
        bail!("Expected a non-empty output directory");
    }
    let probed_dir = resolve_macos_system_alias(output_dir);
    let comps: Vec<_> = probed_dir.components().collect();
    if comps.is_empty() {
        bail!("Expected a non-empty output directory");
    }
    if !probed_dir.is_absolute() {
        let dot_meta = std::fs::symlink_metadata(Path::new("."))?;
        if dot_meta.file_type().is_symlink() {
            bail!("Refusing to unpack through a symlink");
        }
        if !dot_meta.is_dir() {
            bail!("Output parent path is not a directory");
        }
    }
    let mut current = PathBuf::new();
    let mut missing_dirs: Vec<PathBuf> = Vec::new();
    for (idx, comp) in comps.iter().enumerate() {
        let is_last = idx + 1 == comps.len();
        if !missing_dirs.is_empty() {
            let std::path::Component::Normal(_) = comp else {
                bail!("Refusing to unpack through parent or non-normal path components");
            };
            current.push(comp);
            missing_dirs.push(current.clone());
            continue;
        }
        match comp {
            std::path::Component::Prefix(_) => {
                current.push(comp);
                if is_last {
                    let meta = std::fs::symlink_metadata(&current)?;
                    if meta.file_type().is_symlink() { bail!("Refusing to unpack through a symlink"); }
                    if !meta.is_dir() { bail!("Output path exists and is not a directory"); }
                }
            }
            std::path::Component::RootDir | std::path::Component::CurDir | std::path::Component::ParentDir => {
                current.push(comp);
                let meta = std::fs::symlink_metadata(&current)?;
                if meta.file_type().is_symlink() { bail!("Refusing to unpack through a symlink"); }
                if !meta.is_dir() {
                    if is_last { bail!("Output path exists and is not a directory"); }
                    else { bail!("Output parent path is not a directory"); }
                }
            }
            std::path::Component::Normal(_) => {
                current.push(comp);
                match std::fs::symlink_metadata(&current) {
                    Ok(meta) => {
                        if meta.file_type().is_symlink() { bail!("Refusing to unpack through a symlink"); }
                        if is_last && !meta.is_dir() { bail!("Output path exists and is not a directory"); }
                        if !is_last && !meta.is_dir() { bail!("Output parent path is not a directory"); }
                    }
                    Err(err) if err.kind() == io::ErrorKind::NotFound => {
                        missing_dirs.push(current.clone());
                    }
                    Err(err) => return Err(err.into()),
                }
            }
        }
    }
    Ok((current, missing_dirs))
}
/// Portable no-overwrite publication: uses exclusive `create_new` (`O_CREAT | O_EXCL` on Unix,
/// `CREATE_NEW` on Windows) directly at `path` instead of `hard_link` or overwriting `rename`.
/// This supports removable FAT/exFAT output folders without hard-link support while refusing
/// to overwrite existing files, and removes `path` immediately if writing or syncing fails.
fn write_new_file(path: &Path, data: &[u8]) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                bail!("Refusing to unpack through a symlink");
            }
            bail!("Output exists; choose an empty destination or another folder");
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(err) => return Err(err.into()),
    }
    let mut file = match std::fs::OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
            bail!("Output exists; choose an empty destination or another folder")
        }
        Err(err) => return Err(err.into()),
    };
    let write_res = (|| -> Result<()> {
        file.write_all(data)?;
        file.sync_all()?;
        Ok(())
    })();
    drop(file);
    if let Err(err) = write_res {
        let _ = std::fs::remove_file(path);
        return Err(err);
    }
    Ok(())
}
fn unpack_note(input_path: &Path, note: &PortableDocument, output_dir: &Path) -> Result<PathBuf> {
    if output_dir.as_os_str().is_empty() { bail!("Expected a non-empty output directory"); }
    note.validate()?;
    let stem = portable_markdown_stem(input_path);
    let md_name = format!("{stem}.md");
    if std::path::Path::new(&md_name).components().count() != 1 || !is_portable_filename_component(&md_name) {
        bail!("Invalid unpacked Markdown filename");
    }
    let (checked_output_dir, missing_dirs) = inspect_destination_path(output_dir)?;
    let out_existed = missing_dirs.is_empty();
    let md_target = output_dir.join(&md_name);
    let checked_md_target = checked_output_dir.join(&md_name);
    if out_existed {
        match std::fs::symlink_metadata(&checked_md_target) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    bail!("Refusing to unpack through a symlink");
                }
                bail!("Output exists; choose an empty destination or another folder");
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
    }
    let mut staged_assets: Vec<(PathBuf, Vec<u8>)> = Vec::with_capacity(note.assets.len());
    let mut seen_paths = std::collections::HashSet::new();
    seen_paths.insert(md_name.to_ascii_lowercase());
    let assets_dir = checked_output_dir.join("assets");
    let assets_existed = if out_existed {
        match std::fs::symlink_metadata(&assets_dir) {
            Ok(meta) => {
                if meta.file_type().is_symlink() { bail!("Refusing to unpack through a symlink"); }
                if !meta.is_dir() { bail!("Assets path exists and is not a directory"); }
                true
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => false,
            Err(err) => return Err(err.into()),
        }
    } else {
        false
    };
    for (name, data) in &note.assets {
        if !portable::asset_name(name) { bail!("Unsafe portable asset name: {name}"); }
        let rel = Path::new(name);
        let mut rel_components = rel.components();
        let (Some(std::path::Component::Normal(dir_part)), Some(std::path::Component::Normal(file_part)), None) =
            (rel_components.next(), rel_components.next(), rel_components.next())
        else {
            bail!("Unsafe portable asset path: {name}");
        };
        let Some(file_str) = file_part.to_str() else {
            bail!("Unsafe portable asset name: {name}");
        };
        if dir_part != "assets" || !is_portable_filename_component(file_str) {
            bail!("Unsafe portable asset name: {name}");
        }
        if !seen_paths.insert(name.to_ascii_lowercase()) { bail!("Conflicting unpacked asset path: {name}"); }
        let target = checked_output_dir.join(rel);
        if assets_existed {
            match std::fs::symlink_metadata(&target) {
                Ok(meta) => {
                    if meta.file_type().is_symlink() {
                        bail!("Refusing to unpack through a symlink");
                    }
                    bail!("Output exists; choose an empty destination or another folder");
                }
                Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                Err(err) => return Err(err.into()),
            }
        }
        let (_mime, bytes) = portable::image_bytes(data)?;
        staged_assets.push((target, bytes));
    }
    let mut created_dirs: Vec<PathBuf> = Vec::new();
    let mut created_files: Vec<PathBuf> = Vec::new();
    let mut created_assets_dir = false;
    let write_result = (|| -> Result<()> {
        for dir in &missing_dirs {
            std::fs::create_dir(dir)?;
            created_dirs.push(dir.clone());
        }
        let (verified_dir, post_missing) = inspect_destination_path(output_dir)?;
        if !post_missing.is_empty() || verified_dir != checked_output_dir {
            bail!("Destination directory changed during unpack");
        }
        let canonical_root = checked_output_dir.canonicalize()?;
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
            write_new_file(target, bytes)?;
            created_files.push(target.clone());
        }
        let md_parent = checked_md_target.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new(".")).canonicalize()?;
        if md_parent != canonical_root {
            bail!("Markdown target escapes output directory");
        }
        write_new_file(&checked_md_target, note.markdown.as_bytes())?;
        created_files.push(checked_md_target.clone());
        Ok(())
    })();
    if let Err(err) = write_result {
        for file in created_files.into_iter().rev() { let _ = std::fs::remove_file(file); }
        if created_assets_dir { let _ = std::fs::remove_dir(&assets_dir); }
        for dir in created_dirs.into_iter().rev() { let _ = std::fs::remove_dir(dir); }
        return Err(err);
    }
    Ok(md_target)
}

enum ResolvedNoteImage<'a> {
    Embedded(&'a str),
    InlineData(&'a str),
    Local { path: PathBuf, bytes: Vec<u8> },
}

fn resolve_note_image<'a>(
    root: &Path,
    note: Option<&'a PortableDocument>,
    source: &'a str,
) -> Result<ResolvedNoteImage<'a>> {
    if let Some(data) = note.and_then(|n| n.assets.get(source)) {
        return Ok(ResolvedNoteImage::Embedded(data.as_str()));
    }
    if source.starts_with("data:") {
        return Ok(ResolvedNoteImage::InlineData(source));
    }
    if source.contains("://") || source.starts_with("//") {
        bail!("Remote image requires explicit download in the app: {source}");
    }
    let local_part = source
        .split('#')
        .next()
        .unwrap_or(source)
        .split('?')
        .next()
        .unwrap_or(source);
    let file = root
        .join(percent_encoding::percent_decode_str(local_part).decode_utf8()?.as_ref())
        .canonicalize()?;
    if !file.starts_with(root) {
        bail!("Image is outside the note folder");
    }
    if std::fs::metadata(&file)?.len() > portable::MAX_IMAGE as u64 {
        bail!("Image exceeds 25 MB");
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&file)?
        .take(portable::MAX_IMAGE as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > portable::MAX_IMAGE {
        bail!("Image exceeds 25 MB");
    }
    Ok(ResolvedNoteImage::Local { path: file, bytes })
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
            let packed = portable::pack(&markdown, |source| match resolve_note_image(&root, note.as_ref(), source)? {
                ResolvedNoteImage::Embedded(data) => Ok(data.to_owned()),
                ResolvedNoteImage::InlineData(data) => {
                    portable::image_bytes(data)?;
                    Ok(data.to_owned())
                }
                ResolvedNoteImage::Local { path: local, bytes } => {
                    let mime = portable::asset_mime(
                        local.file_name().and_then(|n| n.to_str()).context("Invalid image path")?,
                    )
                    .context("Unsupported image type")?;
                    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
                }
            })?;
            atomic_write(Path::new(output),&packed.encode_compressed()?)?;
            println!("{}",serde_json::json!({"output":output,"assets":packed.assets.len()}));
        }
        "export" => {
            let output = args.get(2).context("Expected PDF output path")?; let mut assets = HashMap::new();
            let root = path.canonicalize()?.parent().context("No containing folder")?.to_path_buf();
            for source in smd_core::image_sources(&markdown) {
                if assets.contains_key(&source) {
                    continue;
                }
                let bytes = match resolve_note_image(&root, note.as_ref(), &source)? {
                    ResolvedNoteImage::Embedded(data) | ResolvedNoteImage::InlineData(data) => portable::image_bytes(data)?.1,
                    ResolvedNoteImage::Local { bytes, .. } => bytes,
                };
                assets.insert(source, bytes);
            }
            atomic_write(Path::new(output),&smd_core::export(&markdown,&PdfOptions::default(),&assets)?)?;
            println!("{}",serde_json::json!({"output":output}));
        }
        _ => bail!("Unknown command. Run smd-engine --help"),
    }
    Ok(())
}
fn main() { if let Err(error) = run() { eprintln!("{error:#}"); std::process::exit(1); } }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_and_fat_reserved_names_cover_dotted_stems_and_asset_basenames() {
        for bad in [
            "CON.smd",
            "CON.chapter.smd",
            "con.a.b.smd",
            "PRN.notes.smd",
            "aux.v2.smd",
            "NUL.smd",
            "COM0.smd",
            "COM1.chapter.smd",
            "COM9 .draft.smd",
            "LPT0.smd",
            "lpt1.notes.smd",
            "LPT9.appendix.smd",
            "COM\u{00b9}.chapter.smd",
            "LPT\u{00b3}.smd",
            "CONIN$.smd",
            "CLOCK$.chapter.smd",
        ] {
            assert_eq!(portable_markdown_stem(Path::new(bad)), "Note", "expected fallback for {bad}");
        }

        for (input, expected) in [
            ("lesson.smd", "lesson"),
            ("CONCEPT.smd", "CONCEPT"),
            ("CONSOLE.chapter.smd", "CONSOLE.chapter"),
            ("COM10.smd", "COM10"),
            ("LPT10.notes.smd", "LPT10.notes"),
            ("Lecture: 1?.smd", "Lecture- 1-"),
        ] {
            assert_eq!(portable_markdown_stem(Path::new(input)), expected);
        }

        for bad_asset in [
            "CON.svg",
            "con.diagram.svg",
            "AUX.png",
            "aux.v1.webp",
            "PRN.jpg",
            "NUL.gif",
            "com0.svg",
            "com1.figure.svg",
            "lpt1.svg",
            "lpt9.notes.avif",
            "trailing.",
            "trailing ",
            "bad:name.svg",
        ] {
            assert!(!is_portable_filename_component(bad_asset), "expected rejection for {bad_asset}");
        }

        for ok_asset in ["image-1.svg", "AUXILIARY.svg", "CONSOLE.diagram.png", "com10.svg", "lpt10.webp"] {
            assert!(is_portable_filename_component(ok_asset), "expected acceptance for {ok_asset}");
        }
    }

    #[test]
    fn preserves_existing_151_to_159_char_asset_bundles_across_read_unpack_export_and_resave() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("smd-engine-compat-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let compat_basename = format!("{}.svg", "a".repeat(155));
        assert_eq!(compat_basename.len(), 159);
        let compat_key = format!("assets/{compat_basename}");
        let svg_bytes = b"<svg xmlns='http://www.w3.org/2000/svg' width='32' height='16'><rect width='32' height='16' fill='#386a57'/></svg>";
        let svg_url = format!("data:image/svg+xml;base64,{}", STANDARD.encode(svg_bytes));
        let markdown = format!("# Existing Note\n\n![Figure](<{compat_key}>)\n");
        let bundle = PortableDocument::new(markdown.clone(), std::collections::BTreeMap::from([(compat_key.clone(), svg_url)]));
        let bundle_path = dir.join("legacy.smd");
        atomic_write(&bundle_path, &bundle.encode_compressed().unwrap()).unwrap();

        let (loaded_md, loaded_note) = read_note(&bundle_path).unwrap();
        let mut note = loaded_note.expect("portable note");
        assert_eq!(loaded_md, markdown);
        assert!(note.assets.contains_key(&compat_key));

        let unpacked_dir = dir.join("unpacked");
        let unpacked_md = unpack_note(&bundle_path, &note, &unpacked_dir).unwrap();
        assert_eq!(std::fs::read_to_string(&unpacked_md).unwrap(), markdown);
        assert_eq!(std::fs::read(unpacked_dir.join(&compat_key)).unwrap(), svg_bytes);

        let pdf_assets = HashMap::from([(compat_key.clone(), portable::image_bytes(&note.assets[&compat_key]).unwrap().1)]);
        let pdf_bytes = smd_core::export(&note.markdown, &PdfOptions::default(), &pdf_assets).unwrap();
        assert!(pdf_bytes.starts_with(b"%PDF-"));

        note.markdown.push_str("\nRe-saved paragraph.\n");
        atomic_write(&bundle_path, &note.encode_compressed().unwrap()).unwrap();
        let (resaved_md, resaved_note) = read_note(&bundle_path).unwrap();
        let resaved_note = resaved_note.expect("portable note");
        assert!(resaved_md.contains(&compat_key));
        assert_eq!(portable::image_bytes(&resaved_note.assets[&compat_key]).unwrap().1, svg_bytes);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_note_image_enforces_canonical_folder_and_caps_growing_reads_at_max_image() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("smd-engine-resolve-{}-{nanos}", std::process::id()));
        let notes = dir.join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        std::fs::write(
            dir.join("outside.svg"),
            b"<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8'/>",
        )
        .unwrap();
        let canonical_root = notes.canonicalize().unwrap();

        let outside_err = match resolve_note_image(&canonical_root, None, "../outside.svg?v=1#frag") {
            Ok(_) => panic!("expected outside-root local image to fail"),
            Err(err) => err,
        };
        assert!(outside_err.to_string().contains("Image is outside the note folder"), "got: {outside_err:#}");

        let prefix = b"<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8'><!--";
        let suffix = b"--></svg>";
        let mut exact_svg = Vec::with_capacity(portable::MAX_IMAGE + 1);
        exact_svg.extend_from_slice(prefix);
        exact_svg.resize(portable::MAX_IMAGE - suffix.len(), b'a');
        exact_svg.extend_from_slice(suffix);
        assert_eq!(exact_svg.len(), portable::MAX_IMAGE);
        let exact_path = notes.join("exact.svg");
        std::fs::write(&exact_path, &exact_svg).unwrap();

        match resolve_note_image(&canonical_root, None, "exact.svg?v=1#ok").unwrap() {
            ResolvedNoteImage::Local { bytes, .. } => assert_eq!(bytes.len(), portable::MAX_IMAGE),
            _ => panic!("expected local image resolution"),
        }

        exact_svg.push(b'\n');
        std::fs::write(&exact_path, &exact_svg).unwrap();
        let over_err = match resolve_note_image(&canonical_root, None, "exact.svg?v=2#over") {
            Ok(_) => panic!("expected MAX_IMAGE + 1 local image to fail"),
            Err(err) => err,
        };
        assert!(over_err.to_string().contains("Image exceeds 25 MB"), "got: {over_err:#}");

        #[cfg(unix)]
        {
            let fifo_path = notes.join("growing.svg");
            assert!(
                std::process::Command::new("mkfifo")
                    .arg(&fifo_path)
                    .status()
                    .unwrap()
                    .success(),
                "mkfifo should create a streaming pipe inside canonical_root"
            );
            assert_eq!(std::fs::metadata(&fifo_path).unwrap().len(), 0);

            let fifo_writer_path = fifo_path.clone();
            let opened = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let opened_writer = std::sync::Arc::clone(&opened);
            let writer = std::thread::spawn(move || -> usize {
                let Ok(mut out) = std::fs::OpenOptions::new().write(true).open(&fifo_writer_path) else {
                    return 0;
                };
                opened_writer.store(true, std::sync::atomic::Ordering::SeqCst);
                let chunk = [b'x'; 65_536];
                let target = portable::MAX_IMAGE * 2;
                let mut written = 0usize;
                while written < target {
                    let step = chunk.len().min(target - written);
                    match out.write(&chunk[..step]) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => written += n,
                    }
                }
                written
            });

            let stream_err = match resolve_note_image(&canonical_root, None, "growing.svg?live=1#stream") {
                Ok(_) => panic!("expected growing stream past MAX_IMAGE to fail"),
                Err(err) => err,
            };
            if !opened.load(std::sync::atomic::Ordering::SeqCst) {
                let _ = std::fs::File::open(&fifo_path);
            }
            let written = writer.join().unwrap();
            assert!(stream_err.to_string().contains("Image exceeds 25 MB"), "got: {stream_err:#}");
            assert!(
                written > portable::MAX_IMAGE && written <= portable::MAX_IMAGE + 4 * 1024 * 1024,
                "expected bounded read to stop at MAX_IMAGE + 1 instead of reading 50 MB, writer wrote {written} bytes"
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }
}
