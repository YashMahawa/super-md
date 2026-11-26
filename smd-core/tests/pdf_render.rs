use smd_core::{export, image_sources, normalize_callouts, source, PdfOptions};
use std::collections::HashMap;

#[test]
fn complete_table_math_preserves_absolute_values_and_cells() {
    let md = r"| In probability | In distribution |
|---|---|
| $P(|X_n-X|>\varepsilon)\to0$ | $F_{X_n}(x)\to F_X(x)$ at its continuity points |
| Code `a|b` is not math | $P(A|B)$ |";
    let output=source(md,&PdfOptions::default(),&HashMap::new()).unwrap();
    let widths=output.split("#table(columns: (").nth(1).unwrap().split(')').next().unwrap();
    assert_eq!(widths.split(',').filter(|part|!part.is_empty()).count(),2);
    assert!(output.contains("smd-header-fill"));
    assert!(export(md,&PdfOptions::default(),&HashMap::new()).unwrap().starts_with(b"%PDF-"));
}
#[test]
fn compact_fonts_and_paragraph_spacing_are_validated_and_typeset() {
    let options=PdfOptions{font_size:6.,line_height:1.45,paragraph_spacing:1.2,..PdfOptions::default()};
    let md="# Compact\n\nFirst paragraph.\n\nSecond paragraph with $x^2$.";
    let text=source(md,&options,&HashMap::new()).unwrap();
    assert!(text.contains("spacing: 1.95em"));
    assert!(export(md,&options,&HashMap::new()).unwrap().starts_with(b"%PDF-"));
    let invalid=PdfOptions{paragraph_spacing:f32::NAN,..options};assert!(invalid.validate().is_err());
}
#[test]
fn plain_pdf_keeps_semantic_callouts_not_wallpaper_accent() {
    let options=PdfOptions{themed:false,theme_accent:"#c123ab".into(),..PdfOptions::default()};
    let md="> [!TIP] Tip\n> Learn.\n\n> [!CAUTION] Caution\n> Carefully.\n\n| Header | Value |\n|---|---|\n| x | y |";
    let output=source(md,&options,&HashMap::new()).unwrap();
    assert!(!output.contains("#c123ab"));
    assert!(output.contains("#14735b"));assert!(output.contains("#946200"));
    assert!(output.contains("__smd_icon_tip.svg"));assert!(output.contains("__smd_icon_warning.svg"));
    assert!(output.contains("#e7e7e7"));
    assert!(export(md,&options,&HashMap::new()).unwrap().starts_with(b"%PDF-"));
}
#[test]
fn emoji_font_is_available_without_system_fonts() {
    let bytes = typst::foundations::Bytes::new(include_bytes!("../fonts/NotoEmoji.ttf").as_slice());
    let font = typst::text::Font::iter(bytes).next().expect("Bundled emoji font");
    assert_eq!(font.info().family, "Noto Emoji");
    assert!(export("# Tasks 😊\n\n- [x] Complete ✅\n- [ ] Study 📚", &PdfOptions::default(), &HashMap::new()).unwrap().starts_with(b"%PDF-"));
}
#[test]
fn inner_products_remain_compatible_with_typst_symbols() {
    let md = r"# Inner product

$$\langle x, y \rangle = \frac{1}{T_0} \int_0^{T_0} x(t)y(t)dt=0$$";
    for themed in [false, true] {
        let options = PdfOptions { themed, theme_accent: "#9a461a".into(), ..PdfOptions::default() };
        assert!(export(md, &options, &HashMap::new()).unwrap().starts_with(b"%PDF-"));
    }
}
#[test]
fn every_selectable_paper_and_bundled_reading_font_typesets() {
    let papers=["a3","a4","a5","a6","iso-b4","iso-b5","iso-b6","letter","legal","tabloid","executive"];
    let fonts=["Manrope","Roboto","Noto Serif","JetBrains Mono"];
    for (i,paper) in papers.iter().enumerate() {
        let options=PdfOptions {page_size:paper.to_string(),font_family:fonts[i%fonts.len()].into(),..PdfOptions::default()};
        let pdf=export("# Paper and font\n\nReadable text with $\\int_0^1 x^2 dx=\\frac13$.",&options,&HashMap::new()).unwrap_or_else(|e|panic!("{paper}: {e:#}"));
        assert!(pdf.starts_with(b"%PDF-"));
    }
    let options=PdfOptions {font_family:"DejaVu Sans".into(),..PdfOptions::default()};
    // A supplied font is usable even when platform font discovery is disabled.
    let assets=HashMap::from([("__font_imported.ttf".into(),include_bytes!("../fonts/Manrope.ttf").to_vec())]);
    assert!(export("An imported font asset.",&options,&assets).unwrap().starts_with(b"%PDF-"));
}
#[test]
fn obsidian_probability_equations_export_with_following_content() {
    let md = r"$$\boxed{\begin{aligned}
P(A\cup B\cup C)=&P(A)+P(B)+P(C)\\
&-P(A\cap B)-P(A\cap C)-P(B\cap C)\\
&+P(A\cap B\cap C).
\end{aligned}}$$

## AFTER-EQUATION

