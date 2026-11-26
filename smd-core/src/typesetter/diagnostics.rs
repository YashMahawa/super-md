use super::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedResourcePointers {
    pub bundled_font_ptrs: Vec<usize>,
    pub icon_ptrs: [usize; 9],
    pub mitex_standard_ptr: usize,
    pub mitex_prelude_ptr: usize,
    pub library_ptr: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CustomFontCacheStats {
    pub entries: usize,
    pub total_bytes: usize,
    pub hits: usize,
    pub misses: usize,
}

pub fn shared_resource_pointers() -> SharedResourcePointers {
    let shared = &*SHARED;
    SharedResourcePointers {
        bundled_font_ptrs: shared.base_fonts.iter().map(|f| f.data().as_ptr() as usize).collect(),
        icon_ptrs: shared.icons.each_ref().map(|(_, b)| b.as_ptr() as usize),
        mitex_standard_ptr: shared.mitex_standard.1.text().as_ptr() as usize,
        mitex_prelude_ptr: shared.mitex_prelude.1.text().as_ptr() as usize,
        library_ptr: (&*shared.library) as *const Library as usize,
    }
}

pub fn static_font_slice_ptrs() -> [usize; 9] {
    BUNDLED_FONT_DATA.map(|s| s.as_ptr() as usize)
}

pub fn static_icon_slice_ptrs() -> [usize; 9] {
    CALLOUT_ICONS.map(|(_, s)| s.as_ptr() as usize)
}

pub fn system_font_scan_count() -> usize {
    SYSTEM_FONT_SCANS.load(Ordering::SeqCst)
}

pub fn system_font_face_load_count() -> usize {
    SYSTEM_FONT_FACE_LOADS.load(Ordering::SeqCst)
}

pub fn custom_font_cache_stats() -> CustomFontCacheStats {
    let cache = CUSTOM_FONT_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    CustomFontCacheStats {
        entries: cache.entries.len(),
        total_bytes: cache.total_bytes,
        hits: cache.hits,
        misses: cache.misses,
    }
}

pub fn clear_custom_font_cache() {
    let mut cache = CUSTOM_FONT_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    cache.entries.clear();
    cache.total_bytes = 0;
    cache.hits = 0;
    cache.misses = 0;
}

pub fn embedded_otf_font_bytes() -> Vec<u8> {
    typst_kit::fonts::embedded()
        .find_map(|(font, _)| {
            let slice = font.data().as_slice();
            slice.starts_with(b"OTTO").then(|| slice.to_vec())
        })
        .expect("embedded CFF OpenType font")
}

#[cfg(not(target_os = "android"))]
pub fn find_cached_os_font_with_ascii() -> Option<(String, String)> {
    let sys = SYSTEM_FONTS.get()?;
    let shared = &*SHARED;
    for slot in &sys.slots {
        if slot.info.family.starts_with('.')
            || shared.base_book.contains_family(&slot.family_lower)
            || !slot.info.coverage.contains('A' as u32)
            || !slot.info.coverage.contains('e' as u32)
        {
            continue;
        }
        if let Some(font) = slot.get() {
            if let Some(ps) = font.post_script_name().filter(|s| !s.is_empty()) {
                return Some((slot.info.family.clone(), ps));
            }
        }
    }
    None
}

#[cfg(not(target_os = "android"))]
pub fn os_family_postscript_names(family: &str) -> Vec<String> {
    let Some(sys) = SYSTEM_FONTS.get() else {
        return Vec::new();
    };
    let lower = family.to_lowercase();
    sys.slots
        .iter()
        .filter(|slot| slot.family_lower == lower)
        .filter_map(|slot| slot.loaded.get()?.as_ref()?.post_script_name())
        .collect()
}

pub fn binary_asset_count_for_export(
    options: &crate::PdfOptions,
    assets: &HashMap<String, Vec<u8>>,
) -> Result<usize> {
    let world = ExportWorld::new(String::new(), &options.font_family, assets, None)?;
    Ok(world.binaries.len())
}

struct TrackedBytes {
    bytes: Vec<u8>,
    _token: Arc<()>,
}

impl AsRef<[u8]> for TrackedBytes {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}

/// Exports a document with a single reference-counted binary image asset so tests
/// can observe exact `comemo` retention and post-PDF eviction deterministically.
pub fn export_with_tracked_image(
    markdown: &str,
    options: &crate::PdfOptions,
    asset_name: &str,
    asset_bytes: Vec<u8>,
    token: Arc<()>,
) -> Result<Vec<u8>> {
    let vpath = validate_asset_path(asset_name)?;
    let placeholder = HashMap::from([(asset_name.to_owned(), Vec::new())]);
    let source_text = crate::source(markdown, options, &placeholder)?;
    let extra = HashMap::from([(
        project_file_id(vpath),
        Bytes::new(TrackedBytes { bytes: asset_bytes, _token: token }),
    )]);
    let world = ExportWorld::new(source_text, &options.font_family, &HashMap::new(), Some(extra))?;
    compile_and_encode(world)
}
