//! The same local typesetter is used by desktop and Android. No browser print layout.
pub mod portable;
use anyhow::{bail, Result};
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use typst_as_lib::{typst_kit_options::TypstKitFontOptions, TypstEngine};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PdfOptions {
    pub page_size: String,
    pub margin: f32,
    pub font_size: f32,
    pub line_height: f32,
    pub font_family: String,
    pub page_numbers: bool,
    pub themed: bool,
    pub theme_accent: String,
}
impl Default for PdfOptions {
    fn default() -> Self {
        Self { page_size: "a4".into(), margin: 18., font_size: 10.5, line_height: 1.35, font_family: "Libertinus Serif".into(), page_numbers: true, themed: false, theme_accent: "#386a57".into() }
    }
}
impl PdfOptions {
    pub fn validate(&self) -> Result<()> {
        if !["a3", "a4", "a5", "a6", "iso-b4", "iso-b5", "iso-b6", "letter", "legal", "tabloid", "executive"].contains(&self.page_size.as_str()) { bail!("Unsupported page size"); }
        for (name, value, min, max) in [("margin", self.margin, 4., 60.), ("font size", self.font_size, 7., 24.), ("line height", self.line_height, 0.9, 2.2)] {
            if !value.is_finite() || value < min || value > max { bail!("Invalid {name}: expected {min} to {max}"); }
        }
        if self.font_family.len() > 120 { bail!("Font name is too long"); }
        if self.theme_accent.len() != 7 || !self.theme_accent.starts_with('#') || !self.theme_accent[1..].chars().all(|c| c.is_ascii_hexdigit()) { bail!("Invalid PDF theme accent"); }
        Ok(())
    }
}

fn string(value: &str) -> String { serde_json::to_string(value).unwrap() }
fn text(value: &str) -> String { format!("#text({})", string(value)) }

/// MiTeX 0.2 predates Typst's angle-bracket rename. Rewrite generated
/// identifiers only, never quoted TeX text (or the user's Markdown).
fn compatible_math(value: &str) -> String {
    let mut output = String::new();
    let mut quoted = false;
    let mut escaped = false;
    let mut token = String::new();
    let flush = |token: &mut String, output: &mut String| {
        let replacement = match token.as_str() {
            "angle.l" => "chevron.l", "angle.r" => "chevron.r",
            "angle.l.double" => "chevron.l.double", "angle.r.double" => "chevron.r.double",
            other => other,
        };
        output.push_str(replacement); token.clear();
    };
    for ch in value.chars() {
        if quoted {
            output.push(ch);
            if ch == '"' && !escaped { quoted = false; }
            escaped = ch == '\\' && !escaped;
        } else if ch == '"' {
            flush(&mut token, &mut output); output.push(ch); quoted = true;
        } else if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' {
            token.push(ch);
        } else { flush(&mut token, &mut output); output.push(ch); }
    }
    flush(&mut token, &mut output); output
}

pub fn image_sources(markdown: &str) -> Vec<String> {
    Parser::new_ext(markdown, Options::all()).filter_map(|event| match event { Event::Start(Tag::Image { dest_url, .. }) => Some(dest_url.to_string()), _ => None }).collect()
}

/// Normalize both Obsidian and Super MD callouts before parsing ordinary Markdown.
pub fn normalize_callouts(input: &str) -> String {
    let mut output = String::new();
    let mut in_callout = false;
    let mut in_fence = false;
    for line in input.lines() {
        if line.trim_start().starts_with("```") || line.trim_start().starts_with("~~~") { in_fence = !in_fence; }
        if !in_fence && line.starts_with(":::callout") {
            let spec = line.trim_start_matches(":::callout").trim();
            let (kind, title) = spec.split_once(' ').unwrap_or((spec, spec));
            output.push_str(&format!("> [!{}] {}\n", kind, title.trim_matches('"')));
            in_callout = true;
        } else if in_callout && line.trim() == ":::" { in_callout = false; output.push('\n'); }
        else { if in_callout { output.push_str("> "); } output.push_str(line); output.push('\n'); }
    }
    output
}

