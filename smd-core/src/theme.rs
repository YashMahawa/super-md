//! Portable themes are bounded data, never executable CSS/QML/JavaScript.
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const MAX_THEME: usize = 65536;
pub const COLORS: &[&str] = &["primary","on-primary","primary-container","on-primary-container","surface","surface-low","surface-high","text","muted","outline","link","heading","code-bg","code-text","code-border","callout-tip","callout-warning","callout-danger","callout-info","callout-example"];
pub const METRICS: &[(&str, f64, f64)] = &[("controlRadius",0.,28.),("contentRadius",0.,32.),("paragraphSpacing",0.5,2.5),("codePadding",8.,32.),("headingWeight",400.,900.),("headingTracking",-0.05,0.1),("textTracking",-0.03,0.1),("tableBorderWidth",0.,3.)];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Theme {
    pub format: String,
    pub version: u32,
    pub name: String,
    #[serde(default = "accent")]
    pub accent: String,
    #[serde(default)]
    pub variants: BTreeMap<String, Variant>,
    #[serde(default)]
    pub metrics: BTreeMap<String, f64>,
}
fn accent() -> String { "blue".into() }
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Variant {
    #[serde(default)]
    pub colors: BTreeMap<String, String>,
    pub background: Option<Background>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Background {
    pub pattern: String,
    pub color: String,
    #[serde(default = "opacity")]
    pub opacity: f64,
    #[serde(default = "spacing")]
    pub spacing: f64,
    #[serde(default)]
    pub angle: f64,
}
fn opacity() -> f64 { 0.06 }
fn spacing() -> f64 { 24. }
fn color(value: &str) -> bool { value.len()==7 && value.starts_with('#') && value[1..].bytes().all(|c| c.is_ascii_hexdigit()) }
pub fn parse(input: &str) -> Result<Theme> {
    if input.len()>MAX_THEME { bail!("Theme exceeds 64 KB"); }
    let theme:Theme=serde_json::from_str(input.trim_start_matches('\u{feff}'))?;
    if theme.format!="supermd-theme" || theme.version!=1 { bail!("Expected supermd-theme version 1"); }
    if theme.name.trim().is_empty() || theme.name.chars().count()>80 || theme.name.chars().any(|c| c.is_control() || matches!(c,'<'|'>')) { bail!("Theme name must contain 1–80 printable characters without markup brackets"); }
    if !["blue","violet","rose","amber"].contains(&theme.accent.as_str()) { bail!("Unknown base accent"); }
    for (key,value) in &theme.metrics {
        let Some((_,min,max))=METRICS.iter().find(|(name,_,_)| *name==key) else { bail!("Unknown metric: {key}"); };
        if !value.is_finite() || value<min || value>max { bail!("{key} must be between {min} and {max}"); }
    }
    for (mode,variant) in &theme.variants {
        if !["light","dark","black"].contains(&mode.as_str()) { bail!("Unknown theme variant: {mode}"); }
        for (key,value) in &variant.colors {
            if !COLORS.contains(&key.as_str()) || !color(value) { bail!("Invalid color role: {key}; use #RRGGBB"); }
        }
        if let Some(bg)=&variant.background {
            if !["none","dots","grid","diagonal","gradient"].contains(&bg.pattern.as_str()) || !color(&bg.color) { bail!("Invalid background pattern or color"); }
            for (value,min,max) in [(bg.opacity,0.,0.15),(bg.spacing,12.,96.),(bg.angle,0.,360.)] {
                if !value.is_finite() || value<min || value>max { bail!("Background values are outside supported ranges"); }
            }
        }
    }
    Ok(theme)
}
pub fn response(input: &str) -> String {
    match parse(input) { Ok(theme)=>serde_json::json!({"theme":theme}).to_string(), Err(error)=>serde_json::json!({"error":error.to_string()}).to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> serde_json::Value { serde_json::json!({"format":"supermd-theme","version":1,"name":"Copper grid","accent":"amber","variants":{"dark":{"colors":{"surface":"#19140e","text":"#efe2d1"},"background":{"pattern":"grid","color":"#aabbcc","opacity":0.06}}},"metrics":{"controlRadius":16,"paragraphSpacing":1.4}}) }
    #[test] fn valid_theme_roundtrips_and_defaults_are_explicit() { let theme=parse(&sample().to_string()).unwrap(); assert_eq!(theme.variants["dark"].background.as_ref().unwrap().spacing,24.); assert_eq!(parse(&serde_json::to_string(&theme).unwrap()).unwrap().name,"Copper grid"); }
    #[test] fn bundled_examples_all_use_the_documented_format() {
        for input in [include_str!("../../public/themes/copper-grid.supermd-theme.json"),include_str!("../../public/themes/ink-dots.supermd-theme.json"),include_str!("../../public/themes/rose-paper.supermd-theme.json")] {assert!(!parse(input).unwrap().name.is_empty());}
    }
    #[test] fn refuses_code_urls_unknown_fields_and_unbounded_layouts() {
        for (path,value) in [("/format",serde_json::json!("other")),("/version",serde_json::json!(2)),("/name",serde_json::json!("\n")),("/accent",serde_json::json!("url(https://example.com)")),("/metrics/controlRadius",serde_json::json!(999)),("/variants/dark/colors/surface",serde_json::json!("url(file:///etc/passwd)")),("/variants/dark/background/opacity",serde_json::json!(0.9)),("/variants/dark/background/pattern",serde_json::json!("javascript"))] {
            let mut v=sample();*v.pointer_mut(path).unwrap()=value;assert!(parse(&v.to_string()).is_err(),"{path}");
        }
        let mut v=sample();v["css"]=serde_json::json!("@import 'https://example.com'");assert!(parse(&v.to_string()).is_err());
        v=sample();v["metrics"]["unknown"]=serde_json::json!(1);assert!(parse(&v.to_string()).is_err());
        v=sample();v["variants"]["dark"]["colors"]["unknown"]=serde_json::json!("#ffffff");assert!(parse(&v.to_string()).is_err());
        assert!(parse(&" ".repeat(MAX_THEME+1)).is_err());
        v=sample();v["name"]=serde_json::json!("<img src=https://example.com>");assert!(parse(&v.to_string()).is_err());
    }
}
