use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use std::borrow::Cow;
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StandaloneEquationBlock {
    pub start: usize,
    pub end: usize,
    pub open_prefix: String,
    pub close_prefix: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EquationTagInfo {
    pub display_text: String,
    pub ref_text: String,
    pub eqref_text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EquationTarget {
    pub anchor_id: String,
    pub tag: Option<EquationTagInfo>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DisplayEquationPlan {
    pub clean_tex: String,
    pub tag: Option<EquationTagInfo>,
    pub anchor_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CommandKind {
    Tag,
    Label,
    Eqref,
    Ref,
    NoTag,
}

#[derive(Clone, Debug)]
struct ParsedCommand {
    kind: CommandKind,
    starred: bool,
    arg: String,
    start: usize,
    end: usize,
}

pub(crate) fn equation_anchor_id(label: &str) -> String {
    let trimmed = label.trim();
    let mut encoded = String::new();
    for ch in trimmed.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' {
            encoded.push(ch);
        } else {
            encoded.push_str(&format!("_{:x}_", ch as u32));
        }
    }
    if encoded.is_empty() {
        "smd-eq-empty".to_string()
    } else {
        format!("smd-eq-{encoded}")
    }
}

fn read_balanced_braces(source: &str, open_brace: usize) -> Option<(&str, usize)> {
    let bytes = source.as_bytes();
    if bytes.get(open_brace) != Some(&b'{') {
        return None;
    }
    let mut depth = 1usize;
    let mut i = open_brace + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => {
                i += 1;
                if i < bytes.len() {
                    i += source[i..].chars().next().map_or(1, char::len_utf8);
                }
                continue;
            }
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some((&source[open_brace + 1..i], i + 1));
                }
            }
            _ => {}
        }
        i += source[i..].chars().next().map_or(1, char::len_utf8);
    }
    None
}

fn has_outer_parens(value: &str) -> bool {
    if !value.starts_with('(') || !value.ends_with(')') {
        return false;
    }
    let mut depth = 0i32;
    for (idx, ch) in value.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 && idx + ch.len_utf8() < value.len() {
                    return false;
                }
            }
            _ => {}
        }
    }
    depth == 0
}

