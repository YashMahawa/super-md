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
    let Some(first_percent) = input.find("%%") else {
        return Cow::Borrowed(input);
    };
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
    let mut out = String::new();
    let mut cursor = 0usize;
    let mut i = first_percent;
    while let Some(rel) = input[i..].find("%%") {
        let open = i + rel;
        if !is_unescaped_percent_pair(bytes, &mask, open, cursor) {
            i = open + 1;
            continue;
        }
        let mut search = open + 2;
        let mut close = None;
        while let Some(end_rel) = input[search..].find("%%") {
            let cand = search + end_rel;
            if is_unescaped_percent_pair(bytes, &mask, cand, open + 2) {
                close = Some(cand);
                break;
            }
            search = cand + 1;
        }
        let Some(end) = close else {
            break;
        };
        if cursor == 0 {
            out.reserve(input.len());
        }
        out.push_str(&input[cursor..open]);
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
        } else if let Some(scanned) = crate::scan_html_tag(&raw[lt..], 0) {
            let tag_slice = &raw[lt..lt + scanned.end];
            if !scanned.closing && scanned.name.eq_ignore_ascii_case("img") && scanned.attr("src").is_some_and(|s| !s.trim().is_empty()) {
                flush(&mut literal, out);
                out.push(Node::Leaf(Event::InlineHtml(CowStr::from(tag_slice.to_string()))));
                i = lt + scanned.end;
                continue;
            }
            if !scanned.closing && crate::is_page_break_div(tag_slice) {
                flush(&mut literal, out);
                out.push(Node::Leaf(Event::InlineHtml(CowStr::from(tag_slice.to_string()))));
                let mut next = lt + scanned.end;
                let trimmed_after = raw[next..].trim_start_matches(char::is_whitespace);
                let ws_len = raw[next..].len() - trimmed_after.len();
                if let Some(close_tag) = crate::scan_html_tag(trimmed_after, 0) {
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

fn slice_cow<'a>(cow: &CowStr<'a>, range: std::ops::Range<usize>) -> CowStr<'a> {
    match cow {
        CowStr::Borrowed(s) => CowStr::Borrowed(&s[range]),
        _ => CowStr::from(cow.as_ref()[range].to_string()),
    }
}

fn has_study_delim_bytes(bytes: &[u8]) -> bool {
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'~' | b'^' => return true,
            b'=' if i + 1 < bytes.len() && bytes[i + 1] == b'=' => return true,
            _ => {}
        }
        i += 1;
    }
    false
}

fn has_enrich_trigger(bytes: &[u8]) -> bool {
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'<' | b'~' | b'^' => return true,
            b'=' if i + 1 < bytes.len() && bytes[i + 1] == b'=' => return true,
            _ => {}
        }
        i += 1;
    }
    false
}

fn str_has_ws(s: &str) -> bool {
    let bytes = s.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if b < 128 {
            if b == b' ' || (0x09..=0x0d).contains(&b) {
                return true;
            }
            i += 1;
        } else {
            return s[i..].chars().any(char::is_whitespace);
        }
    }
    false
}

fn has_break(node: &Node<'_>, reject_spaces: bool) -> bool {
    match node {
        Node::Text(v, _) => {
            if reject_spaces {
                str_has_ws(v)
            } else {
                v.as_bytes().iter().any(|&b| b == b'\n' || b == b'\r')
            }
        }
        Node::Leaf(Event::SoftBreak | Event::HardBreak) => true,
        Node::Group { children, .. } => children.iter().any(|c| has_break(c, reject_spaces)),
        _ => false,
    }
}

fn fold_html_tags<'a>(nodes: Vec<Node<'a>>) -> Vec<Node<'a>> {
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

