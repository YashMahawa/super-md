//! The same local typesetter is used by desktop and Android. No browser print layout.
pub mod portable;
pub mod theme;
pub mod pdf_assets;
mod math_compatibility;
mod step_grid;
use math_compatibility::compatible_math;
use anyhow::{bail, Result};
use pulldown_cmark::{Alignment, CodeBlockKind, CowStr, Event, Options, Parser, Tag, TagEnd};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use typst_as_lib::{typst_kit_options::TypstKitFontOptions, TypstEngine};

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

pub fn image_sources(markdown: &str) -> Vec<String> {
    let stripped = strip_percent_comments(markdown);
    let mut sources = Vec::new();
    let mut events = Parser::new_ext(&stripped, Options::all());
    while let Some(event) = events.next() {
        match event {
            Event::Start(Tag::Image { dest_url, .. }) => sources.push(dest_url.to_string()),
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

fn is_unescaped_percent_pair(bytes: &[u8], mask: &[bool], at: usize, floor: usize) -> bool {
    if at + 1 >= bytes.len() || bytes[at] != b'%' || bytes[at + 1] != b'%' || mask[at] || mask[at + 1] {
        return false;
    }
    let mut slashes = 0usize;
    let mut k = at;
    while k > floor && bytes[k - 1] == b'\\' && !mask[k - 1] {
        slashes += 1;
        k -= 1;
    }
    slashes % 2 == 0
}

/// Strip paired `%%...%%` Obsidian comments outside code spans/blocks and math.
pub fn strip_percent_comments(input: &str) -> String {
    if !input.contains("%%") {
        return input.to_string();
    }
    let mut mask = vec![false; input.len()];
    let mut in_code_block = false;
    for (event, range) in Parser::new_ext(input, Options::ENABLE_MATH).into_offset_iter() {
        match event {
            Event::Start(Tag::CodeBlock(_)) => {
                in_code_block = true;
                mask[range.start..range.end].fill(true);
            }
            Event::End(TagEnd::CodeBlock) => {
                in_code_block = false;
            }
            Event::Code(_) | Event::InlineMath(_) | Event::DisplayMath(_) => {
                mask[range.start..range.end].fill(true);
            }
            _ if in_code_block => {
                mask[range.start..range.end].fill(true);
            }
            _ => {}
        }
    }
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut cursor = 0usize;
    let mut i = 0usize;
    while i + 1 < bytes.len() {
        if !is_unescaped_percent_pair(bytes, &mask, i, cursor) {
            i += 1;
            continue;
        }
        let mut close = None;
        let mut j = i + 2;
        while j + 1 < bytes.len() {
            if is_unescaped_percent_pair(bytes, &mask, j, i + 2) {
                close = Some(j);
                break;
            }
            j += 1;
        }
        if let Some(end) = close {
            out.push_str(&input[cursor..i]);
            cursor = end + 2;
            i = cursor;
        } else {
            break;
        }
    }
    if cursor == 0 {
        return input.to_string();
    }
    out.push_str(&input[cursor..]);
    out
}

/// Normalize both Obsidian and Super MD callouts before parsing ordinary Markdown.
pub fn normalize_callouts(input: &str) -> String {
    let mut output = String::new();
    let mut depth = 0usize;
    let mut fence: Option<(char,usize)> = None;
    for line in input.lines() {
        let body=line.trim_start_matches(' ');
        let code=body.chars().next().filter(|ch| matches!(ch,'`'|'~')).and_then(|ch| {
            let count=body.chars().take_while(|value| *value==ch).count();
            (line.len()-body.len()<=3 && count>=3).then_some((ch,count))
        });
        let inside_fence=fence.is_some();
        if let Some((ch,count))=code {
            if let Some((marker,length))=fence {
                if ch==marker && count>=length && body[count..].trim().is_empty() { fence=None; }
            } else { fence=Some((ch,count)); }
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
    output
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InlineSpan {
    Sub,
    Sup,
    Highlight,
    Underline,
    Kbd,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DelimKind {
    Highlight,
    Sub,
    Sup,
}

#[derive(Clone, Debug, PartialEq)]
enum DocEvent<'a> {
    Md(Event<'a>),
    SpanStart(InlineSpan),
    SpanEnd(InlineSpan),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RenderEnd {
    Md(TagEnd),
    Span(InlineSpan),
}

enum HtmlTok {
    Br,
    Open(InlineSpan),
    Close(InlineSpan),
}

enum Node<'a> {
    Text(CowStr<'a>, Vec<bool>),
    Leaf(Event<'a>),
    HtmlOpen(InlineSpan, String),
    HtmlClose(InlineSpan, String),
    Group { tag: Tag<'a>, end: TagEnd, children: Vec<Node<'a>> },
    Span { span: InlineSpan, children: Vec<Node<'a>> },
}

fn parse_html_tag(s: &str) -> Option<(HtmlTok, usize)> {
    let b = s.as_bytes();
    if b.len() < 3 || b[0] != b'<' {
        return None;
    }
    let (closing, name_start) = if b[1] == b'/' { (true, 2) } else { (false, 1) };
    let mut name_end = name_start;
    while name_end < b.len() && b[name_end].is_ascii_alphabetic() {
        name_end += 1;
    }
    if name_end == name_start {
        return None;
    }
    let tag_name = s[name_start..name_end].to_ascii_lowercase();
    if closing {
        let span = match tag_name.as_str() {
            "mark" => InlineSpan::Highlight,
            "sub" => InlineSpan::Sub,
            "sup" => InlineSpan::Sup,
            "kbd" => InlineSpan::Kbd,
            "u" => InlineSpan::Underline,
            _ => return None,
        };
        let mut p = name_end;
        while p < b.len() && b[p].is_ascii_whitespace() {
            p += 1;
        }
        return (p < b.len() && b[p] == b'>').then_some((HtmlTok::Close(span), p + 1));
    }
    if !matches!(tag_name.as_str(), "br" | "mark" | "sub" | "sup" | "kbd" | "u") {
        return None;
    }
    match b.get(name_end) {
        Some(b'>' | b'/') => {}
        Some(c) if c.is_ascii_whitespace() => {}
        _ => return None,
    }
    let mut p = name_end;
    while p < b.len() && b[p] != b'>' {
        if b[p] == b'"' || b[p] == b'\'' {
            let quote = b[p];
            p += 1;
            while p < b.len() && b[p] != quote {
                p += 1;
            }
            if p >= b.len() {
                return None;
            }
        }
        p += 1;
    }
    if p >= b.len() {
        return None;
    }
    let self_closing = s[name_end..p].trim_end_matches(|c: char| c.is_ascii_whitespace()).ends_with('/');
    if tag_name == "br" {
        return Some((HtmlTok::Br, p + 1));
    }
    if self_closing {
        return None;
    }
    let span = match tag_name.as_str() {
        "mark" => InlineSpan::Highlight,
        "sub" => InlineSpan::Sub,
        "sup" => InlineSpan::Sup,
        "kbd" => InlineSpan::Kbd,
        "u" => InlineSpan::Underline,
        _ => unreachable!(),
    };
    Some((HtmlTok::Open(span), p + 1))
}

fn push_plain_text<'a>(out: &mut Vec<Node<'a>>, value: &str) {
    if !value.is_empty() {
        out.push(Node::Text(CowStr::from(value.to_string()), vec![false; value.len()]));
    }
}

fn tokenize_raw_html<'a>(raw: &str, out: &mut Vec<Node<'a>>) {
    let mut literal = String::new();
    let mut i = 0usize;
    while i < raw.len() {
        let Some(rel) = raw[i..].find('<') else {
            literal.push_str(&raw[i..]);
            break;
        };
        let lt = i + rel;
        literal.push_str(&raw[i..lt]);
        if raw[lt..].starts_with("<!--") {
            if let Some(end_rel) = raw[lt + 4..].find("-->") {
                push_plain_text(out, &literal);
                literal.clear();
                i = lt + 4 + end_rel + 3;
                continue;
            }
        } else if let Some((tok, len)) = parse_html_tag(&raw[lt..]) {
            push_plain_text(out, &literal);
            literal.clear();
            let slice = &raw[lt..lt + len];
            match tok {
                HtmlTok::Br => out.push(Node::Leaf(Event::HardBreak)),
                HtmlTok::Open(span) => out.push(Node::HtmlOpen(span, slice.to_string())),
                HtmlTok::Close(span) => out.push(Node::HtmlClose(span, slice.to_string())),
            }
            i = lt + len;
            continue;
        }
        literal.push('<');
        i = lt + 1;
    }
    push_plain_text(out, &literal);
}

fn node_has_whitespace(node: &Node<'_>) -> bool {
    match node {
        Node::Text(v, _) => v.chars().any(char::is_whitespace),
        Node::Leaf(Event::SoftBreak | Event::HardBreak) => true,
        Node::Group { children, .. } | Node::Span { children, .. } => children.iter().any(node_has_whitespace),
        _ => false,
    }
}

fn node_has_line_break(node: &Node<'_>) -> bool {
    match node {
        Node::Text(v, _) => v.contains('\n') || v.contains('\r'),
        Node::Leaf(Event::SoftBreak | Event::HardBreak) => true,
        Node::Group { children, .. } | Node::Span { children, .. } => children.iter().any(node_has_line_break),
        _ => false,
    }
}

fn fold_html_tags<'a>(nodes: Vec<Node<'a>>) -> Vec<Node<'a>> {
    let mut out: Vec<Node<'a>> = Vec::new();
    let mut stack: Vec<(InlineSpan, String, Vec<Node<'a>>)> = Vec::new();
    let emit = |item: Node<'a>, stack: &mut Vec<(InlineSpan, String, Vec<Node<'a>>)>, out: &mut Vec<Node<'a>>| {
        if let Some((_, _, top)) = stack.last_mut() {
            top.push(item);
        } else {
            out.push(item);
        }
    };
    for node in nodes {
        match node {
            Node::HtmlOpen(span, raw) => stack.push((span, raw, Vec::new())),
            Node::HtmlClose(span, raw) => {
                if let Some(pos) = stack.iter().rposition(|(s, _, _)| *s == span) {
                    while stack.len() - 1 > pos {
                        let (_, unclosed_raw, unclosed_children) = stack.pop().unwrap();
                        let len = unclosed_raw.len();
                        emit(Node::Text(CowStr::from(unclosed_raw), vec![false; len]), &mut stack, &mut out);
                        for child in unclosed_children {
                            emit(child, &mut stack, &mut out);
                        }
                    }
                    let (matched_span, _, children) = stack.pop().unwrap();
                    emit(Node::Span { span: matched_span, children }, &mut stack, &mut out);
                } else {
                    let len = raw.len();
                    emit(Node::Text(CowStr::from(raw), vec![false; len]), &mut stack, &mut out);
                }
            }
            other => emit(other, &mut stack, &mut out),
        }
    }
    while let Some((_, unclosed_raw, unclosed_children)) = stack.pop() {
        let len = unclosed_raw.len();
        emit(Node::Text(CowStr::from(unclosed_raw), vec![false; len]), &mut stack, &mut out);
        for child in unclosed_children {
            emit(child, &mut stack, &mut out);
        }
    }
    out
}

fn merge_adjacent_text<'a>(nodes: Vec<Node<'a>>) -> Vec<Node<'a>> {
    let mut out: Vec<Node<'a>> = Vec::with_capacity(nodes.len());
    for node in nodes {
        if let Node::Text(val, esc) = node {
            if let Some(Node::Text(prev_val, prev_esc)) = out.last_mut() {
                let mut combined = prev_val.to_string();
                combined.push_str(&val);
                *prev_val = CowStr::from(combined);
                prev_esc.extend(esc);
                continue;
            }
            out.push(Node::Text(val, esc));
        } else {
            out.push(node);
        }
    }
    out
}

enum Piece<'a> {
    Node(Node<'a>),
    Text(String, Vec<bool>),
    Delim { kind: DelimKind, can_open: bool, can_close: bool },
}

fn delim_str(kind: DelimKind) -> &'static str {
    match kind {
        DelimKind::Highlight => "==",
        DelimKind::Sub => "~",
        DelimKind::Sup => "^",
    }
}

fn piece_has_whitespace(piece: &Piece<'_>) -> bool {
    match piece {
        Piece::Text(s, _) => s.chars().any(char::is_whitespace),
        Piece::Node(n) => node_has_whitespace(n),
        Piece::Delim { .. } => false,
    }
}

fn piece_has_line_break(piece: &Piece<'_>) -> bool {
    match piece {
        Piece::Text(s, _) => s.contains('\n') || s.contains('\r'),
        Piece::Node(n) => node_has_line_break(n),
        Piece::Delim { .. } => false,
    }
}

fn span_valid(kind: DelimKind, slice: &[Piece<'_>]) -> bool {
    if slice.is_empty() {
        return false;
    }
    match kind {
        DelimKind::Highlight => !slice.iter().any(piece_has_line_break),
        DelimKind::Sub | DelimKind::Sup => !slice.iter().any(piece_has_whitespace),
    }
}

fn pieces_to_nodes<'a>(pieces: Vec<Piece<'a>>) -> Vec<Node<'a>> {
    let mut out: Vec<Node<'a>> = Vec::new();
    for piece in pieces {
        match piece {
            Piece::Node(n) => out.push(n),
            Piece::Text(s, esc) => {
                if !s.is_empty() {
                    out.push(Node::Text(CowStr::from(s), esc));
                }
            }
            Piece::Delim { kind, .. } => {
                let raw = delim_str(kind);
                out.push(Node::Text(CowStr::from(raw), vec![false; raw.len()]));
            }
        }
    }
    merge_adjacent_text(out)
}

fn apply_study_delimiters<'a>(nodes: Vec<Node<'a>>) -> Vec<Node<'a>> {
    let nodes = merge_adjacent_text(nodes);
    if !nodes.iter().any(|n| matches!(n, Node::Text(s, _) if s.contains('=') || s.contains('~') || s.contains('^'))) {
        return nodes;
    }
    let mut pieces: Vec<Piece<'a>> = Vec::new();
    let mut saw_delim = false;
    let len = nodes.len();
    let mut iter = nodes.into_iter().enumerate().peekable();
    let mut prev_was_break_or_node: Option<char> = None;
    while let Some((idx, node)) = iter.next() {
        let next_b = if idx + 1 >= len {
            None
        } else {
            match iter.peek().map(|(_, n)| n) {
                Some(Node::Leaf(Event::SoftBreak | Event::HardBreak)) => Some('\n'),
                Some(_) => Some('x'),
                None => None,
            }
        };
        let prev_b = prev_was_break_or_node;
        prev_was_break_or_node = match &node {
            Node::Leaf(Event::SoftBreak | Event::HardBreak) => Some('\n'),
            _ => Some('x'),
        };
        let Node::Text(val, esc) = node else {
            pieces.push(Piece::Node(node));
            continue;
        };
        let s = val.as_ref();
        if !(s.contains('=') || s.contains('~') || s.contains('^')) {
            pieces.push(Piece::Text(s.to_string(), esc));
            continue;
        }
        let bytes = s.as_bytes();
        let mut buf = String::new();
        let mut buf_esc: Vec<bool> = Vec::new();
        let mut i = 0usize;
        while i < s.len() {
            let b = bytes[i];
            let is_esc = esc.get(i).copied().unwrap_or(false);
            if !is_esc && matches!(b, b'=' | b'~' | b'^') {
                let mut run = 1usize;
                while i + run < s.len() && bytes[i + run] == b && !esc.get(i + run).copied().unwrap_or(false) {
                    run += 1;
                }
                if (b == b'=' && run == 2) || ((b == b'~' || b == b'^') && run == 1) {
                    let before = if i > 0 { s[..i].chars().next_back() } else { prev_b };
                    let after = if i + run < s.len() { s[i + run..].chars().next() } else { next_b };
                    let can_open = after.is_some_and(|c| !c.is_whitespace());
                    let can_close = before.is_some_and(|c| !c.is_whitespace());
                    if can_open || can_close {
                        if !buf.is_empty() {
                            pieces.push(Piece::Text(std::mem::take(&mut buf), std::mem::take(&mut buf_esc)));
                        }
                        saw_delim = true;
                        let kind = match b {
                            b'=' => DelimKind::Highlight,
                            b'~' => DelimKind::Sub,
                            _ => DelimKind::Sup,
                        };
                        pieces.push(Piece::Delim { kind, can_open, can_close });
                        i += run;
                        continue;
                    }
                }
                buf.push_str(&s[i..i + run]);
                buf_esc.extend(std::iter::repeat_n(false, run));
                i += run;
                continue;
            }
            let ch = s[i..].chars().next().unwrap();
            let clen = ch.len_utf8();
            buf.push(ch);
            for k in 0..clen {
                buf_esc.push(esc.get(i + k).copied().unwrap_or(false));
            }
            i += clen;
        }
        if !buf.is_empty() {
            pieces.push(Piece::Text(buf, buf_esc));
        }
    }
    if !saw_delim {
        return pieces_to_nodes(pieces);
    }
    let mut working: Vec<Piece<'a>> = Vec::new();
    let mut openers: Vec<(usize, DelimKind)> = Vec::new();
    for piece in pieces {
        let Piece::Delim { kind, can_open, can_close } = piece else {
            working.push(piece);
            continue;
        };
        let matched = if can_close {
            openers.iter().rposition(|(pos, open_kind)| *open_kind == kind && span_valid(kind, &working[*pos + 1..]))
        } else {
            None
        };
        if let Some(open_idx) = matched {
            let (pos, _) = openers[open_idx];
            openers.truncate(open_idx);
            let inner = pieces_to_nodes(working.drain(pos + 1..).collect());
            let span = match kind {
                DelimKind::Highlight => InlineSpan::Highlight,
                DelimKind::Sub => InlineSpan::Sub,
                DelimKind::Sup => InlineSpan::Sup,
            };
            working[pos] = Piece::Node(Node::Span { span, children: inner });
        } else {
            let pos = working.len();
            working.push(Piece::Delim { kind, can_open, can_close });
            if can_open {
                openers.push((pos, kind));
            }
        }
    }
    pieces_to_nodes(working)
}

