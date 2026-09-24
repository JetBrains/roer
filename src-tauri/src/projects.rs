//! Projects: a global registry of git repositories, independent of any one
//! Workspace. A Project can be attached to many Workspaces (and a Workspace
//! can have many Projects) — the many-to-many lives on `Workspace.projects`
//! as a list of Project ids, not embedded here.
//!
//! Deduped by absolute path on creation, so pointing "Attach project" at the
//! same folder twice (from two different Workspaces) reuses one Project
//! rather than minting a look-alike.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::git;
use crate::history::roer_home;
use crate::workspaces;

const VERSION: u32 = 1;

fn projects_file() -> PathBuf {
    roer_home().join("projects.json")
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub path: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Store {
    version: u32,
    projects: Vec<Project>,
}

impl Default for Store {
    fn default() -> Self {
        Store {
            version: VERSION,
            projects: Vec::new(),
        }
    }
}

fn load(path: &std::path::Path) -> Store {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Store::default();
    };
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

fn fresh_id() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{nanos:x}-{n:x}")
}

pub fn list() -> Vec<Project> {
    list_in(&projects_file())
}

fn list_in(path: &std::path::Path) -> Vec<Project> {
    load(path).projects
}

/// Reuses an existing Project when `path` is already registered, rather than
/// creating a duplicate or renaming it out from under whatever else has it
/// attached — the caller just wanted "the Project at this path", existing or
/// not.
///
/// `project_path` is resolved to its git worktree root first: the registry
/// is documented as holding repositories, and canonicalizing here is what
/// keeps a subdirectory of an already-registered repo from minting a
/// look-alike Project, and a non-repository from being registered at all.
pub fn create(name: String, project_path: String) -> Result<Project, String> {
    create_in(&projects_file(), name, project_path)
}

fn create_in(path: &std::path::Path, name: String, project_path: String) -> Result<Project, String> {
    let root = git::root(&project_path)?;
    let mut store = load(path);
    if let Some(existing) = store.projects.iter().find(|p| p.path == root) {
        return Ok(existing.clone());
    }
    let project = Project {
        id: fresh_id(),
        path: root,
        name,
    };
    store.projects.push(project.clone());
    save(path, &store).map_err(|e| e.to_string())?;
    Ok(project)
}

pub fn rename(id: &str, name: String) -> std::io::Result<Option<Project>> {
    rename_in(&projects_file(), id, name)
}

fn rename_in(
    path: &std::path::Path,
    id: &str,
    name: String,
) -> std::io::Result<Option<Project>> {
    let mut store = load(path);
    let Some(project) = store.projects.iter_mut().find(|p| p.id == id) else {
        return Ok(None);
    };
    project.name = name;
    let updated = project.clone();
    save(path, &store)?;
    Ok(Some(updated))
}

/// Removes the Project everywhere: its own registry entry, and every
/// Workspace's reference to it — otherwise a Workspace would keep pointing at
/// an id nothing resolves to any more.
pub fn delete(id: &str) -> std::io::Result<()> {
    delete_in(&projects_file(), id)?;
    workspaces::strip_project(id)
}

fn delete_in(path: &std::path::Path, id: &str) -> std::io::Result<()> {
    let mut store = load(path);
    store.projects.retain(|p| p.id != id);
    save(path, &store)
}

#[tauri::command]
pub fn projects_list() -> Vec<Project> {
    list()
}

#[tauri::command]
pub fn project_create(name: String, path: String) -> Result<Project, String> {
    create(name, path)
}

#[tauri::command]
pub fn project_rename(id: String, name: String) -> Result<Option<Project>, String> {
    rename(&id, name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn project_delete(id: String) -> Result<(), String> {
    delete(&id).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{canonical, init, scratch};

    fn temp_file() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::env::temp_dir().join(format!("roer-projects-{}-{n}.json", std::process::id()))
    }

    /// A repository, by the path git reports for it, which is what a project
    /// stores and so what a test asserts against.
    fn repo(name: &str) -> String {
        let dir = scratch(name);
        init(&dir.to_string_lossy());
        canonical(&dir)
    }

    #[test]
    fn a_created_project_is_listed() {
        let file = temp_file();
        let root = repo("a-created-project-is-listed");
        let project = create_in(&file, "Roer".to_string(), root).unwrap();
        let listed = list_in(&file);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, project.id);
        assert_eq!(listed[0].name, "Roer");
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn creating_at_a_non_repository_is_rejected() {
        let file = temp_file();
        let dir = scratch("creating-at-a-non-repository-is-rejected");
        assert!(create_in(&file, "Roer".to_string(), dir.to_string_lossy().to_string()).is_err());
        assert!(list_in(&file).is_empty());
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn creating_from_a_subdirectory_resolves_to_the_repository_root() {
        let file = temp_file();
        let root = repo("creating-from-a-subdirectory-resolves-to-the-repository-root");
        std::fs::create_dir_all(format!("{root}/src")).unwrap();
        let project = create_in(&file, "Roer".to_string(), format!("{root}/src")).unwrap();
        assert_eq!(project.path, root);
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn creating_at_a_known_path_reuses_the_existing_project() {
        let file = temp_file();
        let root = repo("creating-at-a-known-path-reuses-the-existing-project");
        let first = create_in(&file, "Roer".to_string(), root.clone()).unwrap();
        let second = create_in(&file, "Different name".to_string(), root).unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(second.name, "Roer");
        assert_eq!(list_in(&file).len(), 1);
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn a_project_can_be_renamed() {
        let file = temp_file();
        let root = repo("a-project-can-be-renamed");
        let project = create_in(&file, "one".to_string(), root).unwrap();
        let updated = rename_in(&file, &project.id, "two".to_string())
            .unwrap()
            .expect("project exists");
        assert_eq!(updated.name, "two");
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn renaming_an_unknown_project_is_none() {
        let file = temp_file();
        assert!(rename_in(&file, "missing", "x".to_string()).unwrap().is_none());
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn deleting_a_project_removes_it_from_the_registry() {
        let file = temp_file();
        let root = repo("deleting-a-project-removes-it-from-the-registry");
        let project = create_in(&file, "one".to_string(), root).unwrap();
        delete_in(&file, &project.id).unwrap();
        assert!(list_in(&file).is_empty());
        std::fs::remove_file(&file).ok();
    }
}
