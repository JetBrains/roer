//! Worktrees made for a piece of work: a checkout of its own per task, so
//! that agents running side by side never write over each other.
//!
//! Git is the only record of them. The list is `git worktree list` read
//! afresh each time, so one made or removed in a terminal is no different
//! from one made here, and nothing is left pointing at a folder that has
//! gone. The one thing git has no word for, the branch a worktree's branch
//! was started from, is kept in git's own config as `branch.<name>.roerBase`,
//! which also marks the branch as one Roer made and so may delete with it.
//!
//! Nothing here prunes. A worktree whose folder cannot be seen is listed as
//! `missing` and left alone: it may be on a drive that is only unplugged,
//! and pruning would forget it for good.
//!
//! They live under `~/.roer/worktrees/<repository>/`, outside the checkout:
//! one nested inside it would be walked by every watcher, search and indexer
//! looking at the main checkout, and reported as its changes.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::git::{self, git};
use crate::history::roer_home;

/// The config key, under `branch.<name>`, holding where a branch began.
const BASE_KEY: &str = "roerBase";

/// How long the fetch before a new branch may take. It is only to start
/// from something recent; past this the branch starts from what is here.
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);

/// The file, at the main checkout's root, listing ignored files a fresh
/// worktree should have copies of: `.env` and the like, which no checkout
/// brings with it.
const INCLUDE_FILE: &str = ".worktreeinclude";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    /// `None` when detached.
    pub branch: Option<String>,
    /// The checked-out commit, abbreviated.
    pub commit: String,
    /// The repository's main checkout, which is never removed from here.
    pub main: bool,
    /// What the branch was started from, when Roer started it.
    pub base: Option<String>,
    /// Locked with `git worktree lock`, which `remove` respects.
    pub locked: bool,
    /// Its folder is not there, as git sees it: deleted by hand, or on a
    /// drive that is not mounted. Never pruned from here.
    pub missing: bool,
}

/// Every worktree of the repository `cwd` is in, the main checkout first,
/// ones whose folder is not there marked `missing`.
#[tauri::command(async)]
pub fn worktree_list(cwd: String) -> Result<Vec<Worktree>, String> {
    let repo = git::repo(&cwd)?;
    list(&repo.main)
}

fn list(main: &str) -> Result<Vec<Worktree>, String> {
    let listed = git(main, &["worktree", "list", "--porcelain"])?;
    let bases = bases(main);
    let mut worktrees: Vec<Worktree> = parse_list(&listed);
    for worktree in &mut worktrees {
        worktree.base = worktree.branch.as_ref().and_then(|branch| bases.get(branch).cloned());
    }
    // Git names the main checkout first, except where it names its git dir
    // instead (a submodule's); `repo` knows which checkout that is.
    if let Some(first) = worktrees.first_mut() {
        first.path = main.to_string();
        first.main = true;
    }
    Ok(worktrees)
}

/// `git worktree list --porcelain`: a block per worktree, a blank line
/// between them, `worktree <path>` first in each.
fn parse_list(text: &str) -> Vec<Worktree> {
    let mut out = Vec::new();
    for block in text.split("\n\n") {
        let mut worktree = Worktree {
            path: String::new(),
            branch: None,
            commit: String::new(),
            main: false,
            base: None,
            locked: false,
            missing: false,
        };
        let mut bare = false;
        for line in block.lines() {
            let (key, value) = line.split_once(' ').unwrap_or((line, ""));
            match key {
                "worktree" => worktree.path = value.to_string(),
                "HEAD" => worktree.commit = value.chars().take(7).collect(),
                "branch" => worktree.branch = Some(value.strip_prefix("refs/heads/").unwrap_or(value).to_string()),
                "locked" => worktree.locked = true,
                "prunable" => worktree.missing = true,
                "bare" => bare = true,
                _ => {}
            }
        }
        // Git before 2.31 does not say `prunable`; the folder does.
        worktree.missing |= !worktree.path.is_empty() && !Path::new(&worktree.path).exists();
        // A bare repository's own entry is no checkout to work in.
        if !worktree.path.is_empty() && !bare {
            out.push(worktree);
        }
    }
    out
}