fn is_autolink_literal(tag: &Tag<'_>, children: &[Node<'_>]) -> bool {
    let Tag::Link { dest_url, .. } = tag else { return false };
    if children.len() != 1 {
        return false;
    }
    let Node::Text(text, _) = &children[0] else { return false };
    let url = dest_url.as_ref();
    let t = text.as_ref();
    url == t || url == format!("mailto:{t}") || url == format!("http://{t}")
}

fn is_phrasing_tag(tag: &Tag<'_>) -> bool {
    matches!(
        tag,
        Tag::Paragraph
            | Tag::Heading { .. }
            | Tag::TableCell
            | Tag::Emphasis
            | Tag::Strong
            | Tag::Strikethrough
            | Tag::Link { .. }
    )
}

fn process_nodes<'a>(nodes: Vec<Node<'a>>, phrasing: bool) -> Vec<Node<'a>> {
    let folded = fold_html_tags(nodes);
    let delimited = if phrasing { apply_study_delimiters(folded) } else { merge_adjacent_text(folded) };
    delimited
        .into_iter()
        .map(|node| match node {
            Node::Group { tag, end, children } => {
                if matches!(tag, Tag::CodeBlock(_)) {
                    Node::Group { tag, end, children }
                } else {
                    let child_phrasing = is_phrasing_tag(&tag) && !is_autolink_literal(&tag, &children);
                    Node::Group { tag, end, children: process_nodes(children, child_phrasing) }
                }
            }
            Node::Span { span, children } => Node::Span { span, children: process_nodes(children, true) },
            other => other,
        })
        .collect()
}