> [!TIP] TIP-AFTER-EQUATION
> $P(A\cap B) \le \min(P(A),P(B))$
";
    let bytes = export(md, &PdfOptions::default(), &HashMap::new()).unwrap();
    assert!(bytes.starts_with(b"%PDF-"));
    let rendered = source(md, &PdfOptions::default(), &HashMap::new()).unwrap();
    assert!(rendered.contains("#text(\"AFTER-EQUATION\")"));
    assert!(rendered.contains("#text(\"TIP-AFTER-EQUATION\")"));
}
#[test]
fn callouts_match_split_bracket_events() {
    for md in ["> [!TIP] Learn\n> Try it first.\n", "> \\[!TIP] Learn\n> Try it first.\n"] {
        let rendered = source(md, &PdfOptions::default(), &HashMap::new()).unwrap();
        assert!(rendered.contains("#14735b"));
        assert!(rendered.contains("#text(\"Learn\")"));
        assert!(!rendered.contains("#text(\"[\")"));
    }
}
#[test]
fn exports_real_math_and_multpage_content() {
    let md = "# Calculus\nInline $e^{i\\pi}+1=0$.\n\n$$\n\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix} \\quad \\int_0^1 x^2 dx = \\frac{1}{3}\n$$\n\n> [!TIP] Study\n> Try the problem first.\n\n| Formula | Meaning |\n|---|---|\n| $\\alpha+\\beta$ | angles |\n\n```python\nprint('hello')\n```\n".repeat(10);
    let pdf = export(&md, &PdfOptions::default(), &HashMap::new()).unwrap();
    assert!(pdf.starts_with(b"%PDF-")); assert!(pdf.len() > 10_000);
}
#[test]
fn validates_parameters_and_assets() {
    let mut options = PdfOptions::default(); options.page_size = "a4\nfont: bad".into();
    assert!(source("hello", &options, &HashMap::new()).is_err());
    assert!(source("![missing](picture.png)", &PdfOptions::default(), &HashMap::new()).is_err());
}
#[test]
fn tables_span_pages_and_keep_every_row() {
    let mut md = "# Table regression\n\n| Index | Formula | Explanation |\n|---|---|---|\n".to_string();
    for i in 0..150 { md.push_str(&format!("| ROW-{i:03} | $\\frac{{1}}{{1+x^2}}$ | A long explanation that wraps naturally in the cell without losing any characters or pushing the table past the page edge. |\n")); }
    md.push_str("\nEND-OF-DOCUMENT\n");
    let bytes = export(&md, &PdfOptions::default(), &HashMap::new()).unwrap();
    let path = std::env::temp_dir().join("supermd-table-regression.pdf");
    std::fs::write(&path, bytes).unwrap();
    if let Ok(output) = std::process::Command::new("pdftotext").arg(&path).arg("-").output() {
        let text = String::from_utf8_lossy(&output.stdout);
        for i in 0..150 { assert!(text.contains(&format!("ROW-{i:03}")), "Missing row {i}"); }
        assert!(text.contains("END-OF-DOCUMENT"));
        assert!(text.matches("Index").count() > 1, "Headers must repeat across pages");
    }
    if let Ok(output) = std::process::Command::new("pdftotext").arg("-bbox").arg(&path).arg("-").output() {
        let text = String::from_utf8_lossy(&output.stdout);
        for word in text.lines().filter(|line| line.contains("<word ")) {
            let x = word.split("xMax=\"").nth(1).unwrap().split('"').next().unwrap().parse::<f64>().unwrap();
            assert!(x < 550., "Text exceeds A4 usable width: {word}");
        }
    }
}
#[test]
fn page_numbers_toggle_and_svg_images() {
    let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><rect width="300" height="100" fill="#42669e"/></svg>"##.to_vec();
    let assets = HashMap::from([("figure.svg".to_string(), svg)]);
    let mut options = PdfOptions::default(); options.page_numbers = false;
    let source = source("![figure](figure.svg)\n\n> [!TIP] Look\n> $x^2$\n", &options, &assets).unwrap();
    assert!(!source.contains("#set page(footer:")); assert!(!source.contains("[!TIP]"));
    assert!(export("![figure](figure.svg)", &options, &assets).unwrap().starts_with(b"%PDF-"));
}
#[test]
fn wide_math_in_table_cells_fits_the_column() {
    let formula = (0..35).map(|i| format!("x_{{{i}}}")).collect::<Vec<_>>().join("+");
    let md = format!("| Expression | Meaning |\n|---|---|\n| ${formula}$ | All terms remain visible |\n\n$$ {formula} $$\n");
    let path = std::env::temp_dir().join("supermd-wide-math.pdf");
    std::fs::write(&path, export(&md, &PdfOptions::default(), &HashMap::new()).unwrap()).unwrap();
    if let Ok(output) = std::process::Command::new("pdftotext").arg("-bbox").arg(&path).arg("-").output() {
        for line in String::from_utf8_lossy(&output.stdout).lines().filter(|line| line.contains("<word ")) {
            let x = line.split("xMax=\"").nth(1).unwrap().split('"').next().unwrap().parse::<f64>().unwrap();
            let right_edge = (210. - PdfOptions::default().margin as f64) * 72. / 25.4;
            assert!(x <= right_edge + 0.5, "Wide equation escaped the printable area: {line}");
        }
    }
}
#[test]
fn long_code_blocks_keep_all_lines_and_paginate() {
    let code = (0..180).map(|i| format!("print('CODE-LINE-{i:03}')")).collect::<Vec<_>>().join("\n");
    let path = std::env::temp_dir().join("supermd-long-code.pdf");
    std::fs::write(&path, export(&format!("```python\n{code}\n```\nEND-CODE"), &PdfOptions::default(), &HashMap::new()).unwrap()).unwrap();
    if let Ok(output) = std::process::Command::new("pdftotext").arg(&path).arg("-").output() {
        let text = String::from_utf8_lossy(&output.stdout);
        for i in 0..180 { assert!(text.contains(&format!("CODE-LINE-{i:03}")), "Missing code line {i}"); }
        assert!(text.contains("END-CODE"));
        assert!((3..=5).contains(&text.matches('\u{000c}').count()), "Code should paginate without excessive blank spacing");
    }
    if let Ok(output) = std::process::Command::new("pdftotext").arg("-bbox").arg(&path).arg("-").output() {
        let mut previous_bottom = 0.;
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if line.contains("<page ") { previous_bottom = 0.; }
            if line.contains("<word ") && line.contains("CODE-LINE-") {
                let coordinate = |name: &str| line.split(&format!("{name}=\"")).nth(1).unwrap().split('"').next().unwrap().parse::<f64>().unwrap();
                assert!(coordinate("yMin") >= previous_bottom, "Code lines must not overlap");
                previous_bottom = coordinate("yMax");
            }
        }
    }
}
fn decompress_pdf_streams(pdf: &[u8]) -> String {
    use std::io::Read;
    let mut out = String::new();
    let mut cursor = 0;
    while let Some(pos) = pdf[cursor..].windows(6).position(|w| w == b"stream") {
        let mut start = cursor + pos + 6;
        if pdf.get(start) == Some(&b'\r') { start += 1; }
        if pdf.get(start) == Some(&b'\n') { start += 1; } else { cursor = start; continue; }
        let Some(end_rel) = pdf[start..].windows(9).position(|w| w == b"endstream") else { break };
        let mut end = start + end_rel;
        while end > start && matches!(pdf[end - 1], b'\r' | b'\n') { end -= 1; }
        let mut decoded = Vec::new();
        if flate2::read::ZlibDecoder::new(&pdf[start..end]).read_to_end(&mut decoded).is_ok() {
            if let Ok(text) = String::from_utf8(decoded) {
                out.push_str(&text);
                out.push('\n');
            }
        }
        cursor = start + end_rel + 9;
    }
    out
}
#[test]
fn code_blocks_preserve_multiline_syntax_highlighting() {
    let string_only = "```python\nprint(\"\"\"\ndef inside_multiline_string(): return 42\n\"\"\")\n```\n";
    let with_real_def = "```python\nprint(\"\"\"\ndef inside_multiline_string(): return 42\n\"\"\")\ndef real_function(): return 42\n```\n";
    let rendered = source(with_real_def, &PdfOptions::default(), &HashMap::new()).unwrap();
    assert_eq!(rendered.matches("\n#smd-code(").count(), 1, "Expected one #smd-code call for the block: {rendered}");

    let string_streams = decompress_pdf_streams(&export(string_only, &PdfOptions::default(), &HashMap::new()).unwrap());
    let real_def_streams = decompress_pdf_streams(&export(with_real_def, &PdfOptions::default(), &HashMap::new()).unwrap());
    // Typst Light highlights strings in #198810 and keywords in #d73948 via PDF `scn` color operators.
    let has_scn = |streams: &str, target: [f64; 3]| {
        streams.lines().any(|line| {
            let Some(rest) = line.split("/c1 cs ").nth(1) else { return false };
            let parts: Vec<&str> = rest.split_whitespace().collect();
            parts.len() >= 4 && parts[3] == "scn" && (0..3).all(|i| parts[i].parse::<f64>().is_ok_and(|v| (v - target[i]).abs() < 0.01))
        })
    };
    let string_green = [0x19 as f64 / 255., 0x88 as f64 / 255., 0x10 as f64 / 255.];
    let keyword_red = [0xd7 as f64 / 255., 0x39 as f64 / 255., 0x48 as f64 / 255.];
    assert!(has_scn(&string_streams, string_green), "Multi-line Python string must emit string highlight color:\n{string_streams}");
    assert!(!has_scn(&string_streams, keyword_red), "Keywords inside a multi-line string must not highlight as keywords:\n{string_streams}");
    assert!(has_scn(&real_def_streams, keyword_red), "Code after closing triple quotes must resume keyword highlighting:\n{real_def_streams}");
}
#[test]
fn code_blocks_preserve_blank_lines_trailing_newlines_and_empty_fences() {
    // Empty tagged and untagged fences pass `none`.
    let empty_md = "```python\n```\n\n```\n```\n\nAFTER-EMPTY\n";
    let empty_src = source(empty_md, &PdfOptions::default(), &HashMap::new()).unwrap();
    assert!(empty_src.contains("#smd-code(none, lang: \"python\")"), "{empty_src}");
    assert!(empty_src.contains("#smd-code(none, lang: none)"), "{empty_src}");
    assert!(export(empty_md, &PdfOptions::default(), &HashMap::new()).unwrap().starts_with(b"%PDF-"));

    // Single blank line fence passes `""`, not `none`.
    let one_blank_src = source("```python\n\n```\n\nMARKER", &PdfOptions::default(), &HashMap::new()).unwrap();
    assert!(one_blank_src.contains("#smd-code(\"\", lang: \"python\")"), "{one_blank_src}");

    // LF, CRLF, and unclosed EOF fences strip at most one trailing newline without dropping intentional trailing blank lines.
    let lf_src = source("```rust\nlet a = 1;\nlet b = 2;\n```\n", &PdfOptions::default(), &HashMap::new()).unwrap();
    let crlf_src = source("```rust\r\nlet a = 1;\r\nlet b = 2;\r\n```\r\n", &PdfOptions::default(), &HashMap::new()).unwrap();
    let eof_src = source("```rust\nlet a = 1;\nlet b = 2;", &PdfOptions::default(), &HashMap::new()).unwrap();
    let trailing_blank_src = source("```rust\nlet a = 1;\nlet b = 2;\n\n```\n", &PdfOptions::default(), &HashMap::new()).unwrap();
    assert!(lf_src.contains("#smd-code(\"let a = 1;\\nlet b = 2;\", lang: \"rust\")"), "{lf_src}");
    assert!(crlf_src.contains("#smd-code(\"let a = 1;\\nlet b = 2;\", lang: \"rust\")"), "{crlf_src}");
    assert!(eof_src.contains("#smd-code(\"let a = 1;\\nlet b = 2;\", lang: \"rust\")"), "{eof_src}");
    assert!(trailing_blank_src.contains("#smd-code(\"let a = 1;\\nlet b = 2;\\n\", lang: \"rust\")"), "{trailing_blank_src}");

    let bbox_word_attr = |md: &str, needle: &str, attr: &str| -> Option<f64> {
        let path = std::env::temp_dir().join(format!("supermd-code-y-{}-{needle}-{attr}.pdf", std::process::id()));
        std::fs::write(&path, export(md, &PdfOptions::default(), &HashMap::new()).unwrap()).unwrap();
        let output = std::process::Command::new("pdftotext").arg("-bbox").arg(&path).arg("-").output();
        let _ = std::fs::remove_file(&path);
        let output = output.ok().filter(|out| out.status.success())?;
        let xml = String::from_utf8_lossy(&output.stdout);
        let prefix = format!("{attr}=\"");
        xml.lines()
            .find(|line| line.contains("<word ") && line.contains(needle))
            .map(|line| line.split(&prefix).nth(1).unwrap().split('"').next().unwrap().parse::<f64>().unwrap())
    };
    let bbox_word_y = |md: &str, needle: &str| bbox_word_attr(md, needle, "yMin");
    let row_pt = 1.2 * PdfOptions::default().font_size as f64;
    if let (Some(empty_y), Some(blank_y)) = (
        bbox_word_y("```python\n```\n\nMARKER", "MARKER"),
        bbox_word_y("```python\n\n```\n\nMARKER", "MARKER"),
    ) {
        let delta = blank_y - empty_y;
        assert!((delta - row_pt).abs() < 0.3, "Single blank line must add 1.2em ({row_pt}pt) over empty fence, got {delta}pt");
    }
    if let (Some(lf_y), Some(crlf_y), Some(trailing_y)) = (
        bbox_word_y("```rust\nlet a = 1;\nlet b = 2;\n```\n\nMARKER", "MARKER"),
        bbox_word_y("```rust\r\nlet a = 1;\r\nlet b = 2;\r\n```\r\n\r\nMARKER", "MARKER"),
        bbox_word_y("```rust\nlet a = 1;\nlet b = 2;\n\n```\n\nMARKER", "MARKER"),
    ) {
        assert!((lf_y - crlf_y).abs() < 0.1, "LF and CRLF fences must produce identical height");
        assert!(((trailing_y - lf_y) - row_pt).abs() < 0.3, "Intentional trailing blank line must keep 1.2em height");
    }
    let spaced_md = "```python\nALPHA = 1\n\nBETA = 2\n\n\nGAMMA = 3\n```\n";
    if let (Some(alpha_y), Some(beta_y), Some(gamma_y)) = (
        bbox_word_y(spaced_md, "ALPHA"),
        bbox_word_y(spaced_md, "BETA"),
        bbox_word_y(spaced_md, "GAMMA"),
    ) {
        assert!(((beta_y - alpha_y) - 2.0 * row_pt).abs() < 0.3, "One blank line must advance 2 * 1.2em");
        assert!(((gamma_y - beta_y) - 3.0 * row_pt).abs() < 0.3, "Two blank lines must advance 3 * 1.2em");
    }
    let indent_md = "```python\nOUTER = 1\n    INNER = 2\n```\n";
    if let (Some(outer_x), Some(inner_x)) = (
        bbox_word_attr(indent_md, "OUTER", "xMin"),
        bbox_word_attr(indent_md, "INNER", "xMin"),
    ) {
        assert!(inner_x > outer_x + 12.0, "Leading spaces on synthesized raw lines must be preserved (outer {outer_x}pt, inner {inner_x}pt)");
    }
}
#[test]
fn untagged_and_wide_code_lines_fit_within_printable_width_without_scaling_normal_lines() {
    let untagged_md = "```\nfenced untagged\n```\n\n    indented line one\n    indented line two\n";
    let untagged_src = source(untagged_md, &PdfOptions::default(), &HashMap::new()).unwrap();
    assert!(untagged_src.contains("#smd-code(\"fenced untagged\", lang: none)"), "{untagged_src}");
    assert!(untagged_src.contains("#smd-code(\"indented line one\\nindented line two\", lang: none)"), "{untagged_src}");
    assert_eq!(
        untagged_src.lines().filter(|l| l.starts_with("#smd-code(") && l.ends_with(", lang: none)")).count(),
        2,
        "Untagged fenced and indented blocks must pass lang: none: {untagged_src}"
    );
    assert!(!untagged_src.contains("lang: \"\""));
    assert!(export(untagged_md, &PdfOptions::default(), &HashMap::new()).unwrap().starts_with(b"%PDF-"));

    // Normal-width code block must not emit non-identity horizontal/vertical scaling matrices in content stream,
    // while an over-wide line scales down to fit the printable width.
    let has_fractional_cm = |pdf: &[u8]| -> bool {
        decompress_pdf_streams(pdf).lines().any(|line| {
            let Some(before_cm) = line.split(" cm").next() else { return false };
            let parts: Vec<&str> = before_cm.split_whitespace().collect();
            if parts.len() < 6 { return false; }
            let Some(sx) = parts[parts.len() - 6].parse::<f64>().ok() else { return false };
            let Some(sy) = parts[parts.len() - 3].parse::<f64>().ok() else { return false };
            sx > 0.0 && sx < 0.99 && (sx - sy.abs()).abs() < 0.01
        })
    };
    let normal_pdf = export("```python\nnormal_value = 1\n```\n", &PdfOptions::default(), &HashMap::new()).unwrap();
    assert!(!has_fractional_cm(&normal_pdf), "Normal-width code lines must skip scale() in #smd-fit");

    let wide_line = format!("wide_value = '{}' # WIDE-TAIL", "W".repeat(160));
    let wide_md = format!("```python\nnormal_value = 1\n{wide_line}\nafter_wide = 2\n```\n");
    let wide_pdf = export(&wide_md, &PdfOptions::default(), &HashMap::new()).unwrap();
    assert!(wide_pdf.starts_with(b"%PDF-"));
    assert!(has_fractional_cm(&wide_pdf), "Over-wide code line must apply scale() in #smd-fit");

    let path = std::env::temp_dir().join(format!("supermd-wide-code-{}.pdf", std::process::id()));
    std::fs::write(&path, &wide_pdf).unwrap();
    if let Ok(output) = std::process::Command::new("pdftotext").arg(&path).arg("-").output() {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            assert!(text.contains("WIDE-TAIL"), "Wide line tail must remain present");
        }
    }
    if let Ok(output) = std::process::Command::new("pdftotext").arg("-bbox").arg(&path).arg("-").output() {
        if output.status.success() {
            let xml = String::from_utf8_lossy(&output.stdout);
            assert!(xml.contains("WIDE-TAIL"), "Wide line tail must remain present");
            let word_height = |needle: &str| -> f64 {
                let line = xml.lines().find(|l| l.contains("<word ") && l.contains(needle)).unwrap();
                let y_min: f64 = line.split("yMin=\"").nth(1).unwrap().split('"').next().unwrap().parse().unwrap();
                let y_max: f64 = line.split("yMax=\"").nth(1).unwrap().split('"').next().unwrap().parse().unwrap();
                y_max - y_min
            };
            let normal_h = word_height("normal_value");
            let after_h = word_height("after_wide");
            let wide_h = word_height("WIDE-TAIL");
            assert!((normal_h - after_h).abs() < 0.05, "Normal lines must share unscaled glyph height");
            assert!(wide_h < normal_h * 0.8, "Over-wide line must scale down (normal {normal_h}pt, wide {wide_h}pt)");
            let right_edge = (210. - PdfOptions::default().margin as f64) * 72. / 25.4;
            for word in xml.lines().filter(|line| line.contains("<word ")) {
                let x = word.split("xMax=\"").nth(1).unwrap().split('"').next().unwrap().parse::<f64>().unwrap();
                assert!(x <= right_edge + 0.5, "Wide code line escaped printable width: {word}");
            }
        }
    }
    let _ = std::fs::remove_file(path);
}
#[test]
fn table_column_alignments_are_preserved_in_typst_source_and_pdf() {
    let md = r"| Left | Center | Right | Unspecified |
| :--- | :----: | ----: | ----------- |
| L1   | C1     | R1    | U1          |
| L2   | C2     | R2    | U2          |";
    let src = source(md, &PdfOptions::default(), &HashMap::new()).unwrap();
    assert!(src.contains("align: (left,center,right,left,)"), "Table must preserve column alignments: {src}");

    let single_col_md = "| Single Center |\n| :---: |\n| Cell |";
    let single_src = source(single_col_md, &PdfOptions::default(), &HashMap::new()).unwrap();
    assert!(single_src.contains("align: (center,)"), "Single column table must have trailing comma in align tuple: {single_src}");

    let pdf_bytes = export(md, &PdfOptions::default(), &HashMap::new()).unwrap();
    assert!(pdf_bytes.starts_with(b"%PDF-"));
}
#[test]
fn normalizes_wikilinks_outside_code_and_exports_clean_pdf_labels() {
    let md = [
        "# Bayes Overview",
        "",
        "Follow [[Task Note]], [[Lecture 2#Bayes Law|Bayes]], [[study.smd]], [Deck](study.smd), and [[#Bayes Overview|Back to overview]].",
        "",
        "| Link | Code |",
        "| --- | --- |",
        "| [[Lecture 2#Bayes|Bayes cell]] | `[[Task Note]]` and `` `![[raw.png]]` `` |",
        "",
        "```python",
        "arr = [[1, 2], [3, 4]]",
        "note = '[[Literal]]'",
        "```",
        "",
    ].join("\n");
    let normalized = normalize_callouts(&md);
    assert!(normalized.contains("[Task Note](Task%20Note.md)"), "{normalized}");
    assert!(normalized.contains("[Bayes](Lecture%202.md#bayes-law)"), "{normalized}");
    assert!(normalized.contains("[study.smd](study.smd)"), "{normalized}");
    assert!(normalized.contains("[Back to overview](#bayes-overview)"), "{normalized}");
    assert!(normalized.contains("[Bayes cell](Lecture%202.md#bayes)"), "{normalized}");
    assert!(normalized.contains("`[[Task Note]]`"), "{normalized}");
    assert!(normalized.contains("`` `![[raw.png]]` ``"), "{normalized}");
    assert!(normalized.contains("arr = [[1, 2], [3, 4]]"), "{normalized}");
    assert!(normalized.contains("note = '[[Literal]]'"), "{normalized}");

    let typst = source(&md, &PdfOptions::default(), &HashMap::new()).unwrap();
    assert!(typst.contains("#text(\"Task Note\")"), "{typst}");
    assert!(typst.contains("#text(\"Bayes\")"), "{typst}");
    assert!(typst.contains("#text(\"Deck\")"), "{typst}");
    assert!(typst.contains("#link(label(\"smd-bayes-overview\"))[#text(\"Back to overview\")]"), "{typst}");
    assert!(!typst.contains("#text(\"[["), "No prose wikilink brackets in Typst output: {typst}");
    assert!(!typst.contains("\\["), "No escaped brackets in Typst output: {typst}");
    assert!(typst.contains("#raw(\"[[Task Note]]\")"), "{typst}");

    let pdf = export(&md, &PdfOptions::default(), &HashMap::new()).unwrap();
    assert!(pdf.starts_with(b"%PDF-"));
    assert!(pdf.len() > 2_000);
}
#[test]
fn frontmatter_omits_yaml_from_page_body_and_populates_pdf_properties() {
    let note = "\u{feff}---  \ntitle: \"Relativistic Quantum Theory\"\nauthor:\n  - Paul Dirac\n  - Emmy Noether\ndescription: \"Spinors, symmetries, and conservation laws\"\ntags: [spinors, symmetry]\ndate: 2026-03-15\n...  \n\n# Spinor Algebra\n\nBody text.\n";
    let typst_src = source(note, &PdfOptions::default(), &HashMap::new()).unwrap();
    assert!(!typst_src.contains("#line(length: 100%"), "YAML delimiter leaked as horizontal rule: {typst_src}");
    assert!(!typst_src.contains("#heading(level: 2"), "YAML block leaked as setext level-2 heading: {typst_src}");
    assert!(!typst_src.contains("#text(\"title:"), "raw YAML key leaked into rendered body: {typst_src}");
    assert_eq!(typst_src.matches("title:").count(), 1);
    assert!(typst_src.contains("#set document(title: \"Relativistic Quantum Theory\", author: (\"Paul Dirac\", \"Emmy Noether\",), description: \"Spinors, symmetries, and conservation laws\", keywords: (\"spinors\", \"symmetry\",), date: datetime(year: 2026, month: 3, day: 15))"));

    let pdf_bytes = export(note, &PdfOptions::default(), &HashMap::new()).unwrap();
    assert!(pdf_bytes.starts_with(b"%PDF-"));
    let corpus = format!("{}\n{}", String::from_utf8_lossy(&pdf_bytes), decompress_pdf_streams(&pdf_bytes));
    assert!(corpus.contains("Relativistic Quantum Theory"), "PDF metadata missing title");
    assert!(corpus.contains("Paul Dirac"), "PDF metadata missing first author");
    assert!(corpus.contains("Emmy Noether"), "PDF metadata missing second author");
    assert!(corpus.contains("Spinors, symmetries, and conservation laws"), "PDF metadata missing description");
    assert!(corpus.contains("spinors"), "PDF metadata missing keyword");
    assert!(corpus.contains("2026-03-15") || corpus.contains("D:20260315"), "PDF metadata missing date");

    // Malformed or unclosed YAML and freeform dates still export valid PDFs safely.
    for fallback in [
        "---\ntitle: Unclosed frontmatter\n\n# Still Exports\n",
        "---\ntitle: Freeform Date\ndate: Spring 2026\n---\n\n# Valid PDF\n",
        "---\n---\n\n# Empty Frontmatter\n",
    ] {
        let bytes = export(fallback, &PdfOptions::default(), &HashMap::new()).unwrap();
        assert!(bytes.starts_with(b"%PDF-"));
    }
}
#[test]
fn study_markdown_and_safe_html_typeset_and_preserve_code_math_and_security() {
    let md = r#"<!-- SECRET_BLOCK_COMMENT
spanning lines -->
%%SECRET_OBSIDIAN_HEADER
![ignored](missing-comment-image.png)%%

# Study Notes H~2~O

==Highlighted concept== with H~2~O, x^2^, ~~deprecated~~, %%SECRET_INLINE_COMMENT%%<!-- SECRET_INLINE_HTML --> and Press <kbd onclick="evil()">Ctrl</kbd>+<kbd>S</kbd>, <mark style="color:red">marked</mark>, <u>underlined</u>, CO<sub>2</sub>, 10<sup>-6</sup>.<br>Second line.

\==Literal markup\=\= beside ==Active highlight==, \==Raw one==, \==Raw two==, \=\=Inline literal\=\=, \\==Slash highlight==, H\~2\~O and H\~2~O and \~lit\~ and \~rawsub~ beside ~sub~, x\^2\^ and x\^2^ and \^rawsup^ beside ^sup^, \%%KEPT_PERCENT\%%, and approx ~5 minutes to boil H~2~O.

Spaced ~not sub~ and ^not sup^, comparison if a == b and c == d, escaped \==rawlit==, URL [https://example.edu/~alice/notes~1](https://example.edu/~alice/notes~1), unmatched <mark>rawmark, and inline <script>alert(1)</script>.

<script>window.pwn = 1</script>

| Concept | Detail |
|---|---|
| ==Cell mark== | Top<br/>Bottom |

Inline code `H~2~O ==raw== ^2^ %%KEPT_INLINE_CODE%% <kbd>k</kbd>` and math $x^2 + y_1$:

$$
%% kept tex comment
\int_0^1 x^2 dx = \frac{1}{3}
$$

```python
%%timeit total = 1 + 1
```
"#;
    assert!(image_sources(md).is_empty(), "Images inside %%...%% comments must be ignored");

    let typst_src = source(md, &PdfOptions::default(), &HashMap::new()).unwrap();
    assert!(typst_src.contains("#sub[#text(\"2\")]"), "Expected Typst #sub: {typst_src}");
    assert!(typst_src.contains("#sub[#text(\"sub\")]"), "Expected ~sub~ -> #sub: {typst_src}");
    assert!(!typst_src.contains("#sub[#text(\"lit\")]"), "Escaped \\~lit\\~ must not become #sub: {typst_src}");
    assert!(!typst_src.contains("#sub[#text(\"rawsub\")]"), "Escaped \\~rawsub~ must not become #sub: {typst_src}");
    assert!(typst_src.contains("#super[#text(\"2\")]"), "Expected Typst #super: {typst_src}");
    assert!(typst_src.contains("#super[#text(\"sup\")]"), "Expected ^sup^ -> #super: {typst_src}");
    assert!(!typst_src.contains("#super[#text(\"rawsup\")]"), "Escaped \\^rawsup^ must not become #super: {typst_src}");
    assert!(typst_src.contains("#super[#text(\"-6\")]"), "Expected HTML <sup> -> #super: {typst_src}");
    assert!(typst_src.contains("#highlight(fill: smd-highlight, radius: 2pt, extent: 1pt)[#text(\"Active highlight\")]"), "Expected unescaped highlight: {typst_src}");
    assert!(typst_src.contains("#highlight(fill: smd-highlight, radius: 2pt, extent: 1pt)[#text(\"Slash highlight\")]"), "Expected highlight after escaped backslash: {typst_src}");
    assert!(!typst_src.contains("[#text(\"Literal markup\")]"), "Escaped \\=\\=Literal markup\\=\\= must stay literal: {typst_src}");
    assert!(!typst_src.contains("[#text(\"Raw one\")]") && !typst_src.contains(", =Raw two"), "Comma-separated \\==Raw one==, \\==Raw two== must not pair: {typst_src}");
    assert!(!typst_src.contains("[#text(\"rawlit\")]"), "Escaped \\==rawlit== must stay literal: {typst_src}");
    assert!(typst_src.contains("#underline[#text(\"underlined\")]"), "Expected Typst #underline: {typst_src}");
    assert!(typst_src.contains("#box(fill: smd-code-fill"), "Expected Typst #box for <kbd>: {typst_src}");
    assert!(typst_src.contains("#strike[#text(\"deprecated\")]"), "Expected Typst #strike for ~~...~~: {typst_src}");
    assert!(typst_src.contains("#linebreak()"), "Expected Typst #linebreak() for <br>: {typst_src}");
    assert!(typst_src.contains("#link(\"https://example.edu/~alice/notes~1\")[#text(\"https://example.edu/~alice/notes~1\")]"), "URL tildes must not become subscripts: {typst_src}");
    assert!(!typst_src.contains("SECRET_BLOCK_COMMENT"));
    assert!(!typst_src.contains("SECRET_OBSIDIAN_HEADER"));
    assert!(!typst_src.contains("SECRET_INLINE_COMMENT"));
    assert!(!typst_src.contains("SECRET_INLINE_HTML"));
    assert!(!typst_src.contains("onclick"));
    assert!(typst_src.contains("KEPT_PERCENT"));
    assert!(typst_src.contains("KEPT_INLINE_CODE"));
    assert!(typst_src.contains("%%timeit total = 1 + 1"));
    assert!(typst_src.contains("<script>"));

    for themed in [false, true] {
        let opts = PdfOptions { themed, theme_accent: "#2d6a4f".into(), ..PdfOptions::default() };
        let pdf_bytes = export(md, &opts, &HashMap::new()).unwrap();
        assert!(pdf_bytes.starts_with(b"%PDF-"));
        if !themed {
            let path = std::env::temp_dir().join(format!("supermd-study-markdown-{}.pdf", std::process::id()));
            std::fs::write(&path, &pdf_bytes).unwrap();
            if let Ok(output) = std::process::Command::new("pdftotext").arg(&path).arg("-").output() {
                if output.status.success() {
                    let extracted = String::from_utf8_lossy(&output.stdout);
                    let flat = extracted.split_whitespace().collect::<Vec<_>>().join(" ");
                    assert!(flat.contains("Highlighted concept"));
                    assert!(flat.contains("==Literal markup== beside Active highlight"), "Expected literal escaped == beside active highlight: {flat}");
                    assert!(flat.contains("\\Slash highlight"), "Expected escaped backslash before active highlight: {flat}");
                    assert!(flat.contains("H~2~O and H~2~O and ~lit~ and ~rawsub~ beside sub"), "Expected literal escaped tildes beside subscript: {flat}");
                    assert!(flat.contains("x^2^ and x^2^ and ^rawsup^ beside sup"), "Expected literal escaped carets beside superscript: {flat}");
                    assert!(flat.contains("%%KEPT_PERCENT%%"), "Expected escaped percent comment preserved: {flat}");
                    assert!(flat.contains("underlined"));
                    assert!(flat.contains("Ctrl"));
                    assert!(flat.contains("~not sub~"));
                    assert!(flat.contains("^not sup^"));
                    assert!(flat.contains("<script>alert(1)</script>"));
                    assert!(!flat.contains("SECRET_BLOCK_COMMENT"));
                    assert!(!flat.contains("SECRET_OBSIDIAN_HEADER"));
                    assert!(!flat.contains("SECRET_INLINE_COMMENT"));
                    assert!(!flat.contains("SECRET_INLINE_HTML"));
                }
            }
            let _ = std::fs::remove_file(path);
        }
    }
}
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
}

