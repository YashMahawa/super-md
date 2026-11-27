use std::collections::BTreeMap;
use std::str::CharIndices;

use super::YamlValue;

#[derive(Clone)]
pub(super) struct RawLine<'a> {
    pub(super) raw: &'a str,
    pub(super) indent: usize,
    pub(super) trimmed: &'a str,
}

pub(super) fn strip_inline_comment(value: &str) -> &str {
    let bytes = value.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i] == b'#' && (i == 0 || bytes[i - 1] == b' ' || bytes[i - 1] == b'\t') {
            return value[..i].trim_end();
        }
    }
    value.trim_end()
}

fn skip_horizontal_whitespace(chars: &mut CharIndices<'_>) {
    while let Some((_, next)) = chars.clone().next() {
        if next == ' ' || next == '\t' {
            chars.next();
        } else {
            break;
        }
    }
}

fn fold_quoted_newline(out: &mut String, chars: &mut CharIndices<'_>) {
    let trimmed_len = out.trim_end_matches([' ', '\t']).len();
    out.truncate(trimmed_len);
    skip_horizontal_whitespace(chars);
    out.push(' ');
}

fn parse_hex_escape(rest: &str, chars: &mut CharIndices<'_>, digits: usize) -> Option<char> {
    if rest.len() < digits || !rest.is_char_boundary(digits) {
        return None;
    }
    let code = u32::from_str_radix(&rest[..digits], 16).ok()?;
    let decoded = char::from_u32(code)?;
    for _ in 0..digits {
        chars.next()?;
    }
    Some(decoded)
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
                '\n' => skip_horizontal_whitespace(&mut chars),
                'x' => out.push(parse_hex_escape(&input[esc_idx + 1..], &mut chars, 2)?),
                'u' => out.push(parse_hex_escape(&input[esc_idx + 1..], &mut chars, 4)?),
                'U' => out.push(parse_hex_escape(&input[esc_idx + 1..], &mut chars, 8)?),
                other => out.push(other),
            }
            continue;
        }
        if ch == '\n' {
            fold_quoted_newline(&mut out, &mut chars);
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
            fold_quoted_newline(&mut out, &mut chars);
            continue;
        }
        out.push(ch);
    }
    None
}

fn parse_quoted_prefix(input: &str) -> Option<(String, &str)> {
    if input.starts_with('"') {
        parse_double_quoted(input)
    } else if input.starts_with('\'') {
        parse_single_quoted(input)
    } else {
        None
    }
}

fn only_trailing_comment(rest: &str) -> bool {
    let trimmed = rest.trim_start();
    trimmed.is_empty() || trimmed.starts_with('#')
}