fn build_nodes<'a, I>(iter: &mut I, source: &str, stop: Option<TagEnd>) -> Vec<Node<'a>>
where
    I: Iterator<Item = (Event<'a>, std::ops::Range<usize>)>,
{
    let mut out: Vec<Node<'a>> = Vec::new();
    while let Some((event, range)) = iter.next() {
        match event {
            Event::End(end) if Some(end) == stop => break,
            Event::End(_) => {}
            Event::Start(Tag::HtmlBlock) => {
                let mut raw = String::new();
                for (inner, _) in iter.by_ref() {
                    if inner == Event::End(TagEnd::HtmlBlock) {
                        break;
                    }
                    if let Event::Html(h) | Event::Text(h) = inner {
                        raw.push_str(&h);
                    }
                }
                let mut tokens = Vec::new();
                tokenize_raw_html(raw.trim_end_matches(['\r', '\n']), &mut tokens);
                let folded = fold_html_tags(tokens);
                let all_blank = folded.iter().all(|n| matches!(n, Node::Text(s, _) if s.trim().is_empty()));
                if !all_blank {
                    out.push(Node::Group { tag: Tag::Paragraph, end: TagEnd::Paragraph, children: folded });
                }
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                let mut children = Vec::new();
                for (inner, _) in iter.by_ref() {
                    if inner == Event::End(TagEnd::CodeBlock) {
                        break;
                    }
                    children.push(Node::Leaf(inner));
                }
                out.push(Node::Group { tag: Tag::CodeBlock(kind), end: TagEnd::CodeBlock, children });
            }
            Event::Start(tag @ (Tag::Subscript | Tag::Superscript)) => {
                let is_sub = matches!(tag, Tag::Subscript);
                let close = tag.to_end();
                let children = build_nodes(iter, source, Some(close));
                if children.is_empty() || children.iter().any(node_has_whitespace) {
                    let marker = if is_sub { "~" } else { "^" };
                    out.push(Node::Text(CowStr::from(marker), vec![false]));
                    out.extend(children);
                    out.push(Node::Text(CowStr::from(marker), vec![false]));
                } else {
                    out.push(Node::Span { span: if is_sub { InlineSpan::Sub } else { InlineSpan::Sup }, children });
                }
            }
            Event::Start(tag) => {
                let close = tag.to_end();
                let children = build_nodes(iter, source, Some(close));
                out.push(Node::Group { tag, end: close, children });
            }
            Event::InlineHtml(html) | Event::Html(html) => {
                tokenize_raw_html(&html, &mut out);
            }
            Event::Text(value) => {
                let is_escaped = range.end > range.start + value.len() && source.as_bytes().get(range.start) == Some(&b'\\');
                let esc = vec![is_escaped; value.len()];
                out.push(Node::Text(value, esc));
            }
            other => out.push(Node::Leaf(other)),
        }
    }
    out
}

fn flatten_nodes<'a>(nodes: Vec<Node<'a>>, out: &mut Vec<DocEvent<'a>>) {
    for node in nodes {
        match node {
            Node::Text(val, _) => out.push(DocEvent::Md(Event::Text(val))),
            Node::Leaf(ev) => out.push(DocEvent::Md(ev)),
            Node::HtmlOpen(_, raw) | Node::HtmlClose(_, raw) => out.push(DocEvent::Md(Event::Text(CowStr::from(raw)))),
            Node::Group { tag, end, children } => {
                out.push(DocEvent::Md(Event::Start(tag)));
                flatten_nodes(children, out);
                out.push(DocEvent::Md(Event::End(end)));
            }
            Node::Span { span, children } => {
                out.push(DocEvent::SpanStart(span));
                flatten_nodes(children, out);
                out.push(DocEvent::SpanEnd(span));
            }
        }
    }
}

