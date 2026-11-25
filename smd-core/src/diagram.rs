use anyhow::{bail, Result};
use roxmltree::{Document, ParsingOptions};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Clone, Debug)]
pub struct DiagramNode {
    pub id: String,
    pub label: String,
    pub x: f64,
    pub y: f64,
    pub state: &'static str,
    pub shape: &'static str,
}

#[derive(Clone, Debug)]
pub struct DiagramEdge {
    pub from: String,
    pub to: String,
    pub dashed: bool,
}

#[derive(Clone, Debug)]
pub struct DiagramSpec {
    pub title: Option<String>,
    pub width: f64,
    pub height: f64,
    pub nodes: Vec<DiagramNode>,
    pub edges: Vec<DiagramEdge>,
}

pub fn looks_like_svg(text: &str) -> bool {
    let mut rest = text.trim_start();
    if let Some(after_decl) = rest.strip_prefix("<?xml") {
        let Some(end) = after_decl.find("?>") else { return false };
        rest = after_decl[end + 2..].trim_start();
    }
    while let Some(after_open) = rest.strip_prefix("<!--") {
        let Some(end) = after_open.find("-->") else { return false };
        rest = after_open[end + 3..].trim_start();
    }
    if let Some(after_doctype) = rest.strip_prefix("<!DOCTYPE") {
        let Some(end) = after_doctype.find('>') else { return false };
        rest = after_doctype[end + 1..].trim_start();
    }
    let lower_prefix: String = rest.chars().take(5).collect::<String>().to_ascii_lowercase();
    if !lower_prefix.starts_with("<svg") {
        return false;
    }
    let Some(fifth) = rest.chars().nth(4) else { return false };
    if !(fifth.is_whitespace() || fifth == '>' || fifth == '/') {
        return false;
    }
    let trimmed_end = rest.trim_end();
    trimmed_end.len() >= 6
        && (trimmed_end[trimmed_end.len().saturating_sub(6)..].eq_ignore_ascii_case("</svg>")
            || trimmed_end.ends_with("/>"))
}

fn has_external_css_url(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let mut rest = lower.as_str();
    while let Some(pos) = rest.find("url(") {
        let after = rest[pos + 4..].trim_start();
        let unquoted = after.strip_prefix('"').or_else(|| after.strip_prefix('\'')).unwrap_or(after).trim_start();
        if unquoted.starts_with("http:")
            || unquoted.starts_with("https:")
            || unquoted.starts_with("//")
            || unquoted.starts_with("file:")
        {
            return true;
        }
        rest = &rest[pos + 4..];
    }
    false
}

/// Validate self-contained SVG XML per src/svgImage.ts and ensure xmlns is present.
pub fn validate_svg(source: &str) -> Result<String> {
    let trimmed = source.trim();
    let doc = Document::parse_with_options(
        trimmed,
        ParsingOptions { allow_dtd: true, ..Default::default() },
    )
    .map_err(|_| anyhow::anyhow!("This SVG is not valid XML."))?;
    let root = doc.root_element();
    if root.tag_name().name() != "svg" {
        bail!("This SVG is not valid XML.");
    }
    // Check raw attributes too so unbound namespaces like xlink:href without xmlns:xlink are caught if ever reached.
    for node in doc.descendants().filter(|n| n.is_element()) {
        let tag = node.tag_name().name().to_ascii_lowercase();
        if matches!(tag.as_str(), "script" | "foreignobject" | "iframe" | "object" | "embed") {
            bail!("SVG must be a self-contained image, without scripts or embedded HTML.");
        }
        for attr in node.attributes() {
            let name = attr.name();
            if name.to_ascii_lowercase().starts_with("on") {
                bail!("SVG event handlers are not allowed.");
            }
            if name.eq_ignore_ascii_case("href") {
                let val = attr.value();
                if !(val.starts_with('#') || val.to_ascii_lowercase().starts_with("data:image/")) {
                    bail!("External SVG resources must be embedded first.");
                }
            }
            if has_external_css_url(attr.value()) {
                bail!("External SVG resources must be embedded first.");
            }
        }
        if tag == "style" {
            let css: String = node.children().filter_map(|c| c.text()).collect();
            if css.to_ascii_lowercase().contains("@import") || has_external_css_url(&css) {
                bail!("External SVG styles are not allowed.");
            }
        }
    }
    if root.default_namespace() == Some("http://www.w3.org/2000/svg") {
        Ok(trimmed.to_string())
    } else {
        let insert_at = root.range().start + 4;
        let mut with_ns = String::with_capacity(trimmed.len() + 36);
        with_ns.push_str(&trimmed[..insert_at]);
        with_ns.push_str(" xmlns=\"http://www.w3.org/2000/svg\"");
        with_ns.push_str(&trimmed[insert_at..]);
        Ok(with_ns)
    }
}

