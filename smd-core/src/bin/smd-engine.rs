//! Headless typesetter and binary-safe portable-note CLI. Never emits assets by default.
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use smd_core::{portable::{self, PortableDocument}, PdfOptions};
use std::{collections::HashMap, io::{self, Read, Write}, path::{Path, PathBuf}};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportRequest { content: String, #[serde(default)] assets: HashMap<String, String>, #[serde(default)] options: PdfOptions }

fn read_note(path: &Path) -> Result<(String, Option<PortableDocument>)> {
    let size = std::fs::metadata(path)?.len();
    if size > portable::MAX_FILE as u64 { bail!("Note exceeds 120 MB"); }
    let content = std::fs::read_to_string(path)?.trim_start_matches('\u{feff}').to_owned();
    // Content, not extension, distinguishes old text SMD from portable SMD.
    let extension = path.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
    let portable = matches!(extension.as_str(), "smd" | "fmd") && content.trim_start().starts_with('{') && content.contains("\"format\"");
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
fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("help");
    if command == "help" || command == "--help" { println!("Super MD native engine\n\nread NOTE [--offset N] [--limit N]   Markdown only; default 16000 chars\ninspect NOTE                       Format, counts, asset names; no bytes\nassets NOTE                        Image names, MIME and decoded size\nextract NOTE ASSET OUTPUT           Write one asset to a file (no stdout bytes)\npack INPUT OUTPUT.smd              Offline portable note with local images\nexport INPUT OUTPUT.pdf             Native Typst PDF (no browser print)\nexport-json OUTPUT.pdf              Prepared content/assets/options from stdin\ndoctor                             Report engine capabilities\n\nNo command auto-runs Python or downloads URLs. Existing text .smd and .fmd are readable."); return Ok(()); }
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
        "pack" => {
            let output = args.get(2).context("Expected output .smd path")?;
            let root = path.canonicalize()?.parent().context("No containing folder")?.to_path_buf();
            let packed = portable::pack(&markdown, |source| {
                if let Some(data) = note.as_ref().and_then(|n| n.assets.get(source)) { return Ok(data.clone()); }
                if source.contains("://") { bail!("Remote image requires explicit download in the app: {source}"); }
                let local = root.join(percent_encoding::percent_decode_str(source).decode_utf8()?.as_ref()).canonicalize()?;
                if !local.starts_with(&root) { bail!("Image is outside the note folder"); }
                if std::fs::metadata(&local)?.len() > portable::MAX_IMAGE as u64 { bail!("Image exceeds 25 MB"); }
                let mime = portable::asset_mime(local.to_str().context("Invalid image path")?).context("Unsupported image type")?;
                Ok(format!("data:{mime};base64,{}",STANDARD.encode(std::fs::read(local)?)))
            })?;
            atomic_write(Path::new(output),packed.encode()?.as_bytes())?;
            println!("{}",serde_json::json!({"output":output,"assets":packed.assets.len()}));
        }
        "export" => {
            let output = args.get(2).context("Expected PDF output path")?; let mut assets = HashMap::new();
            let root = path.canonicalize()?.parent().context("No containing folder")?.to_path_buf();
            for source in smd_core::image_sources(&markdown) {
                let bytes = if let Some(data) = note.as_ref().and_then(|n| n.assets.get(&source)) { portable::image_bytes(data)?.1 } else {
                    let file = root.join(percent_encoding::percent_decode_str(&source).decode_utf8()?.as_ref()).canonicalize()?;
                    if !file.starts_with(&root) { bail!("Image is outside the note folder"); }
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