/// Every branch's recorded base, by branch. Git lowercases the key it
/// prints, never the branch name in the middle of it.
fn bases(main: &str) -> std::collections::HashMap<String, String> {
    let key = BASE_KEY.to_lowercase();
    let pattern = format!(r"^branch\..*\.{key}$");
    let Ok(text) = git(main, &["config", "--get-regexp", &pattern]) else {
        return Default::default();
    };
    text.lines()
        .filter_map(|line| {
            let (name, value) = line.split_once(' ')?;
            let branch = name.strip_prefix("branch.")?.strip_suffix(&format!(".{key}"))?;
            Some((branch.to_string(), value.to_string()))
        })
        .collect()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    pub worktree: Worktree,
    /// Whether the branch was already there and is only checked out, rather
    /// than started from `base`.
    pub existing_branch: bool,
    /// What could not be copied in from `.worktreeinclude`, said once each.
    /// The worktree is made all the same.
    pub warnings: Vec<String>,
}

/// A new worktree for `name` in the repository `cwd` is in. Its branch is
/// `name` made into a branch name and started from `base`, the repository's
/// default branch when there is none given. A branch of that name already
/// there is checked out instead, unless some worktree already has it.
#[tauri::command(async)]
pub fn worktree_create(cwd: String, name: String, base: Option<String>) -> Result<Created, String> {
    let repo = git::repo(&cwd)?;
    create(&repo.main, &roer_home().join("worktrees"), &name, base.as_deref())
}

fn create(main: &str, home: &Path, name: &str, base: Option<&str>) -> Result<Created, String> {
    let branch = branch_name(name).ok_or_else(|| "Give the worktree a name.".to_string())?;
    if git(main, &["check-ref-format", "--branch", &branch]).is_err() {
        return Err(format!("\"{branch}\" is not a name git takes for a branch."));
    }
    let existing_branch = git::run(main, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")])
        .is_ok_and(|out| out.status.success());
    if existing_branch {
        if let Some(holder) = list(main)?.into_iter().find(|w| w.branch.as_deref() == Some(branch.as_str())) {
            return Err(format!("{branch} is already checked out in {}.", holder.path));
        }
    }

    let repo_name = Path::new(main).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "repo".into());
    let path = free_folder(&home.join(repo_name), &branch.replace('/', "-"));
    std::fs::create_dir_all(path.parent().unwrap_or(home)).map_err(|e| format!("could not make {}: {e}", home.display()))?;
    let at = path.to_string_lossy().into_owned();

    let mut base_used = None;
    if existing_branch {
        git(main, &["worktree", "add", "--quiet", &at, &branch])?;
    } else {
        let base = match base.map(str::trim).filter(|b| !b.is_empty()) {
            Some(base) => base.to_string(),
            None => git::default_base(main).unwrap_or_else(|| "HEAD".to_string()),
        };
        // Handed to git as an argument, so nothing that reads as an option.
        if base.starts_with('-') || base.contains("/-") {
            return Err(format!("\"{base}\" is not a branch or commit."));
        }
        fetch(main, &base);
        if !git::run(main, &["rev-parse", "--verify", "--quiet", &format!("{base}^{{commit}}")])
            .is_ok_and(|out| out.status.success())
        {
            return Err(format!("There is no branch or commit called \"{base}\" here."));
        }
        // `--no-track`: a branch started from `origin/main` is not one that
        // pushes to `main`. Its upstream comes with its first push.
        git(main, &["worktree", "add", "--quiet", "--no-track", "-b", &branch, &at, &base])?;
        let _ = git(main, &["config", &format!("branch.{branch}.{BASE_KEY}"), &base]);
        base_used = Some(base);
    }

    let warnings = copy_included(Path::new(main), &path);
    let made = git::root(&at)?;
    let commit = git(&made, &["rev-parse", "--short", "HEAD"]).map(|c| c.trim().to_string()).unwrap_or_default();
    Ok(Created {
        worktree: Worktree {
            path: made,
            branch: Some(branch),
            commit,
            main: false,
            base: base_used,
            locked: false,
            missing: false,
        },
        existing_branch,
        warnings,
    })
}

