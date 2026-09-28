//! The terminal ↔ app plugin-UI channels.
//!
//! `roer plugin-ui` drops one A2UI v1.0 message into ~/.roer/plugin-ui and
//! returns immediately — unlike a handoff, nothing is waiting on it, so there
//! is no claim, ack or timeout. This module only has to notice a new record,
//! hand its contents to the frontend, and forget it: consuming (deleting) the
//! file on delivery is what stands in for an ack here.
//!
//! Watching a directory rather than adding a Tauri command the shim calls
//! directly keeps the same shape as [`crate::handoff`] and works identically
//! whether the app is reached over `open -a Roer` or is already running.
//!
//! The reverse direction — a component's action, reported app → terminal —
//! is the same shape run backwards: [`report_plugin_ui_action`] writes a
//! record under ~/.roer/plugin-ui-actions, tagged with the pane, and
//! `roer plugin-ui-actions` polls and consumes whatever landed for its own
//! pane. There is deliberately no channel back into the app from there: an
//! action is a fact reported to whichever agent is watching that pane, not a
//! command Roer itself runs — the agent decides what, if anything, to do
//! about it.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use notify::{EventKind, RecursiveMode, Watcher};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::history::roer_home;

pub const PLUGIN_UI_EVENT: &str = "roer://plugin-ui";

/// One A2UI v1.0 message, tagged with the pane that sent it.
///
/// `message` is passed through untouched: its shape (`createSurface`,
/// `updateComponents`, `updateDataModel`, `deleteSurface`) is the frontend's
/// contract with the agent, not this watcher's, so it travels as an opaque
/// JSON value.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PluginUiRecord {
    /// What the receipt for this record is named after; absent from a shim
    /// that predates receipts, which waits for none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub pane: String,
    pub message: serde_json::Value,
}

/// Mirrors the shim's own resolution, `ROER_HOME` included.
pub fn plugin_ui_dir() -> PathBuf {
    roer_home().join("plugin-ui")
}

/// Where the panel's answer for a record waits for the `roer` that sent it.
pub fn plugin_ui_receipts_dir() -> PathBuf {
    roer_home().join("plugin-ui-receipts")
}

/// Where a reported action waits for `roer plugin-ui-actions` to collect it.
pub fn plugin_ui_actions_dir() -> PathBuf {
    roer_home().join("plugin-ui-actions")
}

/// A component's action: v1.0's own renderer-to-agent `action` message,
/// tagged with the pane it belongs to rather than making every plugin author
/// repeat it. Opaque here for the same reason [`PluginUiRecord::message`] is.
/// `dataModel` is the surface's whole data model, present only when its
/// `createSurface` asked for `sendDataModel` — the transport carries it
/// beside the message, as A2A carries it in metadata.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PluginUiAction {
    pub pane: String,
    pub message: serde_json::Value,
    #[serde(rename = "dataModel", default, skip_serializing_if = "Option::is_none")]
    pub data_model: Option<serde_json::Value>,
}

/// Report a component's action back to the terminal. Write-then-rename, the
/// same reasoning as the shim's own writes: `roer plugin-ui-actions` must
/// never observe a half-written record.
#[tauri::command]
pub fn report_plugin_ui_action(action: PluginUiAction) -> Result<(), String> {
    write_action(&action, &plugin_ui_actions_dir())
}

/// What the panel did with one record: `shown`, or why not (`other-pane`,
/// `pane-unknown`, `nothing-on-screen`, `invalid`). `onScreen` is the pane it
/// was showing instead, when it knew one. Every way a message misses the
/// panel is silent on screen, so this is how the agent that sent it hears.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PluginUiReceipt {
    pub id: String,
    pub outcome: String,
    #[serde(rename = "onScreen", default, skip_serializing_if = "Option::is_none")]
    pub on_screen: Option<String>,
}

#[tauri::command]
pub fn report_plugin_ui_receipt(receipt: PluginUiReceipt) -> Result<(), String> {
    write_receipt(&receipt, &plugin_ui_receipts_dir())
}

