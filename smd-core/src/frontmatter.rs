//! Unified top-of-file YAML frontmatter parser and PDF document metadata extractor.
//! Recognizes optional UTF-8 BOM, `---` opener, `---` or `...` closer, trailing
//! horizontal whitespace on delimiter lines, empty blocks, and EOF closers.
//! Malformed or unclosed YAML blocks return `None` so callers fall back safely
//! to standard Markdown rendering.

use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq)]
pub enum YamlValue {
    Null,
    Bool(bool),
    String(String),
    Seq(Vec<YamlValue>),
    Map(BTreeMap<String, YamlValue>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PdfDate {
    pub year: i32,
    pub month: u8,
    pub day: u8,
    pub time: Option<(u8, u8, u8)>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PdfMetadata {
    pub title: Option<String>,
    pub authors: Vec<String>,
    pub description: Option<String>,
    pub keywords: Vec<String>,
    pub date: Option<PdfDate>,
}

impl PdfMetadata {
    pub fn is_empty(&self) -> bool {
        self.title.is_none()
            && self.authors.is_empty()
            && self.description.is_none()
            && self.keywords.is_empty()
            && self.date.is_none()
    }

    pub fn typst_set_document(&self) -> String {
        if self.is_empty() {
            return String::new();
        }
        let mut fields = Vec::new();
        if let Some(title) = &self.title {
            fields.push(format!("title: {}", typst_str(title)));
        }
        if !self.authors.is_empty() {
            let tuple = self
                .authors
                .iter()
                .map(|a| format!("{},", typst_str(a)))
                .collect::<Vec<_>>()
                .join(" ");
            fields.push(format!("author: ({tuple})"));
        }
        if let Some(description) = &self.description {
            fields.push(format!("description: {}", typst_str(description)));
        }
        if !self.keywords.is_empty() {
            let tuple = self
                .keywords
                .iter()
                .map(|k| format!("{},", typst_str(k)))
                .collect::<Vec<_>>()
                .join(" ");
            fields.push(format!("keywords: ({tuple})"));
        }
        if let Some(date) = &self.date {
            if let Some((hour, minute, second)) = date.time {
                fields.push(format!(
                    "date: datetime(year: {}, month: {}, day: {}, hour: {}, minute: {}, second: {})",
                    date.year, date.month, date.day, hour, minute, second
                ));
            } else {
                fields.push(format!(
                    "date: datetime(year: {}, month: {}, day: {})",
                    date.year, date.month, date.day
                ));
            }
        }
        format!("#set document({})\n", fields.join(", "))
    }
}

pub struct ParsedFrontmatter<'a> {
    pub raw: &'a str,
    pub end: usize,
    pub entries: BTreeMap<String, YamlValue>,
    pub metadata: PdfMetadata,
}

#[derive(Clone)]
struct RawLine<'a> {
    raw: &'a str,
    indent: usize,
    trimmed: &'a str,
}

fn typst_str(value: &str) -> String {
    serde_json::to_string(value).unwrap()
}

fn strip_inline_comment(value: &str) -> &str {
    let bytes = value.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i] == b'#' && (i == 0 || bytes[i - 1] == b' ' || bytes[i - 1] == b'\t') {
            return value[..i].trim_end();
        }
    }
    value.trim_end()
}

fn parse_double_quoted(input: &str) -> Option<(String, &str)> {
    let mut chars = input.char_indices();
    if chars.next()?.1 != '"' {
        return None;
    }
    let mut out = String::new();
    while let Some((idx, ch)) = chars.next() {
        if ch == '"' {
            return Some((out, &input[idx + 1..]));
        }
        if ch == '\\' {
            let (esc_idx, esc) = chars.next()?;
            match esc {
                '"' => out.push('"'),
                '\\' => out.push('\\'),
                '/' => out.push('/'),
                'n' => out.push('\n'),
                'r' => out.push('\r'),
                't' => out.push('\t'),
                'b' => out.push('\u{0008}'),
                'f' => out.push('\u{000c}'),
                '0' => out.push('\0'),
                ' ' => out.push(' '),
                '\n' => {
                    while let Some((_, next)) = chars.clone().next() {
                        if next == ' ' || next == '\t' {
                            chars.next();
                        } else {
                            break;
                        }
                    }
                }
                'x' => {
                    let rest = &input[esc_idx + 1..];
                    if rest.len() < 2 || !rest.is_char_boundary(2) {
                        return None;
                    }
                    let code = u32::from_str_radix(&rest[..2], 16).ok()?;
                    out.push(char::from_u32(code)?);
                    for _ in 0..2 {
                        chars.next()?;
                    }
                }
                'u' => {
                    let rest = &input[esc_idx + 1..];
                    if rest.len() < 4 || !rest.is_char_boundary(4) {
                        return None;
                    }
                    let code = u32::from_str_radix(&rest[..4], 16).ok()?;
                    out.push(char::from_u32(code)?);
                    for _ in 0..4 {
                        chars.next()?;
                    }
                }
                'U' => {
                    let rest = &input[esc_idx + 1..];
                    if rest.len() < 8 || !rest.is_char_boundary(8) {
                        return None;
                    }
                    let code = u32::from_str_radix(&rest[..8], 16).ok()?;
                    out.push(char::from_u32(code)?);
                    for _ in 0..8 {
                        chars.next()?;
                    }
                }
                other => out.push(other),
            }
            continue;
        }
        if ch == '\n' {
            let trimmed_len = out.trim_end_matches([' ', '\t']).len();
            out.truncate(trimmed_len);
            while let Some((_, next)) = chars.clone().next() {
                if next == ' ' || next == '\t' {
                    chars.next();
                } else {
                    break;
                }
            }
            out.push(' ');
            continue;
        }
        out.push(ch);
    }
    None
}

