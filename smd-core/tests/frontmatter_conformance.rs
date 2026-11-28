use serde::Deserialize;
use serde_json::Value;
use smd_core::frontmatter::{parse_frontmatter, strip_frontmatter, YamlValue};

#[derive(Deserialize)]
struct ConformanceSuite {
    version: u32,
    cases: Vec<ConformanceCase>,
}

#[derive(Deserialize)]
struct ExpectedMetadata {
    title: Option<String>,
    authors: Vec<String>,
    description: Option<String>,
    keywords: Vec<String>,
}

#[derive(Deserialize)]
struct ConformanceCase {
    id: String,
    valid: bool,
    markdown: String,
    body: String,
    entries: Option<Value>,
    metadata: Option<ExpectedMetadata>,
}

fn yaml_to_json(val: &YamlValue) -> Value {
    match val {
        YamlValue::Null => Value::Null,
        YamlValue::Bool(b) => Value::Bool(*b),
        YamlValue::String(s) => Value::String(s.clone()),
        YamlValue::Seq(items) => Value::Array(items.iter().map(yaml_to_json).collect()),
        YamlValue::Map(map) => {
            Value::Object(map.iter().map(|(k, v)| (k.clone(), yaml_to_json(v))).collect())
        }
    }
}

#[test]
fn frontmatter_conformance_vectors() {
    let raw_json = include_str!("../../test-fixtures/frontmatter-conformance.json");
    let suite: ConformanceSuite = serde_json::from_str(raw_json).expect("valid conformance JSON");
    assert_eq!(suite.version, 1);
    assert!(suite.cases.len() >= 20);

    for case in &suite.cases {
        let parsed = parse_frontmatter(&case.markdown);
        assert_eq!(parsed.is_some(), case.valid, "case `{}` validity mismatch", case.id);
        assert_eq!(strip_frontmatter(&case.markdown), case.body, "case `{}` strip mismatch", case.id);

        if let Some(fm) = parsed {
            assert_eq!(&case.markdown[fm.end..], case.body, "case `{}` body slice mismatch", case.id);
            assert_eq!(format!("{}{}", fm.raw, case.body), case.markdown, "case `{}` raw+body mismatch", case.id);
            let actual_entries = Value::Object(
                fm.entries.iter().map(|(k, v)| (k.clone(), yaml_to_json(v))).collect(),
            );
            assert_eq!(Some(&actual_entries), case.entries.as_ref(), "case `{}` entries mismatch", case.id);
            match &case.metadata {
                None => assert!(fm.metadata.is_empty(), "case `{}` expected empty metadata", case.id),
                Some(expected) => {
                    assert_eq!(fm.metadata.title, expected.title, "case `{}` title", case.id);
                    assert_eq!(fm.metadata.authors, expected.authors, "case `{}` authors", case.id);
                    assert_eq!(fm.metadata.description, expected.description, "case `{}` description", case.id);
                    assert_eq!(fm.metadata.keywords, expected.keywords, "case `{}` keywords", case.id);
                }
            }
        }
    }
}
