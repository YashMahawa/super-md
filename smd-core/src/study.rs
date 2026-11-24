use pulldown_cmark::{CowStr, Event, LinkType, Options, Parser, Tag, TagEnd};
use std::borrow::Cow;

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
pub fn strip_percent_comments(input: &str) -> Cow<'_, str> {
    if !input.contains("%%") {
        return Cow::Borrowed(input);
    }
    let mut mask = vec![false; input.len()];
    let mut in_code_block = false;
    for (event, range) in Parser::new_ext(input, Options::ENABLE_MATH).into_offset_iter() {
        match event {
            Event::Start(Tag::CodeBlock(_)) => {
                in_code_block = true;
                mask[range].fill(true);
            }
            Event::End(TagEnd::CodeBlock) => in_code_block = false,
            Event::Code(_) | Event::InlineMath(_) | Event::DisplayMath(_) => mask[range].fill(true),
            _ if in_code_block => mask[range].fill(true),
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
        let Some(end) = (i + 2..bytes.len().saturating_sub(1)).find(|&j| is_unescaped_percent_pair(bytes, &mask, j, i + 2)) else {
            break;
        };
        out.push_str(&input[cursor..i]);
        cursor = end + 2;
        i = cursor;
    }
    if cursor == 0 {
        return Cow::Borrowed(input);
    }
    out.push_str(&input[cursor..]);
    Cow::Owned(out)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DelimKind {
    Highlight,
    Sub,
    Sup,
}

enum HtmlTok {
    Br,
    Tag { open: bool, name: &'static str },
}

enum Node<'a> {
    Text(CowStr<'a>, bool),
    Leaf(Event<'a>),
    HtmlTag { open: bool, name: &'static str, raw: String },
    Group { start: Event<'a>, end: Event<'a>, children: Vec<Node<'a>>, phrasing: bool },
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

fn span_group<'a>(name: &'static str, children: Vec<Node<'a>>) -> Node<'a> {
    let (start, end) = match name {
        "sub" => (Event::Start(Tag::Subscript), Event::End(TagEnd::Subscript)),
        "sup" => (Event::Start(Tag::Superscript), Event::End(TagEnd::Superscript)),
        "mark" => (Event::InlineHtml("<mark>".into()), Event::InlineHtml("</mark>".into())),
        "u" => (Event::InlineHtml("<u>".into()), Event::InlineHtml("</u>".into())),
        "kbd" => (Event::InlineHtml("<kbd>".into()), Event::InlineHtml("</kbd>".into())),
        _ => unreachable!(),
    };
    Node::Group { start, end, children, phrasing: true }
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

fn tokenize_raw_html<'a>(raw: &str, out: &mut Vec<Node<'a>>) {
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
        }
        literal.push('<');
        i = lt + 1;
    }
    flush(&mut literal, out);
}

fn has_break(node: &Node<'_>, reject_spaces: bool) -> bool {
    match node {
        Node::Text(v, _) => if reject_spaces { v.chars().any(char::is_whitespace) } else { v.contains(['\n', '\r']) },
        Node::Leaf(Event::SoftBreak | Event::HardBreak) => true,
        Node::Group { children, .. } => children.iter().any(|c| has_break(c, reject_spaces)),
        _ => false,
    }
}

fn fold_html_tags<'a>(nodes: Vec<Node<'a>>) -> Vec<Node<'a>> {
    let mut out: Vec<Node<'a>> = Vec::new();
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

fn merge_unescaped_text<'a>(nodes: Vec<Node<'a>>) -> Vec<Node<'a>> {
    let mut out: Vec<Node<'a>> = Vec::with_capacity(nodes.len());
    for node in nodes {
        if let Node::Text(val, false) = node {
            if let Some(Node::Text(prev, false)) = out.last_mut() {
                let mut combined = prev.to_string();
                combined.push_str(&val);
                *prev = CowStr::from(combined);
                continue;
            }
            out.push(Node::Text(val, false));
        } else {
            out.push(node);
        }
    }
    out
}

fn apply_study_delimiters<'a>(nodes: Vec<Node<'a>>) -> Vec<Node<'a>> {
    enum Piece<'a> {
        Node(Node<'a>),
        Text(String, bool),
        Delim { kind: DelimKind, can_open: bool, can_close: bool },
    }
    fn to_nodes<'a>(pieces: Vec<Piece<'a>>) -> Vec<Node<'a>> {
        merge_unescaped_text(pieces.into_iter().filter_map(|p| match p {
            Piece::Node(n) => Some(n),
            Piece::Text(s, esc) => (!s.is_empty()).then(|| Node::Text(CowStr::from(s), esc)),
            Piece::Delim { kind, .. } => Some(Node::Text(CowStr::from(match kind {
                DelimKind::Highlight => "==",
                DelimKind::Sub => "~",
                DelimKind::Sup => "^",
            }), false)),
        }).collect())
    }
    fn boundary_char(node: &Node<'_>, front: bool) -> Option<char> {
        match node {
            Node::Leaf(Event::SoftBreak | Event::HardBreak) => Some('\n'),
            Node::Text(s, _) => if front { s.chars().next() } else { s.chars().next_back() },
            _ => Some('x'),
        }
    }

    let nodes = merge_unescaped_text(nodes);
    if !nodes.iter().any(|n| matches!(n, Node::Text(s, false) if s.contains(['=', '~', '^']))) {
        return nodes;
    }
    let mut pieces: Vec<Piece<'a>> = Vec::new();
    let mut saw_delim = false;
    let mut iter = nodes.into_iter().peekable();
    let mut prev_b: Option<char> = None;
    while let Some(node) = iter.next() {
        let next_b = iter.peek().and_then(|n| boundary_char(n, true));
        let cur_end_b = boundary_char(&node, false);
        let Node::Text(val, false) = node else {
            pieces.push(Piece::Node(node));
            prev_b = cur_end_b;
            continue;
        };
        let s = val.as_ref();
        if !s.contains(['=', '~', '^']) {
            pieces.push(Piece::Text(s.to_string(), false));
            prev_b = cur_end_b;
            continue;
        }
        let bytes = s.as_bytes();
        let mut buf = String::new();
        let mut i = 0usize;
        while i < s.len() {
            let b = bytes[i];
            if matches!(b, b'=' | b'~' | b'^') {
                let run = 1 + bytes[i + 1..].iter().take_while(|&&c| c == b).count();
                if (b == b'=' && run == 2) || ((b == b'~' || b == b'^') && run == 1) {
                    let before = if i > 0 { s[..i].chars().next_back() } else { prev_b };
                    let after = if i + run < s.len() { s[i + run..].chars().next() } else { next_b };
                    let can_open = after.is_some_and(|c| !c.is_whitespace());
                    let can_close = before.is_some_and(|c| !c.is_whitespace());
                    if can_open || can_close {
                        if !buf.is_empty() {
                            pieces.push(Piece::Text(std::mem::take(&mut buf), false));
                        }
                        saw_delim = true;
                        let kind = match b { b'=' => DelimKind::Highlight, b'~' => DelimKind::Sub, _ => DelimKind::Sup };
                        pieces.push(Piece::Delim { kind, can_open, can_close });
                        i += run;
                        continue;
                    }
                }
                buf.push_str(&s[i..i + run]);
                i += run;
                continue;
            }
            let ch = s[i..].chars().next().unwrap();
            buf.push(ch);
            i += ch.len_utf8();
        }
        if !buf.is_empty() {
            pieces.push(Piece::Text(buf, false));
        }
        prev_b = cur_end_b;
    }
    if !saw_delim {
        return to_nodes(pieces);
    }
    let valid = |kind: DelimKind, slice: &[Piece<'_>]| -> bool {
        let reject_spaces = kind != DelimKind::Highlight;
        !slice.is_empty() && !slice.iter().any(|p| match p {
            Piece::Text(s, _) => if reject_spaces { s.chars().any(char::is_whitespace) } else { s.contains(['\n', '\r']) },
            Piece::Node(n) => has_break(n, reject_spaces),
            Piece::Delim { .. } => false,
        })
    };
    let mut working: Vec<Piece<'a>> = Vec::new();
    let mut openers: Vec<(usize, DelimKind)> = Vec::new();
    for piece in pieces {
        let Piece::Delim { kind, can_open, can_close } = piece else {
            working.push(piece);
            continue;
        };
        if let Some(open_idx) = can_close.then(|| openers.iter().rposition(|(pos, k)| *k == kind && valid(kind, &working[*pos + 1..]))).flatten() {
            let (pos, _) = openers[open_idx];
            openers.truncate(open_idx);
            let inner = to_nodes(working.drain(pos + 1..).collect());
            let name = match kind { DelimKind::Highlight => "mark", DelimKind::Sub => "sub", DelimKind::Sup => "sup" };
            working[pos] = Piece::Node(span_group(name, inner));
        } else {
            let pos = working.len();
            working.push(Piece::Delim { kind, can_open, can_close });
            if can_open { openers.push((pos, kind)); }
        }
    }
    to_nodes(working)
}