fn parse_single_quoted(input: &str) -> Option<(String, &str)> {
    let mut chars = input.char_indices();
    if chars.next()?.1 != '\'' {
        return None;
    }
    let mut out = String::new();
    while let Some((idx, ch)) = chars.next() {
        if ch == '\'' {
            if let Some((_, '\'')) = chars.clone().next() {
                chars.next();
                out.push('\'');
                continue;
            }
            return Some((out, &input[idx + 1..]));
        }
        if ch == '\n' {
            let trimmed_len = out.trim_end_matches([' ', '\t']).len();
            out.truncate(trimmed_len);
            while let Some((_, next)) = chars.clone().next() {
                if next == ' ' || next == '\t' {
                    chars.next();
                } else {
                    break;
                }
            }
            out.push(' ');
            continue;
        }
        out.push(ch);
    }
    None
}

fn only_trailing_comment(rest: &str) -> bool {
    let trimmed = rest.trim_start();
    trimmed.is_empty() || trimmed.starts_with('#')
}

fn parse_plain_scalar(raw: &str) -> YamlValue {
    let cleaned = strip_inline_comment(raw).trim();
    if cleaned.is_empty() || cleaned == "~" || cleaned.eq_ignore_ascii_case("null") {
        return YamlValue::Null;
    }
    if cleaned.eq_ignore_ascii_case("true") {
        return YamlValue::Bool(true);
    }
    if cleaned.eq_ignore_ascii_case("false") {
        return YamlValue::Bool(false);
    }
    YamlValue::String(cleaned.to_string())
}

fn split_top_level_commas(inner: &str) -> Option<Vec<&str>> {
    let mut parts = Vec::new();
    let mut start = 0usize;
    let mut depth_bracket = 0i32;
    let mut depth_brace = 0i32;
    let mut idx = 0usize;
    while idx < inner.len() {
        let ch = inner[idx..].chars().next()?;
        if ch == '"' {
            let (_, rest) = parse_double_quoted(&inner[idx..])?;
            idx = inner.len() - rest.len();
            continue;
        }
        if ch == '\'' {
            let (_, rest) = parse_single_quoted(&inner[idx..])?;
            idx = inner.len() - rest.len();
            continue;
        }
        match ch {
            '[' => depth_bracket += 1,
            ']' => {
                depth_bracket -= 1;
                if depth_bracket < 0 {
                    return None;
                }
            }
            '{' => depth_brace += 1,
            '}' => {
                depth_brace -= 1;
                if depth_brace < 0 {
                    return None;
                }
            }
            ',' if depth_bracket == 0 && depth_brace == 0 => {
                parts.push(&inner[start..idx]);
                start = idx + 1;
            }
            _ => {}
        }
        idx += ch.len_utf8();
    }
    if depth_bracket != 0 || depth_brace != 0 {
        return None;
    }
    parts.push(&inner[start..]);
    Some(parts)
}

fn parse_flow_value(raw: &str) -> Option<YamlValue> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Some(YamlValue::Null);
    }
    if trimmed.starts_with('"') {
        let (val, rest) = parse_double_quoted(trimmed)?;
        if !only_trailing_comment(rest) {
            return None;
        }
        return Some(YamlValue::String(val));
    }
    if trimmed.starts_with('\'') {
        let (val, rest) = parse_single_quoted(trimmed)?;
        if !only_trailing_comment(rest) {
            return None;
        }
        return Some(YamlValue::String(val));
    }
    if trimmed.starts_with('[') {
        if !trimmed.ends_with(']') {
            return None;
        }
        let inner = trimmed[1..trimmed.len() - 1].trim();
        if inner.is_empty() {
            return Some(YamlValue::Seq(Vec::new()));
        }
        let mut out = Vec::new();
        for item in split_top_level_commas(inner)? {
            if item.trim().is_empty() {
                continue;
            }
            out.push(parse_flow_value(item)?);
        }
        return Some(YamlValue::Seq(out));
    }
    if trimmed.starts_with('{') {
        if !trimmed.ends_with('}') {
            return None;
        }
        let inner = trimmed[1..trimmed.len() - 1].trim();
        if inner.is_empty() {
            return Some(YamlValue::Map(BTreeMap::new()));
        }
        let mut out = BTreeMap::new();
        for pair in split_top_level_commas(inner)? {
            if pair.trim().is_empty() {
                continue;
            }
            let (key, rest) = split_key_value(pair.trim(), true)?;
            out.insert(key, parse_flow_value(rest)?);
        }
        return Some(YamlValue::Map(out));
    }
    if trimmed.contains(['[', ']', '{', '}']) {
        split_top_level_commas(trimmed)?;
    }
    Some(parse_plain_scalar(trimmed))
}

fn split_key_value(trimmed: &str, allow_compact_flow_colon: bool) -> Option<(String, &str)> {
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    if trimmed == "-" || trimmed.starts_with("- ") || trimmed.starts_with("-\t") {
        return None;
    }
    if trimmed.starts_with('"') {
        let (key, rest) = parse_double_quoted(trimmed)?;
        let after = rest.trim_start();
        let post_colon = after.strip_prefix(':')?;
        if !allow_compact_flow_colon
            && !post_colon.is_empty()
            && !post_colon.starts_with(' ')
            && !post_colon.starts_with('\t')
        {
            return None;
        }
        return Some((key, post_colon.trim_start()));
    }
    if trimmed.starts_with('\'') {
        let (key, rest) = parse_single_quoted(trimmed)?;
        let after = rest.trim_start();
        let post_colon = after.strip_prefix(':')?;
        if !allow_compact_flow_colon
            && !post_colon.is_empty()
            && !post_colon.starts_with(' ')
            && !post_colon.starts_with('\t')
        {
            return None;
        }
        return Some((key, post_colon.trim_start()));
    }
    if trimmed.starts_with(['[', ']', '{', '}', '|', '>', '*', '&', '!', '%', '@']) {
        return None;
    }
    for (idx, ch) in trimmed.char_indices() {
        if ch != ':' {
            continue;
        }
        let after = &trimmed[idx + 1..];
        if allow_compact_flow_colon
            || after.is_empty()
            || after.starts_with(' ')
            || after.starts_with('\t')
        {
            let key = trimmed[..idx].trim();
            if key.is_empty() || key.contains(['[', ']', '{', '}', '"', '\'']) {
                return None;
            }
            return Some((key.to_string(), after.trim_start()));
        }
    }
    None
}