pub(crate) fn normalize_tag_plain_text(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = String::new();
    let mut i = 0usize;
    while i < bytes.len() {
        let ch = raw[i..].chars().next().unwrap();
        if ch == '~' {
            out.push(' ');
            i += 1;
            continue;
        }
        if ch == '\\' {
            if i + 1 >= bytes.len() {
                break;
            }
            let next = raw[i + 1..].chars().next().unwrap();
            let next_len = next.len_utf8();
            if matches!(next, '{' | '}' | ',' | ';' | ' ' | '!' | ':') {
                if next == '{' || next == '}' {
                    out.push(next);
                } else if next != '!' {
                    out.push(' ');
                }
                i += 1 + next_len;
                continue;
            }
            if matches!(next, '#' | '$' | '%' | '&' | '~' | '_' | '^') {
                out.push(next);
                i += 1 + next_len;
                continue;
            }
            if next.is_ascii_alphabetic() {
                let mut end = i + 1 + next_len;
                while end < bytes.len() && bytes[end].is_ascii_alphabetic() {
                    end += 1;
                }
                let name = &raw[i + 1..end];
                let mut ws = end;
                while ws < bytes.len() && matches!(bytes[ws], b' ' | b'\t') {
                    ws += 1;
                }
                if matches!(
                    name,
                    "text"
                        | "textrm"
                        | "mathrm"
                        | "textbf"
                        | "mathbf"
                        | "textit"
                        | "mathit"
                        | "mathsf"
                        | "mathtt"
                        | "operatorname"
                ) && bytes.get(ws) == Some(&b'{')
                {
                    if let Some((inner, group_end)) = read_balanced_braces(raw, ws) {
                        out.push_str(&normalize_tag_plain_text(inner));
                        i = group_end;
                        continue;
                    }
                }
                let mapped = match name {
                    "dagger" => Some("†"),
                    "ddagger" => Some("‡"),
                    "star" => Some("⋆"),
                    "ast" => Some("*"),
                    "S" => Some("§"),
                    "P" => Some("¶"),
                    _ => None,
                };
                if let Some(sym) = mapped {
                    out.push_str(sym);
                    i = end;
                    continue;
                }
                out.push_str(&raw[i..end]);
                i = end;
                continue;
            }
            out.push(next);
            i += 1 + next_len;
            continue;
        }
        if ch == '{' {
            if let Some((inner, group_end)) = read_balanced_braces(raw, i) {
                out.push_str(&normalize_tag_plain_text(inner));
                i = group_end;
                continue;
            }
        }
        out.push(ch);
        i += ch.len_utf8();
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(crate) fn format_equation_tag(raw: &str, starred: bool) -> Option<EquationTagInfo> {
    let plain = normalize_tag_plain_text(raw);
    if plain.is_empty() {
        return None;
    }
    if starred {
        let eqref_text = if has_outer_parens(&plain) {
            plain.clone()
        } else {
            format!("({plain})")
        };
        Some(EquationTagInfo {
            display_text: plain.clone(),
            ref_text: plain,
            eqref_text,
        })
    } else {
        let wrapped = format!("({plain})");
        Some(EquationTagInfo {
            display_text: wrapped.clone(),
            ref_text: plain,
            eqref_text: wrapped,
        })
    }
}

fn scan_commands(source: &str, include_defs: bool, include_refs: bool, is_math: bool) -> Vec<ParsedCommand> {
    let bytes = source.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        if is_math && bytes[i] == b'%' {
            let mut slashes = 0usize;
            let mut j = i;
            while j > 0 && bytes[j - 1] == b'\\' {
                slashes += 1;
                j -= 1;
            }
            if slashes % 2 == 0 {
                if let Some(rel_nl) = source[i..].find('\n') {
                    i += rel_nl + 1;
                    continue;
                }
                break;
            }
        }
        if bytes[i] != b'\\' {
            i += source[i..].chars().next().map_or(1, char::len_utf8);
            continue;
        }
        let mut slash_end = i;
        while slash_end < bytes.len() && bytes[slash_end] == b'\\' {
            slash_end += 1;
        }
        let slash_count = slash_end - i;
        if slash_count % 2 == 0 {
            i = slash_end;
            continue;
        }
        let cmd_backslash = slash_end - 1;
        let name_start = slash_end;
        if !bytes.get(name_start).is_some_and(u8::is_ascii_alphabetic) {
            if name_start < bytes.len() {
                i = name_start + source[name_start..].chars().next().map_or(1, char::len_utf8);
            } else {
                break;
            }
            continue;
        }
        let mut name_end = name_start + 1;
        while name_end < bytes.len() && bytes[name_end].is_ascii_alphabetic() {
            name_end += 1;
        }
        let name = &source[name_start..name_end];
        let kind = match name {
            "tag" if include_defs => Some(CommandKind::Tag),
            "label" if include_defs => Some(CommandKind::Label),
            "notag" | "nonumber" if include_defs => Some(CommandKind::NoTag),
            "eqref" if include_refs => Some(CommandKind::Eqref),
            "ref" if include_refs => Some(CommandKind::Ref),
            _ => None,
        };
        if kind == Some(CommandKind::NoTag) {
            out.push(ParsedCommand {
                kind: CommandKind::NoTag,
                starred: false,
                arg: String::new(),
                start: cmd_backslash,
                end: name_end,
            });
            i = name_end;
            continue;
        }
        if let Some(kind) = kind {
            let mut cursor = name_end;
            let mut starred = false;
            if kind == CommandKind::Tag && bytes.get(cursor) == Some(&b'*') {
                starred = true;
                cursor += 1;
            }
            while cursor < bytes.len() && matches!(bytes[cursor], b' ' | b'\t') {
                cursor += 1;
            }
            if bytes.get(cursor) == Some(&b'{') {
                if let Some((inner, group_end)) = read_balanced_braces(source, cursor) {
                    let arg = inner.trim();
                    if !arg.is_empty() && !arg.contains(['\r', '\n']) {
                        out.push(ParsedCommand {
                            kind,
                            starred,
                            arg: arg.to_string(),
                            start: cmd_backslash,
                            end: group_end,
                        });
                        i = group_end;
                        continue;
                    }
                }
            }
        }
        i = name_end;
    }
    out
}

fn scan_line_prefix(line: &str) -> (usize, usize, usize, usize) {
    let bytes = line.as_bytes();
    let mut pos = 0usize;
    let mut col = 0usize;
    let mut base_col = 0usize;
    let mut quote_depth = 0usize;
    while pos < bytes.len() {
        let mut next_pos = pos;
        let mut next_col = col;
        while next_pos < bytes.len() && matches!(bytes[next_pos], b' ' | b'\t') {
            let step = if bytes[next_pos] == b'\t' {
                4 - (next_col % 4)
            } else {
                1
            };
            if next_col + step - base_col > 3 {
                break;
            }
            next_col += step;
            next_pos += 1;
        }
        if bytes.get(next_pos) != Some(&b'>') {
            break;
        }
        quote_depth += 1;
        pos = next_pos + 1;
        col = next_col + 1;
        if bytes.get(pos) == Some(&b' ') {
            pos += 1;
            col += 1;
            base_col = col;
        } else if bytes.get(pos) == Some(&b'\t') {
            base_col = col + 1;
        } else {
            base_col = col;
        }
    }
    let mut content_pos = pos;
    let mut content_col = col;
    while content_pos < bytes.len() && matches!(bytes[content_pos], b' ' | b'\t') {
        content_col += if bytes[content_pos] == b'\t' {
            4 - (content_col % 4)
        } else {
            1
        };
        content_pos += 1;
    }
    (quote_depth, pos, content_col - base_col, content_pos)
}

fn is_unescaped_percent_pair(bytes: &[u8], mask: &[bool], at: usize) -> bool {
    if at + 1 >= bytes.len()
        || bytes[at] != b'%'
        || bytes[at + 1] != b'%'
        || mask[at]
        || mask[at + 1]
    {
        return false;
    }
    let mut slashes = 0usize;
    let mut k = at;
    while k > 0 && bytes[k - 1] == b'\\' && !mask[k - 1] {
        slashes += 1;
        k -= 1;
    }
    slashes % 2 == 0
}

pub(crate) fn standalone_equation_blocks(input: &str) -> Vec<StandaloneEquationBlock> {
    if !input.contains("\\begin{equation") {
        return Vec::new();
    }
    let mut mask = vec![false; input.len()];
    let mut in_code_block = false;
    for (event, range) in Parser::new_ext(input, Options::ENABLE_MATH).into_offset_iter() {
        match event {
            Event::Start(Tag::CodeBlock(_)) => {
                in_code_block = true;
                mask[range].fill(true);
            }
            Event::End(TagEnd::CodeBlock) => {
                in_code_block = false;
            }
            Event::Code(_) | Event::DisplayMath(_) | Event::Html(_) | Event::InlineHtml(_) => {
                mask[range].fill(true);
            }
            _ if in_code_block => {
                mask[range].fill(true);
            }
            _ => {}
        }
    }

    let mut lines: Vec<(usize, usize)> = Vec::new();
    let mut offset = 0usize;
    for raw in input.split('\n') {
        let trimmed_cr = raw.strip_suffix('\r').unwrap_or(raw);
        lines.push((offset, offset + trimmed_cr.len()));
        offset += raw.len() + 1;
    }

    let bytes = input.as_bytes();
    let mut cursor = 0usize;
    let advance_percent_comments = |cursor: &mut usize, limit: usize| {
        while *cursor < limit {
            if mask[*cursor] {
                *cursor += 1;
                continue;
            }
            if is_unescaped_percent_pair(bytes, &mask, *cursor) {
                let mut search = *cursor + 2;
                let mut close = None;
                while let Some(rel) = input[search..].find("%%") {
                    let cand = search + rel;
                    if is_unescaped_percent_pair(bytes, &mask, cand) {
                        close = Some(cand);
                        break;
                    }
                    search = cand + 1;
                }
                *cursor = close.map_or(*cursor + 2, |c| c + 2);
                continue;
            }
            *cursor += 1;
        }
    };

    let mut blocks = Vec::new();
    let mut idx = 0usize;
    while idx < lines.len() {
        let (line_start, line_end) = lines[idx];
        let raw_line = &input[line_start..line_end];
        let (quote_depth, quote_pos, indent, content_pos) = scan_line_prefix(raw_line);
        if content_pos == raw_line.len() || indent >= 4 {
            idx += 1;
            continue;
        }
        let open_offset = line_start + content_pos;
        advance_percent_comments(&mut cursor, open_offset);
        if cursor > open_offset || mask[open_offset] {
            idx += 1;
            continue;
        }
        let rest_from_open = &input[open_offset..line_end];
        let starred = rest_from_open.starts_with("\\begin{equation*}");
        let numbered = !starred && rest_from_open.starts_with("\\begin{equation}");
        if !starred && !numbered {
            idx += 1;
            continue;
        }

        let env_name = if starred { "equation*" } else { "equation" };
        let open_token = format!("\\begin{{{env_name}}}");
        let close_token = format!("\\end{{{env_name}}}");
        let mut depth = 1usize;
        let mut matched: Option<(usize, usize, String)> = None;

        for (j, &(cand_start, cand_end)) in lines.iter().enumerate().skip(idx) {
            let mut scan_start = open_offset + open_token.len();
            let mut cand_prefix_end = quote_pos;
            if j > idx {
                let cand_line = &input[cand_start..cand_end];
                let (pj_quote_depth, pj_pos, _, pj_content_pos) = scan_line_prefix(cand_line);
                if pj_quote_depth != quote_depth {
                    break;
                }
                if pj_content_pos < cand_line.len() && mask[cand_start + pj_content_pos] {
                    let slice = &cand_line[pj_content_pos..];
                    if slice.starts_with("```") || slice.starts_with("~~~") {
                        break;
                    }
                }
                cand_prefix_end = pj_pos;
                scan_start = cand_start + pj_pos;
            }
            let line_floor = if j == idx {
                open_offset
            } else {
                cand_start + cand_prefix_end
            };
            let mut k = scan_start;
            while k < cand_end {
                if bytes[k] == b'%' {
                    let mut slashes = 0usize;
                    let mut b = k;
                    while b > line_floor && bytes[b - 1] == b'\\' {
                        slashes += 1;
                        b -= 1;
                    }
                    if slashes % 2 == 0 {
                        break;
                    }
                }
                if bytes[k] != b'\\' {
                    k += input[k..cand_end].chars().next().map_or(1, char::len_utf8);
                    continue;
                }
                let mut slash_end = k;
                while slash_end < cand_end && bytes[slash_end] == b'\\' {
                    slash_end += 1;
                }
                if (slash_end - k) % 2 == 0 {
                    k = slash_end;
                    continue;
                }
                let cmd_at = slash_end - 1;
                if input[cmd_at..cand_end].starts_with(&open_token) {
                    depth += 1;
                    k = cmd_at + open_token.len();
                    continue;
                }
                if input[cmd_at..cand_end].starts_with(&close_token) {
                    depth -= 1;
                    let after_close = cmd_at + close_token.len();
                    if depth == 0 {
                        let trailing = &input[after_close..cand_end];
                        let trimmed_ws = trailing.trim_start_matches([' ', '\t']);
                        if trimmed_ws.is_empty() || trimmed_ws.starts_with('%') {
                            let block_end = if trimmed_ws.starts_with('%') {
                                cand_end
                            } else {
                                after_close
                            };
                            let close_prefix = if j == idx {
                                input[line_start..open_offset].to_string()
                            } else {
                                input[cand_start..cand_start + cand_prefix_end].to_string()
                            };
                            matched = Some((block_end, j, close_prefix));
                        }
                        break;
                    }
                    k = after_close;
                    continue;
                }
                k = slash_end;
            }
            if depth == 0 {
                break;
            }
        }

        if let Some((block_end, end_line_idx, close_prefix)) = matched {
            blocks.push(StandaloneEquationBlock {
                start: open_offset,
                end: block_end,
                open_prefix: input[line_start..open_offset].to_string(),
                close_prefix,
            });
            cursor = lines[end_line_idx].1;
            idx = end_line_idx + 1;
        } else {
            idx += 1;
        }
    }

    blocks
}

pub(crate) fn normalize_standalone_equation_blocks(input: &str) -> Cow<'_, str> {
    let blocks = standalone_equation_blocks(input);
    if blocks.is_empty() {
        return Cow::Borrowed(input);
    }
    let mut out = String::with_capacity(input.len() + blocks.len() * 8);
    let mut last = 0usize;
    for block in blocks {
        out.push_str(&input[last..block.start]);
        out.push_str("$$\n");
        out.push_str(&block.open_prefix);
        out.push_str(&input[block.start..block.end]);
        out.push('\n');
        out.push_str(&block.close_prefix);
        out.push_str("$$");
        last = block.end;
    }
    out.push_str(&input[last..]);
    Cow::Owned(out)
}

