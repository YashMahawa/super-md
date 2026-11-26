//! The same local typesetter is used by desktop and Android. No browser print layout.
pub mod portable;
pub mod theme;
pub mod pdf_assets;
pub mod frontmatter;
mod diagram;
mod equations;
mod math_compatibility;
mod step_grid;
mod study;
mod typesetter;
pub use study::strip_percent_comments;
#[doc(hidden)]
pub use typesetter::{diagnostics, COMEMO_EVICT_MAX_AGE, CUSTOM_FONT_CACHE_MAX_BYTES, CUSTOM_FONT_CACHE_MAX_ENTRIES};
pub(crate) use typesetter::{is_font_asset, validate_asset_path};
use math_compatibility::compatible_math;
use anyhow::{bail, Result};
use pulldown_cmark::{Alignment, CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PdfOptions {
    pub page_size: String,
    pub margin: f32,
    pub font_size: f32,
    pub line_height: f32,
    pub paragraph_spacing: f32,
    pub font_family: String,
    pub page_numbers: bool,
    pub themed: bool,
    pub theme_accent: String,
}
impl Default for PdfOptions {
    fn default() -> Self {
        Self { page_size: "a4".into(), margin: 14., font_size: 10.5, line_height: 1.4, paragraph_spacing: 0.65, font_family: "Manrope".into(), page_numbers: true, themed: false, theme_accent: "#386a57".into() }
    }
}
impl PdfOptions {
    pub fn validate(&self) -> Result<()> {
        if !["a3", "a4", "a5", "a6", "iso-b4", "iso-b5", "iso-b6", "letter", "legal", "tabloid", "executive"].contains(&self.page_size.as_str()) { bail!("Unsupported page size"); }
        for (name, value, min, max) in [("margin", self.margin, 4., 60.), ("font size", self.font_size, 5., 24.), ("line height", self.line_height, 0.9, 2.2), ("paragraph spacing", self.paragraph_spacing, 0., 3.)] {
            if !value.is_finite() || value < min || value > max { bail!("Invalid {name}: expected {min} to {max}"); }
        }
        if self.font_family.len() > 120 { bail!("Font name is too long"); }
        if self.theme_accent.len() != 7 || !self.theme_accent.starts_with('#') || !self.theme_accent[1..].chars().all(|c| c.is_ascii_hexdigit()) { bail!("Invalid PDF theme accent"); }
        Ok(())
    }
}

fn string(value: &str) -> String { serde_json::to_string(value).unwrap() }
fn text(value: &str) -> String { format!("#text({})", string(value)) }

fn fmt_num(value: f64) -> String {
    if (value - value.round()).abs() < 1e-6 {
        format!("{}", value.round() as i64)
    } else {
        format!("{value:.4}").trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn parse_typst_width(raw: &str) -> Option<String> {
    let clean = raw.trim().trim_matches(['"', '\'']).trim().trim_end_matches(';').trim();
    if clean.is_empty() {
        return None;
    }
    let lower = clean.to_ascii_lowercase();
    if let Some(num) = lower.strip_suffix('%') {
        let v: f64 = num.trim().parse().ok()?;
        return (v.is_finite() && v > 0.0).then(|| format!("{}%", fmt_num(v)));
    }
    if let Some(num) = lower.strip_suffix("px") {
        let v: f64 = num.trim().parse().ok()?;
        return (v.is_finite() && v > 0.0).then(|| format!("{}pt", fmt_num(v * 0.75)));
    }
    for unit in ["pt", "mm", "cm", "in"] {
        if let Some(num) = lower.strip_suffix(unit) {
            let v: f64 = num.trim().parse().ok()?;
            return (v.is_finite() && v > 0.0).then(|| format!("{}{unit}", fmt_num(v)));
        }
    }
    let v: f64 = lower.parse().ok()?;
    (v.is_finite() && v > 0.0).then(|| format!("{}pt", fmt_num(v * 0.75)))
}

fn parse_typst_zoom(raw: &str) -> Option<String> {
    let clean = raw.trim().trim_matches(['"', '\'']).trim().trim_end_matches(';').trim();
    if clean.is_empty() {
        return None;
    }
    let lower = clean.to_ascii_lowercase();
    if let Some(num) = lower.strip_suffix('%') {
        let v: f64 = num.trim().parse().ok()?;
        return (v.is_finite() && v > 0.0).then(|| format!("{}%", fmt_num(v)));
    }
    let v: f64 = lower.parse().ok()?;
    (v.is_finite() && v > 0.0).then(|| format!("{}%", fmt_num(v * 100.0)))
}

fn format_smd_image(key: &str, width: Option<&str>, zoom: Option<&str>) -> String {
    match (width, zoom) {
        (None, None) => format!("#smd-image({})", string(key)),
        (Some(w), None) => format!("#smd-image({}, width: {w})", string(key)),
        (None, Some(z)) => format!("#smd-image({}, zoom: {z})", string(key)),
        (Some(w), Some(z)) => format!("#smd-image({}, width: {w}, zoom: {z})", string(key)),
    }
}

pub(crate) fn strip_html_comments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find("<!--") {
        out.push_str(&rest[..start]);
        if let Some(end) = rest[start + 4..].find("-->") {
            rest = &rest[start + 4 + end + 3..];
        } else {
            return out;
        }
    }
    out.push_str(rest);
    out
}

fn decode_html_attr(value: &str) -> String {
    if !value.contains('&') {
        return value.to_string();
    }
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp + 1..];
        if let Some(semi) = after.bytes().take(12).position(|b| b == b';') {
            let entity = &after[..semi];
            let decoded = if entity.eq_ignore_ascii_case("amp") {
                Some('&')
            } else if entity.eq_ignore_ascii_case("lt") {
                Some('<')
            } else if entity.eq_ignore_ascii_case("gt") {
                Some('>')
            } else if entity.eq_ignore_ascii_case("quot") {
                Some('"')
            } else if entity.eq_ignore_ascii_case("apos") {
                Some('\'')
            } else if let Some(hex) = entity.strip_prefix("#x").or_else(|| entity.strip_prefix("#X")) {
                u32::from_str_radix(hex, 16).ok().filter(|&c| c > 0).and_then(char::from_u32)
            } else if let Some(dec) = entity.strip_prefix('#') {
                dec.parse::<u32>().ok().filter(|&c| c > 0).and_then(char::from_u32)
            } else {
                None
            };
            if let Some(ch) = decoded {
                out.push(ch);
                rest = &after[semi + 1..];
                continue;
            }
        }
        out.push('&');
        rest = after;
    }
    out.push_str(rest);
    out
}

pub(crate) struct ScannedHtmlTag<'a> {
    pub(crate) name: &'a str,
    pub(crate) closing: bool,
    pub(crate) end: usize,
    attrs: Vec<(&'a str, String)>,
}

impl<'a> ScannedHtmlTag<'a> {
    pub(crate) fn attr(&self, attr_name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(attr_name))
            .map(|(_, v)| v.as_str())
    }
}

pub(crate) fn scan_html_tag(input: &str, start: usize) -> Option<ScannedHtmlTag<'_>> {
    let bytes = input.as_bytes();
    if bytes.get(start) != Some(&b'<') {
        return None;
    }
    let mut pos = start + 1;
    let mut closing = false;
    if bytes.get(pos) == Some(&b'/') {
        closing = true;
        pos += 1;
    }
    if !bytes.get(pos).is_some_and(u8::is_ascii_alphabetic) {
        return None;
    }
    let name_start = pos;
    pos += 1;
    while bytes.get(pos).is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'-') {
        pos += 1;
    }
    let name = &input[name_start..pos];
    let mut attrs = Vec::new();
    if closing {
        while bytes.get(pos).is_some_and(u8::is_ascii_whitespace) {
            pos += 1;
        }
        return (bytes.get(pos) == Some(&b'>')).then_some(ScannedHtmlTag {
            name,
            closing: true,
            end: pos + 1,
            attrs,
        });
    }
    if let Some(&b) = bytes.get(pos) {
        if !b.is_ascii_whitespace() && b != b'/' && b != b'>' {
            return None;
        }
    }
    while pos < bytes.len() {
        while bytes.get(pos).is_some_and(u8::is_ascii_whitespace) {
            pos += 1;
        }
        if pos >= bytes.len() {
            return None;
        }
        if bytes[pos] == b'>' {
            return Some(ScannedHtmlTag { name, closing: false, end: pos + 1, attrs });
        }
        if bytes[pos] == b'/' && bytes.get(pos + 1) == Some(&b'>') {
            return Some(ScannedHtmlTag { name, closing: false, end: pos + 2, attrs });
        }
        if bytes[pos] == b'/' {
            pos += 1;
            continue;
        }
        let attr_start = pos;
        while bytes.get(pos).is_some_and(|b| b.is_ascii_alphanumeric() || matches!(*b, b'_' | b'.' | b':' | b'-')) {
            pos += 1;
        }
        if pos == attr_start || !matches!(bytes[attr_start], b'A'..=b'Z' | b'a'..=b'z' | b'_' | b':') {
            return None;
        }
        let attr_name = &input[attr_start..pos];
        while bytes.get(pos).is_some_and(u8::is_ascii_whitespace) {
            pos += 1;
        }
        let attr_val = if bytes.get(pos) == Some(&b'=') {
            pos += 1;
            while bytes.get(pos).is_some_and(u8::is_ascii_whitespace) {
                pos += 1;
            }
            let &first = bytes.get(pos)?;
            if first == b'"' || first == b'\'' {
                let val_start = pos + 1;
                let rel_end = input[val_start..].find(first as char)?;
                let raw_val = &input[val_start..val_start + rel_end];
                pos = val_start + rel_end + 1;
                decode_html_attr(raw_val)
            } else {
                let val_start = pos;
                while let Some(&b) = bytes.get(pos) {
                    if b.is_ascii_whitespace()
                        || matches!(b, b'"' | b'\'' | b'=' | b'<' | b'>' | b'`')
                        || (b == b'/' && bytes.get(pos + 1) == Some(&b'>'))
                    {
                        break;
                    }
                    pos += 1;
                }
                if pos == val_start {
                    return None;
                }
                decode_html_attr(&input[val_start..pos])
            }
        } else {
            String::new()
        };
        if !attrs.iter().any(|(k, _)| k.eq_ignore_ascii_case(attr_name)) {
            attrs.push((attr_name, attr_val));
        }
    }
    None
}

fn scan_html_tags<'a>(input: &'a str, tag_name: &str) -> Vec<ScannedHtmlTag<'a>> {
    let mut tags = Vec::new();
    let bytes = input.as_bytes();
    let mut pos = 0;
    while pos < bytes.len() {
        let Some(rel_lt) = bytes[pos..].iter().position(|&b| b == b'<') else {
            break;
        };
        let lt = pos + rel_lt;
        if input[lt..].starts_with("<!--") {
            if let Some(end) = input[lt + 4..].find("-->") {
                pos = lt + 4 + end + 3;
                continue;
            }
            break;
        }
        if let Some(tag) = scan_html_tag(input, lt) {
            pos = tag.end;
            if !tag.closing && tag.name.eq_ignore_ascii_case(tag_name) {
                tags.push(tag);
            }
        } else {
            pos = lt + 1;
        }
    }
    tags
}

fn css_prop(style: &str, prop_name: &str) -> Option<String> {
    let mut found = None;
    for decl in style.split(';') {
        let Some((name, val)) = decl.split_once(':') else { continue };
        if name.trim().eq_ignore_ascii_case(prop_name) {
            let clean = val.trim();
            let clean = if clean.len() >= 10 && clean[clean.len() - 10..].eq_ignore_ascii_case("!important") {
                clean[..clean.len() - 10].trim()
            } else {
                clean
            };
            if !clean.is_empty() {
                found = Some(clean.to_string());
            }
        }
    }
    found
}

pub(crate) fn is_page_break_div(raw_html: &str) -> bool {
    for tag in scan_html_tags(raw_html, "div") {
        if let Some(style) = tag.attr("style") {
            for (prop, expected) in [
                ("page-break-after", "always"),
                ("page-break-before", "always"),
                ("break-after", "page"),
                ("break-before", "page"),
            ] {
                if css_prop(style, prop).is_some_and(|v| v.eq_ignore_ascii_case(expected)) {
                    return true;
                }
            }
        }
        if let Some(class) = tag.attr("class") {
            if class
                .split_whitespace()
                .any(|t| t.eq_ignore_ascii_case("page-break") || t.eq_ignore_ascii_case("pagebreak"))
            {
                return true;
            }
        }
    }
    false
}

pub(crate) struct HtmlImageSpec {
    src: String,
    width: Option<String>,
    zoom: Option<String>,
}