/// Brings a remote base up to date before branching from it, so a new
/// branch does not start from wherever the last fetch left it. Best effort:
/// offline, or slower than [`FETCH_TIMEOUT`], it starts from what is here.
///
/// Nothing may ask a question it cannot be answered here. Git's own prompt
/// is off already; ssh's passphrase or host-key question is turned off too
/// with `BatchMode`, unless the repository or the environment says how to
/// run ssh, which is then theirs to get right, and the timeout still holds.
fn fetch(main: &str, base: &str) {
    let Some((remote, branch)) = base.split_once('/') else { return };
    let remotes = git(main, &["remote"]).unwrap_or_default();
    if !remotes.lines().any(|r| r.trim() == remote) {
        return;
    }
    let mut command = git::command(main, &["fetch", "--quiet", remote, branch]);
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let configured = git(main, &["config", "core.sshCommand"]).is_ok_and(|c| !c.trim().is_empty());
    if !configured && std::env::var_os("GIT_SSH_COMMAND").is_none() && std::env::var_os("GIT_SSH").is_none() {
        command.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
    let _ = finish_within(command, FETCH_TIMEOUT);
}

/// Runs `command` and waits for it, at most `limit`: past that it is killed
/// and `false` is the answer, as it is when it fails.
fn finish_within(mut command: std::process::Command, limit: Duration) -> bool {
    let Ok(mut child) = command.spawn() else { return false };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if started.elapsed() < limit => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

/// `name` as a branch: lowercase, words joined by `-`, `/` kept so that
/// `fix/login` stays a namespaced branch. `None` with nothing left.
fn branch_name(name: &str) -> Option<String> {
    let mapped: String = name
        .chars()
        .map(|c| c.to_ascii_lowercase())
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '.') { c } else { '-' })
        .collect();
    // A run of separators typed is one in the name, and none at either end
    // of a part between slashes, where git would refuse them anyway.
    let parts: Vec<String> = mapped
        .split('/')
        .map(|part| {
            let mut out = String::new();
            for c in part.chars() {
                if matches!(c, '-' | '.') && out.ends_with(['-', '.']) {
                    continue;
                }
                out.push(c);
            }
            out.trim_matches(['-', '.']).to_string()
        })
        .filter(|part| !part.is_empty())
        .collect();
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// `dir/name`, or `dir/name-2` and on when that is taken.
fn free_folder(dir: &Path, name: &str) -> PathBuf {
    let mut path = dir.join(name);
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{name}-{n}"));
        n += 1;
    }
    path
}

/// Copies what `.worktreeinclude` lists from the main checkout into a new
/// worktree. A path the worktree already has is left alone, so a tracked
/// file listed by mistake is never overwritten, and one missing from the
/// main checkout is passed over without a word: not everyone has every
/// `.env`. Only literal paths are taken; a pattern is said to be skipped.
fn copy_included(main: &Path, worktree: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(main.join(INCLUDE_FILE)) else {
        return Vec::new();
    };
    let mut warnings = Vec::new();
    for line in text.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let entry = line.trim_end_matches('/');
        let literal = !entry.contains(['*', '?', '[', '!'])
            && !Path::new(entry).is_absolute()
            && !Path::new(entry).components().any(|c| matches!(c, std::path::Component::ParentDir));
        if !literal {
            warnings.push(format!("{INCLUDE_FILE}: skipped \"{line}\", only plain paths inside the checkout are copied."));
            continue;
        }
        let from = main.join(entry);
        let to = worktree.join(entry);
        if std::fs::symlink_metadata(&from).is_err() || std::fs::symlink_metadata(&to).is_ok() {
            continue;
        }
        if let Err(e) = copy_tree(&from, &to) {
            warnings.push(format!("could not copy {entry}: {e}"));
        }
    }
    warnings
}

/// A file, a folder with everything in it, or a symlink as a symlink. On
/// macOS `fs::copy` clones on APFS, so even a `node_modules` costs next to
/// nothing until one side changes it.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let meta = std::fs::symlink_metadata(from)?;
    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(from)?;
        #[cfg(unix)]
        return std::os::unix::fs::symlink(target, to);
        #[cfg(windows)]
        return if from.is_dir() {
            std::os::windows::fs::symlink_dir(target, to)
        } else {
            std::os::windows::fs::symlink_file(target, to)
        };
    }
    if meta.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        return Ok(());
    }
    std::fs::copy(from, to).map(|_| ())
}