fn enrich_events<'a>(normalized: &'a str, options: Options) -> Vec<DocEvent<'a>> {
    let mut iter = Parser::new_ext(normalized, options).into_offset_iter();
    let tree = build_nodes(&mut iter, normalized, None);
    let processed = process_nodes(tree, false);
    let mut out = Vec::new();
    flatten_nodes(processed, &mut out);
    out
}

struct Renderer<'a> {
    events: std::iter::Peekable<std::vec::IntoIter<DocEvent<'a>>>,
    assets: &'a HashMap<String, Vec<u8>>,
    footnotes: HashMap<String, String>,
    headings: HashMap<String, usize>,
    heading_counts: HashMap<String, usize>,
}
fn heading_slug(value: &str) -> String {
    let value = value.to_lowercase().chars().filter(|c| c.is_alphanumeric() || c.is_whitespace() || *c == '-' || *c == '_').collect::<String>();
    let slug = value.trim().chars().map(|c| if c.is_whitespace() { '-' } else { c }).collect::<String>();
    if slug.is_empty() { "section".into() } else { slug }
}
impl<'a> Renderer<'a> {
    fn render(&mut self, end: Option<RenderEnd>) -> Result<String> {
        let mut out = String::new();
        while let Some(doc_event) = self.events.next() {
            match doc_event {
                DocEvent::SpanEnd(span) if end == Some(RenderEnd::Span(span)) => break,
                DocEvent::SpanEnd(_) => {}
                DocEvent::SpanStart(span) => {
                    let body = self.render(Some(RenderEnd::Span(span)))?;
                    match span {
                        InlineSpan::Sub => out.push_str(&format!("#sub[{body}]")),
                        InlineSpan::Sup => out.push_str(&format!("#super[{body}]")),
                        InlineSpan::Highlight => out.push_str(&format!("#highlight(fill: smd-highlight, radius: 2pt, extent: 1pt)[{body}]")),
                        InlineSpan::Underline => out.push_str(&format!("#underline[{body}]")),
                        InlineSpan::Kbd => out.push_str(&format!("#box(fill: smd-code-fill, stroke: .5pt + smd-line, inset: (x: 3.5pt, y: 1pt), outset: (y: 1.5pt), radius: 2.5pt)[#text(font: (\"JetBrains Mono\", \"DejaVu Sans Mono\"), size: .86em)[{body}]]")),
                    }
                }
                DocEvent::Md(event) => match event {
                    Event::End(tag) if end == Some(RenderEnd::Md(tag)) => break,
                    Event::End(_) => {},
                    Event::Text(value) => out.push_str(&text(&value)),
                    Event::Code(value) => out.push_str(&format!("#raw({})", string(&value))),
                    Event::InlineMath(ref value) | Event::DisplayMath(ref value) => {
                        let display = matches!(&event, Event::DisplayMath(_));
                        let math = mitex::convert_math(&value, None).map_err(|e| anyhow::anyhow!("LaTeX conversion failed for {value}: {e}"))?;
                        let expression = format!("#eval({}, scope: smd-math-scope)", string(&format!("${}$", compatible_math(&math))));
                        out.push_str(&if display { format!("\n#smd-fit(math.equation(block: true, [{expression}]))\n\n") } else { expression });
                    },
                    Event::SoftBreak => out.push(' '),
                    Event::HardBreak => out.push_str("#linebreak()"),
                    Event::Rule => out.push_str("\n#line(length: 100%, stroke: .5pt + rgb(\"#d6dde5\"))\n"),
                    Event::TaskListMarker(checked) => out.push_str(if checked { "#text(\"☑ \u{a0}\")" } else { "#text(\"☐ \u{a0}\")" }),
                    Event::FootnoteReference(name) => out.push_str(&format!("#footnote[{}]", self.footnotes.get(name.as_ref()).cloned().unwrap_or_else(|| text(&name)))),
                    Event::Html(html) | Event::InlineHtml(html) => { if html.trim().starts_with("<br") { out.push_str("#linebreak()"); } else { out.push_str(&text(&html)); } },
                    Event::Start(tag) => {
                        let close = RenderEnd::Md(tag.to_end());
                        match tag {
                            Tag::CodeBlock(kind) => {
                                let mut code = String::new();
                                while let Some(e) = self.events.next() { if e == DocEvent::Md(Event::End(TagEnd::CodeBlock)) { break; } if let DocEvent::Md(Event::Text(v)) = e { code.push_str(&v); } }
                                let lang = match kind { CodeBlockKind::Fenced(v) => v.to_string(), _ => String::new() };
                                if ["smd-steps", "smd-step-grid"].contains(&lang.as_str()) {
                                    out.push_str(&step_grid::render(&code, self.assets)?);
                                    continue;
                                }
                                if ["mermaid", "smd-chart"].contains(&lang.as_str()) { bail!("Export preparation did not render a {lang} block"); }
                                // Individual lines fit the available width while the
                                // enclosing block stays breakable across pages.
                                out.push_str("\n#block(width: 100%, breakable: true, fill: smd-code-fill, inset: 8pt)[\n");
                                // Each fit is a block-level layout. Adding a separate
                                // linebreak after it creates empty paragraphs and
                                // wastes most of a page on short snippets.
                                out.push_str("#set par(spacing: 0pt, leading: .3em)\n");
                                for line in code.lines() { out.push_str(&format!("#block(height: 1.2em, above: 0pt, below: 0pt)[#smd-fit(raw({}, lang: {}))]\n", string(if line.is_empty() { " " } else { line }), string(&lang))); }
                                out.push_str("]\n\n");
                            },
                            Tag::Image { dest_url, .. } => {
                                let _alt = self.render(Some(close))?;
                                let key = dest_url.to_string();
                                if !self.assets.contains_key(&key) { bail!("Image unavailable for PDF: {key}"); }
                                out.push_str(&format!("#smd-image({})", string(&key)));
                            },
                            Tag::Table(columns) => {
                                let mut lengths = vec![0usize; columns.len()]; let mut counts = vec![0usize; columns.len()]; let mut column = 0; let mut length = 0;
                                for event in self.events.clone() {
                                    match event {
                                        DocEvent::Md(Event::End(TagEnd::Table)) => break,
                                        DocEvent::Md(Event::Start(Tag::TableCell)) => length = 0,
                                        DocEvent::Md(Event::Text(value) | Event::Code(value) | Event::InlineMath(value) | Event::DisplayMath(value)) => length += value.chars().count(),
                                        DocEvent::Md(Event::End(TagEnd::TableCell)) => { lengths[column] += length.min(180); counts[column] += 1; column = (column + 1) % columns.len(); },
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
                                let first_line = if matches!(self.events.peek(), Some(DocEvent::Md(Event::Start(Tag::Paragraph)))) {
                                    self.events.clone().skip(1).take_while(|event| !matches!(event, DocEvent::Md(Event::SoftBreak | Event::HardBreak | Event::End(TagEnd::Paragraph)))).filter_map(|event| match event { DocEvent::Md(Event::Text(value) | Event::Code(value)) => Some(value.to_string()), _ => None }).collect::<String>()
                                } else { String::new() };
                                let callout = first_line.strip_prefix("[!").and_then(|v| v.split_once(']')).map(|(kind, title)| (kind.to_lowercase(), title.trim_start_matches(['+', '-']).trim().to_string()));
                                let (body, accent) = if let Some((kind, title)) = callout {
                                    self.events.next();
                                    while !matches!(self.events.peek(), None | Some(DocEvent::Md(Event::SoftBreak | Event::HardBreak | Event::End(TagEnd::Paragraph)))) { self.events.next(); }
                                    if matches!(self.events.peek(), Some(DocEvent::Md(Event::SoftBreak | Event::HardBreak))) { self.events.next(); }
                                    let title = if title.is_empty() { kind.clone() } else { title };
                                    let body = self.render(Some(RenderEnd::Md(TagEnd::Paragraph)))? + "\n\n" + &self.render(Some(close))?;
                                    let accent = match kind.as_str() { "tip" | "hint" | "success" | "check" | "done" => "#14735b", "warning" | "caution" => "#946200", "danger" | "error" | "failure" | "fail" | "missing" => "#b3261e", _ => "#315d99" };
                                    let icon = match kind.as_str() {"tip"|"hint"=>"tip","warning"|"caution"=>"warning","danger"|"error"=>"error","success"|"check"|"done"=>"success","question"|"faq"=>"question","answer"|"solution"=>"answer","example"=>"example","quote"|"cite"=>"quote",_=>"info"};
                                    (format!("#block(sticky: true, below: 6pt)[#text(weight: \"bold\", fill: rgb(\"{accent}\"))[#box(image(\"__smd_icon_{icon}.svg\", width: 11pt)) #h(4pt) {}]]\n\n{body}", text(&title)), accent)
                                } else { (self.render(Some(close))?, "#315d99") };
                                out.push_str(&format!("\n#block(width: 100%, breakable: true, fill: if smd-themed {{ smd-callout-fill }} else {{ color.mix((white, 94%), (rgb(\"{accent}\"), 6%)) }}, stroke: (left: 2pt + rgb(\"{accent}\")), inset: 10pt, radius: 4pt)[{body}]\n\n"));
                            },
                            _ => {
                                let heading = if matches!(tag, Tag::Heading { .. }) {
                                    let plain = self.events.clone().take_while(|e| !matches!(e, DocEvent::Md(Event::End(TagEnd::Heading(_))))).filter_map(|e| match e { DocEvent::Md(Event::Text(v) | Event::Code(v) | Event::InlineMath(v)) => Some(v.to_string()), _ => None }).collect::<String>();
                                    let slug = heading_slug(&plain); let count = self.heading_counts.entry(slug.clone()).or_default();
                                    let id = if *count == 0 { slug } else { format!("{slug}-{count}") }; *count += 1; Some(id)
                                } else { None };
                                let body = self.render(Some(close))?;
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
                                        let slug = heading_slug(&decoded);
                                        if self.headings.contains_key(&slug) { format!("#link(label({}))[{body}]", string(&format!("smd-{slug}"))) } else { body }
                                    } else if dest_url.starts_with("https:") || dest_url.starts_with("http:") || dest_url.starts_with("mailto:") { format!("#link({})[{body}]", string(&dest_url)) } else { body }),
                                    _ => out.push_str(&body),
                                }
                            }
                        }
                    },
                }
            }
        }
        Ok(out)
    }
}

