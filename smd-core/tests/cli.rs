//! Exercise the real agent-facing process, not a mock of the portable library.
use std::{fs, path::{Path, PathBuf}, process::{Command, Output, Stdio}, io::Write, sync::atomic::{AtomicUsize, Ordering}};
static SEQUENCE: AtomicUsize = AtomicUsize::new(0);
struct Workspace(PathBuf);
impl Workspace {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("supermd-cli-{}-{}", std::process::id(), SEQUENCE.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir(&path).unwrap(); Self(path)
    }
    fn file(&self, name: &str) -> PathBuf { self.0.join(name) }
    fn run(&self, args: &[&str]) -> Output { Command::new(env!("CARGO_BIN_EXE_smd-engine")).current_dir(&self.0).args(args).output().unwrap() }
}
impl Drop for Workspace { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
fn success(output: Output) -> String {
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr)); String::from_utf8(output.stdout).unwrap()
}
fn pdf(path: &Path) { let bytes = fs::read(path).unwrap(); assert!(bytes.starts_with(b"%PDF-")); assert!(bytes.len() > 1000); }
#[test]
fn theme_validation_is_shared_with_the_native_apps() {
    for (input,valid) in [(r#"{"format":"supermd-theme","version":1,"name":"Ink"}"#,true),(r#"{"format":"supermd-theme","version":1,"name":"Ink","css":"@import url(https://example.com)"}"#,false)] {
        let mut process=Command::new(env!("CARGO_BIN_EXE_smd-engine")).arg("validate-theme").stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        process.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
        let response:serde_json::Value=serde_json::from_str(&success(process.wait_with_output().unwrap())).unwrap();
        assert_eq!(response.get("theme").is_some(),valid);
    }
}
#[test]
fn text_and_portable_commands_never_dump_image_bytes() {
    let w = Workspace::new();
    let image = b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"40\" height=\"40\"><circle cx=\"20\" cy=\"20\" r=\"15\" fill=\"blue\"/></svg>";
    fs::write(w.file("picture.svg"), image).unwrap();
    fs::write(w.file("note.md"), "# Unicode αβ\n\n![Picture](picture.svg)\n\n$E=mc^2$").unwrap();
    assert!(success(w.run(&["help"])).contains("read NOTE"));
    let doctor: serde_json::Value = serde_json::from_str(&success(w.run(&["doctor"]))).unwrap(); assert_eq!(doctor["browserPrint"], false);
    assert_eq!(success(w.run(&["read", "note.md", "--offset", "10", "--limit", "2"])), "αβ");
    success(w.run(&["pack", "note.md", "note.smd"]));
    assert!(fs::read(w.file("note.smd")).unwrap().starts_with(&[0x1f, 0x8b]));
    let read = success(w.run(&["read", "note.smd"])); assert!(read.contains("Unicode αβ")); assert!(!read.contains("base64"));
    let inspection: serde_json::Value = serde_json::from_str(&success(w.run(&["inspect", "note.smd"]))).unwrap();
    assert_eq!(inspection["format"], "supermd-smd"); assert_eq!(inspection["assets"].as_array().unwrap().len(), 1);
    let assets: serde_json::Value = serde_json::from_str(&success(w.run(&["assets", "note.smd"]))).unwrap();
    let name = assets[0]["name"].as_str().unwrap(); assert_eq!(assets[0]["bytes"], image.len());
    success(w.run(&["extract", "note.smd", name, "extracted.svg"])); assert_eq!(fs::read(w.file("extracted.svg")).unwrap(), image);
    assert!(!w.run(&["extract", "note.smd", name, "extracted.svg"]).status.success());
    success(w.run(&["export", "note.smd", "note.pdf"])); pdf(&w.file("note.pdf"));
    fs::write(w.file("legacy.smd"), "ordinary text SMD").unwrap(); assert_eq!(success(w.run(&["read", "legacy.smd"])), "ordinary text SMD");
    assert!(!w.run(&["read", "missing.md"]).status.success()); assert!(!w.run(&["unknown", "note.md"]).status.success());
}
#[test]
fn portable_recognition_uses_the_format_marker_not_the_filename() {
    let w=Workspace::new();
    for format in ["supermd-smd","supermd-fmd"] {
        // Put the marker last: JSON object ordering is not part of the format.
        let content=format!("\u{feff}{{\"markdown\":\"# Renamed note\",\"assets\":{{}},\"version\":1,\"format\":\"{format}\"}}");
        for name in ["download", "shared.txt", "shared.json", "shared.MD", "shared.SMD"] {
            fs::write(w.file(name),&content).unwrap();
            assert_eq!(success(w.run(&["read",name])),"# Renamed note");
        }
    }
    fs::write(w.file("ordinary.json"),r#"{"format":"csv","rows":[]}"#).unwrap();
    assert_eq!(success(w.run(&["read","ordinary.json"])),r#"{"format":"csv","rows":[]}"#);
    fs::write(w.file("unsupported.txt"),r##"{"format":"supermd-smd","version":99,"markdown":"# Bad","assets":{}}"##).unwrap();
    assert!(!w.run(&["read","unsupported.txt"]).status.success());
}
#[test]
fn prepared_pdf_stdin_and_invalid_requests() {
    let w = Workspace::new();
    let mut child = Command::new(env!("CARGO_BIN_EXE_smd-engine")).current_dir(&w.0).args(["export-json", "prepared.pdf"])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(br##"{"content":"# Prepared note\n\n$$x^2+y^2=1$$","options":{"pageSize":"a5","pageNumbers":false}}"##).unwrap();
    success(child.wait_with_output().unwrap()); pdf(&w.file("prepared.pdf"));
    fs::write(w.file("invalid.smd"), r#"{"format":"supermd-smd","version":99}"#).unwrap();
    assert!(!w.run(&["inspect", "invalid.smd"]).status.success());
    assert!(!w.run(&["extract", "invalid.smd", "nope", "bad.svg"]).status.success()); assert!(!w.file("bad.svg").exists());
}

#[test]
fn malformed_streams_and_asset_paths_fail_without_overwriting_the_destination() {
    let w=Workspace::new();
    fs::write(w.file("preserved.pdf"),b"existing user file").unwrap();
    for input in [b"{\"content\":".as_slice(), &[0xff], br#"{"content":"test","options":{"fontSize":100}}"#.as_slice()] {
        let mut child=Command::new(env!("CARGO_BIN_EXE_smd-engine")).current_dir(&w.0).args(["export-json","preserved.pdf"])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        let output=child.wait_with_output().unwrap();assert!(!output.status.success());assert!(!output.stderr.is_empty());
        assert_eq!(fs::read(w.file("preserved.pdf")).unwrap(),b"existing user file");
    }
    fs::write(w.file("outside.md"),"![outside](../outside.svg)").unwrap();
    assert!(!w.run(&["export","outside.md","preserved.pdf"]).status.success());
    assert_eq!(fs::read(w.file("preserved.pdf")).unwrap(),b"existing user file");
}

#[test]
fn inline_data_images_export_and_pack_but_remote_images_never_download_implicitly() {
    use base64::Engine;
    let w=Workspace::new();
    let svg=b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\"><circle cx=\"10\" cy=\"10\" r=\"8\" fill=\"blue\"/></svg>";
    let encoded=base64::engine::general_purpose::STANDARD.encode(svg);
    fs::write(w.file("inline.md"),format!("![inline](data:image/svg+xml;base64,{encoded})")).unwrap();
    success(w.run(&["export","inline.md","inline.pdf"]));pdf(&w.file("inline.pdf"));
    success(w.run(&["pack","inline.md","inline.smd"]));
    fs::write(w.file("remote.md"),"![remote](https://example.invalid/diagram.png)").unwrap();
    let output=w.run(&["export","remote.md","remote.pdf"]);
    assert!(!output.status.success());assert!(String::from_utf8_lossy(&output.stderr).contains("explicit download"));assert!(!w.file("remote.pdf").exists());
}

#[test]
fn unpack_extracts_markdown_and_assets_portably_and_rolls_back_on_collision_failure_or_symlink() {
    let w = Workspace::new();
    let svg_a = b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\"><rect width=\"24\" height=\"24\" fill=\"#386a57\"/></svg>";
    let svg_b = b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\"><circle cx=\"12\" cy=\"12\" r=\"9\" fill=\"#6750a4\"/></svg>";
    fs::write(w.file("first.svg"), svg_a).unwrap();
    fs::write(w.file("second.svg"), svg_b).unwrap();
    fs::write(w.file("lesson.md"), "# Lesson\n\n![First](first.svg)\n\n![Second](second.svg)\n").unwrap();
    assert!(success(w.run(&["--help"])).contains("unpack NOTE OUTPUT_DIR"));
    success(w.run(&["pack", "lesson.md", "lesson.smd"]));

    let unpacked_stdout = success(w.run(&["unpack", "lesson.smd", "unpacked"]));
    assert!(!unpacked_stdout.contains("base64"));
    let summary: serde_json::Value = serde_json::from_str(&unpacked_stdout).unwrap();
    assert_eq!(summary["assets"], 2);
    let unpacked_md = fs::read_to_string(w.file("unpacked/lesson.md")).unwrap();
    assert!(unpacked_md.contains("# Lesson"));
    assert!(unpacked_md.contains("assets/image-1.svg"));
    assert!(unpacked_md.contains("assets/image-2.svg"));
    assert_eq!(fs::read(w.file("unpacked/assets/image-1.svg")).unwrap(), svg_a);
    assert_eq!(fs::read(w.file("unpacked/assets/image-2.svg")).unwrap(), svg_b);

    // Reserved/unsafe FAT & Windows stem characters (including dotted reserved prefixes) fall back to portable filenames.
    fs::copy(w.file("lesson.smd"), w.file("CON.smd")).unwrap();
    success(w.run(&["unpack", "CON.smd", "fat-safe/nested"]));
    assert!(w.file("fat-safe/nested/Note.md").exists());
    assert_eq!(fs::read(w.file("fat-safe/nested/assets/image-1.svg")).unwrap(), svg_a);

    fs::copy(w.file("lesson.smd"), w.file("CON.chapter.smd")).unwrap();
    success(w.run(&["unpack", "CON.chapter.smd", "fat-safe-dotted"]));
    assert!(w.file("fat-safe-dotted/Note.md").exists());
    assert!(!w.file("fat-safe-dotted/CON.chapter.md").exists());

    #[cfg(not(windows))]
    {
        fs::copy(w.file("lesson.smd"), w.file("lpt1.notes.smd")).unwrap();
        success(w.run(&["unpack", "lpt1.notes.smd", "fat-safe-lpt1"]));
        assert!(w.file("fat-safe-lpt1/Note.md").exists());
        assert!(!w.file("fat-safe-lpt1/lpt1.notes.md").exists());
    }

    // Assets with reserved Windows/FAT device basenames fail preflight before creating any output.
    {
        use base64::Engine;
        let data_url = format!("data:image/svg+xml;base64,{}", base64::engine::general_purpose::STANDARD.encode(svg_a));
        for reserved_asset in ["assets/CON.svg", "assets/aux.diagram.svg", "assets/com1.svg", "assets/lpt1.notes.svg"] {
            let envelope = serde_json::json!({
                "format": "supermd-smd",
                "version": 1,
                "markdown": format!("# Bad asset\n\n![ok](assets/a-first.svg)\n\n![bad]({reserved_asset})\n"),
                "assets": {
                    "assets/a-first.svg": data_url,
                    reserved_asset: data_url,
                }
            });
            fs::write(w.file("reserved-asset.smd"), envelope.to_string()).unwrap();
            assert!(!w.run(&["unpack", "reserved-asset.smd", "reserved-asset-out/nested"]).status.success());
            assert!(!w.file("reserved-asset-out").exists());

            let existing_out = w.file("reserved-asset-existing");
            let _ = fs::remove_dir_all(&existing_out);
            fs::create_dir(&existing_out).unwrap();
            assert!(!w.run(&["unpack", "reserved-asset.smd", "reserved-asset-existing"]).status.success());
            assert!(fs::read_dir(&existing_out).unwrap().next().is_none());
        }
    }

    // Repeating unpack into the same directory fails without modifying existing files.
    fs::write(w.file("unpacked/lesson.md"), "user edited markdown").unwrap();
    assert!(!w.run(&["unpack", "lesson.smd", "unpacked"]).status.success());
    assert_eq!(fs::read_to_string(w.file("unpacked/lesson.md")).unwrap(), "user edited markdown");

    // Pre-existing Markdown file aborts before creating assets/ or writing any image.
    fs::create_dir(w.file("collide-md")).unwrap();
    fs::write(w.file("collide-md/lesson.md"), "keep existing md").unwrap();
    assert!(!w.run(&["unpack", "lesson.smd", "collide-md"]).status.success());
    assert_eq!(fs::read_to_string(w.file("collide-md/lesson.md")).unwrap(), "keep existing md");
    assert!(!w.file("collide-md/assets").exists());

    // Pre-existing second asset aborts before writing image-1.svg or lesson.md.
    fs::create_dir_all(w.file("collide-asset/assets")).unwrap();
    fs::write(w.file("collide-asset/assets/image-2.svg"), b"keep existing asset").unwrap();
    assert!(!w.run(&["unpack", "lesson.smd", "collide-asset"]).status.success());
    assert_eq!(fs::read(w.file("collide-asset/assets/image-2.svg")).unwrap(), b"keep existing asset");
    assert!(!w.file("collide-asset/assets/image-1.svg").exists());
    assert!(!w.file("collide-asset/lesson.md").exists());

    // Plain Markdown notes are rejected without creating the destination folder.
    assert!(!w.run(&["unpack", "lesson.md", "plain-out"]).status.success());
    assert!(!w.file("plain-out").exists());

    #[cfg(unix)]
    {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let outside = w.file("outside");
        fs::create_dir(&outside).unwrap();

        let link_root = w.file("symlink-out");
        symlink(&outside, &link_root).unwrap();
        assert!(!w.run(&["unpack", "lesson.smd", "symlink-out"]).status.success());
        assert!(!w.run(&["unpack", "lesson.smd", "symlink-out/"]).status.success());
        assert!(!w.run(&["unpack", "lesson.smd", "symlink-out/nested"]).status.success());
        assert!(fs::read_dir(&outside).unwrap().next().is_none());

        // Existing subdirectories inside a symlinked ancestor (relative and absolute) are also rejected.
        let existing_inside = outside.join("existing-sub");
        fs::create_dir(&existing_inside).unwrap();
        assert!(!w.run(&["unpack", "lesson.smd", "symlink-out/existing-sub"]).status.success());
        assert!(!w.run(&["unpack", "lesson.smd", "symlink-out/existing-sub/nested"]).status.success());
        assert!(!w.run(&["unpack", "lesson.smd", link_root.join("existing-sub").to_str().unwrap()]).status.success());
        assert!(!w.run(&["unpack", "lesson.smd", link_root.join("existing-sub/nested").to_str().unwrap()]).status.success());

        let real_parent = w.file("real-parent");
        fs::create_dir(&real_parent).unwrap();
        symlink(&outside, real_parent.join("symlink-mid")).unwrap();
        assert!(!w.run(&["unpack", "lesson.smd", "real-parent/symlink-mid/existing-sub"]).status.success());
        assert!(!w.run(&["unpack", "lesson.smd", "real-parent/symlink-mid/existing-sub/nested"]).status.success());
        assert!(fs::read_dir(&existing_inside).unwrap().next().is_none());
        fs::remove_dir(&existing_inside).unwrap();

        let nested = w.file("with-symlink-assets");
        fs::create_dir(&nested).unwrap();
        symlink(&outside, nested.join("assets")).unwrap();
        assert!(!w.run(&["unpack", "lesson.smd", "with-symlink-assets"]).status.success());
        assert!(!nested.join("lesson.md").exists());
        assert!(fs::read_dir(&outside).unwrap().next().is_none());

        let dangling = w.file("dangling-link");
        symlink(w.file("missing-target"), &dangling).unwrap();
        assert!(!w.run(&["unpack", "lesson.smd", "dangling-link"]).status.success());
        assert!(!w.run(&["unpack", "lesson.smd", "dangling-link/nested"]).status.success());
        assert!(!w.file("missing-target").exists());

        // Mid-unpack write failure (after assets/* are created, when lesson.md fails to open)
        // rolls back every newly written asset while leaving existing unrelated files intact.
        let midrun = w.file("rollback-midrun");
        fs::create_dir_all(midrun.join("assets")).unwrap();
        fs::write(midrun.join("assets/unrelated.txt"), b"keep me").unwrap();
        let mut readonly = fs::metadata(&midrun).unwrap().permissions();
        readonly.set_mode(0o555);
        fs::set_permissions(&midrun, readonly).unwrap();
        let probe_blocked = fs::File::create(midrun.join("probe")).is_err();
        if probe_blocked {
            assert!(!w.run(&["unpack", "lesson.smd", "rollback-midrun"]).status.success());
            assert!(!midrun.join("assets/image-1.svg").exists());
            assert!(!midrun.join("assets/image-2.svg").exists());
            assert!(!midrun.join("lesson.md").exists());
            assert_eq!(fs::read(midrun.join("assets/unrelated.txt")).unwrap(), b"keep me");
        }
        let mut restore = fs::metadata(&midrun).unwrap().permissions();
        restore.set_mode(0o755);
        fs::set_permissions(&midrun, restore).unwrap();
    }
}

fn inflate_pdf_streams(bytes: &[u8]) -> String {
    use std::io::Read;
    let mut text = String::from_utf8_lossy(bytes).into_owned();
    let mut pos = 0usize;
    while let Some(rel) = bytes[pos..].windows(6).position(|w| w == b"stream") {
        let mut s = pos + rel + 6;
        if bytes.get(s) == Some(&b'\r') && bytes.get(s + 1) == Some(&b'\n') {
            s += 2;
        } else if bytes.get(s) == Some(&b'\n') {
            s += 1;
        } else {
            pos = s;
            continue;
        }
        let Some(end_rel) = bytes[s..].windows(9).position(|w| w == b"endstream") else {
            break;
        };
        let raw = &bytes[s..s + end_rel];
        let trimmed = raw.strip_suffix(b"\r\n").or_else(|| raw.strip_suffix(b"\n")).unwrap_or(raw);
        let mut out = Vec::new();
        if flate2::read::ZlibDecoder::new(trimmed).read_to_end(&mut out).is_ok() {
            text.push('\n');
            text.push_str(&String::from_utf8_lossy(&out));
        }
        pos = s + end_rel + 9;
    }
    text
}

#[test]
fn cli_and_in_app_prepared_pdf_exports_produce_identical_pdf_properties_and_omit_frontmatter() {
    let w = Workspace::new();
    let raw_note = "\u{feff}---  \ntitle: \"Analytical Mechanics\"\nauthor: \"Joseph-Louis Lagrange\"\ndescription: \"Variational principles and Euler-Lagrange equations\"\nkeywords: [mechanics, calculus-of-variations]\ndate: 2026-05-20\n...\n\n# Action Principle\n\n$$\\delta S = 0$$\n";
    fs::write(w.file("mechanics.md"), raw_note).unwrap();
    success(w.run(&["export", "mechanics.md", "cli.pdf"]));
    pdf(&w.file("cli.pdf"));

    // Simulate in-app preparePdf output sent over export-json.
    let prepared_note = "\u{feff}---  \ntitle: \"Analytical Mechanics\"\nauthor: \"Joseph-Louis Lagrange\"\ndescription: \"Variational principles and Euler-Lagrange equations\"\nkeywords: [mechanics, calculus-of-variations]\ndate: 2026-05-20\n...\n\n# Action Principle\n\n$$\n\\delta S = 0\n$$\n";
    let request = serde_json::json!({
        "content": prepared_note,
        "assets": {},
        "options": {}
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_smd-engine"))
        .current_dir(&w.0)
        .args(["export-json", "app.pdf"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(request.to_string().as_bytes()).unwrap();
    success(child.wait_with_output().unwrap());
    pdf(&w.file("app.pdf"));

    let cli_bytes = fs::read(w.file("cli.pdf")).unwrap();
    let app_bytes = fs::read(w.file("app.pdf")).unwrap();
    let cli_corpus = inflate_pdf_streams(&cli_bytes);
    let app_corpus = inflate_pdf_streams(&app_bytes);

    for expected in [
        "Analytical Mechanics",
        "Joseph-Louis Lagrange",
        "Variational principles and Euler-Lagrange equations",
        "calculus-of-variations",
    ] {
        assert!(cli_corpus.contains(expected), "CLI PDF missing {expected}");
        assert!(app_corpus.contains(expected), "App PDF missing {expected}");
    }
    assert!(cli_corpus.contains("2026-05-20") || cli_corpus.contains("D:20260520"));
    assert!(app_corpus.contains("2026-05-20") || app_corpus.contains("D:20260520"));
    assert_eq!(cli_bytes, app_bytes, "CLI and in-app PDF exports with deterministic date must have identical metadata and bytes");
}
