use std::collections::HashMap;
use smd_core::{source,export,PdfOptions};

#[test]
fn nested_callouts_and_literal_code_delimiters_match_the_reader_contract() {
    let markdown=":::callout note Outer\nOuter body\n\n:::callout tip Inner\nInner body\n:::\n\nAfter inner\n\n````text\n:::callout warning Not a callout\n:::\n```\n````\n:::\n\n# After\n";
    let normalized=smd_core::normalize_callouts(markdown);
    assert!(normalized.contains("> > [!tip] Inner\n> > Inner body\n>\n"));
    assert!(normalized.contains("> After inner"));
    assert!(normalized.contains("> :::callout warning Not a callout\n> :::"));
    assert!(normalized.ends_with("\n# After\n"));
    assert!(export(markdown,&PdfOptions::default(),&HashMap::new()).unwrap().starts_with(b"%PDF-"));
}

#[test]
fn explicit_table_alignments_survive_the_real_pdf_typesetter() {
    for (markdown, alignment) in [
        ("| A | B | C | D |\n| :--- | :---: | ---: | --- |\n| left | middle | 123 | default |", "align: (left,center,right,left,)"),
        ("| A |\n| ---: |\n| 123 |", "align: (right,)"),
    ] {
        let assets=HashMap::new();
        let generated=source(markdown,&PdfOptions::default(),&assets).unwrap();
        assert!(generated.contains(alignment),"{generated}");
        let bytes=export(markdown,&PdfOptions::default(),&assets).unwrap();
        assert!(bytes.starts_with(b"%PDF-"));
    }
}

#[test]
fn headings_and_lists_keep_breathing_room_in_typeset_output() {
    let markdown="# Topic\n\nShort intro.\n\n- First item\n- Second item\n\n## Detail\n\nAnother paragraph.";
    let generated=source(markdown,&PdfOptions::default(),&HashMap::new()).unwrap();
    assert!(generated.contains("#show heading: set block(above: 1.6em, below: .85em)"));
    assert!(generated.contains("#set list(spacing: .42em, indent: 1.25em, body-indent: .38em)"));
    assert!(generated.contains("#set enum(spacing: .42em, indent: 1.25em, body-indent: .38em)"));
    assert!(export(markdown,&PdfOptions::default(),&HashMap::new()).unwrap().starts_with(b"%PDF-"));
}

#[test]
fn staged_pdf_assets_include_only_referenced_images_and_custom_fonts() {
    let temp=std::env::temp_dir().join(format!("supermd-pdf-assets-{}",std::process::id()));
    std::fs::create_dir(&temp).unwrap();
    let result=(|| {
        std::fs::write(temp.join("used.svg"),b"<svg/>").unwrap();
        std::fs::write(temp.join("__font_custom.ttf"),b"font").unwrap();
        let ignored=std::fs::File::create(temp.join("unrelated.bin")).unwrap();ignored.set_len(500_000_000).unwrap();
        let assets=smd_core::pdf_assets::load_referenced_assets("![used](used.svg)",&temp).unwrap();
        assert_eq!(assets.len(),2);assert_eq!(assets["used.svg"],b"<svg/>");assert_eq!(assets["__font_custom.ttf"],b"font");
        let oversized=std::fs::File::create(temp.join("too-big.png")).unwrap();oversized.set_len(smd_core::portable::MAX_IMAGE as u64+1).unwrap();
        assert!(smd_core::pdf_assets::load_referenced_assets("![bad](too-big.png)",&temp).is_err());
    })();
    std::fs::remove_dir_all(&temp).unwrap();
    result
}

