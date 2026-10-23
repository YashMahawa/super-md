//! Bound Android's staging-directory import before allocating image/font bytes.
use anyhow::{bail, Context, Result};
use std::{collections::{HashMap, HashSet}, fs, io::Read, path::Path};

pub fn load_referenced_assets(markdown: &str, directory: &Path) -> Result<HashMap<String, Vec<u8>>> {
    let referenced: HashSet<_> = crate::image_sources(markdown).into_iter().collect();
    let mut assets = HashMap::new();
    let mut total = 0usize;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let font = name.starts_with("__font_") && (name.ends_with(".ttf") || name.ends_with(".otf"));
        if !font && !referenced.contains(&name) { continue; }
        // Staging assets must be regular local files, never links to unrelated
        // storage. Inspect limits before allocating, then bound the actual read
        // too in case a file grows after its metadata was observed.
        if !entry.file_type()?.is_file() { bail!("PDF asset is not a regular file: {name}"); }
        let limit = if font { 20_000_000 } else { crate::portable::MAX_IMAGE };
        let size = entry.metadata()?.len();
        if size > limit as u64 { bail!("PDF asset exceeds its supported size: {name}"); }
        let remaining = crate::portable::MAX_FILE.saturating_sub(total);
        if size > remaining as u64 { bail!("PDF assets exceed the 120 MB memory budget"); }
        let mut bytes = Vec::new();
        // The validated length is known: reserve once rather than repeatedly
        // growing/copying a large asset on memory-constrained Android devices.
        bytes.try_reserve_exact(size as usize)
            .with_context(|| format!("Not enough memory for PDF asset: {name}"))?;
        fs::File::open(entry.path()).with_context(|| format!("Cannot open PDF asset: {name}"))?
            .take(limit.min(remaining) as u64 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > limit || bytes.len() > remaining { bail!("PDF asset grew beyond its memory budget: {name}"); }
        total += bytes.len();
        assets.insert(name, bytes);
    }
    Ok(assets)
}