pub(crate) fn parse_html_images(raw_html: &str) -> Vec<HtmlImageSpec> {
    let mut out = Vec::new();
    for tag in scan_html_tags(raw_html, "img") {
        let Some(src) = tag.attr("src").map(str::trim).filter(|s| !s.is_empty()) else { continue };
        let style = tag.attr("style").unwrap_or_default();
        let width = css_prop(style, "width")
            .and_then(|w| parse_typst_width(&w))
            .or_else(|| tag.attr("width").and_then(parse_typst_width));
        let zoom = css_prop(style, "zoom").and_then(|z| parse_typst_zoom(&z));
        out.push(HtmlImageSpec { src: src.to_string(), width, zoom });
    }
    out
}

fn parse_brace_image_attrs(inner: &str) -> (Option<String>, Option<String>) {
    let mut width = None;
    let mut zoom = None;
    let mut rest = inner.trim();
    while !rest.is_empty() {
        rest = rest.trim_start();
        if rest.is_empty() {
            break;
        }
        if let Some(eq_pos) = rest.find('=') {
            let token_end = rest.find(char::is_whitespace).unwrap_or(rest.len());
            if eq_pos < token_end {
                let key = rest[..eq_pos].trim();
                let after = rest[eq_pos + 1..].trim_start();
                let (val, next_rest) = if let Some(q) = after.chars().next().filter(|c| *c == '"' || *c == '\'') {
                    let body = &after[1..];
                    if let Some(end) = body.find(q) {
                        (&body[..end], &body[end + 1..])
                    } else {
                        (body, "")
                    }
                } else {
                    let end = after.find(char::is_whitespace).unwrap_or(after.len());
                    (&after[..end], &after[end..])
                };
                if key.eq_ignore_ascii_case("width") {
                    width = parse_typst_width(val);
                } else if key.eq_ignore_ascii_case("zoom") {
                    zoom = parse_typst_zoom(val);
                }
                rest = next_rest;
                continue;
            }
        }
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        rest = &rest[end..];
    }
    (width, zoom)
}

fn consume_image_brace_attrs<'a>(
    events: &mut std::iter::Peekable<std::vec::IntoIter<Event<'a>>>,
) -> (Option<String>, Option<String>, Option<String>) {
    if !matches!(events.peek(), Some(Event::Text(first)) if first.starts_with('{')) {
        return (None, None, None);
    }
    let mut combined = String::new();
    let mut count = 0usize;
    let mut close_idx = None;
    for event in events.clone() {
        let Event::Text(piece) = event else { break };
        count += 1;
        if let Some(pos) = piece.find('}') {
            let prefix = &piece[..pos];
            if prefix.contains('\n') || prefix.contains('\r') {
                break;
            }
            close_idx = Some(combined.len() + pos);
            combined.push_str(&piece);
            break;
        }
        if piece.contains('\n') || piece.contains('\r') {
            break;
        }
        combined.push_str(&piece);
        if combined.len() > 512 {
            break;
        }
    }
    let Some(end) = close_idx else { return (None, None, None) };
    let (width, zoom) = parse_brace_image_attrs(&combined[1..end]);
    if width.is_none() && zoom.is_none() {
        return (None, None, None);
    }
    for _ in 0..count {
        events.next();
    }
    let remainder = (end + 1 < combined.len()).then(|| combined[end + 1..].to_string());
    (width, zoom, remainder)
}

fn parse_positive_number_str(s: &str) -> Option<&str> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    let (int_part, frac_part) = match t.split_once('.') {
        Some((a, b)) => (a, Some(b)),
        None => (t, None),
    };
    if int_part.is_empty() || !int_part.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if let Some(frac) = frac_part {
        if frac.is_empty() || !frac.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
    }
    let val: f64 = t.parse().ok()?;
    (val.is_finite() && val > 0.0).then_some(t)
}

fn parse_obsidian_pipe_spec<'a>(path: &'a str, spec: Option<&'a str>) -> (&'a str, Option<&'a str>) {
    let Some(spec) = spec else { return (path, None) };
    let (caption_opt, dim_candidate) = match spec.rsplit_once('|') {
        Some((cap, last)) => (Some(cap.strip_suffix('\\').unwrap_or(cap).trim()), last.trim()),
        None => (None, spec.trim()),
    };
    let width_part = match dim_candidate.split_once(['x', 'X']) {
        Some((w, h)) => {
            if parse_positive_number_str(h).is_none() {
                return (spec, None);
            }
            w
        }
        None => dim_candidate,
    };
    if let Some(width) = parse_positive_number_str(width_part) {
        let alt = caption_opt.filter(|c| !c.is_empty()).unwrap_or(path);
        (alt, Some(width))
    } else {
        (spec, None)
    }
}

fn normalize_obsidian_slice(slice: &str) -> String {
    let mut out = String::with_capacity(slice.len());
    let mut rest = slice;
    while let Some(pos) = rest.find("![[") {
        out.push_str(&rest[..pos]);
        let after_open = &rest[pos + 3..];
        if let Some(close) = after_open.find("]]") {
            let inner = &after_open[..close];
            if !inner.is_empty() && !inner.contains(['[', ']', '\r', '\n']) {
                let (raw_path, spec) = match inner.split_once('|') {
                    Some((p, s)) => (p, Some(s)),
                    None => (inner, None),
                };
                let path = if spec.is_some() && raw_path.ends_with('\\') {
                    &raw_path[..raw_path.len() - 1]
                } else {
                    raw_path
                }
                .trim();
                if !path.is_empty() {
                    let (alt_raw, width) = parse_obsidian_pipe_spec(path, spec);
                    let alt = alt_raw.replace('\\', "\\\\").replace('[', "\\[").replace(']', "\\]");
                    let escaped_path = path.replace('>', "%3E");
                    if let Some(w) = width {
                        out.push_str(&format!("![{alt}](<{escaped_path}>){{width={w}}}"));
                    } else {
                        out.push_str(&format!("![{alt}](<{escaped_path}>)"));
                    }
                    rest = &after_open[close + 2..];
                    continue;
                }
            }
        }
        out.push_str("![[");
        rest = after_open;
    }
    out.push_str(rest);
    out
}

/// Rewrite prose Obsidian `![[...]]` embeds outside code, HTML, and math spans.
fn normalize_obsidian_embeds(input: &str) -> String {
    if !input.contains("![[") {
        return input.to_string();
    }
    let mut masked: Vec<std::ops::Range<usize>> = Vec::new();
    let mut in_code_block = false;
    for (event, range) in Parser::new_ext(input, Options::ENABLE_MATH).into_offset_iter() {
        match event {
            Event::Start(Tag::CodeBlock(_)) => {
                in_code_block = true;
                masked.push(range);
            }
            Event::End(TagEnd::CodeBlock) => {
                in_code_block = false;
            }
            Event::Code(_) | Event::Html(_) | Event::InlineHtml(_) | Event::InlineMath(_) | Event::DisplayMath(_)
                if !in_code_block =>
            {
                masked.push(range);
            }
            _ => {}
        }
    }
    masked.sort_by_key(|r| r.start);
    let mut out = String::with_capacity(input.len());
    let mut cursor = 0usize;
    for range in masked {
        if range.start > cursor {
            out.push_str(&normalize_obsidian_slice(&input[cursor..range.start]));
        }
        if range.end > cursor {
            let from = cursor.max(range.start);
            out.push_str(&input[from..range.end]);
            cursor = range.end;
        }
    }
    if cursor < input.len() {
        out.push_str(&normalize_obsidian_slice(&input[cursor..]));
    }
    out
}

pub fn image_sources(markdown: &str) -> Vec<String> {
    let body = frontmatter::strip_frontmatter(markdown);
    let stripped = strip_percent_comments(body);
    let normalized = normalize_callouts_body(&stripped);
    let mut sources = Vec::new();
    let options = Options::ENABLE_TABLES | Options::ENABLE_FOOTNOTES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_SUBSCRIPT | Options::ENABLE_SUPERSCRIPT | Options::ENABLE_TASKLISTS | Options::ENABLE_MATH;
    let mut events = Parser::new_ext(&normalized, options);
    while let Some(event) = events.next() {
        match event {
            Event::Start(Tag::Image { dest_url, .. }) => sources.push(dest_url.to_string()),
            Event::Start(Tag::HtmlBlock) => {
                let mut html = String::new();
                for event in events.by_ref() {
                    if event == Event::End(TagEnd::HtmlBlock) { break; }
                    if let Event::Html(piece) | Event::Text(piece) = event { html.push_str(&piece); }
                }
                for img in parse_html_images(&html) {
                    sources.push(img.src);
                }
            }
            Event::Html(html) | Event::InlineHtml(html) => {
                for img in parse_html_images(&html) {
                    sources.push(img.src);
                }
            }
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(lang))) if ["smd-steps", "smd-step-grid"].contains(&lang.as_ref()) => {
                let mut code = String::new();
                for event in events.by_ref() {
                    if event == Event::End(TagEnd::CodeBlock) { break; }
                    if let Event::Text(value) = event { code.push_str(&value); }
                }
                if let Ok(deck) = serde_json::from_str::<serde_json::Value>(&code) {
                    if let Some(steps) = deck.get("steps").and_then(|v| v.as_array()) {
                        sources.extend(steps.iter().filter_map(|step| step.get("image").and_then(|v| v.as_str()).map(str::to_owned)));
                        for step in steps { if let Some(body) = step.get("markdown").and_then(|v| v.as_str()) { sources.extend(image_sources(body)); } }

                    }
                }
            },
            _ => {},
        }
    }
    sources
}

/// Normalize Obsidian/Super MD callouts and wikilinks outside code before parsing Markdown.
pub fn normalize_callouts(input: &str) -> String {
    if let Some(fm) = frontmatter::parse_frontmatter(input) {
        let rest = &input[fm.end..];
        let mut out = fm.raw.to_string();
        if !out.ends_with('\n') && !rest.is_empty() {
            out.push('\n');
        }
        let stripped = strip_percent_comments(rest);
        out.push_str(&normalize_callouts_body(&stripped));
        return out;
    }
    let stripped = strip_percent_comments(input);
    normalize_callouts_body(&stripped)
}

fn normalize_callouts_body(input: &str) -> String {
    let mut output = String::new();
    let mut depth = 0usize;
    let mut fence: Option<(char,usize)> = None;
    for line in input.lines() {
        let body=line.trim_start_matches(' ');
        let code=body.chars().next().filter(|ch| matches!(ch,'`'|'~')).and_then(|ch| {
            let count=body.chars().take_while(|value| *value==ch).count();
            let valid_open = !(fence.is_none() && ch == '`' && body[count..].contains('`'));
            (line.len()-body.len()<=3 && count>=3 && valid_open).then_some((ch,count))
        });
        let inside_fence=fence.is_some();
        if let Some((ch,count))=code {
            if let Some((marker,length))=fence {
                if ch==marker && count>=length && body[count..].trim().is_empty() { fence=None; }
            } else if ch != '`' || !body[count..].contains('`') { fence=Some((ch,count)); }
        }
        let start=if !inside_fence && code.is_none() {
            line.strip_prefix(":::callout").filter(|spec| spec.chars().next().is_some_and(char::is_whitespace))
        } else { None };
        if let Some(spec)=start {
            let spec=spec.trim();
            let (kind,title)=spec.split_once(char::is_whitespace).unwrap_or((spec,spec));
            if !kind.is_empty() && kind.chars().all(|ch| ch.is_alphanumeric() || ch=='_' || ch=='-') {
                depth+=1;
                output.push_str(&format!("{}[!{}] {}\n","> ".repeat(depth),kind,title.trim().trim_matches(['\"','\''])));
                continue;
            }
        }
        if !inside_fence && code.is_none() && depth>0 && line.trim()==":::" {
            depth-=1;output.push_str("> ".repeat(depth).trim_end());output.push('\n');
        } else { output.push_str(&"> ".repeat(depth));output.push_str(line);output.push('\n'); }
    }
    let with_equations = equations::normalize_standalone_equation_blocks(&output);
    normalize_prose_links(&normalize_obsidian_embeds(&with_equations))
}

fn encode_md_destination(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            ' ' => out.push_str("%20"),
            '\t' => out.push_str("%09"),
            '<' => out.push_str("%3C"),
            '>' => out.push_str("%3E"),
            '(' => out.push_str("%28"),
            ')' => out.push_str("%29"),
            _ => out.push(ch),
        }
    }
    out
}

fn escape_md_link_label(label: &str) -> String {
    let mut out = String::with_capacity(label.len());
    for ch in label.chars() {
        if matches!(ch, '[' | ']') { out.push('\\'); }
        out.push(ch);
    }
    out
}

fn has_supported_note_extension(path: &str) -> bool {
    let clean = path.split(['?', '#']).next().unwrap_or("").trim().to_ascii_lowercase();
    [".md", ".smd", ".fmd", ".markdown", ".txt"].iter().any(|ext| clean.ends_with(ext))
}