#[test]
fn standalone_tree_diagram_and_svg_blocks_export_as_vectors_and_reject_unsafe_markup() {
    let markdown = [
        "# Vector Diagrams",
        "",
        "```smd-tree",
        r#"{"title":"Heap","values":["50","30","40","10","20","35"],"highlight":[5]}"#,
        "```",
        "",
        "```smd-diagram",
        r#"{"title":"Pipeline","width":320,"height":140,"nodes":[{"id":"a","label":"PARSE","x":80,"y":70,"state":"visited"},{"id":"b","label":"TYPESET","x":240,"y":70,"shape":"box","state":"active"}],"edges":[{"from":"a","to":"b","dashed":true}]}"#,
        "```",
        "",
        "```svg",
        r##"<svg viewBox="0 0 180 60"><rect x="4" y="4" width="172" height="52" fill="#e8f3ee" stroke="#386a57"/><text x="90" y="35" text-anchor="middle" font-family="Manrope, sans-serif" font-size="16">VECTOR-BADGE</text></svg>"##,
        "```",
    ].join("\n");
    let generated = source(&markdown, &PdfOptions::default(), &HashMap::new()).unwrap();
    assert_eq!(generated.matches("image(bytes(").count(), 3, "{generated}");
    assert_eq!(generated.matches("format: \"svg\"").count(), 3, "{generated}");
    assert!(!generated.contains("\"values\""));
    let pdf = export(&markdown, &PdfOptions::default(), &HashMap::new()).unwrap();
    assert!(pdf.starts_with(b"%PDF-"));
    assert!(!String::from_utf8_lossy(&pdf).contains("/Subtype /Image"), "Vector diagrams must never rasterize");
    assert!(!String::from_utf8_lossy(&pdf).contains("/Subtype/Image"), "Vector diagrams must never rasterize");

    for invalid in [
        "```smd-tree\n{\"values\":[null]}\n```",
        "```smd-diagram\n{\"nodes\":[]}\n```",
        "```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>\n```",
        "```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"alert(1)\"><rect width=\"10\" height=\"10\"/></svg>\n```",
        "```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\"><foreignObject><div>html</div></foreignObject></svg>\n```",
        "```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\"><image href=\"https://evil.invalid/a.png\"/></svg>\n```",
        "```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\"><style>@import url(https://evil.invalid/a.css);</style></svg>\n```",
    ] {
        assert!(source(invalid, &PdfOptions::default(), &HashMap::new()).is_err(), "Should reject: {invalid}");
    }
}

#[test]
fn multiline_python_docstrings_render_as_one_raw_block_and_keep_syntax_colors() {
    let markdown = [
        "```python",
        "def compute(x):",
        "    \"\"\"FIRST_DOC_LINE",
        "    MIDDLE_DOC_LINE",
        "    LAST_DOC_LINE\"\"\"",
        "    msg = \"\"\"FIRST_STR_LINE",
        "    MIDDLE_STR_LINE",
        "    LAST_STR_LINE\"\"\"",
        "    plain_identifier = x + 1",
        "    return plain_identifier",
        "```",
    ].join("\n");
    let generated = source(&markdown, &PdfOptions::default(), &HashMap::new()).unwrap();
    assert!(generated.contains("show raw.line:"), "{generated}");
    assert_eq!(generated.matches("raw(").count(), 1, "Fenced code must emit one block raw() call: {generated}");
    assert!(generated.contains("block: true, lang: \"python\""), "{generated}");

    let pdf = export(&markdown, &PdfOptions::default(), &HashMap::new()).unwrap();
    let path = std::env::temp_dir().join(format!("supermd-multiline-code-{}.pdf", std::process::id()));
    std::fs::write(&path, &pdf).unwrap();
    if let Ok(out) = std::process::Command::new("pdftotext").arg("-bbox").arg(&path).arg("-").output() {
        assert!(out.status.success());
        let xml = String::from_utf8_lossy(&out.stdout);
        for token in ["compute", "FIRST_DOC_LINE", "MIDDLE_DOC_LINE", "LAST_DOC_LINE", "MIDDLE_STR_LINE", "plain_identifier"] {
            assert!(xml.contains(token), "Missing token {token} in PDF text");
        }
        let x_of = |needle: &str| -> f64 {
            let line = xml.lines().find(|l| l.contains("<word ") && l.contains(needle)).unwrap();
            line.split("xMin=\"").nth(1).unwrap().split('"').next().unwrap().parse().unwrap()
        };
        assert!(x_of("MIDDLE_DOC_LINE") > x_of("def") + 8.0, "Leading indentation must be preserved");
    }
    let ppm_prefix = std::env::temp_dir().join(format!("supermd-multiline-ppm-{}", std::process::id()));
    if let (Ok(bbox_out), Ok(ppm_out)) = (
        std::process::Command::new("pdftotext").arg("-bbox").arg(&path).arg("-").output(),
        std::process::Command::new("pdftoppm")
            .args(["-r", "144", &path.to_string_lossy(), &ppm_prefix.to_string_lossy()])
            .output(),
    ) {
        if bbox_out.status.success() && ppm_out.status.success() {
            let xml = String::from_utf8_lossy(&bbox_out.stdout);
            let ppm_path = format!("{}-1.ppm", ppm_prefix.display());
            if let Ok(ppm) = std::fs::read(&ppm_path) {
                let header_end = ppm.windows(4).position(|w| w == b"255\n").map(|p| p + 4).unwrap_or(0);
                let header = String::from_utf8_lossy(&ppm[..header_end]);
                let dims: Vec<usize> = header.split_whitespace().skip(1).take(2).map(|s| s.parse().unwrap()).collect();
                let img_w = dims[0];
                let pixels = &ppm[header_end..];
                let darkest_glyph_rgb = |needle: &str| -> [u8; 3] {
                    let word = xml.lines().find(|l| l.contains("<word ") && l.contains(needle)).unwrap();
                    let attr = |name: &str| -> f64 {
                        word.split(&format!("{name}=\"")).nth(1).unwrap().split('"').next().unwrap().parse().unwrap()
                    };
                    let x0 = (attr("xMin") * 2.0).floor() as usize;
                    let x1 = (attr("xMax") * 2.0).ceil() as usize;
                    let y0 = (attr("yMin") * 2.0).floor() as usize;
                    let y1 = (attr("yMax") * 2.0).ceil() as usize;
                    let mut best = [255u8, 255, 255];
                    for y in y0..y1 {
                        for x in x0..x1 {
                            let i = (y * img_w + x) * 3;
                            let rgb = [pixels[i], pixels[i + 1], pixels[i + 2]];
                            if (rgb[0] as u16 + rgb[1] as u16 + rgb[2] as u16)
                                < (best[0] as u16 + best[1] as u16 + best[2] as u16)
                            {
                                best = rgb;
                            }
                        }
                    }
                    best
                };
                let doc1 = darkest_glyph_rgb("FIRST_DOC_LINE");
                let doc2 = darkest_glyph_rgb("MIDDLE_DOC_LINE");
                let str1 = darkest_glyph_rgb("FIRST_STR_LINE");
                let str2 = darkest_glyph_rgb("MIDDLE_STR_LINE");
                let ident = darkest_glyph_rgb("plain_identifier");
                // Middle docstring line matches first docstring line (comment slate) and is lighter than #202020 identifier ink.
                assert!(doc1[0].abs_diff(doc2[0]) <= 6 && doc2[0] > ident[0] + 50, "Docstring continuation lost highlight color: doc1={doc1:?} doc2={doc2:?} ident={ident:?}");
                // Middle multiline string line matches first string line (green) rather than #202020 identifier ink.
                assert!(str1[1].abs_diff(str2[1]) <= 6 && str2[1] > str2[0] + 60, "Multiline string continuation lost green highlight color: str1={str1:?} str2={str2:?}");
                let _ = std::fs::remove_file(&ppm_path);
            }
        }
    }
    let _ = std::fs::remove_file(&path);
}

