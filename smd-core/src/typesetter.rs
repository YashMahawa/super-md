//! Shared typesetting environment, bounded custom font cache, and on-demand host font loading.
use anyhow::{anyhow, bail, Result};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet, VecDeque};
#[cfg(not(target_os = "android"))]
use std::ops::Deref;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
#[cfg(not(target_os = "android"))]
use std::sync::OnceLock;
use std::sync::{Arc, LazyLock, Mutex};
use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
#[cfg(not(target_os = "android"))]
use typst::text::FontInfo;
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};
use typst_kit::datetime::Time;

/// Bounded retention age for `comemo` eviction after PDF encoding completes.
/// Keeps shared templates, font instances, and math scope warm across consecutive
/// and concurrent (up to 8 parallel) exports while aging out per-document images.
pub const COMEMO_EVICT_MAX_AGE: usize = 8;

/// Matches desktop & Android font library caps (32 files / 64 MB).
pub const CUSTOM_FONT_CACHE_MAX_ENTRIES: usize = 32;
pub const CUSTOM_FONT_CACHE_MAX_BYTES: usize = 64_000_000;

static BUNDLED_FONT_DATA: [&[u8]; 9] = [
    include_bytes!("../fonts/NotoSans-Regular.ttf"),
    include_bytes!("../fonts/NotoSans-Bold.ttf"),
    include_bytes!("../fonts/NotoSans-Italic.ttf"),
    include_bytes!("../fonts/NotoSans-BoldItalic.ttf"),
    include_bytes!("../fonts/Manrope.ttf"),
    include_bytes!("../fonts/Roboto.ttf"),
    include_bytes!("../fonts/NotoSerif.ttf"),
    include_bytes!("../fonts/JetBrainsMono.ttf"),
    include_bytes!("../fonts/NotoEmoji.ttf"),
];

static CALLOUT_ICONS: [(&str, &[u8]); 9] = [
    ("__smd_icon_tip.svg", include_bytes!("../../desktop/icons/CalloutTip.svg")),
    ("__smd_icon_warning.svg", include_bytes!("../../desktop/icons/CalloutWarning.svg")),
    ("__smd_icon_info.svg", include_bytes!("../../desktop/icons/CalloutInfo.svg")),
    ("__smd_icon_error.svg", include_bytes!("../../desktop/icons/CalloutError.svg")),
    ("__smd_icon_success.svg", include_bytes!("../../desktop/icons/CalloutSuccess.svg")),
    ("__smd_icon_question.svg", include_bytes!("../../desktop/icons/CalloutQuestion.svg")),
    ("__smd_icon_answer.svg", include_bytes!("../../desktop/icons/CalloutAnswer.svg")),
    ("__smd_icon_example.svg", include_bytes!("../../desktop/icons/CalloutExample.svg")),
    ("__smd_icon_quote.svg", include_bytes!("../../desktop/icons/CalloutQuote.svg")),
];

pub(crate) static UNNUMBERED_DOCUMENT_TEMPLATE: LazyLock<String> = LazyLock::new(|| {
    include_str!("document.typ")
        .lines()
        .filter(|line| !line.starts_with("#set page(footer:"))
        .collect::<Vec<_>>()
        .join("\n")
});

/// Returns true if `name` is a user-supplied custom font asset (`__font_*.ttf` or `__font_*.otf`, case-insensitive).
pub fn is_font_asset(name: &str) -> bool {
    name.len() > "__font_.ttf".len()
        && name.starts_with("__font_")
        && !name.contains('/')
        && !name.contains('\\')
        && name.as_bytes().rchunks(4).next().is_some_and(|ext| {
            ext.eq_ignore_ascii_case(b".ttf") || ext.eq_ignore_ascii_case(b".otf")
        })
}

/// Validates an asset key against empty, NUL, backslash, root, or root-escaping virtual paths.
pub fn validate_asset_path(name: &str) -> Result<VirtualPath> {
    if name.is_empty() || name.contains('\0') {
        bail!("Invalid PDF asset path: {name:?}");
    }
    if name.starts_with("__font_") && (name.contains('/') || name.contains('\\')) {
        bail!("Invalid PDF asset path {name:?}: custom font key must be a flat filename");
    }
    let vpath = VirtualPath::new(name)
        .map_err(|err| anyhow!("Invalid PDF asset path {name:?}: {err}"))?;
    if vpath.is_root() {
        bail!("Invalid PDF asset path {name:?}: path resolves to project root");
    }
    Ok(vpath)
}

fn project_file_id(vpath: VirtualPath) -> FileId {
    RootedPath::new(VirtualRoot::Project, vpath).intern()
}