/// How a removal went. A worktree with work in it is not removed unless
/// asked again with `force`, and the caller is told what would be lost.
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Removal {
    #[serde(rename_all = "camelCase")]
    Removed {
        /// The branch Roer made for it, deleted with it.
        deleted_branch: Option<String>,
        /// That branch, kept: it has commits nothing else has. Deleting it
        /// anyway is [`worktree_delete_branch`], once someone says so.
        unmerged_branch: Option<String>,
    },
    /// Uncommitted and untracked files, as `git status` lists them.
    Dirty { files: Vec<String> },
}

/// What removing the worktree at `path` would lose: its uncommitted and
/// untracked files, so that one question can say so before anything is
/// done, its sessions ended included.
#[tauri::command(async)]
pub fn worktree_uncommitted(path: String) -> Result<Vec<String>, String> {
    let repo = git::repo(&path)?;
    uncommitted(&repo.root)
}

fn uncommitted(root: &str) -> Result<Vec<String>, String> {
    let status = git(root, &["status", "--porcelain", "-z", "--untracked-files=all"])?;
    let mut files = Vec::new();
    let mut records = status.split('\0').filter(|record| !record.is_empty());
    while let Some(record) = records.next() {
        let Some(file) = record.get(3..) else { continue };
        files.push(file.to_string());
        // A rename or copy is followed by the path it came from.
        if record.starts_with(['R', 'C']) {
            records.next();
        }
    }
    Ok(files)
}

/// Removes the linked worktree at `path`, and the branch Roer made for it
/// if that is merged. A branch it did not make is left alone: a worktree
/// opened onto someone's own branch says nothing about wanting it gone.
#[tauri::command(async)]
pub fn worktree_remove(path: String, force: bool) -> Result<Removal, String> {
    let repo = git::repo(&path)?;
    remove(&repo.main, &repo.root, force)
}

fn remove(main: &str, root: &str, force: bool) -> Result<Removal, String> {
    if root == main {
        return Err("This is the repository's main checkout, not a worktree to remove.".to_string());
    }
    if !force {
        let files = uncommitted(root)?;
        if !files.is_empty() {
            return Ok(Removal::Dirty { files });
        }
    }
    let branch = list(main)?.into_iter().find(|w| w.path == root).and_then(|w| w.branch.zip(w.base)).map(|(b, _)| b);
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(root);
    git(main, &args)?;
    let Some(branch) = branch else {
        return Ok(Removal::Removed { deleted_branch: None, unmerged_branch: None });
    };
    // `-d` refuses a branch whose commits are on nothing else, which is the
    // one case worth asking about.
    Ok(match git(main, &["branch", "--quiet", "-d", &branch]) {
        Ok(_) => Removal::Removed { deleted_branch: Some(branch), unmerged_branch: None },
        Err(_) => Removal::Removed { deleted_branch: None, unmerged_branch: Some(branch) },
    })
}

