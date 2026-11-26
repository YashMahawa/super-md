use crate::frontmatter;
use crate::heading_slug;
use crate::html_scan::parse_html_images;
use crate::strip_percent_comments;
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};

fn parse_positive_number_str(s: &str) -> Option<&str> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    let (int_part, frac_part) = match t.split_once('.') {
        Some((a, b)) => (a, Some(b)),
        None => (t, None),
    };
    if int_part.is_empty() || !int_part.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if let Some(frac) = frac_part {
        if frac.is_empty() || !frac.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
    }
    let val: f64 = t.parse().ok()?;
    (val.is_finite() && val > 0.0).then_some(t)
}

fn parse_obsidian_pipe_spec<'a>(path: &'a str, spec: Option<&'a str>) -> (&'a str, Option<&'a str>) {
    let Some(spec) = spec else { return (path, None) };
    let (caption_opt, dim_candidate) = match spec.rsplit_once('|') {
        Some((cap, last)) => (Some(cap.strip_suffix('\\').unwrap_or(cap).trim()), last.trim()),
        None => (None, spec.trim()),
    };
    let width_part = match dim_candidate.split_once(['x', 'X']) {
        Some((w, h)) => {
            if parse_positive_number_str(h).is_none() {
                return (spec, None);
            }
            w
        }
        None => dim_candidate,
    };
    if let Some(width) = parse_positive_number_str(width_part) {
        let alt = caption_opt.filter(|c| !c.is_empty()).unwrap_or(path);
        (alt, Some(width))
    } else {
        (spec, None)
    }
}

fn normalize_obsidian_slice(slice: &str) -> String {
    let mut out = String::with_capacity(slice.len());
    let mut rest = slice;
    while let Some(pos) = rest.find("![[") {
        out.push_str(&rest[..pos]);
        let after_open = &rest[pos + 3..];
        if let Some(close) = after_open.find("]]") {
            let inner = &after_open[..close];
            if !inner.is_empty() && !inner.contains(['[', ']', '\r', '\n']) {
                let (raw_path, spec) = match inner.split_once('|') {
                    Some((p, s)) => (p, Some(s)),
                    None => (inner, None),
                };
                let path = if spec.is_some() && raw_path.ends_with('\\') {
                    &raw_path[..raw_path.len() - 1]
                } else {
                    raw_path
                }
                .trim();
                if !path.is_empty() {
                    let (alt_raw, width) = parse_obsidian_pipe_spec(path, spec);
                    let alt = alt_raw.replace('\\', "\\\\").replace('[', "\\[").replace(']', "\\]");
                    let escaped_path = path.replace('>', "%3E");
                    if let Some(w) = width {
                        out.push_str(&format!("![{alt}](<{escaped_path}>){{width={w}}}"));
                    } else {
                        out.push_str(&format!("![{alt}](<{escaped_path}>)"));
                    }
                    rest = &after_open[close + 2..];
                    continue;
                }
            }
        }
        out.push_str("![[");
        rest = after_open;
    }
    out.push_str(rest);
    out
}

/// Rewrite prose Obsidian `![[...]]` embeds outside code, HTML, and math spans.
fn normalize_obsidian_embeds(input: &str) -> String {
    if !input.contains("![[") {
        return input.to_string();
    }
    let mut masked: Vec<std::ops::Range<usize>> = Vec::new();
    let mut in_code_block = false;
    for (event, range) in Parser::new_ext(input, Options::ENABLE_MATH).into_offset_iter() {
        match event {
            Event::Start(Tag::CodeBlock(_)) => {
                in_code_block = true;
                masked.push(range);
            }
            Event::End(TagEnd::CodeBlock) => {
                in_code_block = false;
            }
            Event::Code(_) | Event::Html(_) | Event::InlineHtml(_) | Event::InlineMath(_) | Event::DisplayMath(_)
                if !in_code_block =>
            {
                masked.push(range);
            }
            _ => {}
        }
    }
    masked.sort_by_key(|r| r.start);
    let mut out = String::with_capacity(input.len());
    let mut cursor = 0usize;
    for range in masked {
        if range.start > cursor {
            out.push_str(&normalize_obsidian_slice(&input[cursor..range.start]));
        }
        if range.end > cursor {
            let from = cursor.max(range.start);
            out.push_str(&input[from..range.end]);
            cursor = range.end;
        }
    }
    if cursor < input.len() {
        out.push_str(&normalize_obsidian_slice(&input[cursor..]));
    }
    out
}

