//! Code extensions (`docs/extensions.md`): finding them, building their
//! `app.tsx` with Bun, and telling the frontend when one changed.
//!
//! Two scopes. A user extension is a folder in `$ROER_HOME/extensions/`. A
//! session one is a folder anywhere, named by a pointer file that `roer ext
//! dev` drops in `$ROER_HOME/extensions-dev/<id>.json`; it shadows a user
//! extension with the same id. Build output, status and log live in
//! `$ROER_HOME/extension-cache/<id>/`, outside both, so that nothing Roer
//! writes is ever seen as a change to the extension.
//!
//! The status file is how the `roer` CLI and its MCP tools learn how a build
//! went: they share no process with the app, only `$ROER_HOME`.

use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeSet, HashMap};
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};

use crate::events::Sink;

/// Emitted with the ids whose build changed, or that came or went.
pub const EXTENSIONS_EVENT: &str = "roer://extensions";

const BUILD_SCRIPT: &str = include_str!("extension_build.ts");

/// The log is cut back to its newer half once it passes this.
const LOG_LIMIT: u64 = 1024 * 1024;

/// How long the folders must stay quiet before a rebuild: an agent writing
/// several files is one build, not one per file.
const SETTLE: Duration = Duration::from_millis(300);

pub(crate) fn home() -> PathBuf {
    crate::history::roer_home()
}

fn user_dir() -> PathBuf {
    home().join("extensions")
}

fn dev_dir() -> PathBuf {
    home().join("extensions-dev")
}

/// The ids the person switched off, as a JSON array. Inside the watched
/// folder, so a switch reaches every window the way an edit does, and a dot
/// file, which no scan takes for an extension.
fn disabled_path() -> PathBuf {
    user_dir().join(".disabled.json")
}

/// The extensions switched off, bundled ones included.
pub(crate) fn disabled() -> BTreeSet<String> {
    read_disabled(&disabled_path())
}

fn read_disabled(path: &Path) -> BTreeSet<String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<String>>(&text).ok())
        .map(|ids| ids.into_iter().filter(|id| valid_id(id)).collect())
        .unwrap_or_default()
}

fn write_disabled(path: &Path, ids: &BTreeSet<String>) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let text = serde_json::to_string_pretty(&ids.iter().collect::<Vec<_>>()).map_err(|e| e.to_string())?;
    // Written aside and moved in, so a reader never sees half a list.
    let partial = path.with_extension("json.partial");
    std::fs::write(&partial, text).map_err(|e| format!("{}: {e}", partial.display()))?;
    std::fs::rename(&partial, path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Held from reading the switched-off list to writing it back, so two
/// switches at once (two windows, or two quick clicks) can't each write a
/// list missing the other's change.
static SWITCHING: Mutex<()> = Mutex::new(());

/// Switches `id` on or off in the list at `path`; whether that changed it.
fn switch(path: &Path, id: &str, enabled: bool) -> Result<bool, String> {
    let _switching = SWITCHING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut ids = read_disabled(path);
    let changed = if enabled { ids.remove(id) } else { ids.insert(id.to_string()) };
    if changed {
        write_disabled(path, &ids)?;
    }
    Ok(changed)
}

pub(crate) fn cache_dir(id: &str) -> PathBuf {
    home().join("extension-cache").join(id)
}

/// `extension.json`, as far as this module reads it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    api_version: u32,
    id: String,
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    app: Option<String>,
    #[serde(default)]
    server: Option<String>,
}

#[derive(Deserialize)]
struct DevPointer {
    dir: String,
}

/// One extension and how its last build went. Also its `status.json`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionInfo {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// `"user"` or `"session"`.
    pub scope: String,
    pub dir: String,
    /// Of the sources the build was made from; the frontend reloads on a new one.
    pub hash: String,
    /// Built, or nothing to build. False with `errors` when the build failed.
    pub ok: bool,
    /// Whether there is an `app.js` to load.
    pub has_app: bool,
    /// Whether the manifest names a `server.ts`, which runs on the first `rpc`.
    #[serde(default)]
    pub has_server: bool,
    #[serde(default)]
    pub errors: Vec<String>,
    /// Seconds since the epoch.
    pub built_at: u64,
    /// Switched off by the person: neither built nor loaded, and its server not started.
    #[serde(default)]
    pub disabled: bool,
}

/// What the frontend imports: the built module, and its stylesheet if any.
#[derive(Serialize)]
pub struct Bundle {
    pub js: String,
    pub css: Option<String>,
    pub hash: String,
}