fn write_receipt(receipt: &PluginUiReceipt, dir: &Path) -> Result<(), String> {
    // The id names a file, and it came back from the frontend.
    let safe = !receipt.id.is_empty()
        && receipt.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if !safe {
        return Err(format!("not a plugin UI record id: {}", receipt.id));
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("{}.json", receipt.id));
    // A desktop window and a browser tab can both answer for one record:
    // whichever showed it is the answer that counts.
    if receipt.outcome != "shown" && file.exists() {
        return Ok(());
    }
    let partial = file.with_extension("json.partial");
    let body = serde_json::to_string(receipt).map_err(|e| e.to_string())?;
    std::fs::write(&partial, body).map_err(|e| e.to_string())?;
    std::fs::rename(&partial, &file).map_err(|e| e.to_string())
}

fn write_action(action: &PluginUiAction, dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("{}-{}.json", unique_stamp(), std::process::id()));
    let partial = file.with_extension("json.partial");
    let body = serde_json::to_string(action).map_err(|e| e.to_string())?;
    std::fs::write(&partial, body).map_err(|e| e.to_string())?;
    std::fs::rename(&partial, &file).map_err(|e| e.to_string())
}

/// A unique, filesystem-sortable name for an action record. Nanoseconds
/// rather than the shim's second-resolution stamp: two clicks in the same
/// second must not collide before the pid is even considered.
fn unique_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default()
        .to_string()
}

fn is_record(path: &Path) -> bool {
    // The shim writes `<name>.json.partial` and renames it into place, so
    // filtering on the extension is also what keeps a partial record from
    // being parsed mid-write.
    path.extension().and_then(|e| e.to_str()) == Some("json")
}

/// Start watching for plugin-UI messages.
///
/// Messages written while the app was down are lost, not queued — there is
/// no pending-fetch command to mirror `handoff_pending`. That is deliberate:
/// a plugin's UI is only ever generated while a session is on screen and an
/// agent is being asked for it, so the app is already up by construction.
pub fn watch<S: crate::events::Sink>(app: S) -> notify::Result<()> {
    watch_records::<PluginUiRecord, S>(app, plugin_ui_dir(), PLUGIN_UI_EVENT)
}

/// Watch `dir` for fire-and-forget records the shim drops there, emit each
/// one to the frontend as `event`, and consume the file. Shared by every
/// terminal → app channel with this shape (plugin UI, PR drafts): only the
/// record type and the directory differ.
pub fn watch_records<R, S: crate::events::Sink>(
    app: S,
    dir: PathBuf,
    event: &'static str,
) -> notify::Result<()>
where
    R: DeserializeOwned + Serialize + Clone,
{
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("roer: cannot create {}: {e}", dir.display());
        return Ok(());
    }

    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = match notify::recommended_watcher(tx) {
            Ok(watcher) => watcher,
            Err(e) => {
                eprintln!("roer: could not start the {event} watcher: {e}");
                return;
            }
        };
        if let Err(e) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
            eprintln!("roer: could not watch {}: {e}", dir.display());
            return;
        }

        // One rename can surface as several events, so records are delivered
        // once. Entries for files that are gone are dropped first, which both
        // bounds the set and lets a recycled filename through.
        let mut seen: HashSet<PathBuf> = HashSet::new();
        for change in rx.into_iter().flatten() {
            if !matches!(change.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                continue;
            }
            seen.retain(|path| path.exists());
            for path in change.paths {
                if is_record(&path) && path.exists() && seen.insert(path.clone()) {
                    deliver::<R, S>(&app, &path, event);
                }
            }
        }
    });

    Ok(())
}

fn deliver<R, S: crate::events::Sink>(app: &S, path: &Path, event: &str)
where
    R: DeserializeOwned + Serialize + Clone,
{
    match read::<R>(path) {
        Ok(record) => app.emit(event, &record),
        // A malformed record must not take the watcher down with it.
        Err(e) => eprintln!("roer: ignoring {}: {e}", path.display()),
    }
    // Fire-and-forget: nothing acks this, so delivering it is the last thing
    // that happens to the file. Leaving it behind would mean the watcher
    // re-delivers on every subsequent event within its `seen` window, or the
    // directory grows without bound across a long session.
    let _ = std::fs::remove_file(path);
}

fn read<R: DeserializeOwned>(path: &Path) -> Result<R, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

/// A saved plugin UI: the prompt that produced it, plus the one v1.0
/// `createSurface` message that builds it, components and data model inline
/// — kept opaque here for the same reason [`PluginUiRecord::message`] is:
/// this module doesn't know or care about the A2UI component catalog, only
/// the frontend does.
///
/// A bundle saved before v1.0 comes back as `legacy` instead, its files as
/// they are. Upgrading one needs the catalog, so that is the frontend's job
/// too; it writes the result back as `surface`, which clears the old files.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PluginUiBundle {
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy: Option<LegacyBundle>,
}

