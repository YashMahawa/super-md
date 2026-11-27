//! Unified top-of-file YAML frontmatter parser and PDF document metadata extractor.
//! Recognizes optional UTF-8 BOM, `---` opener, `---` or `...` closer, trailing
//! horizontal whitespace on delimiter lines, empty blocks, and EOF closers.
//! Malformed or unclosed YAML blocks return `None` so callers fall back safely
//! to standard Markdown rendering.

mod metadata;
mod pdf_date;
mod yaml_block;
mod yaml_lexer;

use std::collections::BTreeMap;

pub use pdf_date::parse_pdf_date;

use metadata::normalize_pdf_metadata;
use yaml_block::parse_block_mapping;
use yaml_lexer::{next_meaningful_line, to_raw_lines};

#[derive(Clone, Debug, PartialEq)]
pub enum YamlValue {
    Null,
    Bool(bool),
    String(String),
    Seq(Vec<YamlValue>),
    Map(BTreeMap<String, YamlValue>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PdfDate {
    pub year: i32,
    pub month: u8,
    pub day: u8,
    pub time: Option<(u8, u8, u8)>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PdfMetadata {
    pub title: Option<String>,
    pub authors: Vec<String>,
    pub description: Option<String>,
    pub keywords: Vec<String>,
    pub date: Option<PdfDate>,
}

impl PdfMetadata {
    pub fn is_empty(&self) -> bool {
        self.title.is_none()
            && self.authors.is_empty()
            && self.description.is_none()
            && self.keywords.is_empty()
            && self.date.is_none()
    }
}

pub struct ParsedFrontmatter<'a> {
    pub raw: &'a str,
    pub end: usize,
    pub entries: BTreeMap<String, YamlValue>,
    pub metadata: PdfMetadata,
}

pub fn parse_frontmatter(markdown: &str) -> Option<ParsedFrontmatter<'_>> {
    let mut cursor = if markdown.starts_with('\u{feff}') {
        '\u{feff}'.len_utf8()
    } else {
        0
    };
    if !markdown[cursor..].starts_with("---") {
        return None;
    }
    cursor += 3;
    let bytes = markdown.as_bytes();
    while cursor < bytes.len() && (bytes[cursor] == b' ' || bytes[cursor] == b'\t') {
        cursor += 1;
    }
    if bytes.get(cursor) == Some(&b'\r') && bytes.get(cursor + 1) == Some(&b'\n') {
        cursor += 2;
    } else if bytes.get(cursor) == Some(&b'\n') {
        cursor += 1;
    } else {
        return None;
    }

    let yaml_start = cursor;
    let mut line_start = cursor;
    let mut yaml_end = None;
    let mut frontmatter_end = None;

    while line_start <= bytes.len() {
        let rel_nl = markdown[line_start..].find('\n');
        let (content_end, next_line_start, full_line_end) = match rel_nl {
            None => (bytes.len(), bytes.len() + 1, bytes.len()),
            Some(pos) => {
                let nl_idx = line_start + pos;
                let c_end = if nl_idx > line_start && bytes[nl_idx - 1] == b'\r' {
                    nl_idx - 1
                } else {
                    nl_idx
                };
                (c_end, nl_idx + 1, nl_idx + 1)
            }
        };
        let line = &markdown[line_start..content_end];
        if let Some(rest) = line.strip_prefix("---").or_else(|| line.strip_prefix("...")) {
            if rest.bytes().all(|b| b == b' ' || b == b'\t') {
                yaml_end = Some(line_start);
                frontmatter_end = Some(full_line_end);
                break;
            }
        }
        if rel_nl.is_none() {
            break;
        }
        line_start = next_line_start;
    }

    let yaml_end = yaml_end?;
    let frontmatter_end = frontmatter_end?;
    let mut yaml_slice = &markdown[yaml_start..yaml_end];
    if let Some(stripped) = yaml_slice.strip_suffix('\n') {
        yaml_slice = stripped.strip_suffix('\r').unwrap_or(stripped);
    }

    let lines = if yaml_slice.is_empty() {
        Vec::new()
    } else {
        to_raw_lines(yaml_slice)?
    };

    let first_meaningful = next_meaningful_line(&lines, 0);
    let mut entries = BTreeMap::new();
    if first_meaningful < lines.len() {
        if lines[first_meaningful].indent != 0 {
            return None;
        }
        let (parsed, next_idx) = parse_block_mapping(&lines, first_meaningful, 0)?;
        if next_meaningful_line(&lines, next_idx) < lines.len() {
            return None;
        }
        entries = parsed;
    }

    let metadata = normalize_pdf_metadata(&entries);
    Some(ParsedFrontmatter {
        raw: &markdown[..frontmatter_end],
        end: frontmatter_end,
        entries,
        metadata,
    })
}

pub fn strip_frontmatter(markdown: &str) -> &str {
    match parse_frontmatter(markdown) {
        Some(fm) => &markdown[fm.end..],
        None => markdown,
    }
}

#[cfg(test)]
mod tests {
    use super::yaml_lexer::strip_flow_line_comment;
    use super::*;