/// An extension folder found on disk, before anything is built.
struct Found {
    scope: &'static str,
    dir: PathBuf,
    manifest: Result<Manifest, String>,
    /// The id it goes by: the manifest's, or the folder's when that is unreadable.
    id: String,
}

fn read_manifest(dir: &Path) -> Result<Manifest, String> {
    let path = dir.join("extension.json");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let manifest: Manifest = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    if manifest.api_version != 1 {
        return Err(format!("{}: apiVersion {} is not supported (1 is)", path.display(), manifest.api_version));
    }
    if !valid_id(&manifest.id) {
        return Err(format!("{}: id {:?} must be lowercase letters, digits and dashes", path.display(), manifest.id));
    }
    Ok(manifest)
}

pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Every extension on disk, one per id, a session one winning over a user one.
fn scan() -> Vec<Found> {
    let mut by_id: HashMap<String, Found> = HashMap::new();
    let mut found = |scope: &'static str, dir: PathBuf| {
        let manifest = read_manifest(&dir);
        let id = match &manifest {
            Ok(manifest) => manifest.id.clone(),
            Err(_) => dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        };
        if !valid_id(&id) {
            return;
        }
        if scope == "user" && by_id.contains_key(&id) {
            return;
        }
        by_id.insert(id.clone(), Found { scope, dir, manifest, id });
    };

    for (_, dir) in dev_pointers() {
        found("session", dir);
    }
    if let Ok(entries) = std::fs::read_dir(user_dir()) {
        // A dot-folder is `roer ext install` copying one in.
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
            .map(|e| e.path())
            .filter(|p| p.join("extension.json").is_file())
            .collect();
        dirs.sort();
        for dir in dirs {
            found("user", dir);
        }
    }

    let mut all: Vec<Found> = by_id.into_values().collect();
    all.sort_by(|a, b| a.id.cmp(&b.id));
    all
}

/// The session scope: `(id, folder)` for each pointer whose folder still exists.
fn dev_pointers() -> Vec<(String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(dev_dir()) else { return Vec::new() };
    let mut pointers: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let id = path.file_stem()?.to_string_lossy().into_owned();
            if path.extension()? != "json" {
                return None;
            }
            let pointer: DevPointer = serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
            let dir = PathBuf::from(pointer.dir);
            dir.is_dir().then_some((id, dir))
        })
        .collect();
    pointers.sort();
    pointers
}

/// Whether a path under an extension folder is one a build reads.
fn is_source(rel: &Path) -> bool {
    !rel.components().any(|part| {
        let name = part.as_os_str().to_string_lossy();
        name == "node_modules" || name.starts_with('.') || name == "comments.json"
    })
}

/// A hash of every source file's path, size and modification time, plus the
/// scope and folder: different whenever a rebuild could come out different.
fn fingerprint(found: &Found) -> String {
    let mut files = Vec::new();
    walk(&found.dir, &found.dir, &mut files);
    files.sort();
    let mut hasher = DefaultHasher::new();
    found.scope.hash(&mut hasher);
    found.dir.hash(&mut hasher);
    // A new Roer can build the same sources differently.
    env!("CARGO_PKG_VERSION").hash(&mut hasher);
    BUILD_SCRIPT.hash(&mut hasher);
    files.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, u64, u128)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(rel) = path.strip_prefix(root) else { continue };
        if !is_source(rel) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            walk(root, &path, out);
        } else {
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos());
            out.push((rel.to_string_lossy().into_owned(), meta.len(), modified));
        }
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// The Bun that builds extensions and runs their servers: `ROER_BUN`, then the
/// one beside the app, then the one Roer downloaded, then Bun's own install
/// location, then `PATH`. Never the shell's `PATH` alone, which an app started
/// from the Finder does not have. With none of them, Roer downloads its own,
/// once, saying so in the log of `id`, the extension waiting for it.
pub(crate) fn bun(id: &str) -> Result<PathBuf, String> {
    if let Some(explicit) = std::env::var_os("ROER_BUN").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(explicit));
    }
    let name = if cfg!(windows) { "bun.exe" } else { "bun" };
    let beside = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|dir| dir.join(name)));
    let installed = crate::roer::home().map(|home| home.join(".bun").join("bin").join(name));
    let on_path = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).map(|dir| dir.join(name)).collect::<Vec<_>>())
        .unwrap_or_default();
    let found = beside
        .into_iter()
        .chain([crate::bun_fetch::installed()])
        .chain(installed)
        .chain(on_path)
        .find(|path| path.is_file());
    if let Some(found) = found {
        return Ok(found);
    }
    crate::bun_fetch::fetch(|what| log(id, what)).map_err(|why| {
        format!("Extensions are built with Bun, and Roer could not download it: {why}. Install it from bun.sh, or set ROER_BUN.")
    })
}