#[test]
fn explicit_image_widths_and_zoom_scale_and_clamp_without_changing_unsized_portrait_bounds() {
    let wide_svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="400pt" height="40pt"><rect width="400pt" height="40pt" fill="#00a859"/></svg>"##.to_vec();
    let portrait_svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="40pt" height="160pt"><rect width="40pt" height="160pt" fill="#00a859"/></svg>"##.to_vec();
    let assets = HashMap::from([
        ("wide.svg".to_string(), wide_svg),
        ("portrait.svg".to_string(), portrait_svg),
    ]);
    let md = [
        "![[wide.svg|120]]",
        "",
        "<img src=\"wide.svg\" width=\"160px\" />",
        "",
        "![Quarto px](wide.svg){width=200}",
        "",
        "<img src=\"wide.svg\" style=\"zoom:50%\" />",
        "",
        "![Quarto pct](wide.svg){width=50%}",
        "",
        "![Clamped](wide.svg){width=2000}",
        "",
        "\\newpage",
        "",
        "![Portrait](portrait.svg)",
    ].join("\n");
    let sources = smd_core::image_sources(&md);
    assert!(sources.contains(&"wide.svg".to_string()));
    assert!(sources.contains(&"portrait.svg".to_string()));

    let generated = source(&md, &PdfOptions::default(), &assets).unwrap();
    assert!(generated.contains("#smd-image(\"wide.svg\", width: 90pt)"), "{generated}");
    assert!(generated.contains("#smd-image(\"wide.svg\", width: 120pt)"), "{generated}");
    assert!(generated.contains("#smd-image(\"wide.svg\", width: 150pt)"), "{generated}");
    assert!(generated.contains("#smd-image(\"wide.svg\", zoom: 50%)"), "{generated}");
    assert!(generated.contains("#smd-image(\"wide.svg\", width: 50%)"), "{generated}");
    assert!(generated.contains("#smd-image(\"wide.svg\", width: 1500pt)"), "{generated}");
    assert!(generated.contains("#smd-image(\"portrait.svg\")"), "{generated}");
    assert!(!generated.contains("{width="), "{generated}");

    let pdf = export(&md, &PdfOptions::default(), &assets).unwrap();
    let path = std::env::temp_dir().join(format!("supermd-image-widths-{}.pdf", std::process::id()));
    let ppm_prefix = std::env::temp_dir().join(format!("supermd-image-widths-ppm-{}", std::process::id()));
    std::fs::write(&path, &pdf).unwrap();
    if let Ok(out) = std::process::Command::new("pdftoppm")
        .args(["-r", "72", &path.to_string_lossy(), &ppm_prefix.to_string_lossy()])
        .output()
    {
        assert!(out.status.success());
        let band_widths = |page_num: usize| -> Vec<usize> {
            let ppm_path = format!("{}-{page_num}.ppm", ppm_prefix.display());
            let ppm = std::fs::read(&ppm_path).unwrap();
            let _ = std::fs::remove_file(&ppm_path);
            let header_end = ppm.windows(4).position(|w| w == b"255\n").unwrap() + 4;
            let header = String::from_utf8_lossy(&ppm[..header_end]);
            let dims: Vec<usize> = header.split_whitespace().skip(1).take(2).map(|s| s.parse().unwrap()).collect();
            let (w, h) = (dims[0], dims[1]);
            let pixels = &ppm[header_end..];
            let mut bands = Vec::new();
            let mut current_max = 0usize;
            for y in 0..h {
                let row = &pixels[y * w * 3 .. (y + 1) * w * 3];
                let green_cols: Vec<usize> = row
                    .chunks_exact(3)
                    .enumerate()
                    .filter(|(_, rgb)| rgb[1] > 120 && rgb[0] < 60)
                    .map(|(x, _)| x)
                    .collect();
                if let (Some(&first), Some(&last)) = (green_cols.first(), green_cols.last()) {
                    current_max = current_max.max(last - first + 1);
                } else if current_max > 0 {
                    bands.push(current_max);
                    current_max = 0;
                }
            }
            if current_max > 0 {
                bands.push(current_max);
            }
            bands
        };
        // At 72 DPI (1px == 1pt): 90pt, 120pt, 150pt, 200pt, ~258pt (50% of 182mm), ~516pt (clamped to 182mm).
        let page1 = band_widths(1);
        assert_eq!(page1.len(), 6, "Expected 6 green bars on page 1, got {page1:?}");
        for (actual, expected) in page1.into_iter().zip([90usize, 120, 150, 200, 258, 516]) {
            assert!(actual.abs_diff(expected) <= 3, "Expected ~{expected}pt width, got {actual}pt");
        }
        // Unsized 40x160 portrait keeps 170mm * (40/160) = 42.5mm (~120.5pt), never full 516pt width.
        let page2 = band_widths(2);
        assert_eq!(page2.len(), 1, "Expected 1 portrait bar on page 2, got {page2:?}");
        assert!(page2[0].abs_diff(120) <= 3, "Expected ~120pt portrait width, got {}pt", page2[0]);
    }
    let _ = std::fs::remove_file(&path);
}

