use super::{span_group, Node};
use crate::html_scan::{is_page_break_div, scan_html_tag};
use pulldown_cmark::{CowStr, Event};

enum HtmlTok {
    Br,
    Tag { open: bool, name: &'static str },
}

fn allowed_tag(name: &str) -> Option<&'static str> {
    match name {
        "mark" => Some("mark"),
        "sub" => Some("sub"),
        "sup" => Some("sup"),
        "kbd" => Some("kbd"),
        "u" => Some("u"),
        _ => None,
    }
}

fn parse_html_tag(s: &str) -> Option<(HtmlTok, usize)> {
    let b = s.as_bytes();
    if b.len() < 3 || b[0] != b'<' {
        return None;
    }
    let (closing, name_start) = if b[1] == b'/' { (true, 2) } else { (false, 1) };
    let name_end = name_start + b[name_start..].iter().take_while(|c| c.is_ascii_alphabetic()).count();
    if name_end == name_start {
        return None;
    }
    let lower = s[name_start..name_end].to_ascii_lowercase();
    if closing {
        let name = allowed_tag(&lower)?;
        let p = name_end + b[name_end..].iter().take_while(|c| c.is_ascii_whitespace()).count();
        return (b.get(p) == Some(&b'>')).then_some((HtmlTok::Tag { open: false, name }, p + 1));
    }
    if lower != "br" && allowed_tag(&lower).is_none() {
        return None;
    }
    if !b.get(name_end).is_some_and(|c| matches!(c, b'>' | b'/') || c.is_ascii_whitespace()) {
        return None;
    }
    let mut p = name_end;
    while p < b.len() && b[p] != b'>' {
        if b[p] == b'"' || b[p] == b'\'' {
            let quote = b[p];
            p += 1 + b[p + 1..].iter().position(|&c| c == quote)?;
        }
        p += 1;
    }
    if p >= b.len() {
        return None;
    }
    let self_closing = s[name_end..p].trim_end_matches(|c: char| c.is_ascii_whitespace()).ends_with('/');
    if lower == "br" {
        return Some((HtmlTok::Br, p + 1));
    }
    (!self_closing).then(|| (HtmlTok::Tag { open: true, name: allowed_tag(&lower).unwrap() }, p + 1))
}

pub(super) fn tokenize_raw_html<'a>(raw: &str, out: &mut Vec<Node<'a>>) {
    let mut literal = String::new();
    let flush = |lit: &mut String, out: &mut Vec<Node<'a>>| {
        if !lit.is_empty() {
            out.push(Node::Text(CowStr::from(std::mem::take(lit)), false));
        }
    };
    let mut i = 0usize;
    while i < raw.len() {
        let Some(rel) = raw[i..].find('<') else {
            literal.push_str(&raw[i..]);
            break;
        };
        let lt = i + rel;
        literal.push_str(&raw[i..lt]);
        if let Some(after_open) = raw[lt..].strip_prefix("<!--") {
            if let Some(end_rel) = after_open.find("-->") {
                flush(&mut literal, out);
                i = lt + 4 + end_rel + 3;
                continue;
            }
        } else if let Some((tok, len)) = parse_html_tag(&raw[lt..]) {
            flush(&mut literal, out);
            match tok {
                HtmlTok::Br => out.push(Node::Leaf(Event::HardBreak)),
                HtmlTok::Tag { open, name } => out.push(Node::HtmlTag { open, name, raw: raw[lt..lt + len].to_string() }),
            }
            i = lt + len;
            continue;
        } else if let Some(scanned) = scan_html_tag(&raw[lt..], 0) {
            let tag_slice = &raw[lt..lt + scanned.end];
            if !scanned.closing && scanned.name.eq_ignore_ascii_case("img") && scanned.attr("src").is_some_and(|s| !s.trim().is_empty()) {
                flush(&mut literal, out);
                out.push(Node::Leaf(Event::InlineHtml(CowStr::from(tag_slice.to_string()))));
                i = lt + scanned.end;
                continue;
            }
            if !scanned.closing && is_page_break_div(tag_slice) {
                flush(&mut literal, out);
                out.push(Node::Leaf(Event::InlineHtml(CowStr::from(tag_slice.to_string()))));
                let mut next = lt + scanned.end;
                let trimmed_after = raw[next..].trim_start_matches(char::is_whitespace);
                let ws_len = raw[next..].len() - trimmed_after.len();
                if let Some(close_tag) = scan_html_tag(trimmed_after, 0) {
                    if close_tag.closing && close_tag.name.eq_ignore_ascii_case("div") {
                        next += ws_len + close_tag.end;
                    }
                }
                i = next;
                continue;
            }
        }
        literal.push('<');
        i = lt + 1;
    }
    flush(&mut literal, out);
}

pub(super) fn fold_html_tags<'a>(nodes: Vec<Node<'a>>) -> Vec<Node<'a>> {
    if !nodes.iter().any(|n| matches!(n, Node::HtmlTag { .. })) {
        return nodes;
    }
    let mut out: Vec<Node<'a>> = Vec::with_capacity(nodes.len());
    let mut stack: Vec<(&'static str, String, Vec<Node<'a>>)> = Vec::new();
    let emit = |item: Node<'a>, stack: &mut Vec<(&'static str, String, Vec<Node<'a>>)>, out: &mut Vec<Node<'a>>| {
        if let Some((_, _, top)) = stack.last_mut() { top.push(item); } else { out.push(item); }
    };
    for node in nodes {
        match node {
            Node::HtmlTag { open: true, name, raw } => stack.push((name, raw, Vec::new())),
            Node::HtmlTag { open: false, name, raw } => {
                if let Some(pos) = stack.iter().rposition(|(s, _, _)| *s == name) {
                    while stack.len() - 1 > pos {
                        let (_, unclosed_raw, unclosed_children) = stack.pop().unwrap();
                        emit(Node::Text(CowStr::from(unclosed_raw), false), &mut stack, &mut out);
                        for child in unclosed_children { emit(child, &mut stack, &mut out); }
                    }
                    let (matched, _, children) = stack.pop().unwrap();
                    emit(span_group(matched, children), &mut stack, &mut out);
                } else {
                    emit(Node::Text(CowStr::from(raw), false), &mut stack, &mut out);
                }
            }
            other => emit(other, &mut stack, &mut out),
        }
    }
    while let Some((_, unclosed_raw, unclosed_children)) = stack.pop() {
        emit(Node::Text(CowStr::from(unclosed_raw), false), &mut stack, &mut out);
        for child in unclosed_children { emit(child, &mut stack, &mut out); }
    }
    out
}