/// Builds run one at a time: two at once would write the same cache.
static BUILDING: Mutex<()> = Mutex::new(());

fn status_path(id: &str) -> PathBuf {
    cache_dir(id).join("status.json")
}

fn read_status(id: &str) -> Option<ExtensionInfo> {
    serde_json::from_str(&std::fs::read_to_string(status_path(id)).ok()?).ok()
}

/// The extension as built from its sources now, building it if the last
/// build was of something else.
fn ensure(found: &Found) -> ExtensionInfo {
    let _guard = BUILDING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let hash = fingerprint(found);
    if let Some(status) = read_status(&found.id) {
        if status.hash == hash && status.dir == found.dir.to_string_lossy() {
            return status;
        }
    }
    let status = build(found, hash);
    let _ = std::fs::create_dir_all(cache_dir(&found.id));
    if let Ok(text) = serde_json::to_string_pretty(&status) {
        let _ = std::fs::write(status_path(&found.id), text);
    }
    status
}

fn build(found: &Found, hash: String) -> ExtensionInfo {
    let mut info = ExtensionInfo {
        id: found.id.clone(),
        name: found.id.clone(),
        description: None,
        scope: found.scope.to_string(),
        dir: found.dir.to_string_lossy().into_owned(),
        hash,
        ok: false,
        has_app: false,
        has_server: false,
        errors: Vec::new(),
        built_at: now(),
        disabled: false,
    };
    let manifest = match &found.manifest {
        Ok(manifest) => manifest,
        Err(error) => {
            info.errors.push(error.clone());
            log(&found.id, &format!("manifest: {error}"));
            return info;
        }
    };
    info.name = manifest.name.clone();
    info.description = manifest.description.clone();
    if let Some(server) = &manifest.server {
        info.has_server = true;
        if !found.dir.join(server).is_file() {
            let error = format!("{}: no such file (the manifest's \"server\")", found.dir.join(server).display());
            log(&found.id, &format!("manifest: {error}"));
            info.errors.push(error);
            return info;
        }
    }
    let Some(app) = &manifest.app else {
        info.ok = true;
        return info;
    };

    match run_build(&found.id, &found.dir.join(app)) {
        Ok(()) => {
            info.ok = true;
            info.has_app = true;
            log(&found.id, "built");
        }
        Err(errors) => {
            for error in &errors {
                log(&found.id, &format!("build: {error}"));
            }
            info.errors = errors;
        }
    }
    info
}

/// Runs the build script into a fresh folder, and swaps it in only when it
/// worked: a failed build leaves the last good `app.js` where it was.
fn run_build(id: &str, entry: &Path) -> Result<(), Vec<String>> {
    if !entry.is_file() {
        return Err(vec![format!("{}: no such file (the manifest's \"app\")", entry.display())]);
    }
    let bun = bun(id).map_err(|e| vec![e])?;
    let cache = cache_dir(id);
    let script = home().join("extension-cache").join("build.ts");
    let out = cache.join("out.partial");
    let _ = std::fs::remove_dir_all(&out);
    std::fs::create_dir_all(&cache).map_err(|e| vec![format!("{}: {e}", cache.display())])?;
    std::fs::write(&script, BUILD_SCRIPT).map_err(|e| vec![format!("{}: {e}", script.display())])?;

    let output = crate::process::command(&bun)
        .arg(&script)
        .arg(entry)
        .arg(&out)
        .current_dir(entry.parent().unwrap_or(Path::new(".")))
        // Production JSX, which is what the host's React runs.
        .env("NODE_ENV", "production")
        .output()
        .map_err(|e| vec![format!("could not run {}: {e}", bun.display())])?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let report = stdout.lines().rev().find_map(|line| serde_json::from_str::<serde_json::Value>(line).ok());
    let Some(report) = report else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(vec![if stderr.is_empty() { "the build printed nothing".into() } else { stderr }]);
    };
    let logs: Vec<String> = report["logs"]
        .as_array()
        .map(|logs| logs.iter().filter_map(|l| l.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    if report["ok"] != serde_json::Value::Bool(true) {
        return Err(if logs.is_empty() { vec!["the build failed".into()] } else { logs });
    }

    for name in ["app.js", "app.css"] {
        let _ = std::fs::remove_file(cache.join(name));
        if out.join(name).is_file() {
            std::fs::rename(out.join(name), cache.join(name)).map_err(|e| vec![format!("{name}: {e}")])?;
        }
    }
    let _ = std::fs::remove_dir_all(&out);
    Ok(())
}

/// Appends a line to an extension's log, which `roer ext logs` prints.
pub(crate) fn log(id: &str, message: &str) {
    if !valid_id(id) {
        return;
    }
    let dir = cache_dir(id);
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("log");
    if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > LOG_LIMIT) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            let _ = std::fs::write(&path, newer_half(&text));
        }
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        for line in message.lines() {
            let _ = writeln!(file, "{} {line}", now());
        }
    }
}