pub(super) fn parse_plain_scalar(raw: &str) -> YamlValue {
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
        if ch == '"' || ch == '\'' {
            let (_, rest) = parse_quoted_prefix(&inner[idx..])?;
            idx = inner.len() - rest.len();
            continue;
        }
        match ch {
            '[' => depth_bracket += 1,
            ']' if depth_bracket == 0 => return None,
            ']' => depth_bracket -= 1,
            '{' => depth_brace += 1,
            '}' if depth_brace == 0 => return None,
            '}' => depth_brace -= 1,
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

pub(super) fn parse_flow_value(raw: &str) -> Option<YamlValue> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Some(YamlValue::Null);
    }
    if trimmed.starts_with('"') || trimmed.starts_with('\'') {
        let (val, rest) = parse_quoted_prefix(trimmed)?;
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

fn split_quoted_key_value(trimmed: &str, allow_compact_flow_colon: bool) -> Option<(String, &str)> {
    let (key, rest) = parse_quoted_prefix(trimmed)?;
    let after = rest.trim_start();
    let post_colon = after.strip_prefix(':')?;
    if !allow_compact_flow_colon
        && !post_colon.is_empty()
        && !post_colon.starts_with(' ')
        && !post_colon.starts_with('\t')
    {
        return None;
    }
    Some((key, post_colon.trim_start()))
}

pub(super) fn split_key_value(
    trimmed: &str,
    allow_compact_flow_colon: bool,
) -> Option<(String, &str)> {
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    if trimmed == "-" || trimmed.starts_with("- ") || trimmed.starts_with("-\t") {
        return None;
    }
    if trimmed.starts_with('"') || trimmed.starts_with('\'') {
        return split_quoted_key_value(trimmed, allow_compact_flow_colon);
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

pub(super) fn is_blank_or_comment(line: &RawLine<'_>) -> bool {
    line.trimmed.is_empty() || line.trimmed.starts_with('#')
}

pub(super) fn is_sequence_item(trimmed: &str) -> Option<&str> {
    if trimmed == "-" {
        return Some("");
    }
    if let Some(rest) = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("-\t")) {
        return Some(rest.trim_start());
    }
    None
}

#[derive(Default)]
struct QuoteState {
    in_single: bool,
    in_double: bool,
}

enum QuotedAdvance {
    Consumed(usize),
    TrailingBackslash,
}

impl QuoteState {
    fn is_in_quotes(&self) -> bool {
        self.in_single || self.in_double
    }

    fn step_inside_quotes(&mut self, bytes: &[u8], i: usize) -> Option<QuotedAdvance> {
        let ch = bytes[i];
        if self.in_double {
            if ch == b'\\' {
                if i + 1 >= bytes.len() {
                    return Some(QuotedAdvance::TrailingBackslash);
                }
                return Some(QuotedAdvance::Consumed(2));
            }
            if ch == b'"' {
                self.in_double = false;
            }
            return Some(QuotedAdvance::Consumed(1));
        }
        if self.in_single {
            if ch == b'\'' {
                if bytes.get(i + 1) == Some(&b'\'') {
                    return Some(QuotedAdvance::Consumed(2));
                }
                self.in_single = false;
            }
            return Some(QuotedAdvance::Consumed(1));
        }
        None
    }

    fn enter_if_quote(&mut self, ch: u8) -> bool {
        match ch {
            b'"' => self.in_double = true,
            b'\'' => self.in_single = true,
            _ => return false,
        }
        true
    }
}

pub(super) fn strip_flow_line_comment(line: &str) -> &str {
    let bytes = line.as_bytes();
    let mut quotes = QuoteState::default();
    let mut i = 0usize;
    while i < bytes.len() {
        if let Some(adv) = quotes.step_inside_quotes(bytes, i) {
            match adv {
                QuotedAdvance::Consumed(n) => i += n,
                QuotedAdvance::TrailingBackslash => break,
            }
            continue;
        }
        let ch = bytes[i];
        if !quotes.enter_if_quote(ch)
            && ch == b'#'
            && (i == 0 || bytes[i - 1] == b' ' || bytes[i - 1] == b'\t')
        {
            return line[..i].trim_end();
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
    let mut quotes = QuoteState::default();
    let mut closed_top = false;
    let mut i = 0usize;
    while i < bytes.len() {
        if let Some(adv) = quotes.step_inside_quotes(bytes, i) {
            match adv {
                QuotedAdvance::Consumed(n) => i += n,
                QuotedAdvance::TrailingBackslash => return FlowState::Incomplete,
            }
            continue;
        }
        let ch = bytes[i];
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
        if !quotes.enter_if_quote(ch) {
            match ch {
                b'[' => depth_bracket += 1,
                b'{' => depth_brace += 1,
                b']' | b'}' => {
                    if ch == b']' {
                        depth_bracket -= 1;
                    } else {
                        depth_brace -= 1;
                    }
                    if depth_bracket < 0 || depth_brace < 0 {
                        return FlowState::Error;
                    }
                    closed_top = depth_bracket == 0 && depth_brace == 0;
                }
                _ => {}
            }
        }
        i += 1;
    }
    if quotes.is_in_quotes() || depth_bracket > 0 || depth_brace > 0 {
        return FlowState::Incomplete;
    }
    if closed_top { FlowState::Balanced } else { FlowState::Incomplete }
}

pub(super) fn collect_flow_lines(
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

pub(super) fn collect_quoted_scalar(
    lines: &[RawLine<'_>],
    start_index: usize,
    initial_rest: &str,
    min_cont_indent: usize,
) -> Option<(String, usize)> {
    let mut combined = initial_rest.to_string();
    let mut idx = start_index;
    loop {
        if let Some((val, rest)) = parse_quoted_prefix(&combined) {
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

pub(super) fn next_meaningful_line(lines: &[RawLine<'_>], from_index: usize) -> usize {
    let mut idx = from_index;
    while idx < lines.len() && is_blank_or_comment(&lines[idx]) {
        idx += 1;
    }
    idx
}

pub(super) fn to_raw_lines(yaml_body: &str) -> Option<Vec<RawLine<'_>>> {
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
