use std::collections::HashMap;
use smd_core::{source,export,PdfOptions};

#[test]
fn nested_callouts_and_literal_code_delimiters_match_the_reader_contract() {
    let markdown=":::callout note Outer\nOuter body\n\n:::callout tip Inner\nInner body\n:::\n\nAfter inner\n\n````text\n:::callout warning Not a callout\n:::\n```\n````\n:::\n\n# After\n";
    let normalized=smd_core::normalize_callouts(markdown);
    assert!(normalized.contains("> > [!tip] Inner\n> > Inner body\n>\n"));
    assert!(normalized.contains("> After inner"));
    assert!(normalized.contains("> :::callout warning Not a callout\n> :::"));
    assert!(normalized.ends_with("\n# After\n"));
    assert!(export(markdown,&PdfOptions::default(),&HashMap::new()).unwrap().starts_with(b"%PDF-"));
}

#[test]
fn explicit_table_alignments_survive_the_real_pdf_typesetter() {
    for (markdown, alignment) in [
        ("| A | B | C | D |\n| :--- | :---: | ---: | --- |\n| left | middle | 123 | default |", "align: (left,center,right,left,)"),
        ("| A |\n| ---: |\n| 123 |", "align: (right,)"),
    ] {
        let assets=HashMap::new();
        let generated=source(markdown,&PdfOptions::default(),&assets).unwrap();
        assert!(generated.contains(alignment),"{generated}");
        let bytes=export(markdown,&PdfOptions::default(),&assets).unwrap();
        assert!(bytes.starts_with(b"%PDF-"));
    }
}

#[test]
fn staged_pdf_assets_include_only_referenced_images_and_custom_fonts() {
    let temp=std::env::temp_dir().join(format!("supermd-pdf-assets-{}",std::process::id()));
    std::fs::create_dir(&temp).unwrap();
    let result=(|| {
        std::fs::write(temp.join("used.svg"),b"<svg/>").unwrap();
        std::fs::write(temp.join("__font_custom.ttf"),b"font").unwrap();
        let ignored=std::fs::File::create(temp.join("unrelated.bin")).unwrap();ignored.set_len(500_000_000).unwrap();
        let assets=smd_core::pdf_assets::load_referenced_assets("![used](used.svg)",&temp).unwrap();
        assert_eq!(assets.len(),2);assert_eq!(assets["used.svg"],b"<svg/>");assert_eq!(assets["__font_custom.ttf"],b"font");
        let oversized=std::fs::File::create(temp.join("too-big.png")).unwrap();oversized.set_len(smd_core::portable::MAX_IMAGE as u64+1).unwrap();
        assert!(smd_core::pdf_assets::load_referenced_assets("![bad](too-big.png)",&temp).is_err());
    })();
    std::fs::remove_dir_all(&temp).unwrap();
    result
}
