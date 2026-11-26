//! The same local typesetter is used by desktop and Android. No browser print layout.
pub mod portable;
pub mod theme;
pub mod pdf_assets;
pub mod frontmatter;
mod diagram;
mod html_scan;
#[cfg(target_os = "android")]
mod jni_bridge;
mod math_compatibility;
mod normalize;
mod step_grid;
mod study;
mod typesetter;
pub use normalize::{image_sources, normalize_callouts};
pub use study::strip_percent_comments;
#[doc(hidden)]
pub use typesetter::{diagnostics, COMEMO_EVICT_MAX_AGE, CUSTOM_FONT_CACHE_MAX_BYTES, CUSTOM_FONT_CACHE_MAX_ENTRIES};
pub(crate) use typesetter::{is_font_asset, validate_asset_path};
use html_scan::{consume_image_brace_attrs, format_smd_image, is_page_break_div, parse_html_images, strip_html_comments};
use math_compatibility::compatible_math;
use anyhow::{bail, Result};
use pulldown_cmark::{Alignment, CodeBlockKind, Event, Options, Tag, TagEnd};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PdfOptions {
    pub page_size: String,
    pub margin: f32,
    pub font_size: f32,
    pub line_height: f32,
    pub paragraph_spacing: f32,
    pub font_family: String,
    pub page_numbers: bool,
    pub themed: bool,
    pub theme_accent: String,
}
impl Default for PdfOptions {
    fn default() -> Self {
        Self { page_size: "a4".into(), margin: 14., font_size: 10.5, line_height: 1.4, paragraph_spacing: 0.65, font_family: "Manrope".into(), page_numbers: true, themed: false, theme_accent: "#386a57".into() }
    }
}
impl PdfOptions {
    pub fn validate(&self) -> Result<()> {
        if !["a3", "a4", "a5", "a6", "iso-b4", "iso-b5", "iso-b6", "letter", "legal", "tabloid", "executive"].contains(&self.page_size.as_str()) { bail!("Unsupported page size"); }
        for (name, value, min, max) in [("margin", self.margin, 4., 60.), ("font size", self.font_size, 5., 24.), ("line height", self.line_height, 0.9, 2.2), ("paragraph spacing", self.paragraph_spacing, 0., 3.)] {
            if !value.is_finite() || value < min || value > max { bail!("Invalid {name}: expected {min} to {max}"); }
        }
        if self.font_family.len() > 120 { bail!("Font name is too long"); }
        if self.theme_accent.len() != 7 || !self.theme_accent.starts_with('#') || !self.theme_accent[1..].chars().all(|c| c.is_ascii_hexdigit()) { bail!("Invalid PDF theme accent"); }
        Ok(())
    }
}

pub(crate) fn string(value: &str) -> String { serde_json::to_string(value).unwrap() }
pub(crate) fn text(value: &str) -> String { format!("#text({})", string(value)) }

