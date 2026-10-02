//! `roer ext`: making, loading and installing extensions (`docs/extensions.md`).
//!
//! The CLI shares no process with the app, only `$ROER_HOME`: it drops a
//! session extension's pointer in `extensions-dev/`, or copies a folder into
//! `extensions/`, and the app's watcher builds and loads it. How that went
//! comes back through the app's `extension-cache/<id>/status.json` and
//! `log`, which this waits on, so an agent learns about a build error from the
//! command that caused it.
//!
//! The same functions back the `extension_*` tools of `roer mcp`.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::records::home;
use crate::Fail;

pub const USAGE: &str = "\
usage:
  roer ext new <id> [dir]     write a new extension's folder, <dir>/<id> (default: here)
  roer ext dev <dir>          load the folder as a session extension: built, loaded and
                              rebuilt on every save until Roer restarts; reports the
                              build's errors
  roer ext install <dir>      copy the folder into ~/.roer/extensions, to keep
  roer ext list               id<TAB>scope<TAB>ok|failed<TAB>folder, one per line
  roer ext logs <id> [lines]  the extension's log: builds, activations, render errors
  roer ext remove <id>        take the extension away, from either scope
  roer ext guide              how to write one, and the API's types
";

/// How to write one: the guide and the API's types, which `roer ext guide`
/// and the `roer:extensions/1` resource hand an agent.
pub const GUIDE: &str = include_str!("ext/guide.md");
pub const TYPES: &str = include_str!("ext/roer.d.ts");

pub fn guide() -> String {
    format!("{GUIDE}\n## The API\n\n```ts\n{TYPES}```\n")
}

/// How long the app gets to build an extension after the CLI hands it over.
const BUILD_WAIT: Duration = Duration::from_secs(30);
/// And to load it into its window after that.
const LOAD_WAIT: Duration = Duration::from_secs(10);

pub fn run(cwd: &str, args: &[&str]) -> Result<(), Fail> {
    let out = match args {
        ["new", id] => new(id, Path::new(cwd))?,
        ["new", id, dir] => new(id, &absolute(cwd, dir))?,
        ["dev", dir] => dev(&absolute(cwd, dir))?,
        ["install", dir] => install(&absolute(cwd, dir))?,
        ["list" | "ls"] => list(),
        ["logs", id] => logs(id, 100)?,
        ["logs", id, lines] => logs(id, lines.parse().map_err(|_| Fail::new(64, "lines must be a number"))?)?,
        ["remove" | "rm", id] => remove(id)?,
        ["guide"] => guide(),
        ["help" | "--help" | "-h"] | [] => USAGE.to_string(),
        _ => return Err(Fail::new(64, format!("unknown: roer ext {}\n{USAGE}", args.join(" ")))),
    };
    print!("{out}");
    if !out.ends_with('\n') {
        println!();
    }
    Ok(())
}

pub fn absolute(cwd: &str, dir: &str) -> PathBuf {
    let path = Path::new(dir);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        Path::new(cwd).join(path)
    }
}

fn user_dir() -> PathBuf {
    home().join("extensions")
}

fn dev_dir() -> PathBuf {
    home().join("extensions-dev")
}