pub(crate) fn prepare_markdown_body(raw_body: &str, protect_table_math: bool) -> String {
    let stripped = strip_percent_comments(raw_body);
    let normalized = normalize_callouts_body(&stripped);
    if protect_table_math {
        normalize_table_math(&normalized)
    } else {
        normalized
    }
}

pub fn image_sources(markdown: &str) -> Vec<String> {
    let normalized = prepare_markdown_body(frontmatter::strip_frontmatter(markdown), false);
    let mut sources = Vec::new();
    let options = Options::ENABLE_TABLES | Options::ENABLE_FOOTNOTES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_SUBSCRIPT | Options::ENABLE_SUPERSCRIPT | Options::ENABLE_TASKLISTS | Options::ENABLE_MATH;
    let mut events = Parser::new_ext(&normalized, options);
    while let Some(event) = events.next() {
        match event {
            Event::Start(Tag::Image { dest_url, .. }) => sources.push(dest_url.to_string()),
            Event::Start(Tag::HtmlBlock) => {
                let mut html = String::new();
                for event in events.by_ref() {
                    if event == Event::End(TagEnd::HtmlBlock) { break; }
                    if let Event::Html(piece) | Event::Text(piece) = event { html.push_str(&piece); }
                }
                for img in parse_html_images(&html) {
                    sources.push(img.src);
                }
            }
            Event::Html(html) | Event::InlineHtml(html) => {
                for img in parse_html_images(&html) {
                    sources.push(img.src);
                }
            }
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

/// Normalize Obsidian/Super MD callouts and wikilinks outside code before parsing Markdown.
pub fn normalize_callouts(input: &str) -> String {
    if let Some(fm) = frontmatter::parse_frontmatter(input) {
        let rest = &input[fm.end..];
        let mut out = fm.raw.to_string();
        if !out.ends_with('\n') && !rest.is_empty() {
            out.push('\n');
        }
        out.push_str(&prepare_markdown_body(rest, false));
        return out;
    }
    prepare_markdown_body(input, false)
}

fn normalize_callouts_body(input: &str) -> String {
    let mut output = String::new();
    let mut depth = 0usize;
    let mut fence: Option<(char,usize)> = None;
    for line in input.lines() {
        let body=line.trim_start_matches(' ');
        let code=body.chars().next().filter(|ch| matches!(ch,'`'|'~')).and_then(|ch| {
            let count=body.chars().take_while(|value| *value==ch).count();
            let valid_open = !(fence.is_none() && ch == '`' && body[count..].contains('`'));
            (line.len()-body.len()<=3 && count>=3 && valid_open).then_some((ch,count))
        });
        let inside_fence=fence.is_some();
        if let Some((ch,count))=code {
            if let Some((marker,length))=fence {
                if ch==marker && count>=length && body[count..].trim().is_empty() { fence=None; }
            } else if ch != '`' || !body[count..].contains('`') { fence=Some((ch,count)); }
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
    normalize_prose_links(&normalize_obsidian_embeds(&output))
}

fn encode_md_destination(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            ' ' => out.push_str("%20"),
            '\t' => out.push_str("%09"),
            '<' => out.push_str("%3C"),
            '>' => out.push_str("%3E"),
            '(' => out.push_str("%28"),
            ')' => out.push_str("%29"),
            _ => out.push(ch),
        }
    }
    out
}

fn escape_md_link_label(label: &str) -> String {
    let mut out = String::with_capacity(label.len());
    for ch in label.chars() {
        if matches!(ch, '[' | ']') { out.push('\\'); }
        out.push(ch);
    }
    out
}

fn has_supported_note_extension(path: &str) -> bool {
    let clean = path.split(['?', '#']).next().unwrap_or("").trim().to_ascii_lowercase();
    [".md", ".smd", ".fmd", ".markdown", ".txt"].iter().any(|ext| clean.ends_with(ext))
}

fn format_wikilink_markdown(inner: &str) -> Option<String> {
    if inner.is_empty() || inner.contains(['\r', '\n']) { return None; }
    let (raw_left, raw_alias) = match inner.split_once('|') {
        Some((left, alias)) => (left, Some(alias)),
        None => (inner, None),
    };
    let cleaned_left = if raw_alias.is_some() && raw_left.ends_with('\\') { &raw_left[..raw_left.len() - 1] } else { raw_left };
    let trimmed_left = cleaned_left.trim();
    if trimmed_left.is_empty() { return None; }
    if let Some(rest) = trimmed_left.strip_prefix('#') {
        let fragment = rest.trim();
        if fragment.is_empty() { return None; }
        let label = raw_alias.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(fragment);
        return Some(format!("[{}](#{})", escape_md_link_label(label), heading_slug(fragment)));
    }
    let (target, fragment) = match trimmed_left.split_once('#') {
        Some((t, f)) => (t.trim(), f.trim()),
        None => (trimmed_left, ""),
    };
    if target.is_empty() { return None; }
    let label = raw_alias.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(trimmed_left);
    let dest_path = if has_supported_note_extension(target) { target.to_string() } else { format!("{target}.md") };
    let slug_frag = if fragment.is_empty() { String::new() } else { heading_slug(fragment) };
    let dest_frag = if fragment.is_empty() {
        String::new()
    } else if !slug_frag.is_empty() {
        format!("#{slug_frag}")
    } else {
        format!("#{}", encode_md_destination(fragment))
    };
    Some(format!("[{}]({}{})", escape_md_link_label(label), encode_md_destination(&dest_path), dest_frag))
}

fn is_likely_link_destination(dest: &str) -> bool {
    let trimmed = dest.trim();
    if trimmed.is_empty() || !trimmed.contains([' ', '\t']) { return false; }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with('#') || lower.starts_with("./") || lower.starts_with("../") || lower.starts_with('/') || lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:") {
        return true;
    }
    let clean = lower.split(['?', '#']).next().unwrap_or("").trim();
    [".md", ".smd", ".fmd", ".markdown", ".txt", ".pdf"].iter().any(|ext| clean.ends_with(ext))
}

fn rewrite_prose_segment(segment: &str) -> String {
    let mut after_wiki = String::with_capacity(segment.len());
    let bytes = segment.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'[' && bytes[i + 1] == b'[' && (i == 0 || !matches!(bytes[i - 1], b'!' | b'\\')) {
            let start = i + 2;
            let mut end = start;
            let mut found = None;
            while end < bytes.len() && !matches!(bytes[end], b'\r' | b'\n' | b'[') {
                if bytes[end] == b']' {
                    if end + 1 < bytes.len() && bytes[end + 1] == b']' && end > start {
                        found = Some(end);
                    }
                    break;
                }
                end += 1;
            }
            if let Some(close_idx) = found {
                if let Some(formatted) = format_wikilink_markdown(&segment[start..close_idx]) {
                    after_wiki.push_str(&formatted);
                    i = close_idx + 2;
                    continue;
                }
            }
        }
        let ch = segment[i..].chars().next().unwrap();
        after_wiki.push(ch);
        i += ch.len_utf8();
    }

    let mut out = String::with_capacity(after_wiki.len());
    let wbytes = after_wiki.as_bytes();
    let mut j = 0usize;
    while j < wbytes.len() {
        if wbytes[j] == b'[' && (j == 0 || !matches!(wbytes[j - 1], b'!' | b'\\')) {
            let mut k = j + 1;
            let mut escaped = false;
            let mut label_close = None;
            while k < wbytes.len() && !matches!(wbytes[k], b'\r' | b'\n') {
                if escaped { escaped = false; k += 1; continue; }
                if wbytes[k] == b'\\' { escaped = true; k += 1; continue; }
                if wbytes[k] == b'[' { break; }
                if wbytes[k] == b']' { label_close = Some(k); break; }
                k += 1;
            }
            if let Some(close_bracket) = label_close {
                if close_bracket + 1 < wbytes.len() && wbytes[close_bracket + 1] == b'(' {
                    let dest_start = close_bracket + 2;
                    let mut p = dest_start;
                    let mut dest_close = None;
                    while p < wbytes.len() && !matches!(wbytes[p], b'\r' | b'\n' | b'<' | b'>' | b'(') {
                        if wbytes[p] == b')' { dest_close = Some(p); break; }
                        p += 1;
                    }
                    if let Some(close_paren) = dest_close {
                        let raw_inside = &after_wiki[dest_start..close_paren];
                        let (dest_part, title_part) = split_optional_link_title(raw_inside);
                        if is_likely_link_destination(dest_part) {
                            out.push_str(&after_wiki[j..dest_start]);
                            out.push_str(&encode_md_destination(dest_part));
                            out.push_str(title_part);
                            out.push(')');
                            j = close_paren + 1;
                            continue;
                        }
                    }
                }
            }
        }
        let ch = after_wiki[j..].chars().next().unwrap();
        out.push(ch);
        j += ch.len_utf8();
    }
    out
}

fn split_optional_link_title(inside: &str) -> (&str, &str) {
    let trimmed = inside.trim_end_matches([' ', '\t']);
    if let Some(quote) = trimmed.chars().last().filter(|c| matches!(c, '"' | '\'')) {
        if let Some(open_pos) = trimmed[..trimmed.len() - 1].rfind(quote) {
            if open_pos > 0 && matches!(trimmed.as_bytes()[open_pos - 1], b' ' | b'\t') {
                let mut ws_start = open_pos - 1;
                while ws_start > 0 && matches!(trimmed.as_bytes()[ws_start - 1], b' ' | b'\t') {
                    ws_start -= 1;
                }
                return (&inside[..ws_start], &inside[ws_start..]);
            }
        }
    }
    (inside, "")
}

/// Normalize prose wikilinks and spaced Markdown link destinations while
/// leaving fenced code, indented code, inline code, HTML, and math untouched.
fn normalize_prose_links(input: &str) -> String {
    if !input.contains("[[") && !input.contains("](") { return input.to_string(); }
    let mut protected = Vec::new();
    for (event, range) in Parser::new_ext(input, Options::ENABLE_MATH).into_offset_iter() {
        if matches!(event, Event::Start(Tag::CodeBlock(_)) | Event::Code(_) | Event::InlineMath(_) | Event::DisplayMath(_) | Event::Html(_) | Event::InlineHtml(_)) {
            protected.push(range);
        }
    }
    protected.sort_by_key(|r| r.start);
    let mut merged: Vec<std::ops::Range<usize>> = Vec::new();
    for range in protected {
        if let Some(last) = merged.last_mut() {
            if range.start <= last.end {
                last.end = last.end.max(range.end);
                continue;
            }
        }
        merged.push(range);
    }
    let mut out = String::with_capacity(input.len());
    let mut cursor = 0usize;
    for range in merged {
        if cursor < range.start {
            out.push_str(&rewrite_prose_segment(&input[cursor..range.start]));
        }
        out.push_str(&input[range.start..range.end]);
        cursor = range.end;
    }
    if cursor < input.len() {
        out.push_str(&rewrite_prose_segment(&input[cursor..]));
    }
    out
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

#[cfg(test)]
mod tests {
    use super::normalize_table_math;

    #[test]
    fn normalize_table_math_escapes_unescaped_bars_and_preserves_code_and_crlf() {
        let md = r"| In probability | In distribution |
|---|---|
| $P(|X_n-X|>\varepsilon)\to0$ | $F_{X_n}(x)\to F_X(x)$ at its continuity points |
| Code `a|b` is not math | $P(A|B)$ |";
        let normalized = normalize_table_math(md);
        assert_eq!(normalize_table_math(&md.replace('\n', "\r\n")), normalized.replace('\n', "\r\n"));
        assert!(normalized.contains(r"$P(\vert X_n-X\vert >\varepsilon)\to0$"));
        assert!(normalized.contains("`a|b`"));
    }
}