struct Renderer<'a> {
    events: std::iter::Peekable<std::vec::IntoIter<Event<'a>>>,
    assets: &'a HashMap<String, Vec<u8>>,
    footnotes: HashMap<String, String>,
    headings: HashMap<String, usize>,
    heading_counts: HashMap<String, usize>,
}
fn heading_slug(value: &str) -> String {
    let value = value.to_lowercase().chars().filter(|c| c.is_alphanumeric() || c.is_whitespace() || *c == '-' || *c == '_').collect::<String>();
    let slug = value.trim().chars().map(|c| if c.is_whitespace() { '-' } else { c }).collect::<String>();
    if slug.is_empty() { "section".into() } else { slug }
}
impl<'a> Renderer<'a> {
    fn render(&mut self, end: Option<TagEnd>) -> Result<String> {
        let mut out = String::new();
        while let Some(event) = self.events.next() {
            match event {
                Event::End(tag) if Some(tag) == end => break,
                Event::End(_) => {},
                Event::Text(value) => out.push_str(&text(&value)),
                Event::Code(value) => out.push_str(&format!("#raw({})", string(&value))),
                Event::InlineMath(ref value) | Event::DisplayMath(ref value) => {
                    let display = matches!(&event, Event::DisplayMath(_));
                    let math = mitex::convert_math(&value, None).map_err(|e| anyhow::anyhow!("LaTeX conversion failed for {value}: {e}"))?;
                    let expression = format!("#eval({}, scope: smd-math-scope)", string(&format!("${}$", compatible_math(&math))));
                    out.push_str(&if display { format!("\n#smd-fit(math.equation(block: true, [{expression}]))\n\n") } else { expression });
                },
                Event::SoftBreak => out.push(' '),
                Event::HardBreak => out.push_str("#linebreak()"),
                Event::Rule => out.push_str("\n#line(length: 100%, stroke: .5pt + rgb(\"#d6dde5\"))\n"),
                Event::TaskListMarker(checked) => out.push_str(if checked { "#text(\"☑ \u{a0}\")" } else { "#text(\"☐ \u{a0}\")" }),
                Event::FootnoteReference(name) => out.push_str(&format!("#footnote[{}]", self.footnotes.get(name.as_ref()).cloned().unwrap_or_else(|| text(&name)))),
                Event::Html(html) | Event::InlineHtml(html) => { if html.trim().starts_with("<br") { out.push_str("#linebreak()"); } },
                Event::Start(tag) => {
                    let close = tag.to_end();
                    match tag {
                        Tag::CodeBlock(kind) => {
                            let mut code = String::new();
                            while let Some(e) = self.events.next() { if e == Event::End(close) { break; } if let Event::Text(v) = e { code.push_str(&v); } }
                            let lang = match kind { CodeBlockKind::Fenced(v) => v.to_string(), _ => String::new() };
                            if ["mermaid", "smd-chart"].contains(&lang.as_str()) { bail!("Export preparation did not render a {lang} block"); }
                            // Individual lines fit the available width while the
                            // enclosing block stays breakable across pages.
                            out.push_str("\n#block(width: 100%, breakable: true, fill: smd-code-fill, inset: 8pt)[\n");
                            // Each fit is a block-level layout. Adding a separate
                            // linebreak after it creates empty paragraphs and
                            // wastes most of a page on short snippets.
                            out.push_str("#set par(spacing: 0pt, leading: .3em)\n");
                            for line in code.lines() { out.push_str(&format!("#block(height: 1.2em, above: 0pt, below: 0pt)[#smd-fit(raw({}, lang: {}))]\n", string(if line.is_empty() { " " } else { line }), string(&lang))); }
                            out.push_str("]\n\n");
                        },
                        Tag::Image { dest_url, .. } => {
                            let _alt = self.render(Some(close))?;
                            let key = dest_url.to_string();
                            if !self.assets.contains_key(&key) { bail!("Image unavailable for PDF: {key}"); }
                            out.push_str(&format!("#smd-image({})", string(&key)));
                        },
                        Tag::Table(columns) => {
                            let mut lengths = vec![0usize; columns.len()]; let mut counts = vec![0usize; columns.len()]; let mut column = 0; let mut length = 0;
                            for event in self.events.clone() {
                                match event {
                                    Event::End(TagEnd::Table) => break,
                                    Event::Start(Tag::TableCell) => length = 0,
                                    Event::Text(value) | Event::Code(value) | Event::InlineMath(value) | Event::DisplayMath(value) => length += value.chars().count(),
                                    Event::End(TagEnd::TableCell) => { lengths[column] += length.min(180); counts[column] += 1; column = (column + 1) % columns.len(); },
                                    _ => {},
                                }
                            }
                            let widths = lengths.iter().zip(&counts).map(|(len, count)| format!("{:.2}fr,", ((*len as f64 / (*count).max(1) as f64).max(8.)).sqrt().min(12.))).collect::<String>();
                            out.push_str(&format!("\n#table(columns: ({widths}), inset: 6pt, stroke: .4pt + smd-line,\n"));
                            out.push_str(&self.render(Some(close))?); out.push_str(")\n\n");
                        },
                        Tag::TableHead => { out.push_str("table.header("); out.push_str(&self.render(Some(close))?); out.push_str("),\n"); },
                        Tag::TableRow => out.push_str(&self.render(Some(close))?),
                        Tag::TableCell => {
                            // Fit only over-wide equations. A layout wrapper on
                            // *each* inline equation creates block-level breaks
                            // and inflates mixed prose/math cells unnecessarily.
                            out.push_str("[#layout(cell => { show math.equation: it => { let w = measure(it).width; if w > cell.width { let factor = cell.width / w; scale(x: factor * 100%, y: factor * 100%, reflow: true, it) } else { it } }; [");
                            out.push_str(&self.render(Some(close))?); out.push_str("] })],\n");
                        },
                        Tag::FootnoteDefinition(name) => { let body = self.render(Some(close))?; self.footnotes.insert(name.to_string(), body); },
                        Tag::BlockQuote(_) => {
                            // CommonMark may split literal brackets into several
                            // Text events. Match the first complete logical line,
                            // not only its first text fragment.
                            let first_line = if matches!(self.events.peek(), Some(Event::Start(Tag::Paragraph))) {
                                self.events.clone().skip(1).take_while(|event| !matches!(event, Event::SoftBreak | Event::HardBreak | Event::End(TagEnd::Paragraph))).filter_map(|event| match event { Event::Text(value) | Event::Code(value) => Some(value.to_string()), _ => None }).collect::<String>()
                            } else { String::new() };
                            let callout = first_line.strip_prefix("[!").and_then(|v| v.split_once(']')).map(|(kind, title)| (kind.to_lowercase(), title.trim_start_matches(['+', '-']).trim().to_string()));
                            let (body, accent) = if let Some((kind, title)) = callout {
                                self.events.next();
                                while !matches!(self.events.peek(), None | Some(Event::SoftBreak | Event::HardBreak | Event::End(TagEnd::Paragraph))) { self.events.next(); }
                                if matches!(self.events.peek(), Some(Event::SoftBreak | Event::HardBreak)) { self.events.next(); }
                                let title = if title.is_empty() { kind.clone() } else { title };
                                let body = self.render(Some(TagEnd::Paragraph))? + "\n\n" + &self.render(Some(close))?;
                                let accent = match kind.as_str() { "tip" | "success" => "#14735b", "warning" | "caution" => "#946200", "danger" | "error" => "#b3261e", _ => "#315d99" };
                                (format!("#text(weight: \"bold\", fill: rgb(\"{accent}\"))[{}]\n\n{body}", text(&title)), accent)
                            } else { (self.render(Some(close))?, "#315d99") };
                            out.push_str(&format!("\n#block(width: 100%, breakable: true, fill: smd-callout-fill, stroke: (left: 2pt + rgb(\"{accent}\")), inset: 10pt, radius: 4pt)[{body}]\n\n"));
                        },
                        _ => {
                            let heading = if matches!(tag, Tag::Heading { .. }) {
                                let plain = self.events.clone().take_while(|e| !matches!(e, Event::End(TagEnd::Heading(_)))).filter_map(|e| match e { Event::Text(v) | Event::Code(v) | Event::InlineMath(v) => Some(v.to_string()), _ => None }).collect::<String>();
                                let slug = heading_slug(&plain); let count = self.heading_counts.entry(slug.clone()).or_default();
                                let id = if *count == 0 { slug } else { format!("{slug}-{count}") }; *count += 1; Some(id)
                            } else { None };
                            let body = self.render(Some(close))?;
                            match tag {
                                Tag::Paragraph => out.push_str(&format!("{body}\n\n")),
                                Tag::Heading { level, .. } => out.push_str(&format!("\n#heading(level: {})[{body}] <smd-{}>\n\n", level as u8, heading.unwrap())),
                                Tag::Emphasis => out.push_str(&format!("#emph[{body}]")),
                                Tag::Strong => out.push_str(&format!("#strong[{body}]")),
                                Tag::Strikethrough => out.push_str(&format!("#strike[{body}]")),
                                Tag::List(start) => out.push_str(&if let Some(start) = start { format!("\n#enum(start: {start}, {body})\n") } else { format!("\n#list({body})\n") }),
                                Tag::Item => out.push_str(&format!("[{body}],\n")),
                                Tag::Link { dest_url, .. } => out.push_str(&if let Some(fragment) = dest_url.strip_prefix('#') {
                                    let decoded = percent_encoding::percent_decode_str(fragment).decode_utf8_lossy();
                                    let slug = heading_slug(&decoded);
                                    if self.headings.contains_key(&slug) { format!("#link(label({}))[{body}]", string(&format!("smd-{slug}"))) } else { body }
                                } else if dest_url.starts_with("https:") || dest_url.starts_with("http:") || dest_url.starts_with("mailto:") { format!("#link({})[{body}]", string(&dest_url)) } else { body }),
                                _ => out.push_str(&body),
                            }
                        }
                    }
                },
            }
        }
        Ok(out)
    }
}