fn valid_id(id: &str) -> bool {
    (1..=32).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn json_f64(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|v| v.is_finite())
}

pub fn parse_diagram(value: &Value) -> Option<DiagramSpec> {
    let obj = value.as_object()?;
    let title = match obj.get("title") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.encode_utf16().count() <= 160 => Some(s.clone()),
        _ => return None,
    };
    let width = json_f64(obj.get("width")).filter(|w| (120.0..=1200.0).contains(w))?;
    let height = json_f64(obj.get("height")).filter(|h| (80.0..=1000.0).contains(h))?;
    let raw_nodes = obj.get("nodes")?.as_array()?;
    if raw_nodes.is_empty() || raw_nodes.len() > 60 {
        return None;
    }
    let raw_edges = obj.get("edges")?.as_array()?;
    if raw_edges.len() > 140 {
        return None;
    }
    let mut nodes = Vec::with_capacity(raw_nodes.len());
    let mut seen = HashSet::with_capacity(raw_nodes.len());
    for raw in raw_nodes {
        let n = raw.as_object()?;
        let id = n.get("id")?.as_str()?;
        if !valid_id(id) || seen.contains(id) {
            return None;
        }
        let label = n.get("label")?.as_str()?;
        if label.encode_utf16().count() > 40 {
            return None;
        }
        let x = json_f64(n.get("x")).filter(|x| *x >= 30.0 && *x <= width - 30.0)?;
        let y = json_f64(n.get("y")).filter(|y| *y >= 30.0 && *y <= height - 30.0)?;
        let state = match n.get("state") {
            None | Some(Value::Null) => "normal",
            Some(Value::String(s)) => match s.as_str() {
                "normal" => "normal",
                "active" => "active",
                "visited" => "visited",
                "muted" => "muted",
                _ => return None,
            },
            _ => return None,
        };
        let shape = match n.get("shape") {
            None | Some(Value::Null) => "circle",
            Some(Value::String(s)) => match s.as_str() {
                "circle" => "circle",
                "box" => "box",
                _ => return None,
            },
            _ => return None,
        };
        seen.insert(id.to_string());
        nodes.push(DiagramNode { id: id.to_string(), label: label.to_string(), x, y, state, shape });
    }
    let mut edges = Vec::with_capacity(raw_edges.len());
    for raw in raw_edges {
        let e = raw.as_object()?;
        let from = e.get("from")?.as_str()?;
        let to = e.get("to")?.as_str()?;
        if !seen.contains(from) || !seen.contains(to) || from == to {
            return None;
        }
        let dashed = match e.get("dashed") {
            None | Some(Value::Null) => false,
            Some(Value::Bool(b)) => *b,
            _ => return None,
        };
        edges.push(DiagramEdge { from: from.to_string(), to: to.to_string(), dashed });
    }
    Some(DiagramSpec { title, width, height, nodes, edges })
}

pub fn parse_diagram_source(source: &str) -> Option<DiagramSpec> {
    if source.encode_utf16().count() > 16000 {
        return None;
    }
    let parsed: Value = serde_json::from_str(source).ok()?;
    parse_diagram(&parsed)
}

pub fn parse_binary_tree(value: &Value) -> Option<DiagramSpec> {
    let obj = value.as_object()?;
    let title = match obj.get("title") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.encode_utf16().count() <= 160 => Some(s.clone()),
        _ => return None,
    };
    let values = obj.get("values")?.as_array()?;
    if values.is_empty() || values.len() > 15 || values[0].is_null() {
        return None;
    }
    let mut active = HashSet::new();
    if let Some(hl) = obj.get("highlight") {
        let arr = hl.as_array()?;
        if arr.len() > 15 {
            return None;
        }
        for item in arr {
            let idx = item.as_u64().or_else(|| {
                item.as_f64()
                    .filter(|f| f.is_finite() && *f >= 0.0 && f.fract() == 0.0)
                    .map(|f| f as u64)
            })? as usize;
            if idx >= values.len() {
                return None;
            }
            active.insert(idx);
        }
    }
    let levels = (usize::BITS - values.len().leading_zeros()) as usize;
    let width = (((1usize << levels) * 75) as f64).max(240.0);
    let height = (levels * 104) as f64;
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    for (i, val) in values.iter().enumerate() {
        if val.is_null() {
            continue;
        }
        let label = match val {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => return None,
        };
        if label.encode_utf16().count() > 32 {
            return None;
        }
        if i > 0 && values[(i - 1) / 2].is_null() {
            return None;
        }
        let level = (usize::BITS - (i + 1).leading_zeros() - 1) as usize;
        let start = (1usize << level) - 1;
        let slot = i - start;
        let x = (slot as f64 + 0.5) * width / ((1usize << level) as f64);
        let y = 52.0 + (level as f64) * 104.0;
        let state = if active.contains(&i) { "active" } else { "normal" };
        nodes.push(DiagramNode {
            id: format!("n{i}"),
            label,
            x,
            y,
            state,
            shape: "circle",
        });
        if i > 0 {
            edges.push(DiagramEdge {
                from: format!("n{}", (i - 1) / 2),
                to: format!("n{i}"),
                dashed: false,
            });
        }
    }
    if nodes.is_empty() {
        return None;
    }
    // Validate bounds and edge integrity identically to parseDiagram.
    let spec = DiagramSpec { title, width, height, nodes, edges };
    for n in &spec.nodes {
        if n.x < 30.0 || n.y < 30.0 || n.x > spec.width - 30.0 || n.y > spec.height - 30.0 {
            return None;
        }
    }
    Some(spec)
}

