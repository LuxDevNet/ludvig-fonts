#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

const PAGE: &str = include_str!("../web/index.html");
const CSS: &str = include_str!("../meadow.css");
const JS: &str = include_str!("../web/app.js");

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Root {
    id: String,
    path: String,
    label: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Face {
    id: String,
    root_id: String,
    pack: String,
    name: String,
    ext: String,
    bytes: u64,
    rel: String,
}

#[derive(Clone)]
struct Meta {
    missing: bool,
    error: Option<String>,
}

struct App {
    roots: Vec<Root>,
    faces: Vec<Face>,
    files: HashMap<String, PathBuf>,
    meta: HashMap<String, Meta>,
    revision: u64,
    ready: bool,
    library: String,
    fingerprint: u64,
}

fn main() {
    let open = !std::env::args().any(|arg| arg == "--no-open");
    if let Some(url) = probe_existing() {
        if open {
            open_browser(&url);
        }
        return;
    }

    let mut app = App {
        roots: Vec::new(),
        faces: Vec::new(),
        files: HashMap::new(),
        meta: HashMap::new(),
        revision: 0,
        ready: false,
        library: find_library().unwrap_or_default(),
        fingerprint: 0,
    };
    load_roots(&mut app);
    let state = Arc::new(Mutex::new(app));
    let scanner = Arc::clone(&state);
    thread::spawn(move || loop {
        scan(&scanner);
        thread::sleep(Duration::from_secs(4));
    });

    let (server, port) = match bind() {
        Some(bound) => bound,
        None => {
            complain("Nightgrass could not open a local port.");
            return;
        }
    };
    let url = format!("http://127.0.0.1:{port}");
    log_line(&format!("Nightgrass is at {url}"));
    if open {
        open_browser(&url);
    }

    for request in server.incoming_requests() {
        let state = Arc::clone(&state);
        thread::spawn(move || {
            let _ = handle(request, &state);
        });
    }
}

fn bind() -> Option<(Server, u16)> {
    for port in 4317..4337 {
        if let Ok(server) = Server::http(format!("127.0.0.1:{port}")) {
            return Some((server, port));
        }
    }
    None
}

fn probe_existing() -> Option<String> {
    for port in 4317..4337 {
        let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
        let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(200)) else {
            continue;
        };
        stream.set_read_timeout(Some(Duration::from_millis(500))).ok();
        stream.set_write_timeout(Some(Duration::from_millis(500))).ok();
        if stream
            .write_all(b"GET /api/revision HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
            .is_err()
        {
            continue;
        }
        let mut buf = [0u8; 512];
        let n = stream.read(&mut buf).unwrap_or(0);
        let text = String::from_utf8_lossy(&buf[..n]);
        if text.contains("200") && text.contains("revision") {
            return Some(format!("http://127.0.0.1:{port}"));
        }
    }
    None
}

fn handle(mut request: Request, state: &Mutex<App>) -> std::io::Result<()> {
    let method = request.method().clone();
    let url = request.url().split('?').next().unwrap_or("/").to_string();
    let range = request
        .headers()
        .iter()
        .find(|item| item.field.equiv("Range"))
        .map(|item| item.value.as_str().to_string());
    if method == Method::Post {
        let mut body = String::new();
        let _ = request.as_reader().take(1_000_000).read_to_string(&mut body);
        let response = post_roots(state, &body);
        return request.respond(response);
    }
    let response = match (method, url.as_str()) {
        (Method::Get | Method::Head, "/") => html(PAGE, "text/html; charset=utf-8"),
        (Method::Get | Method::Head, "/meadow.css") => html(CSS, "text/css; charset=utf-8"),
        (Method::Get | Method::Head, "/app.js") => html(JS, "text/javascript; charset=utf-8"),
        (Method::Get | Method::Head, "/api/catalog") => json_body(200, &catalog_json(state)),
        (Method::Get | Method::Head, "/api/revision") => json_body(200, &revision_json(state)),
        (Method::Get | Method::Head, path) if path.starts_with("/api/font/") => {
            let id = &path["/api/font/".len()..];
            font_response(state, id, range.as_deref())
        }
        (Method::Delete, path) if path.starts_with("/api/roots/") => {
            let id = &path["/api/roots/".len()..];
            delete_root(state, id)
        }
        _ => json_body(404, r#"{"error":"Not found"}"#),
    };
    request.respond(response)
}

fn html(body: &str, kind: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_data(body.as_bytes())
        .with_status_code(StatusCode(200))
        .with_header(header("Content-Type", kind))
        .with_header(header("Cache-Control", "no-cache"))
}

fn json_body(status: u16, body: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_data(body.as_bytes())
        .with_status_code(StatusCode(status))
        .with_header(header("Content-Type", "application/json"))
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("header")
}

fn catalog_json(state: &Mutex<App>) -> String {
    let app = state.lock().expect("state");
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for face in &app.faces {
        *counts.entry(face.root_id.as_str()).or_default() += 1;
    }
    let library_key = app.library.to_lowercase();
    let library_mounted = !library_key.is_empty()
        && app.roots.iter().any(|root| root.path.to_lowercase() == library_key);
    let roots: Vec<_> = app
        .roots
        .iter()
        .map(|root| {
            let meta = app.meta.get(&root.id);
            json!({
                "id": root.id,
                "path": root.path,
                "label": root.label,
                "missing": meta.map(|item| item.missing).unwrap_or(false),
                "error": meta.and_then(|item| item.error.clone()),
                "faceCount": counts.get(root.id.as_str()).copied().unwrap_or(0),
            })
        })
        .collect();
    json!({
        "ready": app.ready,
        "revision": app.revision,
        "libraryPath": app.library,
        "libraryMounted": library_mounted,
        "roots": roots,
        "faces": app.faces,
    })
    .to_string()
}

fn revision_json(state: &Mutex<App>) -> String {
    let app = state.lock().expect("state");
    json!({ "revision": app.revision, "ready": app.ready }).to_string()
}

fn post_roots(state: &Mutex<App>, body: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let parsed: serde_json::Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(_) => return json_body(400, r#"{"error":"Send a folder path."}"#),
    };
    let mut folder = parsed.get("path").and_then(|value| value.as_str()).map(str::to_string);
    if parsed.get("pick").and_then(|value| value.as_bool()).unwrap_or(false) {
        match pick_folder() {
            Pick::Cancelled => {
                let mut payload: serde_json::Value = serde_json::from_str(&catalog_json(state)).unwrap_or(json!({}));
                payload["cancelled"] = json!(true);
                return json_body(200, &payload.to_string());
            }
            Pick::Error(error) => return json_body(400, &json!({ "error": error }).to_string()),
            Pick::Path(path) => folder = Some(path),
        }
    } else if parsed.get("useLibrary").and_then(|value| value.as_bool()).unwrap_or(false) {
        let library = state.lock().expect("state").library.clone();
        if library.is_empty() {
            return json_body(400, r#"{"error":"Nightgrass could not find the unzipped-fonts folder."}"#);
        }
        folder = Some(library);
    }
    let Some(folder) = folder else {
        return json_body(400, r#"{"error":"Send a folder path."}"#);
    };
    if let Err(error) = add_root(state, &folder) {
        let mut payload: serde_json::Value = serde_json::from_str(&catalog_json(state)).unwrap_or(json!({}));
        payload["error"] = json!(error);
        return json_body(400, &payload.to_string());
    }
    scan(state);
    json_body(200, &catalog_json(state))
}

fn delete_root(state: &Mutex<App>, id: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let removed = {
        let mut app = state.lock().expect("state");
        let before = app.roots.len();
        app.roots.retain(|root| root.id != id);
        before != app.roots.len()
    };
    if !removed {
        return json_body(404, r#"{"error":"That folder is not open."}"#);
    }
    save_roots(state);
    scan(state);
    json_body(200, &catalog_json(state))
}

fn add_root(state: &Mutex<App>, folder: &str) -> Result<(), String> {
    let path = PathBuf::from(folder);
    if !path.is_dir() {
        return Err("Nightgrass cannot read that folder.".into());
    }
    let resolved = plain(&fs::canonicalize(&path).map_err(|_| "Nightgrass cannot read that folder.".to_string())?);
    let text = resolved.to_string_lossy().to_string();
    let key = text.to_lowercase();
    let mut app = state.lock().expect("state");
    if app.roots.iter().any(|root| root.path.to_lowercase() == key) {
        return Err("That folder is already open.".into());
    }
    if app.roots.len() >= 24 {
        return Err("Nightgrass is already watching 24 folders.".into());
    }
    let label = resolved.file_name().and_then(|name| name.to_str()).unwrap_or("folder");
    let label = if label.eq_ignore_ascii_case("unzipped-fonts") {
        "Ludvig library"
    } else {
        label
    };
    app.roots.push(Root {
        id: hash_id(&key),
        path: text,
        label: label.to_string(),
    });
    drop(app);
    save_roots(state);
    Ok(())
}

enum Pick {
    Path(String),
    Cancelled,
    Error(String),
}

fn pick_folder() -> Pick {
    let script = r#"
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose a folder of fonts'
$dialog.ShowNewFolderButton = $false
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
}
"#;
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-STA", "-Command", script])
        .output();
    match output {
        Ok(output) if output.status.success() => {
            let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if selected.is_empty() {
                Pick::Cancelled
            } else {
                Pick::Path(selected)
            }
        }
        Ok(output) => Pick::Error(
            String::from_utf8_lossy(&output.stderr)
                .trim()
                .to_string()
                .if_empty("The folder window did not open."),
        ),
        Err(_) => Pick::Error("The folder window did not open.".into()),
    }
}

trait IfEmpty {
    fn if_empty(self, fallback: &str) -> String;
}

impl IfEmpty for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() { fallback.to_string() } else { self }
    }
}

fn font_response(state: &Mutex<App>, id: &str, range: Option<&str>) -> Response<std::io::Cursor<Vec<u8>>> {
    let path = {
        let app = state.lock().expect("state");
        app.files.get(id).cloned()
    };
    let Some(path) = path else {
        return json_body(404, r#"{"error":"That face is not in an open folder."}"#);
    };
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => return json_body(404, r#"{"error":"Nightgrass could not read that font file."}"#),
    };
    let ext = ext_of(&path);
    let mime = match ext.as_str() {
        "otf" => "font/otf",
        "ttf" => "font/ttf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "otc" | "ttc" => "font/collection",
        _ => "application/octet-stream",
    };
    let total = bytes.len();
    let Some(spec) = range else {
        return Response::from_data(bytes)
            .with_status_code(StatusCode(200))
            .with_header(header("Content-Type", mime))
            .with_header(header("Accept-Ranges", "bytes"))
            .with_header(header("Cache-Control", "private, max-age=3600"));
    };
    match parse_range(spec, total) {
        Some((start, end)) => {
            let slice = bytes[start..=end].to_vec();
            Response::from_data(slice)
                .with_status_code(StatusCode(206))
                .with_header(header("Content-Type", mime))
                .with_header(header("Accept-Ranges", "bytes"))
                .with_header(header("Content-Range", &format!("bytes {start}-{end}/{total}")))
                .with_header(header("Cache-Control", "private, max-age=3600"))
        }
        None => Response::from_data(Vec::new())
            .with_status_code(StatusCode(416))
            .with_header(header("Content-Range", &format!("bytes */{total}"))),
    }
}

fn parse_range(spec: &str, total: usize) -> Option<(usize, usize)> {
    if total == 0 {
        return None;
    }
    let spec = spec.trim().strip_prefix("bytes=")?;
    let (start_text, end_text) = spec.split_once('-')?;
    if start_text.is_empty() && end_text.is_empty() {
        return None;
    }
    let (start, end) = if start_text.is_empty() {
        let suffix: usize = end_text.parse().ok()?;
        (total.saturating_sub(suffix), total - 1)
    } else {
        let start = start_text.parse().ok()?;
        let end = if end_text.is_empty() { total - 1 } else { end_text.parse().ok()? };
        (start, end.min(total - 1))
    };
    if start >= total || start > end {
        None
    } else {
        Some((start, end))
    }
}

fn scan(state: &Mutex<App>) {
    let (roots, library) = {
        let app = state.lock().expect("state");
        (app.roots.clone(), app.library.clone())
    };
    let mut faces = Vec::new();
    let mut files = HashMap::new();
    let mut meta = HashMap::new();
    for root in &roots {
        match scan_root(root) {
            Ok((batch, paths)) => {
                faces.extend(batch);
                files.extend(paths);
                meta.insert(root.id.clone(), Meta { missing: false, error: None });
            }
            Err(error) => {
                meta.insert(
                    root.id.clone(),
                    Meta {
                        missing: true,
                        error: Some(error),
                    },
                );
            }
        }
    }
    faces.sort_by(|a, b| {
        a.pack
            .to_lowercase()
            .cmp(&b.pack.to_lowercase())
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    let fingerprint = fingerprint(&faces, &meta);
    let mut app = state.lock().expect("state");
    if app.roots != roots || app.library != library {
        return;
    }
    if app.ready && app.fingerprint == fingerprint {
        return;
    }
    let count = faces.len();
    app.faces = faces;
    app.files = files;
    app.meta = meta;
    app.fingerprint = fingerprint;
    app.ready = true;
    app.revision += 1;
    log_line(&format!("Nightgrass indexed {count} faces from {} folder{}.", roots.len(), if roots.len() == 1 { "" } else { "s" }));
}

fn fingerprint(faces: &[Face], meta: &HashMap<String, Meta>) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for face in faces {
        hash = fnv(face.id.as_bytes(), hash);
        hash = fnv(&face.bytes.to_le_bytes(), hash);
    }
    let mut keys: Vec<_> = meta.keys().cloned().collect();
    keys.sort();
    for key in keys {
        hash = fnv(key.as_bytes(), hash);
        if let Some(item) = meta.get(&key) {
            hash = fnv(&[u8::from(item.missing)], hash);
            hash = fnv(item.error.as_deref().unwrap_or("").as_bytes(), hash);
        }
    }
    hash
}

fn scan_root(root: &Root) -> Result<(Vec<Face>, HashMap<String, PathBuf>), String> {
    let base = PathBuf::from(&root.path);
    if !base.is_dir() {
        return Err("That path is not a folder.".into());
    }
    let mut found: HashMap<String, (Face, PathBuf, u8)> = HashMap::new();
    let mut pending = vec![(base.clone(), String::new())];
    while let Some((dir, rel)) = pending.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') || name == "node_modules" || name == "__MACOSX" || name.starts_with("._") {
                continue;
            }
            let path = entry.path();
            let child_rel = if rel.is_empty() {
                name.to_string()
            } else {
                format!("{rel}/{name}")
            };
            if path.is_dir() {
                pending.push((path, child_rel));
                continue;
            }
            let ext = ext_of(&path);
            let rank = match ext.as_str() {
                "woff2" => 5,
                "woff" => 4,
                "otf" => 3,
                "ttf" => 2,
                "otc" | "ttc" => 1,
                _ => 0,
            };
            if rank == 0 {
                continue;
            }
            let bytes = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            if bytes == 0 {
                continue;
            }
            let parts: Vec<&str> = child_rel.split('/').collect();
            let filename = *parts.last().unwrap_or(&"");
            let stem = filename.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(filename);
            let parent = if parts.len() >= 2 { parts[parts.len() - 2] } else { root.label.as_str() };
            let key = format!("{}/{}", norm(parent), norm(stem));
            if found.get(&key).map(|(_, _, current)| *current >= rank).unwrap_or(false) {
                continue;
            }
            let pack = if parts.len() > 2 {
                format!("{} / {parent}", parts[0])
            } else if parts.len() == 2 {
                parts[0].to_string()
            } else {
                root.label.clone()
            };
            let face = Face {
                id: hash_id(&path.to_string_lossy().to_lowercase()),
                root_id: root.id.clone(),
                pack,
                name: pretty_stem(stem),
                ext,
                bytes,
                rel: child_rel,
            };
            found.insert(key, (face, path, rank));
        }
    }
    let mut faces = Vec::new();
    let mut files = HashMap::new();
    for (_, (face, path, _)) in found {
        files.insert(face.id.clone(), path);
        faces.push(face);
    }
    Ok((faces, files))
}

fn pretty_stem(stem: &str) -> String {
    let mut out = String::new();
    let mut space = false;
    for ch in stem.chars() {
        if ch == '_' || ch == '-' || ch.is_whitespace() {
            space = !out.is_empty();
            continue;
        }
        if space {
            out.push(' ');
            space = false;
        }
        out.push(ch);
    }
    if out.is_empty() { stem.to_string() } else { out }
}

fn norm(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

fn ext_of(path: &Path) -> String {
    path.extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn hash_id(value: &str) -> String {
    format!("{:016x}", fnv(value.as_bytes(), 0xcbf29ce484222325))
}

fn fnv(bytes: &[u8], mut hash: u64) -> u64 {
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn load_roots(app: &mut App) {
    if let Ok(text) = fs::read_to_string(roots_file()) {
        if let Ok(roots) = serde_json::from_str::<Vec<Root>>(&text) {
            app.roots = roots;
        }
    }
    if app.roots.is_empty() && !app.library.is_empty() {
        app.roots.push(Root {
            id: hash_id(&app.library.to_lowercase()),
            path: app.library.clone(),
            label: "Ludvig library".into(),
        });
        let roots = app.roots.clone();
        let _ = fs::create_dir_all(data_dir());
        let _ = fs::write(roots_file(), serde_json::to_string_pretty(&roots).unwrap_or_else(|_| "[]".into()));
    }
}

fn save_roots(state: &Mutex<App>) {
    let roots = state.lock().expect("state").roots.clone();
    let _ = fs::create_dir_all(data_dir());
    let _ = fs::write(roots_file(), serde_json::to_string_pretty(&roots).unwrap_or_else(|_| "[]".into()));
}

fn data_dir() -> PathBuf {
    if let Ok(base) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(base).join("Nightgrass");
    }
    PathBuf::from(".").join("Nightgrass")
}

fn roots_file() -> PathBuf {
    data_dir().join("roots.json")
}

fn log_line(line: &str) {
    let _ = fs::create_dir_all(data_dir());
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(data_dir().join("nightgrass.log")) {
        let _ = writeln!(file, "{line}");
    }
}

fn find_library() -> Option<String> {
    let mut starts = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        starts.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            starts.push(parent.to_path_buf());
        }
    }
    for start in starts {
        let mut current = Some(start.as_path());
        for _ in 0..8 {
            let Some(dir) = current else { break };
            let candidate = dir.join("unzipped-fonts");
            if candidate.is_dir() {
                let resolved = fs::canonicalize(&candidate).unwrap_or(candidate);
                return Some(plain(&resolved).to_string_lossy().to_string());
            }
            current = dir.parent();
        }
    }
    None
}

fn plain(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    let text = text.strip_prefix(r"\\?\").unwrap_or(&text);
    PathBuf::from(text)
}

fn open_browser(url: &str) {
    let _ = Command::new("cmd").args(["/C", "start", "", url]).spawn();
}

fn complain(message: &str) {
    log_line(message);
    let _ = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-Command",
            &format!("Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('{message}')"),
        ])
        .spawn();
}
