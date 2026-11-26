use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

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