fn skip_math_trivia(tex: &str, mut i: usize) -> usize {
    let bytes = tex.as_bytes();
    while i < bytes.len() {
        match bytes[i] {
            b' ' | b'\t' | b'\r' | b'\n' => i += 1,
            b'%' => match tex[i..].find('\n') {
                Some(rel) => i += rel + 1,
                None => return bytes.len(),
            },
            _ => break,
        }
    }
    i
}

fn detect_outer_equation_environment(tex: &str) -> Option<(bool, usize, usize, usize, usize)> {
    let open_start = skip_math_trivia(tex, 0);
    let rest = &tex[open_start..];
    let starred = rest.starts_with("\\begin{equation*}");
    let numbered = !starred && rest.starts_with("\\begin{equation}");
    if !starred && !numbered {
        return None;
    }
    let env_name = if starred { "equation*" } else { "equation" };
    let open_token = format!("\\begin{{{env_name}}}");
    let close_token = format!("\\end{{{env_name}}}");
    let open_end = open_start + open_token.len();
    let bytes = tex.as_bytes();
    let mut depth = 1usize;
    let mut i = open_end;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let mut slashes = 0usize;
            let mut j = i;
            while j > 0 && bytes[j - 1] == b'\\' {
                slashes += 1;
                j -= 1;
            }
            if slashes % 2 == 0 {
                if let Some(rel) = tex[i..].find('\n') {
                    i += rel + 1;
                    continue;
                }
                break;
            }
        }
        if bytes[i] != b'\\' {
            i += tex[i..].chars().next().map_or(1, char::len_utf8);
            continue;
        }
        let mut slash_end = i;
        while slash_end < bytes.len() && bytes[slash_end] == b'\\' {
            slash_end += 1;
        }
        if (slash_end - i) % 2 == 0 {
            i = slash_end;
            continue;
        }
        let cmd_at = slash_end - 1;
        if tex[cmd_at..].starts_with(&open_token) {
            depth += 1;
            i = cmd_at + open_token.len();
            continue;
        }
        if tex[cmd_at..].starts_with(&close_token) {
            depth -= 1;
            let close_end = cmd_at + close_token.len();
            if depth == 0 {
                return (skip_math_trivia(tex, close_end) == bytes.len())
                    .then_some((starred, open_start, open_end, cmd_at, close_end));
            }
            i = close_end;
            continue;
        }
        i = slash_end;
    }
    None
}