/// The two files a pre-v1.0 bundle kept its messages in.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct LegacyBundle {
    #[serde(rename = "surfaceUpdate")]
    pub surface_update: serde_json::Value,
    #[serde(rename = "dataModelUpdate", skip_serializing_if = "Option::is_none")]
    pub data_model_update: Option<serde_json::Value>,
}

const SURFACE_FILE: &str = "surface.json";
const LEGACY_SURFACE_FILE: &str = "surface-update.json";
const LEGACY_DATA_FILE: &str = "data-model.json";

fn is_bundle(dir: &Path) -> bool {
    dir.join(SURFACE_FILE).is_file() || dir.join(LEGACY_SURFACE_FILE).is_file()
}

#[derive(Clone, Debug, Serialize)]
pub struct PluginUiBundleSummary {
    pub name: String,
    pub prompt: String,
}

/// The worktree root holding `cwd`, falling back to `cwd` itself outside a
/// repository — a roer session is always opened at a project directory, so
/// this is a reasonable place to keep bundles even without git.
fn project_root(cwd: &str) -> PathBuf {
    crate::git::root(cwd)
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(cwd))
}

fn bundles_dir(cwd: &str) -> PathBuf {
    project_root(cwd).join(".roer").join("plugin-ui").join("bundles")
}

/// A bundle name becomes a single path segment on disk, so it must not be
/// empty or carry any path structure of its own — a `../x` here must never
/// escape `bundles_dir`.
fn validate_bundle_name(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(format!(
            "invalid plugin-ui bundle name: {name:?} (use letters, digits, - and _ only)"
        ))
    }
}

fn write_string(path: &Path, contents: &str) -> Result<(), String> {
    let partial = path.with_extension("partial");
    std::fs::write(&partial, contents).map_err(|e| e.to_string())?;
    std::fs::rename(&partial, path).map_err(|e| e.to_string())
}

fn read_json(path: &Path) -> Result<serde_json::Value, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn list_plugin_ui_bundles(cwd: String) -> Vec<PluginUiBundleSummary> {
    let dir = bundles_dir(&cwd);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut bundles: Vec<PluginUiBundleSummary> = entries
        .flatten()
        .filter(|entry| is_bundle(&entry.path()))
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_string();
            let prompt = std::fs::read_to_string(entry.path().join("prompt.md")).unwrap_or_default();
            Some(PluginUiBundleSummary { name, prompt })
        })
        .collect();
    bundles.sort_by(|a, b| a.name.cmp(&b.name));
    bundles
}

#[tauri::command(async)]
pub fn read_plugin_ui_bundle(cwd: String, name: String) -> Result<PluginUiBundle, String> {
    validate_bundle_name(&name)?;
    let dir = bundles_dir(&cwd).join(&name);
    let prompt = std::fs::read_to_string(dir.join("prompt.md")).unwrap_or_default();
    if dir.join(SURFACE_FILE).is_file() {
        return Ok(PluginUiBundle {
            prompt,
            surface: Some(read_json(&dir.join(SURFACE_FILE))?),
            legacy: None,
        });
    }
    Ok(PluginUiBundle {
        prompt,
        surface: None,
        legacy: Some(LegacyBundle {
            surface_update: read_json(&dir.join(LEGACY_SURFACE_FILE))?,
            data_model_update: read_json(&dir.join(LEGACY_DATA_FILE)).ok(),
        }),
    })
}