struct SharedTypesetter {
    library: LazyHash<Library>,
    base_book: LazyHash<FontBook>,
    base_fonts: Vec<Font>,
    base_families_lower: Vec<String>,
    main_id: FileId,
    mitex_standard: (FileId, Source, Bytes),
    mitex_prelude: (FileId, Source, Bytes),
    icons: [(FileId, Bytes); 9],
}

static SHARED: LazyLock<SharedTypesetter> = LazyLock::new(|| {
    let library = LazyHash::new(Library::default());
    let _ = typst::utils::hash128(&library);

    let mut book = FontBook::new();
    let mut base_fonts = Vec::with_capacity(32);
    let mut base_families_lower = Vec::with_capacity(32);

    for slice in BUNDLED_FONT_DATA {
        for font in Font::iter(Bytes::new(slice)) {
            let info = font.info().clone();
            base_families_lower.push(info.family.to_lowercase());
            book.push(info);
            base_fonts.push(font);
        }
    }
    for (font, info) in typst_kit::fonts::embedded() {
        base_families_lower.push(info.family.to_lowercase());
        book.push(info);
        base_fonts.push(font);
    }

    let base_book = LazyHash::new(book);
    let _ = typst::utils::hash128(&base_book);

    let main_id = project_file_id(VirtualPath::new("main.typ").expect("static main.typ"));

    let make_static_source = |path: &'static str, text: &'static str| {
        let id = project_file_id(VirtualPath::new(path).expect("static source path"));
        let src = Source::new(id, text.to_owned());
        let bytes = Bytes::from_string(src.clone());
        let _ = typst::utils::hash128(&src);
        let _ = typst::utils::hash128(&bytes);
        (id, src, bytes)
    };
    let mitex_standard = make_static_source("mitex/standard.typ", include_str!("mitex/standard.typ"));
    let mitex_prelude = make_static_source("mitex/prelude.typ", include_str!("mitex/prelude.typ"));

    let icons = CALLOUT_ICONS.map(|(name, slice)| {
        let id = project_file_id(VirtualPath::new(name).expect("static icon path"));
        let bytes = Bytes::new(slice);
        let _ = typst::utils::hash128(&bytes);
        (id, bytes)
    });

    SharedTypesetter {
        library,
        base_book,
        base_fonts,
        base_families_lower,
        main_id,
        mitex_standard,
        mitex_prelude,
        icons,
    }
});

struct CachedCustomFont {
    key: (u128, usize),
    byte_len: usize,
    fonts: Arc<[Font]>,
}

#[derive(Default)]
struct CustomFontCache {
    entries: VecDeque<CachedCustomFont>,
    total_bytes: usize,
    hits: usize,
    misses: usize,
}

static CUSTOM_FONT_CACHE: LazyLock<Mutex<CustomFontCache>> =
    LazyLock::new(|| Mutex::new(CustomFontCache::default()));

fn get_or_parse_custom_font(bytes: &[u8]) -> Arc<[Font]> {
    let key = (typst::utils::hash128(bytes), bytes.len());
    {
        let mut cache = CUSTOM_FONT_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(pos) = cache.entries.iter().position(|entry| entry.key == key) {
            let entry = cache.entries.remove(pos).expect("entry at pos");
            let fonts = Arc::clone(&entry.fonts);
            cache.entries.push_back(entry);
            cache.hits += 1;
            return fonts;
        }
    }

    let parsed: Arc<[Font]> = Font::iter(Bytes::new(bytes.to_vec()))
        .collect::<Vec<_>>()
        .into();

    let mut cache = CUSTOM_FONT_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(pos) = cache.entries.iter().position(|entry| entry.key == key) {
        let entry = cache.entries.remove(pos).expect("entry at pos");
        let fonts = Arc::clone(&entry.fonts);
        cache.entries.push_back(entry);
        cache.hits += 1;
        return fonts;
    }

    cache.misses += 1;
    if parsed.is_empty() || bytes.len() > CUSTOM_FONT_CACHE_MAX_BYTES {
        return parsed;
    }

    while !cache.entries.is_empty()
        && (cache.entries.len() >= CUSTOM_FONT_CACHE_MAX_ENTRIES
            || cache.total_bytes + bytes.len() > CUSTOM_FONT_CACHE_MAX_BYTES)
    {
        if let Some(evicted) = cache.entries.pop_front() {
            cache.total_bytes = cache.total_bytes.saturating_sub(evicted.byte_len);
        }
    }

    cache.total_bytes += bytes.len();
    cache.entries.push_back(CachedCustomFont {
        key,
        byte_len: bytes.len(),
        fonts: Arc::clone(&parsed),
    });
    parsed
}

