//! Workspaces: a persisted, user-named entity that everything related to one
//! piece of work hangs off — sessions and past Claude conversations
//! explicitly assigned to it, Projects (git repos, see `projects.rs`)
//! attached to it, plus a generic slot for other external items such as a
//! tracker task. A Project is a global entity that can be attached to many
//! Workspaces, so a Workspace only holds ids here, not embedded Projects.
//!
//! Unlike `history.rs`, a Workspace is state the user explicitly created,
//! not a reconciliation of something else's truth — so it is written
//! directly rather than derived on every read.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::history::roer_home;

const VERSION: u32 = 1;

/// Every user starts with somewhere to put a Project, rather than an empty
/// list and a "New workspace" button as the very first thing the app asks
/// of them.
const DEFAULT_WORKSPACE_NAME: &str = "Default";

fn workspaces_file() -> PathBuf {
    roer_home().join("workspaces.json")
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceItem {
    pub id: String,
    pub kind: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    /// Project ids, resolved against the global registry in `projects.rs` —
    /// not embedded, since one Project can be attached to several Workspaces.
    #[serde(default)]
    pub projects: Vec<String>,
    #[serde(default)]
    pub items: Vec<WorkspaceItem>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Store {
    version: u32,
    workspaces: Vec<Workspace>,
    /// Session id (live tmux session, past session, or Claude thread — all
    /// share an `id: String`) to the Workspace it is assigned to. A session
    /// belongs to at most one Workspace at a time.
    #[serde(default)]
    assignments: BTreeMap<String, String>,
}

impl Default for Store {
    fn default() -> Self {
        Store {
            version: VERSION,
            workspaces: Vec::new(),
            assignments: BTreeMap::new(),
        }
    }
}

fn load(path: &std::path::Path) -> Store {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Store::default();
    };
    // A version mismatch (or corrupt JSON) drops the file wholesale, same
    // trade-off history.rs makes: simple beats migrating field-by-field.
    match serde_json::from_str::<Store>(&raw) {
        Ok(store) if store.version == VERSION => store,
        _ => Store::default(),
    }
}

fn save(path: &std::path::Path, store: &Store) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(store)?)?;
    std::fs::rename(&tmp, path)
}

/// Unique enough for this: minted from a click, never in a hot loop, and
/// collisions would need two calls landing in the same nanosecond.
fn fresh_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{nanos:x}")
}

/// The list, seeding a Default workspace the first time anything asks — so
/// there is always somewhere to attach a Project, without a first-run wizard
/// or a "New workspace" button standing between install and useful.
pub fn list() -> Vec<Workspace> {
    list_in(&workspaces_file())
}

fn list_in(path: &std::path::Path) -> Vec<Workspace> {
    let mut store = load(path);
    if store.workspaces.is_empty() {
        store.workspaces.push(Workspace {
            id: fresh_id(),
            name: DEFAULT_WORKSPACE_NAME.to_string(),
            projects: Vec::new(),
            items: Vec::new(),
        });
        // Best-effort: a failed save here just means the same seed runs
        // again next launch, which is harmless.
        let _ = save(path, &store);
    }
    store.workspaces
}

pub fn create(name: String) -> std::io::Result<Workspace> {
    create_in(&workspaces_file(), name)
}

fn create_in(path: &std::path::Path, name: String) -> std::io::Result<Workspace> {
    let mut store = load(path);
    let workspace = Workspace {
        id: fresh_id(),
        name,
        projects: Vec::new(),
        items: Vec::new(),
    };
    store.workspaces.push(workspace.clone());
    save(path, &store)?;
    Ok(workspace)
}

pub fn rename(id: &str, name: String) -> std::io::Result<Option<Workspace>> {
    rename_in(&workspaces_file(), id, name)
}

fn rename_in(
    path: &std::path::Path,
    id: &str,
    name: String,
) -> std::io::Result<Option<Workspace>> {
    let mut store = load(path);
    let Some(workspace) = store.workspaces.iter_mut().find(|w| w.id == id) else {
        return Ok(None);
    };
    workspace.name = name;
    let updated = workspace.clone();
    save(path, &store)?;
    Ok(Some(updated))
}