pub fn parse_binary_tree_source(source: &str) -> Option<DiagramSpec> {
    if source.encode_utf16().count() > 12000 {
        return None;
    }
    let parsed: Value = serde_json::from_str(source).ok()?;
    parse_binary_tree(&parsed)
}

fn xml_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}

/// Render DiagramSpec to self-contained print SVG matching src/stepPdf.tsx.
pub fn diagram_svg(diagram: &DiagramSpec) -> String {
    let label = xml_escape(diagram.title.as_deref().unwrap_or("Diagram"));
    let mut out = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {} {}\" role=\"img\" aria-label=\"{label}\" preserveAspectRatio=\"xMidYMid meet\">",
        diagram.width, diagram.height
    );
    for edge in &diagram.edges {
        let a = diagram.nodes.iter().find(|n| n.id == edge.from).expect("validated node");
        let b = diagram.nodes.iter().find(|n| n.id == edge.to).expect("validated node");
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = {
            let h = dx.hypot(dy);
            if h == 0.0 { 1.0 } else { h }
        };
        let ra = if a.shape == "box" { 35.0 } else { 29.0 };
        let rb = if b.shape == "box" { 35.0 } else { 29.0 };
        let x1 = a.x + dx * ra / dist;
        let y1 = a.y + dy * ra / dist;
        let x2 = b.x - dx * rb / dist;
        let y2 = b.y - dy * rb / dist;
        let dash = if edge.dashed { " stroke-dasharray=\"5 7\"" } else { "" };
        out.push_str(&format!(
            "<line x1=\"{x1}\" y1=\"{y1}\" x2=\"{x2}\" y2=\"{y2}\" stroke=\"#667085\" stroke-width=\"3\"{dash}/>"
        ));
    }
    for node in &diagram.nodes {
        let opacity = if node.state == "muted" { " opacity=\".4\"" } else { "" };
        let fill = match node.state {
            "active" => "#ffb367",
            "visited" => "#153d4b",
            _ => "#f4f7fb",
        };
        let text_fill = if node.state == "visited" { "#f1faff" } else { "#20252d" };
        out.push_str(&format!("<g transform=\"translate({} {})\"{opacity}>", node.x, node.y));
        if node.shape == "box" {
            out.push_str(&format!(
                "<rect x=\"-38\" y=\"-28\" width=\"76\" height=\"56\" rx=\"12\" fill=\"{fill}\" stroke=\"#386a57\" stroke-width=\"2.5\"/>"
            ));
        } else {
            out.push_str(&format!(
                "<circle r=\"29\" fill=\"{fill}\" stroke=\"#386a57\" stroke-width=\"2.5\"/>"
            ));
        }
        out.push_str(&format!(
            "<text text-anchor=\"middle\" dominant-baseline=\"central\" fill=\"{text_fill}\" font-size=\"21\" font-family=\"Manrope, Noto Sans, sans-serif\">{}</text></g>",
            xml_escape(&node.label)
        ));
    }
    out.push_str("</svg>");
    out
}

pub fn render_vector_block(lang: &str, code: &str) -> Result<String> {
    match lang {
        "svg" => validate_svg(code),
        "smd-tree" => {
            let spec = parse_binary_tree_source(code)
                .ok_or_else(|| anyhow::anyhow!("Invalid diagram; fix it before exporting."))?;
            validate_svg(&diagram_svg(&spec))
        }
        "smd-diagram" => {
            let spec = parse_diagram_source(code)
                .ok_or_else(|| anyhow::anyhow!("Invalid diagram; fix it before exporting."))?;
            validate_svg(&diagram_svg(&spec))
        }
        _ => bail!("Unsupported vector block: {lang}"),
    }
}