fn format_wikilink_markdown(inner: &str) -> Option<String> {
    if inner.is_empty() || inner.contains(['\r', '\n']) { return None; }
    let (raw_left, raw_alias) = match inner.split_once('|') {
        Some((left, alias)) => (left, Some(alias)),
        None => (inner, None),
    };
    let cleaned_left = if raw_alias.is_some() && raw_left.ends_with('\\') { &raw_left[..raw_left.len() - 1] } else { raw_left };
    let trimmed_left = cleaned_left.trim();
    if trimmed_left.is_empty() { return None; }
    if let Some(rest) = trimmed_left.strip_prefix('#') {
        let fragment = rest.trim();
        if fragment.is_empty() { return None; }
        let label = raw_alias.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(fragment);
        return Some(format!("[{}](#{})", escape_md_link_label(label), heading_slug(fragment)));
    }
    let (target, fragment) = match trimmed_left.split_once('#') {
        Some((t, f)) => (t.trim(), f.trim()),
        None => (trimmed_left, ""),
    };
    if target.is_empty() { return None; }
    let label = raw_alias.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(trimmed_left);
    let dest_path = if has_supported_note_extension(target) { target.to_string() } else { format!("{target}.md") };
    let slug_frag = if fragment.is_empty() { String::new() } else { heading_slug(fragment) };
    let dest_frag = if fragment.is_empty() {
        String::new()
    } else if !slug_frag.is_empty() {
        format!("#{slug_frag}")
    } else {
        format!("#{}", encode_md_destination(fragment))
    };
    Some(format!("[{}]({}{})", escape_md_link_label(label), encode_md_destination(&dest_path), dest_frag))
}

fn is_likely_link_destination(dest: &str) -> bool {
    let trimmed = dest.trim();
    if trimmed.is_empty() || !trimmed.contains([' ', '\t']) { return false; }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with('#') || lower.starts_with("./") || lower.starts_with("../") || lower.starts_with('/') || lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:") {
        return true;
    }
    let clean = lower.split(['?', '#']).next().unwrap_or("").trim();
    [".md", ".smd", ".fmd", ".markdown", ".txt", ".pdf"].iter().any(|ext| clean.ends_with(ext))
}

fn rewrite_prose_segment(segment: &str) -> String {
    let mut after_wiki = String::with_capacity(segment.len());
    let bytes = segment.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'[' && bytes[i + 1] == b'[' && (i == 0 || !matches!(bytes[i - 1], b'!' | b'\\')) {
            let start = i + 2;
            let mut end = start;
            let mut found = None;
            while end < bytes.len() && !matches!(bytes[end], b'\r' | b'\n' | b'[') {
                if bytes[end] == b']' {
                    if end + 1 < bytes.len() && bytes[end + 1] == b']' && end > start {
                        found = Some(end);
                    }
                    break;
                }
                end += 1;
            }
            if let Some(close_idx) = found {
                if let Some(formatted) = format_wikilink_markdown(&segment[start..close_idx]) {
                    after_wiki.push_str(&formatted);
                    i = close_idx + 2;
                    continue;
                }
            }
        }
        let ch = segment[i..].chars().next().unwrap();
        after_wiki.push(ch);
        i += ch.len_utf8();
    }

    let mut out = String::with_capacity(after_wiki.len());
    let wbytes = after_wiki.as_bytes();
    let mut j = 0usize;
    while j < wbytes.len() {
        if wbytes[j] == b'[' && (j == 0 || !matches!(wbytes[j - 1], b'!' | b'\\')) {
            let mut k = j + 1;
            let mut escaped = false;
            let mut label_close = None;
            while k < wbytes.len() && !matches!(wbytes[k], b'\r' | b'\n') {
                if escaped { escaped = false; k += 1; continue; }
                if wbytes[k] == b'\\' { escaped = true; k += 1; continue; }
                if wbytes[k] == b'[' { break; }
                if wbytes[k] == b']' { label_close = Some(k); break; }
                k += 1;
            }
            if let Some(close_bracket) = label_close {
                if close_bracket + 1 < wbytes.len() && wbytes[close_bracket + 1] == b'(' {
                    let dest_start = close_bracket + 2;
                    let mut p = dest_start;
                    let mut dest_close = None;
                    while p < wbytes.len() && !matches!(wbytes[p], b'\r' | b'\n' | b'<' | b'>' | b'(') {
                        if wbytes[p] == b')' { dest_close = Some(p); break; }
                        p += 1;
                    }
                    if let Some(close_paren) = dest_close {
                        let raw_inside = &after_wiki[dest_start..close_paren];
                        let (dest_part, title_part) = split_optional_link_title(raw_inside);
                        if is_likely_link_destination(dest_part) {
                            out.push_str(&after_wiki[j..dest_start]);
                            out.push_str(&encode_md_destination(dest_part));
                            out.push_str(title_part);
                            out.push(')');
                            j = close_paren + 1;
                            continue;
                        }
                    }
                }
            }
        }
        let ch = after_wiki[j..].chars().next().unwrap();
        out.push(ch);
        j += ch.len_utf8();
    }
    out
}

fn split_optional_link_title(inside: &str) -> (&str, &str) {
    let trimmed = inside.trim_end_matches([' ', '\t']);
    if let Some(quote) = trimmed.chars().last().filter(|c| matches!(c, '"' | '\'')) {
        if let Some(open_pos) = trimmed[..trimmed.len() - 1].rfind(quote) {
            if open_pos > 0 && matches!(trimmed.as_bytes()[open_pos - 1], b' ' | b'\t') {
                let mut ws_start = open_pos - 1;
                while ws_start > 0 && matches!(trimmed.as_bytes()[ws_start - 1], b' ' | b'\t') {
                    ws_start -= 1;
                }
                return (&inside[..ws_start], &inside[ws_start..]);
            }
        }
    }
    (inside, "")
}

/// Normalize prose wikilinks and spaced Markdown link destinations while
/// leaving fenced code, indented code, inline code, HTML, and math untouched.
fn normalize_prose_links(input: &str) -> String {
    if !input.contains("[[") && !input.contains("](") { return input.to_string(); }
    let mut protected = Vec::new();
    for (event, range) in Parser::new_ext(input, Options::ENABLE_MATH).into_offset_iter() {
        if matches!(event, Event::Start(Tag::CodeBlock(_)) | Event::Code(_) | Event::InlineMath(_) | Event::DisplayMath(_) | Event::Html(_) | Event::InlineHtml(_)) {
            protected.push(range);
        }
    }
    protected.sort_by_key(|r| r.start);
    let mut merged: Vec<std::ops::Range<usize>> = Vec::new();
    for range in protected {
        if let Some(last) = merged.last_mut() {
            if range.start <= last.end {
                last.end = last.end.max(range.end);
                continue;
            }
        }
        merged.push(range);
    }
    let mut out = String::with_capacity(input.len());
    let mut cursor = 0usize;
    for range in merged {
        if cursor < range.start {
            out.push_str(&rewrite_prose_segment(&input[cursor..range.start]));
        }
        out.push_str(&input[range.start..range.end]);
        cursor = range.end;
    }
    if cursor < input.len() {
        out.push_str(&rewrite_prose_segment(&input[cursor..]));
    }
    out
}

/// Protect complete math spans on actual table rows before GFM splits columns.
/// Parsing without tables excludes code, so literal code and TeX norms survive.
fn normalize_table_math(input: &str) -> String {
    let mut starts = Vec::new(); let mut offset = 0;
    let lines = input.split_inclusive('\n').map(|line| {starts.push(offset);offset+=line.len();line.trim_end_matches(['\r','\n'])}).collect::<Vec<_>>();
    let mut rows = vec![false; lines.len()];
    for i in 1..lines.len() {
        let cells = lines[i].trim().trim_start_matches('>').trim().trim_matches('|').split('|').map(str::trim).collect::<Vec<_>>();
        if cells.len() >= 2 && cells.iter().all(|cell| cell.chars().filter(|c| *c == '-').count() >= 3 && cell.chars().all(|c| c == '-' || c == ':')) && lines[i-1].contains('|') {
            rows[i-1] = true;
            for j in i+1..lines.len() { if lines[j].trim().is_empty() || !lines[j].contains('|') { break; } rows[j] = true; }
        }
    }
    let mut edits = Vec::new();
    for (event, range) in Parser::new_ext(input, Options::ENABLE_MATH).into_offset_iter() {
        if !matches!(event, Event::InlineMath(_) | Event::DisplayMath(_)) { continue; }
        let line = starts.partition_point(|start| *start <= range.start).saturating_sub(1);
        if !rows.get(line).copied().unwrap_or(false) { continue; }
        let raw = &input[range.clone()]; let mut replaced=String::new(); let mut slashes=0;
        for ch in raw.chars() {
            if ch == '|' && slashes % 2 == 0 { replaced.push_str("\\vert "); } else { replaced.push(ch); }
            slashes=if ch == '\\' {slashes+1} else {0};
        }
        if replaced != raw { edits.push((range,replaced)); }
    }
    let mut result=input.to_string();
    for (range,text) in edits.into_iter().rev() { result.replace_range(range,&text); }
    result
}