fn is_blank_or_comment(line: &RawLine<'_>) -> bool {
    line.trimmed.is_empty() || line.trimmed.starts_with('#')
}

fn is_sequence_item(trimmed: &str) -> Option<&str> {
    if trimmed == "-" {
        return Some("");
    }
    if let Some(rest) = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("-\t")) {
        return Some(rest.trim_start());
    }
    None
}

fn strip_flow_line_comment(line: &str) -> &str {
    let bytes = line.as_bytes();
    let mut in_single = false;
    let mut in_double = false;
    let mut i = 0usize;
    while i < bytes.len() {
        let ch = bytes[i];
        if in_double {
            if ch == b'\\' {
                i += 2;
                continue;
            }
            if ch == b'"' {
                in_double = false;
            }
            i += 1;
            continue;
        }
        if in_single {
            if ch == b'\'' {
                if bytes.get(i + 1) == Some(&b'\'') {
                    i += 2;
                    continue;
                }
                in_single = false;
            }
            i += 1;
            continue;
        }
        match ch {
            b'"' => in_double = true,
            b'\'' => in_single = true,
            b'#' if i == 0 || bytes[i - 1] == b' ' || bytes[i - 1] == b'\t' => {
                return line[..i].trim_end();
            }
            _ => {}
        }
        i += 1;
    }
    line
}

#[derive(PartialEq, Eq)]
enum FlowState {
    Balanced,
    Incomplete,
    Error,
}

fn flow_balance_state(text: &str) -> FlowState {
    let bytes = text.as_bytes();
    let mut depth_bracket = 0i32;
    let mut depth_brace = 0i32;
    let mut in_single = false;
    let mut in_double = false;
    let mut closed_top = false;
    let mut i = 0usize;
    while i < bytes.len() {
        let ch = bytes[i];
        if in_double {
            if ch == b'\\' {
                if i + 1 >= bytes.len() {
                    return FlowState::Incomplete;
                }
                i += 2;
                continue;
            }
            if ch == b'"' {
                in_double = false;
            }
            i += 1;
            continue;
        }
        if in_single {
            if ch == b'\'' {
                if bytes.get(i + 1) == Some(&b'\'') {
                    i += 2;
                    continue;
                }
                in_single = false;
            }
            i += 1;
            continue;
        }
        if closed_top {
            if ch == b' ' || ch == b'\t' {
                i += 1;
                continue;
            }
            if ch == b'#' {
                break;
            }
            return FlowState::Error;
        }
        match ch {
            b'"' => in_double = true,
            b'\'' => in_single = true,
            b'[' => depth_bracket += 1,
            b']' => {
                depth_bracket -= 1;
                if depth_bracket < 0 {
                    return FlowState::Error;
                }
                if depth_bracket == 0 && depth_brace == 0 {
                    closed_top = true;
                }
            }
            b'{' => depth_brace += 1,
            b'}' => {
                depth_brace -= 1;
                if depth_brace < 0 {
                    return FlowState::Error;
                }
                if depth_bracket == 0 && depth_brace == 0 {
                    closed_top = true;
                }
            }
            _ => {}
        }
        i += 1;
    }
    if in_single || in_double || depth_bracket > 0 || depth_brace > 0 {
        return FlowState::Incomplete;
    }
    if closed_top {
        FlowState::Balanced
    } else {
        FlowState::Incomplete
    }
}

