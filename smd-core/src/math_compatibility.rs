use typst::syntax::{SyntaxKind, SyntaxNode};

// MiTeX's embedded symbol names predate the shipping Typst symbol inventory.
// Match syntax nodes rather than text: #textmath[...] contains literal markup
// which must never be renamed, even when it looks like a symbol identifier.
pub(crate) fn compatible_math(value: &str) -> String {
    // Ordinary equations need no extra syntax tree. All legacy identifiers
    // below contain a dot, except `diff`.
    if !value.contains('.') && !value.contains("diff") { return value.to_owned(); }
    fn replacement(name: &str) -> Option<&'static str> {
        Some(match name {
            "angle.l" => "chevron.l", "angle.r" => "chevron.r",
            "angle.l.double" => "chevron.l.double", "angle.r.double" => "chevron.r.double",
            "ast.circle" => "convolve.o",
            "dot.circle" => "dot.o", "dot.circle.big" => "dot.o.big",
            "plus.circle" => "plus.o", "plus.circle.big" => "plus.o.big",
            "times.circle" => "times.o", "times.circle.big" => "times.o.big",
            "minus.circle" => "minus.o", "circle.nested" => "compose.o",
            "dash.circle" => "dash.o",
            "arrow.l.dash" => "arrow.l.dashed", "arrow.r.dash" => "arrow.r.dashed",
            "planck.reduce" => "planck",
            "bracket.l.double" => "bracket.l.stroked", "bracket.r.double" => "bracket.r.stroked",
            "ohm.inv" => "Omega.inv", "diff" => "partial",
            _ => return None,
        })
    }
    fn visit(node: &SyntaxNode, offset: usize, edits: &mut Vec<(std::ops::Range<usize>, &'static str)>) {
        if matches!(node.kind(), SyntaxKind::MathIdent | SyntaxKind::MathFieldAccess) {
            if let Some(new) = replacement(&node.full_text()) {
                edits.push((offset..offset + node.len(), new));
                return;
            }
        }
        let mut child_offset = offset;
        for child in node.children() {
            visit(child, child_offset, edits);
            child_offset += child.len();
        }
    }
    let mut edits = Vec::new();
    visit(&typst::syntax::parse_math(value), 0, &mut edits);
    let mut output = value.to_owned();
    for (range, new) in edits.into_iter().rev() { output.replace_range(range, new); }
    output
}

#[cfg(test)]
mod tests {
    use super::compatible_math;

    #[test]
    fn changes_symbols_but_preserves_markup_strings_and_unicode_offsets() {
        assert_eq!(compatible_math("ast.circle_N"), "convolve.o_N");
        assert_eq!(compatible_math("α + ast.circle_N + ast.circle"), "α + convolve.o_N + convolve.o");
        assert_eq!(compatible_math(r#"ast.circle + "ast.circle" + #textmath[ast.circle angle.l diff];"#),
            r#"convolve.o + "ast.circle" + #textmath[ast.circle angle.l diff];"#);
        assert_eq!(compatible_math("dot.circle.big + plus.circle + diff"), "dot.o.big + plus.o + partial");
    }
}