struct Renderer<'a> {
    events: std::iter::Peekable<std::vec::IntoIter<Event<'a>>>,
    assets: &'a HashMap<String, Vec<u8>>,
    footnotes: HashMap<String, String>,
    headings: HashMap<String, usize>,
    heading_counts: HashMap<String, usize>,
}
pub(crate) fn heading_slug(value: &str) -> String {
    let value = value.to_lowercase().chars().filter(|c| c.is_alphanumeric() || c.is_whitespace() || *c == '-' || *c == '_').collect::<String>();
    let slug = value.trim().chars().map(|c| if c.is_whitespace() { '-' } else { c }).collect::<String>();
    if slug.is_empty() { "section".into() } else { slug }
}
fn parse_braced_fence_language(raw_info: &str) -> Option<&'static str> {
    let trimmed = raw_info.trim();
    let inner = trimmed.strip_prefix('{')?.strip_suffix('}')?.trim();
    let rest = inner.strip_prefix('.').unwrap_or(inner);
    let first = rest.as_bytes().first().copied()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    let ident_len = rest
        .bytes()
        .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
        .count();
    let tail = &rest[ident_len..];
    if !tail.is_empty() && !tail.starts_with(|c: char| c.is_whitespace() || c == ',' || c == '#') {
        return None;
    }
    match rest[..ident_len].to_ascii_lowercase().as_str() {
        "python" => Some("python"),
        "py" => Some("py"),
        "mermaid" => Some("mermaid"),
        _ => None,
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum RenderStop<'b> {
    Tag(TagEnd),
    Html(&'b str),
}
impl<'a> Renderer<'a> {
    fn render_html(&self, html: &str, is_block: bool, out: &mut String) -> Result<()> {
        let clean = strip_html_comments(html);
        let trimmed = clean.trim();
        if trimmed.len() >= 3 && trimmed[..3].eq_ignore_ascii_case("<br") {
            out.push_str("#linebreak()");
        } else if diagram::looks_like_svg(trimmed) {
            let svg = diagram::validate_svg(trimmed)?;
            out.push_str(&format!("\n#smd-image(bytes({}), format: \"svg\")\n\n", string(&svg)));
        } else if is_page_break_div(html) {
            out.push_str(if is_block { "\n#pagebreak()\n\n" } else { "#pagebreak()" });
        } else {
            let imgs = parse_html_images(html);
            if imgs.is_empty() {
                if !clean.is_empty() {
                    out.push_str(&text(&clean));
                }
            } else {
                for img in imgs {
                    validate_asset_path(&img.src)?;
                    if is_font_asset(&img.src) || !self.assets.contains_key(&img.src) {
                        bail!("Image unavailable for PDF: {}", img.src);
                    }
                    out.push_str(&format_smd_image(&img.src, img.width.as_deref(), img.zoom.as_deref()));
                    if is_block {
                        out.push_str("\n\n");
                    }
                }
            }
        }
        Ok(())
    }

    fn render(&mut self, end: Option<TagEnd>) -> Result<String> {
        self.render_until(end.map(RenderStop::Tag))
    }
    fn render_until(&mut self, end: Option<RenderStop<'_>>) -> Result<String> {
        let mut out = String::new();
        while let Some(event) = self.events.next() {
            match event {
                Event::End(tag) if end == Some(RenderStop::Tag(tag)) => break,
                Event::End(_) => {},
                Event::InlineHtml(ref html) if end == Some(RenderStop::Html(html.as_ref())) => break,
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
                Event::Html(ref html) | Event::InlineHtml(ref html) => match html.as_ref() {
                    "<mark>" => out.push_str(&format!("#highlight(fill: smd-highlight, radius: 2pt, extent: 1pt)[{}]", self.render_until(Some(RenderStop::Html("</mark>")))?)),
                    "<u>" => out.push_str(&format!("#underline[{}]", self.render_until(Some(RenderStop::Html("</u>")))?)),
                    "<kbd>" => out.push_str(&format!("#box(fill: smd-code-fill, stroke: .5pt + smd-line, inset: (x: 3.5pt, y: 1pt), outset: (y: 1.5pt), radius: 2.5pt)[#text(font: (\"JetBrains Mono\", \"DejaVu Sans Mono\"), size: .86em)[{}]]", self.render_until(Some(RenderStop::Html("</kbd>")))?)),
                    "</mark>" | "</u>" | "</kbd>" => {}
                    _ => self.render_html(html, matches!(&event, Event::Html(_)), &mut out)?,
                },
                Event::Start(tag) => {
                    let close = tag.to_end();
                    match tag {
                        Tag::HtmlBlock => {
                            let mut html = String::new();
                            while let Some(e) = self.events.next() {
                                if e == Event::End(close) { break; }
                                if let Event::Html(v) | Event::Text(v) = e { html.push_str(&v); }
                            }
                            self.render_html(&html, true, &mut out)?;
                        },
                        Tag::CodeBlock(kind) => {
                            let mut code = String::new();
                            while let Some(e) = self.events.next() { if e == Event::End(close) { break; } if let Event::Text(v) = e { code.push_str(&v); } }
                            let info = match kind { CodeBlockKind::Fenced(v) => v.to_string(), _ => String::new() };
                            let braced = parse_braced_fence_language(&info);
                            let lang_token = braced.unwrap_or_else(|| info.split_whitespace().next().unwrap_or(""));
                            let lang = lang_token.to_ascii_lowercase();
                            if ["smd-steps", "smd-step-grid"].contains(&lang.as_str()) {
                                out.push_str(&step_grid::render(&code, self.assets)?);
                                continue;
                            }
                            if ["mermaid", "smd-chart"].contains(&lang.as_str()) { bail!("Export preparation did not render a {lang} block"); }
                            let raw_svg_fence = (lang.is_empty() || ["xml", "html", "svg+xml", "image/svg+xml"].contains(&lang.as_str()))
                                && diagram::looks_like_svg(&code);
                            if ["svg", "smd-tree", "smd-diagram"].contains(&lang.as_str()) || raw_svg_fence {
                                let vector_kind = if matches!(lang.as_str(), "smd-tree" | "smd-diagram") { lang.as_str() } else { "svg" };
                                let svg = diagram::render_vector_block(vector_kind, &code)?;
                                out.push_str(&format!("\n#smd-image(bytes({}), format: \"svg\")\n\n", string(&svg)));
                                continue;
                            }
                            // Highlight the whole block once and fit individual
                            // synthesized lines inside a breakable container.
                            let code_arg = if code.is_empty() {
                                "none".into()
                            } else {
                                string(code.strip_suffix("\r\n").or_else(|| code.strip_suffix('\n')).unwrap_or(&code))
                            };
                            let lang_arg = if lang_token.is_empty() { "none".into() } else { string(lang_token) };
                            out.push_str(&format!("\n#smd-code({code_arg}, lang: {lang_arg})\n\n"));
                        },
                        Tag::Image { dest_url, .. } => {
                            let _alt = self.render(Some(close))?;
                            let key = dest_url.to_string();
                            validate_asset_path(&key)?;
                            if is_font_asset(&key) || !self.assets.contains_key(&key) { bail!("Image unavailable for PDF: {key}"); }
                            let (width, zoom, trailing) = consume_image_brace_attrs(&mut self.events);
                            out.push_str(&format_smd_image(&key, width.as_deref(), zoom.as_deref()));
                            if let Some(rem) = trailing {
                                if !rem.is_empty() {
                                    out.push_str(&text(&rem));
                                }
                            }
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
                            let alignments = columns.iter().map(|column| match column {
                                Alignment::Center => "center,",
                                Alignment::Right => "right,",
                                _ => "left,",
                            }).collect::<String>();
                            out.push_str(&format!("\n#table(columns: ({widths}), align: ({alignments}), inset: 6pt, stroke: .4pt + smd-line, fill: (x, y) => if y == 0 {{ smd-header-fill }} else {{ none }},\n"));
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
                                let accent = match kind.as_str() { "tip" | "hint" | "success" | "check" | "done" => "#14735b", "warning" | "caution" => "#946200", "danger" | "error" | "failure" | "fail" | "missing" => "#b3261e", _ => "#315d99" };
                                let icon = match kind.as_str() {"tip"|"hint"=>"tip","warning"|"caution"=>"warning","danger"|"error"=>"error","success"|"check"|"done"=>"success","question"|"faq"=>"question","answer"|"solution"=>"answer","example"=>"example","quote"|"cite"=>"quote",_=>"info"};
                                (format!("#block(sticky: true, below: 6pt)[#text(weight: \"bold\", fill: rgb(\"{accent}\"))[#box(image(\"__smd_icon_{icon}.svg\", width: 11pt)) #h(4pt) {}]]\n\n{body}", text(&title)), accent)
                            } else { (self.render(Some(close))?, "#315d99") };
                            out.push_str(&format!("\n#block(width: 100%, breakable: true, fill: if smd-themed {{ smd-callout-fill }} else {{ color.mix((white, 94%), (rgb(\"{accent}\"), 6%)) }}, stroke: (left: 2pt + rgb(\"{accent}\")), inset: 10pt, radius: 4pt)[{body}]\n\n"));
                        },
                        _ => {
                            if matches!(tag, Tag::Paragraph) {
                                let mut plain_only = true;
                                let mut raw_para = String::new();
                                for e in self.events.clone().take_while(|e| !matches!(e, Event::End(TagEnd::Paragraph))) {
                                    match e {
                                        Event::Text(v) | Event::InlineHtml(v) => raw_para.push_str(&v),
                                        Event::SoftBreak => raw_para.push('\n'),
                                        _ => { plain_only = false; break; }
                                    }
                                }
                                let trimmed = raw_para.trim();
                                let is_quarto_break = trimmed
                                    .strip_prefix("{{<")
                                    .and_then(|s| s.strip_suffix(">}}"))
                                    .is_some_and(|s| s.trim() == "pagebreak");
                                if plain_only && (trimmed == "\\newpage" || trimmed == "\\pagebreak" || is_quarto_break) {
                                    for e in self.events.by_ref() {
                                        if e == Event::End(TagEnd::Paragraph) { break; }
                                    }
                                    out.push_str("#pagebreak()\n\n");
                                    continue;
                                }
                            }
                            let heading = if matches!(tag, Tag::Heading { .. }) {
                                let plain = self.events.clone().take_while(|e| !matches!(e, Event::End(TagEnd::Heading(_)))).filter_map(|e| match e { Event::Text(v) | Event::Code(v) | Event::InlineMath(v) => Some(v.to_string()), _ => None }).collect::<String>();
                                let slug = heading_slug(&plain); let count = self.heading_counts.entry(slug.clone()).or_default();
                                let id = if *count == 0 { slug } else { format!("{slug}-{count}") }; *count += 1; Some(id)
                            } else { None };
                            let body = self.render(Some(close))?;
                            match tag {
                                Tag::Paragraph => { if body.starts_with("#strong[") && body.ends_with(']') { out.push_str(&format!("#block(sticky: true, below: .35em)[{body}]\n\n")); } else { out.push_str(&format!("{body}\n\n")); } },
                                Tag::Heading { level, .. } => out.push_str(&format!("\n#heading(level: {})[{body}] <smd-{}>\n\n", level as u8, heading.unwrap())),
                                Tag::Emphasis => out.push_str(&format!("#emph[{body}]")),
                                Tag::Strong => out.push_str(&format!("#strong[{body}]")),
                                Tag::Strikethrough => out.push_str(&format!("#strike[{body}]")),
                                Tag::Subscript => out.push_str(&format!("#sub[{body}]")),
                                Tag::Superscript => out.push_str(&format!("#super[{body}]")),
                                Tag::List(start) => out.push_str(&if let Some(start) = start { format!("\n#enum(start: {start}, {body})\n") } else { format!("\n#list({body})\n") }),
                                Tag::Item => out.push_str(&format!("[{body}],\n")),
                                Tag::Link { dest_url, .. } => out.push_str(&if let Some(fragment) = dest_url.strip_prefix('#') {
                                    let decoded = percent_encoding::percent_decode_str(fragment).decode_utf8_lossy();
                                    let trimmed = decoded.trim();
                                    let slug = heading_slug(trimmed);
                                    let resolved = if self.headings.contains_key(trimmed) {
                                        Some(trimmed.to_string())
                                    } else if self.headings.contains_key(&slug) {
                                        Some(slug)
                                    } else if let Some((prefix, suffix)) = trimmed.rsplit_once('-') {
                                        let numbered = format!("{}-{suffix}", heading_slug(prefix));
                                        (suffix.chars().all(|c| c.is_ascii_digit()) && self.headings.contains_key(&numbered)).then_some(numbered)
                                    } else {
                                        None
                                    };
                                    if let Some(id) = resolved { format!("#link(label({}))[{body}]", string(&format!("smd-{id}"))) } else { body }
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

pub(crate) fn render_fragment(markdown: &str, assets: &HashMap<String, Vec<u8>>) -> Result<String> {
    let normalized = normalize::prepare_markdown_body(frontmatter::strip_frontmatter(markdown), true);
    let events = study::enrich_events(&normalized, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_SUBSCRIPT | Options::ENABLE_SUPERSCRIPT | Options::ENABLE_MATH);
    Renderer { events: events.into_iter().peekable(), assets, footnotes: HashMap::new(), headings: HashMap::new(), heading_counts: HashMap::new() }.render(None)
}

pub fn source(markdown: &str, options: &PdfOptions, assets: &HashMap<String, Vec<u8>>) -> Result<String> {
    options.validate()?;
    let (doc_metadata, raw_body) = match frontmatter::parse_frontmatter(markdown) {
        Some(fm) => (fm.metadata.typst_set_document(), &markdown[fm.end..]),
        None => (String::new(), markdown.strip_prefix('\u{feff}').unwrap_or(markdown)),
    };
    let normalized = normalize::prepare_markdown_body(raw_body, true);
    let events = study::enrich_events(&normalized, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_SUBSCRIPT | Options::ENABLE_SUPERSCRIPT | Options::ENABLE_TASKLISTS | Options::ENABLE_MATH | Options::ENABLE_FOOTNOTES);
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
    let template: &str = if options.page_numbers { include_str!("document.typ") } else { &typesetter::UNNUMBERED_DOCUMENT_TEMPLATE };
    let paper=match options.page_size.as_str() {"letter"=>"us-letter","legal"=>"us-legal","tabloid"=>"us-tabloid","executive"=>"us-executive",other=>other};
    // MiTeX's bundled conversion spec still emits Typst's former `sect`
    // intersection name. Typst 0.15 calls it `inter`. Scope aliases preserve
    // equations without rewriting user TeX or changing the section symbol.
    let accent = if options.themed { &options.theme_accent } else { "#555555" };
    let themed = if options.themed { "true" } else { "false" };
    let palette = format!(r##"#let smd-themed = {themed}
#let smd-accent = rgb({})
#let smd-paper = if smd-themed {{ color.mix((white, 89%), (smd-accent, 11%)) }} else {{ white }}
#let smd-code-fill = if smd-themed {{ color.mix((white, 79%), (smd-accent, 21%)) }} else {{ rgb("#f4f4f4") }}
#let smd-callout-fill = if smd-themed {{ color.mix((white, 84%), (smd-accent, 16%)) }} else {{ rgb("#f2f2f2") }}
#let smd-header-fill = if smd-themed {{ color.mix((white, 76%), (smd-accent, 24%)) }} else {{ rgb("#e7e7e7") }}
#let smd-line = if smd-themed {{ color.mix((white, 55%), (smd-accent, 45%)) }} else {{ rgb("#d6d6d6") }}
#let smd-link = if smd-themed {{ color.mix((rgb("#202020"), 45%), (smd-accent, 55%)) }} else {{ rgb("#315d99") }}
#let smd-highlight = if smd-themed {{ color.mix((smd-paper, 58%), (rgb("#f6c945"), 42%)) }} else {{ rgb("#fff2a8") }}
"##, string(accent));
    // Typst collapses paragraph spacing against leading. Add leading so the
    // export control specifies the visible gap instead of disappearing below it.
    Ok(format!("#import \"/mitex/standard.typ\": scope as mitex-scope\n#let smd-math-scope = mitex-scope + (sect: sym.inter,)\n{palette}{doc_metadata}#set page(paper: {}, margin: {}mm, fill: smd-paper)\n#set text(font: ({}, \"Libertinus Serif\", \"New Computer Modern\"), size: {}pt)\n#set par(leading: {}em, spacing: {}em)\n{template}\n{body}", string(paper), options.margin, string(&options.font_family), options.font_size, options.line_height - 0.7, options.line_height - 0.7 + options.paragraph_spacing))
}

pub fn export(markdown: &str, options: &PdfOptions, assets: &HashMap<String, Vec<u8>>) -> Result<Vec<u8>> {
    let source = source(markdown, options, assets)?;
    typesetter::export_typst(source, options, assets)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renderer_strips_single_crlf_on_raw_code_block_events() {
        let raw_crlf_events = vec![
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced("rust".into()))),
            Event::Text("let a = 1;\r\nlet b = 2;\r\n".into()),
            Event::End(TagEnd::CodeBlock),
        ];
        let raw_crlf_out = Renderer {
            events: raw_crlf_events.into_iter().peekable(),
            assets: &HashMap::new(),
            footnotes: HashMap::new(),
            headings: HashMap::new(),
            heading_counts: HashMap::new(),
        }
        .render(None)
        .unwrap();
        assert_eq!(raw_crlf_out.trim(), "#smd-code(\"let a = 1;\\r\\nlet b = 2;\", lang: \"rust\")");
    }
}