struct Renderer<'a> {
    events: std::iter::Peekable<std::vec::IntoIter<Event<'a>>>,
    assets: &'a HashMap<String, Vec<u8>>,
    footnotes: HashMap<String, String>,
    headings: HashMap<String, usize>,
    heading_counts: HashMap<String, usize>,
    equations: HashMap<String, equations::EquationTarget>,
    display_plans: VecDeque<equations::DisplayEquationPlan>,
    emitted_equation_anchors: HashSet<String>,
    link_depth: usize,
}
fn heading_slug(value: &str) -> String {
    let value = value.to_lowercase().chars().filter(|c| c.is_alphanumeric() || c.is_whitespace() || *c == '-' || *c == '_').collect::<String>();
    let slug = value.trim().chars().map(|c| if c.is_whitespace() { '-' } else { c }).collect::<String>();
    if slug.is_empty() { "section".into() } else { slug }
}
fn parse_braced_fence_language(raw_info: &str) -> Option<&'static str> {
    let trimmed = raw_info.trim();
    let inner = trimmed.strip_prefix('{')?.strip_suffix('}')?.trim();
    let rest = inner.strip_prefix('.').unwrap_or(inner);
    let first = rest.as_bytes().first().copied()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    let ident_len = rest
        .bytes()
        .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
        .count();
    let tail = &rest[ident_len..];
    if !tail.is_empty() && !tail.starts_with(|c: char| c.is_whitespace() || c == ',' || c == '#') {
        return None;
    }
    match rest[..ident_len].to_ascii_lowercase().as_str() {
        "python" => Some("python"),
        "py" => Some("py"),
        "mermaid" => Some("mermaid"),
        _ => None,
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum RenderStop<'b> {
    Tag(TagEnd),
    Html(&'b str),
}
impl<'a> Renderer<'a> {
    fn render_html(&self, html: &str, is_block: bool, out: &mut String) -> Result<()> {
        let clean = strip_html_comments(html);
        let trimmed = clean.trim();
        if trimmed.len() >= 3 && trimmed[..3].eq_ignore_ascii_case("<br") {
            out.push_str("#linebreak()");
        } else if diagram::looks_like_svg(trimmed) {
            let svg = diagram::validate_svg(trimmed)?;
            out.push_str(&format!("\n#smd-image(bytes({}), format: \"svg\")\n\n", string(&svg)));
        } else if is_page_break_div(html) {
            out.push_str(if is_block { "\n#pagebreak()\n\n" } else { "#pagebreak()" });
        } else {
            let imgs = parse_html_images(html);
            if imgs.is_empty() {
                if !clean.is_empty() {
                    out.push_str(&text(&clean));
                }
            } else {
                for img in imgs {
                    validate_asset_path(&img.src)?;
                    if is_font_asset(&img.src) || !self.assets.contains_key(&img.src) {
                        bail!("Image unavailable for PDF: {}", img.src);
                    }
                    out.push_str(&format_smd_image(&img.src, img.width.as_deref(), img.zoom.as_deref()));
                    if is_block {
                        out.push_str("\n\n");
                    }
                }
            }
        }
        Ok(())
    }

    fn render(&mut self, end: Option<TagEnd>) -> Result<String> {
        self.render_until(end.map(RenderStop::Tag))
    }
    fn render_until(&mut self, end: Option<RenderStop<'_>>) -> Result<String> {
        let mut out = String::new();
        while let Some(event) = self.events.next() {
            match event {
                Event::End(tag) if end == Some(RenderStop::Tag(tag)) => break,
                Event::End(_) => {},
                Event::InlineHtml(ref html) if end == Some(RenderStop::Html(html.as_ref())) => break,
                Event::Text(value) => out.push_str(&equations::render_prose_with_equation_refs(&value, &self.equations, self.link_depth > 0)),
                Event::Code(value) => out.push_str(&format!("#raw({})", string(&value))),
                Event::InlineMath(ref value) | Event::DisplayMath(ref value) => {
                    let display = matches!(&event, Event::DisplayMath(_));
                    let plan = if display {
                        self.display_plans.pop_front().unwrap_or_else(|| {
                            let mut sink_map = HashMap::new();
                            let mut sink_counter = 0usize;
                            equations::analyze_display_equation(value, &mut sink_map, &mut sink_counter)
                        })
                    } else {
                        equations::DisplayEquationPlan { clean_tex: value.to_string(), tag: None, anchor_ids: Vec::new() }
                    };
                    let (prepared_tex, replacements) = equations::prepare_math_refs_for_mitex(&plan.clean_tex, &self.equations);
                    let math = mitex::convert_math(&prepared_tex, None).map_err(|e| anyhow::anyhow!("LaTeX conversion failed for {value}: {e}"))?;
                    let resolved_math = equations::apply_mitex_ref_replacements(&compatible_math(&math), &replacements);
                    let expression = format!("#eval({}, scope: smd-math-scope)", string(&format!("${resolved_math}$")));
                    if display {
                        let mut unique_anchors = Vec::new();
                        for id in plan.anchor_ids {
                            if self.emitted_equation_anchors.insert(id.clone()) {
                                unique_anchors.push(id);
                            }
                        }
                        let primary_label = unique_anchors.first().map(|id| format!(" <{id}>")).unwrap_or_default();
                        let extra_labels = unique_anchors.iter().skip(1).map(|id| format!("#metadata(none) <{id}>")).collect::<String>();
                        if let Some(tag) = plan.tag {
                            out.push_str(&format!(
                                "\n#smd-tagged-equation([{extra_labels}{expression}], {}){primary_label}\n\n",
                                string(&tag.display_text)
                            ));
                        } else if !primary_label.is_empty() {
                            out.push_str(&format!(
                                "\n#block(width: 100%, breakable: false)[{extra_labels}#smd-fit(math.equation(block: true, [{expression}]))]{primary_label}\n\n"
                            ));
                        } else {
                            out.push_str(&format!("\n#smd-fit(math.equation(block: true, [{expression}]))\n\n"));
                        }
                    } else {
                        out.push_str(&expression);
                    }
                },
                Event::SoftBreak => out.push(' '),
                Event::HardBreak => out.push_str("#linebreak()"),
                Event::Rule => out.push_str("\n#line(length: 100%, stroke: .5pt + rgb(\"#d6dde5\"))\n"),
                Event::TaskListMarker(checked) => out.push_str(if checked { "#text(\"☑ \u{a0}\")" } else { "#text(\"☐ \u{a0}\")" }),
                Event::FootnoteReference(name) => out.push_str(&format!("#footnote[{}]", self.footnotes.get(name.as_ref()).cloned().unwrap_or_else(|| text(&name)))),
                Event::Html(ref html) | Event::InlineHtml(ref html) => match html.as_ref() {
                    "<mark>" => out.push_str(&format!("#highlight(fill: smd-highlight, radius: 2pt, extent: 1pt)[{}]", self.render_until(Some(RenderStop::Html("</mark>")))?)),
                    "<u>" => out.push_str(&format!("#underline[{}]", self.render_until(Some(RenderStop::Html("</u>")))?)),
                    "<kbd>" => out.push_str(&format!("#box(fill: smd-code-fill, stroke: .5pt + smd-line, inset: (x: 3.5pt, y: 1pt), outset: (y: 1.5pt), radius: 2.5pt)[#text(font: (\"JetBrains Mono\", \"DejaVu Sans Mono\"), size: .86em)[{}]]", self.render_until(Some(RenderStop::Html("</kbd>")))?)),
                    "</mark>" | "</u>" | "</kbd>" => {}
                    _ => self.render_html(html, matches!(&event, Event::Html(_)), &mut out)?,
                },
                Event::Start(tag) => {
                    let close = tag.to_end();
                    match tag {
                        Tag::HtmlBlock => {
                            let mut html = String::new();
                            while let Some(e) = self.events.next() {
                                if e == Event::End(close) { break; }
                                if let Event::Html(v) | Event::Text(v) = e { html.push_str(&v); }
                            }
                            self.render_html(&html, true, &mut out)?;
                        },
                        Tag::CodeBlock(kind) => {
                            let mut code = String::new();
                            while let Some(e) = self.events.next() { if e == Event::End(close) { break; } if let Event::Text(v) = e { code.push_str(&v); } }
                            let info = match kind { CodeBlockKind::Fenced(v) => v.to_string(), _ => String::new() };
                            let braced = parse_braced_fence_language(&info);
                            let lang_token = braced.unwrap_or_else(|| info.split_whitespace().next().unwrap_or(""));
                            let lang = lang_token.to_ascii_lowercase();
                            if ["smd-steps", "smd-step-grid"].contains(&lang.as_str()) {
                                out.push_str(&step_grid::render(&code, self.assets)?);
                                continue;
                            }
                            if ["mermaid", "smd-chart"].contains(&lang.as_str()) { bail!("Export preparation did not render a {lang} block"); }
                            let raw_svg_fence = (lang.is_empty() || ["xml", "html", "svg+xml", "image/svg+xml"].contains(&lang.as_str()))
                                && diagram::looks_like_svg(&code);
                            if ["svg", "smd-tree", "smd-diagram"].contains(&lang.as_str()) || raw_svg_fence {
                                let vector_kind = if matches!(lang.as_str(), "smd-tree" | "smd-diagram") { lang.as_str() } else { "svg" };
                                let svg = diagram::render_vector_block(vector_kind, &code)?;
                                out.push_str(&format!("\n#smd-image(bytes({}), format: \"svg\")\n\n", string(&svg)));
                                continue;
                            }
                            // Highlight the whole block once and fit individual
                            // synthesized lines inside a breakable container.
                            let code_arg = if code.is_empty() {
                                "none".into()
                            } else {
                                string(code.strip_suffix("\r\n").or_else(|| code.strip_suffix('\n')).unwrap_or(&code))
                            };
                            let lang_arg = if lang_token.is_empty() { "none".into() } else { string(lang_token) };
                            out.push_str(&format!("\n#smd-code({code_arg}, lang: {lang_arg})\n\n"));
                        },
                        Tag::Image { dest_url, .. } => {
                            let _alt = self.render(Some(close))?;
                            let key = dest_url.to_string();
                            validate_asset_path(&key)?;
                            if is_font_asset(&key) || !self.assets.contains_key(&key) { bail!("Image unavailable for PDF: {key}"); }
                            let (width, zoom, trailing) = consume_image_brace_attrs(&mut self.events);
                            out.push_str(&format_smd_image(&key, width.as_deref(), zoom.as_deref()));
                            if let Some(rem) = trailing {
                                if !rem.is_empty() {
                                    out.push_str(&text(&rem));
                                }
                            }
                        },
                        Tag::Table(columns) => {
                            let mut lengths = vec![0usize; columns.len()]; let mut counts = vec![0usize; columns.len()]; let mut column = 0; let mut length = 0;
                            for event in self.events.clone() {
                                match event {
                                    Event::End(TagEnd::Table) => break,
                                    Event::Start(Tag::TableCell) => length = 0,
                                    Event::Text(value) | Event::Code(value) | Event::InlineMath(value) | Event::DisplayMath(value) => length += value.chars().count(),
                                    Event::End(TagEnd::TableCell) => { lengths[column] += length.min(180); counts[column] += 1; column = (column + 1) % columns.len(); },
                                    _ => {},
                                }
                            }
                            let widths = lengths.iter().zip(&counts).map(|(len, count)| format!("{:.2}fr,", ((*len as f64 / (*count).max(1) as f64).max(8.)).sqrt().min(12.))).collect::<String>();
                            let alignments = columns.iter().map(|column| match column {
                                Alignment::Center => "center,",
                                Alignment::Right => "right,",
                                _ => "left,",
                            }).collect::<String>();
                            out.push_str(&format!("\n#table(columns: ({widths}), align: ({alignments}), inset: 6pt, stroke: .4pt + smd-line, fill: (x, y) => if y == 0 {{ smd-header-fill }} else {{ none }},\n"));
                            out.push_str(&self.render(Some(close))?); out.push_str(")\n\n");
                        },
                        Tag::TableHead => { out.push_str("table.header("); out.push_str(&self.render(Some(close))?); out.push_str("),\n"); },
                        Tag::TableRow => out.push_str(&self.render(Some(close))?),
                        Tag::TableCell => {
                            // Fit only over-wide equations. A layout wrapper on
                            // *each* inline equation creates block-level breaks
                            // and inflates mixed prose/math cells unnecessarily.
                            out.push_str("[#layout(cell => { show math.equation: it => { let w = measure(it).width; if w > cell.width { let factor = cell.width / w; scale(x: factor * 100%, y: factor * 100%, reflow: true, it) } else { it } }; [");
                            out.push_str(&self.render(Some(close))?); out.push_str("] })],\n");
                        },
                        Tag::FootnoteDefinition(name) => { let body = self.render(Some(close))?; self.footnotes.insert(name.to_string(), body); },
                        Tag::BlockQuote(_) => {
                            // CommonMark may split literal brackets into several
                            // Text events. Match the first complete logical line,
                            // not only its first text fragment.
                            let first_line = if matches!(self.events.peek(), Some(Event::Start(Tag::Paragraph))) {
                                self.events.clone().skip(1).take_while(|event| !matches!(event, Event::SoftBreak | Event::HardBreak | Event::End(TagEnd::Paragraph))).filter_map(|event| match event { Event::Text(value) | Event::Code(value) => Some(value.to_string()), _ => None }).collect::<String>()
                            } else { String::new() };
                            let callout = first_line.strip_prefix("[!").and_then(|v| v.split_once(']')).map(|(kind, title)| (kind.to_lowercase(), title.trim_start_matches(['+', '-']).trim().to_string()));
                            let (body, accent) = if let Some((kind, title)) = callout {
                                self.events.next();
                                while !matches!(self.events.peek(), None | Some(Event::SoftBreak | Event::HardBreak | Event::End(TagEnd::Paragraph))) {
                                    if matches!(self.events.next(), Some(Event::DisplayMath(_))) {
                                        let _ = self.display_plans.pop_front();
                                    }
                                }
                                if matches!(self.events.peek(), Some(Event::SoftBreak | Event::HardBreak)) { self.events.next(); }
                                let title = if title.is_empty() { kind.clone() } else { title };
                                let body = self.render(Some(TagEnd::Paragraph))? + "\n\n" + &self.render(Some(close))?;
                                let accent = match kind.as_str() { "tip" | "hint" | "success" | "check" | "done" => "#14735b", "warning" | "caution" => "#946200", "danger" | "error" | "failure" | "fail" | "missing" => "#b3261e", _ => "#315d99" };
                                let icon = match kind.as_str() {"tip"|"hint"=>"tip","warning"|"caution"=>"warning","danger"|"error"=>"error","success"|"check"|"done"=>"success","question"|"faq"=>"question","answer"|"solution"=>"answer","example"=>"example","quote"|"cite"=>"quote",_=>"info"};
                                (format!("#block(sticky: true, below: 6pt)[#text(weight: \"bold\", fill: rgb(\"{accent}\"))[#box(image(\"__smd_icon_{icon}.svg\", width: 11pt)) #h(4pt) {}]]\n\n{body}", text(&title)), accent)
                            } else { (self.render(Some(close))?, "#315d99") };
                            out.push_str(&format!("\n#block(width: 100%, breakable: true, fill: if smd-themed {{ smd-callout-fill }} else {{ color.mix((white, 94%), (rgb(\"{accent}\"), 6%)) }}, stroke: (left: 2pt + rgb(\"{accent}\")), inset: 10pt, radius: 4pt)[{body}]\n\n"));
                        },
                        _ => {
                            if matches!(tag, Tag::Paragraph) {
                                let mut plain_only = true;
                                let mut raw_para = String::new();
                                for e in self.events.clone().take_while(|e| !matches!(e, Event::End(TagEnd::Paragraph))) {
                                    match e {
                                        Event::Text(v) | Event::InlineHtml(v) => raw_para.push_str(&v),
                                        Event::SoftBreak => raw_para.push('\n'),
                                        _ => { plain_only = false; break; }
                                    }
                                }
                                let trimmed = raw_para.trim();
                                let is_quarto_break = trimmed
                                    .strip_prefix("{{<")
                                    .and_then(|s| s.strip_suffix(">}}"))
                                    .is_some_and(|s| s.trim() == "pagebreak");
                                if plain_only && (trimmed == "\\newpage" || trimmed == "\\pagebreak" || is_quarto_break) {
                                    for e in self.events.by_ref() {
                                        if e == Event::End(TagEnd::Paragraph) { break; }
                                    }
                                    out.push_str("#pagebreak()\n\n");
                                    continue;
                                }
                            }
                            let heading = if matches!(tag, Tag::Heading { .. }) {
                                let plain = self.events.clone().take_while(|e| !matches!(e, Event::End(TagEnd::Heading(_)))).filter_map(|e| match e { Event::Text(v) | Event::Code(v) | Event::InlineMath(v) => Some(v.to_string()), _ => None }).collect::<String>();
                                let slug = heading_slug(&plain); let count = self.heading_counts.entry(slug.clone()).or_default();
                                let id = if *count == 0 { slug } else { format!("{slug}-{count}") }; *count += 1; Some(id)
                            } else { None };
                            if matches!(tag, Tag::Link { .. }) {
                                self.link_depth += 1;
                            }
                            let body_res = self.render(Some(close));
                            if matches!(tag, Tag::Link { .. }) {
                                self.link_depth -= 1;
                            }
                            let body = body_res?;
                            match tag {
                                Tag::Paragraph => { if body.starts_with("#strong[") && body.ends_with(']') { out.push_str(&format!("#block(sticky: true, below: .35em)[{body}]\n\n")); } else { out.push_str(&format!("{body}\n\n")); } },
                                Tag::Heading { level, .. } => out.push_str(&format!("\n#heading(level: {})[{body}] <smd-{}>\n\n", level as u8, heading.unwrap())),
                                Tag::Emphasis => out.push_str(&format!("#emph[{body}]")),
                                Tag::Strong => out.push_str(&format!("#strong[{body}]")),
                                Tag::Strikethrough => out.push_str(&format!("#strike[{body}]")),
                                Tag::Subscript => out.push_str(&format!("#sub[{body}]")),
                                Tag::Superscript => out.push_str(&format!("#super[{body}]")),
                                Tag::List(start) => out.push_str(&if let Some(start) = start { format!("\n#enum(start: {start}, {body})\n") } else { format!("\n#list({body})\n") }),
                                Tag::Item => out.push_str(&format!("[{body}],\n")),
                                Tag::Link { dest_url, .. } => out.push_str(&if let Some(fragment) = dest_url.strip_prefix('#') {
                                    let decoded = percent_encoding::percent_decode_str(fragment).decode_utf8_lossy();
                                    let trimmed = decoded.trim();
                                    if let Some(eq_target) = self.equations.get(trimmed) {
                                        format!("#link(label({}))[{body}]", string(&eq_target.anchor_id))
                                    } else {
                                        let slug = heading_slug(trimmed);
                                        let resolved = if self.headings.contains_key(trimmed) {
                                            Some(trimmed.to_string())
                                        } else if self.headings.contains_key(&slug) {
                                            Some(slug)
                                        } else if let Some((prefix, suffix)) = trimmed.rsplit_once('-') {
                                            let numbered = format!("{}-{suffix}", heading_slug(prefix));
                                            (suffix.chars().all(|c| c.is_ascii_digit()) && self.headings.contains_key(&numbered)).then_some(numbered)
                                        } else {
                                            None
                                        };
                                        if let Some(id) = resolved { format!("#link(label({}))[{body}]", string(&format!("smd-{id}"))) } else { body }
                                    }
                                } else if dest_url.starts_with("https:") || dest_url.starts_with("http:") || dest_url.starts_with("mailto:") { format!("#link({})[{body}]", string(&dest_url)) } else { body }),
                                _ => out.push_str(&body),
                            }
                        }
                    }
                },
            }
        }
        Ok(out)
    }
}

pub(crate) fn render_fragment(markdown: &str, assets: &HashMap<String, Vec<u8>>) -> Result<String> {
    let body = frontmatter::strip_frontmatter(markdown);
    let stripped = strip_percent_comments(body);
    let normalized = normalize_table_math(&normalize_callouts_body(&stripped));
    let events = study::enrich_events(&normalized, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_SUBSCRIPT | Options::ENABLE_SUPERSCRIPT | Options::ENABLE_MATH);
    let mut equations = HashMap::new();
    let mut display_plans = VecDeque::new();
    let mut equation_counter = 0usize;
    for event in &events {
        if let Event::DisplayMath(v) = event {
            display_plans.push_back(equations::analyze_display_equation(v, &mut equations, &mut equation_counter));
        }
    }
    Renderer { events: events.into_iter().peekable(), assets, footnotes: HashMap::new(), headings: HashMap::new(), heading_counts: HashMap::new(), equations, display_plans, emitted_equation_anchors: HashSet::new(), link_depth: 0 }.render(None)
}

pub fn source(markdown: &str, options: &PdfOptions, assets: &HashMap<String, Vec<u8>>) -> Result<String> {
    options.validate()?;
    let (doc_metadata, raw_body) = match frontmatter::parse_frontmatter(markdown) {
        Some(fm) => (fm.metadata.typst_set_document(), &markdown[fm.end..]),
        None => (String::new(), markdown.strip_prefix('\u{feff}').unwrap_or(markdown)),
    };
    let stripped = strip_percent_comments(raw_body);
    let normalized = normalize_table_math(&normalize_callouts_body(&stripped));
    let events = study::enrich_events(&normalized, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_SUBSCRIPT | Options::ENABLE_SUPERSCRIPT | Options::ENABLE_TASKLISTS | Options::ENABLE_MATH | Options::ENABLE_FOOTNOTES);
    let mut headings = HashMap::new(); let mut current = None::<String>;
    let mut equations = HashMap::new();
    let mut display_plans = VecDeque::new();
    let mut equation_counter = 0usize;
    for event in &events { match event {
        Event::Start(Tag::Heading { .. }) => current = Some(String::new()),
        Event::Text(v) | Event::Code(v) | Event::InlineMath(v) => { if let Some(text) = &mut current { text.push_str(v); } },
        Event::End(TagEnd::Heading(_)) => { if let Some(text) = current.take() { let slug = heading_slug(&text); let count = headings.get(&slug).copied().unwrap_or(0); if count > 0 { headings.insert(format!("{slug}-{count}"), 1); } headings.insert(slug, count + 1); } },
        Event::DisplayMath(v) => {
            display_plans.push_back(equations::analyze_display_equation(v, &mut equations, &mut equation_counter));
        },
        _ => {}
    } }
    let mut renderer = Renderer { events: events.into_iter().peekable(), assets, footnotes: HashMap::new(), headings, heading_counts: HashMap::new(), equations: equations.clone(), display_plans: display_plans.clone(), emitted_equation_anchors: HashSet::new(), link_depth: 0 };
    // References normally precede definitions, so collect definitions first.
    let mut definitions = Renderer { events: renderer.events.clone(), assets, footnotes: HashMap::new(), headings: renderer.headings.clone(), heading_counts: HashMap::new(), equations, display_plans, emitted_equation_anchors: HashSet::new(), link_depth: 0 };
    while let Some(event) = definitions.events.next() {
        match event {
            Event::Start(Tag::FootnoteDefinition(name)) => {
                let value = definitions.render(Some(TagEnd::FootnoteDefinition))?;
                definitions.footnotes.insert(name.to_string(), value);
            }
            Event::DisplayMath(_) => {
                let _ = definitions.display_plans.pop_front();
            }
            _ => {}
        }
    }
    renderer.footnotes = definitions.footnotes;
    let body = renderer.render(None)?;
    let template: &str = if options.page_numbers { include_str!("document.typ") } else { &typesetter::UNNUMBERED_DOCUMENT_TEMPLATE };
    let paper=match options.page_size.as_str() {"letter"=>"us-letter","legal"=>"us-legal","tabloid"=>"us-tabloid","executive"=>"us-executive",other=>other};
    // MiTeX's bundled conversion spec still emits Typst's former `sect`
    // intersection name. Typst 0.15 calls it `inter`. Scope aliases preserve
    // equations without rewriting user TeX or changing the section symbol.
    let accent = if options.themed { &options.theme_accent } else { "#555555" };
    let themed = if options.themed { "true" } else { "false" };
    let palette = format!(r##"#let smd-themed = {themed}
#let smd-accent = rgb({})
#let smd-paper = if smd-themed {{ color.mix((white, 89%), (smd-accent, 11%)) }} else {{ white }}
#let smd-code-fill = if smd-themed {{ color.mix((white, 79%), (smd-accent, 21%)) }} else {{ rgb("#f4f4f4") }}
#let smd-callout-fill = if smd-themed {{ color.mix((white, 84%), (smd-accent, 16%)) }} else {{ rgb("#f2f2f2") }}
#let smd-header-fill = if smd-themed {{ color.mix((white, 76%), (smd-accent, 24%)) }} else {{ rgb("#e7e7e7") }}
#let smd-line = if smd-themed {{ color.mix((white, 55%), (smd-accent, 45%)) }} else {{ rgb("#d6d6d6") }}
#let smd-link = if smd-themed {{ color.mix((rgb("#202020"), 45%), (smd-accent, 55%)) }} else {{ rgb("#315d99") }}
#let smd-highlight = if smd-themed {{ color.mix((smd-paper, 58%), (rgb("#f6c945"), 42%)) }} else {{ rgb("#fff2a8") }}
"##, string(accent));
    // Typst collapses paragraph spacing against leading. Add leading so the
    // export control specifies the visible gap instead of disappearing below it.
    Ok(format!("#import \"/mitex/standard.typ\": scope as mitex-scope\n#let smd-math-scope = mitex-scope + (sect: sym.inter,)\n{palette}{doc_metadata}#set page(paper: {}, margin: {}mm, fill: smd-paper)\n#set text(font: ({}, \"Libertinus Serif\", \"New Computer Modern\"), size: {}pt)\n#set par(leading: {}em, spacing: {}em)\n{template}\n{body}", string(paper), options.margin, string(&options.font_family), options.font_size, options.line_height - 0.7, options.line_height - 0.7 + options.paragraph_spacing))
}

pub fn export(markdown: &str, options: &PdfOptions, assets: &HashMap<String, Vec<u8>>) -> Result<Vec<u8>> {
    let source = source(markdown, options, assets)?;
    typesetter::export_typst(source, options, assets)
}

#[cfg(target_os = "android")]
fn jni_string(env: jni::JNIEnv, value: &str) -> jni::sys::jstring {
    env.new_string(value)
        .or_else(|_| env.new_string(""))
        .map(|s| s.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_dev_supermd_studio_PdfEngine_validateTheme(
    mut env: jni::JNIEnv, _class: jni::objects::JClass, input: jni::objects::JString,
) -> jni::sys::jstring {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        match env.get_string(&input) {
            Ok(value) => theme::response(&String::from(value)),
            Err(_) => "{\"error\":\"Invalid theme input\"}".into(),
        }
    }))
    .unwrap_or_else(|_| "{\"error\":\"Theme validation failed\"}".into());
    jni_string(env, &result)
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_dev_supermd_studio_PdfEngine_fontFamilies(
    mut env: jni::JNIEnv, _class: jni::objects::JClass, path: jni::objects::JString,
) -> jni::sys::jstring {
    let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let families = (|| -> Result<Vec<String>> {
            let path: String = env.get_string(&path)?.into();
            if std::fs::metadata(&path)?.len() > 20_000_000 { bail!("Font exceeds 20 MB"); }
            let bytes = typst::foundations::Bytes::new(std::fs::read(path)?);
            Ok(typst::text::Font::iter(bytes).map(|font| font.info().family.clone()).collect())
        })()
        .unwrap_or_default();
        serde_json::to_string(&families).unwrap_or_else(|_| "[]".into())
    }))
    .unwrap_or_else(|_| "[]".into());
    jni_string(env, &payload)
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_dev_supermd_studio_PdfEngine_imageSources(
    mut env: jni::JNIEnv, _class: jni::objects::JClass, markdown: jni::objects::JString,
) -> jni::sys::jstring {
    let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        match env.get_string(&markdown) {
            Ok(value) => serde_json::to_string(&image_sources(&String::from(value))).unwrap_or_else(|_| "[]".into()),
            Err(_) => "[]".into(),
        }
    }))
    .unwrap_or_else(|_| "[]".into());
    jni_string(env, &payload)
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_dev_supermd_studio_PdfEngine_export(
    mut env: jni::JNIEnv, _class: jni::objects::JClass, markdown: jni::objects::JString,
    options: jni::objects::JString, asset_dir: jni::objects::JString, output: jni::objects::JString,
) -> jni::sys::jstring {
    let message = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let result = (|| -> Result<()> {
            let markdown: String = env.get_string(&markdown)?.into();
            let options: String = env.get_string(&options)?.into();
            let asset_dir: String = env.get_string(&asset_dir)?.into();
            let output: String = env.get_string(&output)?.into();
            let options: PdfOptions = serde_json::from_str(&options)?;
            let assets = pdf_assets::load_referenced_assets(&markdown, std::path::Path::new(&asset_dir))?;
            std::fs::write(&output, export(&markdown, &options, &assets)?)?;
            Ok(())
        })();
        result.err().map(|e| format!("{e:#}")).unwrap_or_default()
    }))
    .unwrap_or_else(|_| "PDF export failed unexpectedly".into());
    jni_string(env, &message)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn complete_table_math_preserves_absolute_values_and_cells() {
        let md = r"| In probability | In distribution |
|---|---|
| $P(|X_n-X|>\varepsilon)\to0$ | $F_{X_n}(x)\to F_X(x)$ at its continuity points |
| Code `a|b` is not math | $P(A|B)$ |";
        let normalized=normalize_table_math(md);
        assert_eq!(normalize_table_math(&md.replace('\n',"\r\n")),normalized.replace('\n',"\r\n"));
        assert!(normalized.contains(r"$P(\vert X_n-X\vert >\varepsilon)\to0$"));
        assert!(normalized.contains("`a|b`"));
        let output=source(md,&PdfOptions::default(),&HashMap::new()).unwrap();
        let widths=output.split("#table(columns: (").nth(1).unwrap().split(')').next().unwrap();
        assert_eq!(widths.split(',').filter(|part|!part.is_empty()).count(),2);
        assert!(output.contains("smd-header-fill"));
        assert!(export(md,&PdfOptions::default(),&HashMap::new()).unwrap().starts_with(b"%PDF-"));
    }
    #[test]
    fn compact_fonts_and_paragraph_spacing_are_validated_and_typeset() {
        let options=PdfOptions{font_size:6.,line_height:1.45,paragraph_spacing:1.2,..PdfOptions::default()};
        let md="# Compact\n\nFirst paragraph.\n\nSecond paragraph with $x^2$.";
        let text=source(md,&options,&HashMap::new()).unwrap();
        assert!(text.contains("spacing: 1.95em"));
        assert!(export(md,&options,&HashMap::new()).unwrap().starts_with(b"%PDF-"));
        let invalid=PdfOptions{paragraph_spacing:f32::NAN,..options};assert!(invalid.validate().is_err());
    }
    #[test]
    fn plain_pdf_keeps_semantic_callouts_not_wallpaper_accent() {
        let options=PdfOptions{themed:false,theme_accent:"#c123ab".into(),..PdfOptions::default()};
        let md="> [!TIP] Tip\n> Learn.\n\n> [!CAUTION] Caution\n> Carefully.\n\n| Header | Value |\n|---|---|\n| x | y |";
        let output=source(md,&options,&HashMap::new()).unwrap();
        assert!(!output.contains("#c123ab"));
        assert!(output.contains("#14735b"));assert!(output.contains("#946200"));
        assert!(output.contains("__smd_icon_tip.svg"));assert!(output.contains("__smd_icon_warning.svg"));
        assert!(output.contains("#e7e7e7"));
        assert!(export(md,&options,&HashMap::new()).unwrap().starts_with(b"%PDF-"));
    }
    #[test]
    fn emoji_font_is_available_without_system_fonts() {
        let bytes = typst::foundations::Bytes::new(include_bytes!("../fonts/NotoEmoji.ttf").as_slice());
        let font = typst::text::Font::iter(bytes).next().expect("Bundled emoji font");
        assert_eq!(font.info().family, "Noto Emoji");
        assert!(export("# Tasks 😊\n\n- [x] Complete ✅\n- [ ] Study 📚", &PdfOptions::default(), &HashMap::new()).unwrap().starts_with(b"%PDF-"));
    }
    #[test]
    fn inner_products_remain_compatible_with_typst_symbols() {
        assert_eq!(compatible_math("angle.l x angle.r \"angle.l\""), "chevron.l x chevron.r \"angle.l\"");
        let md = r"# Inner product

$$\langle x, y \rangle = \frac{1}{T_0} \int_0^{T_0} x(t)y(t)dt=0$$";
        for themed in [false, true] {
            let options = PdfOptions { themed, theme_accent: "#9a461a".into(), ..PdfOptions::default() };
            assert!(export(md, &options, &HashMap::new()).unwrap().starts_with(b"%PDF-"));
        }
    }
    #[test]
    fn every_selectable_paper_and_bundled_reading_font_typesets() {
        let papers=["a3","a4","a5","a6","iso-b4","iso-b5","iso-b6","letter","legal","tabloid","executive"];
        let fonts=["Manrope","Roboto","Noto Serif","JetBrains Mono"];
        for (i,paper) in papers.iter().enumerate() {
            let options=PdfOptions {page_size:paper.to_string(),font_family:fonts[i%fonts.len()].into(),..PdfOptions::default()};
            let pdf=export("# Paper and font\n\nReadable text with $\\int_0^1 x^2 dx=\\frac13$.",&options,&HashMap::new()).unwrap_or_else(|e|panic!("{paper}: {e:#}"));
            assert!(pdf.starts_with(b"%PDF-"));
        }
        let options=PdfOptions {font_family:"DejaVu Sans".into(),..PdfOptions::default()};
        // A supplied font is usable even when platform font discovery is disabled.
        let assets=HashMap::from([("__font_imported.ttf".into(),include_bytes!("../fonts/Manrope.ttf").to_vec())]);
        assert!(export("An imported font asset.",&options,&assets).unwrap().starts_with(b"%PDF-"));
    }
    #[test]
    fn obsidian_probability_equations_export_with_following_content() {
        let md = r"$$\boxed{\begin{aligned}
P(A\cup B\cup C)=&P(A)+P(B)+P(C)\\
&-P(A\cap B)-P(A\cap C)-P(B\cap C)\\
&+P(A\cap B\cap C).
\end{aligned}}$$

