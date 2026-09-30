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