fn merge_unescaped_text<'a>(nodes: Vec<Node<'a>>) -> Vec<Node<'a>> {
    if !nodes.windows(2).any(|w| matches!(w, [Node::Text(_, false), Node::Text(_, false)])) {
        return nodes;
    }
    let mut out: Vec<Node<'a>> = Vec::with_capacity(nodes.len());
    let mut iter = nodes.into_iter().peekable();
    while let Some(node) = iter.next() {
        if let Node::Text(first, false) = node {
            if matches!(iter.peek(), Some(Node::Text(_, false))) {
                let mut parts: Vec<CowStr<'a>> = vec![first];
                let mut total_len = parts[0].len();
                while let Some(Node::Text(_, false)) = iter.peek() {
                    let Some(Node::Text(next_val, false)) = iter.next() else { unreachable!() };
                    total_len += next_val.len();
                    parts.push(next_val);
                }
                let mut combined = String::with_capacity(total_len);
                for part in parts {
                    combined.push_str(&part);
                }
                out.push(Node::Text(CowStr::from(combined), false));
            } else {
                out.push(Node::Text(first, false));
            }
        } else {
            out.push(node);
        }
    }
    out
}

fn apply_study_delimiters<'a>(nodes: Vec<Node<'a>>) -> Vec<Node<'a>> {
    enum Piece<'a> {
        Node(Node<'a>),
        Text(CowStr<'a>, bool),
        Delim { kind: DelimKind, can_open: bool, can_close: bool },
    }
    fn to_nodes<'a, I: IntoIterator<Item = Piece<'a>>>(pieces: I) -> Vec<Node<'a>> {
        merge_unescaped_text(pieces.into_iter().filter_map(|p| match p {
            Piece::Node(n) => Some(n),
            Piece::Text(s, esc) => (!s.is_empty()).then_some(Node::Text(s, esc)),
            Piece::Delim { kind, .. } => Some(Node::Text(CowStr::Borrowed(match kind {
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

    fn delim_flanking(b: u8, before: Option<char>, after: Option<char>) -> (bool, bool) {
        let before_ws = before.is_none_or(char::is_whitespace);
        let after_ws = after.is_none_or(char::is_whitespace);
        if b != b'=' {
            return (!after_ws, !before_ws);
        }
        let is_punct = |c: char| c.is_ascii_punctuation() || (!c.is_alphanumeric() && !c.is_whitespace() && !c.is_control() && !('\u{0300}'..='\u{036F}').contains(&c));
        let before_punct = before.is_some_and(is_punct);
        let after_punct = after.is_some_and(is_punct);
        (
            !after_ws && (!after_punct || before_ws || before_punct),
            !before_ws && (!before_punct || after_ws || after_punct),
        )
    }

    let nodes = merge_unescaped_text(nodes);
    if !nodes.iter().any(|n| matches!(n, Node::Text(s, false) if has_study_delim_bytes(s.as_bytes()))) {
        return nodes;
    }
    let mut pieces: Vec<Piece<'a>> = Vec::with_capacity(nodes.len() + 4);
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
        let bytes = val.as_bytes();
        if !has_study_delim_bytes(bytes) {
            pieces.push(Piece::Text(val, false));
            prev_b = cur_end_b;
            continue;
        }
        let s = val.as_ref();
        let mut seg_start = 0usize;
        let mut split = false;
        let mut i = 0usize;
        while i < bytes.len() {
            let b = bytes[i];
            if matches!(b, b'=' | b'~' | b'^') {
                let run = 1 + bytes[i + 1..].iter().take_while(|&&c| c == b).count();
                if (b == b'=' && run == 2) || ((b == b'~' || b == b'^') && run == 1) {
                    let before = if i > 0 { s[..i].chars().next_back() } else { prev_b };
                    let after = if i + run < s.len() { s[i + run..].chars().next() } else { next_b };
                    let (can_open, can_close) = delim_flanking(b, before, after);
                    if can_open || can_close {
                        if i > seg_start {
                            pieces.push(Piece::Text(slice_cow(&val, seg_start..i), false));
                        }
                        split = true;
                        saw_delim = true;
                        let kind = match b { b'=' => DelimKind::Highlight, b'~' => DelimKind::Sub, _ => DelimKind::Sup };
                        pieces.push(Piece::Delim { kind, can_open, can_close });
                        i += run;
                        seg_start = i;
                        continue;
                    }
                }
                i += run;
                continue;
            }
            i += 1;
        }
        if !split {
            pieces.push(Piece::Text(val, false));
        } else if seg_start < s.len() {
            pieces.push(Piece::Text(slice_cow(&val, seg_start..s.len()), false));
        }
        prev_b = cur_end_b;
    }
    if !saw_delim {
        return to_nodes(pieces);
    }

    let mut working: Vec<Piece<'a>> = Vec::with_capacity(pieces.len());
    let mut hl_openers: Vec<usize> = Vec::new();
    let mut sub_openers: Vec<usize> = Vec::new();
    let mut sup_openers: Vec<usize> = Vec::new();
    let mut changed = false;

    for piece in pieces {
        let Piece::Delim { kind, can_open, can_close } = piece else {
            if !hl_openers.is_empty() || !sub_openers.is_empty() || !sup_openers.is_empty() {
                match &piece {
                    Piece::Text(s, _) => {
                        if !hl_openers.is_empty() && s.as_bytes().iter().any(|&b| b == b'\n' || b == b'\r') {
                            hl_openers.clear();
                            sub_openers.clear();
                            sup_openers.clear();
                        } else if (!sub_openers.is_empty() || !sup_openers.is_empty()) && str_has_ws(s) {
                            sub_openers.clear();
                            sup_openers.clear();
                        }
                    }
                    Piece::Node(n) => {
                        if !hl_openers.is_empty() && has_break(n, false) {
                            hl_openers.clear();
                            sub_openers.clear();
                            sup_openers.clear();
                        } else if (!sub_openers.is_empty() || !sup_openers.is_empty()) && has_break(n, true) {
                            sub_openers.clear();
                            sup_openers.clear();
                        }
                    }
                    Piece::Delim { .. } => unreachable!(),
                }
            }
            working.push(piece);
            continue;
        };

        let stack = match kind {
            DelimKind::Highlight => &mut hl_openers,
            DelimKind::Sub => &mut sub_openers,
            DelimKind::Sup => &mut sup_openers,
        };
        let match_idx = if can_close && !stack.is_empty() {
            let top = stack.len() - 1;
            if stack[top] + 1 < working.len() {
                Some(top)
            } else if top > 0 {
                Some(top - 1)
            } else {
                None
            }
        } else {
            None
        };

        if let Some(idx) = match_idx {
            let opener_pos = stack[idx];
            stack.truncate(idx);
            while hl_openers.last().is_some_and(|&p| p > opener_pos) { hl_openers.pop(); }
            while sub_openers.last().is_some_and(|&p| p > opener_pos) { sub_openers.pop(); }
            while sup_openers.last().is_some_and(|&p| p > opener_pos) { sup_openers.pop(); }
            let inner = to_nodes(working.drain(opener_pos + 1..));
            let name = match kind { DelimKind::Highlight => "mark", DelimKind::Sub => "sub", DelimKind::Sup => "sup" };
            working[opener_pos] = Piece::Node(span_group(name, inner));
            changed = true;
        } else {
            let pos = working.len();
            working.push(Piece::Delim { kind, can_open, can_close });
            if can_open {
                stack.push(pos);
            }
        }
    }
    let _ = changed;
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
                let clean = crate::strip_html_comments(&raw);
                let trimmed = clean.trim();
                if crate::diagram::looks_like_svg(trimmed)
                    || crate::is_page_break_div(&raw)
                    || !crate::parse_html_images(&raw).is_empty()
                {
                    out.push(Node::Leaf(Event::Html(CowStr::from(raw))));
                } else {
                    let mut tokens = Vec::new();
                    tokenize_raw_html(raw.trim_end_matches(['\r', '\n']), &mut tokens);
                    let folded = fold_html_tags(tokens);
                    if !folded.iter().all(|n| matches!(n, Node::Text(s, _) if s.trim().is_empty())) {
                        out.push(Node::Group { start: Event::Start(Tag::Paragraph), end: Event::End(TagEnd::Paragraph), children: folded, phrasing: true });
                    }
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
                    out.push(Node::Text(CowStr::from(marker), false));
                    out.extend(children);
                    out.push(Node::Text(CowStr::from(marker), false));
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
            Event::InlineHtml(html) | Event::Html(html) => {
                if html.trim().eq_ignore_ascii_case("</div>")
                    && matches!(out.last(), Some(Node::Leaf(Event::InlineHtml(prev))) if crate::is_page_break_div(prev))
                {
                    continue;
                }
                tokenize_raw_html(&html, &mut out);
            }
            Event::Text(value) => {
                let bytes = source.as_bytes();
                let mut slashes = 0usize;
                let mut k = range.start;
                while k > 0 && bytes[k - 1] == b'\\' {
                    slashes += 1;
                    k -= 1;
                }
                let escaped_head = slashes % 2 == 1 || (range.end > range.start + value.len() && bytes.get(range.start) == Some(&b'&'));
                if escaped_head {
                    if let Some(ch) = value.chars().next() {
                        let split = ch.len_utf8();
                        if split < value.len() {
                            out.push(Node::Text(slice_cow(&value, 0..split), true));
                            out.push(Node::Text(slice_cow(&value, split..value.len()), false));
                            continue;
                        }
                    }
                }
                out.push(Node::Text(value, escaped_head));
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
    if !has_enrich_trigger(normalized.as_bytes()) {
        return Parser::new_ext(normalized, options).collect();
    }
    let mut iter = Parser::new_ext(normalized, options).into_offset_iter();
    let tree = build_nodes(&mut iter, normalized, None);
    let cap = tree.len().saturating_mul(4);
    let processed = process_nodes(tree, false);
    let mut out = Vec::with_capacity(cap);
    flatten(processed, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{source, PdfOptions};
    use std::collections::HashMap;
    use std::time::Instant;

    #[test]
    fn study_delimiter_parity_covers_nested_unicode_overlapping_and_single_equals() {
        let md = concat!(
            "Nested ==**bold** and *italic* with H~2~O and 10^-3^== plus x~*i*~ and y^**2**^.\n\n",
            "Unicode 🧪==emoji highlight==, ==trailing🧪==, 🧪~2~, x^🧪^, “==smart quotes==”, «==guillemets==», and \u{00a0}==nbsp open==.\n\n",
            "Overlapping ~a==b~c==, ==outer ==inner==, ==outer ==~inner==, and intraword a~b c~d~e.\n\n",
            "Equations A = L * U, x = 1, a == b, a === b, ~~struck~~, \\==escaped==, &#61;=entity==, \\\\==after slash==, and =<!-- c -->=joined==.\n",
        );
        let typst = source(md, &PdfOptions::default(), &HashMap::new()).unwrap();
        assert!(typst.contains("#highlight(fill: smd-highlight, radius: 2pt, extent: 1pt)[#strong[#text(\"bold\")]#text(\" and \")#emph[#text(\"italic\")]#text(\" with H\")#sub[#text(\"2\")]#text(\"O and 10\")#super[#text(\"-3\")]]"), "{typst}");
        assert!(typst.contains("x\")#sub[#emph[#text(\"i\")]]") && typst.contains("y\")#super[#strong[#text(\"2\")]]"), "{typst}");
        assert!(typst.contains("🧪\")#highlight(fill: smd-highlight, radius: 2pt, extent: 1pt)[#text(\"emoji highlight\")]"), "{typst}");
        assert!(typst.contains("#highlight(fill: smd-highlight, radius: 2pt, extent: 1pt)[#text(\"trailing🧪\")]"), "{typst}");
        assert!(typst.contains("🧪\")#sub[#text(\"2\")]") && typst.contains("x\")#super[#text(\"🧪\")]"), "{typst}");
        assert!(typst.contains("#highlight(fill: smd-highlight, radius: 2pt, extent: 1pt)[#text(\"smart quotes\")]"), "{typst}");
        assert!(typst.contains("#highlight(fill: smd-highlight, radius: 2pt, extent: 1pt)[#text(\"guillemets\")]"), "{typst}");
        assert!(typst.contains("#highlight(fill: smd-highlight, radius: 2pt, extent: 1pt)[#text(\"nbsp open\")]"), "{typst}");
        assert!(typst.contains("#sub[#text(\"a==b\")]#text(\"c==, ==outer \")#highlight(fill: smd-highlight, radius: 2pt, extent: 1pt)[#text(\"inner\")]#text(\", ==outer \")#highlight(fill: smd-highlight, radius: 2pt, extent: 1pt)[#text(\"~inner\")]"), "{typst}");
        assert!(typst.contains("a~b c\")#sub[#text(\"d\")]#text(\"e."), "{typst}");
        assert!(typst.contains("#strike[#text(\"struck\")]"), "{typst}");
        assert!(!typst.contains("[#text(\"escaped\")]") && !typst.contains("[#text(\"entity\")]"), "{typst}");
        assert!(typst.contains("#highlight(fill: smd-highlight, radius: 2pt, extent: 1pt)[#text(\"after slash\")]"), "{typst}");
        assert!(typst.contains("#highlight(fill: smd-highlight, radius: 2pt, extent: 1pt)[#text(\"joined\")]"), "{typst}");

        let plain = "Plain equation A = L * U and y = mx + b without study markers.\n";
        assert!(!has_enrich_trigger(plain.as_bytes()));
    }

    #[test]
    fn enrich_events_scales_linearly_on_large_single_block_study_note() {
        let mut doc = String::from("# Large Study Block\n\n");
        for i in 1..=800 {
            doc.push_str(&format!(
                "Line {i}: ==Key takeaway {i}== notes that H~2~O and C~6~H~12~O~6~ scale by 2^10^ (~15 ms latency, if x == y or z = {i}, ~spaced tilde~ and ^spaced caret^) with 🧪==emoji== and \\~escaped\\~ markers.\n"
            ));
        }
        let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_SUBSCRIPT | Options::ENABLE_SUPERSCRIPT | Options::ENABLE_TASKLISTS | Options::ENABLE_MATH | Options::ENABLE_FOOTNOTES;
        let t0 = Instant::now();
        let events = enrich_events(&doc, opts);
        let elapsed = t0.elapsed();
        assert!(elapsed.as_millis() < 1500, "enrich_events took too long on ~185 KB single block: {elapsed:?}");

        let mark_opens = events.iter().filter(|e| matches!(e, Event::InlineHtml(h) if h.as_ref() == "<mark>")).count();
        let sub_opens = events.iter().filter(|e| matches!(e, Event::Start(Tag::Subscript))).count();
        let sup_opens = events.iter().filter(|e| matches!(e, Event::Start(Tag::Superscript))).count();
        assert_eq!(mark_opens, 1600);
        assert_eq!(sub_opens, 3200);
        assert_eq!(sup_opens, 800);
    }

    #[test]
    fn strip_percent_comments_scales_with_interleaved_math_escapes_and_code_fences() {
        let no_strip = "Inline `$a$` and `%%code_only%%` plus $x %% y$ and \\%%escaped\\%%:\n```python\n%%timeit x = 1\n```\n";
        assert!(matches!(strip_percent_comments(no_strip), Cow::Borrowed(_)));

        let mut doc = String::new();
        for i in 0..400 {
            doc.push_str(&format!(
                "Item {i}: inline $a_{i} + b_{i} = 100\\%$ and $p_{i} %% kept_inline_{i}$ %%strip_inline_{i}%% costs $50 to $99 (\\$escaped, \\%%kept_lit_{i}\\%%) with $$m_{i} %% kept_compact_{i}$$.\n\
                 $$\n%% kept_display_{i}\n\\sum_{{k=1}}^{{n}} x_k = {i}\n$$\n\
                 ```python\n%%timeit total = {i}\n```\n\
                 ~~~markdown\n%%kept_tilde_{i}%%\n~~~\n"
            ));
        }
        for j in 0..1600 {
            doc.push_str(&format!(
                "Ledger {j}: budget $50 to $99 (\\$fee, \\%%lit_{j}\\%%) %%strip_ledger_{j}%%\n"
            ));
        }

        let t0 = Instant::now();
        let stripped = strip_percent_comments(&doc);
        let elapsed = t0.elapsed();
        assert!(elapsed.as_millis() < 1000, "strip_percent_comments took too long on ~260 KB interleaved note: {elapsed:?}");
        assert!(stripped.contains("kept_inline_0") && stripped.contains("kept_inline_399"));
        assert!(stripped.contains("kept_compact_399") && stripped.contains("kept_display_399"));
        assert!(stripped.contains("%%timeit total = 399") && stripped.contains("%%kept_tilde_399%%"));
        assert!(stripped.contains("\\%%kept_lit_200\\%%") && stripped.contains("\\%%lit_1599\\%%"));
        assert!(!stripped.contains("strip_inline_0") && !stripped.contains("strip_inline_399"));
        assert!(!stripped.contains("strip_ledger_0") && !stripped.contains("strip_ledger_1599"));
    }
}