fn collect_flow_lines(
    lines: &[RawLine<'_>],
    start_index: usize,
    initial_rest: &str,
    min_cont_indent: usize,
) -> Option<(String, usize)> {
    let mut combined = strip_flow_line_comment(initial_rest).to_string();
    let mut idx = start_index;
    loop {
        match flow_balance_state(&combined) {
            FlowState::Error => return None,
            FlowState::Balanced => return Some((combined, idx + 1)),
            FlowState::Incomplete => {}
        }
        idx += 1;
        if idx >= lines.len() {
            return None;
        }
        if is_blank_or_comment(&lines[idx]) {
            continue;
        }
        if lines[idx].indent < min_cont_indent {
            return None;
        }
        combined.push(' ');
        combined.push_str(strip_flow_line_comment(lines[idx].trimmed));
    }
}

fn collect_quoted_scalar(
    lines: &[RawLine<'_>],
    start_index: usize,
    initial_rest: &str,
    min_cont_indent: usize,
) -> Option<(String, usize)> {
    let is_double = initial_rest.starts_with('"');
    let mut combined = initial_rest.to_string();
    let mut idx = start_index;
    loop {
        let parsed = if is_double {
            parse_double_quoted(&combined)
        } else {
            parse_single_quoted(&combined)
        };
        if let Some((val, rest)) = parsed {
            if !only_trailing_comment(rest) {
                return None;
            }
            return Some((val, idx + 1));
        }
        idx += 1;
        if idx >= lines.len() {
            return None;
        }
        if lines[idx].trimmed.is_empty() {
            combined.push('\n');
            continue;
        }
        if lines[idx].indent < min_cont_indent {
            return None;
        }
        combined.push('\n');
        combined.push_str(lines[idx].trimmed);
    }
}

fn parse_block_scalar_header(header: &str) -> Option<(char, char, Option<usize>)> {
    let mut chars = header.chars();
    let style = chars.next()?;
    if style != '|' && style != '>' {
        return None;
    }
    let mut chomp = 'c';
    let mut indent_digit = None;
    let rest = chars.as_str();
    let mut consumed = 0usize;
    for ch in rest.chars().take(2) {
        if (ch == '+' || ch == '-') && chomp == 'c' {
            chomp = ch;
            consumed += 1;
        } else if ch.is_ascii_digit() && ch != '0' && indent_digit.is_none() {
            indent_digit = Some((ch as u8 - b'0') as usize);
            consumed += 1;
        } else {
            break;
        }
    }
    let tail = rest[consumed..].trim_start_matches([' ', '\t']);
    if !tail.is_empty() && !tail.starts_with('#') {
        return None;
    }
    Some((style, chomp, indent_digit))
}

fn parse_block_scalar(
    lines: &[RawLine<'_>],
    start_index: usize,
    header: &str,
    parent_indent: usize,
) -> Option<(String, usize)> {
    let (style, chomp, indent_digit) = parse_block_scalar_header(header)?;
    let mut raw_content: Vec<&str> = Vec::new();
    let mut idx = start_index + 1;
    while idx < lines.len() {
        let raw = lines[idx].raw;
        if raw.trim().is_empty() {
            raw_content.push("");
            idx += 1;
            continue;
        }
        if lines[idx].indent <= parent_indent {
            break;
        }
        raw_content.push(raw);
        idx += 1;
    }
    if chomp == '-' {
        while raw_content.last() == Some(&"") {
            raw_content.pop();
        }
    }
    let block_indent = if let Some(d) = indent_digit {
        Some(parent_indent + d)
    } else {
        raw_content
            .iter()
            .filter(|line| !line.is_empty())
            .map(|line| line.bytes().take_while(|b| *b == b' ').count())
            .min()
    };
    let Some(block_indent) = block_indent else {
        return Some((String::new(), idx));
    };
    let dedented: Vec<&str> = raw_content
        .into_iter()
        .map(|line| {
            if line.is_empty() {
                ""
            } else {
                &line[block_indent.min(line.len())..]
            }
        })
        .collect();
    let mut out = String::new();
    if style == '|' {
        out = dedented.join("\n");
    } else {
        for (i, curr) in dedented.iter().enumerate() {
            if i == 0 {
                out.push_str(curr);
                continue;
            }
            let prev = dedented[i - 1];
            let more_indented = curr.starts_with([' ', '\t']) || prev.starts_with([' ', '\t']);
            if curr.is_empty() || prev.is_empty() || more_indented {
                out.push('\n');
                out.push_str(curr);
            } else {
                out.push(' ');
                out.push_str(curr);
            }
        }
    }
    if chomp == '-' || chomp == 'c' {
        while out.ends_with('\n') {
            out.pop();
        }
    }
    Some((out, idx))
}

fn next_meaningful_line(lines: &[RawLine<'_>], from_index: usize) -> usize {
    let mut idx = from_index;
    while idx < lines.len() && is_blank_or_comment(&lines[idx]) {
        idx += 1;
    }
    idx
}

fn parse_value_after_key(
    lines: &[RawLine<'_>],
    line_index: usize,
    rest: &str,
    key_indent: usize,
) -> Option<(YamlValue, usize)> {
    if rest.is_empty() || rest.starts_with('#') {
        let next_idx = next_meaningful_line(lines, line_index + 1);
        if next_idx >= lines.len() {
            return Some((YamlValue::Null, lines.len()));
        }
        let next_line = &lines[next_idx];
        if next_line.indent > key_indent && is_sequence_item(next_line.trimmed).is_some() {
            let (seq, idx) = parse_block_sequence(lines, next_idx, next_line.indent)?;
            return Some((YamlValue::Seq(seq), idx));
        }
        if next_line.indent == key_indent && is_sequence_item(next_line.trimmed).is_some() {
            let (seq, idx) = parse_block_sequence(lines, next_idx, key_indent)?;
            return Some((YamlValue::Seq(seq), idx));
        }
        if next_line.indent > key_indent {
            if split_key_value(next_line.trimmed, false).is_some() {
                let (map, idx) = parse_block_mapping(lines, next_idx, next_line.indent)?;
                return Some((YamlValue::Map(map), idx));
            }
            let mut parts = Vec::new();
            let mut idx = next_idx;
            while idx < lines.len() {
                if is_blank_or_comment(&lines[idx]) {
                    idx += 1;
                    continue;
                }
                if lines[idx].indent <= key_indent {
                    break;
                }
                if split_key_value(lines[idx].trimmed, false).is_some()
                    || is_sequence_item(lines[idx].trimmed).is_some()
                {
                    break;
                }
                parts.push(strip_inline_comment(lines[idx].trimmed));
                idx += 1;
            }
            return Some((parse_plain_scalar(&parts.join(" ")), idx));
        }
        return Some((YamlValue::Null, next_idx));
    }

    if rest.starts_with('|') || rest.starts_with('>') {
        let (val, idx) = parse_block_scalar(lines, line_index, rest, key_indent)?;
        return Some((YamlValue::String(val), idx));
    }
    if rest.starts_with('"') || rest.starts_with('\'') {
        let (val, idx) = collect_quoted_scalar(lines, line_index, rest, key_indent + 1)?;
        return Some((YamlValue::String(val), idx));
    }
    if rest.starts_with('[') || rest.starts_with('{') {
        let (combined, idx) = collect_flow_lines(lines, line_index, rest, key_indent)?;
        return Some((parse_flow_value(&combined)?, idx));
    }

    let mut parts = vec![strip_inline_comment(rest)];
    let mut idx = line_index + 1;
    while idx < lines.len() {
        if is_blank_or_comment(&lines[idx]) || lines[idx].indent <= key_indent {
            break;
        }
        if split_key_value(lines[idx].trimmed, false).is_some()
            || is_sequence_item(lines[idx].trimmed).is_some()
        {
            break;
        }
        parts.push(strip_inline_comment(lines[idx].trimmed));
        idx += 1;
    }
    Some((parse_plain_scalar(&parts.join(" ")), idx))
}

fn parse_block_sequence(
    lines: &[RawLine<'_>],
    start_index: usize,
    seq_indent: usize,
) -> Option<(Vec<YamlValue>, usize)> {
    let mut items = Vec::new();
    let mut idx = start_index;
    while idx < lines.len() {
        if is_blank_or_comment(&lines[idx]) {
            idx += 1;
            continue;
        }
        if lines[idx].indent < seq_indent {
            break;
        }
        if lines[idx].indent > seq_indent {
            return None;
        }
        let Some(item_rest) = is_sequence_item(lines[idx].trimmed) else {
            break;
        };
        if item_rest.is_empty() || item_rest.starts_with('#') {
            let next_idx = next_meaningful_line(lines, idx + 1);
            if next_idx < lines.len() && lines[next_idx].indent > seq_indent {
                if is_sequence_item(lines[next_idx].trimmed).is_some() {
                    let (sub, next) =
                        parse_block_sequence(lines, next_idx, lines[next_idx].indent)?;
                    items.push(YamlValue::Seq(sub));
                    idx = next;
                    continue;
                }
                if split_key_value(lines[next_idx].trimmed, false).is_some() {
                    let (sub, next) =
                        parse_block_mapping(lines, next_idx, lines[next_idx].indent)?;
                    items.push(YamlValue::Map(sub));
                    idx = next;
                    continue;
                }
            }
            items.push(YamlValue::Null);
            idx = next_idx;
            continue;
        }
        if let Some((key, rest)) = split_key_value(item_rest, false) {
            let entry_indent = seq_indent + 2;
            let (first_val, mut next_idx) = parse_value_after_key(lines, idx, rest, seq_indent + 1)?;
            let mut obj = BTreeMap::new();
            obj.insert(key, first_val);
            let peek = next_meaningful_line(lines, next_idx);
            if peek < lines.len()
                && lines[peek].indent >= entry_indent
                && is_sequence_item(lines[peek].trimmed).is_none()
            {
                let (rest_map, after_map) =
                    parse_block_mapping(lines, peek, lines[peek].indent)?;
                obj.extend(rest_map);
                next_idx = after_map;
            }
            items.push(YamlValue::Map(obj));
            idx = next_idx;
            continue;
        }
        if item_rest.starts_with('|') || item_rest.starts_with('>') {
            let (val, next) = parse_block_scalar(lines, idx, item_rest, seq_indent)?;
            items.push(YamlValue::String(val));
            idx = next;
            continue;
        }
        if item_rest.starts_with('"') || item_rest.starts_with('\'') {
            let (val, next) = collect_quoted_scalar(lines, idx, item_rest, seq_indent + 1)?;
            items.push(YamlValue::String(val));
            idx = next;
            continue;
        }
        if item_rest.starts_with('[') || item_rest.starts_with('{') {
            let (combined, next) = collect_flow_lines(lines, idx, item_rest, seq_indent + 1)?;
            items.push(parse_flow_value(&combined)?);
            idx = next;
            continue;
        }
        items.push(parse_plain_scalar(item_rest));
        idx += 1;
    }
    Some((items, idx))
}

fn parse_block_mapping(
    lines: &[RawLine<'_>],
    start_index: usize,
    map_indent: usize,
) -> Option<(BTreeMap<String, YamlValue>, usize)> {
    let mut result = BTreeMap::new();
    let mut idx = start_index;
    while idx < lines.len() {
        if is_blank_or_comment(&lines[idx]) {
            idx += 1;
            continue;
        }
        if lines[idx].indent < map_indent {
            break;
        }
        if lines[idx].indent > map_indent {
            return None;
        }
        let (key, rest) = split_key_value(lines[idx].trimmed, false)?;
        let (val, next_idx) = parse_value_after_key(lines, idx, rest, map_indent)?;
        result.insert(key, val);
        idx = next_idx;
    }
    Some((result, idx))
}

fn to_raw_lines(yaml_body: &str) -> Option<Vec<RawLine<'_>>> {
    let mut lines = Vec::new();
    for raw_line in yaml_body.split('\n') {
        let raw_line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        let mut indent = 0usize;
        let mut has_leading_tab = false;
        for b in raw_line.bytes() {
            if b == b' ' {
                indent += 1;
            } else if b == b'\t' {
                has_leading_tab = true;
                break;
            } else {
                break;
            }
        }
        let trimmed = raw_line.trim();
        if has_leading_tab && !trimmed.is_empty() && !trimmed.starts_with('#') {
            return None;
        }
        lines.push(RawLine { raw: raw_line, indent, trimmed });
    }
    Some(lines)
}

fn lookup_case_insensitive<'a>(
    entries: &'a BTreeMap<String, YamlValue>,
    target: &str,
) -> Option<&'a YamlValue> {
    if let Some(val) = entries.get(target) {
        return Some(val);
    }
    entries
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(target))
        .map(|(_, v)| v)
}

fn scalar_to_string(value: &YamlValue) -> Option<String> {
    match value {
        YamlValue::String(s) => {
            let t = s.trim();
            (!t.is_empty()).then(|| t.to_string())
        }
        YamlValue::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn extract_author_name(value: &YamlValue) -> Option<String> {
    if let Some(direct) = scalar_to_string(value) {
        return Some(direct);
    }
    if let YamlValue::Map(map) = value {
        if let Some(name) = lookup_case_insensitive(map, "name")
            .or_else(|| lookup_case_insensitive(map, "literal"))
        {
            if let Some(direct) = scalar_to_string(name) {
                return Some(direct);
            }
            if let YamlValue::Map(name_map) = name {
                if let Some(lit) =
                    lookup_case_insensitive(name_map, "literal").and_then(scalar_to_string)
                {
                    return Some(lit);
                }
                let parts: Vec<String> = ["given", "family"]
                    .iter()
                    .filter_map(|k| lookup_case_insensitive(name_map, k).and_then(scalar_to_string))
                    .collect();
                if !parts.is_empty() {
                    return Some(parts.join(" "));
                }
            }
        }
        let parts: Vec<String> = ["given", "family"]
            .iter()
            .filter_map(|k| lookup_case_insensitive(map, k).and_then(scalar_to_string))
            .collect();
        if !parts.is_empty() {
            return Some(parts.join(" "));
        }
    }
    None
}

fn extract_authors(entries: &BTreeMap<String, YamlValue>) -> Vec<String> {
    let mut out = Vec::new();
    let mut push = |name: Option<String>| {
        if let Some(n) = name {
            if !out.contains(&n) {
                out.push(n);
            }
        }
    };
    for key in ["author", "authors", "creator"] {
        let Some(val) = lookup_case_insensitive(entries, key) else {
            continue;
        };
        match val {
            YamlValue::Seq(items) => {
                for item in items {
                    push(extract_author_name(item));
                }
            }
            other => push(extract_author_name(other)),
        }
    }
    out
}

fn extract_keywords(entries: &BTreeMap<String, YamlValue>) -> Vec<String> {
    let mut out = Vec::new();
    let mut push = |raw: &str| {
        let trimmed = raw.trim();
        if !trimmed.is_empty() && !out.iter().any(|existing| existing == trimmed) {
            out.push(trimmed.to_string());
        }
    };
    for key in ["keywords", "tags", "tag"] {
        let Some(val) = lookup_case_insensitive(entries, key) else {
            continue;
        };
        match val {
            YamlValue::Seq(items) => {
                for item in items {
                    if let Some(s) = scalar_to_string(item) {
                        push(&s);
                    }
                }
            }
            other => {
                if let Some(s) = scalar_to_string(other) {
                    if s.contains(',') {
                        for part in s.split(',') {
                            push(part);
                        }
                    } else {
                        push(&s);
                    }
                }
            }
        }
    }
    out
}

fn days_in_month(year: i32, month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            let leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
            if leap { 29 } else { 28 }
        }
        _ => 0,
    }
}

fn valid_ymd(year: i32, month: u8, day: u8) -> bool {
    (0..=9999).contains(&year) && (1..=12).contains(&month) && day >= 1 && day <= days_in_month(year, month)
}

fn shift_utc_offset(
    mut year: i32,
    mut month: u8,
    mut day: u8,
    hour: u8,
    minute: u8,
    second: u8,
    offset_minutes: i32,
) -> Option<PdfDate> {
    let mut total_minutes = (hour as i32) * 60 + (minute as i32) - offset_minutes;
    while total_minutes < 0 {
        total_minutes += 1440;
        if day > 1 {
            day -= 1;
        } else if month > 1 {
            month -= 1;
            day = days_in_month(year, month);
        } else {
            year -= 1;
            if year < 0 {
                return None;
            }
            month = 12;
            day = 31;
        }
    }
    while total_minutes >= 1440 {
        total_minutes -= 1440;
        let max_day = days_in_month(year, month);
        if day < max_day {
            day += 1;
        } else if month < 12 {
            month += 1;
            day = 1;
        } else {
            year += 1;
            if year > 9999 {
                return None;
            }
            month = 1;
            day = 1;
        }
    }
    let adj_hour = (total_minutes / 60) as u8;
    let adj_minute = (total_minutes % 60) as u8;
    Some(PdfDate {
        year,
        month,
        day,
        time: Some((adj_hour, adj_minute, second)),
    })
}

pub fn parse_pdf_date(raw: &str) -> Option<PdfDate> {
    let s = raw.trim();
    if s.len() < 8 {
        return None;
    }
    // ISO-8601 / RFC-3339: YYYY-MM-DD or YYYY/MM/DD with optional [T ]HH:MM[:SS][.frac][Z|±HH:?MM]
    let sep = s.as_bytes().get(4).copied();
    if matches!(sep, Some(b'-' | b'/')) && s[..4].bytes().all(|b| b.is_ascii_digit()) {
        let rest = &s[5..];
        let (month_str, after_month) = rest.split_once(sep.unwrap() as char)?;
        if month_str.is_empty() || month_str.len() > 2 || !month_str.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let day_len = after_month.bytes().take_while(|b| b.is_ascii_digit()).count();
        if day_len == 0 || day_len > 2 {
            return None;
        }
        let year: i32 = s[..4].parse().ok()?;
        let month: u8 = month_str.parse().ok()?;
        let day: u8 = after_month[..day_len].parse().ok()?;
        if !valid_ymd(year, month, day) {
            return None;
        }
        let tail = after_month[day_len..].trim();
        if tail.is_empty() {
            return Some(PdfDate { year, month, day, time: None });
        }
        let time_part = after_month[day_len..]
            .strip_prefix(['T', 't', ' '])?
            .trim();
        if time_part.len() < 5 {
            return None;
        }
        let hour: u8 = time_part.get(0..2)?.parse().ok()?;
        if time_part.as_bytes().get(2) != Some(&b':') {
            return None;
        }
        let minute: u8 = time_part.get(3..5)?.parse().ok()?;
        if hour > 23 || minute > 59 {
            return None;
        }
        let mut rem = &time_part[5..];
        let mut second = 0u8;
        if let Some(sec_rest) = rem.strip_prefix(':') {
            if sec_rest.len() < 2 {
                return None;
            }
            second = sec_rest[..2].parse().ok()?;
            if second > 59 {
                return None;
            }
            rem = &sec_rest[2..];
            if let Some(frac) = rem.strip_prefix('.') {
                let digits = frac.bytes().take_while(|b| b.is_ascii_digit()).count();
                if digits == 0 {
                    return None;
                }
                rem = &frac[digits..];
            }
        }
        let rem = rem.trim();
        if rem.is_empty() || rem.eq_ignore_ascii_case("z") {
            return Some(PdfDate {
                year,
                month,
                day,
                time: Some((hour, minute, second)),
            });
        }
        if let Some(sign) = rem.chars().next().filter(|c| *c == '+' || *c == '-') {
            let tz = &rem[1..];
            let (tz_h, tz_m) = if let Some((h, m)) = tz.split_once(':') {
                (h, m)
            } else if tz.len() == 4 {
                (&tz[..2], &tz[2..])
            } else if tz.len() == 2 {
                (tz, "00")
            } else {
                return None;
            };
            let h: i32 = tz_h.parse().ok()?;
            let m: i32 = tz_m.parse().ok()?;
            if !(0..=23).contains(&h) || !(0..=59).contains(&m) {
                return None;
            }
            let offset_mins = (h * 60 + m) * if sign == '+' { 1 } else { -1 };
            return shift_utc_offset(year, month, day, hour, minute, second, offset_mins);
        }
        return None;
    }

    // Named month formats such as "March 15, 2026" or "15 March 2026"
    let cleaned = s.replace(',', " ");
    let tokens: Vec<&str> = cleaned.split_whitespace().collect();
    if tokens.len() == 3 {
        let month_num = |m: &str| -> Option<u8> {
            match m.to_ascii_lowercase().as_str() {
                "jan" | "january" => Some(1),
                "feb" | "february" => Some(2),
                "mar" | "march" => Some(3),
                "apr" | "april" => Some(4),
                "may" => Some(5),
                "jun" | "june" => Some(6),
                "jul" | "july" => Some(7),
                "aug" | "august" => Some(8),
                "sep" | "sept" | "september" => Some(9),
                "oct" | "october" => Some(10),
                "nov" | "november" => Some(11),
                "dec" | "december" => Some(12),
                _ => None,
            }
        };
        if let (Some(month), Ok(day), Ok(year)) =
            (month_num(tokens[0]), tokens[1].parse::<u8>(), tokens[2].parse::<i32>())
        {
            if valid_ymd(year, month, day) {
                return Some(PdfDate { year, month, day, time: None });
            }
        }
        if let (Ok(day), Some(month), Ok(year)) =
            (tokens[0].parse::<u8>(), month_num(tokens[1]), tokens[2].parse::<i32>())
        {
            if valid_ymd(year, month, day) {
                return Some(PdfDate { year, month, day, time: None });
            }
        }
    }
    None
}

fn normalize_pdf_metadata(entries: &BTreeMap<String, YamlValue>) -> PdfMetadata {
    let title = lookup_case_insensitive(entries, "title").and_then(scalar_to_string);
    let authors = extract_authors(entries);
    let description = lookup_case_insensitive(entries, "description")
        .and_then(scalar_to_string)
        .or_else(|| lookup_case_insensitive(entries, "subject").and_then(scalar_to_string))
        .or_else(|| lookup_case_insensitive(entries, "abstract").and_then(scalar_to_string));
    let keywords = extract_keywords(entries);
    let date = lookup_case_insensitive(entries, "date")
        .and_then(scalar_to_string)
        .and_then(|d| parse_pdf_date(&d));
    PdfMetadata {
        title,
        authors,
        description,
        keywords,
        date,
    }
}

pub fn parse_frontmatter(markdown: &str) -> Option<ParsedFrontmatter<'_>> {
    let mut cursor = if markdown.starts_with('\u{feff}') {
        '\u{feff}'.len_utf8()
    } else {
        0
    };
    if !markdown[cursor..].starts_with("---") {
        return None;
    }
    cursor += 3;
    let bytes = markdown.as_bytes();
    while cursor < bytes.len() && (bytes[cursor] == b' ' || bytes[cursor] == b'\t') {
        cursor += 1;
    }
    if bytes.get(cursor) == Some(&b'\r') && bytes.get(cursor + 1) == Some(&b'\n') {
        cursor += 2;
    } else if bytes.get(cursor) == Some(&b'\n') {
        cursor += 1;
    } else {
        return None;
    }

    let yaml_start = cursor;
    let mut line_start = cursor;
    let mut yaml_end = None;
    let mut frontmatter_end = None;

    while line_start <= bytes.len() {
        let rel_nl = markdown[line_start..].find('\n');
        let (content_end, next_line_start, full_line_end) = match rel_nl {
            None => (bytes.len(), bytes.len() + 1, bytes.len()),
            Some(pos) => {
                let nl_idx = line_start + pos;
                let c_end = if nl_idx > line_start && bytes[nl_idx - 1] == b'\r' {
                    nl_idx - 1
                } else {
                    nl_idx
                };
                (c_end, nl_idx + 1, nl_idx + 1)
            }
        };
        let line = &markdown[line_start..content_end];
        if let Some(rest) = line.strip_prefix("---").or_else(|| line.strip_prefix("...")) {
            if rest.bytes().all(|b| b == b' ' || b == b'\t') {
                yaml_end = Some(line_start);
                frontmatter_end = Some(full_line_end);
                break;
            }
        }
        if rel_nl.is_none() {
            break;
        }
        line_start = next_line_start;
    }

    let yaml_end = yaml_end?;
    let frontmatter_end = frontmatter_end?;
    let mut yaml_slice = &markdown[yaml_start..yaml_end];
    if let Some(stripped) = yaml_slice.strip_suffix('\n') {
        yaml_slice = stripped.strip_suffix('\r').unwrap_or(stripped);
    }

    let lines = if yaml_slice.is_empty() {
        Vec::new()
    } else {
        to_raw_lines(yaml_slice)?
    };

    let first_meaningful = next_meaningful_line(&lines, 0);
    let mut entries = BTreeMap::new();
    if first_meaningful < lines.len() {
        if lines[first_meaningful].indent != 0 {
            return None;
        }
        let (parsed, next_idx) = parse_block_mapping(&lines, first_meaningful, 0)?;
        if next_meaningful_line(&lines, next_idx) < lines.len() {
            return None;
        }
        entries = parsed;
    }

    let metadata = normalize_pdf_metadata(&entries);
    Some(ParsedFrontmatter {
        raw: &markdown[..frontmatter_end],
        end: frontmatter_end,
        entries,
        metadata,
    })
}

pub fn strip_frontmatter(markdown: &str) -> &str {
    match parse_frontmatter(markdown) {
        Some(fm) => &markdown[fm.end..],
        None => markdown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_delimiter_variations_bom_empty_and_eof_closers() {
        let cases = [
            ("\u{feff}---\ntitle: BOM\n---\nBody", "Body", Some("BOM")),
            ("---  \t \ntitle: Dot\n...  \t\nBody", "Body", Some("Dot")),
            ("---\r\ntitle: CRLF\r\n...\r\nBody", "Body", Some("CRLF")),
            ("---\n---\nAfter empty", "After empty", None),
            ("---\n...\nAfter dots", "After dots", None),
            ("---\n# comment\n---\nAfter comment", "After comment", None),
            ("---\ntitle: EOF\n---", "", Some("EOF")),
            ("\u{feff}---\ntitle: BOM EOF\n...", "", Some("BOM EOF")),
        ];
        for (input, expected_body, expected_title) in cases {
            let parsed = parse_frontmatter(input).unwrap_or_else(|| panic!("failed on {input:?}"));
            assert_eq!(&input[parsed.end..], expected_body);
            assert_eq!(parsed.metadata.title.as_deref(), expected_title);
        }
    }

    #[test]
    fn normalizes_quarto_obsidian_and_typora_pdf_metadata() {
        let md = "\
---
title: \"Statistical Mechanics\"
author:
  - name: Ludwig Boltzmann
  - given: Josiah
    family: Gibbs
abstract: |-
  Canonical ensemble derivations
  and entropy bounds.
keywords: [entropy, ensembles]
tags:
- physics
- entropy
date: 2026-03-15T14:30:00+02:00
...
# Body";
        let parsed = parse_frontmatter(md).unwrap();
        assert_eq!(parsed.metadata.title.as_deref(), Some("Statistical Mechanics"));
        assert_eq!(parsed.metadata.authors, vec!["Ludwig Boltzmann", "Josiah Gibbs"]);
        assert_eq!(
            parsed.metadata.description.as_deref(),
            Some("Canonical ensemble derivations\nand entropy bounds.")
        );
        assert_eq!(parsed.metadata.keywords, vec!["entropy", "ensembles", "physics"]);
        assert_eq!(
            parsed.metadata.date,
            Some(PdfDate { year: 2026, month: 3, day: 15, time: Some((12, 30, 0)) })
        );
        let directive = parsed.metadata.typst_set_document();
        assert!(directive.contains("title: \"Statistical Mechanics\""));
        assert!(directive.contains("author: (\"Ludwig Boltzmann\", \"Josiah Gibbs\",)"));
        assert!(directive.contains("keywords: (\"entropy\", \"ensembles\", \"physics\",)"));
        assert!(directive.contains("date: datetime(year: 2026, month: 3, day: 15, hour: 12, minute: 30, second: 0)"));
    }

    #[test]
    fn parses_calendar_dates_and_ignores_freeform_dates_safely() {
        assert_eq!(
            parse_pdf_date("2026-03-15"),
            Some(PdfDate { year: 2026, month: 3, day: 15, time: None })
        );
        assert_eq!(
            parse_pdf_date("March 15, 2026"),
            Some(PdfDate { year: 2026, month: 3, day: 15, time: None })
        );
        assert_eq!(
            parse_pdf_date("15 Sep 2026"),
            Some(PdfDate { year: 2026, month: 9, day: 15, time: None })
        );
        assert_eq!(parse_pdf_date("2026-02-29"), None);
        assert_eq!(parse_pdf_date("Spring Semester 2026"), None);
    }

    #[test]
    fn rejects_malformed_unclosed_and_non_yaml_blocks() {
        for sample in [
            "---\ntitle: Unclosed\n\n# Body",
            "+++\ntitle = \"TOML\"\n+++\n# Body",
            "---\nJust a sentence between rules.\n---\n",
            "---\n- item 1\n- item 2\n---\n",
            "---\ntitle: \"unclosed quote\n---\n",
            "---\ntags: [unclosed\n---\n",
            "---\nauthor:\n\t- tab indent\n---\n",
        ] {
            assert!(parse_frontmatter(sample).is_none(), "unexpectedly accepted {sample:?}");
            assert_eq!(strip_frontmatter(sample), sample);
        }
    }
}
