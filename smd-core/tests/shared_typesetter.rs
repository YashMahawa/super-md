//! Process-isolated tests for shared invariant resources, zero OS font scans on
//! built-in/custom fonts, custom .ttf/.otf caching and precedence, post-PDF
//! comemo eviction, concurrent exports, and invalid asset path handling.
use smd_core::{
    diagnostics, export, source, PdfOptions, COMEMO_EVICT_MAX_AGE, CUSTOM_FONT_CACHE_MAX_BYTES,
    CUSTOM_FONT_CACHE_MAX_ENTRIES,
};
use std::collections::HashMap;
use std::sync::{Arc, Barrier};

fn rename_opentype_font(raw: &[u8], family: &str, postscript: &str) -> Vec<u8> {
    let num_tables = u16::from_be_bytes([raw[4], raw[5]]) as usize;
    let full_name = format!("{family} Regular");
    let entries: [(u16, &str); 7] = [
        (1, family),
        (2, "Regular"),
        (3, postscript),
        (4, &full_name),
        (6, postscript),
        (16, family),
        (17, "Regular"),
    ];

    let header_len = 6 + entries.len() * 12;
    let mut records = Vec::with_capacity(entries.len() * 12);
    let mut strings = Vec::new();
    for (name_id, value) in entries {
        let encoded: Vec<u8> = value.encode_utf16().flat_map(u16::to_be_bytes).collect();
        let offset = strings.len() as u16;
        let length = encoded.len() as u16;
        strings.extend_from_slice(&encoded);
        records.extend_from_slice(&3u16.to_be_bytes());
        records.extend_from_slice(&1u16.to_be_bytes());
        records.extend_from_slice(&0x0409u16.to_be_bytes());
        records.extend_from_slice(&name_id.to_be_bytes());
        records.extend_from_slice(&length.to_be_bytes());
        records.extend_from_slice(&offset.to_be_bytes());
    }

    let mut name_table = Vec::with_capacity(header_len + strings.len());
    name_table.extend_from_slice(&0u16.to_be_bytes());
    name_table.extend_from_slice(&(entries.len() as u16).to_be_bytes());
    name_table.extend_from_slice(&(header_len as u16).to_be_bytes());
    name_table.extend_from_slice(&records);
    name_table.extend_from_slice(&strings);

    let mut checksum = 0u32;
    for chunk in name_table.chunks(4) {
        let mut buf = [0u8; 4];
        buf[..chunk.len()].copy_from_slice(chunk);
        checksum = checksum.wrapping_add(u32::from_be_bytes(buf));
    }

    let mut out = raw.to_vec();
    while out.len() % 4 != 0 {
        out.push(0);
    }
    let new_offset = out.len() as u32;
    let new_length = name_table.len() as u32;
    out.extend_from_slice(&name_table);
    while out.len() % 4 != 0 {
        out.push(0);
    }

    let mut patched = false;
    for i in 0..num_tables {
        let rec = 12 + i * 16;
        if &out[rec..rec + 4] == b"name" {
            out[rec + 4..rec + 8].copy_from_slice(&checksum.to_be_bytes());
            out[rec + 8..rec + 12].copy_from_slice(&new_offset.to_be_bytes());
            out[rec + 12..rec + 16].copy_from_slice(&new_length.to_be_bytes());
            patched = true;
            break;
        }
    }
    assert!(patched, "Expected sfnt name table");
    out
}

fn minimal_valid_png(r: u8, g: u8, b: u8) -> Vec<u8> {
    fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut body = Vec::with_capacity(4 + data.len());
        body.extend_from_slice(kind);
        body.extend_from_slice(data);
        let mut crc = 0xffff_ffffu32;
        for &byte in &body {
            crc ^= byte as u32;
            for _ in 0..8 {
                crc = if crc & 1 != 0 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
            }
        }
        crc = !crc;
        let mut out = Vec::with_capacity(12 + data.len());
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend_from_slice(&body);
        out.extend_from_slice(&crc.to_be_bytes());
        out
    }

    // Valid zlib stream (CMF=0x78, FLG=0x01, uncompressed block of 4 bytes: filter=0, R, G, B + Adler32)
    let raw = [0u8, r, g, b];
    let mut s1 = 1u32;
    let mut s2 = 0u32;
    for &byte in &raw {
        s1 = (s1 + byte as u32) % 65521;
        s2 = (s2 + s1) % 65521;
    }
    let adler = (s2 << 16) | s1;
    let mut idat = vec![0x78, 0x01, 0x01, 0x04, 0x00, 0xfb, 0xff];
    idat.extend_from_slice(&raw);
    idat.extend_from_slice(&adler.to_be_bytes());

    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    png.extend_from_slice(&chunk(b"IHDR", &[0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]));
    png.extend_from_slice(&chunk(b"IDAT", &idat));
    png.extend_from_slice(&chunk(b"IEND", &[]));
    png
}

