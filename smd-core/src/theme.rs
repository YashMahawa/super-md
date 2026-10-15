//! Portable themes are bounded data, never executable CSS/QML/JavaScript.
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use base64::{engine::general_purpose::STANDARD,Engine as _};

pub const MAX_THEME: usize = 2 * 1024 * 1024;
const MAX_IMAGE: usize = 512 * 1024;
pub const COLORS: &[&str] = &["primary","on-primary","primary-container","on-primary-container","surface","surface-low","surface-high","text","muted","outline","link","heading","code-bg","code-text","code-border","callout-tip","callout-warning","callout-danger","callout-info","callout-example",
    "code-header-bg","code-header-text","inline-code-bg","inline-code-text",
    "python-bg","python-text","python-border","python-header-bg","python-header-text","python-output-bg","python-output-text","python-output-border","python-error-bg","python-error-text","python-run-bg","python-run-text",
    "table-bg","table-text","table-border","table-header-bg","table-header-text","table-row-alt-bg","table-row-hover-bg",
    "callout-bg","callout-text","blockquote-bg","blockquote-text","blockquote-border",
    "syntax-keyword","syntax-string","syntax-number","syntax-function","syntax-builtin","syntax-attr","syntax-type","syntax-comment"];
pub const METRICS: &[(&str, f64, f64)] = &[("controlRadius",0.,28.),("contentRadius",0.,32.),("paragraphSpacing",0.5,2.5),("codePadding",8.,32.),("headingWeight",400.,900.),("headingTracking",-0.05,0.1),("textTracking",-0.03,0.1),("tableBorderWidth",0.,3.),
    ("codeRadius",0.,32.),("pythonRadius",0.,32.),("tableRadius",0.,24.),("calloutRadius",0.,32.),("blockquoteRadius",0.,24.),("tableCellPadding",4.,24.),("tableHeaderWeight",400.,900.),("codeFontScale",0.7,1.4),("pythonSourceMaxHeight",8.,60.),("codeBorderWidth",0.,3.),("pythonBorderWidth",0.,3.),("blockquoteBorderWidth",0.,8.)];

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
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub assets: BTreeMap<String, String>,
}
fn accent() -> String { "blue".into() }
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Variant {
    #[serde(default)]
    pub colors: BTreeMap<String, String>,
    pub background: Option<Background>,
    #[serde(default,skip_serializing_if = "BTreeMap::is_empty")]
    pub artwork: BTreeMap<String,Artwork>,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Artwork {
    pub image: String,
    #[serde(default = "opacity")]
    pub opacity: f64,
    #[serde(default = "art_fit")]
    pub fit: String,
    #[serde(default = "art_position", skip_serializing_if = "centered")]
    pub position: String,
}
fn art_fit()->String {"cover".into()}
fn art_position()->String {"center".into()}
fn centered(value:&str)->bool {value=="center"}
fn asset_id(value:&str)->bool { !value.is_empty()&&value.len()<=64&&value.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-') }
fn validate_art(art:&Artwork,assets:&BTreeMap<String,String>)->Result<()> {
    if !art.opacity.is_finite()||art.opacity<0.||art.opacity>0.25||!["cover","contain"].contains(&art.fit.as_str())||!["center","left","right","top","bottom","top-left","top-right","bottom-left","bottom-right"].contains(&art.position.as_str()) {bail!("Invalid artwork visibility, fit or position");}
    if let Some(id)=art.image.strip_prefix("asset:") {
        if !asset_id(id)||!assets.contains_key(id) {bail!("Unknown artwork asset: {id}");}
        return Ok(());
    }
    validate_image(&art.image)
}
fn validate_image(image:&str)->Result<()> {
    if image.len()>MAX_IMAGE*4/3+128 {bail!("Artwork must be at most 512 KB per image");}
    let Some((prefix,data))=image.split_once(',') else {bail!("Artwork must be an embedded image");};
    let bytes=STANDARD.decode(data)?;
    if bytes.len()>MAX_IMAGE {bail!("Artwork must be at most 512 KB per image");}
    match prefix {
        "data:image/svg+xml;base64"=>{
            if bytes.len()>128*1024 {bail!("Vector artwork must be at most 128 KB");}
            let source=std::str::from_utf8(&bytes)?;
            let doc=roxmltree::Document::parse(source)?;
            if doc.root_element().tag_name().name()!="svg" {bail!("Expected SVG artwork");}
            if doc.descendants().count()>5000 {bail!("Artwork contains too many elements");}
            for node in doc.descendants().filter(|node|node.is_element()) {
                if !["svg","g","path","rect","circle","ellipse","line","polyline","polygon","defs","linearGradient","radialGradient","stop","clipPath","title","desc"].contains(&node.tag_name().name()) {bail!("Artwork supports static vector geometry only");}
                for a in node.attributes() {
                    if !["id","viewBox","width","height","x","y","x1","y1","x2","y2","cx","cy","r","rx","ry","d","points","fill","stroke","stroke-width","stroke-linecap","stroke-linejoin","stroke-dasharray","fill-rule","clip-rule","opacity","fill-opacity","stroke-opacity","transform","offset","stop-color","stop-opacity","gradientUnits","gradientTransform","clip-path","preserveAspectRatio"].contains(&a.name()) {bail!("Unsupported artwork attribute: {}",a.name());}
                    let v=a.value();
                    let internal_url=v.strip_prefix("url(#").and_then(|s|s.strip_suffix(')')).is_some_and(|s|!s.is_empty()&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-'));
                    if v.contains('\\')||v.to_lowercase().contains("url(")&&!internal_url||v.contains("://")||v.contains("data:") {bail!("Artwork cannot load resources");}
                }
            }
        },
        "data:image/png;base64"|"data:image/jpeg;base64"|"data:image/webp;base64"=>{
            let png=bytes.starts_with(b"\x89PNG\r\n\x1a\n");
            let jpeg=bytes.starts_with(b"\xff\xd8\xff");
            let webp=bytes.len()>=16&&&bytes[..4]==b"RIFF"&&&bytes[8..12]==b"WEBP";
            if !(prefix=="data:image/png;base64"&&png||prefix=="data:image/jpeg;base64"&&jpeg||prefix=="data:image/webp;base64"&&webp) {bail!("Artwork type does not match its image bytes");}
            let size=imagesize::blob_size(&bytes)?;
            if size.width==0||size.height==0||size.width>4096||size.height>4096||size.width.saturating_mul(size.height)>4_194_304 {bail!("Artwork exceeds four megapixels or 4096 pixels per side");}
            // Inspect container chunks, not arbitrary compressed pixel bytes.
            if png {
                let mut pos=8;
                while pos+12<=bytes.len() {
                    let len=u32::from_be_bytes(bytes[pos..pos+4].try_into()?) as usize;
                    if &bytes[pos+4..pos+8]==b"acTL" {bail!("Animated artwork is not supported");}
                    pos=pos.checked_add(len+12).ok_or_else(||anyhow::anyhow!("Invalid PNG chunk"))?;
                    if pos>bytes.len() {bail!("Invalid PNG chunk");}
                }
            } else if webp {
                let mut pos=12;
                while pos+8<=bytes.len() {
                    let kind=&bytes[pos..pos+4];
                    let len=u32::from_le_bytes(bytes[pos+4..pos+8].try_into()?) as usize;
                    if kind==b"ANIM"||kind==b"ANMF"||kind==b"VP8X"&&len>=1&&bytes.get(pos+8).is_some_and(|b|b&2!=0) {bail!("Animated artwork is not supported");}
                    pos=pos.checked_add(len+8+(len%2)).ok_or_else(||anyhow::anyhow!("Invalid WebP chunk"))?;
                    if pos>bytes.len() {bail!("Invalid WebP chunk");}
                }
            }
        },
        _=>bail!("Artwork accepts embedded static SVG, PNG, JPEG or WebP only"),
    }
    Ok(())
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
    #[serde(default = "motif_size", skip_serializing_if = "default_motif_size")]
    pub size: f64,
    #[serde(default)]
    pub angle: f64,
}
fn opacity() -> f64 { 0.06 }
fn spacing() -> f64 { 24. }
fn motif_size() -> f64 { 24. }
fn default_motif_size(value: &f64) -> bool { *value == 24. }
fn color(value: &str) -> bool { value.len()==7 && value.starts_with('#') && value[1..].bytes().all(|c| c.is_ascii_hexdigit()) }
pub fn parse(input: &str) -> Result<Theme> {
    if input.len()>MAX_THEME { bail!("Theme exceeds 2 MB"); }
    let theme:Theme=serde_json::from_str(input.trim_start_matches('\u{feff}'))?;
    if theme.format!="supermd-theme" || theme.version!=1 { bail!("Expected supermd-theme version 1"); }
    if theme.name.trim().is_empty() || theme.name.chars().count()>80 || theme.name.chars().any(|c| c.is_control() || matches!(c,'<'|'>')) { bail!("Theme name must contain 1–80 printable characters without markup brackets"); }
    if !["blue","violet","rose","amber"].contains(&theme.accent.as_str()) { bail!("Unknown base accent"); }
    if theme.assets.len()>8 {bail!("A theme supports at most eight reusable assets");}
    for (id,image) in &theme.assets {
        if !asset_id(id) {bail!("Asset names must use 1–64 letters, numbers, hyphens or underscores");}
        validate_image(image)?;
    }
    for (key,value) in &theme.metrics {
        let Some((_,min,max))=METRICS.iter().find(|(name,_,_)| *name==key) else { bail!("Unknown metric: {key}"); };
        if !value.is_finite() || value<min || value>max { bail!("{key} must be between {min} and {max}"); }
    }
    for (mode,variant) in &theme.variants {
        if !["light","dark","black"].contains(&mode.as_str()) { bail!("Unknown theme variant: {mode}"); }
        for (area,art) in &variant.artwork {
            if !["reader","sidebar","toolbar"].contains(&area.as_str()) {bail!("Unknown artwork area: {area}");}
            validate_art(art,&theme.assets)?;
        }
        for (key,value) in &variant.colors {
            if !COLORS.contains(&key.as_str()) || !color(value) { bail!("Invalid color role: {key}; use #RRGGBB"); }
        }
        if let Some(bg)=&variant.background {
            if !["none","dots","grid","diagonal","gradient","paws"].contains(&bg.pattern.as_str()) || !color(&bg.color) { bail!("Invalid background pattern or color"); }
            for (value,min,max) in [(bg.opacity,0.,0.25),(bg.spacing,12.,192.),(bg.size,8.,64.),(bg.angle,0.,360.)] {
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
    #[test] fn component_roles_and_metrics_roundtrip_and_are_bounded() {
        let mut v=sample();
        for role in COLORS { v["variants"]["dark"]["colors"][*role]=serde_json::json!("#345678"); }
        for (key,min,max) in METRICS {v["metrics"][*key]=serde_json::json!((min+max)/2.);}
        let theme=parse(&v.to_string()).unwrap();
        assert_eq!(theme.variants["dark"].colors["table-border"],"#345678");
        assert_eq!(parse(&serde_json::to_string(&theme).unwrap()).unwrap().metrics,theme.metrics);
        for (key,min,max) in METRICS {
            for value in [min-1.,max+1.] {let mut invalid=v.clone();invalid["metrics"][*key]=serde_json::json!(value);assert!(parse(&invalid.to_string()).is_err(),"{key}");}
        }
        for value in ["url(https://example.com)","red","#ffffff;background:red"] {let mut invalid=v.clone();invalid["variants"]["dark"]["colors"]["python-bg"]=serde_json::json!(value);assert!(parse(&invalid.to_string()).is_err());}
    }
    #[test] fn bundled_examples_all_use_the_documented_format() {
        for input in [include_str!("../../public/themes/copper-grid.supermd-theme.json"),include_str!("../../public/themes/ink-dots.supermd-theme.json"),include_str!("../../public/themes/rose-paper.supermd-theme.json"),include_str!("../../public/themes/catnap-paws.supermd-theme.json"),include_str!("../../public/themes/midnight-paws.supermd-theme.json"),include_str!("../../public/themes/blueprint.supermd-theme.json"),include_str!("../../public/themes/plum-linen.supermd-theme.json"),include_str!("../../public/themes/apricot-glow.supermd-theme.json")] {assert!(!parse(input).unwrap().name.is_empty());}
    }
    #[test] fn paw_pattern_controls_are_bounded_and_roundtrip() {
        let mut v=sample();
        v["variants"]["dark"]["background"]=serde_json::json!({"pattern":"paws","color":"#aabbcc","opacity":0.12,"spacing":112,"size":30,"angle":342});
        let theme=parse(&v.to_string()).unwrap();
        assert_eq!(theme.variants["dark"].background.as_ref().unwrap().size,30.);
        assert!(parse(&serde_json::to_string(&theme).unwrap()).is_ok());
        for (key,value) in [("size",0.),("size",65.),("spacing",193.),("opacity",0.26)] {
            let mut invalid=v.clone();invalid["variants"]["dark"]["background"][key]=serde_json::json!(value);
            assert!(parse(&invalid.to_string()).is_err());
        }
    }
    #[test] fn all_gallery_themes_validate_with_embedded_art() {
        let path=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../public/themes");
        for entry in std::fs::read_dir(path).unwrap() {
            let path=entry.unwrap().path();if path.extension().is_some_and(|ext|ext=="json") {
                let raw=std::fs::read_to_string(&path).unwrap();assert!(parse(&raw).is_ok(),"{}: {:?}",path.display(),parse(&raw).err());
            }
        }
    }
    #[test] fn embedded_art_refuses_active_content_resources_and_oversized_images() {
        for body in ["<script/>","<rect onclick='x()'/>","<image href='https://example.com/a.png'/>","<rect style='fill:red'/>","<animate/>","<path fill='url(#a) url(https://example.com)'/>"] {
            let svg=format!("<svg xmlns='http://www.w3.org/2000/svg'>{body}</svg>");
            let art=Artwork{image:format!("data:image/svg+xml;base64,{}",STANDARD.encode(svg)),opacity:0.1,fit:"cover".into(),position:art_position()};
            assert!(validate_art(&art,&BTreeMap::new()).is_err(),"{body}");
        }
        let svg="<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 500 400'><path d='M0 0L100 100' stroke='#123456'/></svg>";
        let art=Artwork{image:format!("data:image/svg+xml;base64,{}",STANDARD.encode(svg)),opacity:0.1,fit:"contain".into(),position:art_position()};
        assert!(validate_art(&art,&BTreeMap::new()).is_ok());
        assert!(validate_art(&Artwork{image:"https://example.com/art.svg".into(),..art.clone()},&BTreeMap::new()).is_err());
        assert!(validate_art(&Artwork{image:format!("data:image/svg+xml;base64,{}",STANDARD.encode(" ".repeat(128*1024+1))),..art},&BTreeMap::new()).is_err());
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
    #[test] fn shared_raster_assets_roundtrip_and_reject_missing_references_or_spoofed_types() {
        let fixtures: BTreeMap<String,String>=serde_json::from_str(include_str!("../../test-fixtures/theme-artwork.json")).unwrap();
        let mut v=sample();v["assets"]=serde_json::json!(fixtures);
        v["variants"]["dark"]["artwork"]=serde_json::json!({"reader":{"image":"asset:jpeg","position":"right","opacity":0.2},"sidebar":{"image":"asset:webp"},"toolbar":{"image":"asset:png"}});
        let parsed=parse(&v.to_string()).unwrap();
        assert_eq!(parsed.assets.len(),3);
        assert_eq!(parsed.variants["dark"].artwork["reader"].image,"asset:jpeg");
        assert!(parse(&serde_json::to_string(&parsed).unwrap()).is_ok());
        let mut bad=v.clone();bad["variants"]["dark"]["artwork"]["reader"]["image"]=serde_json::json!("asset:missing");assert!(parse(&bad.to_string()).is_err());
        let mut bad=v.clone();bad["assets"]["jpeg"]=serde_json::json!(fixtures["jpeg"].replace("image/jpeg","image/png"));assert!(parse(&bad.to_string()).is_err());
        let mut bad=v.clone();bad["variants"]["dark"]["artwork"]["reader"]["position"]=serde_json::json!("url(file:///secret)");assert!(parse(&bad.to_string()).is_err());
        let mut bytes=STANDARD.decode(fixtures["webp"].split_once(',').unwrap().1).unwrap();bytes[20]|=2;
        assert!(validate_image(&format!("data:image/webp;base64,{}",STANDARD.encode(bytes))).is_err());
        for (id,uri) in fixtures {assert!(validate_image(&uri).is_ok(),"{id}");}
    }
}
