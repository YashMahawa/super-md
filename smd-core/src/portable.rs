//! Portable SMD v1: a bounded UTF-8 JSON envelope. Editors expose only `markdown`.
//! The former FMD envelope remains readable, without silently renaming user files.
use anyhow::{bail, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use flate2::{bufread::GzDecoder, Compression, GzBuilder};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, io::{self, Cursor, Read, Write}};

pub const MAX_FILE: usize = 120_000_000;
pub const MAX_IMAGE: usize = 25_000_000;
pub const MAX_ASSET_FILENAME_LEN: usize = 150;
pub const MAX_COMPAT_ASSET_FILENAME_LEN: usize = 159;
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
fn valid_asset_basename(name: &str, max_len: usize) -> bool {
    !name.is_empty() && name.len() <= max_len && name != "." && name != ".." && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
pub fn new_asset_name(name: &str) -> bool {
    name.strip_prefix("assets/").is_some_and(|name| valid_asset_basename(name, MAX_ASSET_FILENAME_LEN))
}
pub fn asset_name(name: &str) -> bool {
    name.strip_prefix("assets/").is_some_and(|name| valid_asset_basename(name, MAX_COMPAT_ASSET_FILENAME_LEN))
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
    pub fn new(markdown: String, assets: BTreeMap<String, String>) -> Self { Self { format: "supermd-smd".into(), version: 1, markdown, assets } }
    pub fn validate(&self) -> Result<()> {
        if !["supermd-smd", "supermd-fmd"].contains(&self.format.as_str()) || self.version != 1 { bail!("Unsupported portable SMD format/version"); }
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

    /// Encode the unchanged v1 JSON envelope in a deterministic, single-member gzip stream.
    pub fn encode_compressed(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let mut output = Vec::new();
        {
            let mut gzip = GzBuilder::new().mtime(0).operating_system(255).write(&mut output, Compression::best());
            struct Bounded<'a, W: Write> { inner: &'a mut W, bytes: usize }
            impl<W: Write> Write for Bounded<'_, W> {
                fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                    if self.bytes.saturating_add(bytes.len()) > MAX_FILE { return Err(io::Error::new(io::ErrorKind::InvalidData, "SMD JSON exceeds 120 MB")); }
                    let written = self.inner.write(bytes)?; self.bytes += written; Ok(written)
                }
                fn flush(&mut self) -> io::Result<()> { self.inner.flush() }
            }
            let mut bounded = Bounded { inner: &mut gzip, bytes: 0 };
            serde_json::to_writer(&mut bounded, self)?;
            drop(bounded);
            gzip.finish()?;
        }
        if output.len() > MAX_FILE { bail!("Compressed SMD file exceeds 120 MB"); }
        Ok(output)
    }

    /// Decode legacy JSON or the default gzip-wrapped v1 envelope. Both limits are
    /// applied before JSON parsing, and gzip must contain exactly one complete member.
    pub fn decode_bytes(input: &[u8]) -> Result<Self> {
        if input.len() > MAX_FILE { bail!("SMD file exceeds 120 MB"); }
        if input.starts_with(&[0x1f, 0x8b]) {
            let cursor = Cursor::new(input);
            let mut decoder = GzDecoder::new(cursor);
            let mut json = Vec::new();
            decoder.by_ref().take((MAX_FILE + 1) as u64).read_to_end(&mut json)?;
            if json.len() > MAX_FILE { bail!("Inflated SMD exceeds 120 MB"); }
            let consumed = decoder.into_inner().position() as usize;
            if consumed != input.len() { bail!("SMD gzip stream contains trailing or concatenated data"); }
            let document: Self = serde_json::from_slice(&json)?;
            document.validate()?;
            Ok(document)
        } else {
            let text = std::str::from_utf8(input)?;
            Self::decode(text)
        }
    }
}

