use std::collections::HashMap;
use smd_core::{export, source, PdfOptions};

#[test]
fn circular_convolution_exports_with_current_typst_without_changing_tex_text() {
    let markdown = r"# Circular convolution

Inline $x \circledast h$ and $x \circledast_N h$.

$$y[n]=(x\circledast_N h)[n]=\sum_{m=0}^{N-1}x[m]h[(n-m)\bmod N].$$

Literal text $\text{ast.circle}$ and existing $\langle x,y\rangle$ remain intact.
";
    let generated = source(markdown, &PdfOptions::default(), &HashMap::new()).unwrap();
    assert!(generated.contains("convolve.o"));
    let literal = mitex::convert_math(r"\text{ast.circle}", None).unwrap();
    let encoded_literal = serde_json::to_string(&format!("${literal}$")).unwrap();
    assert!(generated.contains(&encoded_literal), "Quoted user text must not be rewritten: {encoded_literal}\n{generated}");
    let bytes = export(markdown, &PdfOptions::default(), &HashMap::new()).unwrap();
    assert!(bytes.starts_with(b"%PDF-"));
    assert!(bytes.len() > 1000);
}

#[test]
fn embedded_symbol_inventory_remains_compatible_with_the_shipping_typesetter() {
    // Audit symbolic zero-argument commands, not layout commands which require
    // a matrix, an argument, or a surrounding environment. No handwritten list
    // can silently miss a newly added MiTeX symbol.
    let mut commands = mitex_spec_gen::DEFAULT_SPEC.items().filter_map(|(name, item)| {
        let mitex::CommandSpecItem::Cmd(shape) = item else { return None };
        if !matches!(&shape.args, mitex::ArgShape::Right { pattern: mitex::ArgPattern::None }) {
            return None;
        }
        let alias = shape.alias.as_deref()?;
        (name.chars().all(|c| c.is_ascii_alphabetic()) && !name.is_empty()
            && alias.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
            && !alias.is_empty()).then(|| name.to_string())
    }).collect::<Vec<_>>();
    commands.sort();
    assert!(commands.len() > 300, "Symbol inventory unexpectedly empty or incomplete: {}", commands.len());
    fn sheet(commands: &[String]) -> String {
        commands.iter().map(|name| format!("${{\\{name}}}$\n\n")).collect()
    }
    fn failing(commands: &[String], failures: &mut Vec<String>) {
        if export(&sheet(commands), &PdfOptions::default(), &HashMap::new()).is_ok() { return; }
        if commands.len() == 1 {
            let error = export(&sheet(commands), &PdfOptions::default(), &HashMap::new()).unwrap_err();
            let converted = mitex::convert_math(&format!("\\{}", commands[0]), None).unwrap();
            failures.push(format!("\\{} -> {converted}: {error}", commands[0]));
        } else {
            let middle = commands.len() / 2;
            failing(&commands[..middle], failures);
            failing(&commands[middle..], failures);
        }
    }
    let mut failures = Vec::new();
    failing(&commands, &mut failures);
    assert!(failures.is_empty(), "Incompatible symbols ({} tested):\n{}", commands.len(), failures.join("\n"));
    println!("Exported all {} embedded symbolic commands", commands.len());
}