fn strip_unescaped_latex_comments(tex: &str) -> String {
    if !tex.contains('%') {
        return tex.to_string();
    }
    let bytes = tex.as_bytes();
    let mut out = String::with_capacity(tex.len());
    let mut last = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let mut slashes = 0usize;
            let mut j = i;
            while j > 0 && bytes[j - 1] == b'\\' {
                slashes += 1;
                j -= 1;
            }
            if slashes % 2 == 0 {
                out.push_str(&tex[last..i]);
                if let Some(rel) = tex[i..].find('\n') {
                    last = i + rel;
                    i = last + 1;
                } else {
                    last = bytes.len();
                    break;
                }
                continue;
            }
        }
        i += tex[i..].chars().next().map_or(1, char::len_utf8);
    }
    out.push_str(&tex[last..]);
    out
}

pub(crate) fn analyze_display_equation(
    tex: &str,
    equations: &mut HashMap<String, EquationTarget>,
    equation_counter: &mut usize,
) -> DisplayEquationPlan {
    let outer_eq = detect_outer_equation_environment(tex);
    let commands = scan_commands(tex, true, false, true);
    if commands.is_empty() && outer_eq.is_none() {
        return DisplayEquationPlan {
            clean_tex: tex.to_string(),
            tag: None,
            anchor_ids: Vec::new(),
        };
    }
    let mut tag = None;
    let mut has_explicit_tag = false;
    let mut has_no_tag = false;
    let mut labels = Vec::new();
    let mut strip_spans = Vec::new();
    if let Some((_, open_start, open_end, close_start, close_end)) = outer_eq {
        strip_spans.push((open_start, open_end));
        strip_spans.push((close_start, close_end));
    }
    for cmd in commands {
        strip_spans.push((cmd.start, cmd.end));
        match cmd.kind {
            CommandKind::Tag => {
                has_explicit_tag = true;
                if let Some(parsed) = format_equation_tag(&cmd.arg, cmd.starred) {
                    tag = Some(parsed);
                }
            }
            CommandKind::Label => {
                labels.push(cmd.arg);
            }
            CommandKind::NoTag => {
                has_no_tag = true;
            }
            _ => {}
        }
    }
    if matches!(outer_eq, Some((false, ..))) && !has_explicit_tag && !has_no_tag {
        *equation_counter += 1;
        tag = format_equation_tag(&equation_counter.to_string(), false);
    }
    strip_spans.sort_by_key(|&(start, end)| (start, end));
    let mut clean_tex = String::with_capacity(tex.len());
    let mut last = 0usize;
    for (start, end) in strip_spans {
        if start >= last {
            clean_tex.push_str(&tex[last..start]);
            last = end;
        }
    }
    clean_tex.push_str(&tex[last..]);
    if outer_eq.is_some() {
        clean_tex = strip_unescaped_latex_comments(&clean_tex);
    }

    let mut anchor_ids = Vec::new();
    for label in labels {
        if !equations.contains_key(&label) {
            let id = equation_anchor_id(&label);
            equations.insert(
                label,
                EquationTarget {
                    anchor_id: id.clone(),
                    tag: tag.clone(),
                },
            );
            if !anchor_ids.contains(&id) {
                anchor_ids.push(id);
            }
        }
    }

    DisplayEquationPlan {
        clean_tex,
        tag,
        anchor_ids,
    }
}

