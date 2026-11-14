use anyhow::{bail, Result};
use serde::Deserialize;
use std::collections::HashMap;
use crate::{string, text};

#[derive(Deserialize)]
struct Deck { title: String, steps: Vec<Step> }
#[derive(Deserialize)]
struct Step { label: String, image: Option<String>, description: Option<String>, markdown: Option<String>, diagram: Option<serde_json::Value>, chart: Option<serde_json::Value> }

pub fn render(source: &str, assets: &HashMap<String, Vec<u8>>) -> Result<String> {
    if source.len() > 480_000 { bail!("Step cards exceed the export size limit"); }
    let deck: Deck = serde_json::from_str(source)?;
    if deck.title.trim().is_empty() || deck.title.len() > 480 || !(2..=40).contains(&deck.steps.len()) { bail!("Invalid step cards title or number of steps"); }
    let wide = deck.steps.iter().filter_map(|s| s.image.as_ref()).filter_map(|name| assets.get(name)).any(|bytes| {
        if let Ok(svg) = std::str::from_utf8(bytes) { if let Ok(doc) = roxmltree::Document::parse(&svg[svg.find("<svg").unwrap_or(0)..]) {
            let view: Vec<f64> = doc.root_element().attribute("viewBox").unwrap_or("").split(|c: char| c.is_whitespace() || c == ',').filter_map(|v| v.parse().ok()).collect();
            if view.len()==4 && view[3]>0. { return view[2]/view[3]>1.8; }
        }}
        imagesize::blob_size(bytes).is_ok_and(|size| size.width as f64 / size.height.max(1) as f64 > 1.8)
    });
    let count = if wide || deck.steps.iter().any(|s| s.markdown.is_some()) { 1 } else if deck.steps.len() > 3 { 2 } else { deck.steps.len() };
    let columns = "1fr,".repeat(count);
    let mut out = format!("\n#block(above: .7em, below: 4pt, sticky: true)[#strong[{}]]\n", text(&deck.title));
    for row in deck.steps.chunks(count) {
        // Each row can move intact to the next page. The deck itself can span
        // pages, and its final partial row retains the same diagram scale.
        out.push_str(&format!("#block(width: 100%, breakable: false, above: 3pt, below: 7pt)[#grid(columns: ({columns}), column-gutter: 6pt, align: top,\n"));
        for step in row {
            if step.label.trim().is_empty() || step.label.len() > 400 || step.description.as_ref().is_some_and(|s| s.len() > 6000) { bail!("Invalid step card label or description"); }
            if step.diagram.is_some() || step.chart.is_some() { bail!("Open this note in Super MD to prepare its interactive step diagrams for PDF export"); }
            if step.image.is_none() && step.description.is_none() && step.markdown.is_none() { bail!("Step card has no image or description"); }
            out.push_str(&format!("[#set text(size: .94em)\n#set par(spacing: 3pt, leading: .28em)\n#block(below: 3pt)[#strong[{}]]\n", text(&step.label)));
            if step.markdown.is_some() && step.image.is_some() { out.push_str("#grid(columns: (1fr, 1fr), gutter: 10pt, ["); }
            if let Some(image) = &step.image {
                if !assets.contains_key(image) { bail!("Image unavailable for PDF step: {image}"); }
                out.push_str(&format!("#smd-step-image({})\n", string(image)));
            }
            if let Some(markdown) = &step.markdown {
                if markdown.len() > 100_000 { bail!("Step Markdown exceeds the export size limit"); }
                if step.image.is_some() { out.push_str("], ["); }
                out.push_str(&crate::render_fragment(markdown, assets)?);
                if step.image.is_some() { out.push_str("])"); }
            }
            if let Some(description) = &step.description { out.push_str(&format!("\n{}\n", text(description))); }
            out.push_str("],\n");
        }
        out.push_str(")]\n");
    }
    out.push('\n');
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{export, image_sources, source, PdfOptions};
    fn fixture(count: usize) -> (String, HashMap<String, Vec<u8>>) {
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="320" height="210"><rect x="4" y="4" width="312" height="142" rx="8" fill="#e8f0ff"/><path d="M25 115L125 45L290 100" stroke="#2463b3" stroke-width="4" fill="none"/></svg>"##.to_vec();
        let steps: Vec<_> = (1..=count).map(|i| serde_json::json!({"label":format!("FRAME-{i:02}"),"image":"frame.svg","description":format!("CAPTION-{i:02}")})).collect();
        (format!("# Before\n\n```smd-steps\n{}\n```\n\nEND-SEQUENCE",serde_json::json!({"title":"All stages", "steps":steps})), HashMap::from([("frame.svg".into(),svg)]))
    }
    #[test]
    fn discovers_hidden_frames_and_preserves_code_examples() {
        let (md, _) = fixture(7);
        assert_eq!(image_sources(&md), vec!["frame.svg";7]);
        assert!(image_sources(&format!("````text\n{md}\n````")).is_empty());
    }
    #[test]
    fn rows_have_at_most_three_cells_and_no_interactive_chrome() {
        for n in [2,3,4,5,7,40] {
            let (md, assets) = fixture(n);
            let out = source(&md,&PdfOptions::default(),&assets).unwrap();
            assert_eq!(out.matches("#grid(columns:").count(), n.div_ceil(if n>3 {2} else {n}));
            assert!(out.contains(&format!("columns: ({})","1fr,".repeat(if n>3 {2} else {n}))));
            assert_eq!(out.matches("#smd-step-image(\"frame.svg\")").count(),n);
            assert!(!out.contains("raw(\"{\\\""));
        }
    }
    #[test]
    fn forty_frames_paginate_without_losing_labels_or_captions() {
        let (md, assets) = fixture(40);
        let bytes = export(&md,&PdfOptions::default(),&assets).unwrap();
        let path = std::env::temp_dir().join(format!("supermd-step-grid-{}.pdf",std::process::id()));
        std::fs::write(&path,bytes).unwrap();
        if let Ok(output) = std::process::Command::new("pdftotext").args([path.to_str().unwrap(),"-"]).output() {
            assert!(output.status.success());
            let text=String::from_utf8_lossy(&output.stdout);
            for i in 1..=40 { assert!(text.contains(&format!("FRAME-{i:02}"))); assert!(text.contains(&format!("CAPTION-{i:02}"))); }
            assert!(text.contains("END-SEQUENCE"));
        }
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn matplotlib_doctype_keeps_wide_figures_full_width() {
        let (md,mut assets)=fixture(5);
        assets.insert("frame.svg".into(),br##"<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 260"><path d="M1 1L700 240" stroke="black"/></svg>"##.to_vec());
        let rendered=source(&md,&PdfOptions::default(),&assets).unwrap();
        assert_eq!(rendered.matches("#grid(columns: (1fr,)").count(),5);
        assert!(export(&md,&PdfOptions::default(),&assets).unwrap().starts_with(b"%PDF-"));
    }
    #[test]
    fn rich_steps_typeset_math_and_markdown_beside_the_image() {
        let (_, assets)=fixture(2);
        let md=format!("```smd-step-grid\n{}\n```",serde_json::json!({"title":"Calculation","steps":[{"label":"Mean","image":"frame.svg","markdown":"**Mean**\n\n$x=3$\n\n- One\n- Two"},{"label":"Result","markdown":"The result is **three**."}]}));
        let generated=source(&md,&PdfOptions::default(),&assets).unwrap();
        assert!(generated.contains("#strong["));
        assert!(generated.contains("#grid(columns: (1fr, 1fr)"));
        assert!(export(&md,&PdfOptions::default(),&assets).unwrap().starts_with(b"%PDF-"));
    }
    #[test]
    fn missing_frames_or_unprepared_diagrams_fail_visibly() {
        let (md, _) = fixture(3);
        assert!(source(&md,&PdfOptions::default(),&HashMap::new()).unwrap_err().to_string().contains("Image unavailable"));
        assert!(render(r#"{"title":"X","steps":[{"label":"A","diagram":{}},{"label":"B","description":"Text"}]}"#,&HashMap::new()).is_err());
    }
}