#[test]
fn manual_page_breaks_split_pages_while_code_literals_stay_intact() {
    let md = [
        "PAGE_ONE_MARKER",
        "",
        "<div style=\"page-break-after: always;\"></div>",
        "",
        "PAGE_TWO_MARKER",
        "",
        "\\newpage",
        "",
        "PAGE_THREE_MARKER",
        "",
        "\\pagebreak",
        "",
        "PAGE_FOUR_MARKER",
        "",
        "{{< pagebreak >}}",
        "",
        "PAGE_FIVE_MARKER with inline `\\newpage` and `{{< pagebreak >}}`",
        "",
        "```tex",
        "\\newpage",
        "\\pagebreak",
        "{{< pagebreak >}}",
        "<div style=\"page-break-after:always\"></div>",
        "```",
    ].join("\n");
    let generated = source(&md, &PdfOptions::default(), &HashMap::new()).unwrap();
    assert_eq!(generated.matches("#pagebreak()").count(), 4, "{generated}");
    let pdf = export(&md, &PdfOptions::default(), &HashMap::new()).unwrap();
    let path = std::env::temp_dir().join(format!("supermd-pagebreaks-{}.pdf", std::process::id()));
    std::fs::write(&path, &pdf).unwrap();
    if let Ok(out) = std::process::Command::new("pdftotext").arg(&path).arg("-").output() {
        assert!(out.status.success());
        let text = String::from_utf8_lossy(&out.stdout);
        let pages: Vec<&str> = text.split('\u{000c}').filter(|p| !p.trim().is_empty()).collect();
        assert_eq!(pages.len(), 5, "Expected exactly 5 pages, got {}: {pages:?}", pages.len());
        assert!(pages[0].contains("PAGE_ONE_MARKER"));
        assert!(pages[1].contains("PAGE_TWO_MARKER"));
        assert!(pages[2].contains("PAGE_THREE_MARKER"));
        assert!(pages[3].contains("PAGE_FOUR_MARKER"));
        assert!(pages[4].contains("PAGE_FIVE_MARKER"));
        assert!(pages[4].contains("\\newpage"));
        assert!(pages[4].contains("{{< pagebreak >}}"));
    }
    let _ = std::fs::remove_file(&path);
}