static SYSTEM_FONT_SCANS: AtomicUsize = AtomicUsize::new(0);
static SYSTEM_FONT_FACE_LOADS: AtomicUsize = AtomicUsize::new(0);

#[cfg(not(target_os = "android"))]
struct SystemFontSlot {
    path: typst_kit::fonts::FontPath,
    info: FontInfo,
    family_lower: String,
    loaded: OnceLock<Option<Font>>,
}

#[cfg(not(target_os = "android"))]
impl SystemFontSlot {
    fn get(&self) -> Option<Font> {
        self.loaded
            .get_or_init(|| {
                use typst_kit::fonts::FontSource;
                let font = self.path.load();
                if font.is_some() {
                    SYSTEM_FONT_FACE_LOADS.fetch_add(1, Ordering::SeqCst);
                }
                font
            })
            .clone()
    }
}

#[cfg(not(target_os = "android"))]
struct SystemFonts {
    slots: Vec<SystemFontSlot>,
    combined_book: LazyHash<FontBook>,
}

#[cfg(not(target_os = "android"))]
static SYSTEM_FONTS: OnceLock<SystemFonts> = OnceLock::new();

#[cfg(not(target_os = "android"))]
fn system_fonts() -> &'static SystemFonts {
    SYSTEM_FONTS.get_or_init(|| {
        SYSTEM_FONT_SCANS.fetch_add(1, Ordering::SeqCst);
        let shared = &*SHARED;
        let mut combined_book = shared.base_book.deref().clone();
        let mut slots = Vec::new();
        for (path, info) in typst_kit::fonts::system() {
            let family_lower = info.family.to_lowercase();
            combined_book.push(info.clone());
            slots.push(SystemFontSlot {
                path,
                info,
                family_lower,
                loaded: OnceLock::new(),
            });
        }
        let combined_book = LazyHash::new(combined_book);
        let _ = typst::utils::hash128(&combined_book);
        SystemFonts { slots, combined_book }
    })
}

enum CustomSlot {
    Font(Font),
    Base(usize),
    #[cfg(not(target_os = "android"))]
    System(&'static SystemFonts, usize),
}

enum FontPlan {
    BaseOnly,
    #[cfg(not(target_os = "android"))]
    BaseAndSystem(&'static SystemFonts),
    Custom(Vec<CustomSlot>),
}

struct ExportWorld {
    main_source: Source,
    main_bytes: Bytes,
    book: Cow<'static, LazyHash<FontBook>>,
    font_plan: FontPlan,
    binaries: HashMap<FileId, Bytes>,
    time: Time,
}

impl ExportWorld {
    fn new(
        source_text: String,
        requested_family: &str,
        assets: &HashMap<String, Vec<u8>>,
        extra_binaries: Option<HashMap<FileId, Bytes>>,
    ) -> Result<Self> {
        let shared = &*SHARED;
        let mut custom_font_entries: Vec<(&str, &[u8])> = Vec::new();
        let mut binaries = extra_binaries.unwrap_or_default();

        for (name, bytes) in assets {
            let vpath = validate_asset_path(name)?;
            if is_font_asset(name) {
                custom_font_entries.push((name.as_str(), bytes.as_slice()));
            } else {
                binaries.insert(project_file_id(vpath), Bytes::new(bytes.clone()));
            }
        }

        custom_font_entries.sort_unstable_by(|a, b| a.0.cmp(b.0));

        let mut custom_fonts: Vec<Font> = Vec::new();
        let mut custom_families: HashSet<String> = HashSet::new();
        for (_, bytes) in custom_font_entries {
            for font in get_or_parse_custom_font(bytes).iter() {
                custom_families.insert(font.info().family.to_lowercase());
                custom_fonts.push(font.clone());
            }
        }

        let requested_trimmed = requested_family.trim();
        let requested_lower = requested_family.to_lowercase();
        let matched_builtin_or_custom = requested_trimmed.is_empty()
            || shared.base_book.contains_family(&requested_lower)
            || custom_families.contains(&requested_lower);

        let (book, font_plan) = if custom_fonts.is_empty() {
            if matched_builtin_or_custom {
                (Cow::Borrowed(&shared.base_book), FontPlan::BaseOnly)
            } else {
                #[cfg(not(target_os = "android"))]
                {
                    let sys = system_fonts();
                    (Cow::Borrowed(&sys.combined_book), FontPlan::BaseAndSystem(sys))
                }
                #[cfg(target_os = "android")]
                {
                    (Cow::Borrowed(&shared.base_book), FontPlan::BaseOnly)
                }
            }
        } else {
            let mut custom_book = FontBook::new();
            let mut slots = Vec::with_capacity(custom_fonts.len() + shared.base_fonts.len());

            for font in custom_fonts {
                custom_book.push(font.info().clone());
                slots.push(CustomSlot::Font(font));
            }
            for (idx, font) in shared.base_fonts.iter().enumerate() {
                if !custom_families.contains(&shared.base_families_lower[idx]) {
                    custom_book.push(font.info().clone());
                    slots.push(CustomSlot::Base(idx));
                }
            }
            #[cfg(not(target_os = "android"))]
            if !matched_builtin_or_custom {
                let sys = system_fonts();
                for (idx, slot) in sys.slots.iter().enumerate() {
                    if !custom_families.contains(&slot.family_lower) {
                        custom_book.push(slot.info.clone());
                        slots.push(CustomSlot::System(sys, idx));
                    }
                }
            }

            (Cow::Owned(LazyHash::new(custom_book)), FontPlan::Custom(slots))
        };

        let main_source = Source::new(shared.main_id, source_text);
        let main_bytes = Bytes::from_string(main_source.clone());

        Ok(Self {
            main_source,
            main_bytes,
            book,
            font_plan,
            binaries,
            time: Time::system(),
        })
    }
}

impl World for ExportWorld {
    fn library(&self) -> &LazyHash<Library> {
        &SHARED.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        &self.book
    }

