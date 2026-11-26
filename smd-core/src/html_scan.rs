use crate::string;
use pulldown_cmark::Event;

fn fmt_num(value: f64) -> String {
    if (value - value.round()).abs() < 1e-6 {
        format!("{}", value.round() as i64)
    } else {
        format!("{value:.4}").trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn parse_positive_f64(raw: &str) -> Option<f64> {
    let v: f64 = raw.trim().parse().ok()?;
    (v.is_finite() && v > 0.0).then_some(v)
}

#[derive(Clone, Copy)]
enum DimensionKind {
    Width,
    Zoom,
}

fn parse_typst_dimension(raw: &str, kind: DimensionKind) -> Option<String> {
    let clean = raw.trim().trim_matches(['"', '\'']).trim().trim_end_matches(';').trim();
    if clean.is_empty() {
        return None;
    }
    let lower = clean.to_ascii_lowercase();
    if let Some(num) = lower.strip_suffix('%') {
        return parse_positive_f64(num).map(|v| format!("{}%", fmt_num(v)));
    }
    match kind {
        DimensionKind::Width => {
            if let Some(num) = lower.strip_suffix("px") {
                return parse_positive_f64(num).map(|v| format!("{}pt", fmt_num(v * 0.75)));
            }
            for unit in ["pt", "mm", "cm", "in"] {
                if let Some(num) = lower.strip_suffix(unit) {
                    return parse_positive_f64(num).map(|v| format!("{}{unit}", fmt_num(v)));
                }
            }
            parse_positive_f64(&lower).map(|v| format!("{}pt", fmt_num(v * 0.75)))
        }
        DimensionKind::Zoom => parse_positive_f64(&lower).map(|v| format!("{}%", fmt_num(v * 100.0))),
    }
}

fn parse_typst_width(raw: &str) -> Option<String> {
    parse_typst_dimension(raw, DimensionKind::Width)
}

fn parse_typst_zoom(raw: &str) -> Option<String> {
    parse_typst_dimension(raw, DimensionKind::Zoom)
}

pub(crate) fn format_smd_image(key: &str, width: Option<&str>, zoom: Option<&str>) -> String {
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
    pub(crate) src: String,
    pub(crate) width: Option<String>,
    pub(crate) zoom: Option<String>,
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

pub(crate) fn consume_image_brace_attrs<'a>(
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