    #[test]
    fn parses_delimiter_variations_bom_empty_and_eof_closers() {
        let cases = [
            ("\u{feff}---\ntitle: BOM\n---\nBody", "Body", Some("BOM")),
            ("---  \t \ntitle: Dot\n...  \t\nBody", "Body", Some("Dot")),
            ("---\r\ntitle: CRLF\r\n...\r\nBody", "Body", Some("CRLF")),
            ("---\n---\nAfter empty", "After empty", None),
            ("---\n...\nAfter dots", "After dots", None),
            ("---\n# comment\n---\nAfter comment", "After comment", None),
            ("---\ntitle: EOF\n---", "", Some("EOF")),
            ("\u{feff}---\ntitle: BOM EOF\n...", "", Some("BOM EOF")),
        ];
        for (input, expected_body, expected_title) in cases {
            let parsed = parse_frontmatter(input).unwrap_or_else(|| panic!("failed on {input:?}"));
            assert_eq!(&input[parsed.end..], expected_body);
            assert_eq!(parsed.metadata.title.as_deref(), expected_title);
        }
    }

    #[test]
    fn normalizes_quarto_obsidian_and_typora_pdf_metadata() {
        let md = "\
---
title: \"Statistical Mechanics\"
author:
  - name: Ludwig Boltzmann
  - given: Josiah
    family: Gibbs
abstract: |-
  Canonical ensemble derivations
  and entropy bounds.
keywords: [entropy, ensembles]
tags:
- physics
- entropy
date: 2026-03-15T14:30:00+02:00
...
# Body";
        let parsed = parse_frontmatter(md).unwrap();
        assert_eq!(parsed.metadata.title.as_deref(), Some("Statistical Mechanics"));
        assert_eq!(parsed.metadata.authors, vec!["Ludwig Boltzmann", "Josiah Gibbs"]);
        assert_eq!(
            parsed.metadata.description.as_deref(),
            Some("Canonical ensemble derivations\nand entropy bounds.")
        );
        assert_eq!(parsed.metadata.keywords, vec!["entropy", "ensembles", "physics"]);
        assert_eq!(
            parsed.metadata.date,
            Some(PdfDate { year: 2026, month: 3, day: 15, time: Some((12, 30, 0)) })
        );
        let directive = parsed.metadata.typst_set_document();
        assert!(directive.contains("title: \"Statistical Mechanics\""));
        assert!(directive.contains("author: (\"Ludwig Boltzmann\", \"Josiah Gibbs\",)"));
        assert!(directive.contains("keywords: (\"entropy\", \"ensembles\", \"physics\",)"));
        assert!(directive.contains(
            "date: datetime(year: 2026, month: 3, day: 15, hour: 12, minute: 30, second: 0)"
        ));
    }

    #[test]
    fn parses_calendar_dates_and_ignores_freeform_dates_safely() {
        assert_eq!(
            parse_pdf_date("2026-03-15"),
            Some(PdfDate { year: 2026, month: 3, day: 15, time: None })
        );
        assert_eq!(
            parse_pdf_date("March 15, 2026"),
            Some(PdfDate { year: 2026, month: 3, day: 15, time: None })
        );
        assert_eq!(
            parse_pdf_date("15 Sep 2026"),
            Some(PdfDate { year: 2026, month: 9, day: 15, time: None })
        );
        assert_eq!(parse_pdf_date("2026-02-29"), None);
        assert_eq!(parse_pdf_date("Spring Semester 2026"), None);
    }

    #[test]
    fn rejects_malformed_unclosed_and_non_yaml_blocks() {
        for sample in [
            "---\ntitle: Unclosed\n\n# Body",
            "+++\ntitle = \"TOML\"\n+++\n# Body",
            "---\nJust a sentence between rules.\n---\n",
            "---\n- item 1\n- item 2\n---\n",
            "---\ntitle: \"unclosed quote\n---\n",
            "---\ntags: [unclosed\n---\n",
            "---\nauthor:\n\t- tab indent\n---\n",
        ] {
            assert!(parse_frontmatter(sample).is_none(), "unexpectedly accepted {sample:?}");
            assert_eq!(strip_frontmatter(sample), sample);
        }
    }

    #[test]
    fn parses_hex_escapes_and_rejects_invalid_hex_sequences() {
        let md = "---\ntitle: \"\\x41-\\u03b1-\\U0001f680\"\n---\n";
        let parsed = parse_frontmatter(md).unwrap();
        assert_eq!(parsed.metadata.title.as_deref(), Some("A-\u{03b1}-\u{1f680}"));

        for invalid in [
            "---\ntitle: \"\\x4\"\n---\n",
            "---\ntitle: \"\\xZZ\"\n---\n",
            "---\ntitle: \"\\x\u{00e9}\"\n---\n",
            "---\ntitle: \"\\u03b\"\n---\n",
            "---\ntitle: \"\\ud800\"\n---\n",
            "---\ntitle: \"\\U0001f68\"\n---\n",
            "---\ntitle: \"\\U00110000\"\n---\n",
        ] {
            assert!(parse_frontmatter(invalid).is_none(), "unexpectedly accepted {invalid:?}");
        }
    }

