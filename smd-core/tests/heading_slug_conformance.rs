use serde::Deserialize;
use smd_core::{export, normalize_callouts, slug::heading_slug, source, PdfOptions};
use std::collections::HashMap;

#[derive(Deserialize)]
struct ConformanceSuite {
    version: u32,
    cases: Vec<ConformanceCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConformanceCase {
    id: String,
    input: String,
    document_slug: String,
    agent_slug: String,
}

#[test]
fn heading_slug_matches_shared_conformance_corpus() {
    let raw = include_str!("../../test-fixtures/heading-slug-conformance.json");
    let suite: ConformanceSuite = serde_json::from_str(raw).expect("valid conformance JSON");
    assert_eq!(suite.version, 1);
    assert!((24..=30).contains(&suite.cases.len()));
    assert!(
        suite.cases.iter().any(|c| c.document_slug != c.agent_slug),
        "fixture must preserve distinct documentSlug (NFKC) and agentSlug (NFKD) expectations"
    );
    for case in &suite.cases {
        assert!(!case.id.is_empty());
        assert_eq!(
            heading_slug(&case.input),
            case.document_slug,
            "case '{}' ({:?}) diverged",
            case.id,
            case.input
        );
    }
}

#[test]
fn typst_labels_links_and_wikilinks_resolve_normalized_headings() {
    let md = [
        "# Cafe\u{0301}",
        "",
        "## ℍ₂O & ℝ² Space",
        "",
        "## Press <kbd>Ctrl</kbd> + C",
        "",
        "Jump to [Café](#cafe%CC%81), [Math](#h2o--r2-space), [Shortcut](#Press%20%3Ckbd%3ECtrl%3C/kbd%3E%20+%20C), [[#Cafe\u{0301}|Accent]], [[#ℍ₂O & ℝ² Space|Space]], and [[#Press ＜kbd＞Ctrl＜/kbd＞ + C|Keyboard]].",
        "",
    ]
    .join("\n");

    let normalized = normalize_callouts(&md);
    assert!(normalized.contains("[Accent](#café)"), "{normalized}");
    assert!(normalized.contains("[Space](#h2o--r2-space)"), "{normalized}");
    assert!(
        normalized.contains("[Keyboard](#press-ctrl--c)"),
        "wikilink fragment must NFKC-normalize and strip tags: {normalized}"
    );

    let typst = source(&md, &PdfOptions::default(), &HashMap::new()).unwrap();
    assert!(typst.contains("<smd-café>"), "missing <smd-café> label: {typst}");
    assert!(typst.contains("<smd-h2o--r2-space>"), "missing <smd-h2o--r2-space> label: {typst}");
    assert!(typst.contains("<smd-press-ctrl--c>"), "missing <smd-press-ctrl--c> label: {typst}");
    assert!(typst.contains("#link(label(\"smd-café\"))[#text(\"Café\")]"), "{typst}");
    assert!(typst.contains("#link(label(\"smd-café\"))[#text(\"Accent\")]"), "{typst}");
    assert!(typst.contains("#link(label(\"smd-h2o--r2-space\"))[#text(\"Math\")]"), "{typst}");
    assert!(typst.contains("#link(label(\"smd-h2o--r2-space\"))[#text(\"Space\")]"), "{typst}");
    assert!(typst.contains("#link(label(\"smd-press-ctrl--c\"))[#text(\"Shortcut\")]"), "{typst}");
    assert!(typst.contains("#link(label(\"smd-press-ctrl--c\"))[#text(\"Keyboard\")]"), "{typst}");

    let pdf = export(&md, &PdfOptions::default(), &HashMap::new()).unwrap();
    assert!(pdf.starts_with(b"%PDF-"));
}

#[test]
fn unicode_whitespace_and_category_filtering_match_ecma262_semantics() {
    let js_ws: [u32; 25] = [
        0x0009, 0x000A, 0x000B, 0x000C, 0x000D, 0x0020, 0x00A0, 0x1680, 0x2000, 0x2001, 0x2002,
        0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F,
        0x205F, 0x3000, 0xFEFF,
    ];
    for cp in js_ws {
        let ch = char::from_u32(cp).unwrap();
        assert_eq!(heading_slug(&format!("a{ch}b")), "a-b", "U+{cp:04X} must map to '-'");
        assert_eq!(heading_slug(&format!("{ch}a{ch}")), "a", "U+{cp:04X} must trim");
    }
    assert_eq!(heading_slug("a\u{0085}b"), "ab", "NEL U+0085 is not JS \\s");
    for mark in ['\u{0300}', '\u{0363}', '\u{05B8}', '\u{093E}', '\u{20DD}'] {
        assert_eq!(heading_slug(&format!("x{mark}y")), "xy", "mark U+{:04X} must strip", mark as u32);
    }
}