/// Offline CLI packing uses parser offsets so code and other Markdown are not
/// reformatted. Reference-style images are replaced at their rendered use site.
pub fn pack(markdown: &str, mut load: impl FnMut(&str) -> Result<String>) -> Result<PortableDocument> {
    use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
    let fm_end = crate::frontmatter::parse_frontmatter(markdown).map(|fm| fm.end).unwrap_or(0);
    let body = &markdown[fm_end..];
    let options = Options::ENABLE_TABLES | Options::ENABLE_FOOTNOTES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_MATH;
    let mut events = Parser::new_ext(body, options).into_offset_iter();
    let mut assets = BTreeMap::new(); let mut shared = BTreeMap::<String, String>::new(); let mut edits = Vec::new();
    while let Some((event, range)) = events.next() {
        if let Event::Start(Tag::Image { dest_url, title, .. }) = event {
            let source = dest_url.to_string(); let mut alt = String::new();
            for (event, _) in events.by_ref() { match event { Event::End(TagEnd::Image) => break, Event::Text(text) | Event::Code(text) => alt.push_str(&text), Event::SoftBreak | Event::HardBreak => alt.push(' '), _ => {} } }
            let name = if let Some(name) = shared.get(&source) { name.clone() } else {
                let data = if source.starts_with("data:") { source.clone() } else { load(&source)? };
                let (mime, _) = image_bytes(&data)?; let extension = match mime { "image/svg+xml" => "svg", "image/jpeg" => "jpg", _ => mime.trim_start_matches("image/") };
                let name = format!("assets/image-{}.{}", assets.len() + 1, extension);
                if !new_asset_name(&name) { bail!("Unsafe FMD asset name: {name}"); }
                assets.insert(name.clone(), data); shared.insert(source, name.clone()); name
            };
            let label = alt.replace('\\', "\\\\").replace('[', "\\[").replace(']', "\\]");
            let title = if title.is_empty() { String::new() } else { format!(" \"{}\"", title.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', " ")) };
            edits.push(((range.start + fm_end)..(range.end + fm_end), format!("![{label}](<{name}>{title})")));
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
        for name in ["../x", "assets/../x", "assets/x/y", "/x", "assets/.", "assets/.."] {
            assert!(!asset_name(name));
            assert!(!new_asset_name(name));
        }
        let svg_bytes = b"<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'><rect width='24' height='24' fill='#386a57'/></svg>";
        let svg_data = format!("data:image/svg+xml;base64,{}", STANDARD.encode(svg_bytes));
        let max_new_key = format!("assets/{}.svg", "a".repeat(146));
        let compat_mid_key = format!("assets/{}.svg", "a".repeat(147));
        let compat_max_key = format!("assets/{}.svg", "a".repeat(155));
        let over_compat_key = format!("assets/{}.svg", "a".repeat(156));
        assert!(new_asset_name(&max_new_key));
        assert!(asset_name(&max_new_key));
        for compat_key in [&compat_mid_key, &compat_max_key] {
            assert!(!new_asset_name(compat_key));
            assert!(asset_name(compat_key));
            let initial_md = format!("# Legacy bundle\n\n![Diagram](<{compat_key}>)\n");
            let legacy = PortableDocument::new(initial_md.clone(), BTreeMap::from([(compat_key.clone(), svg_data.clone())]));
            let mut reopened = PortableDocument::decode_bytes(&legacy.encode_compressed().unwrap()).unwrap();
            assert_eq!(reopened.markdown, initial_md);
            assert_eq!(image_bytes(&reopened.assets[compat_key]).unwrap().1, svg_bytes);
            let pdf_assets = std::collections::HashMap::from([(compat_key.clone(), image_bytes(&reopened.assets[compat_key]).unwrap().1)]);
            let pdf = crate::export(&reopened.markdown, &crate::PdfOptions::default(), &pdf_assets).unwrap();
            assert!(pdf.starts_with(b"%PDF-"));
            reopened.markdown.push_str("\nUpdated note paragraph.\n");
            let resaved = PortableDocument::decode_bytes(&reopened.encode_compressed().unwrap()).unwrap();
            assert!(resaved.markdown.contains(compat_key));
            assert_eq!(image_bytes(&resaved.assets[compat_key]).unwrap().1, svg_bytes);
        }
        for invalid in [over_compat_key.as_str(), "assets/.", "assets/.."] {
            assert!(!new_asset_name(invalid));
            assert!(!asset_name(invalid));
            assert!(PortableDocument::new("notes".into(), BTreeMap::from([(invalid.to_string(), svg_data.clone())])).validate().is_err());
        }
        assert!(image_bytes("data:text/html;base64,eA==").is_err());
        let mut doc = PortableDocument::new("notes".into(), BTreeMap::new()); doc.version = 2; assert!(doc.encode().is_err());
    }
    #[test] fn compressed_v1_round_trip_is_deterministic_and_preserves_assets() {
        let svg = "<svg xmlns='http://www.w3.org/2000/svg'><text>α</text></svg>".as_bytes();
        let doc = PortableDocument::new("# α\n\n![Proof](assets/proof.svg)\n".into(), BTreeMap::from([("assets/proof.svg".into(), format!("data:image/svg+xml;base64,{}", STANDARD.encode(svg)))]));
        let first = doc.encode_compressed().unwrap();
        assert_eq!(first, doc.encode_compressed().unwrap());
        assert_eq!(&first[..2], &[0x1f, 0x8b]);
        let reopened = PortableDocument::decode_bytes(&first).unwrap();
        assert_eq!(reopened.markdown, doc.markdown);
        assert_eq!(image_bytes(&reopened.assets["assets/proof.svg"]).unwrap().1, svg);
        assert_eq!(PortableDocument::decode(&doc.encode().unwrap()).unwrap().markdown, doc.markdown);
    }
    #[test] fn rejects_truncated_and_concatenated_gzip_members() {
        let doc = PortableDocument::new("source".into(), BTreeMap::new());
        let encoded = doc.encode_compressed().unwrap();
        assert!(PortableDocument::decode_bytes(&encoded[..encoded.len()-2]).is_err());
        let mut joined = encoded.clone(); joined.extend_from_slice(&encoded);
        assert!(PortableDocument::decode_bytes(&joined).is_err());
        let mut trailing = encoded.clone(); trailing.push(0);
        assert!(PortableDocument::decode_bytes(&trailing).is_err());
    }
    #[test] fn decodes_and_round_trips_existing_159_char_basename_and_caps_new_names_at_150() {
        let svg_bytes = b"<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16'><circle cx='8' cy='8' r='6' fill='#386a57'/></svg>";
        let svg_data = format!("data:image/svg+xml;base64,{}", STANDARD.encode(svg_bytes));
        let basename_159 = format!("{}.svg", "b".repeat(155));
        assert_eq!(basename_159.len(), 159);
        let key_159 = format!("assets/{basename_159}");
        let markdown = format!("# Existing Envelope\n\n![Figure](<{key_159}>)\n");
        let raw_envelope = serde_json::json!({
            "format": "supermd-smd",
            "version": 1,
            "markdown": markdown,
            "assets": { &key_159: svg_data },
        })
        .to_string();

        let decoded = PortableDocument::decode(&raw_envelope).unwrap();
        assert_eq!(decoded.markdown, markdown);
        assert_eq!(image_bytes(&decoded.assets[&key_159]).unwrap().1, svg_bytes);

        let reencoded_json = decoded.encode().unwrap();
        let reopened_json = PortableDocument::decode(&reencoded_json).unwrap();
        assert_eq!(reopened_json.markdown, markdown);
        assert_eq!(reopened_json.assets, decoded.assets);

        let reencoded_gzip = decoded.encode_compressed().unwrap();
        let reopened_gzip = PortableDocument::decode_bytes(&reencoded_gzip).unwrap();
        assert_eq!(reopened_gzip.markdown, markdown);
        assert_eq!(image_bytes(&reopened_gzip.assets[&key_159]).unwrap().1, svg_bytes);

        let max_new_150 = format!("assets/{}.svg", "b".repeat(146));
        let over_new_151 = format!("assets/{}.svg", "b".repeat(147));
        assert_eq!(max_new_150.strip_prefix("assets/").unwrap().len(), 150);
        assert_eq!(over_new_151.strip_prefix("assets/").unwrap().len(), 151);
        assert!(new_asset_name(&max_new_150));
        assert!(!new_asset_name(&over_new_151));
        assert!(!new_asset_name(&key_159));
    }
}