pub(crate) fn render_prose_with_equation_refs(
    value: &str,
    equations: &HashMap<String, EquationTarget>,
    inside_link: bool,
) -> String {
    if !value.contains('\\') {
        return crate::text(value);
    }
    let commands = scan_commands(value, false, true, false);
    if commands.is_empty() {
        return crate::text(value);
    }
    let mut out = String::new();
    let mut last = 0usize;
    for cmd in commands {
        if cmd.start > last {
            out.push_str(&crate::text(&value[last..cmd.start]));
        }
        if let Some(target) = equations.get(&cmd.arg) {
            if let Some(tag) = &target.tag {
                let rendered = if cmd.kind == CommandKind::Eqref {
                    &tag.eqref_text
                } else {
                    &tag.ref_text
                };
                if inside_link {
                    out.push_str(&crate::text(rendered));
                } else {
                    out.push_str(&format!(
                        "#link(label({}))[{}]",
                        crate::string(&target.anchor_id),
                        crate::text(rendered)
                    ));
                }
                last = cmd.end;
                continue;
            }
        }
        let fallback = if cmd.kind == CommandKind::Eqref { "(??)" } else { "??" };
        out.push_str(&crate::text(fallback));
        last = cmd.end;
    }
    if last < value.len() {
        out.push_str(&crate::text(&value[last..]));
    }
    out
}

