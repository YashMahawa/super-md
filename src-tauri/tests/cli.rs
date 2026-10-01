use std::{fs, process::Command};

#[test]
fn cli_exports_offline_math_tables_and_checks_runtime() {
    let folder = tempfile::tempdir().unwrap();
    let input = folder.path().join("notes.smd");
    let output = folder.path().join("notes.pdf");
    fs::write(&input, "# CLI regression\n\n> [!TIP] Study\n> Work through the formula.\n\n$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$\n\n| Formula | Meaning |\n|---|---|\n| $x^2$ | Square |\n").unwrap();
    let binary = env!("CARGO_BIN_EXE_super-md");
    let result = Command::new(binary).arg("export").arg(&input).arg("-o").arg(&output).arg("--no-page-numbers").output().unwrap();
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    assert!(fs::read(output).unwrap().starts_with(b"%PDF-"));
    assert!(Command::new(binary).arg("doctor").output().unwrap().status.success());
}

#[test]
fn cli_packs_one_portable_file_and_exports_without_loose_images() {
    let folder = tempfile::tempdir().unwrap(); let input = folder.path().join("notes.md"); let image = folder.path().join("proof.svg"); let portable = folder.path().join("shared.fmd"); let pdf = folder.path().join("shared.pdf");
    fs::write(&image, "<svg xmlns='http://www.w3.org/2000/svg' width='100' height='40'><path d='M0 35L100 5' stroke='blue'/></svg>").unwrap();
    let markdown = "# Portable CLI\n\n![Proof](proof.svg)\n\n$$x^2+y^2=1$$\n\n```python\nprint('leave my source alone')\n```\n";
    fs::write(&input, markdown).unwrap(); let binary = env!("CARGO_BIN_EXE_super-md");
    let result = Command::new(binary).arg("pack").arg(&input).arg("-o").arg(&portable).output().unwrap();
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    let bundle = smd_core::portable::PortableDocument::decode(&fs::read_to_string(&portable).unwrap()).unwrap();
    assert_eq!(bundle.assets.len(), 1); assert!(bundle.markdown.contains("print('leave my source alone')")); assert!(!bundle.markdown.contains("base64"));
    fs::remove_file(image).unwrap();
    let exported = Command::new(binary).arg("export").arg(&portable).arg("-o").arg(&pdf).output().unwrap(); assert!(exported.status.success(), "{}", String::from_utf8_lossy(&exported.stderr));
    assert!(fs::read(pdf).unwrap().starts_with(b"%PDF-"));
    assert_eq!(fs::read_to_string(input).unwrap(), markdown);
}
