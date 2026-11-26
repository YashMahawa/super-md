use std::collections::BTreeMap;

use super::yaml_lexer::{
    collect_flow_lines, collect_quoted_scalar, is_blank_or_comment, is_sequence_item,
    next_meaningful_line, parse_flow_value, parse_plain_scalar, split_key_value,
    strip_inline_comment, RawLine,
};
use super::YamlValue;

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

fn parse_structured_inline_value(
    lines: &[RawLine<'_>],
    line_index: usize,
    rest: &str,
    parent_indent: usize,
    flow_cont_indent: usize,
) -> Option<Option<(YamlValue, usize)>> {
    if rest.starts_with('|') || rest.starts_with('>') {
        return Some(
            parse_block_scalar(lines, line_index, rest, parent_indent)
                .map(|(val, idx)| (YamlValue::String(val), idx)),
        );
    }
    if rest.starts_with('"') || rest.starts_with('\'') {
        return Some(
            collect_quoted_scalar(lines, line_index, rest, parent_indent + 1)
                .map(|(val, idx)| (YamlValue::String(val), idx)),
        );
    }
    if rest.starts_with('[') || rest.starts_with('{') {
        return Some(
            collect_flow_lines(lines, line_index, rest, flow_cont_indent)
                .and_then(|(combined, idx)| Some((parse_flow_value(&combined)?, idx))),
        );
    }
    None
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

    if let Some(result) =
        parse_structured_inline_value(lines, line_index, rest, key_indent, key_indent)
    {
        return result;
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
        if let Some(result) =
            parse_structured_inline_value(lines, idx, item_rest, seq_indent, seq_indent + 1)
        {
            let (val, next) = result?;
            items.push(val);
            idx = next;
            continue;
        }
        items.push(parse_plain_scalar(item_rest));
        idx += 1;
    }
    Some((items, idx))
}

pub(super) fn parse_block_mapping(
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