#[test]
fn shared_typesetting_suite_runs_without_host_os_font_scans() {
    // 1. Invariant static buffers are backed directly by static slices (zero heap copies)
    //    and retain identical pointers across repeat exports.
    let before_ptrs = diagnostics::shared_resource_pointers();
    let static_fonts = diagnostics::static_font_slice_ptrs();
    for (idx, &static_ptr) in static_fonts.iter().enumerate() {
        assert_eq!(
            before_ptrs.bundled_font_ptrs[idx], static_ptr,
            "Bundled font {idx} must wrap &'static [u8] directly without heap copying"
        );
    }
    assert_eq!(
        before_ptrs.icon_ptrs,
        diagnostics::static_icon_slice_ptrs(),
        "Callout icons must wrap &'static [u8] directly without heap copying"
    );

    // 2. Built-in, embedded, empty, and case-varied font families never scan host OS fonts.
    for family in [
        "",
        "Manrope",
        "manrope",
        "MANROPE",
        "Roboto",
        "Noto Serif",
        "JetBrains Mono",
        "Noto Sans",
        "Libertinus Serif",
        "libertinus serif",
        "New Computer Modern",
        "DejaVu Sans Mono",
    ] {
        let opts = PdfOptions {
            font_family: family.into(),
            ..PdfOptions::default()
        };
        let md = "# Shared Note\n\n> [!TIP] Callout\n> Inline math $e^{i\\pi}+1=0$ and `code`.";
        let pdf = export(md, &opts, &HashMap::new()).expect("built-in export");
        assert!(pdf.starts_with(b"%PDF-"));
    }
    assert_eq!(
        diagnostics::system_font_scan_count(),
        0,
        "Default, built-in, and embedded fonts must perform zero OS font scans"
    );

    let after_ptrs = diagnostics::shared_resource_pointers();
    assert_eq!(
        before_ptrs, after_ptrs,
        "Repeat exports must reuse identical shared font, icon, template, and library allocations"
    );

    // 3. Custom .ttf/.TTF and .otf/.OTF fonts embed in PDF, stay excluded from binary/image
    //    asset maps, override bundled/embedded/OS fonts, and cache parsed faces by content hash.
    diagnostics::clear_custom_font_cache();
    let base_ttf = include_bytes!("../fonts/NotoSans-Regular.ttf");
    let base_otf = diagnostics::embedded_otf_font_bytes();
    assert!(base_otf.starts_with(b"OTTO"));

    let custom_ttf = rename_opentype_font(base_ttf, "CustomLabSans", "CustomLabSans-Regular");
    let custom_otf = rename_opentype_font(&base_otf, "CustomLabOtf", "CustomLabOtf-Regular");
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="teal"/></svg>"#.to_vec();

    let ttf_assets = HashMap::from([
        ("__font_UpperCase.TTF".to_string(), custom_ttf.clone()),
        ("diagram.svg".to_string(), svg.clone()),
    ]);
    assert_eq!(
        diagnostics::binary_asset_count_for_export(
            &PdfOptions { font_family: "CustomLabSans".into(), ..PdfOptions::default() },
            &ttf_assets,
        )
        .unwrap(),
        1,
        "Custom .TTF font bytes must be excluded from general binary/image asset maps"
    );
    let stats_after_first_parse = diagnostics::custom_font_cache_stats();
    assert_eq!(stats_after_first_parse.entries, 1);
    assert_eq!(stats_after_first_parse.misses, 1);
    assert_eq!(stats_after_first_parse.hits, 0);

    // Referencing a __font_* key as an image must fail cleanly.
    assert!(source("![bad](__font_UpperCase.TTF)", &PdfOptions::default(), &ttf_assets).is_err());

    let ttf_pdf = export(
        "# Custom TTF\n\nBody text ![diagram](diagram.svg)",
        &PdfOptions { font_family: "CustomLabSans".into(), ..PdfOptions::default() },
        &ttf_assets,
    )
    .expect("custom TTF export");
    assert!(
        String::from_utf8_lossy(&ttf_pdf).contains("CustomLabSans-Regular"),
        "PDF must embed custom .TTF font face"
    );

    // Re-exporting identical font bytes under a different __font_* key hits the content-hash cache.
    let renamed_key_assets = HashMap::from([("__font_second_copy.ttf".to_string(), custom_ttf.clone())]);
    let ttf_pdf_2 = export(
        "Cached custom font reuse.",
        &PdfOptions { font_family: "CustomLabSans".into(), ..PdfOptions::default() },
        &renamed_key_assets,
    )
    .expect("cached custom TTF export");
    assert!(String::from_utf8_lossy(&ttf_pdf_2).contains("CustomLabSans-Regular"));
    let stats_after_hit = diagnostics::custom_font_cache_stats();
    assert_eq!(stats_after_hit.entries, 1);
    assert_eq!(stats_after_hit.misses, 1);
    assert_eq!(stats_after_hit.hits, 2);

    // Uppercase .OTF custom font embedding.
    let otf_assets = HashMap::from([("__font_UpperCase.OTF".to_string(), custom_otf.clone())]);
    assert_eq!(
        diagnostics::binary_asset_count_for_export(
            &PdfOptions { font_family: "CustomLabOtf".into(), ..PdfOptions::default() },
            &otf_assets,
        )
        .unwrap(),
        0,
        "Custom .OTF font bytes must be excluded from general binary/image asset maps"
    );
    let otf_pdf = export(
        "# Custom OTF\n\nVector OpenType CFF font.",
        &PdfOptions { font_family: "CustomLabOtf".into(), ..PdfOptions::default() },
        &otf_assets,
    )
    .expect("custom OTF export");
    assert!(
        String::from_utf8_lossy(&otf_pdf).contains("CustomLabOtf-Regular"),
        "PDF must embed custom .OTF font face"
    );

    // Custom static font overrides bundled variable Manrope AND embedded Libertinus Serif.
    let override_manrope = rename_opentype_font(base_ttf, "Manrope", "OverrideManrope-Custom");
    let manrope_pdf = export(
        "# Override Bundled\n\nCustom static font wins over bundled variable Manrope.",
        &PdfOptions { font_family: "Manrope".into(), ..PdfOptions::default() },
        &HashMap::from([("__font_override.ttf".into(), override_manrope)]),
    )
    .expect("override Manrope");
    assert!(
        String::from_utf8_lossy(&manrope_pdf).contains("OverrideManrope-Custom"),
        "Custom font must override bundled variable font of the same family"
    );

    let override_libertinus = rename_opentype_font(base_ttf, "Libertinus Serif", "OverrideLibertinus-Custom");
    let libertinus_pdf = export(
        "Custom font wins over embedded Libertinus Serif.",
        &PdfOptions { font_family: "Libertinus Serif".into(), ..PdfOptions::default() },
        &HashMap::from([("__font_libertinus.otf".into(), override_libertinus)]),
    )
    .expect("override Libertinus Serif");
    assert!(
        String::from_utf8_lossy(&libertinus_pdf).contains("OverrideLibertinus-Custom"),
        "Custom font must override embedded fallback font of the same family"
    );

    // Custom font cache bounds entry count to 32 and total bytes to <= 64 MB via LRU eviction.
    for i in 0..(CUSTOM_FONT_CACHE_MAX_ENTRIES + 6) {
        let fam = format!("BoundedCacheFont{i}");
        let ps = format!("BoundedCacheFont{i}-Regular");
        let font_bytes = rename_opentype_font(base_ttf, &fam, &ps);
        let assets = HashMap::from([(format!("__font_{i}.ttf"), font_bytes)]);
        let opts = PdfOptions { font_family: fam, ..PdfOptions::default() };
        assert!(export("Bounded cache entry.", &opts, &assets).unwrap().starts_with(b"%PDF-"));
    }
    let bounded_stats = diagnostics::custom_font_cache_stats();
    assert!(bounded_stats.entries <= CUSTOM_FONT_CACHE_MAX_ENTRIES);
    assert!(bounded_stats.total_bytes <= CUSTOM_FONT_CACHE_MAX_BYTES);
    assert_eq!(
        diagnostics::system_font_scan_count(),
        0,
        "Imported custom fonts must never trigger host OS font scans"
    );

    // 4. Bounded post-PDF comemo eviction keeps shared entries warm while aging out
    //    per-document PDF raster image caches right on the retention window boundary.
    let token = Arc::new(());
    let png = minimal_valid_png(30, 140, 210);
    let img_pdf = diagnostics::export_with_tracked_image(
        "# Image Document\n\n![pixel](tracked.png)\n\n$$\\int_0^1 x^2 dx = \\frac{1}{3}$$",
        &PdfOptions::default(),
        "tracked.png",
        png,
        Arc::clone(&token),
    )
    .expect("tracked image export");
    assert!(img_pdf.starts_with(b"%PDF-"));
    // Immediately after export #1 (evict ran after typst_pdf::pdf -> age == 1 <= COMEMO_EVICT_MAX_AGE),
    // the image entry is still warm in cache for immediate re-export.
    assert!(
        Arc::strong_count(&token) > 1,
        "Recent compilation/PDF image entry should remain warm within the retention window"
    );

    for step in 1..COMEMO_EVICT_MAX_AGE {
        let math_md = format!("# Follow-up {step}\n\n$$\\sum_{{k=1}}^{{n}} k = \\frac{{n(n+1)}}{{2}}$$");
        assert!(export(&math_md, &PdfOptions::default(), &HashMap::new()).unwrap().starts_with(b"%PDF-"));
        assert!(
            Arc::strong_count(&token) > 1,
            "Image cache should still be retained at age {}",
            step + 1
        );
    }

    // One more export pushes the unused per-document image entry to age == COMEMO_EVICT_MAX_AGE + 1,
    // proving eviction ran AFTER typst_pdf::pdf and freed both compile and PDF image caches.
    assert!(
        export("# Eviction boundary\n\n$$x^2 + y^2 = z^2$$", &PdfOptions::default(), &HashMap::new())
            .unwrap()
            .starts_with(b"%PDF-")
    );
    assert_eq!(
        Arc::strong_count(&token),
        1,
        "Per-document compile and PDF image caches must age out after COMEMO_EVICT_MAX_AGE follow-up exports"
    );

    // 5. Invalid, malformed, or root-escaping asset paths return clean structured errors (never panic).
    for bad_key in [
        "",
        "/",
        ".",
        "./",
        "..",
        "../outside.png",
        "assets/../../outside.svg",
        "/../../outside.svg",
        "folder\\backslash.png",
        "bad\0nul.png",
        "a/..",
        "__font_../escape.ttf",
        "__font_bad\\escape.otf",
    ] {
        let bad_assets = HashMap::from([(bad_key.to_string(), svg.clone())]);
        let err = export("Plain text with bad asset map.", &PdfOptions::default(), &bad_assets)
            .expect_err(&format!("Asset key {bad_key:?} must be rejected"));
        assert!(
            err.to_string().contains("Invalid PDF asset path"),
            "Unexpected error for {bad_key:?}: {err:#}"
        );

        let md = format!("![escape]({bad_key})");
        assert!(export(&md, &PdfOptions::default(), &bad_assets).is_err());
    }

    // 6. Concurrent exports (8 simultaneous jobs matching Android/desktop parallelism) succeed with zero panics.
    let threads = 8usize;
    let barrier = Arc::new(Barrier::new(threads));
    let shared_custom = Arc::new(custom_ttf);
    let shared_png = Arc::new(minimal_valid_png(180, 60, 90));
    let handles: Vec<_> = (0..threads)
        .map(|worker| {
            let barrier = Arc::clone(&barrier);
            let custom = Arc::clone(&shared_custom);
            let png = Arc::clone(&shared_png);
            std::thread::spawn(move || {
                barrier.wait();
                for round in 0..3 {
                    let md = format!(
                        "# Worker {worker} Round {round}\n\n![dot](dot.png)\n\n> [!WARNING] Concurrent\n> $$\\int_0^\\pi \\sin(x) dx = 2$$"
                    );
                    let mut assets = HashMap::from([("dot.png".to_string(), (*png).clone())]);
                    let family = match (worker + round) % 4 {
                        0 => "Manrope",
                        1 => "Roboto",
                        2 => "Noto Serif",
                        _ => {
                            assets.insert("__font_concurrent.TTF".into(), (*custom).clone());
                            "CustomLabSans"
                        }
                    };
                    let opts = PdfOptions {
                        font_family: family.into(),
                        themed: worker % 2 == 0,
                        ..PdfOptions::default()
                    };
                    let pdf = export(&md, &opts, &assets).expect("concurrent PDF export");
                    assert!(pdf.starts_with(b"%PDF-"));
                }
            })
        })
        .collect();

    for handle in handles {
        handle.join().expect("worker thread must not panic");
    }

    assert_eq!(
        diagnostics::system_font_scan_count(),
        0,
        "Entire built-in + custom + concurrent suite must perform zero host OS font scans"
    );
}
