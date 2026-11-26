use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use smd_core::{source,export,PdfOptions};

fn count_pdf_pages(pdf: &[u8]) -> usize {
    let mut count = 0;
    for needle in [b"/Type /Page".as_slice(), b"/Type/Page".as_slice()] {
        let mut pos = 0;
        while let Some(rel) = pdf[pos..].windows(needle.len()).position(|w| w == needle) {
            let after = pos + rel + needle.len();
            if !pdf.get(after).is_some_and(|b| b.is_ascii_alphanumeric()) {
                count += 1;
            }
            pos = after;
        }
    }
    count
}

fn decompress_pdf_streams(pdf: &[u8]) -> Vec<String> {
    let mut streams = Vec::new();
    let mut pos = 0;
    while let Some(rel) = pdf[pos..].windows(6).position(|w| w == b"stream") {
        let mut data_start = pos + rel + 6;
        if pdf.get(data_start) == Some(&b'\r') {
            data_start += 1;
        }
        if pdf.get(data_start) != Some(&b'\n') {
            pos = data_start;
            continue;
        }
        data_start += 1;
        let Some(end_rel) = pdf[data_start..].windows(9).position(|w| w == b"endstream") else {
            break;
        };
        let mut data_end = data_start + end_rel;
        if data_end > data_start && pdf[data_end - 1] == b'\n' {
            data_end -= 1;
        }
        if data_end > data_start && pdf[data_end - 1] == b'\r' {
            data_end -= 1;
        }
        let mut decoded = Vec::new();
        if flate2::read::ZlibDecoder::new(&pdf[data_start..data_end]).read_to_end(&mut decoded).is_ok() {
            streams.push(String::from_utf8_lossy(&decoded).into_owned());
        }
        pos = data_start + end_rel + 9;
    }
    streams
}

fn read_ppm_pages(ppm_dir: &std::path::Path) -> BTreeMap<usize, Vec<u8>> {
    let mut pages = BTreeMap::new();
    if let Ok(entries) = std::fs::read_dir(ppm_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            // Poppler writes page-1.ppm / page-01.ppm; Xpdf on Windows writes page-000001.ppm.
            if let Some(stem) = name.strip_prefix("page-").and_then(|s| s.strip_suffix(".ppm")) {
                if let Ok(num) = stem.parse::<usize>() {
                    if let Ok(bytes) = std::fs::read(entry.path()) {
                        pages.insert(num, bytes);
                    }
                }
            }
        }
    }
    pages
}

fn require_poppler() -> bool {
    cfg!(target_os = "linux") && std::env::var_os("SUPERMD_TEST_NON_POPPLER").is_none()
}