/// The newer half of a log, from the first line that starts past its middle.
/// The middle is a byte offset, which can fall inside a character; a newline
/// never does, and without one the cut moves on to the next character.
fn newer_half(text: &str) -> &str {
    let half = text.len() / 2;
    let cut = match text.as_bytes()[half..].iter().position(|&b| b == b'\n') {
        Some(at) => half + at + 1,
        None => (half..=text.len()).find(|&at| text.is_char_boundary(at)).unwrap_or(text.len()),
    };
    &text[cut..]
}

/// The `server.ts` an extension runs, and the hash of the sources it is
/// part of: a server started from another hash is out of date.
pub(crate) fn server_entry(id: &str) -> Result<(PathBuf, String), String> {
    if disabled().contains(id) {
        return Err(format!("{id} is switched off"));
    }
    let found = scan().into_iter().find(|found| found.id == id).ok_or_else(|| format!("no such extension: {id}"))?;
    let manifest = found.manifest.as_ref().map_err(Clone::clone)?;
    let server = manifest.server.as_ref().ok_or_else(|| format!("{id} has no server: its manifest names no \"server\""))?;
    let entry = found.dir.join(server);
    if !entry.is_file() {
        return Err(format!("{}: no such file (the manifest's \"server\")", entry.display()));
    }
    Ok((entry, fingerprint(&found)))
}

#[tauri::command(async)]
pub fn extensions_list() -> Vec<ExtensionInfo> {
    let off = disabled();
    scan().iter().map(|found| if off.contains(&found.id) { described(found) } else { ensure(found) }).collect()
}

/// A switched-off extension as it was last built, or as its manifest names
/// it: nothing is built for one that will not run.
fn described(found: &Found) -> ExtensionInfo {
    let mut info = read_status(&found.id)
        .filter(|status| status.dir == found.dir.to_string_lossy())
        .unwrap_or_else(|| ExtensionInfo {
            id: found.id.clone(),
            name: found.manifest.as_ref().map_or_else(|_| found.id.clone(), |m| m.name.clone()),
            description: found.manifest.as_ref().ok().and_then(|m| m.description.clone()),
            scope: found.scope.to_string(),
            dir: found.dir.to_string_lossy().into_owned(),
            hash: String::new(),
            ok: true,
            has_app: false,
            has_server: false,
            errors: Vec::new(),
            built_at: 0,
            disabled: false,
        });
    info.scope = found.scope.to_string();
    info.disabled = true;
    info
}

/// The ids switched off, for the extensions that ship inside the app, which
/// no scan finds.
#[tauri::command(async)]
pub fn extensions_disabled() -> Vec<String> {
    disabled().into_iter().collect()
}

/// Switches an extension on or off. The watcher sees the list change and
/// tells every window, which loads or unloads it.
#[tauri::command(async)]
pub fn extension_set_enabled(id: String, enabled: bool) -> Result<(), String> {
    if !valid_id(&id) {
        return Err(format!("no such extension: {id}"));
    }
    if switch(&disabled_path(), &id, enabled)? {
        log(&id, if enabled { "switched on" } else { "switched off" });
    }
    Ok(())
}

#[tauri::command(async)]
pub fn extension_bundle(id: String) -> Result<Bundle, String> {
    if !valid_id(&id) {
        return Err(format!("no such extension: {id}"));
    }
    let status = read_status(&id).ok_or_else(|| format!("{id} has not been built"))?;
    let dir = cache_dir(&id);
    let js = std::fs::read_to_string(dir.join("app.js")).map_err(|e| format!("{id}: {e}"))?;
    let css = std::fs::read_to_string(dir.join("app.css")).ok();
    Ok(Bundle { js, css, hash: status.hash })
}

/// What the frontend saw go wrong while running one: an activation that
/// threw, a contribution that failed to render.
#[tauri::command]
pub fn extension_log(id: String, message: String) {
    log(&id, &message);
}

/// What a window is told about: an extension's sources, a fresh build of the
/// same ones (`roer ext dev` asks for one, and waits to hear it was loaded),
/// and whether it is switched on. A bundled one, which no scan finds, is here
/// only while it is off.
fn states() -> HashMap<String, (String, u64, bool)> {
    let mut states: HashMap<String, (String, u64, bool)> = extensions_list()
        .into_iter()
        .map(|info| (info.id, (info.hash, info.built_at, info.disabled)))
        .collect();
    for id in disabled() {
        states.entry(id).or_insert((String::new(), 0, true));
    }
    states
}