fn cache_dir(id: &str) -> PathBuf {
    home().join("extension-cache").join(id)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn checked(id: &str) -> Result<&str, Fail> {
    if valid_id(id) {
        Ok(id)
    } else {
        Err(Fail::new(2, format!("{id:?} is not an extension id: lowercase letters, digits and dashes")))
    }
}

/// The folder's `extension.json`, and the id it gives.
fn manifest(dir: &Path) -> Result<(Value, String), Fail> {
    let path = dir.join("extension.json");
    let text = std::fs::read_to_string(&path).map_err(|e| Fail::new(2, format!("{}: {e}", path.display())))?;
    let manifest: Value = serde_json::from_str(&text).map_err(|e| Fail::new(2, format!("{}: {e}", path.display())))?;
    let id = manifest["id"].as_str().unwrap_or_default().to_string();
    checked(&id)?;
    if manifest["apiVersion"] != json!(1) {
        return Err(Fail::new(2, format!("{}: \"apiVersion\" must be 1", path.display())));
    }
    if manifest["name"].as_str().is_none_or(str::is_empty) {
        return Err(Fail::new(2, format!("{}: \"name\" is required", path.display())));
    }
    Ok((manifest, id))
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn write_atomic(path: &Path, text: &str) -> Result<(), Fail> {
    let partial = path.with_extension("partial");
    std::fs::write(&partial, text)
        .and_then(|()| std::fs::rename(&partial, path))
        .map_err(|e| Fail::new(1, format!("{}: {e}", path.display())))
}

/// `dev` or `install`, for `roer mcp`.
pub fn act(verb: &str, dir: &Path) -> Result<String, Fail> {
    if verb == "dev" {
        dev(dir)
    } else {
        install(dir)
    }
}

fn new(id: &str, parent: &Path) -> Result<String, Fail> {
    let id = checked(id)?;
    let dir = parent.join(id);
    if dir.exists() && std::fs::read_dir(&dir).map(|mut d| d.next().is_some()).unwrap_or(true) {
        return Err(Fail::new(2, format!("{} already exists and is not empty", dir.display())));
    }
    std::fs::create_dir_all(&dir).map_err(|e| Fail::new(1, format!("{}: {e}", dir.display())))?;
    let name: String = id
        .split('-')
        .map(|word| {
            let mut chars = word.chars();
            chars.next().map(|c| c.to_uppercase().chain(chars).collect::<String>()).unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ");
    let manifest = json!({ "apiVersion": 1, "id": id, "name": name, "roer": ">=0.8", "app": "app.tsx" });
    let app = format!(
        r#"import {{ defineExtension, useSession }} from "roer";

function Main() {{
  const session = useSession();
  if (!session?.root) return <div className="empty"><p className="muted">Not in a git repository.</p></div>;
  return (
    <div className="empty">
      <p>{{session.root}}</p>
      <p className="muted">{{session.branch}}</p>
    </div>
  );
}}

export default defineExtension((roer) => {{
  roer.stage.registerTab({{ id: "main", title: {title}, component: Main }});
}});
"#,
        title = serde_json::to_string(&name).unwrap_or_default(),
    );
    let tsconfig = json!({
        "compilerOptions": {
            "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
            "jsx": "react-jsx", "strict": true, "noEmit": true, "skipLibCheck": true,
        },
        "include": ["*.ts", "*.tsx", "**/*.ts", "**/*.tsx"],
    });
    for (file, text) in [
        ("extension.json", format!("{:#}\n", manifest)),
        ("app.tsx", app),
        ("roer.d.ts", TYPES.to_string()),
        ("tsconfig.json", format!("{:#}\n", tsconfig)),
    ] {
        let path = dir.join(file);
        std::fs::write(&path, text).map_err(|e| Fail::new(1, format!("{}: {e}", path.display())))?;
    }
    Ok(format!("Wrote {}. Load it with `roer ext dev {}`.", dir.display(), dir.display()))
}

fn dev(dir: &Path) -> Result<String, Fail> {
    let dir = dunce(dir)?;
    let (_, id) = manifest(&dir)?;
    std::fs::create_dir_all(dev_dir()).map_err(|e| Fail::new(1, format!("{}: {e}", dev_dir().display())))?;
    let started = now();
    // A status of the same sources would be taken as this build's.
    let _ = std::fs::remove_file(cache_dir(&id).join("status.json"));
    write_atomic(&dev_dir().join(format!("{id}.json")), &json!({ "dir": dir }).to_string())?;
    report(&id, &dir, started, "session")
}

fn install(dir: &Path) -> Result<String, Fail> {
    let dir = dunce(dir)?;
    let (_, id) = manifest(&dir)?;
    let target = user_dir().join(&id);
    if dir == target {
        return Err(Fail::new(2, format!("{} is already installed", dir.display())));
    }
    std::fs::create_dir_all(user_dir()).map_err(|e| Fail::new(1, format!("{}: {e}", user_dir().display())))?;
    let partial = user_dir().join(format!(".{id}.partial"));
    let _ = std::fs::remove_dir_all(&partial);
    copy_tree(&dir, &partial).map_err(|e| Fail::new(1, format!("copying {}: {e}", dir.display())))?;
    let started = now();
    let _ = std::fs::remove_file(cache_dir(&id).join("status.json"));
    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(&partial, &target).map_err(|e| Fail::new(1, format!("{}: {e}", target.display())))?;
    // Installed means done iterating: the copy takes over from the draft.
    let _ = std::fs::remove_file(dev_dir().join(format!("{id}.json")));
    report(&id, &target, started, "user")
}

fn dunce(dir: &Path) -> Result<PathBuf, Fail> {
    std::fs::canonicalize(dir).map_err(|e| Fail::new(2, format!("{}: {e}", dir.display())))
}

/// Everything but `.git`, so an installed copy keeps its `node_modules`.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        if name == ".git" {
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_tree(&entry.path(), &to.join(&name))?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), to.join(&name))?;
        }
    }
    Ok(())
}