pub(crate) fn render_fragment(markdown: &str, assets: &HashMap<String, Vec<u8>>) -> Result<String> {
    let stripped = strip_percent_comments(markdown);
    let normalized = normalize_table_math(&normalize_callouts(&stripped));
    let events = enrich_events(&normalized, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_SUBSCRIPT | Options::ENABLE_SUPERSCRIPT | Options::ENABLE_MATH);
    Renderer { events: events.into_iter().peekable(), assets, footnotes: HashMap::new(), headings: HashMap::new(), heading_counts: HashMap::new() }.render(None)
}

pub fn source(markdown: &str, options: &PdfOptions, assets: &HashMap<String, Vec<u8>>) -> Result<String> {
    options.validate()?;
    let stripped = strip_percent_comments(markdown);
    let normalized = normalize_table_math(&normalize_callouts(&stripped));
    let events = enrich_events(&normalized, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_SUBSCRIPT | Options::ENABLE_SUPERSCRIPT | Options::ENABLE_TASKLISTS | Options::ENABLE_MATH | Options::ENABLE_FOOTNOTES);
    let mut headings = HashMap::new(); let mut current = None::<String>;
    for event in &events { match event {
        DocEvent::Md(Event::Start(Tag::Heading { .. })) => current = Some(String::new()),
        DocEvent::Md(Event::Text(v) | Event::Code(v) | Event::InlineMath(v)) => { if let Some(text) = &mut current { text.push_str(v); } },
        DocEvent::Md(Event::End(TagEnd::Heading(_))) => { if let Some(text) = current.take() { let slug = heading_slug(&text); let count = headings.get(&slug).copied().unwrap_or(0); if count > 0 { headings.insert(format!("{slug}-{count}"), 1); } headings.insert(slug, count + 1); } },
        _ => {}
    } }
    let mut renderer = Renderer { events: events.into_iter().peekable(), assets, footnotes: HashMap::new(), headings, heading_counts: HashMap::new() };
    // References normally precede definitions, so collect definitions first.
    let mut definitions = Renderer { events: renderer.events.clone(), assets, footnotes: HashMap::new(), headings: renderer.headings.clone(), heading_counts: HashMap::new() };
    while let Some(event) = definitions.events.next() {
        if let DocEvent::Md(Event::Start(Tag::FootnoteDefinition(name))) = event { let value = definitions.render(Some(RenderEnd::Md(TagEnd::FootnoteDefinition)))?; definitions.footnotes.insert(name.to_string(), value); }
    }
    renderer.footnotes = definitions.footnotes;
    let body = renderer.render(None)?;
    let template = if options.page_numbers { include_str!("document.typ").to_string() } else { include_str!("document.typ").lines().filter(|line| !line.starts_with("#set page(footer:")).collect::<Vec<_>>().join("\n") };
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
    Ok(format!("#import \"/mitex/standard.typ\": scope as mitex-scope\n#let smd-math-scope = mitex-scope + (sect: sym.inter,)\n{palette}#set page(paper: {}, margin: {}mm, fill: smd-paper)\n#set text(font: ({}, \"Libertinus Serif\", \"New Computer Modern\"), size: {}pt)\n#set par(leading: {}em, spacing: {}em)\n{template}\n{body}", string(paper), options.margin, string(&options.font_family), options.font_size, options.line_height - 0.7, options.line_height - 0.7 + options.paragraph_spacing))
}