/// Rebuilds whatever changed whenever the extension folders do, and emits
/// [`EXTENSIONS_EVENT`] with the ids whose build is new, or that went away.
pub fn watch<S: Sink>(sink: S) -> notify::Result<()> {
    for dir in [user_dir(), dev_dir()] {
        if let Err(e) = std::fs::create_dir_all(&dir) {
            eprintln!("roer: cannot create {}: {e}", dir.display());
        }
    }
    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = match notify::recommended_watcher(tx) {
            Ok(watcher) => watcher,
            Err(e) => {
                eprintln!("roer: could not start the extensions watcher: {e}");
                return;
            }
        };
        let _ = watcher.watch(&user_dir(), RecursiveMode::Recursive);
        let _ = watcher.watch(&dev_dir(), RecursiveMode::NonRecursive);
        let mut watched: Vec<PathBuf> = Vec::new();
        let mut known = states();

        loop {
            // Session folders come and go with their pointers.
            let dirs: Vec<PathBuf> = dev_pointers().into_iter().map(|(_, dir)| dir).collect();
            for gone in watched.iter().filter(|dir| !dirs.contains(dir)) {
                let _ = watcher.unwatch(gone);
            }
            for new in dirs.iter().filter(|dir| !watched.contains(dir)) {
                let _ = watcher.watch(new, RecursiveMode::Recursive);
            }
            watched = dirs;

            // Wait for a change, then for the folders to go quiet.
            if rx.recv().is_err() {
                return;
            }
            while rx.recv_timeout(SETTLE).is_ok() {}

            let now = states();
            let mut changed: Vec<String> = now
                .iter()
                .filter(|(id, hash)| known.get(*id) != Some(hash))
                .map(|(id, _)| id.clone())
                .chain(known.keys().filter(|id| !now.contains_key(*id)).cloned())
                .collect();
            changed.sort();
            // A changed server.ts, or one whose extension went away, stops;
            // the next rpc starts it from the new sources.
            for id in &changed {
                crate::extension_servers::stop(id);
            }
            known = now;
            if !changed.is_empty() {
                sink.emit(EXTENSIONS_EVENT, &serde_json::json!({ "changed": changed }));
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_newer_half_of_a_log_whatever_characters_its_middle_falls_in() {
        // Every byte offset of this one is tried as the middle, accents and emoji included.
        let text = "1 première ligne\n2 zweite Zeile ü\n3 третья 🚀\n4 last\n";
        for pad in 0..12 {
            let padded = format!("{}{text}", "é".repeat(pad));
            let kept = newer_half(&padded);
            assert!(padded.ends_with(kept));
            assert!(kept.is_empty() || kept.starts_with(|c: char| c.is_ascii_digit()), "{kept:?}");
        }
        let one_line = "ééééééééé";
        assert!(one_line.ends_with(newer_half(one_line)));
    }

    #[test]
    fn switches_at_once_each_keep_the_others_change() {
        let dir = std::env::temp_dir().join(format!("roer-switches-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join(".disabled.json");
        let ids: Vec<String> = (0..24).map(|n| format!("ext-{n}")).collect();
        std::thread::scope(|scope| {
            for id in &ids {
                let path = &path;
                scope.spawn(move || switch(path, id, false).unwrap());
            }
        });
        assert_eq!(read_disabled(&path), ids.iter().cloned().collect());
        // Switching one back on leaves the rest off, and switching it on again changes nothing.
        assert!(switch(&path, "ext-3", true).unwrap());
        assert!(!switch(&path, "ext-3", true).unwrap());
        assert_eq!(read_disabled(&path).len(), 23);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ids_are_lowercase_words_joined_by_dashes() {
        assert!(valid_id("todos"));
        assert!(valid_id("changes-by-folder"));
        assert!(!valid_id(""));
        assert!(!valid_id("Todos"));
        assert!(!valid_id("../escape"));
        assert!(!valid_id("a/b"));
    }

    #[test]
    fn a_build_reads_neither_dependencies_nor_hidden_files_nor_comments() {
        assert!(is_source(Path::new("app.tsx")));
        assert!(is_source(Path::new("src/view.tsx")));
        assert!(!is_source(Path::new("node_modules/react/index.js")));
        assert!(!is_source(Path::new(".git/HEAD")));
        assert!(!is_source(Path::new("comments.json")));
    }
}