pub fn delete(id: &str) -> std::io::Result<()> {
    delete_in(&workspaces_file(), id)
}

fn delete_in(path: &std::path::Path, id: &str) -> std::io::Result<()> {
    let mut store = load(path);
    store.workspaces.retain(|w| w.id != id);
    // A deleted Workspace's assignments would otherwise dangle, pointing at
    // an id that no longer resolves to anything.
    store.assignments.retain(|_, workspace_id| workspace_id != id);
    save(path, &store)
}

pub fn attach_project(
    workspace_id: &str,
    project_id: &str,
) -> std::io::Result<Option<Workspace>> {
    attach_project_in(&workspaces_file(), workspace_id, project_id)
}

fn attach_project_in(
    path: &std::path::Path,
    workspace_id: &str,
    project_id: &str,
) -> std::io::Result<Option<Workspace>> {
    let mut store = load(path);
    let Some(workspace) = store.workspaces.iter_mut().find(|w| w.id == workspace_id) else {
        return Ok(None);
    };
    if !workspace.projects.iter().any(|id| id == project_id) {
        workspace.projects.push(project_id.to_string());
    }
    let updated = workspace.clone();
    save(path, &store)?;
    Ok(Some(updated))
}

pub fn detach_project(
    workspace_id: &str,
    project_id: &str,
) -> std::io::Result<Option<Workspace>> {
    detach_project_in(&workspaces_file(), workspace_id, project_id)
}

fn detach_project_in(
    path: &std::path::Path,
    workspace_id: &str,
    project_id: &str,
) -> std::io::Result<Option<Workspace>> {
    let mut store = load(path);
    let Some(workspace) = store.workspaces.iter_mut().find(|w| w.id == workspace_id) else {
        return Ok(None);
    };
    workspace.projects.retain(|id| id != project_id);
    let updated = workspace.clone();
    save(path, &store)?;
    Ok(Some(updated))
}

/// Removes a Project id from every Workspace that references it. Called by
/// `projects::delete` once the Project itself is gone from its own registry,
/// so nothing is left pointing at an id that no longer resolves.
pub fn strip_project(project_id: &str) -> std::io::Result<()> {
    strip_project_in(&workspaces_file(), project_id)
}

fn strip_project_in(path: &std::path::Path, project_id: &str) -> std::io::Result<()> {
    let mut store = load(path);
    for workspace in &mut store.workspaces {
        workspace.projects.retain(|id| id != project_id);
    }
    save(path, &store)
}

pub fn add_item(
    workspace_id: &str,
    kind: String,
    title: String,
    url: Option<String>,
) -> std::io::Result<Option<Workspace>> {
    add_item_in(&workspaces_file(), workspace_id, kind, title, url)
}

fn add_item_in(
    path: &std::path::Path,
    workspace_id: &str,
    kind: String,
    title: String,
    url: Option<String>,
) -> std::io::Result<Option<Workspace>> {
    let mut store = load(path);
    let Some(workspace) = store.workspaces.iter_mut().find(|w| w.id == workspace_id) else {
        return Ok(None);
    };
    workspace.items.push(WorkspaceItem {
        id: fresh_id(),
        kind,
        title,
        url,
    });
    let updated = workspace.clone();
    save(path, &store)?;
    Ok(Some(updated))
}

pub fn remove_item(workspace_id: &str, item_id: &str) -> std::io::Result<Option<Workspace>> {
    remove_item_in(&workspaces_file(), workspace_id, item_id)
}

fn remove_item_in(
    path: &std::path::Path,
    workspace_id: &str,
    item_id: &str,
) -> std::io::Result<Option<Workspace>> {
    let mut store = load(path);
    let Some(workspace) = store.workspaces.iter_mut().find(|w| w.id == workspace_id) else {
        return Ok(None);
    };
    workspace.items.retain(|i| i.id != item_id);
    let updated = workspace.clone();
    save(path, &store)?;
    Ok(Some(updated))
}

pub fn assignments() -> BTreeMap<String, String> {
    assignments_in(&workspaces_file())
}