fn link_literal_text(nodes: &[Node<'_>]) -> Option<String> {
    let mut out = String::new();
    for node in nodes {
        match node {
            Node::Text(t, _) => out.push_str(t),
            Node::Group { start: Event::Start(Tag::Subscript), children, .. } => {
                out.push('~'); out.push_str(&link_literal_text(children)?); out.push('~');
            }
            Node::Group { start: Event::Start(Tag::Superscript), children, .. } => {
                out.push('^'); out.push_str(&link_literal_text(children)?); out.push('^');
            }
            _ => return None,
        }
    }
    Some(out)
}

fn process_nodes<'a>(nodes: Vec<Node<'a>>, phrasing: bool) -> Vec<Node<'a>> {
    let folded = fold_html_tags(nodes);
    let delimited = if phrasing { apply_study_delimiters(folded) } else { merge_unescaped_text(folded) };
    delimited.into_iter().map(|node| match node {
        Node::Group { start, end, children, phrasing: child_phrasing } => {
            if matches!(start, Event::Start(Tag::CodeBlock(_))) {
                Node::Group { start, end, children, phrasing: false }
            } else {
                Node::Group { start, end, children: process_nodes(children, child_phrasing), phrasing: child_phrasing }
            }
        }
        other => other,
    }).collect()
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
                    if inner == Event::End(TagEnd::HtmlBlock) { break; }
                    if let Event::Html(h) | Event::Text(h) = inner { raw.push_str(&h); }
                }
                let mut tokens = Vec::new();
                tokenize_raw_html(raw.trim_end_matches(['\r', '\n']), &mut tokens);
                let folded = fold_html_tags(tokens);
                if !folded.iter().all(|n| matches!(n, Node::Text(s, _) if s.trim().is_empty())) {
                    out.push(Node::Group { start: Event::Start(Tag::Paragraph), end: Event::End(TagEnd::Paragraph), children: folded, phrasing: true });
                }
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                let mut children = Vec::new();
                for (inner, _) in iter.by_ref() {
                    if inner == Event::End(TagEnd::CodeBlock) { break; }
                    children.push(Node::Leaf(inner));
                }
                out.push(Node::Group { start: Event::Start(Tag::CodeBlock(kind)), end: Event::End(TagEnd::CodeBlock), children, phrasing: false });
            }
            Event::Start(tag @ (Tag::Subscript | Tag::Superscript)) => {
                let is_sub = matches!(tag, Tag::Subscript);
                let close = tag.to_end();
                let children = build_nodes(iter, source, Some(close));
                if children.is_empty() || children.iter().any(|n| has_break(n, true)) {
                    let marker = if is_sub { "~" } else { "^" };
                    out.push(Node::Text(CowStr::from(marker), true));
                    out.extend(children);
                    out.push(Node::Text(CowStr::from(marker), true));
                } else {
                    out.push(Node::Group { start: Event::Start(tag), end: Event::End(close), children, phrasing: true });
                }
            }
            Event::Start(tag) => {
                let close = tag.to_end();
                let mut children = build_nodes(iter, source, Some(close));
                let mut phrasing = matches!(tag, Tag::Paragraph | Tag::Heading { .. } | Tag::TableCell | Tag::Emphasis | Tag::Strong | Tag::Strikethrough | Tag::Link { .. });
                if let Tag::Link { link_type, ref dest_url, .. } = tag {
                    if matches!(link_type, LinkType::Autolink | LinkType::Email) {
                        phrasing = false;
                    } else if let Some(plain) = link_literal_text(&children) {
                        let url = dest_url.as_ref();
                        if url == plain || url == format!("mailto:{plain}") || url == format!("http://{plain}") {
                            children = vec![Node::Text(CowStr::from(plain), true)];
                            phrasing = false;
                        }
                    }
                }
                out.push(Node::Group { start: Event::Start(tag), end: Event::End(close), children, phrasing });
            }
            Event::InlineHtml(html) | Event::Html(html) => tokenize_raw_html(&html, &mut out),
            Event::Text(value) => {
                let escaped = range.end > range.start + value.len() && source.as_bytes().get(range.start) == Some(&b'\\');
                out.push(Node::Text(value, escaped));
            }
            other => out.push(Node::Leaf(other)),
        }
    }
    out
}

fn flatten<'a>(nodes: Vec<Node<'a>>, out: &mut Vec<Event<'a>>) {
    for node in nodes {
        match node {
            Node::Text(val, _) => out.push(Event::Text(val)),
            Node::Leaf(ev) => out.push(ev),
            Node::HtmlTag { raw, .. } => out.push(Event::Text(CowStr::from(raw))),
            Node::Group { start, end, children, .. } => {
                out.push(start);
                flatten(children, out);
                out.push(end);
            }
        }
    }
}

pub(crate) fn enrich_events<'a>(normalized: &'a str, options: Options) -> Vec<Event<'a>> {
    if !normalized.as_bytes().iter().any(|b| matches!(b, b'=' | b'~' | b'^' | b'<')) {
        return Parser::new_ext(normalized, options).collect();
    }
    let mut iter = Parser::new_ext(normalized, options).into_offset_iter();
    let tree = build_nodes(&mut iter, normalized, None);
    let processed = process_nodes(tree, false);
    let mut out = Vec::new();
    flatten(processed, &mut out);
    out
}