#[test]
fn equation_references_and_pdf_labels_coexist_with_percent_comments_and_callouts() {
    let md = concat!(
        "Forward \\eqref{eq:energy} and [Mass-energy](#eq:energy).\n\n",
        "%%\n$$\nE = 0 \\tag{0.0}\\label{eq:energy}\n$$\n%%\n\n",
        "$$\nE = mc^2 \\tag{2.1}\\label{eq:energy}\\label{eq:einstein}\n$$\n\n",
        "> [!note] Relativity\n",
        "> Alias \\ref{eq:einstein} and inline $K = \\eqref{eq:energy}$.\n",
    );
    let typst = source(md, &PdfOptions::default(), &HashMap::new()).unwrap();
    assert!(typst.contains("<smd-eq-eq_3a_energy>") && typst.contains("#metadata(none) <smd-eq-eq_3a_einstein>"), "{typst}");
    assert!(typst.contains("#link(label(\"smd-eq-eq_3a_energy\"))[#text(\"(2.1)\")]") && !typst.contains("(0.0)"), "{typst}");
    let pdf = export(md, &PdfOptions::default(), &HashMap::new()).unwrap();
    let raw_pdf = String::from_utf8_lossy(&pdf);
    assert!(raw_pdf.contains("/Subtype /Link") || raw_pdf.contains("/Subtype/Link"));
    let path = std::env::temp_dir().join(format!("supermd-eq-merge-{}.pdf", std::process::id()));
    std::fs::write(&path, &pdf).unwrap();
    if let Ok(out) = std::process::Command::new("pdftotext").arg("-layout").arg(&path).arg("-").output() {
        if out.status.success() {
            let flat = String::from_utf8_lossy(&out.stdout).split_whitespace().collect::<Vec<_>>().join(" ");
            assert!(flat.contains("Forward (2.1) and Mass-energy.") && flat.contains("Alias 2.1") && !flat.contains("0.0"), "{flat}");
        }
    }
    let _ = std::fs::remove_file(path);
}

