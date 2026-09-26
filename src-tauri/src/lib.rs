use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    str::FromStr,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    path: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveRequest {
    path: Option<String>,
    content: String,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExportOptions {
    page_size: String,
    margin: f32,
    font_size: f32,
    line_height: f32,
    font_family: String,
    output: Option<String>,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            page_size: "a4".into(),
            margin: 18.0,
            font_size: 10.5,
            line_height: 1.35,
            font_family: "New Computer Modern".into(),
            output: None,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PythonResult {
    stdout: String,
    stderr: String,
    images: Vec<String>,
    ok: bool,
}

#[derive(Deserialize)]
struct ChartSpec {
    title: Option<String>,
    x: Option<ChartAxis>,
    y: Option<ChartAxis>,
    series: Vec<ChartSeries>,
    #[serde(default)]
    sliders: Vec<ChartSlider>,
}

#[derive(Deserialize)]
struct ChartAxis {
    min: Option<f64>,
    max: Option<f64>,
    steps: Option<usize>,
    label: Option<String>,
}

#[derive(Deserialize)]
struct ChartSeries {
    name: Option<String>,
    expression: Option<String>,
    points: Option<Vec<[f64; 2]>>,
    color: Option<String>,
}

#[derive(Deserialize)]
struct ChartSlider {
    name: String,
    value: f64,
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn open_document() -> Result<Option<Document>, String> {
    let path = rfd::FileDialog::new()
        .add_filter("Super Markdown", &["smd", "md", "markdown"])
        .pick_file();
    path.map(read_document).transpose().map_err(display_error)
}

#[cfg(target_os = "android")]
#[tauri::command]
fn open_document() -> Result<Option<Document>, String> {
    Err("Use Android's document picker".into())
}

#[tauri::command]
fn read_document_at(path: String) -> Result<Document, String> {
    read_document(PathBuf::from(path)).map_err(display_error)
}

fn read_document(path: PathBuf) -> Result<Document> {
    let content =
        fs::read_to_string(&path).with_context(|| format!("Could not read {}", path.display()))?;
    Ok(Document {
        path: path.to_string_lossy().into_owned(),
        content,
    })
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn save_document(request: SaveRequest) -> Result<Option<String>, String> {
    let path = match request.path {
        Some(path) => PathBuf::from(path),
        None => match rfd::FileDialog::new()
            .add_filter("Super Markdown", &["smd"])
            .add_filter("Markdown", &["md"])
            .set_file_name("notes.smd")
            .save_file()
        {
            Some(path) => path,
            None => return Ok(None),
        },
    };
    fs::write(&path, request.content)
        .with_context(|| format!("Could not save {}", path.display()))
        .map_err(display_error)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(target_os = "android")]
#[tauri::command]
fn save_document(_request: SaveRequest) -> Result<Option<String>, String> {
    Err("Use Android's document picker".into())
}

#[tauri::command]
fn load_caelestia_theme() -> Option<Value> {
    let state = dirs::state_dir()?.join("caelestia/scheme.json");
    serde_json::from_str(&fs::read_to_string(state).ok()?).ok()
}

#[tauri::command]
fn startup_document(path: tauri::State<'_, Option<String>>) -> Result<Option<Document>, String> {
    path.as_ref()
        .map(|value| read_document(PathBuf::from(value)))
        .transpose()
        .map_err(display_error)
}

fn draft_filename(label: &str) -> Result<String, String> {
    if !label
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    {
        return Err("Invalid window label".into());
    }
    Ok(if label == "main" {
        "untitled-draft.smd".to_string()
    } else {
        format!("untitled-draft-{label}.smd")
    })
}

fn draft_path(label: &str) -> Result<PathBuf, String> {
    let filename = draft_filename(label)?;
    let directory = dirs::data_local_dir()
        .ok_or_else(|| "Could not locate application data directory".to_string())?
        .join("super-md");
    fs::create_dir_all(&directory).map_err(display_error)?;
    Ok(directory.join(filename))
}

#[tauri::command]
fn save_draft(window: tauri::Window, content: String) -> Result<(), String> {
    let target = draft_path(window.label())?;
    let temporary = target.with_extension("smd.tmp");
    fs::write(&temporary, content).map_err(display_error)?;
    fs::rename(temporary, target).map_err(display_error)
}

#[tauri::command]
fn load_draft(window: tauri::Window) -> Result<Option<String>, String> {
    let target = draft_path(window.label())?;
    if !target.exists() {
        return Ok(None);
    }
    fs::read_to_string(target).map(Some).map_err(display_error)
}

#[tauri::command]
fn clear_draft(window: tauri::Window) -> Result<(), String> {
    let target = draft_path(window.label())?;
    if target.exists() {
        fs::remove_file(target).map_err(display_error)?;
    }
    Ok(())
}

#[tauri::command]
fn list_draft_windows() -> Result<Vec<String>, String> {
    let main = draft_path("main")?;
    let directory = main
        .parent()
        .ok_or_else(|| "Draft directory missing".to_string())?;
    let mut labels = Vec::new();
    for entry in fs::read_dir(directory).map_err(display_error)? {
        let entry = entry.map_err(display_error)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(label) = name
            .strip_prefix("untitled-draft-")
            .and_then(|value| value.strip_suffix(".smd"))
        {
            if label.starts_with("document-")
                && label
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
            {
                labels.push(label.to_string());
            }
        }
    }
    labels.sort();
    labels.reverse();
    labels.truncate(24);
    Ok(labels)
}

#[tauri::command]
fn load_asset(document_path: String, source: String) -> Result<String, String> {
    if document_path.trim().is_empty() {
        return Err("Save the document before loading relative images".into());
    }
    let encoded_path = source.split(['?', '#']).next().unwrap_or(&source);
    let decoded_path = percent_decode_str(encoded_path).decode_utf8_lossy();
    let source_path = if let Some(file_url) = decoded_path.strip_prefix("file://") {
        Path::new(file_url)
    } else {
        Path::new(decoded_path.as_ref())
    };
    let root = Path::new(&document_path)
        .parent()
        .ok_or_else(|| "Document has no parent directory".to_string())?
        .canonicalize()
        .map_err(display_error)?;
    let path = if source_path.is_absolute() {
        source_path.to_path_buf()
    } else {
        root.join(source_path)
    };
    let path = path.canonicalize().map_err(display_error)?;
    if !path.starts_with(&root) || !path.is_file() {
        return Err("Image must be inside the document's folder".into());
    }
    if fs::metadata(&path).map_err(display_error)?.len() > 25 * 1024 * 1024 {
        return Err("Image is larger than 25 MB".into());
    }
    let bytes = fs::read(&path).map_err(display_error)?;
    let mime = match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "svg" => "image/svg+xml",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "image/png",
    };
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn choose_python() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Choose Python interpreter")
        .pick_file()
        .map(|path| path.to_string_lossy().into_owned())
}

#[cfg(target_os = "android")]
#[tauri::command]
fn choose_python() -> Option<String> { None }

#[tauri::command]
fn detect_python() -> Option<String> {
    ["python3", "python"]
        .iter()
        .find_map(|name| which::which(name).ok())
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn run_python(python: String, code: String) -> Result<PythonResult, String> {
    run_python_inner(&python, &code).map_err(display_error)
}

fn run_python_inner(python: &str, code: &str) -> Result<PythonResult> {
    let directory = tempfile::tempdir()?;
    let runner = directory.path().join("supermd_runner.py");
    fs::write(&runner, include_str!("python_runner.py"))?;
    let mut child = Command::new(python)
        .arg(&runner)
        .current_dir(directory.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("Could not start Python interpreter: {python}"))?;
    child
        .stdin
        .take()
        .context("Could not open Python stdin")?
        .write_all(serde_json::to_string(code)?.as_bytes())?;
    let output = child.wait_with_output()?;
    if !output.status.success() && output.stdout.is_empty() {
        bail!("{}", String::from_utf8_lossy(&output.stderr));
    }
    serde_json::from_slice(&output.stdout).context("Python runner returned invalid output")
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn export_pdf(
    path: Option<String>,
    content: String,
    options: ExportOptions,
) -> Result<Option<String>, String> {
    let suggested = path
        .as_deref()
        .map(Path::new)
        .and_then(|value| value.file_stem())
        .and_then(|value| value.to_str())
        .map(|value| format!("{value}.pdf"))
        .unwrap_or_else(|| "notes.pdf".into());
    let output = match options.output.clone() {
        Some(output) => PathBuf::from(output),
        None => match rfd::FileDialog::new()
            .add_filter("PDF document", &["pdf"])
            .set_file_name(&suggested)
            .save_file()
        {
            Some(path) => path,
            None => return Ok(None),
        },
    };
    export_pdf_inner(path.as_deref().map(Path::new), &content, &output, &options)
        .map_err(display_error)?;
    Ok(Some(output.to_string_lossy().into_owned()))
}

#[cfg(target_os = "android")]
#[tauri::command]
fn export_pdf(_path: Option<String>, _content: String, _options: ExportOptions) -> Result<Option<String>, String> {
    Err("On-device semantic PDF export is not available yet".into())
}

fn export_pdf_inner(
    source: Option<&Path>,
    content: &str,
    output: &Path,
    options: &ExportOptions,
) -> Result<()> {
    let pandoc =
        which::which("pandoc").context("Pandoc was not found. Install pandoc 3 or newer.")?;
    which::which("typst").context("Typst was not found. Install typst 0.13 or newer.")?;
    let directory = tempfile::tempdir()?;
    let input = directory.path().join("document.md");
    let header = directory.path().join("supermd.typ");
    let metadata = directory.path().join("export.yaml");
    fs::write(&input, render_export_markdown(content, directory.path())?)?;
    fs::write(&header, include_str!("supermd.typ"))?;

    let margin = format!("{}mm", options.margin.clamp(4.0, 60.0));
    let font_size = format!("{}pt", options.font_size.clamp(7.0, 24.0));
    let line_height = options.line_height.clamp(0.9, 2.2).to_string();
    let font_family = match options.font_family.as_str() {
        "New Computer Modern"
        | "Libertinus Serif"
        | "Noto Sans"
        | "DejaVu Serif"
        | "Arial"
        | "Georgia"
        | "Times New Roman" => options.font_family.as_str(),
        _ => bail!("Unsupported PDF font"),
    };
    fs::write(
        &metadata,
        format!(
            "papersize: {}\nmainfont: '{}'\nfontsize: {}\nlinestretch: {}\nmargin:\n  top: {}\n  right: {}\n  bottom: {}\n  left: {}\n",
            options.page_size.to_ascii_lowercase(), font_family, font_size, line_height, margin, margin, margin, margin
        ),
    )?;
    let resource = source
        .and_then(Path::parent)
        .unwrap_or_else(|| Path::new("."));
    let resource_paths = std::env::join_paths([resource, directory.path()])
        .context("Could not build resource search path")?;
    let status = Command::new(pandoc)
        .arg(&input)
        .arg("--from=markdown+tex_math_dollars+fenced_divs+pipe_tables+task_lists+strikeout")
        .arg("--pdf-engine=typst")
        .arg("--standalone")
        .arg("--syntax-highlighting=zenburn")
        .arg(format!(
            "--resource-path={}",
            resource_paths.to_string_lossy()
        ))
        .arg(format!("--include-in-header={}", header.display()))
        .arg(format!("--metadata-file={}", metadata.display()))
        .arg("--output")
        .arg(output)
        .status()?;
    if !status.success() {
        bail!("Pandoc/Typst export failed with status {status}");
    }
    Ok(())
}

fn normalize_super_markdown(input: &str) -> String {
    let mut output = String::new();
    let mut callout: Option<(String, String, Vec<String>)> = None;
    for line in input.lines() {
        if let Some(rest) = line.strip_prefix(":::callout") {
            let mut pieces = rest.trim().splitn(2, char::is_whitespace);
            let kind = pieces
                .next()
                .filter(|v| !v.is_empty())
                .unwrap_or("note")
                .to_uppercase();
            let title = pieces.next().unwrap_or(&kind).trim_matches('"').to_string();
            callout = Some((kind, title, Vec::new()));
        } else if line.trim() == ":::" && callout.is_some() {
            let (_kind, title, lines) = callout.take().unwrap();
            output.push_str(&format!("> **{title}**\n"));
            for value in lines {
                output.push_str("> ");
                output.push_str(&value);
                output.push('\n');
            }
            output.push('\n');
        } else if let Some((_, _, lines)) = callout.as_mut() {
            lines.push(line.to_string());
        } else {
            let trimmed = line.trim_start();
            if let Some(marker) = trimmed.strip_prefix("> [!") {
                if let Some(end) = marker.find(']') {
                    let kind = &marker[..end];
                    let title = marker[end + 1..].trim();
                    let label = if title.is_empty() { kind } else { title };
                    output.push_str(&format!("> **{label}**\n"));
                    continue;
                }
            }
            output.push_str(line);
            output.push('\n');
        }
    }
    if let Some((_kind, title, lines)) = callout {
        output.push_str(&format!("> **{title}**\n"));
        for value in lines {
            output.push_str("> ");
            output.push_str(&value);
            output.push('\n');
        }
    }
    output
}

fn render_export_markdown(input: &str, directory: &Path) -> Result<String> {
    let normalized = normalize_super_markdown(input);
    let mut output = String::new();
    let mut chart = None::<Vec<String>>;
    let mut chart_index = 0;
    for line in normalized.lines() {
        if line.trim() == "```smd-chart" && chart.is_none() {
            chart = Some(Vec::new());
        } else if line.trim() == "```" && chart.is_some() {
            let source = chart.take().unwrap().join("\n");
            match serde_json::from_str::<ChartSpec>(&source).and_then(|spec| {
                let svg = render_chart_svg(&spec).map_err(serde::de::Error::custom)?;
                chart_index += 1;
                let filename = format!("supermd-chart-{chart_index}.svg");
                fs::write(directory.join(&filename), svg).map_err(serde::de::Error::custom)?;
                Ok((
                    spec.title.unwrap_or_else(|| "Interactive chart".into()),
                    filename,
                ))
            }) {
                Ok((title, filename)) => output.push_str(&format!(
                    "![{}]({filename}){{ width=100% }}\n\n",
                    title.replace(']', "")
                )),
                Err(_) => output.push_str(&format!("```json\n{source}\n```\n")),
            }
        } else if let Some(lines) = chart.as_mut() {
            lines.push(line.to_string());
        } else {
            output.push_str(line);
            output.push('\n');
        }
    }
    Ok(output)
}

fn render_chart_svg(spec: &ChartSpec) -> Result<String> {
    let width = 900.0;
    let height = 430.0;
    let left = 64.0;
    let right = 24.0;
    let top = 32.0;
    let bottom = 58.0;
    let x_min = spec.x.as_ref().and_then(|axis| axis.min).unwrap_or(-10.0);
    let x_max = spec.x.as_ref().and_then(|axis| axis.max).unwrap_or(10.0);
    let steps = spec
        .x
        .as_ref()
        .and_then(|axis| axis.steps)
        .unwrap_or(200)
        .clamp(8, 1500);
    let mut context = meval::Context::new();
    for slider in &spec.sliders {
        context.var(&slider.name, slider.value);
    }
    let mut all_series: Vec<Vec<[f64; 2]>> = Vec::new();
    for series in &spec.series {
        if let Some(points) = &series.points {
            all_series.push(points.clone());
            continue;
        }
        let expression = series
            .expression
            .as_deref()
            .unwrap_or("0")
            .replace("Math.", "");
        let parsed = meval::Expr::from_str(&expression)
            .with_context(|| format!("Invalid chart expression: {expression}"))?;
        let mut points = Vec::with_capacity(steps + 1);
        for index in 0..=steps {
            let x = x_min + index as f64 / steps as f64 * (x_max - x_min);
            context.var("x", x);
            let y = parsed.eval_with_context(&context)?;
            if y.is_finite() {
                points.push([x, y]);
            }
        }
        all_series.push(points);
    }
    let y_values: Vec<f64> = all_series.iter().flatten().map(|point| point[1]).collect();
    let auto_min = y_values.iter().copied().fold(f64::INFINITY, f64::min);
    let auto_max = y_values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let y_min = spec
        .y
        .as_ref()
        .and_then(|axis| axis.min)
        .unwrap_or(auto_min.min(-1.0));
    let y_max = spec
        .y
        .as_ref()
        .and_then(|axis| axis.max)
        .unwrap_or(auto_max.max(1.0));
    let px =
        |x: f64| left + (x - x_min) / (x_max - x_min).max(f64::EPSILON) * (width - left - right);
    let py = |y: f64| {
        top + (1.0 - (y - y_min) / (y_max - y_min).max(f64::EPSILON)) * (height - top - bottom)
    };
    let colors = ["#6750a4", "#006a6a", "#b3261e", "#7d5700", "#3f6374"];
    let mut svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}"><rect width="100%" height="100%" rx="16" fill="#faf7fc"/><g stroke="#c9c3cc" stroke-width="1">"##
    );
    if y_min <= 0.0 && y_max >= 0.0 {
        svg.push_str(&format!(
            r#"<line x1="{left}" y1="{}" x2="{}" y2="{}"/>"#,
            py(0.0),
            width - right,
            py(0.0)
        ));
    }
    if x_min <= 0.0 && x_max >= 0.0 {
        svg.push_str(&format!(
            r#"<line x1="{}" y1="{top}" x2="{}" y2="{}"/>"#,
            px(0.0),
            px(0.0),
            height - bottom
        ));
    }
    svg.push_str("</g>");
    for (index, points) in all_series.iter().enumerate() {
        let color = spec.series[index]
            .color
            .as_deref()
            .unwrap_or(colors[index % colors.len()]);
        let encoded = points
            .iter()
            .map(|point| format!("{:.2},{:.2}", px(point[0]), py(point[1])))
            .collect::<Vec<_>>()
            .join(" ");
        svg.push_str(&format!(
            r#"<polyline fill="none" stroke="{}" stroke-width="3.5" points="{}"/>"#,
            xml_escape(color),
            encoded
        ));
    }
    let x_label = spec
        .x
        .as_ref()
        .and_then(|axis| axis.label.as_deref())
        .unwrap_or("x");
    let y_label = spec
        .y
        .as_ref()
        .and_then(|axis| axis.label.as_deref())
        .unwrap_or("y");
    svg.push_str(&format!(r##"<g fill="#49454f" font-family="sans-serif" font-size="15"><text x="{left}" y="{}">{}: {:.2} … {:.2}</text><text x="12" y="22">{}: {:.2} … {:.2}</text>"##, height-15.0, xml_escape(x_label), x_min, x_max, xml_escape(y_label), y_min, y_max));
    let mut legend_x = left;
    for (index, series) in spec.series.iter().enumerate() {
        let label = series
            .name
            .as_deref()
            .or(series.expression.as_deref())
            .unwrap_or("series");
        let color = series
            .color
            .as_deref()
            .unwrap_or(colors[index % colors.len()]);
        svg.push_str(&format!(
            r#"<text x="{legend_x}" y="22" fill="{}">● {}</text>"#,
            xml_escape(color),
            xml_escape(label)
        ));
        legend_x += 150.0;
    }
    svg.push_str("</g></svg>");
    Ok(svg)
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn display_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn print_help() {
    println!("Super MD\n\nUSAGE:\n  super-md                     Open the desktop app\n  super-md <file.smd>          Open a document\n  super-md export <input> [-o output.pdf] [--page-size A4] [--margin 18] [--font 'New Computer Modern']\n  super-md doctor              Check optional runtimes");
}

fn run_cli(arguments: &[String]) -> Result<bool> {
    if arguments.is_empty() {
        return Ok(false);
    }
    match arguments[0].as_str() {
        "--help" | "-h" | "help" => {
            print_help();
            Ok(true)
        }
        "--version" | "-V" => {
            println!("super-md {}", env!("CARGO_PKG_VERSION"));
            Ok(true)
        }
        "doctor" => {
            for command in ["pandoc", "typst", "python3"] {
                match which::which(command) {
                    Ok(path) => println!("✓ {command}: {}", path.display()),
                    Err(_) => println!("✗ {command}: not found"),
                }
            }
            Ok(true)
        }
        "export" => {
            let input = arguments.get(1).context("Missing input file")?;
            let mut options = ExportOptions::default();
            let mut index = 2;
            while index < arguments.len() {
                match arguments[index].as_str() {
                    "-o" | "--output" => {
                        index += 1;
                        options.output =
                            Some(arguments.get(index).context("Missing output path")?.clone());
                    }
                    "--page-size" => {
                        index += 1;
                        options.page_size =
                            arguments.get(index).context("Missing page size")?.clone();
                    }
                    "--margin" => {
                        index += 1;
                        options.margin = arguments.get(index).context("Missing margin")?.parse()?;
                    }
                    "--font" => {
                        index += 1;
                        options.font_family =
                            arguments.get(index).context("Missing font name")?.clone();
                    }
                    unknown => bail!("Unknown export option: {unknown}"),
                }
                index += 1;
            }
            let input_path = PathBuf::from(input);
            let content = fs::read_to_string(&input_path)?;
            let output = options
                .output
                .clone()
                .map(PathBuf::from)
                .unwrap_or_else(|| input_path.with_extension("pdf"));
            export_pdf_inner(Some(&input_path), &content, &output, &options)?;
            println!("{}", output.display());
            Ok(true)
        }
        _ => Ok(false),
    }
}

pub fn run() -> Result<()> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if run_cli(&arguments)? {
        return Ok(());
    }
    let startup_path = arguments.first().cloned();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(startup_path)
        .invoke_handler(tauri::generate_handler![
            open_document,
            read_document_at,
            save_document,
            load_caelestia_theme,
            startup_document,
            save_draft,
            load_draft,
            clear_draft,
            list_draft_windows,
            load_asset,
            choose_python,
            detect_python,
            run_python,
            export_pdf
        ])
        .run(tauri::generate_context!())
        .context("Tauri failed")?;
    Ok(())
}

#[cfg(mobile)]
#[tauri::mobile_entry_point]
pub fn mobile_main() {
    run().expect("Super MD mobile startup failed");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_super_callouts() {
        let result = normalize_super_markdown(":::callout warning Careful\nDo not blink.\n:::");
        assert!(result.contains("> **Careful**"));
        assert!(result.contains("> Do not blink."));
    }

    #[test]
    fn loads_relative_image_with_encoded_spaces() {
        let directory = tempfile::tempdir().unwrap();
        let images = directory.path().join("DM Images");
        fs::create_dir(&images).unwrap();
        fs::write(images.join("diagram.png"), b"image bytes").unwrap();
        let document = directory.path().join("DM Morning Notes.md");
        let result = load_asset(
            document.to_string_lossy().into_owned(),
            "DM%20Images/diagram.png".into(),
        )
        .unwrap();
        assert_eq!(
            result,
            format!("data:image/png;base64,{}", STANDARD.encode(b"image bytes"))
        );
    }

    #[test]
    fn rejects_images_outside_document_folder() {
        let directory = tempfile::tempdir().unwrap();
        let notes = directory.path().join("notes");
        fs::create_dir(&notes).unwrap();
        fs::write(directory.path().join("private.png"), b"not an image").unwrap();
        let document = notes.join("note.md").to_string_lossy().into_owned();
        assert!(load_asset(document.clone(), "../private.png".into()).is_err());
        assert!(load_asset(
            document,
            directory
                .path()
                .join("private.png")
                .to_string_lossy()
                .into_owned()
        )
        .is_err());
    }

    #[test]
    fn keeps_window_drafts_isolated_and_names_safe() {
        assert_eq!(draft_filename("main").unwrap(), "untitled-draft.smd");
        assert_eq!(
            draft_filename("document-123").unwrap(),
            "untitled-draft-document-123.smd"
        );
        assert!(draft_filename("../outside").is_err());
    }
}