#[tauri::command(async)]
pub fn write_plugin_ui_bundle(
    cwd: String,
    name: String,
    bundle: PluginUiBundle,
) -> Result<(), String> {
    validate_bundle_name(&name)?;
    let surface = bundle
        .surface
        .as_ref()
        .ok_or("a plugin-ui bundle is written as its createSurface message")?;
    let dir = bundles_dir(&cwd).join(&name);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    write_string(&dir.join("prompt.md"), &bundle.prompt)?;
    write_string(
        &dir.join(SURFACE_FILE),
        &serde_json::to_string_pretty(surface).map_err(|e| e.to_string())?,
    )?;
    // Written as v1.0, it no longer needs what it was before — and leaving
    // them would make it look like a legacy bundle to an older reader.
    let _ = std::fs::remove_file(dir.join(LEGACY_SURFACE_FILE));
    let _ = std::fs::remove_file(dir.join(LEGACY_DATA_FILE));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_json_records_are_picked_up() {
        assert!(is_record(Path::new("/tmp/p/20260101T000000-1.json")));
        assert!(!is_record(Path::new(
            "/tmp/p/20260101T000000-1.json.partial"
        )));
        assert!(!is_record(Path::new("/tmp/p/notes.txt")));
    }

    #[test]
    fn reads_a_message_and_keeps_it_opaque() {
        let dir = std::env::temp_dir().join(format!("roer-plugin-ui-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("20260101T000000-1.json");
        std::fs::write(
            &path,
            r#"{"pane": "%3", "message": {"version": "v1.0", "deleteSurface": {"surfaceId": "s"}}}"#,
        )
        .expect("write record");

        let got = read::<PluginUiRecord>(&path).expect("parse");
        assert_eq!(got.pane, "%3");
        assert_eq!(got.message["version"], "v1.0");
        assert_eq!(got.message["deleteSurface"]["surfaceId"], "s");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_receipt_is_named_after_its_record_and_a_shown_one_wins() {
        let dir = std::env::temp_dir().join(format!("roer-plugin-ui-receipts-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        let receipt = |outcome: &str| PluginUiReceipt {
            id: "20260101T000000-1-0-1".into(),
            outcome: outcome.into(),
            on_screen: Some("%2".into()),
        };
        let read_back = || read::<PluginUiReceipt>(&dir.join("20260101T000000-1-0-1.json")).expect("receipt");

        write_receipt(&receipt("other-pane"), &dir).expect("write");
        assert_eq!(read_back().outcome, "other-pane");
        assert_eq!(read_back().on_screen.as_deref(), Some("%2"));
        write_receipt(&receipt("shown"), &dir).expect("write");
        write_receipt(&receipt("nothing-on-screen"), &dir).expect("write");
        assert_eq!(read_back().outcome, "shown", "a window that showed it outranks one that did not");

        let escape = PluginUiReceipt { id: "../../evil".into(), outcome: "shown".into(), on_screen: None };
        assert!(write_receipt(&escape, &dir).is_err());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_malformed_record_is_an_error_not_a_panic() {
        let dir = std::env::temp_dir().join(format!("roer-plugin-ui-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("bad.json");
        std::fs::write(&path, "{ not json").expect("write");
        assert!(read::<PluginUiRecord>(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_action_lands_as_one_complete_json_file() {
        let dir = std::env::temp_dir().join(format!("roer-plugin-ui-actions-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();

        let action = PluginUiAction {
            pane: "%9".into(),
            message: serde_json::json!({
                "version": "v1.0",
                "action": {
                    "name": "run",
                    "surfaceId": "catalog-demo",
                    "sourceComponentId": "run-button",
                    "timestamp": "2026-09-22T00:00:00Z",
                    "context": {},
                },
            }),
            data_model: None,
        };
        write_action(&action, &dir).expect("write");

        let entries: Vec<_> = std::fs::read_dir(&dir)
            .expect("read dir")
            .map(|e| e.expect("entry").path())
            .collect();
        // Never a `.partial` left behind, and never more than the one record.
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].extension().and_then(|e| e.to_str()), Some("json"));

        let raw = std::fs::read_to_string(&entries[0]).expect("read");
        let got: PluginUiAction = serde_json::from_str(&raw).expect("parse");
        assert_eq!(got.pane, "%9");
        assert_eq!(got.message["action"]["name"], "run");
        assert_eq!(got.message["action"]["sourceComponentId"], "run-button");
        // No `sendDataModel`, no data model on the wire.
        assert!(!raw.contains("dataModel"));

        std::fs::remove_dir_all(&dir).ok();
    }

    fn temp_project(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "roer-plugin-ui-bundles-{label}-{}",
            std::process::id()
        ));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn rejects_names_that_are_not_a_single_path_segment() {
        assert!(validate_bundle_name("test-runner").is_ok());
        assert!(validate_bundle_name("").is_err());
        assert!(validate_bundle_name("..").is_err());
        assert!(validate_bundle_name("../x").is_err());
        assert!(validate_bundle_name("a/b").is_err());
    }

    fn surface(id: &str) -> serde_json::Value {
        serde_json::json!({
            "version": "v1.0",
            "createSurface": {
                "surfaceId": id,
                "components": [{"id": "root", "component": "Text", "text": "hi"}],
                "dataModel": {"status": "idle"},
            },
        })
    }

    #[test]
    fn a_bundle_round_trips_through_write_and_read() {
        let project = temp_project("roundtrip");
        let cwd = project.to_str().unwrap().to_string();

        let bundle = PluginUiBundle {
            prompt: "Add a test runner".into(),
            surface: Some(surface("test-runner")),
            legacy: None,
        };
        write_plugin_ui_bundle(cwd.clone(), "test-runner".into(), bundle.clone())
            .expect("write bundle");

        let got = read_plugin_ui_bundle(cwd.clone(), "test-runner".into()).expect("read bundle");
        assert_eq!(got.prompt, bundle.prompt);
        assert_eq!(got.surface, bundle.surface);
        assert_eq!(got.legacy, None);

        let bundles = list_plugin_ui_bundles(cwd);
        assert_eq!(bundles.len(), 1);
        assert_eq!(bundles[0].name, "test-runner");
        assert_eq!(bundles[0].prompt, "Add a test runner");

        std::fs::remove_dir_all(&project).ok();
    }

    #[test]
    fn a_pre_v1_bundle_is_listed_read_as_legacy_and_cleared_once_rewritten() {
        let project = temp_project("legacy");
        let cwd = project.to_str().unwrap().to_string();
        let dir = bundles_dir(&cwd).join("old");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(dir.join(LEGACY_SURFACE_FILE), r#"{"kind": "surfaceUpdate", "surfaceId": "old"}"#)
            .expect("write");
        std::fs::write(dir.join(LEGACY_DATA_FILE), r#"{"kind": "dataModelUpdate", "patch": {}}"#)
            .expect("write");

        assert_eq!(list_plugin_ui_bundles(cwd.clone()).len(), 1);
        let got = read_plugin_ui_bundle(cwd.clone(), "old".into()).expect("read");
        assert_eq!(got.surface, None);
        let legacy = got.legacy.expect("legacy");
        assert_eq!(legacy.surface_update["kind"], "surfaceUpdate");
        assert!(legacy.data_model_update.is_some());

        write_plugin_ui_bundle(
            cwd.clone(),
            "old".into(),
            PluginUiBundle { prompt: String::new(), surface: Some(surface("old")), legacy: None },
        )
        .expect("rewrite");
        assert!(!dir.join(LEGACY_SURFACE_FILE).exists());
        assert!(!dir.join(LEGACY_DATA_FILE).exists());
        assert!(read_plugin_ui_bundle(cwd, "old".into()).expect("read").surface.is_some());

        std::fs::remove_dir_all(&project).ok();
    }

    #[test]
    fn writing_a_bundle_needs_its_surface() {
        let project = temp_project("no-surface");
        let cwd = project.to_str().unwrap().to_string();
        let err = write_plugin_ui_bundle(
            cwd,
            "empty".into(),
            PluginUiBundle { prompt: String::new(), surface: None, legacy: None },
        )
        .unwrap_err();
        assert!(err.contains("createSurface"));
        std::fs::remove_dir_all(&project).ok();
    }

    #[test]
    fn listing_skips_directories_with_no_surface() {
        let project = temp_project("skip-incomplete");
        let cwd = project.to_str().unwrap().to_string();
        std::fs::create_dir_all(bundles_dir(&cwd).join("half-written")).expect("mkdir");

        assert!(list_plugin_ui_bundles(cwd).is_empty());

        std::fs::remove_dir_all(&project).ok();
    }

    #[test]
    fn a_traversal_attempt_in_the_name_is_rejected_before_touching_disk() {
        let project = temp_project("traversal");
        let cwd = project.to_str().unwrap().to_string();

        let err = write_plugin_ui_bundle(
            cwd,
            "../escaped".into(),
            PluginUiBundle {
                prompt: String::new(),
                surface: Some(serde_json::json!({})),
                legacy: None,
            },
        )
        .unwrap_err();
        assert!(err.contains("invalid plugin-ui bundle name"));
        assert!(!project.parent().unwrap().join("escaped").exists());

        std::fs::remove_dir_all(&project).ok();
    }
}