pub fn source(markdown: &str, options: &PdfOptions, assets: &HashMap<String, Vec<u8>>) -> Result<String> {
    options.validate()?;
    let normalized = normalize_callouts(markdown);
    let events = Parser::new_ext(&normalized, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_MATH | Options::ENABLE_FOOTNOTES).collect::<Vec<_>>();
    let mut headings = HashMap::new(); let mut current = None::<String>;
    for event in &events { match event {
        Event::Start(Tag::Heading { .. }) => current = Some(String::new()),
        Event::Text(v) | Event::Code(v) | Event::InlineMath(v) => { if let Some(text) = &mut current { text.push_str(v); } },
        Event::End(TagEnd::Heading(_)) => { if let Some(text) = current.take() { let slug = heading_slug(&text); let count = headings.get(&slug).copied().unwrap_or(0); if count > 0 { headings.insert(format!("{slug}-{count}"), 1); } headings.insert(slug, count + 1); } },
        _ => {}
    } }
    let mut renderer = Renderer { events: events.into_iter().peekable(), assets, footnotes: HashMap::new(), headings, heading_counts: HashMap::new() };
    // References normally precede definitions, so collect definitions first.
    let mut definitions = Renderer { events: renderer.events.clone(), assets, footnotes: HashMap::new(), headings: renderer.headings.clone(), heading_counts: HashMap::new() };
    while let Some(event) = definitions.events.next() {
        if let Event::Start(Tag::FootnoteDefinition(name)) = event { let value = definitions.render(Some(TagEnd::FootnoteDefinition))?; definitions.footnotes.insert(name.to_string(), value); }
    }
    renderer.footnotes = definitions.footnotes;
    let body = renderer.render(None)?;
    let template = if options.page_numbers { include_str!("document.typ").to_string() } else { include_str!("document.typ").lines().filter(|line| !line.starts_with("#set page(footer:")).collect::<Vec<_>>().join("\n") };
    let paper=match options.page_size.as_str() {"letter"=>"us-letter","legal"=>"us-legal","tabloid"=>"us-tabloid","executive"=>"us-executive",other=>other};
    // MiTeX's bundled conversion spec still emits Typst's former `sect`
    // intersection name. Typst 0.15 calls it `inter`. Scope aliases preserve
    // equations without rewriting user TeX or changing the section symbol.
    let accent = &options.theme_accent;
    let themed = if options.themed { "true" } else { "false" };
    let palette = format!("#let smd-themed = {themed}\n#let smd-accent = rgb({})\n#let smd-paper = if smd-themed {{ color.mix((white, 89%), (smd-accent, 11%)) }} else {{ white }}\n#let smd-code-fill = if smd-themed {{ color.mix((white, 79%), (smd-accent, 21%)) }} else {{ rgb(\"#f4f6f8\") }}\n#let smd-callout-fill = if smd-themed {{ color.mix((white, 84%), (smd-accent, 16%)) }} else {{ rgb(\"#f1f4f8\") }}\n#let smd-line = if smd-themed {{ color.mix((white, 55%), (smd-accent, 45%)) }} else {{ rgb(\"#d6dde5\") }}\n#let smd-link = if smd-themed {{ color.mix((rgb(\"#20252d\"), 45%), (smd-accent, 55%)) }} else {{ rgb(\"#315d99\") }}\n", string(accent));
    Ok(format!("#import \"/mitex/standard.typ\": scope as mitex-scope\n#let smd-math-scope = mitex-scope + (sect: sym.inter,)\n{palette}#set page(paper: {}, margin: {}mm, fill: smd-paper)\n#set text(font: ({}, \"Libertinus Serif\", \"New Computer Modern\"), size: {}pt)\n#set par(leading: {}em)\n{template}\n{body}", string(paper), options.margin, string(&options.font_family), options.font_size, options.line_height - 0.7))
}