    fn main(&self) -> FileId {
        SHARED.main_id
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        let shared = &*SHARED;
        if id == shared.main_id {
            return Ok(self.main_source.clone());
        }
        if id == shared.mitex_standard.0 {
            return Ok(shared.mitex_standard.1.clone());
        }
        if id == shared.mitex_prelude.0 {
            return Ok(shared.mitex_prelude.1.clone());
        }
        Err(FileError::NotFound(PathBuf::from(id.vpath().get_without_slash())))
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        let shared = &*SHARED;
        if id == shared.main_id {
            return Ok(self.main_bytes.clone());
        }
        if id == shared.mitex_standard.0 {
            return Ok(shared.mitex_standard.2.clone());
        }
        if id == shared.mitex_prelude.0 {
            return Ok(shared.mitex_prelude.2.clone());
        }
        for (icon_id, bytes) in &shared.icons {
            if id == *icon_id {
                return Ok(bytes.clone());
            }
        }
        if let Some(bytes) = self.binaries.get(&id) {
            return Ok(bytes.clone());
        }
        Err(FileError::NotFound(PathBuf::from(id.vpath().get_without_slash())))
    }

    fn font(&self, index: usize) -> Option<Font> {
        match &self.font_plan {
            FontPlan::BaseOnly => SHARED.base_fonts.get(index).cloned(),
            #[cfg(not(target_os = "android"))]
            FontPlan::BaseAndSystem(sys) => {
                if let Some(font) = SHARED.base_fonts.get(index) {
                    Some(font.clone())
                } else {
                    let sys_idx = index.checked_sub(SHARED.base_fonts.len())?;
                    sys.slots.get(sys_idx)?.get()
                }
            }
            FontPlan::Custom(slots) => match slots.get(index)? {
                CustomSlot::Font(font) => Some(font.clone()),
                CustomSlot::Base(idx) => SHARED.base_fonts.get(*idx).cloned(),
                #[cfg(not(target_os = "android"))]
                CustomSlot::System(sys, idx) => sys.slots.get(*idx)?.get(),
            },
        }
    }

    fn today(&self, offset: Option<Duration>) -> Option<Datetime> {
        self.time.today(offset)
    }
}

struct EvictAfterPdf;

impl Drop for EvictAfterPdf {
    fn drop(&mut self) {
        typst::comemo::evict(COMEMO_EVICT_MAX_AGE);
    }
}

fn compile_and_encode(world: ExportWorld) -> Result<Vec<u8>> {
    let _evict = EvictAfterPdf;
    let document = typst::compile(&world)
        .output
        .map_err(|errors| anyhow!("PDF typesetting failed: {errors:?}"))?;
    let pdf = typst_pdf::pdf(&document, &Default::default())
        .map_err(|errors| anyhow!("PDF encoding failed: {errors:?}"))?;
    drop(document);
    drop(world);
    Ok(pdf)
}

pub fn export_typst(
    source_text: String,
    options: &crate::PdfOptions,
    assets: &HashMap<String, Vec<u8>>,
) -> Result<Vec<u8>> {
    let world = ExportWorld::new(source_text, &options.font_family, assets, None)?;
    compile_and_encode(world)
}

#[doc(hidden)]
pub mod diagnostics {
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
}
