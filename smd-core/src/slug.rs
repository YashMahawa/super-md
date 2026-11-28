use unicode_normalization::UnicodeNormalization;
use unicode_properties::{GeneralCategoryGroup, UnicodeGeneralCategory};

fn is_js_whitespace(c: char) -> bool {
    (c.is_whitespace() && c != '\u{0085}') || c == '\u{feff}'
}

pub fn heading_slug(value: &str) -> String {
    let lower = value.nfkc().collect::<String>().to_lowercase();
    let mut no_tags = String::with_capacity(lower.len());
    let mut rest = lower.as_str();
    while let Some(lt) = rest.find('<') {
        no_tags.push_str(&rest[..lt]);
        let after_lt = &rest[lt + 1..];
        match after_lt.find('>') {
            Some(gt) if gt >= 1 => rest = &after_lt[gt + 1..],
            Some(_) => {
                no_tags.push('<');
                rest = after_lt;
            }
            None => {
                no_tags.push_str(&rest[lt..]);
                rest = "";
                break;
            }
        }
    }
    no_tags.push_str(rest);
    let filtered: String = no_tags
        .chars()
        .filter(|&c| {
            matches!(
                c.general_category_group(),
                GeneralCategoryGroup::Letter | GeneralCategoryGroup::Number
            ) || is_js_whitespace(c)
                || c == '_'
                || c == '-'
        })
        .collect();
    let slug: String = filtered
        .trim_matches(is_js_whitespace)
        .chars()
        .map(|c| if is_js_whitespace(c) { '-' } else { c })
        .collect();
    if slug.is_empty() {
        "section".into()
    } else {
        slug
    }
}
