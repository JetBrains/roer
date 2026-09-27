//! A directory listing for `roer-server`'s folder picker.
//!
//! The native app gets a real OS folder picker from
//! `@tauri-apps/plugin-dialog`; a browser tab has nothing like it — the File
//! System Access API hands back an opaque handle, never the absolute path
//! the backend needs to open a project. This is the browser's substitute: a
//! bare listing of one directory's subdirectories, which the frontend turns
//! into a breadcrumb-and-list dialog.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<DirEntry>,
}

/// Subdirectories of `path` (or of `$HOME` when `path` is absent), sorted by
/// name, dotfiles excluded — the same clutter a native picker hides.
pub(crate) fn list_dir(path: Option<String>) -> Result<DirListing, String> {
    let dir = match path.filter(|p| !p.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => crate::roer::home().ok_or("no home directory")?,
    };
    let dir = dir
        .canonicalize()
        .map_err(|e| format!("could not open {}: {e}", dir.display()))?;
    if !dir.is_dir() {
        return Err(format!("{} is not a directory", dir.display()));
    }

    let mut entries: Vec<DirEntry> = fs::read_dir(&dir)
        .map_err(|e| format!("could not read {}: {e}", dir.display()))?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                return None;
            }
            Some(DirEntry { name, path: entry.path().to_string_lossy().into_owned() })
        })
        .collect();
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    let parent = parent_of(&dir);
    Ok(DirListing { path: dir.to_string_lossy().into_owned(), parent, entries })
}

fn parent_of(dir: &Path) -> Option<String> {
    dir.parent()
        .filter(|p| *p != dir)
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("roer-browse-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lists_subdirectories_but_not_files() {
        let root = tmp("dirs-not-files");
        fs::create_dir(root.join("b")).unwrap();
        fs::create_dir(root.join("a")).unwrap();
        fs::write(root.join("readme.txt"), "hi").unwrap();

        let listing = list_dir(Some(root.to_string_lossy().into_owned())).unwrap();
        let names: Vec<_> = listing.entries.iter().map(|e| e.name.clone()).collect();
        assert_eq!(names, ["a", "b"]);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn hides_dotfiles() {
        let root = tmp("dotfiles");
        fs::create_dir(root.join(".git")).unwrap();
        fs::create_dir(root.join("src")).unwrap();

        let listing = list_dir(Some(root.to_string_lossy().into_owned())).unwrap();
        let names: Vec<_> = listing.entries.iter().map(|e| e.name.clone()).collect();
        assert_eq!(names, ["src"]);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn reports_no_parent_at_the_filesystem_root() {
        let listing = list_dir(Some("/".to_string())).unwrap();
        assert_eq!(listing.parent, None);
    }

    #[test]
    fn falls_back_to_home_when_no_path_is_given() {
        let listing = list_dir(None).unwrap();
        assert_eq!(listing.path, crate::roer::home().unwrap().to_string_lossy());
    }

    #[test]
    fn rejects_a_path_that_is_a_file_not_a_directory() {
        let root = tmp("not-a-dir");
        let file = root.join("x.txt");
        fs::write(&file, "hi").unwrap();

        assert!(list_dir(Some(file.to_string_lossy().into_owned())).is_err());

        fs::remove_dir_all(&root).unwrap();
    }
}
