//! Dedicated process-isolated integration test for on-demand host OS font discovery,
//! lazy face loading, cross-export metadata caching, and syscall-level scan avoidance.
#![cfg(not(target_os = "android"))]

use smd_core::{diagnostics, export, PdfOptions};
use std::collections::HashMap;

#[test]
fn on_demand_system_font_loading_embeds_os_font_and_caches_metadata() {
    assert_eq!(diagnostics::system_font_scan_count(), 0);

    // Built-in export before any OS font request does not scan host OS font directories.
    let builtin_pdf = export("# Built-in\n\nDefault Manrope text.", &PdfOptions::default(), &HashMap::new())
        .expect("built-in export");
    assert!(builtin_pdf.starts_with(b"%PDF-"));
    assert_eq!(diagnostics::system_font_scan_count(), 0);

    // Requesting a non-builtin, non-custom font triggers host OS font discovery on demand.
    let preferred_candidates = if cfg!(target_os = "macos") {
        ["Helvetica", "Arial", "Times New Roman"]
    } else if cfg!(target_os = "windows") {
        ["Arial", "Segoe UI", "Times New Roman"]
    } else {
        ["Liberation Serif", "DejaVu Sans", "FreeSerif"]
    };

    let probe_opts = PdfOptions {
        font_family: preferred_candidates[0].into(),
        ..PdfOptions::default()
    };
    let probe_pdf = export("# Host OS Font\n\nDesktop system font check.", &probe_opts, &HashMap::new())
        .expect("initial OS font export");
    assert!(probe_pdf.starts_with(b"%PDF-"));
    assert_eq!(
        diagnostics::system_font_scan_count(),
        1,
        "First unbundled, non-imported font export must scan OS font directories exactly once"
    );

    // Resolve an installed ASCII-capable OS font (preferring the initial candidate if installed)
    // and verify its actual PostScript face is embedded in the output PDF.
    let candidate_ps = diagnostics::os_family_postscript_names(preferred_candidates[0]);
    let (target_family, expected_ps_list, pdf_bytes) = if !candidate_ps.is_empty() {
        (preferred_candidates[0].to_string(), candidate_ps, probe_pdf)
    } else if let Some((family, ps)) = diagnostics::find_cached_os_font_with_ascii() {
        let opts = PdfOptions {
            font_family: family.clone(),
            ..PdfOptions::default()
        };
        let pdf = export("# Host OS Font\n\nDesktop system font check.", &opts, &HashMap::new())
            .expect("installed OS font export");
        (family, vec![ps], pdf)
    } else {
        // Minimal headless container with zero host OS fonts installed: still verify scan caching.
        let repeat = export("Repeat probe.", &probe_opts, &HashMap::new()).expect("repeat OS probe");
        assert!(repeat.starts_with(b"%PDF-"));
        assert_eq!(diagnostics::system_font_scan_count(), 1);
        return;
    };

    let pdf_text = String::from_utf8_lossy(&pdf_bytes);
    assert!(
        expected_ps_list.iter().any(|ps| pdf_text.contains(ps)),
        "Expected PDF for OS family {target_family:?} to embed one of {expected_ps_list:?}"
    );
    let loads_after_first = diagnostics::system_font_face_load_count();
    assert!(loads_after_first >= 1, "Required OS font face must be loaded on demand");

    // Repeat export with the same OS font reuses both cached metadata AND cached loaded Font faces.
    let repeat_opts = PdfOptions {
        font_family: target_family.clone(),
        ..PdfOptions::default()
    };
    let repeat_pdf = export("# Second OS Export\n\nCached OS font reuse.", &repeat_opts, &HashMap::new())
        .expect("repeat OS font export");
    assert!(repeat_pdf.starts_with(b"%PDF-"));
    assert_eq!(
        diagnostics::system_font_scan_count(),
        1,
        "Subsequent OS font exports must reuse cached OS font metadata without rescanning"
    );
    assert_eq!(
        diagnostics::system_font_face_load_count(),
        loads_after_first,
        "Subsequent exports with the same OS font variant must reuse cached Font faces without disk reads"
    );

    // Custom font with the same family name as an installed OS font overrides the OS font.
    let override_bytes = rename_sfnt_family(
        include_bytes!("../fonts/NotoSans-Regular.ttf"),
        &target_family,
        "CustomOverridesOsFont-Regular",
    );
    let override_pdf = export(
        "# Custom Overrides OS\n\nImported custom face wins over host OS font.",
        &repeat_opts,
        &HashMap::from([("__font_override_os.TTF".to_string(), override_bytes)]),
    )
    .expect("custom override of OS font");
    assert!(
        String::from_utf8_lossy(&override_pdf).contains("CustomOverridesOsFont-Regular"),
        "Custom font must override installed OS font of the same family"
    );
}

fn rename_sfnt_family(raw: &[u8], family: &str, postscript: &str) -> Vec<u8> {
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
    for i in 0..num_tables {
        let rec = 12 + i * 16;
        if &out[rec..rec + 4] == b"name" {
            out[rec + 4..rec + 8].copy_from_slice(&checksum.to_be_bytes());
            out[rec + 8..rec + 12].copy_from_slice(&new_offset.to_be_bytes());
            out[rec + 12..rec + 16].copy_from_slice(&new_length.to_be_bytes());
            break;
        }
    }
    out
}

#[cfg(target_os = "linux")]
#[test]
fn cli_subprocess_built_in_and_custom_font_exports_issue_zero_font_dir_syscalls() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::io::Write;
    use std::process::{Command, Stdio};

    if Command::new("strace").arg("--version").output().map(|o| o.status.success()).unwrap_or(false) {
        let temp = std::env::temp_dir().join(format!("supermd-strace-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        std::fs::create_dir_all(&temp).unwrap();

        let custom_b64 = STANDARD.encode(include_bytes!("../fonts/Manrope.ttf"));
        let payloads = [
            serde_json::json!({
                "content": "# Default Font\n\n$$x^2 + 1$$",
                "options": { "fontFamily": "Manrope" }
            }),
            serde_json::json!({
                "content": "# Custom Imported Font\n\nBody text.",
                "options": { "fontFamily": "Manrope" },
                "assets": { "__font_Imported.TTF": custom_b64 }
            }),
        ];

        for (idx, payload) in payloads.iter().enumerate() {
            let out_pdf = temp.join(format!("out-{idx}.pdf"));
            let mut child = Command::new("strace")
                .args([
                    "-e",
                    "trace=file",
                    env!("CARGO_BIN_EXE_smd-engine"),
                    "export-json",
                    out_pdf.to_str().unwrap(),
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(payload.to_string().as_bytes())
                .unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            let trace = String::from_utf8_lossy(&output.stderr);
            let font_reads: Vec<&str> = trace
                .lines()
                .filter(|line| line.contains("/fonts") || line.contains("fontconfig"))
                .collect();
            assert!(
                font_reads.is_empty(),
                "Expected zero host OS font syscalls for case {idx}, got: {font_reads:?}"
            );
            assert!(std::fs::read(&out_pdf).unwrap().starts_with(b"%PDF-"));
        }

        let _ = std::fs::remove_dir_all(&temp);
    }
}