pub fn export(markdown: &str, options: &PdfOptions, assets: &HashMap<String, Vec<u8>>) -> Result<Vec<u8>> {
    let source = source(markdown, options, assets)?;
    let engine = TypstEngine::builder()
        .main_file(source)
        .fonts([
            include_bytes!("../fonts/NotoSans-Regular.ttf").as_slice(),
            include_bytes!("../fonts/NotoSans-Bold.ttf").as_slice(),
            include_bytes!("../fonts/NotoSans-Italic.ttf").as_slice(),
            include_bytes!("../fonts/NotoSans-BoldItalic.ttf").as_slice(),
            include_bytes!("../fonts/Manrope.ttf").as_slice(),
            include_bytes!("../fonts/Roboto.ttf").as_slice(),
            include_bytes!("../fonts/NotoSerif.ttf").as_slice(),
            include_bytes!("../fonts/JetBrainsMono.ttf").as_slice(),
            include_bytes!("../fonts/NotoEmoji.ttf").as_slice(),
        ].into_iter().chain(assets.iter().filter(|(name,_)| name.starts_with("__font_") && (name.ends_with(".ttf") || name.ends_with(".otf"))).map(|(_,bytes)| bytes.as_slice())))
        .search_fonts_with(TypstKitFontOptions::default().include_system_fonts(!cfg!(target_os="android")).include_embedded_fonts(true))
        .with_static_file_resolver(assets.iter().map(|(k,v)| (k.as_str(), v.as_slice())))
        .with_static_source_file_resolver([
            ("mitex/standard.typ", include_str!("mitex/standard.typ")),
            ("mitex/prelude.typ", include_str!("mitex/prelude.typ")),
        ])
        .build();
    let document = engine.compile().output.map_err(|errors| anyhow::anyhow!("PDF typesetting failed: {errors:?}"))?;
    typst_pdf::pdf(&document, &Default::default()).map(|v| v.to_vec()).map_err(|e| anyhow::anyhow!("PDF encoding failed: {e:?}"))
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_dev_supermd_studio_PdfEngine_fontFamilies(
    mut env: jni::JNIEnv, _class: jni::objects::JClass, path: jni::objects::JString,
) -> jni::sys::jstring {
    let result = (|| -> Result<Vec<String>> {
        let path: String = env.get_string(&path)?.into();
        if std::fs::metadata(&path)?.len()>20_000_000 { bail!("Font exceeds 20 MB"); }
        let bytes=typst::foundations::Bytes::new(std::fs::read(path)?);
        Ok(typst::text::Font::iter(bytes).map(|font| font.info().family.clone()).collect())
    })();
    env.new_string(serde_json::to_string(&result.unwrap_or_default()).unwrap()).unwrap().into_raw()
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_dev_supermd_studio_PdfEngine_imageSources(
    mut env: jni::JNIEnv, _class: jni::objects::JClass, markdown: jni::objects::JString,
) -> jni::sys::jstring {
    let markdown: String = env.get_string(&markdown).expect("Markdown string").into();
    env.new_string(serde_json::to_string(&image_sources(&markdown)).unwrap()).unwrap().into_raw()
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_dev_supermd_studio_PdfEngine_export(
    mut env: jni::JNIEnv, _class: jni::objects::JClass, markdown: jni::objects::JString,
    options: jni::objects::JString, asset_dir: jni::objects::JString, output: jni::objects::JString,
) -> jni::sys::jstring {
    let result = (|| -> Result<()> {
        let markdown: String = env.get_string(&markdown)?.into();
        let options: String = env.get_string(&options)?.into();
        let asset_dir: String = env.get_string(&asset_dir)?.into();
        let output: String = env.get_string(&output)?.into();
        let options: PdfOptions = serde_json::from_str(&options)?;
        let mut assets = HashMap::new();
        for entry in std::fs::read_dir(asset_dir)? {
            let path = entry?.path();
            if path.is_file() { assets.insert(path.file_name().unwrap().to_string_lossy().into_owned(), std::fs::read(path)?); }
        }
        std::fs::write(&output, export(&markdown, &options, &assets)?)?;
        Ok(())
    })();
    env.new_string(result.err().map(|e| format!("{e:#}")).unwrap_or_default()).unwrap().into_raw()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn emoji_font_is_available_without_system_fonts() {
        let bytes = typst::foundations::Bytes::new(include_bytes!("../fonts/NotoEmoji.ttf").as_slice());
        let font = typst::text::Font::iter(bytes).next().expect("Bundled emoji font");
        assert_eq!(font.info().family, "Noto Emoji");
        assert!(export("# Tasks 😊\n\n- [x] Complete ✅\n- [ ] Study 📚", &PdfOptions::default(), &HashMap::new()).unwrap().starts_with(b"%PDF-"));
    }
    #[test]
    fn inner_products_remain_compatible_with_typst_symbols() {
        assert_eq!(compatible_math("angle.l x angle.r \"angle.l\""), "chevron.l x chevron.r \"angle.l\"");
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
                assert!(x < 550., "Wide equation escaped the page: {line}");
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
}