pub(crate) fn prepare_math_refs_for_mitex(
    tex: &str,
    equations: &HashMap<String, EquationTarget>,
) -> (String, Vec< (String, String) >) {
    if !tex.contains('\\') {
        return (tex.to_string(), Vec::new());
    }
    let commands = scan_commands(tex, false, true, true);
    if commands.is_empty() {
        return (tex.to_string(), Vec::new());
    }
    let mut out = String::with_capacity(tex.len() + commands.len() * 16);
    let mut replacements = Vec::with_capacity(commands.len());
    let mut last = 0usize;
    for (idx, cmd) in commands.into_iter().enumerate() {
        out.push_str(&tex[last..cmd.start]);
        let mut token = format!("SMDEQREF{idx}END");
        while tex.contains(&token) {
            token.push('X');
        }
        out.push_str(&format!("\\text{{{token}}}"));
        let typst_expr = if let Some(target) = equations.get(&cmd.arg).filter(|t| t.tag.is_some()) {
            let tag = target.tag.as_ref().unwrap();
            let rendered = if cmd.kind == CommandKind::Eqref {
                &tag.eqref_text
            } else {
                &tag.ref_text
            };
            format!(
                "#link(label({}))[{}]",
                crate::string(&target.anchor_id),
                crate::text(rendered)
            )
        } else {
            let fallback = if cmd.kind == CommandKind::Eqref { "(??)" } else { "??" };
            crate::text(fallback)
        };
        replacements.push((token, typst_expr));
        last = cmd.end;
    }
    out.push_str(&tex[last..]);
    (out, replacements)
}

pub(crate) fn apply_mitex_ref_replacements(
    typst_math: &str,
    replacements: &[(String, String)],
) -> String {
    if replacements.is_empty() {
        return typst_math.to_string();
    }
    let mut out = typst_math.to_string();
    for (token, expr) in replacements {
        let wrapped = format!("#textmath[{token}]");
        if out.contains(&wrapped) {
            out = out.replace(&wrapped, expr);
        } else {
            out = out.replace(token, expr);
        }
    }
    out
}
