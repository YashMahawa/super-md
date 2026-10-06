# Development

## Desktop

Use Node 20+, Rust stable, and Python 3.13. Install the pinned desktop requirements into a virtual environment. Linux needs Qt display/audio/NSS runtime libraries, not WebKitGTK development packages. PDF typesetting is embedded; no external Pandoc or Typst executable is required.

```sh
npm ci
python -m venv desktop/.venv
desktop/.venv/bin/python -m pip install -r desktop/requirements-build.txt
npm run build
npx vitest run
desktop/.venv/bin/python -m unittest discover -s desktop -p 'test_*.py'
npm run test:pdf
cargo build --locked --release --manifest-path smd-core/Cargo.toml --bin smd-engine
desktop/.venv/bin/python desktop/main.py
desktop/.venv/bin/python desktop/package.py --bundle-only
```

On Windows, use the virtual environment's `Scripts` directory in place of `bin`.

Desktop Python cells use the interpreter or virtual environment chosen in Settings. NumPy and Matplotlib are needed for plotting cells. Python execution is explicit and local, but is not a security sandbox.

## Android

Install JDK 17, SDK platform 37, build tools 36, NDK 27.1.12297006, host Python 3.13, and the Rust target `aarch64-linux-android`.

```sh
rustup target add aarch64-linux-android
export ANDROID_HOME=/path/to/android-sdk
export SUPERMD_BUILD_PYTHON=/path/to/python3.13
npm run android:release
```

The build script locks concurrent builds, limits Cargo jobs to four and Gradle workers to two, and caps the Gradle heap at 1536 MB. Set `SUPERMD_BUILD_CPUS` to restrict CPU affinity when desired.

Output: `android/app/build/outputs/apk/release/`. Distribution signing uses `SUPERMD_KEYSTORE`, `SUPERMD_STORE_PASSWORD`, `SUPERMD_KEY_ALIAS`, and `SUPERMD_KEY_PASSWORD`. Do not commit keystores or credentials. Without signing variables, the artifact is unsigned and must not be distributed.

CI publication requires distribution signing secrets or a locally signed release APK attached to the release draft. It verifies the upgrade certificate, non-debuggable variant, 16-KB alignment, and clean tagged source before publication. Never replace the signing identity to work around an installation failure.

## Shared components and boundaries

- Qt Quick/QML provides the desktop shell. Compose Material 3 Expressive provides Android controls.
- The document renderer uses React, TypeScript, CodeMirror, KaTeX, and shared Markdown preparation.
- Rust / Typst / MiTeX handles typeset PDF export and portable-note operations.
- GUI export supplies prepared diagrams and already-executed figures. Headless CLI export never runs code implicitly.
- Desktop controls are independently skinned Qt Quick Controls using Google's Material Color Utilities. They are not a claim that stock Qt implements the entire Expressive specification.
- Android has bundled Python 3.13, NumPy, and Matplotlib in a separate app-owned worker. Desktop uses the selected interpreter.

Review [platform parity](PLATFORM-PARITY.md), [gestures and math repair](GESTURES-AND-MATH-REPAIR.md), [large-note performance](LARGE-NOTE-PERFORMANCE.md), and [verification](VERIFICATION.md) when changing shared behavior.

Keep third-party notices intact. See [desktop notices](../desktop/NOTICE.md), [UI licenses](../public/third-party-ui-licenses.txt), and the MIT copyright in [LICENSE](../LICENSE).