## AFTER-EQUATION

> [!TIP] TIP-AFTER-EQUATION
> $P(A\cap B) \le \min(P(A),P(B))$
";
        let bytes = export(md, &PdfOptions::default(), &HashMap::new()).unwrap();
        assert!(bytes.starts_with(b"%PDF-"));
        let rendered = source(md, &PdfOptions::default(), &HashMap::new()).unwrap();
        assert!(rendered.contains("#text(\"AFTER-EQUATION\")"));
        assert!(rendered.contains("#text(\"TIP-AFTER-EQUATION\")"));
    }
    #[test]
    fn callouts_match_split_bracket_events() {
        for md in ["> [!TIP] Learn\n> Try it first.\n", "> \\[!TIP] Learn\n> Try it first.\n"] {
            let rendered = source(md, &PdfOptions::default(), &HashMap::new()).unwrap();
            assert!(rendered.contains("#14735b"));
            assert!(rendered.contains("#text(\"Learn\")"));
            assert!(!rendered.contains("#text(\"[\")"));
        }
    }
    #[test]
    fn exports_real_math_and_multpage_content() {
        let md = "# Calculus\nInline $e^{i\\pi}+1=0$.\n\n$$\n\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix} \\quad \\int_0^1 x^2 dx = \\frac{1}{3}\n$$\n\n> [!TIP] Study\n> Try the problem first.\n\n| Formula | Meaning |\n|---|---|\n| $\\alpha+\\beta$ | angles |\n\n```python\nprint('hello')\n```\n".repeat(10);
        let pdf = export(&md, &PdfOptions::default(), &HashMap::new()).unwrap();
        assert!(pdf.starts_with(b"%PDF-")); assert!(pdf.len() > 10_000);
    }
    #[test]
    fn validates_parameters_and_assets() {
        let mut options = PdfOptions::default(); options.page_size = "a4\nfont: bad".into();
        assert!(source("hello", &options, &HashMap::new()).is_err());
        assert!(source("![missing](picture.png)", &PdfOptions::default(), &HashMap::new()).is_err());
    }
    #[test]
    fn tables_span_pages_and_keep_every_row() {
        let mut md = "# Table regression\n\n| Index | Formula | Explanation |\n|---|---|---|\n".to_string();
        for i in 0..150 { md.push_str(&format!("| ROW-{i:03} | $\\frac{{1}}{{1+x^2}}$ | A long explanation that wraps naturally in the cell without losing any characters or pushing the table past the page edge. |\n")); }
        md.push_str("\nEND-OF-DOCUMENT\n");
        let bytes = export(&md, &PdfOptions::default(), &HashMap::new()).unwrap();
        let path = std::env::temp_dir().join("supermd-table-regression.pdf");
        std::fs::write(&path, bytes).unwrap();
        if let Ok(output) = std::process::Command::new("pdftotext").arg(&path).arg("-").output() {
            let text = String::from_utf8_lossy(&output.stdout);
            for i in 0..150 { assert!(text.contains(&format!("ROW-{i:03}")), "Missing row {i}"); }
            assert!(text.contains("END-OF-DOCUMENT"));
            assert!(text.matches("Index").count() > 1, "Headers must repeat across pages");
        }
        if let Ok(output) = std::process::Command::new("pdftotext").arg("-bbox").arg(&path).arg("-").output() {
            let text = String::from_utf8_lossy(&output.stdout);
            for word in text.lines().filter(|line| line.contains("<word ")) {
                let x = word.split("xMax=\"").nth(1).unwrap().split('"').next().unwrap().parse::<f64>().unwrap();
                assert!(x < 550., "Text exceeds A4 usable width: {word}");
            }
        }
    }
    #[test]
    fn page_numbers_toggle_and_svg_images() {
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><rect width="300" height="100" fill="#42669e"/></svg>"##.to_vec();
        let assets = HashMap::from([("figure.svg".to_string(), svg)]);
        let mut options = PdfOptions::default(); options.page_numbers = false;
        let source = source("![figure](figure.svg)\n\n> [!TIP] Look\n> $x^2$\n", &options, &assets).unwrap();
        assert!(!source.contains("#set page(footer:")); assert!(!source.contains("[!TIP]"));
        assert!(export("![figure](figure.svg)", &options, &assets).unwrap().starts_with(b"%PDF-"));
    }
    #[test]
    fn wide_math_in_table_cells_fits_the_column() {
        let formula = (0..35).map(|i| format!("x_{{{i}}}")).collect::<Vec<_>>().join("+");
        let md = format!("| Expression | Meaning |\n|---|---|\n| ${formula}$ | All terms remain visible |\n\n$$ {formula} $$\n");
        let path = std::env::temp_dir().join("supermd-wide-math.pdf");
        std::fs::write(&path, export(&md, &PdfOptions::default(), &HashMap::new()).unwrap()).unwrap();
        if let Ok(output) = std::process::Command::new("pdftotext").arg("-bbox").arg(&path).arg("-").output() {
            for line in String::from_utf8_lossy(&output.stdout).lines().filter(|line| line.contains("<word ")) {
                let x = line.split("xMax=\"").nth(1).unwrap().split('"').next().unwrap().parse::<f64>().unwrap();
                let right_edge = (210. - PdfOptions::default().margin as f64) * 72. / 25.4;
                assert!(x <= right_edge + 0.5, "Wide equation escaped the printable area: {line}");
            }
        }
    }
    #[test]
    fn long_code_blocks_keep_all_lines_and_paginate() {
        let code = (0..180).map(|i| format!("print('CODE-LINE-{i:03}')")).collect::<Vec<_>>().join("\n");
        let path = std::env::temp_dir().join("supermd-long-code.pdf");
        std::fs::write(&path, export(&format!("```python\n{code}\n```\nEND-CODE"), &PdfOptions::default(), &HashMap::new()).unwrap()).unwrap();
        if let Ok(output) = std::process::Command::new("pdftotext").arg(&path).arg("-").output() {
            let text = String::from_utf8_lossy(&output.stdout);
            for i in 0..180 { assert!(text.contains(&format!("CODE-LINE-{i:03}")), "Missing code line {i}"); }
            assert!(text.contains("END-CODE"));
            assert!((3..=5).contains(&text.matches('\u{000c}').count()), "Code should paginate without excessive blank spacing");
        }
        if let Ok(output) = std::process::Command::new("pdftotext").arg("-bbox").arg(&path).arg("-").output() {
            let mut previous_bottom = 0.;
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                if line.contains("<page ") { previous_bottom = 0.; }
                if line.contains("<word ") && line.contains("CODE-LINE-") {
                    let coordinate = |name: &str| line.split(&format!("{name}=\"")).nth(1).unwrap().split('"').next().unwrap().parse::<f64>().unwrap();
                    assert!(coordinate("yMin") >= previous_bottom, "Code lines must not overlap");
                    previous_bottom = coordinate("yMax");
                }
            }
        }
    }
    fn decompress_pdf_streams(pdf: &[u8]) -> String {
        use std::io::Read;
        let mut out = String::new();
        let mut cursor = 0;
        while let Some(pos) = pdf[cursor..].windows(6).position(|w| w == b"stream") {
            let mut start = cursor + pos + 6;
            if pdf.get(start) == Some(&b'\r') { start += 1; }
            if pdf.get(start) == Some(&b'\n') { start += 1; } else { cursor = start; continue; }
            let Some(end_rel) = pdf[start..].windows(9).position(|w| w == b"endstream") else { break };
            let mut end = start + end_rel;
            while end > start && matches!(pdf[end - 1], b'\r' | b'\n') { end -= 1; }
            let mut decoded = Vec::new();
            if flate2::read::ZlibDecoder::new(&pdf[start..end]).read_to_end(&mut decoded).is_ok() {
                if let Ok(text) = String::from_utf8(decoded) {
                    out.push_str(&text);
                    out.push('\n');
                }
            }
            cursor = start + end_rel + 9;
        }
        out
    }
    #[test]
    fn code_blocks_preserve_multiline_syntax_highlighting() {
        let string_only = "```python\nprint(\"\"\"\ndef inside_multiline_string(): return 42\n\"\"\")\n```\n";
        let with_real_def = "```python\nprint(\"\"\"\ndef inside_multiline_string(): return 42\n\"\"\")\ndef real_function(): return 42\n```\n";
        let rendered = source(with_real_def, &PdfOptions::default(), &HashMap::new()).unwrap();
        assert_eq!(rendered.matches("\n#smd-code(").count(), 1, "Expected one #smd-code call for the block: {rendered}");

        let string_streams = decompress_pdf_streams(&export(string_only, &PdfOptions::default(), &HashMap::new()).unwrap());
        let real_def_streams = decompress_pdf_streams(&export(with_real_def, &PdfOptions::default(), &HashMap::new()).unwrap());
        // Typst Light highlights strings in #198810 and keywords in #d73948 via PDF `scn` color operators.
        let has_scn = |streams: &str, target: [f64; 3]| {
            streams.lines().any(|line| {
                let Some(rest) = line.split("/c1 cs ").nth(1) else { return false };
                let parts: Vec<&str> = rest.split_whitespace().collect();
                parts.len() >= 4 && parts[3] == "scn" && (0..3).all(|i| parts[i].parse::<f64>().is_ok_and(|v| (v - target[i]).abs() < 0.01))
            })
        };
        let string_green = [0x19 as f64 / 255., 0x88 as f64 / 255., 0x10 as f64 / 255.];
        let keyword_red = [0xd7 as f64 / 255., 0x39 as f64 / 255., 0x48 as f64 / 255.];
        assert!(has_scn(&string_streams, string_green), "Multi-line Python string must emit string highlight color:\n{string_streams}");
        assert!(!has_scn(&string_streams, keyword_red), "Keywords inside a multi-line string must not highlight as keywords:\n{string_streams}");
        assert!(has_scn(&real_def_streams, keyword_red), "Code after closing triple quotes must resume keyword highlighting:\n{real_def_streams}");
    }
    #[test]
    fn code_blocks_preserve_blank_lines_trailing_newlines_and_empty_fences() {
        // Empty tagged and untagged fences pass `none`.
        let empty_md = "```python\n```\n\n```\n```\n\nAFTER-EMPTY\n";
        let empty_src = source(empty_md, &PdfOptions::default(), &HashMap::new()).unwrap();
        assert!(empty_src.contains("#smd-code(none, lang: \"python\")"), "{empty_src}");
        assert!(empty_src.contains("#smd-code(none, lang: none)"), "{empty_src}");
        assert!(export(empty_md, &PdfOptions::default(), &HashMap::new()).unwrap().starts_with(b"%PDF-"));

        // Single blank line fence passes `""`, not `none`.
        let one_blank_src = source("```python\n\n```\n\nMARKER", &PdfOptions::default(), &HashMap::new()).unwrap();
        assert!(one_blank_src.contains("#smd-code(\"\", lang: \"python\")"), "{one_blank_src}");

        // LF, CRLF (both normalized through `source` and direct `Renderer` events), and unclosed EOF fences
        // strip at most one trailing newline without dropping intentional trailing blank lines.
        let lf_src = source("```rust\nlet a = 1;\nlet b = 2;\n```\n", &PdfOptions::default(), &HashMap::new()).unwrap();
        let crlf_src = source("```rust\r\nlet a = 1;\r\nlet b = 2;\r\n```\r\n", &PdfOptions::default(), &HashMap::new()).unwrap();
        let eof_src = source("```rust\nlet a = 1;\nlet b = 2;", &PdfOptions::default(), &HashMap::new()).unwrap();
        let trailing_blank_src = source("```rust\nlet a = 1;\nlet b = 2;\n\n```\n", &PdfOptions::default(), &HashMap::new()).unwrap();
        assert!(lf_src.contains("#smd-code(\"let a = 1;\\nlet b = 2;\", lang: \"rust\")"), "{lf_src}");
        assert!(crlf_src.contains("#smd-code(\"let a = 1;\\nlet b = 2;\", lang: \"rust\")"), "{crlf_src}");
        assert!(eof_src.contains("#smd-code(\"let a = 1;\\nlet b = 2;\", lang: \"rust\")"), "{eof_src}");
        assert!(trailing_blank_src.contains("#smd-code(\"let a = 1;\\nlet b = 2;\\n\", lang: \"rust\")"), "{trailing_blank_src}");

        let raw_crlf_events = vec![
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced("rust".into()))),
            Event::Text("let a = 1;\r\nlet b = 2;\r\n".into()),
            Event::End(TagEnd::CodeBlock),
        ];
        let raw_crlf_out = Renderer {
            events: raw_crlf_events.into_iter().peekable(),
            assets: &HashMap::new(),
            footnotes: HashMap::new(),
            headings: HashMap::new(),
            heading_counts: HashMap::new(),
            equations: HashMap::new(),
            display_plans: VecDeque::new(),
            emitted_equation_anchors: HashSet::new(),
            link_depth: 0,
        }.render(None).unwrap();
        assert_eq!(raw_crlf_out.trim(), "#smd-code(\"let a = 1;\\r\\nlet b = 2;\", lang: \"rust\")");

        let bbox_word_attr = |md: &str, needle: &str, attr: &str| -> Option<f64> {
            let path = std::env::temp_dir().join(format!("supermd-code-y-{}-{needle}-{attr}.pdf", std::process::id()));
            std::fs::write(&path, export(md, &PdfOptions::default(), &HashMap::new()).unwrap()).unwrap();
            let output = std::process::Command::new("pdftotext").arg("-bbox").arg(&path).arg("-").output();
            let _ = std::fs::remove_file(&path);
            let output = output.ok().filter(|out| out.status.success())?;
            let xml = String::from_utf8_lossy(&output.stdout);
            let prefix = format!("{attr}=\"");
            xml.lines()
                .find(|line| line.contains("<word ") && line.contains(needle))
                .map(|line| line.split(&prefix).nth(1).unwrap().split('"').next().unwrap().parse::<f64>().unwrap())
        };
        let bbox_word_y = |md: &str, needle: &str| bbox_word_attr(md, needle, "yMin");
        let row_pt = 1.2 * PdfOptions::default().font_size as f64;
        if let (Some(empty_y), Some(blank_y)) = (
            bbox_word_y("```python\n```\n\nMARKER", "MARKER"),
            bbox_word_y("```python\n\n```\n\nMARKER", "MARKER"),
        ) {
            let delta = blank_y - empty_y;
            assert!((delta - row_pt).abs() < 0.3, "Single blank line must add 1.2em ({row_pt}pt) over empty fence, got {delta}pt");
        }
        if let (Some(lf_y), Some(crlf_y), Some(trailing_y)) = (
            bbox_word_y("```rust\nlet a = 1;\nlet b = 2;\n```\n\nMARKER", "MARKER"),
            bbox_word_y("```rust\r\nlet a = 1;\r\nlet b = 2;\r\n```\r\n\r\nMARKER", "MARKER"),
            bbox_word_y("```rust\nlet a = 1;\nlet b = 2;\n\n```\n\nMARKER", "MARKER"),
        ) {
            assert!((lf_y - crlf_y).abs() < 0.1, "LF and CRLF fences must produce identical height");
            assert!(((trailing_y - lf_y) - row_pt).abs() < 0.3, "Intentional trailing blank line must keep 1.2em height");
        }
        let spaced_md = "```python\nALPHA = 1\n\nBETA = 2\n\n\nGAMMA = 3\n```\n";
        if let (Some(alpha_y), Some(beta_y), Some(gamma_y)) = (
            bbox_word_y(spaced_md, "ALPHA"),
            bbox_word_y(spaced_md, "BETA"),
            bbox_word_y(spaced_md, "GAMMA"),
        ) {
            assert!(((beta_y - alpha_y) - 2.0 * row_pt).abs() < 0.3, "One blank line must advance 2 * 1.2em");
            assert!(((gamma_y - beta_y) - 3.0 * row_pt).abs() < 0.3, "Two blank lines must advance 3 * 1.2em");
        }
        let indent_md = "```python\nOUTER = 1\n    INNER = 2\n```\n";
        if let (Some(outer_x), Some(inner_x)) = (
            bbox_word_attr(indent_md, "OUTER", "xMin"),
            bbox_word_attr(indent_md, "INNER", "xMin"),
        ) {
            assert!(inner_x > outer_x + 12.0, "Leading spaces on synthesized raw lines must be preserved (outer {outer_x}pt, inner {inner_x}pt)");
        }
    }
    #[test]
    fn untagged_and_wide_code_lines_fit_within_printable_width_without_scaling_normal_lines() {
        let untagged_md = "```\nfenced untagged\n```\n\n    indented line one\n    indented line two\n";
        let untagged_src = source(untagged_md, &PdfOptions::default(), &HashMap::new()).unwrap();
        assert!(untagged_src.contains("#smd-code(\"fenced untagged\", lang: none)"), "{untagged_src}");
        assert!(untagged_src.contains("#smd-code(\"indented line one\\nindented line two\", lang: none)"), "{untagged_src}");
        assert_eq!(
            untagged_src.lines().filter(|l| l.starts_with("#smd-code(") && l.ends_with(", lang: none)")).count(),
            2,
            "Untagged fenced and indented blocks must pass lang: none: {untagged_src}"
        );
        assert!(!untagged_src.contains("lang: \"\""));
        assert!(export(untagged_md, &PdfOptions::default(), &HashMap::new()).unwrap().starts_with(b"%PDF-"));

        // Normal-width code block must not emit non-identity horizontal/vertical scaling matrices in content stream,
        // while an over-wide line scales down to fit the printable width.
        let has_fractional_cm = |pdf: &[u8]| -> bool {
            decompress_pdf_streams(pdf).lines().any(|line| {
                let Some(before_cm) = line.split(" cm").next() else { return false };
                let parts: Vec<&str> = before_cm.split_whitespace().collect();
                if parts.len() < 6 { return false; }
                let Some(sx) = parts[parts.len() - 6].parse::<f64>().ok() else { return false };
                let Some(sy) = parts[parts.len() - 3].parse::<f64>().ok() else { return false };
                sx > 0.0 && sx < 0.99 && (sx - sy.abs()).abs() < 0.01
            })
        };
        let normal_pdf = export("```python\nnormal_value = 1\n```\n", &PdfOptions::default(), &HashMap::new()).unwrap();
        assert!(!has_fractional_cm(&normal_pdf), "Normal-width code lines must skip scale() in #smd-fit");

        let wide_line = format!("wide_value = '{}' # WIDE-TAIL", "W".repeat(160));
        let wide_md = format!("```python\nnormal_value = 1\n{wide_line}\nafter_wide = 2\n```\n");
        let wide_pdf = export(&wide_md, &PdfOptions::default(), &HashMap::new()).unwrap();
        assert!(wide_pdf.starts_with(b"%PDF-"));
        assert!(has_fractional_cm(&wide_pdf), "Over-wide code line must apply scale() in #smd-fit");

        let path = std::env::temp_dir().join(format!("supermd-wide-code-{}.pdf", std::process::id()));
        std::fs::write(&path, &wide_pdf).unwrap();
        if let Ok(output) = std::process::Command::new("pdftotext").arg(&path).arg("-").output() {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                assert!(text.contains("WIDE-TAIL"), "Wide line tail must remain present");
            }
        }
        if let Ok(output) = std::process::Command::new("pdftotext").arg("-bbox").arg(&path).arg("-").output() {
            if output.status.success() {
                let xml = String::from_utf8_lossy(&output.stdout);
                assert!(xml.contains("WIDE-TAIL"), "Wide line tail must remain present");
                let word_height = |needle: &str| -> f64 {
                    let line = xml.lines().find(|l| l.contains("<word ") && l.contains(needle)).unwrap();
                    let y_min: f64 = line.split("yMin=\"").nth(1).unwrap().split('"').next().unwrap().parse().unwrap();
                    let y_max: f64 = line.split("yMax=\"").nth(1).unwrap().split('"').next().unwrap().parse().unwrap();
                    y_max - y_min
                };
                let normal_h = word_height("normal_value");
                let after_h = word_height("after_wide");
                let wide_h = word_height("WIDE-TAIL");
                assert!((normal_h - after_h).abs() < 0.05, "Normal lines must share unscaled glyph height");
                assert!(wide_h < normal_h * 0.8, "Over-wide line must scale down (normal {normal_h}pt, wide {wide_h}pt)");
                let right_edge = (210. - PdfOptions::default().margin as f64) * 72. / 25.4;
                for word in xml.lines().filter(|line| line.contains("<word ")) {
                    let x = word.split("xMax=\"").nth(1).unwrap().split('"').next().unwrap().parse::<f64>().unwrap();
                    assert!(x <= right_edge + 0.5, "Wide code line escaped printable width: {word}");
                }
            }
        }
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn table_column_alignments_are_preserved_in_typst_source_and_pdf() {
        let md = r"| Left | Center | Right | Unspecified |
| :--- | :----: | ----: | ----------- |
| L1   | C1     | R1    | U1          |
| L2   | C2     | R2    | U2          |";
        let src = source(md, &PdfOptions::default(), &HashMap::new()).unwrap();
        assert!(src.contains("align: (left,center,right,left,)"), "Table must preserve column alignments: {src}");

        let single_col_md = "| Single Center |\n| :---: |\n| Cell |";
        let single_src = source(single_col_md, &PdfOptions::default(), &HashMap::new()).unwrap();
        assert!(single_src.contains("align: (center,)"), "Single column table must have trailing comma in align tuple: {single_src}");

        let pdf_bytes = export(md, &PdfOptions::default(), &HashMap::new()).unwrap();
        assert!(pdf_bytes.starts_with(b"%PDF-"));
    }
    #[test]
    fn normalizes_wikilinks_outside_code_and_exports_clean_pdf_labels() {
        let md = [
            "# Bayes Overview",
            "",
            "Follow [[Task Note]], [[Lecture 2#Bayes Law|Bayes]], [[study.smd]], [Deck](study.smd), and [[#Bayes Overview|Back to overview]].",
            "",
            "| Link | Code |",
            "| --- | --- |",
            "| [[Lecture 2#Bayes|Bayes cell]] | `[[Task Note]]` and `` `![[raw.png]]` `` |",
            "",
            "```python",
            "arr = [[1, 2], [3, 4]]",
            "note = '[[Literal]]'",
            "```",
            "",
        ].join("\n");
        let normalized = normalize_callouts(&md);
        assert!(normalized.contains("[Task Note](Task%20Note.md)"), "{normalized}");
        assert!(normalized.contains("[Bayes](Lecture%202.md#bayes-law)"), "{normalized}");
        assert!(normalized.contains("[study.smd](study.smd)"), "{normalized}");
        assert!(normalized.contains("[Back to overview](#bayes-overview)"), "{normalized}");
        assert!(normalized.contains("[Bayes cell](Lecture%202.md#bayes)"), "{normalized}");
        assert!(normalized.contains("`[[Task Note]]`"), "{normalized}");
        assert!(normalized.contains("`` `![[raw.png]]` ``"), "{normalized}");
        assert!(normalized.contains("arr = [[1, 2], [3, 4]]"), "{normalized}");
        assert!(normalized.contains("note = '[[Literal]]'"), "{normalized}");

        let typst = source(&md, &PdfOptions::default(), &HashMap::new()).unwrap();
        assert!(typst.contains("#text(\"Task Note\")"), "{typst}");
        assert!(typst.contains("#text(\"Bayes\")"), "{typst}");
        assert!(typst.contains("#text(\"Deck\")"), "{typst}");
        assert!(typst.contains("#link(label(\"smd-bayes-overview\"))[#text(\"Back to overview\")]"), "{typst}");
        assert!(!typst.contains("#text(\"[["), "No prose wikilink brackets in Typst output: {typst}");
        assert!(!typst.contains("\\["), "No escaped brackets in Typst output: {typst}");
        assert!(typst.contains("#raw(\"[[Task Note]]\")"), "{typst}");

        let pdf = export(&md, &PdfOptions::default(), &HashMap::new()).unwrap();
        assert!(pdf.starts_with(b"%PDF-"));
        assert!(pdf.len() > 2_000);
    }

    #[test]
    fn frontmatter_omits_yaml_from_page_body_and_populates_pdf_properties() {
        let note = "\u{feff}---  \ntitle: \"Relativistic Quantum Theory\"\nauthor:\n  - Paul Dirac\n  - Emmy Noether\ndescription: \"Spinors, symmetries, and conservation laws\"\ntags: [spinors, symmetry]\ndate: 2026-03-15\n...  \n\n# Spinor Algebra\n\nBody text.\n";
        let typst_src = source(note, &PdfOptions::default(), &HashMap::new()).unwrap();
        assert!(!typst_src.contains("#line(length: 100%"), "YAML delimiter leaked as horizontal rule: {typst_src}");
        assert!(!typst_src.contains("#heading(level: 2"), "YAML block leaked as setext level-2 heading: {typst_src}");
        assert!(!typst_src.contains("#text(\"title:"), "raw YAML key leaked into rendered body: {typst_src}");
        assert_eq!(typst_src.matches("title:").count(), 1);
        assert!(typst_src.contains("#set document(title: \"Relativistic Quantum Theory\", author: (\"Paul Dirac\", \"Emmy Noether\",), description: \"Spinors, symmetries, and conservation laws\", keywords: (\"spinors\", \"symmetry\",), date: datetime(year: 2026, month: 3, day: 15))"));

        let pdf_bytes = export(note, &PdfOptions::default(), &HashMap::new()).unwrap();
        assert!(pdf_bytes.starts_with(b"%PDF-"));
        let corpus = format!("{}\n{}", String::from_utf8_lossy(&pdf_bytes), decompress_pdf_streams(&pdf_bytes));
        assert!(corpus.contains("Relativistic Quantum Theory"), "PDF metadata missing title");
        assert!(corpus.contains("Paul Dirac"), "PDF metadata missing first author");
        assert!(corpus.contains("Emmy Noether"), "PDF metadata missing second author");
        assert!(corpus.contains("Spinors, symmetries, and conservation laws"), "PDF metadata missing description");
        assert!(corpus.contains("spinors"), "PDF metadata missing keyword");
        assert!(corpus.contains("2026-03-15") || corpus.contains("D:20260315"), "PDF metadata missing date");

        // Malformed or unclosed YAML and freeform dates still export valid PDFs safely.
        for fallback in [
            "---\ntitle: Unclosed frontmatter\n\n# Still Exports\n",
            "---\ntitle: Freeform Date\ndate: Spring 2026\n---\n\n# Valid PDF\n",
            "---\n---\n\n# Empty Frontmatter\n",
        ] {
            let bytes = export(fallback, &PdfOptions::default(), &HashMap::new()).unwrap();
            assert!(bytes.starts_with(b"%PDF-"));
        }
    }

    #[test]
    fn study_markdown_and_safe_html_typeset_and_preserve_code_math_and_security() {
        let md = r#"<!-- SECRET_BLOCK_COMMENT
spanning lines -->
%%SECRET_OBSIDIAN_HEADER
![ignored](missing-comment-image.png)%%

# Study Notes H~2~O

==Highlighted concept== with H~2~O, x^2^, ~~deprecated~~, %%SECRET_INLINE_COMMENT%%<!-- SECRET_INLINE_HTML --> and Press <kbd onclick="evil()">Ctrl</kbd>+<kbd>S</kbd>, <mark style="color:red">marked</mark>, <u>underlined</u>, CO<sub>2</sub>, 10<sup>-6</sup>.<br>Second line.

\==Literal markup\=\= beside ==Active highlight==, \==Raw one==, \==Raw two==, \=\=Inline literal\=\=, \\==Slash highlight==, H\~2\~O and H\~2~O and \~lit\~ and \~rawsub~ beside ~sub~, x\^2\^ and x\^2^ and \^rawsup^ beside ^sup^, \%%KEPT_PERCENT\%%, and approx ~5 minutes to boil H~2~O.

Spaced ~not sub~ and ^not sup^, comparison if a == b and c == d, escaped \==rawlit==, URL [https://example.edu/~alice/notes~1](https://example.edu/~alice/notes~1), unmatched <mark>rawmark, and inline <script>alert(1)</script>.

<script>window.pwn = 1</script>

| Concept | Detail |
|---|---|
| ==Cell mark== | Top<br/>Bottom |

Inline code `H~2~O ==raw== ^2^ %%KEPT_INLINE_CODE%% <kbd>k</kbd>` and math $x^2 + y_1$:

$$
%% kept tex comment
\int_0^1 x^2 dx = \frac{1}{3}
$$

```python
%%timeit total = 1 + 1
```
"#;
        assert!(image_sources(md).is_empty(), "Images inside %%...%% comments must be ignored");

        let typst_src = source(md, &PdfOptions::default(), &HashMap::new()).unwrap();
        assert!(typst_src.contains("#sub[#text(\"2\")]"), "Expected Typst #sub: {typst_src}");
        assert!(typst_src.contains("#sub[#text(\"sub\")]"), "Expected ~sub~ -> #sub: {typst_src}");
        assert!(!typst_src.contains("#sub[#text(\"lit\")]"), "Escaped \\~lit\\~ must not become #sub: {typst_src}");
        assert!(!typst_src.contains("#sub[#text(\"rawsub\")]"), "Escaped \\~rawsub~ must not become #sub: {typst_src}");
        assert!(typst_src.contains("#super[#text(\"2\")]"), "Expected Typst #super: {typst_src}");
        assert!(typst_src.contains("#super[#text(\"sup\")]"), "Expected ^sup^ -> #super: {typst_src}");
        assert!(!typst_src.contains("#super[#text(\"rawsup\")]"), "Escaped \\^rawsup^ must not become #super: {typst_src}");
        assert!(typst_src.contains("#super[#text(\"-6\")]"), "Expected HTML <sup> -> #super: {typst_src}");
        assert!(typst_src.contains("#highlight(fill: smd-highlight, radius: 2pt, extent: 1pt)[#text(\"Active highlight\")]"), "Expected unescaped highlight: {typst_src}");
        assert!(typst_src.contains("#highlight(fill: smd-highlight, radius: 2pt, extent: 1pt)[#text(\"Slash highlight\")]"), "Expected highlight after escaped backslash: {typst_src}");
        assert!(!typst_src.contains("[#text(\"Literal markup\")]"), "Escaped \\=\\=Literal markup\\=\\= must stay literal: {typst_src}");
        assert!(!typst_src.contains("[#text(\"Raw one\")]") && !typst_src.contains(", =Raw two"), "Comma-separated \\==Raw one==, \\==Raw two== must not pair: {typst_src}");
        assert!(!typst_src.contains("[#text(\"rawlit\")]"), "Escaped \\==rawlit== must stay literal: {typst_src}");
        assert!(typst_src.contains("#underline[#text(\"underlined\")]"), "Expected Typst #underline: {typst_src}");
        assert!(typst_src.contains("#box(fill: smd-code-fill"), "Expected Typst #box for <kbd>: {typst_src}");
        assert!(typst_src.contains("#strike[#text(\"deprecated\")]"), "Expected Typst #strike for ~~...~~: {typst_src}");
        assert!(typst_src.contains("#linebreak()"), "Expected Typst #linebreak() for <br>: {typst_src}");
        assert!(typst_src.contains("#link(\"https://example.edu/~alice/notes~1\")[#text(\"https://example.edu/~alice/notes~1\")]"), "URL tildes must not become subscripts: {typst_src}");
        assert!(!typst_src.contains("SECRET_BLOCK_COMMENT"));
        assert!(!typst_src.contains("SECRET_OBSIDIAN_HEADER"));
        assert!(!typst_src.contains("SECRET_INLINE_COMMENT"));
        assert!(!typst_src.contains("SECRET_INLINE_HTML"));
        assert!(!typst_src.contains("onclick"));
        assert!(typst_src.contains("KEPT_PERCENT"));
        assert!(typst_src.contains("KEPT_INLINE_CODE"));
        assert!(typst_src.contains("%%timeit total = 1 + 1"));
        assert!(typst_src.contains("<script>"));

        for themed in [false, true] {
            let opts = PdfOptions { themed, theme_accent: "#2d6a4f".into(), ..PdfOptions::default() };
            let pdf_bytes = export(md, &opts, &HashMap::new()).unwrap();
            assert!(pdf_bytes.starts_with(b"%PDF-"));
            if !themed {
                let path = std::env::temp_dir().join(format!("supermd-study-markdown-{}.pdf", std::process::id()));
                std::fs::write(&path, &pdf_bytes).unwrap();
                if let Ok(output) = std::process::Command::new("pdftotext").arg(&path).arg("-").output() {
                    if output.status.success() {
                        let extracted = String::from_utf8_lossy(&output.stdout);
                        let flat = extracted.split_whitespace().collect::<Vec<_>>().join(" ");
                        assert!(flat.contains("Highlighted concept"));
                        assert!(flat.contains("==Literal markup== beside Active highlight"), "Expected literal escaped == beside active highlight: {flat}");
                        assert!(flat.contains("\\Slash highlight"), "Expected escaped backslash before active highlight: {flat}");
                        assert!(flat.contains("H~2~O and H~2~O and ~lit~ and ~rawsub~ beside sub"), "Expected literal escaped tildes beside subscript: {flat}");
                        assert!(flat.contains("x^2^ and x^2^ and ^rawsup^ beside sup"), "Expected literal escaped carets beside superscript: {flat}");
                        assert!(flat.contains("%%KEPT_PERCENT%%"), "Expected escaped percent comment preserved: {flat}");
                        assert!(flat.contains("underlined"));
                        assert!(flat.contains("Ctrl"));
                        assert!(flat.contains("~not sub~"));
                        assert!(flat.contains("^not sup^"));
                        assert!(flat.contains("<script>alert(1)</script>"));
                        assert!(!flat.contains("SECRET_BLOCK_COMMENT"));
                        assert!(!flat.contains("SECRET_OBSIDIAN_HEADER"));
                        assert!(!flat.contains("SECRET_INLINE_COMMENT"));
                        assert!(!flat.contains("SECRET_INLINE_HTML"));
                    }
                }
                let _ = std::fs::remove_file(path);
            }
        }
    }
}