    #[test]
    fn folds_multiline_quoted_newlines_and_escaped_continuations() {
        let md = "\
---
double: \"alpha  \t
   beta\t

  gamma\\\n   delta\"
single: 'one  \t
   it''s\t

  two'
---
";
        let parsed = parse_frontmatter(md).unwrap();
        assert_eq!(
            parsed.entries.get("double"),
            Some(&YamlValue::String("alpha beta gamma".to_string() + "delta"))
        );
        assert_eq!(
            parsed.entries.get("single"),
            Some(&YamlValue::String("one it's two".to_string()))
        );
    }

    #[test]
    fn parses_single_and_double_quoted_keys_in_block_and_flow_mappings() {
        let md = "\
---
\"double: key\": \"v1\"
'single''key': 'v2'
flow: {\"k1\":1, 'k''2':2}
---
";
        let parsed = parse_frontmatter(md).unwrap();
        assert_eq!(parsed.entries.get("double: key"), Some(&YamlValue::String("v1".into())));
        assert_eq!(parsed.entries.get("single'key"), Some(&YamlValue::String("v2".into())));
        let mut expected_flow = BTreeMap::new();
        expected_flow.insert("k1".into(), YamlValue::String("1".into()));
        expected_flow.insert("k'2".into(), YamlValue::String("2".into()));
        assert_eq!(parsed.entries.get("flow"), Some(&YamlValue::Map(expected_flow)));

        for invalid in [
            "---\n\"compact\":1\n---\n",
            "---\n'compact':2\n---\n",
            "---\n\"unclosed: 1\n---\n",
            "---\n'unclosed: 1\n---\n",
        ] {
            assert!(parse_frontmatter(invalid).is_none(), "unexpectedly accepted {invalid:?}");
        }
    }

    #[test]
    fn tracks_quote_state_across_flow_comments_and_continuations() {
        assert_eq!(strip_flow_line_comment("[\"a # b\", 'it''s # c'] # trailing"), "[\"a # b\", 'it''s # c']");
        assert_eq!(strip_flow_line_comment("[\"trailing\\"), "[\"trailing\\");

        let md = "\
---
items: [
  \"hash # in \\\"double\\\"\", # comment after double
  'hash # in ''single''', # comment after single
] # comment after bracket
---
";
        let parsed = parse_frontmatter(md).unwrap();
        assert_eq!(
            parsed.entries.get("items"),
            Some(&YamlValue::Seq(vec![
                YamlValue::String("hash # in \"double\"".into()),
                YamlValue::String("hash # in 'single'".into()),
            ]))
        );

        assert!(parse_frontmatter("---\nitems: [1, 2] \"extra\"\n---\n").is_none());
        assert!(parse_frontmatter("---\nitems: [\"unterminated\\\n---\n").is_none());
    }

    #[test]
    fn dispatches_block_quoted_and_flow_scalars_in_mappings_and_sequences() {
        let md = "\
---
map_block: |-
  line 1
  line 2
map_folded: >-
  fold 1
  fold 2
map_flow: [
zero_indent_ok
]
seq:
  - |-
    seq line 1
    seq line 2
  - >-
    seq fold 1
    seq fold 2
  - \"seq
   double\"
  - 'seq
   single'
  - [
   seq_flow
   ]
  - {a: 1}
---
";
        let parsed = parse_frontmatter(md).unwrap();
        assert_eq!(parsed.entries.get("map_block"), Some(&YamlValue::String("line 1\nline 2".into())));
        assert_eq!(parsed.entries.get("map_folded"), Some(&YamlValue::String("fold 1 fold 2".into())));
        assert_eq!(
            parsed.entries.get("map_flow"),
            Some(&YamlValue::Seq(vec![YamlValue::String("zero_indent_ok".into())]))
        );
        let mut expected_map = BTreeMap::new();
        expected_map.insert("a".into(), YamlValue::String("1".into()));
        assert_eq!(
            parsed.entries.get("seq"),
            Some(&YamlValue::Seq(vec![
                YamlValue::String("seq line 1\nseq line 2".into()),
                YamlValue::String("seq fold 1 seq fold 2".into()),
                YamlValue::String("seq double".into()),
                YamlValue::String("seq single".into()),
                YamlValue::Seq(vec![YamlValue::String("seq_flow".into())]),
                YamlValue::Map(expected_map),
            ]))
        );

        // Sequence flow continuation requires indent >= seq_indent + 1
        let under_indented_seq_flow = "---\nseq:\n  - [\n  bad\n  ]\n---\n";
        assert!(parse_frontmatter(under_indented_seq_flow).is_none());
    }
}
