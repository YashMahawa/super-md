use std::collections::HashMap;

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
            "eqref" if include_refs => Some(CommandKind::Eqref),
            "ref" if include_refs => Some(CommandKind::Ref),
            _ => None,
        };
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

pub(crate) fn analyze_display_equation(
    tex: &str,
    equations: &mut HashMap<String, EquationTarget>,
) -> DisplayEquationPlan {
    let commands = scan_commands(tex, true, false, true);
    if commands.is_empty() {
        return DisplayEquationPlan {
            clean_tex: tex.to_string(),
            tag: None,
            anchor_ids: Vec::new(),
        };
    }
    let mut tag = None;
    let mut labels = Vec::new();
    let mut strip_spans = Vec::new();
    for cmd in commands {
        strip_spans.push((cmd.start, cmd.end));
        match cmd.kind {
            CommandKind::Tag => {
                if let Some(parsed) = format_equation_tag(&cmd.arg, cmd.starred) {
                    tag = Some(parsed);
                }
            }
            CommandKind::Label => {
                labels.push(cmd.arg);
            }
            _ => {}
        }
    }
    let mut clean_tex = String::with_capacity(tex.len());
    let mut last = 0usize;
    for (start, end) in strip_spans {
        clean_tex.push_str(&tex[last..start]);
        last = end;
    }
    clean_tex.push_str(&tex[last..]);

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