fn parse_p6_ppm(ppm: &[u8]) -> Option<(usize, usize, &[u8])> {
    if !ppm.starts_with(b"P6") {
        return None;
    }
    let mut i = 2usize;
    let mut tokens: Vec<usize> = Vec::with_capacity(3);
    while tokens.len() < 3 && i < ppm.len() {
        while i < ppm.len() {
            if ppm[i] == b'#' {
                while i < ppm.len() && ppm[i] != b'\n' {
                    i += 1;
                }
            } else if ppm[i].is_ascii_whitespace() {
                i += 1;
            } else {
                break;
            }
        }
        let start = i;
        while i < ppm.len() && ppm[i].is_ascii_digit() {
            i += 1;
        }
        if start == i {
            return None;
        }
        tokens.push(std::str::from_utf8(&ppm[start..i]).ok()?.parse().ok()?);
    }
    if tokens.len() != 3 {
        return None;
    }
    let (w, h, maxval) = (tokens[0], tokens[1], tokens[2]);
    if maxval != 255 || w == 0 || h == 0 {
        return None;
    }
    let pixel_bytes = w.checked_mul(h)?.checked_mul(3)?;
    if i >= ppm.len() || !ppm[i].is_ascii_whitespace() {
        return None;
    }
    let header_end = if ppm[i] == b'\r' && ppm.get(i + 1) == Some(&b'\n') && ppm.len() == i + 2 + pixel_bytes {
        i + 2
    } else {
        i + 1
    };
    (ppm.len() >= header_end + pixel_bytes).then(|| (w, h, &ppm[header_end..header_end + pixel_bytes]))
}

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
        std::fs::write(temp.join("__font_UPPER.OTF"),b"otf-font").unwrap();
        std::fs::write(temp.join("__font_Mixed.Ttf"),b"ttf-font").unwrap();
        let ignored=std::fs::File::create(temp.join("unrelated.bin")).unwrap();ignored.set_len(500_000_000).unwrap();
        let assets=smd_core::pdf_assets::load_referenced_assets("![used](used.svg)",&temp).unwrap();
        assert_eq!(assets.len(),4);assert_eq!(assets["used.svg"],b"<svg/>");assert_eq!(assets["__font_custom.ttf"],b"font");
        assert_eq!(assets["__font_UPPER.OTF"],b"otf-font");assert_eq!(assets["__font_Mixed.Ttf"],b"ttf-font");
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
    assert_eq!(generated.matches("#smd-image(bytes(").count(), 3, "{generated}");
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
    assert!(generated.contains("show raw.where(block: true):"), "{generated}");
    assert_eq!(generated.matches("\n#smd-code(").count(), 1, "Fenced code must emit one #smd-code() call: {generated}");
    assert!(generated.contains(", lang: \"python\")"), "{generated}");

    let pdf = export(&markdown, &PdfOptions::default(), &HashMap::new()).unwrap();
    assert_eq!(count_pdf_pages(&pdf), 1);
    let streams = decompress_pdf_streams(&pdf).join("\n");
    assert!(
        streams.matches("0.45490196 0.45490196 0.4862745 scn").count() >= 4,
        "Expected comment slate highlight across all docstring lines: {streams}"
    );
    assert!(
        streams.matches("0.09803922 0.53333336 0.0627451 scn").count() >= 4,
        "Expected string green highlight across all multiline string lines: {streams}"
    );

    let path = std::env::temp_dir().join(format!("supermd-multiline-code-{}.pdf", std::process::id()));
    std::fs::write(&path, &pdf).unwrap();
    if let Ok(out) = std::process::Command::new("pdftotext").arg(&path).arg("-").output() {
        if require_poppler() {
            assert!(out.status.success());
        }
        if out.status.success() {
            let plain = String::from_utf8_lossy(&out.stdout);
            for token in ["compute", "FIRST_DOC_LINE", "MIDDLE_DOC_LINE", "LAST_DOC_LINE", "MIDDLE_STR_LINE", "plain_identifier"] {
                assert!(plain.contains(token), "Missing token {token} in PDF text");
            }
        }
    }
    let ppm_dir = std::env::temp_dir().join(format!("supermd-multiline-ppm-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&ppm_dir);
    std::fs::create_dir_all(&ppm_dir).unwrap();
    let ppm_prefix = ppm_dir.join("page");
    let bbox_res = std::process::Command::new("pdftotext").arg("-bbox").arg(&path).arg("-").output();
    let ppm_res = std::process::Command::new("pdftoppm")
        .args(["-r", "144", &path.to_string_lossy(), &ppm_prefix.to_string_lossy()])
        .output();
    if require_poppler() {
        assert!(bbox_res.as_ref().is_ok_and(|o| o.status.success()), "Poppler pdftotext -bbox must succeed on Linux CI");
        assert!(ppm_res.as_ref().is_ok_and(|o| o.status.success()), "Poppler pdftoppm must succeed on Linux CI");
    }
    if let Ok(bbox_out) = bbox_res {
        if bbox_out.status.success() {
            let xml = String::from_utf8_lossy(&bbox_out.stdout);
            if xml.contains("<word ") {
                let x_of = |needle: &str| -> f64 {
                    let line = xml.lines().find(|l| l.contains("<word ") && l.contains(needle)).unwrap();
                    line.split("xMin=\"").nth(1).unwrap().split('"').next().unwrap().parse().unwrap()
                };
                assert!(x_of("MIDDLE_DOC_LINE") > x_of("def") + 8.0, "Leading indentation must be preserved");
                if ppm_res.is_ok_and(|o| o.status.success()) {
                    let pages = read_ppm_pages(&ppm_dir);
                    if require_poppler() {
                        assert!(pages.contains_key(&1), "Expected rendered PPM page 1");
                    }
                    if let Some((img_w, _img_h, pixels)) = pages.get(&1).and_then(|raw| parse_p6_ppm(raw)) {
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
                    }
                }
            }
        }
    }
    let _ = std::fs::remove_dir_all(&ppm_dir);
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
    assert_eq!(count_pdf_pages(&pdf), 2);
    let stream_clip_widths: Vec<Vec<f64>> = decompress_pdf_streams(&pdf)
        .into_iter()
        .filter(|s| s.contains("0 0.65882355 0.34901962 scn"))
        .map(|s| {
            s.lines()
                .filter_map(|line| {
                    let rest = line.strip_prefix("q ")?;
                    let nums: Vec<f64> = rest
                        .split_whitespace()
                        .filter_map(|tok| tok.parse::<f64>().ok())
                        .collect();
                    (line.ends_with(" l") && nums.len() == 8 && (nums[1] - nums[3]).abs() < 1e-3)
                        .then_some((nums[2] - nums[0]).abs())
                })
                .collect()
        })
        .collect();
    assert_eq!(stream_clip_widths.len(), 2, "Expected 2 page streams with green SVG figures: {stream_clip_widths:?}");
    assert_eq!(stream_clip_widths[0].len(), 6, "Expected 6 sized bars on page 1: {:?}", stream_clip_widths[0]);
    for (actual, expected) in stream_clip_widths[0].iter().zip([90.0f64, 120.0, 150.0, 200.0, 257.95, 515.91]) {
        assert!((actual - expected).abs() <= 1.5, "Expected ~{expected}pt PDF clip width, got {actual}pt");
    }
    assert_eq!(stream_clip_widths[1].len(), 1, "Expected 1 portrait bar on page 2: {:?}", stream_clip_widths[1]);
    assert!((stream_clip_widths[1][0] - 120.47).abs() <= 1.5, "Expected ~120.5pt portrait clip width, got {}pt", stream_clip_widths[1][0]);

    let path = std::env::temp_dir().join(format!("supermd-image-widths-{}.pdf", std::process::id()));
    let ppm_dir = std::env::temp_dir().join(format!("supermd-image-widths-ppm-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&ppm_dir);
    std::fs::create_dir_all(&ppm_dir).unwrap();
    let ppm_prefix = ppm_dir.join("page");
    std::fs::write(&path, &pdf).unwrap();
    let ppm_res = std::process::Command::new("pdftoppm")
        .args(["-r", "72", &path.to_string_lossy(), &ppm_prefix.to_string_lossy()])
        .output();
    if require_poppler() {
        assert!(ppm_res.as_ref().is_ok_and(|o| o.status.success()), "Poppler pdftoppm must succeed on Linux CI");
    }
    if let Ok(out) = ppm_res {
        if out.status.success() {
            let pages = read_ppm_pages(&ppm_dir);
            if require_poppler() {
                assert_eq!(pages.len(), 2, "Expected 2 rendered PPM pages");
            }
            if let (Some(ppm1), Some(ppm2)) = (pages.get(&1), pages.get(&2)) {
                let band_widths = |ppm: &[u8]| -> Vec<usize> {
                    let (w, h, pixels) = parse_p6_ppm(ppm).expect("Valid binary P6 PPM");
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
                let page1 = band_widths(ppm1);
                assert_eq!(page1.len(), 6, "Expected 6 green bars on page 1, got {page1:?}");
                for (actual, expected) in page1.into_iter().zip([90usize, 120, 150, 200, 258, 516]) {
                    assert!(actual.abs_diff(expected) <= 3, "Expected ~{expected}pt width, got {actual}pt");
                }
                // Unsized 40x160 portrait keeps 170mm * (40/160) = 42.5mm (~120.5pt), never full 516pt width.
                let page2 = band_widths(ppm2);
                assert_eq!(page2.len(), 1, "Expected 1 portrait bar on page 2, got {page2:?}");
                assert!(page2[0].abs_diff(120) <= 3, "Expected ~120pt portrait width, got {}pt", page2[0]);
            }
        }
    }
    let _ = std::fs::remove_dir_all(&ppm_dir);
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
    assert_eq!(count_pdf_pages(&pdf), 5, "Expected 5 PDF page objects");
    let path = std::env::temp_dir().join(format!("supermd-pagebreaks-{}.pdf", std::process::id()));
    std::fs::write(&path, &pdf).unwrap();
    if let Ok(out) = std::process::Command::new("pdftotext").arg(&path).arg("-").output() {
        if require_poppler() {
            assert!(out.status.success());
        }
        if out.status.success() {
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
    }
    let _ = std::fs::remove_file(&path);
}

#[test]
fn html_images_with_angle_brackets_in_quoted_attributes_preserve_assets_and_widths() {
    let plot_svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="400pt" height="40pt"><rect width="400pt" height="40pt" fill="#00a859"/></svg>"##.to_vec();
    let headless_md = [
        r#"<img alt="A > B" src="assets/plot.svg" width="300">"#,
        "",
        r#"<div data-note="x > y & <img src='ignored.svg'>"><img title='Bound: x > 0 & "ok"' alt="src=wrong.svg width=999 > real" src="assets/wrapped.svg" width="200px" /></div>"#,
        "",
        r#"Inline <img alt="Left > Right" title="Top > Bottom" src="assets/inline.svg" style="width: 160px; zoom: 50%"> end."#,
    ].join("\n");

    let discovered = smd_core::image_sources(&headless_md);
    assert_eq!(
        discovered,
        vec![
            "assets/plot.svg".to_string(),
            "assets/wrapped.svg".to_string(),
            "assets/inline.svg".to_string(),
        ]
    );

    let headless_assets = HashMap::from([
        ("assets/plot.svg".to_string(), plot_svg.clone()),
        ("assets/wrapped.svg".to_string(), plot_svg.clone()),
        ("assets/inline.svg".to_string(), plot_svg.clone()),
    ]);
    let headless_typst = source(&headless_md, &PdfOptions::default(), &headless_assets).unwrap();
    assert!(headless_typst.contains("#smd-image(\"assets/plot.svg\", width: 225pt)"), "{headless_typst}");
    assert!(headless_typst.contains("#smd-image(\"assets/wrapped.svg\", width: 150pt)"), "{headless_typst}");
    assert!(headless_typst.contains("#smd-image(\"assets/inline.svg\", width: 120pt, zoom: 50%)"), "{headless_typst}");

    // Match GUI preparePdf output after lifting quoted-attribute HTML <img> tags.
    let gui_prepared_md = [
        r#"![A > B](asset-1.svg){width=300}"#,
        "",
        r#"![src=wrong.svg width=999 > real](asset-2.svg "Bound: x > 0 & \"ok\""){width=200px}"#,
        "",
        r#"Inline ![Left > Right](asset-3.svg "Top > Bottom"){width=160px zoom=50%} end."#,
    ].join("\n");
    let gui_assets = HashMap::from([
        ("asset-1.svg".to_string(), plot_svg.clone()),
        ("asset-2.svg".to_string(), plot_svg.clone()),
        ("asset-3.svg".to_string(), plot_svg),
    ]);
    let gui_typst = source(&gui_prepared_md, &PdfOptions::default(), &gui_assets).unwrap();
    assert!(gui_typst.contains("#smd-image(\"asset-1.svg\", width: 225pt)"), "{gui_typst}");
    assert!(gui_typst.contains("#smd-image(\"asset-2.svg\", width: 150pt)"), "{gui_typst}");
    assert!(gui_typst.contains("#smd-image(\"asset-3.svg\", width: 120pt, zoom: 50%)"), "{gui_typst}");

    for (label, pdf) in [
        ("headless", export(&headless_md, &PdfOptions::default(), &headless_assets).unwrap()),
        ("gui", export(&gui_prepared_md, &PdfOptions::default(), &gui_assets).unwrap()),
    ] {
        let clips: Vec<f64> = decompress_pdf_streams(&pdf)
            .into_iter()
            .filter(|s| s.contains("0 0.65882355 0.34901962 scn"))
            .flat_map(|s| {
                s.lines()
                    .filter_map(|line| {
                        let rest = line.strip_prefix("q ")?;
                        let nums: Vec<f64> = rest.split_whitespace().filter_map(|tok| tok.parse::<f64>().ok()).collect();
                        (line.ends_with(" l") && nums.len() == 8 && (nums[1] - nums[3]).abs() < 1e-3)
                            .then_some((nums[2] - nums[0]).abs())
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        assert_eq!(clips.len(), 3, "{label}: expected 3 rendered figures, got {clips:?}");
        for (actual, expected) in clips.iter().zip([225.0f64, 150.0, 60.0]) {
            assert!((actual - expected).abs() <= 1.5, "{label}: expected ~{expected}pt clip width, got {actual}pt");
        }
    }
}