pub fn export(markdown: &str, options: &PdfOptions, assets: &HashMap<String, Vec<u8>>) -> Result<Vec<u8>> {
    let source = source(markdown, options, assets)?;
    let engine = TypstEngine::builder()
        .main_file(source)
        .fonts([
            include_bytes!("../fonts/NotoSans-Regular.ttf").as_slice(),
            include_bytes!("../fonts/NotoSans-Bold.ttf").as_slice(),
            include_bytes!("../fonts/NotoSans-Italic.ttf").as_slice(),
            include_bytes!("../fonts/NotoSans-BoldItalic.ttf").as_slice(),
            include_bytes!("../fonts/Manrope.ttf").as_slice(),
            include_bytes!("../fonts/Roboto.ttf").as_slice(),
            include_bytes!("../fonts/NotoSerif.ttf").as_slice(),
            include_bytes!("../fonts/JetBrainsMono.ttf").as_slice(),
            include_bytes!("../fonts/NotoEmoji.ttf").as_slice(),
        ].into_iter().chain(assets.iter().filter(|(name,_)| name.starts_with("__font_") && (name.ends_with(".ttf") || name.ends_with(".otf"))).map(|(_,bytes)| bytes.as_slice())))
        .search_fonts_with(TypstKitFontOptions::default().include_system_fonts(!cfg!(target_os="android")).include_embedded_fonts(true))
        .with_static_file_resolver(assets.iter().map(|(k,v)| (k.as_str(), v.as_slice())).chain([
            ("__smd_icon_tip.svg",include_bytes!("../../desktop/icons/CalloutTip.svg").as_slice()),
            ("__smd_icon_warning.svg",include_bytes!("../../desktop/icons/CalloutWarning.svg").as_slice()),
            ("__smd_icon_info.svg",include_bytes!("../../desktop/icons/CalloutInfo.svg").as_slice()),
            ("__smd_icon_error.svg",include_bytes!("../../desktop/icons/CalloutError.svg").as_slice()),
            ("__smd_icon_success.svg",include_bytes!("../../desktop/icons/CalloutSuccess.svg").as_slice()),
            ("__smd_icon_question.svg",include_bytes!("../../desktop/icons/CalloutQuestion.svg").as_slice()),
            ("__smd_icon_answer.svg",include_bytes!("../../desktop/icons/CalloutAnswer.svg").as_slice()),
            ("__smd_icon_example.svg",include_bytes!("../../desktop/icons/CalloutExample.svg").as_slice()),
            ("__smd_icon_quote.svg",include_bytes!("../../desktop/icons/CalloutQuote.svg").as_slice()),
        ]))
        .with_static_source_file_resolver([
            ("mitex/standard.typ", include_str!("mitex/standard.typ")),
            ("mitex/prelude.typ", include_str!("mitex/prelude.typ")),
        ])
        .build();
    let document = engine.compile().output.map_err(|errors| anyhow::anyhow!("PDF typesetting failed: {errors:?}"))?;
    typst_pdf::pdf(&document, &Default::default()).map(|v| v.to_vec()).map_err(|e| anyhow::anyhow!("PDF encoding failed: {e:?}"))
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_dev_supermd_studio_PdfEngine_validateTheme(
    mut env: jni::JNIEnv, _class: jni::objects::JClass, input: jni::objects::JString,
) -> jni::sys::jstring {
    let result = match env.get_string(&input) { Ok(value)=>theme::response(&String::from(value)), Err(_)=>"{\"error\":\"Invalid theme input\"}".into() };
    env.new_string(result).expect("Theme response").into_raw()
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_dev_supermd_studio_PdfEngine_fontFamilies(
    mut env: jni::JNIEnv, _class: jni::objects::JClass, path: jni::objects::JString,
) -> jni::sys::jstring {
    let result = (|| -> Result<Vec<String>> {
        let path: String = env.get_string(&path)?.into();
        if std::fs::metadata(&path)?.len()>20_000_000 { bail!("Font exceeds 20 MB"); }
        let bytes=typst::foundations::Bytes::new(std::fs::read(path)?);
        Ok(typst::text::Font::iter(bytes).map(|font| font.info().family.clone()).collect())
    })();
    env.new_string(serde_json::to_string(&result.unwrap_or_default()).unwrap()).unwrap().into_raw()
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_dev_supermd_studio_PdfEngine_imageSources(
    mut env: jni::JNIEnv, _class: jni::objects::JClass, markdown: jni::objects::JString,
) -> jni::sys::jstring {
    let markdown: String = env.get_string(&markdown).expect("Markdown string").into();
    env.new_string(serde_json::to_string(&image_sources(&markdown)).unwrap()).unwrap().into_raw()
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_dev_supermd_studio_PdfEngine_export(
    mut env: jni::JNIEnv, _class: jni::objects::JClass, markdown: jni::objects::JString,
    options: jni::objects::JString, asset_dir: jni::objects::JString, output: jni::objects::JString,
) -> jni::sys::jstring {
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
    env.new_string(result.err().map(|e| format!("{e:#}")).unwrap_or_default()).unwrap().into_raw()
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
    fn study_markdown_and_safe_html_typeset_and_preserve_code_math_and_security() {
        let md = r#"<!-- SECRET_BLOCK_COMMENT
spanning lines -->
%%SECRET_OBSIDIAN_HEADER
![ignored](missing-comment-image.png)%%

# Study Notes H~2~O

==Highlighted concept== with H~2~O, x^2^, ~~deprecated~~, %%SECRET_INLINE_COMMENT%%<!-- SECRET_INLINE_HTML --> and Press <kbd onclick="evil()">Ctrl</kbd>+<kbd>S</kbd>, <mark style="color:red">marked</mark>, <u>underlined</u>, CO<sub>2</sub>, 10<sup>-6</sup>.<br>Second line.

Spaced ~not sub~ and ^not sup^, comparison if a == b and c == d, unmatched <mark>rawmark, and inline <script>alert(1)</script>.

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
        assert!(typst_src.contains("#super[#text(\"2\")]"), "Expected Typst #super: {typst_src}");
        assert!(typst_src.contains("#super[#text(\"-6\")]"), "Expected HTML <sup> -> #super: {typst_src}");
        assert!(typst_src.contains("#highlight(fill: smd-highlight"), "Expected Typst #highlight: {typst_src}");
        assert!(typst_src.contains("#underline[#text(\"underlined\")]"), "Expected Typst #underline: {typst_src}");
        assert!(typst_src.contains("#box(fill: smd-code-fill"), "Expected Typst #box for <kbd>: {typst_src}");
        assert!(typst_src.contains("#strike[#text(\"deprecated\")]"), "Expected Typst #strike for ~~...~~: {typst_src}");
        assert!(typst_src.contains("#linebreak()"), "Expected Typst #linebreak() for <br>: {typst_src}");
        assert!(!typst_src.contains("SECRET_BLOCK_COMMENT"));
        assert!(!typst_src.contains("SECRET_OBSIDIAN_HEADER"));
        assert!(!typst_src.contains("SECRET_INLINE_COMMENT"));
        assert!(!typst_src.contains("SECRET_INLINE_HTML"));
        assert!(!typst_src.contains("onclick"));
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
                    let extracted = String::from_utf8_lossy(&output.stdout);
                    assert!(extracted.contains("Highlighted concept"));
                    assert!(extracted.contains("underlined"));
                    assert!(extracted.contains("Ctrl"));
                    assert!(extracted.contains("~not sub~"));
                    assert!(extracted.contains("^not sup^"));
                    assert!(extracted.contains("<script>alert(1)</script>"));
                    assert!(!extracted.contains("SECRET_BLOCK_COMMENT"));
                    assert!(!extracted.contains("SECRET_OBSIDIAN_HEADER"));
                    assert!(!extracted.contains("SECRET_INLINE_COMMENT"));
                    assert!(!extracted.contains("SECRET_INLINE_HTML"));
                }
                let _ = std::fs::remove_file(path);
            }
        }
    }
}
