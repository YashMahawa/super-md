use crate::{export, image_sources, pdf_assets, theme, PdfOptions};
use anyhow::{bail, Result};

fn jni_string(env: jni::JNIEnv, value: &str) -> jni::sys::jstring {
    env.new_string(value)
        .or_else(|_| env.new_string(""))
        .map(|s| s.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

#[no_mangle]
pub extern "system" fn Java_dev_supermd_studio_PdfEngine_validateTheme(
    mut env: jni::JNIEnv, _class: jni::objects::JClass, input: jni::objects::JString,
) -> jni::sys::jstring {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        match env.get_string(&input) {
            Ok(value) => theme::response(&String::from(value)),
            Err(_) => "{\"error\":\"Invalid theme input\"}".into(),
        }
    }))
    .unwrap_or_else(|_| "{\"error\":\"Theme validation failed\"}".into());
    jni_string(env, &result)
}

#[no_mangle]
pub extern "system" fn Java_dev_supermd_studio_PdfEngine_fontFamilies(
    mut env: jni::JNIEnv, _class: jni::objects::JClass, path: jni::objects::JString,
) -> jni::sys::jstring {
    let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let families = (|| -> Result<Vec<String>> {
            let path: String = env.get_string(&path)?.into();
            if std::fs::metadata(&path)?.len() > 20_000_000 { bail!("Font exceeds 20 MB"); }
            let bytes = typst::foundations::Bytes::new(std::fs::read(path)?);
            Ok(typst::text::Font::iter(bytes).map(|font| font.info().family.clone()).collect())
        })()
        .unwrap_or_default();
        serde_json::to_string(&families).unwrap_or_else(|_| "[]".into())
    }))
    .unwrap_or_else(|_| "[]".into());
    jni_string(env, &payload)
}

#[no_mangle]
pub extern "system" fn Java_dev_supermd_studio_PdfEngine_imageSources(
    mut env: jni::JNIEnv, _class: jni::objects::JClass, markdown: jni::objects::JString,
) -> jni::sys::jstring {
    let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        match env.get_string(&markdown) {
            Ok(value) => serde_json::to_string(&image_sources(&String::from(value))).unwrap_or_else(|_| "[]".into()),
            Err(_) => "[]".into(),
        }
    }))
    .unwrap_or_else(|_| "[]".into());
    jni_string(env, &payload)
}

#[no_mangle]
pub extern "system" fn Java_dev_supermd_studio_PdfEngine_export(
    mut env: jni::JNIEnv, _class: jni::objects::JClass, markdown: jni::objects::JString,
    options: jni::objects::JString, asset_dir: jni::objects::JString, output: jni::objects::JString,
) -> jni::sys::jstring {
    let message = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let result = (|| -> Result<()> {
            let markdown: String = env.get_string(&markdown)?.into();
            let options: String = env.get_string(&options)?.into();
            let asset_dir: String = env.get_string(&asset_dir)?.into();
            let output: String = env.get_string(&output)?.into();
            let options: PdfOptions = serde_json::from_str(&options)?;
            let assets = pdf_assets::load_referenced_assets(&markdown, std::path::Path::new(&asset_dir))?;
            std::fs::write(&output, export(&markdown, &options, &assets)?)?;
            Ok(())
        })();
        result.err().map(|e| format!("{e:#}")).unwrap_or_default()
    }))
    .unwrap_or_else(|_| "PDF export failed unexpectedly".into());
    jni_string(env, &message)
}