fn assignments_in(path: &std::path::Path) -> BTreeMap<String, String> {
    load(path).assignments
}

pub fn assign(session_id: &str, workspace_id: &str) -> std::io::Result<()> {
    assign_in(&workspaces_file(), session_id, workspace_id)
}

fn assign_in(
    path: &std::path::Path,
    session_id: &str,
    workspace_id: &str,
) -> std::io::Result<()> {
    let mut store = load(path);
    store
        .assignments
        .insert(session_id.to_string(), workspace_id.to_string());
    save(path, &store)
}

pub fn unassign(session_id: &str) -> std::io::Result<()> {
    unassign_in(&workspaces_file(), session_id)
}

fn unassign_in(path: &std::path::Path, session_id: &str) -> std::io::Result<()> {
    let mut store = load(path);
    store.assignments.remove(session_id);
    save(path, &store)
}

#[tauri::command]
pub fn workspaces_list() -> Vec<Workspace> {
    list()
}

#[tauri::command]
pub fn workspace_create(name: String) -> Result<Workspace, String> {
    create(name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspace_rename(id: String, name: String) -> Result<Option<Workspace>, String> {
    rename(&id, name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspace_delete(id: String) -> Result<(), String> {
    delete(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspace_attach_project(
    workspace_id: String,
    project_id: String,
) -> Result<Option<Workspace>, String> {
    attach_project(&workspace_id, &project_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspace_detach_project(
    workspace_id: String,
    project_id: String,
) -> Result<Option<Workspace>, String> {
    detach_project(&workspace_id, &project_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspace_add_item(
    workspace_id: String,
    kind: String,
    title: String,
    url: Option<String>,
) -> Result<Option<Workspace>, String> {
    add_item(&workspace_id, kind, title, url).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspace_remove_item(
    workspace_id: String,
    item_id: String,
) -> Result<Option<Workspace>, String> {
    remove_item(&workspace_id, &item_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspace_assignments() -> BTreeMap<String, String> {
    assignments()
}

#[tauri::command]
pub fn workspace_assign(session_id: String, workspace_id: String) -> Result<(), String> {
    assign(&session_id, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspace_unassign(session_id: String) -> Result<(), String> {
    unassign(&session_id).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Each test gets its own file, not just a timestamp: tests run in
    // parallel threads of the same process, so two calls close enough
    // together can otherwise land on the same nanosecond and collide (see
    // "Make claude.rs test fixtures collision-proof").
    fn temp_file() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::env::temp_dir().join(format!("roer-workspaces-{}-{n}.json", std::process::id()))
    }

    #[test]
    fn a_created_workspace_is_listed() {
        let file = temp_file();
        let workspace = create_in(&file, "Roer".to_string()).unwrap();
        let listed = list_in(&file);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, workspace.id);
        assert_eq!(listed[0].name, "Roer");
        assert!(listed[0].projects.is_empty());
        assert!(listed[0].items.is_empty());
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn listing_an_empty_store_seeds_a_default_workspace() {
        let file = temp_file();
        let listed = list_in(&file);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, DEFAULT_WORKSPACE_NAME);
        // The seed is persisted, not re-minted on every read.
        let listed_again = list_in(&file);
        assert_eq!(listed_again[0].id, listed[0].id);
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn a_deleted_workspace_is_gone() {
        let file = temp_file();
        let workspace = create_in(&file, "one".to_string()).unwrap();
        create_in(&file, "two".to_string()).unwrap();

        delete_in(&file, &workspace.id).unwrap();

        let listed = list_in(&file);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "two");
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn deleting_a_workspace_drops_its_assignments() {
        let file = temp_file();
        let workspace = create_in(&file, "one".to_string()).unwrap();
        assign_in(&file, "session-1", &workspace.id).unwrap();

        delete_in(&file, &workspace.id).unwrap();

        assert!(assignments_in(&file).is_empty());
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn a_session_can_be_assigned_and_unassigned() {
        let file = temp_file();
        let workspace = create_in(&file, "one".to_string()).unwrap();

        assign_in(&file, "session-1", &workspace.id).unwrap();
        assert_eq!(assignments_in(&file).get("session-1"), Some(&workspace.id));

        unassign_in(&file, "session-1").unwrap();
        assert!(assignments_in(&file).get("session-1").is_none());
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn assigning_a_session_again_moves_it_to_the_new_workspace() {
        let file = temp_file();
        let one = create_in(&file, "one".to_string()).unwrap();
        let two = create_in(&file, "two".to_string()).unwrap();

        assign_in(&file, "session-1", &one.id).unwrap();
        assign_in(&file, "session-1", &two.id).unwrap();

        assert_eq!(assignments_in(&file).get("session-1"), Some(&two.id));
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn a_project_can_be_attached_and_detached() {
        let file = temp_file();
        let workspace = create_in(&file, "one".to_string()).unwrap();

        let updated = attach_project_in(&file, &workspace.id, "project-1")
            .unwrap()
            .expect("workspace exists");
        assert_eq!(updated.projects, vec!["project-1".to_string()]);

        let updated = detach_project_in(&file, &workspace.id, "project-1")
            .unwrap()
            .expect("workspace exists");
        assert!(updated.projects.is_empty());
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn attaching_the_same_project_twice_does_not_duplicate_it() {
        let file = temp_file();
        let workspace = create_in(&file, "one".to_string()).unwrap();

        attach_project_in(&file, &workspace.id, "project-1").unwrap();
        let updated = attach_project_in(&file, &workspace.id, "project-1")
            .unwrap()
            .expect("workspace exists");
        assert_eq!(updated.projects, vec!["project-1".to_string()]);
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn attaching_a_project_to_an_unknown_workspace_is_none() {
        let file = temp_file();
        let result = attach_project_in(&file, "missing", "project-1").unwrap();
        assert!(result.is_none());
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn stripping_a_project_removes_it_from_every_workspace() {
        let file = temp_file();
        let one = create_in(&file, "one".to_string()).unwrap();
        let two = create_in(&file, "two".to_string()).unwrap();
        attach_project_in(&file, &one.id, "project-1").unwrap();
        attach_project_in(&file, &two.id, "project-1").unwrap();
        attach_project_in(&file, &two.id, "project-2").unwrap();

        strip_project_in(&file, "project-1").unwrap();

        let listed = list_in(&file);
        for workspace in listed {
            assert!(!workspace.projects.contains(&"project-1".to_string()));
        }
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn a_workspace_can_be_renamed() {
        let file = temp_file();
        let workspace = create_in(&file, "one".to_string()).unwrap();
        let updated = rename_in(&file, &workspace.id, "two".to_string())
            .unwrap()
            .expect("workspace exists");
        assert_eq!(updated.name, "two");
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn an_item_can_be_added_and_removed() {
        let file = temp_file();
        let workspace = create_in(&file, "one".to_string()).unwrap();

        let updated = add_item_in(
            &file,
            &workspace.id,
            "task".to_string(),
            "Fix the thing".to_string(),
            Some("https://example.com/ISSUE-1".to_string()),
        )
        .unwrap()
        .expect("workspace exists");
        assert_eq!(updated.items.len(), 1);
        let item_id = updated.items[0].id.clone();

        let updated = remove_item_in(&file, &workspace.id, &item_id)
            .unwrap()
            .expect("workspace exists");
        assert!(updated.items.is_empty());
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn adding_an_item_to_an_unknown_workspace_is_none() {
        let file = temp_file();
        let result = add_item_in(&file, "missing", "task".to_string(), "x".to_string(), None)
            .unwrap();
        assert!(result.is_none());
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn a_bad_or_missing_version_drops_the_file() {
        let file = temp_file();
        std::fs::write(&file, r#"{"version":999,"workspaces":[]}"#).unwrap();

        create_in(&file, "one".to_string()).unwrap();
        assert_eq!(list_in(&file).len(), 1);
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn the_write_is_atomic_no_tmp_file_left_behind() {
        let file = temp_file();
        create_in(&file, "one".to_string()).unwrap();
        assert!(file.is_file());
        assert!(!file.with_extension("json.tmp").exists());
        std::fs::remove_file(&file).ok();
    }
}
