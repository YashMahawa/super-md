use std::collections::BTreeMap;

use super::{parse_pdf_date, PdfMetadata, YamlValue};

fn typst_str(value: &str) -> String {
    serde_json::to_string(value).unwrap()
}

impl PdfMetadata {
    pub fn typst_set_document(&self) -> String {
        if self.is_empty() {
            return String::new();
        }
        let mut fields = Vec::new();
        if let Some(title) = &self.title {
            fields.push(format!("title: {}", typst_str(title)));
        }
        if !self.authors.is_empty() {
            let tuple = self
                .authors
                .iter()
                .map(|a| format!("{},", typst_str(a)))
                .collect::<Vec<_>>()
                .join(" ");
            fields.push(format!("author: ({tuple})"));
        }
        if let Some(description) = &self.description {
            fields.push(format!("description: {}", typst_str(description)));
        }
        if !self.keywords.is_empty() {
            let tuple = self
                .keywords
                .iter()
                .map(|k| format!("{},", typst_str(k)))
                .collect::<Vec<_>>()
                .join(" ");
            fields.push(format!("keywords: ({tuple})"));
        }
        if let Some(date) = &self.date {
            if let Some((hour, minute, second)) = date.time {
                fields.push(format!(
                    "date: datetime(year: {}, month: {}, day: {}, hour: {}, minute: {}, second: {})",
                    date.year, date.month, date.day, hour, minute, second
                ));
            } else {
                fields.push(format!(
                    "date: datetime(year: {}, month: {}, day: {})",
                    date.year, date.month, date.day
                ));
            }
        }
        format!("#set document({})\n", fields.join(", "))
    }
}

fn lookup_case_insensitive<'a>(
    entries: &'a BTreeMap<String, YamlValue>,
    target: &str,
) -> Option<&'a YamlValue> {
    if let Some(val) = entries.get(target) {
        return Some(val);
    }
    entries
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(target))
        .map(|(_, v)| v)
}

fn scalar_to_string(value: &YamlValue) -> Option<String> {
    match value {
        YamlValue::String(s) => {
            let t = s.trim();
            (!t.is_empty()).then(|| t.to_string())
        }
        YamlValue::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn extract_author_name(value: &YamlValue) -> Option<String> {
    if let Some(direct) = scalar_to_string(value) {
        return Some(direct);
    }
    if let YamlValue::Map(map) = value {
        if let Some(name) = lookup_case_insensitive(map, "name")
            .or_else(|| lookup_case_insensitive(map, "literal"))
        {
            if let Some(direct) = scalar_to_string(name) {
                return Some(direct);
            }
            if let YamlValue::Map(name_map) = name {
                if let Some(lit) =
                    lookup_case_insensitive(name_map, "literal").and_then(scalar_to_string)
                {
                    return Some(lit);
                }
                let parts: Vec<String> = ["given", "family"]
                    .iter()
                    .filter_map(|k| lookup_case_insensitive(name_map, k).and_then(scalar_to_string))
                    .collect();
                if !parts.is_empty() {
                    return Some(parts.join(" "));
                }
            }
        }
        let parts: Vec<String> = ["given", "family"]
            .iter()
            .filter_map(|k| lookup_case_insensitive(map, k).and_then(scalar_to_string))
            .collect();
        if !parts.is_empty() {
            return Some(parts.join(" "));
        }
    }
    None
}

fn extract_authors(entries: &BTreeMap<String, YamlValue>) -> Vec<String> {
    let mut out = Vec::new();
    let mut push = |name: Option<String>| {
        if let Some(n) = name {
            if !out.contains(&n) {
                out.push(n);
            }
        }
    };
    for key in ["author", "authors", "creator"] {
        let Some(val) = lookup_case_insensitive(entries, key) else {
            continue;
        };
        match val {
            YamlValue::Seq(items) => {
                for item in items {
                    push(extract_author_name(item));
                }
            }
            other => push(extract_author_name(other)),
        }
    }
    out
}

fn extract_keywords(entries: &BTreeMap<String, YamlValue>) -> Vec<String> {
    let mut out = Vec::new();
    let mut push = |raw: &str| {
        let trimmed = raw.trim();
        if !trimmed.is_empty() && !out.iter().any(|existing| existing == trimmed) {
            out.push(trimmed.to_string());
        }
    };
    for key in ["keywords", "tags", "tag"] {
        let Some(val) = lookup_case_insensitive(entries, key) else {
            continue;
        };
        match val {
            YamlValue::Seq(items) => {
                for item in items {
                    if let Some(s) = scalar_to_string(item) {
                        push(&s);
                    }
                }
            }
            other => {
                if let Some(s) = scalar_to_string(other) {
                    if s.contains(',') {
                        for part in s.split(',') {
                            push(part);
                        }
                    } else {
                        push(&s);
                    }
                }
            }
        }
    }
    out
}

pub(super) fn normalize_pdf_metadata(entries: &BTreeMap<String, YamlValue>) -> PdfMetadata {
    let title = lookup_case_insensitive(entries, "title").and_then(scalar_to_string);
    let authors = extract_authors(entries);
    let description = lookup_case_insensitive(entries, "description")
        .and_then(scalar_to_string)
        .or_else(|| lookup_case_insensitive(entries, "subject").and_then(scalar_to_string))
        .or_else(|| lookup_case_insensitive(entries, "abstract").and_then(scalar_to_string));
    let keywords = extract_keywords(entries);
    let date = lookup_case_insensitive(entries, "date")
        .and_then(scalar_to_string)
        .and_then(|d| parse_pdf_date(&d));
    PdfMetadata {
        title,
        authors,
        description,
        keywords,
        date,
    }
}
