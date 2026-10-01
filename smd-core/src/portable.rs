//! FMD v1: a bounded, UTF-8 JSON envelope. Editors expose only `markdown`.
use anyhow::{bail, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const MAX_FILE: usize = 120_000_000;
pub const MAX_IMAGE: usize = 25_000_000;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PortableDocument {
    pub format: String,
    pub version: u32,
    pub markdown: String,
    pub assets: BTreeMap<String, String>,
}
pub fn asset_mime(name: &str) -> Option<&'static str> {
    match name.rsplit('.').next()?.to_ascii_lowercase().as_str() { "png" => Some("image/png"), "jpg" | "jpeg" => Some("image/jpeg"), "svg" => Some("image/svg+xml"), "gif" => Some("image/gif"), "webp" => Some("image/webp"), "avif" => Some("image/avif"), _ => None }
}
pub fn asset_name(name: &str) -> bool {
    name.strip_prefix("assets/").is_some_and(|name| !name.is_empty() && name.len() < 160 && name != "." && name != ".." && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)))
}
pub fn image_bytes(data: &str) -> Result<(&str, Vec<u8>)> {
    let (header, encoded) = data.split_once(",").ok_or_else(|| anyhow::anyhow!("Invalid image data"))?;
    let mime = header.strip_prefix("data:").and_then(|s| s.strip_suffix(";base64")).ok_or_else(|| anyhow::anyhow!("Expected a base64 image"))?;
    if !["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml"].contains(&mime) { bail!("Unsupported image type: {mime}"); }
    if encoded.len() > MAX_IMAGE * 4 / 3 + 4 { bail!("Image exceeds 25 MB"); }
    let bytes = STANDARD.decode(encoded)?;
    if bytes.len() > MAX_IMAGE { bail!("Image exceeds 25 MB"); }
    Ok((mime, bytes))
}
impl PortableDocument {
    pub fn new(markdown: String, assets: BTreeMap<String, String>) -> Self { Self { format: "supermd-fmd".into(), version: 1, markdown, assets } }
    pub fn validate(&self) -> Result<()> {
        if self.format != "supermd-fmd" || self.version != 1 { bail!("Unsupported FMD format/version"); }
        if self.markdown.len() > 20_000_000 || self.assets.len() > 512 { bail!("FMD document is too large"); }
        let mut total = 0;
        for (name, data) in &self.assets {
            if !asset_name(name) { bail!("Unsafe FMD asset name: {name}"); }
            let (mime, bytes) = image_bytes(data)?;
            if asset_mime(name) != Some(mime) { bail!("FMD image extension does not match its type: {name}"); }
            total += bytes.len();
            if total > 75_000_000 { bail!("FMD assets exceed 75 MB in total"); }
        }
        Ok(())
    }
    pub fn decode(input: &str) -> Result<Self> {
        if input.len() > MAX_FILE { bail!("FMD file exceeds 120 MB"); }
        let document: Self = serde_json::from_str(input)?;
        document.validate()?;
        Ok(document)
    }
    pub fn encode(&self) -> Result<String> { self.validate()?; let value = serde_json::to_string(self)?; if value.len() > MAX_FILE { bail!("FMD file exceeds 120 MB"); } Ok(value) }
}

/// Offline CLI packing uses parser offsets so code and other Markdown are not
/// reformatted. Reference-style images are replaced at their rendered use site.
pub fn pack(markdown: &str, mut load: impl FnMut(&str) -> Result<String>) -> Result<PortableDocument> {
    use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
    let mut events = Parser::new_ext(markdown, Options::all()).into_offset_iter();
    let mut assets = BTreeMap::new(); let mut shared = BTreeMap::<String, String>::new(); let mut edits = Vec::new();
    while let Some((event, range)) = events.next() {
        if let Event::Start(Tag::Image { dest_url, title, .. }) = event {
            let source = dest_url.to_string(); let mut alt = String::new();
            for (event, _) in events.by_ref() { match event { Event::End(TagEnd::Image) => break, Event::Text(text) | Event::Code(text) => alt.push_str(&text), Event::SoftBreak | Event::HardBreak => alt.push(' '), _ => {} } }
            let name = if let Some(name) = shared.get(&source) { name.clone() } else {
                let data = if source.starts_with("data:") { source.clone() } else { load(&source)? };
                let (mime, _) = image_bytes(&data)?; let extension = match mime { "image/svg+xml" => "svg", "image/jpeg" => "jpg", _ => mime.trim_start_matches("image/") };
                let name = format!("assets/image-{}.{}", assets.len() + 1, extension); assets.insert(name.clone(), data); shared.insert(source, name.clone()); name
            };
            let label = alt.replace('\\', "\\\\").replace('[', "\\[").replace(']', "\\]");
            let title = if title.is_empty() { String::new() } else { format!(" \"{}\"", title.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', " ")) };
            edits.push((range, format!("![{label}](<{name}>{title})")));
        }
    }
    let mut content = markdown.to_string();
    for (range, image) in edits.into_iter().rev() { content.replace_range(range, &image); }
    let bundle = PortableDocument::new(content, assets); bundle.validate()?; Ok(bundle)
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn round_trips_markdown_without_putting_bytes_in_the_editor() {
        let doc = PortableDocument::new("![Proof](assets/proof.svg)\n\n```mermaid\nA --> B\n```".into(), BTreeMap::from([("assets/proof.svg".into(), format!("data:image/svg+xml;base64,{}", STANDARD.encode(b"<svg xmlns='http://www.w3.org/2000/svg'/>")))]));
        let reopened = PortableDocument::decode(&doc.encode().unwrap()).unwrap();
        assert_eq!(reopened.markdown, doc.markdown); assert_eq!(reopened.assets, doc.assets); assert!(!reopened.markdown.contains("base64"));
    }
    #[test] fn rejects_traversal_active_payloads_and_unknown_versions() {
        for name in ["../x", "assets/../x", "assets/x/y", "/x"] { assert!(!asset_name(name)); }
        assert!(image_bytes("data:text/html;base64,eA==").is_err());
        let mut doc = PortableDocument::new("notes".into(), BTreeMap::new()); doc.version = 2; assert!(doc.encode().is_err());
    }
}
