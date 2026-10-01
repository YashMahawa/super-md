use super::{atomic_write, display_error};
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{fs, io::{Read, Write}, net::{IpAddr, ToSocketAddrs}, path::PathBuf, time::Duration};
use smd_core::portable::{image_bytes, PortableDocument};

// Extract a bundle once per file revision. Only the small Markdown string and
// requested image cross the bridge, rather than reparsing every embedded image.
pub fn portable_cache(path: &std::path::Path) -> Result<PathBuf> {
    use std::hash::{Hash, Hasher};
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK.lock().map_err(|_| anyhow::anyhow!("Portable cache unavailable"))?;
    let path = path.canonicalize()?; let metadata = fs::metadata(&path)?;
    if metadata.len() > smd_core::portable::MAX_FILE as u64 { bail!("FMD exceeds 120 MB"); }
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hash); metadata.len().hash(&mut hash); metadata.modified()?.hash(&mut hash);
    let cache = dirs::cache_dir().context("Cache directory unavailable")?.join("super-md/portable").join(format!("{:016x}", hash.finish()));
    if cache.join("complete").is_file() { return Ok(cache); }
    let bundle = PortableDocument::decode(&fs::read_to_string(path)?)?;
    fs::create_dir_all(&cache)?;
    for (name, data) in bundle.assets { let bytes = image_bytes(&data)?.1; atomic_write(&cache.join(name.trim_start_matches("assets/")), &bytes)?; }
    atomic_write(&cache.join("markdown"), bundle.markdown.as_bytes())?;
    atomic_write(&cache.join("complete"), b"1")?;
    Ok(cache)
}

pub fn attachment_directory() -> Result<PathBuf> {
    let dir = dirs::data_local_dir().context("Application data directory unavailable")?.join("super-md/attachments"); fs::create_dir_all(&dir)?; Ok(dir)
}
pub fn mime(extension: &str) -> Option<&'static str> { match extension.to_ascii_lowercase().as_str() {
    "svg" => Some("image/svg+xml"), "png" => Some("image/png"), "jpg" | "jpeg" => Some("image/jpeg"), "gif" => Some("image/gif"), "webp" => Some("image/webp"), "avif" => Some("image/avif"), _ => None,
} }
#[derive(Deserialize)] pub struct ImageInput { name: String, data: String }
#[derive(Serialize)] pub struct ImportedImage { source: String, alt: String }
pub fn store_image(name: String, data: String) -> Result<ImportedImage> {
    let (kind, bytes) = image_bytes(&data)?;
    let extension = match kind { "image/svg+xml" => "svg", "image/jpeg" => "jpg", _ => kind.trim_start_matches("image/") };
    let directory = attachment_directory()?;
    let mut file = tempfile::Builder::new().prefix("import-").suffix(&format!(".{extension}")).tempfile_in(&directory)?;
    file.write_all(&bytes)?; file.as_file().sync_all()?;
    let (_, path) = file.keep()?;
    Ok(ImportedImage { source: format!("assets/{}", path.file_name().unwrap().to_string_lossy()), alt: name.chars().take(200).collect() })
}
#[tauri::command] pub async fn import_images(images: Vec<ImageInput>) -> Result<Vec<ImportedImage>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if images.len() > 32 || images.iter().map(|i| i.data.len()).sum::<usize>() > 100_000_000 { bail!("Too many/large images"); }
        images.into_iter().map(|i| store_image(i.name, i.data)).collect::<Result<Vec<_>>>()
    }).await.map_err(display_error)?.map_err(display_error)
}
#[tauri::command] pub async fn import_image_paths(paths: Vec<String>) -> Result<Vec<ImportedImage>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if paths.len() > 32 { bail!("Insert at most 32 images at once"); }
        let mut total = 0;
        paths.into_iter().map(|path| {
            let path = PathBuf::from(path); let size = fs::metadata(&path)?.len(); total += size;
            if size > 25_000_000 || total > 75_000_000 { bail!("Images exceed the size limit"); }
            let kind = mime(path.extension().and_then(|s| s.to_str()).unwrap_or("")).context("Unsupported image file")?;
            store_image(path.file_name().unwrap().to_string_lossy().into_owned(), format!("data:{kind};base64,{}", STANDARD.encode(fs::read(path)?)))
        }).collect::<Result<Vec<_>>>()
    }).await.map_err(display_error)?.map_err(display_error)
}
#[derive(Serialize)] pub struct Resource { body: String }
fn public_address(ip: IpAddr) -> bool { match ip {
    IpAddr::V4(ip) => !ip.is_private() && !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified() && !ip.is_multicast() && !ip.is_broadcast() && ip.octets()[0] != 0 && !(ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1])),
    IpAddr::V6(ip) => !ip.is_loopback() && !ip.is_unspecified() && !ip.is_multicast() && !ip.is_unique_local() && !ip.is_unicast_link_local() && ip.to_ipv4_mapped().map(|v| public_address(IpAddr::V4(v))).unwrap_or(true),
} }
#[tauri::command] pub async fn fetch_resource(url: String, image: bool) -> Result<Resource, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Resource> {
        let mut current = reqwest::Url::parse(&url)?;
        for _ in 0..=4 {
            if current.scheme() != "https" || !current.username().is_empty() || current.password().is_some() || current.port_or_known_default() != Some(443) { bail!("Use a public HTTPS address without login details"); }
            let host = current.host_str().context("Address has no host")?;
            let addresses = (host, 443).to_socket_addrs()?.collect::<Vec<_>>();
            if addresses.is_empty() || addresses.iter().any(|a| !public_address(a.ip())) { bail!("Local/private network addresses are not fetched"); }
            let client = reqwest::blocking::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(15)).resolve_to_addrs(host, &addresses).build()?;
            let response = client.get(current.clone()).header("User-Agent", "SuperMD/0.2 (user-requested link preview)").send()?;
            if response.status().is_redirection() { let location = response.headers().get(reqwest::header::LOCATION).context("Redirect has no destination")?.to_str()?; current = current.join(location)?; continue; }
            let response = response.error_for_status()?;
            let kind = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").split(';').next().unwrap_or("").trim().to_string();
            let limit = if image { 25_000_000 } else { 1_000_000 };
            let mut bytes = Vec::new(); response.take(limit + 1).read_to_end(&mut bytes)?;
            if bytes.len() > limit as usize { bail!("Remote resource exceeds the size limit"); }
            return if image {
                let data = format!("data:{kind};base64,{}", STANDARD.encode(bytes)); image_bytes(&data)?; Ok(Resource { body: data })
            } else { Ok(Resource { body: String::from_utf8_lossy(&bytes).into_owned() }) };
        }
        bail!("Too many redirects")
    }).await.map_err(display_error)?.map_err(display_error)
}
#[tauri::command] pub async fn export_fmd(content: String, assets: std::collections::BTreeMap<String, String>) -> Result<Option<String>, String> {
    let target = rfd::AsyncFileDialog::new().add_filter("Portable Super MD", &["fmd"]).set_file_name("notes.fmd").save_file().await;
    let Some(target) = target else { return Ok(None) };
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>> { let data = PortableDocument::new(content, assets).encode()?; atomic_write(target.path(), data.as_bytes())?; Ok(Some(target.path().to_string_lossy().into_owned())) }).await.map_err(display_error)?.map_err(display_error)
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn rejects_private_and_mapped_networks() {
        for ip in ["127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.1.1", "::1", "::ffff:127.0.0.1", "fd00::1"] { assert!(!public_address(ip.parse().unwrap())); }
        assert!(public_address("8.8.8.8".parse().unwrap()));
    }
}