/// Deletes a branch whatever it holds, for the branch [`worktree_remove`]
/// kept, once the person has said its commits can go. Never a branch some
/// worktree still has checked out: git refuses that itself.
#[tauri::command(async)]
pub fn worktree_delete_branch(cwd: String, branch: String) -> Result<(), String> {
    let repo = git::repo(&cwd)?;
    git(&repo.main, &["branch", "--quiet", "-D", &branch]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{canonical, commit, init, must, scratch, write};

    /// A repository with one commit on `main`, and a folder of its own for
    /// worktrees, by the paths git reports.
    fn setup(name: &str) -> (String, PathBuf) {
        let dir = scratch(name);
        let main = dir.join("repo");
        std::fs::create_dir_all(&main).unwrap();
        let main = canonical(&main);
        init(&main);
        write(Path::new(&main), "README.md", "hello\n");
        write(Path::new(&main), ".gitignore", ".env\nnode_modules/\n");
        must(&main, &["add", "."]);
        commit(&main, "first");
        (main, PathBuf::from(canonical(&dir)).join("worktrees"))
    }

    #[test]
    fn a_name_becomes_a_branch_name() {
        assert_eq!(branch_name("Fix the login page!").as_deref(), Some("fix-the-login-page"));
        assert_eq!(branch_name("fix//Login  -- flow").as_deref(), Some("fix/login-flow"));
        assert_eq!(branch_name("  ...  ").as_deref(), None);
        assert_eq!(branch_name("Café au lait").as_deref(), Some("caf-au-lait"));
    }

    #[test]
    fn a_created_worktree_is_listed_with_its_base() {
        let (main, home) = setup("a-created-worktree-is-listed-with-its-base");
        let created = create(&main, &home, "Add search", None).unwrap();
        assert_eq!(created.worktree.branch.as_deref(), Some("add-search"));
        assert!(created.worktree.path.ends_with("/repo/add-search"), "{}", created.worktree.path);
        assert!(!created.existing_branch);

        let listed = list(&main).unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed[0].main);
        assert_eq!(listed[0].path, main);
        assert_eq!(listed[1].path, created.worktree.path);
        assert_eq!(listed[1].base.as_deref(), Some("main"));
    }

    #[test]
    fn a_taken_folder_gets_a_number() {
        let (main, home) = setup("a-taken-folder-gets-a-number");
        std::fs::create_dir_all(home.join("repo/task")).unwrap();
        let created = create(&main, &home, "task", None).unwrap();
        assert!(created.worktree.path.ends_with("/repo/task-2"), "{}", created.worktree.path);
    }

    #[test]
    fn an_existing_branch_is_checked_out_not_started_again() {
        let (main, home) = setup("an-existing-branch-is-checked-out-not-started-again");
        must(&main, &["branch", "old-work"]);
        let created = create(&main, &home, "old-work", None).unwrap();
        assert!(created.existing_branch);
        assert_eq!(created.worktree.base, None);
        // And not twice.
        let again = create(&main, &home, "old-work", None).unwrap_err();
        assert!(again.contains("already checked out"), "{again}");
    }

    #[test]
    fn included_files_are_copied_and_patterns_are_not() {
        let (main, home) = setup("included-files-are-copied-and-patterns-are-not");
        write(Path::new(&main), ".env", "SECRET=1\n");
        write(Path::new(&main), "node_modules/pkg/index.js", "x\n");
        write(Path::new(&main), INCLUDE_FILE, "# local setup\n.env\nnode_modules/\n.env.missing\n*.local\nREADME.md\n");
        write(Path::new(&main), "README.md", "changed here only\n");
        let created = create(&main, &home, "copy", None).unwrap();
        let at = Path::new(&created.worktree.path);
        assert_eq!(std::fs::read_to_string(at.join(".env")).unwrap(), "SECRET=1\n");
        assert_eq!(std::fs::read_to_string(at.join("node_modules/pkg/index.js")).unwrap(), "x\n");
        // The checkout's own file wins over the main checkout's edit of it.
        assert_eq!(std::fs::read_to_string(at.join("README.md")).unwrap(), "hello\n");
        assert_eq!(created.warnings.len(), 1, "{:?}", created.warnings);
        assert!(created.warnings[0].contains("*.local"));
    }

    #[test]
    fn removing_a_clean_worktree_deletes_its_merged_branch() {
        let (main, home) = setup("removing-a-clean-worktree-deletes-its-merged-branch");
        let created = create(&main, &home, "done", None).unwrap();
        let removal = remove(&main, &created.worktree.path, false).unwrap();
        assert_eq!(removal, Removal::Removed { deleted_branch: Some("done".into()), unmerged_branch: None });
        assert!(!Path::new(&created.worktree.path).exists());
        assert_eq!(list(&main).unwrap().len(), 1);
    }

    #[test]
    fn a_dirty_worktree_is_kept_until_forced() {
        let (main, home) = setup("a-dirty-worktree-is-kept-until-forced");
        let created = create(&main, &home, "wip", None).unwrap();
        write(Path::new(&created.worktree.path), "new.txt", "draft\n");
        let removal = remove(&main, &created.worktree.path, false).unwrap();
        assert_eq!(removal, Removal::Dirty { files: vec!["new.txt".into()] });
        assert!(Path::new(&created.worktree.path).exists());
        assert!(matches!(remove(&main, &created.worktree.path, true).unwrap(), Removal::Removed { .. }));
        assert!(!Path::new(&created.worktree.path).exists());
    }

    #[test]
    fn an_unmerged_branch_is_kept_and_named() {
        let (main, home) = setup("an-unmerged-branch-is-kept-and-named");
        let created = create(&main, &home, "feature", None).unwrap();
        let at = created.worktree.path.clone();
        write(Path::new(&at), "feature.txt", "new\n");
        must(&at, &["add", "."]);
        commit(&at, "feature");
        let removal = remove(&main, &at, false).unwrap();
        assert_eq!(removal, Removal::Removed { deleted_branch: None, unmerged_branch: Some("feature".into()) });
        worktree_delete_branch(main.clone(), "feature".into()).unwrap();
        assert!(git(&main, &["rev-parse", "--verify", "--quiet", "refs/heads/feature"]).is_err());
    }

    #[test]
    fn a_branch_roer_did_not_make_survives_its_worktree() {
        let (main, home) = setup("a-branch-roer-did-not-make-survives-its-worktree");
        must(&main, &["branch", "mine"]);
        let created = create(&main, &home, "mine", None).unwrap();
        let removal = remove(&main, &created.worktree.path, false).unwrap();
        assert_eq!(removal, Removal::Removed { deleted_branch: None, unmerged_branch: None });
        assert!(git(&main, &["rev-parse", "--verify", "--quiet", "refs/heads/mine"]).is_ok());
    }

    #[test]
    fn the_main_checkout_is_not_removed() {
        let (main, _) = setup("the-main-checkout-is-not-removed");
        assert!(remove(&main, &main, true).is_err());
    }

    #[test]
    fn a_folder_that_is_not_there_is_listed_missing_not_pruned() {
        let (main, home) = setup("a-folder-that-is-not-there-is-listed-missing-not-pruned");
        let created = create(&main, &home, "gone", None).unwrap();
        std::fs::remove_dir_all(&created.worktree.path).unwrap();
        let listed = list(&main).unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed[1].missing);
        // Git still has it: it would be back as it was once the folder is.
        assert!(git(&main, &["worktree", "list"]).unwrap().contains("gone"));
    }

    #[test]
    fn a_base_that_reads_as_an_option_or_names_nothing_is_refused() {
        let (main, home) = setup("a-base-that-reads-as-an-option-or-names-nothing-is-refused");
        for base in ["--orphan", "origin/--upload-pack=touch /tmp/x"] {
            let refused = create(&main, &home, "task", Some(base)).unwrap_err();
            assert!(refused.contains("not a branch or commit"), "{refused}");
        }
        let missing = create(&main, &home, "task", Some("no-such-branch")).unwrap_err();
        assert!(missing.contains("no branch or commit called"), "{missing}");
        // Nothing was made for any of them.
        assert_eq!(list(&main).unwrap().len(), 1);
    }

    #[test]
    fn what_a_removal_would_lose_is_listed_first() {
        let (main, home) = setup("what-a-removal-would-lose-is-listed-first");
        let created = create(&main, &home, "wip", None).unwrap();
        assert!(uncommitted(&created.worktree.path).unwrap().is_empty());
        write(Path::new(&created.worktree.path), "draft.md", "x\n");
        write(Path::new(&created.worktree.path), "README.md", "changed\n");
        let mut files = uncommitted(&created.worktree.path).unwrap();
        files.sort();
        assert_eq!(files, vec!["README.md", "draft.md"]);
    }

    #[test]
    fn a_command_past_its_time_is_stopped() {
        let mut slow = crate::process::command(if cfg!(windows) { "ping" } else { "sleep" });
        slow.args(if cfg!(windows) { vec!["-n", "10", "127.0.0.1"] } else { vec!["10"] });
        slow.stdout(Stdio::null());
        let started = Instant::now();
        assert!(!finish_within(slow, Duration::from_millis(300)));
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