fn read_status(id: &str) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(cache_dir(id).join("status.json")).ok()?).ok()
}

/// The log's lines from `since` on, without their timestamps.
fn log_since(id: &str, since: u64) -> Vec<String> {
    let text = std::fs::read_to_string(cache_dir(id).join("log")).unwrap_or_default();
    text.lines()
        .filter_map(|line| {
            let (at, rest) = line.split_once(' ')?;
            (at.parse::<u64>().ok()? >= since).then(|| rest.to_string())
        })
        .collect()
}

/// Waits for the app to build `id` from `dir`, then to load it, and says how both went.
fn report(id: &str, dir: &Path, started: u64, scope: &str) -> Result<String, Fail> {
    let dir_text = dir.to_string_lossy();
    let deadline = Instant::now() + BUILD_WAIT;
    let status = loop {
        if let Some(status) = read_status(id).filter(|s| s["dir"].as_str() == Some(&dir_text)) {
            break status;
        }
        if Instant::now() > deadline {
            return Err(Fail::new(
                3,
                format!(
                    "Registered {id} ({scope}), but no Roer app built it within {}s. Roer builds and loads \
                     extensions: ask the user to start it.",
                    BUILD_WAIT.as_secs()
                ),
            ));
        }
        std::thread::sleep(Duration::from_millis(200));
    };

    if status["ok"] != json!(true) {
        let errors: Vec<&str> = status["errors"].as_array().map(|e| e.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        return Err(Fail::new(1, format!("{id} did not build:\n{}", errors.join("\n"))));
    }
    if status["hasApp"] != json!(true) {
        return Ok(format!("{id} ({scope}) has no \"app\" in its manifest, so there is nothing to show."));
    }

    let deadline = Instant::now() + LOAD_WAIT;
    loop {
        let lines = log_since(id, started);
        if let Some(at) = lines.iter().rposition(|line| line.starts_with("activation failed") || line == "loaded") {
            if lines[at] == "loaded" {
                return Ok(format!(
                    "{id} ({scope}) built and loaded: its tab is in Roer's strip. It rebuilds and reloads on every save; \
                     `roer ext logs {id}` has what it threw while rendering."
                ));
            }
            return Err(Fail::new(1, format!("{id} built, but failed to load:\n{}", lines[at..].join("\n"))));
        }
        if Instant::now() > deadline {
            return Ok(format!(
                "{id} ({scope}) built, but no Roer window has loaded it yet: is one open? `roer ext logs {id}` will say \
                 when it loads."
            ));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn pointer_dir(path: &Path) -> Option<PathBuf> {
    let pointer: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    pointer["dir"].as_str().map(PathBuf::from)
}

pub fn list() -> String {
    let mut rows: Vec<(String, &str, PathBuf)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dev_dir()) {
        for entry in entries.flatten() {
            let path = entry.path();
            let (Some(id), Some(dir)) = (path.file_stem().map(|s| s.to_string_lossy().into_owned()), pointer_dir(&path)) else {
                continue;
            };
            if path.extension().is_some_and(|e| e == "json") && dir.is_dir() {
                rows.push((id, "session", dir));
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(user_dir()) {
        for entry in entries.flatten() {
            let id = entry.file_name().to_string_lossy().into_owned();
            if valid_id(&id) && entry.path().join("extension.json").is_file() && !rows.iter().any(|row| row.0 == id) {
                rows.push((id, "user", entry.path()));
            }
        }
    }
    rows.sort();
    if rows.is_empty() {
        return "No extensions. `roer ext new <id>` writes one.".to_string();
    }
    rows.iter()
        .map(|(id, scope, dir)| {
            let state = match read_status(id) {
                Some(status) if status["ok"] == json!(true) => "ok",
                Some(_) => "failed",
                None => "unbuilt",
            };
            format!("{id}\t{scope}\t{state}\t{}", dir.display())
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn logs(id: &str, lines: usize) -> Result<String, Fail> {
    let id = checked(id)?;
    let text = std::fs::read_to_string(cache_dir(id).join("log")).unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    if all.is_empty() {
        return Ok(format!("{id} has logged nothing yet."));
    }
    Ok(all[all.len().saturating_sub(lines)..].join("\n"))
}

fn remove(id: &str) -> Result<String, Fail> {
    let id = checked(id)?;
    let pointer = dev_dir().join(format!("{id}.json"));
    let installed = user_dir().join(id);
    let mut gone = Vec::new();
    if pointer.is_file() {
        std::fs::remove_file(&pointer).map_err(|e| Fail::new(1, format!("{}: {e}", pointer.display())))?;
        gone.push("its session folder (left on disk)");
    }
    if installed.is_dir() {
        std::fs::remove_dir_all(&installed).map_err(|e| Fail::new(1, format!("{}: {e}", installed.display())))?;
        gone.push("its installed copy");
    }
    if gone.is_empty() {
        return Err(Fail::new(2, format!("no extension {id}")));
    }
    Ok(format!("Removed {id}: {}.", gone.join(" and ")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_extension_is_a_manifest_an_entry_and_the_types() {
        let parent = std::env::temp_dir().join(format!("roer-ext-new-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&parent);
        std::fs::create_dir_all(&parent).unwrap();

        new("todo-list", &parent).unwrap();
        let dir = parent.join("todo-list");
        let (manifest, id) = manifest(&dir).unwrap();
        assert_eq!(id, "todo-list");
        assert_eq!(manifest["name"], "Todo List");
        assert!(std::fs::read_to_string(dir.join("app.tsx")).unwrap().contains("title: \"Todo List\""));
        assert!(std::fs::read_to_string(dir.join("roer.d.ts")).unwrap().contains("declare module \"roer\""));
        assert!(new("todo-list", &parent).is_err(), "never writes over a folder");

        std::fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn a_manifest_needs_an_id_a_name_and_api_version_1() {
        let dir = std::env::temp_dir().join(format!("roer-ext-manifest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let check = |text: &str| {
            std::fs::write(dir.join("extension.json"), text).unwrap();
            manifest(&dir).map(|(_, id)| id).map_err(|fail| fail.message)
        };
        assert_eq!(check(r#"{"apiVersion":1,"id":"a-b","name":"A"}"#), Ok("a-b".into()));
        assert!(check(r#"{"apiVersion":1,"id":"A","name":"A"}"#).unwrap_err().contains("not an extension id"));
        assert!(check(r#"{"apiVersion":2,"id":"a","name":"A"}"#).unwrap_err().contains("apiVersion"));
        assert!(check(r#"{"apiVersion":1,"id":"a"}"#).unwrap_err().contains("name"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
