//! Local changes for the session's own repository.
//!
//! Two calls and no state: the tree asks for every changed file at once, and
//! the pane on the right asks for one file's diff when it is selected. Both
//! shell out to `git`, because a libgit2 binding would have to be taught the
//! same rules and would still be wrong about the index.
//!
//! Porcelain v2 is the only status format with a documented, stable contract,
//! and it is the only one that reports the index and the worktree separately —
//! which is the difference between "staged" and "not staged" on screen. It is
//! read NUL-delimited: a path may hold anything but NUL, and the line form
//! escapes such a path into a spelling that cannot be diffed.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use serde::Serialize;

/// An untracked file is read from disk to count its lines. Anything larger is
/// listed without counts rather than pulled into memory.
const MAX_COUNT_BYTES: u64 = 2 * 1024 * 1024;

/// Enough of a file to tell text from binary. Git uses the same trick.
pub(crate) const SNIFF_BYTES: usize = 8000;

/// A diff long enough to stall the renderer is cut short instead. Git is
/// stopped at that point rather than read to the end first, so a generated
/// file costs a screenful of memory and not its whole size.
const MAX_DIFF_BYTES: usize = 400_000;

/// A diff is for reading, not for running. Both of these hand the work to a
/// command of the repository's choosing, which does not belong in a viewer —
/// and an external driver's output would not parse as a diff anyway.
const NO_DRIVERS: [&str; 2] = ["--no-ext-diff", "--no-textconv"];

/// One changed file. `staged` and `unstaged` are the two status letters of
/// porcelain v2, kept apart so the UI can say which side a change is on;
/// `.` means that side is unchanged.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// Repo-relative and slash-separated, so it groups into a tree directly
    /// and can be handed straight back to [`git_diff`].
    pub path: String,
    pub staged: String,
    pub unstaged: String,
    pub added: u32,
    pub deleted: u32,
    /// Where a renamed file came from, so the row can show the move.
    pub renamed_from: Option<String>,
    /// No line counts to show, and no diff worth rendering.
    pub binary: bool,
    /// Whether `added` and `deleted` are counts at all. A file too large to
    /// read, or a submodule, has none, and the row then shows no counts
    /// instead of claiming zero.
    pub counted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    /// The worktree root. Every path is relative to it, and it is what the
    /// frontend passes back when asking for a diff.
    pub root: String,
    /// `(detached)` when there is no branch, which is what git itself reports.
    pub branch: String,
    /// The checked-out commit, abbreviated: what names a detached checkout.
    /// Empty before the first commit.
    pub commit: String,
    pub files: Vec<FileChange>,
}

/// Git, told not to interact: a prompt would hang the app with nowhere to
/// type, and the optional index refresh takes a lock that a terminal session
/// in the same repo may be holding.
pub(crate) fn command(dir: &str, args: &[&str]) -> Command {
    let mut git = crate::process::command("git");
    git.arg("-C")
        .arg(dir)
        // Without this git escapes any non-ASCII path, and the escaped name
        // is not a path that can be diffed.
        .args(["-c", "core.quotePath=false"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0");
    git
}

pub(crate) fn run(dir: &str, args: &[&str]) -> Result<Output, String> {
    command(dir, args)
        .output()
        .map_err(|e| format!("could not run git: {e}"))
}

/// What git said when it was fed something on standard input.
pub(crate) struct Fed {
    pub stdout: String,
    pub stderr: String,
    /// Git's exit code, which for some commands is an answer rather than a
    /// failure: `check-ignore` exits 1 to say "none of these are ignored".
    pub code: Option<i32>,
}

/// Runs git with `input` on its standard input.
///
/// Separate from [`run`] for two reasons `git check-ignore --stdin` supplies
/// both of. It wants a pipe on stdin, and `output()` does not open one — it
/// nulls it. And its exit 1 is an answer, not a failure, so the code is
/// handed back instead of being turned into an error the way [`git`] does.
///
/// The write goes on a thread of its own because git is writing its answer
/// while we are still writing the question: a batch larger than the 64 KB
/// pipe buffer deadlocks the moment each side is waiting for the other to
/// drain.
pub(crate) fn feed(dir: &str, args: &[&str], input: String) -> Result<Fed, String> {
    let mut child = command(dir, args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run git: {e}"))?;

    // Moved into the thread, so the pipe closes — and git sees the end of
    // its input — when the write is done.
    let mut pipe = child.stdin.take().expect("stdin is a pipe");
    let writer = std::thread::spawn(move || pipe.write_all(input.as_bytes()));

    let out = child
        .wait_with_output()
        .map_err(|e| format!("could not wait for git: {e}"))?;
    // Joined after the wait and its result dropped: a broken pipe here is
    // git having stopped reading, which its own exit code says more about
    // than the failed write does.
    let _ = writer.join();

    Ok(Fed {
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        code: out.status.code(),
    })
}

/// Output of a git command read only up to `limit` bytes.
struct Bounded {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    success: bool,
    /// Git had more to say and was stopped.
    truncated: bool,
}

/// Runs git and stops it once it has produced more than `limit` bytes.
/// [`Output`] would buffer the whole thing first, which for a generated or
/// minified file is however many megabytes git feels like printing.
fn run_bounded(dir: &str, args: &[&str], limit: usize) -> Result<Bounded, String> {
    bounded(command(dir, args), limit)
}

/// [`run_bounded`], for a git command set up by hand: one with an environment of its own, say.
fn bounded(mut command: Command, limit: usize) -> Result<Bounded, String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run git: {e}"))?;

    // One byte past the limit is what tells a diff that ends exactly there
    // from one that goes on.
    let mut pipe = child.stdout.take().expect("stdout is a pipe");
    let mut stdout = Vec::new();
    let read = pipe
        .by_ref()
        .take(limit as u64 + 1)
        .read_to_end(&mut stdout);
    let truncated = stdout.len() > limit;
    if truncated {
        // Git is blocked writing into a pipe nobody will drain; killing it is
        // what ends it.
        let _ = child.kill();
    }
    drop(pipe);

    // `wait_with_output` reaps the child and drains stderr, which is a pipe
    // of its own and would otherwise be a second way to block.
    let rest = child
        .wait_with_output()
        .map_err(|e| format!("could not wait for git: {e}"))?;
    read.map_err(|e| format!("could not read from git: {e}"))?;

    Ok(Bounded {
        stdout,
        stderr: rest.stderr,
        success: rest.status.success(),
        truncated,
    })
}

/// `path` as a pathspec that means exactly itself.
///
/// Git reads a bare pathspec as a glob, so a directory really named `a[1]`
/// would be taken for a character class and match nothing. `:(literal)`
/// turns that off; a directory still matches everything under it.
pub(crate) fn literal(path: &str) -> String {
    format!(":(literal){path}")
}

/// Standard output of a git command that is expected to succeed.
pub(crate) fn git(dir: &str, args: &[&str]) -> Result<String, String> {
    let out = run(dir, args)?;
    if !out.status.success() {
        let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let what = args.join(" ");
        return Err(if why.is_empty() {
            format!("`git {what}` failed")
        } else {
            why
        });
    }
    // Not `from_utf8_lossy(..).into_owned()`: the `Cow` it hands back for
    // valid UTF-8 — which is all but a vanishing minority of git output — is
    // borrowed, so `into_owned` copies the whole of stdout a second time. For
    // the file listing of a big repo that is another 123 MB. Taking the
    // bytes converts in place, and the lossy path is kept for output that
    // really does hold something invalid.
    Ok(match String::from_utf8(out.stdout) {
        Ok(text) => text,
        Err(bad) => String::from_utf8_lossy(bad.as_bytes()).into_owned(),
    })
}

/// Whether the repository has a commit yet. A fresh `git init` has none, and
/// every diff against `HEAD` fails there.
fn has_head(root: &str) -> bool {
    run(root, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .map(|out| out.status.success())
        .unwrap_or(false)
}

/// The id of the empty tree, in whatever hash algorithm this repository uses.
/// `hash-object` computes it and writes nothing.
fn empty_tree(root: &str) -> Result<String, String> {
    Ok(git(root, &["hash-object", "-t", "tree", "/dev/null"])?
        .trim()
        .to_string())
}

/// The worktree root holding `cwd`, in git's own spelling of it.
///
/// Not `git()`: git's own wording names `.git` and the walk up the parents,
/// which reads as something broken. A session simply being outside a
/// repository is the ordinary case here.
pub(crate) fn root(cwd: &str) -> Result<String, String> {
    if cwd.is_empty() {
        return Err("no directory for this session".to_string());
    }
    let out = run(cwd, &["rev-parse", "--show-toplevel"])?;
    let root = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || root.is_empty() {
        return Err(format!("{cwd} is not in a git repository."));
    }
    Ok(root)
}

/// The git root for a session's directory, for grouping sessions by
/// repository in the sidebar. `None` outside a repository, so the sidebar
/// can fall back to the directory itself as its own group.
#[tauri::command]
pub fn git_root(cwd: String) -> Option<String> {
    root(&cwd).ok()
}

/// Where a directory sits among a repository's worktrees.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    /// The checkout the directory is in: a worktree's own folder.
    pub root: String,
    /// The repository's main checkout, the same for all its worktrees.
    pub main: String,
    /// Every worktree of the repository, the main checkout first.
    pub worktrees: Vec<String>,
}

/// Which repository a directory is in, whichever worktree of it: a session
/// in a linked worktree belongs to the project as much as one in the main
/// checkout. `None` outside a repository.
#[tauri::command(async)]
pub fn git_repo(cwd: String) -> Option<Repo> {
    repo(&cwd).ok()
}

fn repo(cwd: &str) -> Result<Repo, String> {
    let root = root(cwd)?;
    let dirs = git(&root, &["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])?;
    let mut dirs = dirs.lines().map(str::trim);
    let (own, common) = (dirs.next().unwrap_or_default(), dirs.next().unwrap_or_default());
    let listed = git(&root, &["worktree", "list", "--porcelain"]).unwrap_or_default();
    let mut worktrees: Vec<String> = listed
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
        .map(str::to_string)
        .collect();
    // A checkout whose git dir is the repository's own is the main one, its
    // git dir wherever it is: a submodule's lives in its superproject's
    // `.git/modules`, one made with `--separate-git-dir` anywhere at all,
    // and git's list then names that dir in place of the checkout. A linked
    // worktree goes by the list, or else by the common dir, which is
    // `<main>/.git` in the usual layout and a bare repository itself. Where
    // the list names the git dir, a submodule's says in `core.worktree`
    // which checkout is its own; a `--separate-git-dir` one says nowhere.
    let main = if own == common {
        match worktrees.first_mut() {
            Some(first) => *first = root.clone(),
            None => worktrees.push(root.clone()),
        }
        root.clone()
    } else if let Some(first) = worktrees.first_mut() {
        if *first == common {
            if let Some(checkout) = recorded_checkout(&root, common) {
                *first = checkout;
            }
        }
        first.clone()
    } else {
        let common = Path::new(common);
        let main = if common.file_name().is_some_and(|name| name == ".git") {
            common.parent().unwrap_or(common)
        } else {
            common
        };
        main.to_string_lossy().into_owned()
    };
    Ok(Repo { root, main, worktrees })
}

/// The checkout a git dir names as its own in `core.worktree`, relative to
/// the git dir as git reads it. A submodule's has one. Spelled as git
/// spells its own paths, which `canonicalize` on Windows does not.
fn recorded_checkout(root: &str, common: &str) -> Option<String> {
    let config = Path::new(common).join("config");
    let recorded = git(root, &["config", "--file", &config.to_string_lossy(), "core.worktree"]).ok()?;
    self::root(&Path::new(common).join(recorded.trim()).to_string_lossy()).ok()
}

/// Every local branch, for the branch-diff view's two pickers.
#[tauri::command(async)]
pub fn git_branches(cwd: String) -> Result<Vec<String>, String> {
    let root = root(&cwd)?;
    branches(&root)
}

fn branches(root: &str) -> Result<Vec<String>, String> {
    let out = git(root, &["branch", "--format=%(refname:short)"])?;
    Ok(out.lines().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect())
}

/// The session's own branch, the sensible default for "which branch". Empty
/// when detached, which is not a branch a diff view can be about.
#[tauri::command(async)]
pub fn git_current_branch(cwd: String) -> Result<String, String> {
    let root = root(&cwd)?;
    Ok(git(&root, &["branch", "--show-current"])?.trim().to_string())
}

/// Where the current branch stands against the branch it pushes to. `None`
/// upstream means it has never been pushed, which is the usual state of a
/// branch about to become a pull request.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Upstream {
    pub upstream: Option<String>,
    /// Commits here that the upstream does not have yet.
    pub ahead: u32,
    pub behind: u32,
}

#[tauri::command(async)]
pub fn git_upstream_status(cwd: String) -> Result<Upstream, String> {
    let root = root(&cwd)?;
    upstream_status(&root)
}

pub(crate) fn upstream_status(root: &str) -> Result<Upstream, String> {
    let out = run(root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])?;
    if !out.status.success() {
        return Ok(Upstream { upstream: None, ahead: 0, behind: 0 });
    }
    let upstream = String::from_utf8_lossy(&out.stdout).trim().to_string();
    // `@{u}...HEAD` with --left-right counts each side of the symmetric
    // difference: behind on the left, ahead on the right.
    let counts = git(root, &["rev-list", "--left-right", "--count", "@{u}...HEAD"])?;
    let mut sides = counts.split_whitespace().map(|n| n.parse::<u32>().unwrap_or(0));
    let behind = sides.next().unwrap_or(0);
    let ahead = sides.next().unwrap_or(0);
    Ok(Upstream { upstream: Some(upstream), ahead, behind })
}

/// Publishes the current branch to `origin` and makes it the upstream, if it
/// is not already there. Nothing is forced: a rejected push is reported as
/// git's own complaint, for the person to sort out.
pub(crate) fn push_upstream(root: &str) -> Result<(), String> {
    let status = upstream_status(root)?;
    if status.upstream.is_some() && status.ahead == 0 {
        return Ok(());
    }
    git(root, &["push", "--quiet", "-u", "origin", "HEAD"]).map(|_| ())
}

/// Commits everything the worktree has changed, new files included, with
/// `message`, hooks and all, and hands back the new commit's short hash. A
/// hook that refuses is git's answer, passed on whole; what was staged stays
/// staged, as it would after a `git commit` in a terminal.
#[tauri::command(async)]
pub fn git_commit_all(cwd: String, message: String) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("A commit needs a message.".to_string());
    }
    let root = root(&cwd)?;
    git(&root, &["add", "--all"])?;
    let fed = feed(&root, &["commit", "--file", "-", "--cleanup=strip"], message)?;
    if fed.code != Some(0) {
        let said: Vec<&str> = [fed.stderr.trim(), fed.stdout.trim()].into_iter().filter(|s| !s.is_empty()).collect();
        return Err(if said.is_empty() { "git commit failed".to_string() } else { said.join("\n") });
    }
    Ok(git(&root, &["rev-parse", "--short", "HEAD"])?.trim().to_string())
}

/// Pushes a branch that need not be checked out, under its own name, and makes
/// origin's copy its upstream. Nothing to send is not an error.
pub(crate) fn push_branch(root: &str, branch: &str) -> Result<(), String> {
    git(root, &["push", "--quiet", "-u", "origin", &format!("refs/heads/{branch}:refs/heads/{branch}")]).map(|_| ())
}

/// One commit, as much as the branch-diff view names it by.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub short: String,
    pub author: String,
    /// Unix seconds, author date.
    pub date: i64,
    pub subject: String,
    /// The rest of the message, after the subject; empty when there is none.
    pub body: String,
}

/// Record separator between `git log` entries: a message body spans lines,
/// so a line is no longer one commit.
const RECORD_SEP: char = '\x1e';

/// Field separator within one `git log` record. `\x1f` (unit separator)
/// rather than a tab or comma: nothing a person types ever contains it, so a
/// commit message can hold either without breaking the split.
const FIELD_SEP: &str = "\x1f";

/// Every commit `branch` has that `base` does not, oldest first — the order
/// a reviewer steps through them in, not the order `git log` prints by
/// default.
#[tauri::command(async)]
pub fn git_branch_commits(root: String, branch: String, base: String) -> Result<Vec<Commit>, String> {
    branch_commits(&root, &branch, &base)
}

fn branch_commits(root: &str, branch: &str, base: &str) -> Result<Vec<Commit>, String> {
    let format = format!("%H{FIELD_SEP}%h{FIELD_SEP}%an{FIELD_SEP}%at{FIELD_SEP}%s{FIELD_SEP}%b{RECORD_SEP}");
    let range = format!("{base}..{branch}");
    let out = git(root, &["log", "--reverse", &format!("--format={format}"), &range])?;
    Ok(out.split(RECORD_SEP).map(str::trim).filter(|record| !record.is_empty()).filter_map(parse_commit).collect())
}

fn parse_commit(record: &str) -> Option<Commit> {
    let mut fields = record.splitn(6, FIELD_SEP);
    Some(Commit {
        hash: fields.next()?.to_string(),
        short: fields.next()?.to_string(),
        author: fields.next()?.to_string(),
        date: fields.next()?.parse().ok()?,
        subject: fields.next()?.to_string(),
        body: fields.next().unwrap_or_default().trim().to_string(),
    })
}

/// `commit`'s parent, or the empty tree for a root commit — the other side
/// of what `git show` would diff it against.
fn commit_parent(root: &str, commit: &str) -> Result<String, String> {
    let out = run(root, &["rev-parse", "--verify", "--quiet", &format!("{commit}^")])?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        empty_tree(root)
    }
}

/// The files one commit touched, diffed against its own parent — what
/// stepping to that commit in the branch-diff view shows, independent of
/// which base branch the commit range was picked against.
#[tauri::command(async)]
pub fn git_commit_files(root: String, commit: String) -> Result<Vec<FileChange>, String> {
    commit_files(&root, &commit)
}

fn commit_files(root: &str, commit: &str) -> Result<Vec<FileChange>, String> {
    let parent = commit_parent(root, commit)?;
    diff_files(root, &parent, commit)
}

/// One commit's unified diff of a single file, against its own parent.
#[tauri::command(async)]
pub fn git_commit_diff(root: String, commit: String, path: String) -> Result<String, String> {
    let parent = commit_parent(&root, &commit)?;
    let spec = literal(&path);
    let mut args = vec!["diff", "--no-color"];
    args.extend(NO_DRIVERS);
    args.extend(["-M", parent.as_str(), commit.as_str(), "--", spec.as_str()]);
    let out = run_bounded(&root, &args, MAX_DIFF_BYTES)?;

    if !out.success {
        let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if why.is_empty() {
            format!("could not diff {path}")
        } else {
            why
        });
    }

    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    Ok(cap(text, out.truncated))
}

/// Everything a branch has changed since it left its base, as one patch: its
/// commits and whatever is not committed yet, untracked files included. What
/// its pull request will show once it is pushed, before there is one.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BranchDiff {
    pub root: String,
    /// The branch it is compared with, e.g. `origin/main`. Empty when there
    /// is none, and then the patch is only what is uncommitted.
    pub base: String,
    /// Commits the branch has over its base.
    pub commits: u32,
    pub diff: String,
    /// Why the patch is less than asked for, for the tab to say: no common
    /// ancestor with the base (a shallow clone, an orphan branch), so it is
    /// only what is uncommitted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// `base`, when given, is the branch to compare with (a pull request's base);
/// otherwise the repository's default branch. `head`, when given and not the
/// branch checked out, is another branch to diff instead: its commits alone,
/// since what is not committed belongs to the checked-out one.
#[tauri::command(async)]
pub fn git_branch_diff(cwd: String, base: Option<String>, head: Option<String>) -> Result<BranchDiff, String> {
    let root = root(&cwd)?;
    let base = base.as_deref().filter(|b| !b.is_empty());
    match head.as_deref().filter(|h| !h.is_empty()) {
        Some(head) if git(&root, &["branch", "--show-current"])?.trim() != head => other_branch_diff(&root, base, head),
        _ => branch_diff(&root, base),
    }
}

/// `base` as the ref to diff against: the one asked for, else the default.
fn base_or_default(root: &str, base: Option<&str>) -> Result<Option<String>, String> {
    match base {
        Some(base) => Ok(Some(base_ref(root, base).ok_or_else(|| format!("no branch named {base}"))?)),
        None => Ok(default_base(root)),
    }
}

/// A branch that is not checked out, against its base: its commits since it
/// left the base, as its pull request will show them.
fn other_branch_diff(root: &str, base: Option<&str>, head: &str) -> Result<BranchDiff, String> {
    if !is_commit(root, head) {
        return Err(format!("no branch named {head}"));
    }
    let base = base_or_default(root, base)?;
    let mut note = None;
    let fork = match &base {
        Some(base) => match git(root, &["merge-base", head, base]) {
            Ok(fork) => Some(fork.trim().to_string()),
            Err(_) => {
                note = Some(format!(
                    "{head} has no commit in common with {base} (a shallow clone, or an orphan branch): \
                     showing everything it has."
                ));
                None
            }
        },
        None => None,
    };
    let from = match &fork {
        Some(fork) => fork.clone(),
        None => empty_tree(root)?,
    };
    let commits = match &fork {
        Some(fork) => git(root, &["rev-list", "--count", &format!("{fork}..{head}")])?.trim().parse().unwrap_or(0),
        None => git(root, &["rev-list", "--count", head])?.trim().parse().unwrap_or(0),
    };
    let mut args = vec!["diff", "--no-color"];
    args.extend(NO_DRIVERS);
    args.extend(["-M", from.as_str(), head, "--"]);
    let out = run_bounded(root, &args, MAX_DIFF_BYTES)?;
    if !out.success && !out.truncated {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    Ok(BranchDiff {
        root: root.to_string(),
        base: base.unwrap_or_default(),
        commits,
        diff: cap(text, out.truncated),
        note,
    })
}

fn branch_diff(root: &str, base: Option<&str>) -> Result<BranchDiff, String> {
    let base = base_or_default(root, base)?;
    let mut note = None;
    let fork = match (&base, has_head(root)) {
        (_, false) => None,
        (Some(base), true) => match git(root, &["merge-base", "HEAD", base]) {
            Ok(fork) => Some(fork.trim().to_string()),
            // No common ancestor: still worth showing what is not committed.
            Err(_) => {
                note = Some(format!(
                    "This branch has no commit in common with {base} (a shallow clone, or an orphan branch): \
                     showing only what is not committed."
                ));
                Some("HEAD".to_string())
            }
        },
        (None, true) => Some("HEAD".to_string()),
    };
    let commits = match &fork {
        Some(fork) if fork != "HEAD" => git(root, &["rev-list", "--count", &format!("{fork}..HEAD")])?
            .trim()
            .parse()
            .unwrap_or(0),
        _ => 0,
    };
    let from = match fork {
        Some(fork) => fork,
        None => empty_tree(root)?,
    };

    // The worktree against the fork point: committed, staged and unstaged at
    // once. Untracked files are in no tree, so they are marked as about to be
    // added in a copy of the index, which puts them in the same single diff
    // as new files, however many there are. The real index is not touched.
    let index = TempIndex::new(root)?;
    let mut add = command(root, &["add", "--intent-to-add", "--all"]);
    add.env("GIT_INDEX_FILE", &index.0).stdin(Stdio::null());
    let added = add.output().map_err(|e| format!("could not run git: {e}"))?;
    if !added.status.success() {
        return Err(String::from_utf8_lossy(&added.stderr).trim().to_string());
    }
    let mut args = vec!["diff", "--no-color"];
    args.extend(NO_DRIVERS);
    args.extend(["-M", from.as_str()]);
    let mut diff_cmd = command(root, &args);
    diff_cmd.env("GIT_INDEX_FILE", &index.0);
    let out = bounded(diff_cmd, MAX_DIFF_BYTES)?;
    if !out.success && !out.truncated {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let diff = out.stdout;
    let truncated = out.truncated;

    let text = String::from_utf8_lossy(&diff).into_owned();
    Ok(BranchDiff {
        root: root.to_string(),
        base: base.unwrap_or_default(),
        commits,
        diff: cap(text, truncated),
        note,
    })
}

/// A copy of the repository's index in the temp folder, removed when dropped.
struct TempIndex(PathBuf);

impl TempIndex {
    fn new(root: &str) -> Result<TempIndex, String> {
        static COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("roer-index-{}-{n}", std::process::id()));
        let real = git(root, &["rev-parse", "--path-format=absolute", "--git-path", "index"])?;
        // A repository with nothing added yet has no index: an empty one is the same.
        match std::fs::copy(real.trim(), &path) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("could not copy the index: {e}")),
        }
        Ok(TempIndex(path))
    }
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let mut lock = self.0.clone().into_os_string();
        lock.push(".lock");
        let _ = std::fs::remove_file(lock);
    }
}

/// Whether `r` names a commit in this repository.
fn is_commit(root: &str, r: &str) -> bool {
    run(root, &["rev-parse", "--verify", "--quiet", &format!("{r}^{{commit}}")]).is_ok_and(|out| out.status.success())
}

/// `name` as a ref this repository has: origin's copy, or else the local
/// branch. Origin's wins for the same reason it does in [`default_base`]: a
/// pull request goes into the branch as GitHub has it, and the local one is
/// often behind it, which would put upstream commits into the branch's diff.
fn base_ref(root: &str, name: &str) -> Option<String> {
    [format!("origin/{name}"), name.to_string()].into_iter().find(|r| is_commit(root, r))
}

/// The branch a new pull request would go into: what origin calls its
/// default, else `main` or `master`. Origin's copy wins over a local one,
/// which is often behind it.
fn default_base(root: &str) -> Option<String> {
    let head = git(root, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).ok();
    if let Some(head) = head.map(|h| h.trim().to_string()).filter(|h| !h.is_empty()) {
        return Some(head);
    }
    ["origin/main", "origin/master", "main", "master"].into_iter().find(|r| is_commit(root, r)).map(str::to_string)
}

/// The files changed between two trees — a commit and its parent here,
/// rather than the worktree and `HEAD` that [`changes`] compares.
fn diff_files(root: &str, from: &str, to: &str) -> Result<Vec<FileChange>, String> {
    let mut status_args = vec!["diff", "--no-color", "-z", "-M", "--name-status"];
    status_args.extend(NO_DRIVERS);
    status_args.extend([from, to]);
    let mut files = parse_name_status(&git(root, &status_args)?);

    let mut numstat_args = vec!["diff", "--numstat", "-z", "-M"];
    numstat_args.extend(NO_DRIVERS);
    numstat_args.extend([from, to]);
    let counts = numstat(&git(root, &numstat_args)?);

    for file in &mut files {
        if let Some(stat) = counts.get(&file.path) {
            file.added = stat.added;
            file.deleted = stat.deleted;
            file.binary = stat.binary;
            file.counted = !stat.binary;
        }
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/// `--name-status -z` records: `<X><score>\0<path>\0`, or for a rename or a
/// copy `<X><score>\0<origPath>\0<path>\0`. The letter goes on the worktree
/// side, not the index: a commit has nothing staged, and [`isStaged`] on the
/// frontend would otherwise mark every row as if it did.
fn parse_name_status(text: &str) -> Vec<FileChange> {
    let mut files = Vec::new();
    let mut records = text.split('\0').filter(|record| !record.is_empty());
    while let Some(status) = records.next() {
        let mut letters = status.chars();
        let kind = letters.next().unwrap_or('M');
        let file = if kind == 'R' || kind == 'C' {
            let Some(from) = records.next() else { break };
            let Some(path) = records.next() else { break };
            FileChange {
                path: path.to_string(),
                staged: ".".to_string(),
                unstaged: kind.to_string(),
                renamed_from: (kind == 'R').then(|| from.to_string()),
                ..FileChange::default()
            }
        } else {
            let Some(path) = records.next() else { break };
            FileChange {
                path: path.to_string(),
                staged: ".".to_string(),
                unstaged: kind.to_string(),
                ..FileChange::default()
            }
        };
        files.push(file);
    }
    files
}

/// Everything changed in the session's repository, staged or not.
///
/// `async` keeps this off the main thread, which is where Tauri runs a plain
/// synchronous command — and `git status` over a large big_repo takes 1.7 s,
/// which is 1.7 s of frozen window every time the changes tab comes to the
/// front. The body is unchanged; only the thread it runs on is.
#[tauri::command(async)]
pub fn git_changes(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::files::FileIndex>,
    cwd: String,
) -> Result<Changes, String> {
    git_changes_core(&app, &state, cwd)
}

/// The watched read itself, generic over the host the same way
/// [`crate::files::files_search_core`] is.
pub(crate) fn git_changes_core<S: crate::events::Sink>(
    app: &S,
    state: &crate::files::FileIndex,
    cwd: String,
) -> Result<Changes, String> {
    let root = root(&cwd)?;
    // Looking at the diff is asking to be told when it changes.
    crate::files::watch_root(app, state, &root);
    changes(&root)
}

/// The status read itself, with nothing of Tauri about it so a test can call
/// it.
fn changes(root: &str) -> Result<Changes, String> {
    let status = git(
        root,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
        ],
    )?;
    let (branch, commit, mut files) = parse_status(&status);

    // One pass for every tracked file's line counts, rather than a `git`
    // process per row: a repository mid-refactor has hundreds of rows.
    let counts = if has_head(root) {
        let mut args = vec!["diff", "--numstat", "-z", "-M"];
        args.extend(NO_DRIVERS);
        args.push("HEAD");
        numstat(&git(root, &args)?)
    } else {
        HashMap::new()
    };

    for file in &mut files {
        match counts.get(&file.path) {
            Some(stat) => {
                file.added = stat.added;
                file.deleted = stat.deleted;
                file.binary = stat.binary;
                file.counted = !stat.binary;
            }
            // Untracked files are in no diff, so their whole content counts as
            // added. The same goes for everything when there is no HEAD.
            None => {
                let (added, binary) = count_lines(&Path::new(&root).join(&file.path));
                file.added = added.unwrap_or(0);
                file.binary = binary;
                file.counted = added.is_some();
            }
        }
    }

    Ok(Changes {
        root: root.to_string(),
        branch,
        commit,
        files,
    })
}

/// One file's unified diff against HEAD, staged changes included.
///
/// `untracked` cannot be inferred here: the file is in no index and no
/// commit, so git has nothing to compare it against unless it is told to
/// treat it as a pair of paths.
///
/// `async` for the reason [`git_changes`] is: this shells out to git twice and
/// the main thread should not be the one waiting.
#[tauri::command(async)]
pub fn git_diff(root: String, path: String, untracked: bool) -> Result<String, String> {
    let spec = format!("./{path}");
    // Before the first commit the empty tree is the only other side. The
    // index is not that side: `--cached` would answer for what is staged and
    // miss every edit made since.
    let base = if untracked || has_head(&root) {
        "HEAD".to_string()
    } else {
        empty_tree(&root)?
    };

    let mut args = vec!["diff", "--no-color"];
    args.extend(NO_DRIVERS);
    if untracked {
        args.extend(["--no-index", "--", "/dev/null", spec.as_str()]);
    } else {
        args.extend(["-M", base.as_str(), "--", path.as_str()]);
    }
    let out = run_bounded(&root, &args, MAX_DIFF_BYTES)?;

    // `--no-index` reports "these differ" as exit code 1, which is the
    // ordinary outcome here rather than a failure.
    if !out.success && out.stdout.is_empty() {
        let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if why.is_empty() {
            format!("could not diff {path}")
        } else {
            why
        });
    }

    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    Ok(cap(text, out.truncated))
}

/// Cuts a diff that was stopped short back to a character boundary, and says
/// so, so the pane shows the start of the change instead of freezing on it.
fn cap(mut text: String, truncated: bool) -> String {
    if !truncated {
        return text;
    }
    let mut end = text.len().min(MAX_DIFF_BYTES);
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push_str("\nroer: diff truncated — the rest is too large to show.\n");
    text
}

/// Branch name and changed files, from `status --porcelain=v2 -z`.
///
/// Records are NUL-delimited, so every path is the literal one, and a
/// rename's original path is a record of its own following the rename.
fn parse_status(text: &str) -> (String, String, Vec<FileChange>) {
    let mut branch = String::new();
    let mut commit = String::new();
    let mut files: Vec<FileChange> = Vec::new();

    let mut records = text.split('\0').filter(|record| !record.is_empty());
    while let Some(record) = records.next() {
        if let Some(head) = record.strip_prefix("# branch.head ") {
            branch = head.to_string();
            continue;
        }
        // `(initial)` before the first commit, which has none to name.
        if let Some(oid) = record.strip_prefix("# branch.oid ") {
            commit = if oid.starts_with('(') { String::new() } else { oid.chars().take(7).collect() };
            continue;
        }
        let Some((kind, rest)) = record.split_once(' ') else {
            continue;
        };
        let parsed = match kind {
            "1" => ordinary(rest),
            "2" => records.next().and_then(|from| renamed(rest, from)),
            "u" => unmerged(rest),
            "?" => Some(FileChange {
                path: rest.to_string(),
                staged: ".".to_string(),
                unstaged: "?".to_string(),
                ..FileChange::default()
            }),
            // `!` is an ignored file, and `#` any other header.
            _ => None,
        };
        if let Some(file) = parsed {
            files.push(file);
        }
    }

    // Git orders by index order; the tree wants path order, and sorting here
    // means every consumer gets the same one.
    files.sort_by(|a, b| a.path.cmp(&b.path));
    (branch, commit, files)
}

/// `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
fn ordinary(rest: &str) -> Option<FileChange> {
    // The path is the last field and may contain spaces, so it takes the
    // remainder rather than being split on its own.
    let mut fields = rest.splitn(8, ' ');
    let xy = fields.next()?;
    for _ in 0..6 {
        fields.next()?;
    }
    Some(change(xy, fields.next()?, None))
}

/// `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>`, whose
/// `<origPath>` is the record that follows it.
fn renamed(rest: &str, original: &str) -> Option<FileChange> {
    let mut fields = rest.splitn(9, ' ');
    let xy = fields.next()?;
    for _ in 0..7 {
        fields.next()?;
    }
    Some(change(xy, fields.next()?, Some(original.to_string())))
}

/// `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
fn unmerged(rest: &str) -> Option<FileChange> {
    let mut fields = rest.splitn(10, ' ');
    let xy = fields.next()?;
    for _ in 0..8 {
        fields.next()?;
    }
    Some(change(xy, fields.next()?, None))
}

fn change(xy: &str, path: &str, renamed_from: Option<String>) -> FileChange {
    let mut letters = xy.chars();
    FileChange {
        path: path.to_string(),
        staged: letters.next().unwrap_or('.').to_string(),
        unstaged: letters.next().unwrap_or('.').to_string(),
        renamed_from,
        ..FileChange::default()
    }
}

#[derive(Debug, Default, PartialEq)]
struct Stat {
    added: u32,
    deleted: u32,
    binary: bool,
}

/// `--numstat -z` records: `<added>\t<deleted>\t<path>`, with `-` for a
/// binary file. A rename leaves the path field empty and spells the move as
/// the next two records, old then new; status reports a rename under the new
/// name, so that is the half these counts belong to.
fn numstat(text: &str) -> HashMap<String, Stat> {
    let mut stats = HashMap::new();
    let mut records = text.split('\0').filter(|record| !record.is_empty());
    while let Some(record) = records.next() {
        let mut fields = record.splitn(3, '\t');
        let Some(added) = fields.next() else { continue };
        let Some(deleted) = fields.next() else {
            continue;
        };
        let path = match fields.next() {
            Some(path) if !path.is_empty() => path.to_string(),
            _ => {
                let _old = records.next();
                match records.next() {
                    Some(new) => new.to_string(),
                    None => continue,
                }
            }
        };
        stats.insert(
            path,
            Stat {
                added: added.parse().unwrap_or(0),
                deleted: deleted.parse().unwrap_or(0),
                binary: added == "-",
            },
        );
    }
    stats
}

/// Lines in a file on disk, and whether it is binary. Used for the files git
/// has never seen, which are in no diff and so in no `--numstat` output.
/// `None` is a count nobody can give, which the row shows as no count.
fn count_lines(path: &Path) -> (Option<u32>, bool) {
    // Not `metadata`: that follows the link and would answer for the target,
    // while git diffs a symlink as the one line naming where it points.
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return (None, false);
    };
    if meta.is_symlink() {
        return (Some(1), false);
    }
    // A directory here is a submodule, which has no lines of its own.
    if !meta.is_file() || meta.len() > MAX_COUNT_BYTES {
        return (None, false);
    }
    let Ok(bytes) = std::fs::read(path) else {
        return (None, false);
    };
    if bytes.is_empty() {
        return (Some(0), false);
    }
    if bytes.iter().take(SNIFF_BYTES).any(|&b| b == 0) {
        return (None, true);
    }
    let newlines = bytes.iter().filter(|&&b| b == b'\n').count();
    // A file whose last line has no newline still shows that line.
    let lines = newlines + usize::from(*bytes.last().unwrap() != b'\n');
    (Some(lines.min(u32::MAX as usize) as u32), false)
}

#[cfg(test)]
mod tests {
    use super::{
        branch_commits, branch_diff, branches, changes, git_branch_diff, git_commit_all, commit_files, count_lines, git, git_commit_diff,
        git_diff, git_root, numstat, parse_name_status, parse_status, push_upstream, repo, root,
        upstream_status, Stat, Upstream, MAX_DIFF_BYTES,
    };
    use crate::testing::{commit, init, must, scratch, write};

    #[test]
    fn a_worktree_belongs_to_the_repository_it_was_added_to() {
        let dir = scratch("worktree-repo");
        let main = dir.join("main");
        std::fs::create_dir_all(&main).unwrap();
        let main_s = main.to_string_lossy().to_string();
        init(&main_s);
        write(&main, "a.txt", "a");
        must(&main_s, &["add", "a.txt"]);
        commit(&main_s, "first");
        let linked = dir.join("linked");
        must(&main_s, &["worktree", "add", "-q", "-b", "side", &linked.to_string_lossy()]);

        let from_main = repo(&main_s).unwrap();
        let from_linked = repo(&linked.to_string_lossy()).unwrap();
        assert_eq!(from_linked.main, from_main.main, "one repository");
        assert_eq!(from_main.root, from_main.main);
        assert_ne!(from_linked.root, from_linked.main, "its own checkout");
        assert_eq!(from_linked.worktrees.len(), 2, "{:?}", from_linked.worktrees);
        assert_eq!(from_linked.worktrees[0], from_main.main, "the main checkout first");
        assert!(repo(&dir.to_string_lossy()).is_err(), "not in a repository");
    }

    #[test]
    fn a_checkout_with_its_git_dir_elsewhere_is_its_own_main() {
        let dir = scratch("separate-git-dir");
        let work = dir.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let work_s = work.to_string_lossy().to_string();
        must(&work_s, &["init", "-q", "--separate-git-dir", &dir.join("store.git").to_string_lossy()]);
        // No global identity on a CI runner: the same one `init` gives.
        must(&work_s, &["config", "user.email", "test@example.invalid"]);
        must(&work_s, &["config", "user.name", "Roer Test"]);
        write(&work, "a.txt", "a");
        must(&work_s, &["add", "a.txt"]);
        commit(&work_s, "first");

        let found = repo(&work_s).unwrap();
        assert_eq!(found.main, found.root, "not the git dir: {found:?}");

        // A submodule's git dir is in its superproject's `.git/modules`.
        let sup = dir.join("super");
        std::fs::create_dir_all(&sup).unwrap();
        let sup_s = sup.to_string_lossy().to_string();
        init(&sup_s);
        must(&sup_s, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", &work_s, "sub"]);
        let sub = repo(&sup.join("sub").to_string_lossy()).unwrap();
        assert_eq!(sub.main, sub.root, "not .git/modules: {sub:?}");

        // A worktree of the submodule is its project's too.
        let linked = dir.join("sub-linked");
        must(&sub.root, &["worktree", "add", "-q", "-b", "side", &linked.to_string_lossy()]);
        let from_linked = repo(&linked.to_string_lossy()).unwrap();
        assert_eq!(from_linked.main, sub.main, "one repository: {from_linked:?}");
        assert_eq!(from_linked.worktrees[0], sub.main, "the checkout first");
    }

    #[test]
    fn reads_the_branch_and_an_ordinary_change() {
        let (branch, commit, files) = parse_status(
            "# branch.oid 1234abcdef\0\
             # branch.head changes-view\0\
             1 .M N... 100644 100644 100644 abc def src/App.tsx\0",
        );
        assert_eq!(branch, "changes-view");
        assert_eq!(commit, "1234abc");
        assert_eq!(parse_status("# branch.oid (initial)\0# branch.head main\0").1, "", "no commit yet");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "src/App.tsx");
        assert_eq!(files[0].staged, ".");
        assert_eq!(files[0].unstaged, "M");
        assert_eq!(files[0].renamed_from, None);
    }

    #[test]
    fn keeps_the_two_status_letters_apart() {
        // Staged an edit, then edited again: both sides have something.
        let (_, _, files) = parse_status("1 MM N... 100644 100644 100644 abc def a.txt\0");
        assert_eq!(files[0].staged, "M");
        assert_eq!(files[0].unstaged, "M");
    }

    #[test]
    fn parses_a_rename_with_its_original_path() {
        let (_, _, files) =
            parse_status("2 R. N... 100644 100644 100644 abc def R100 src/new.ts\0src/old.ts\0");
        assert_eq!(files[0].path, "src/new.ts");
        assert_eq!(files[0].renamed_from.as_deref(), Some("src/old.ts"));
        assert_eq!(files[0].staged, "R");
    }

    #[test]
    fn parses_an_unmerged_file() {
        let (_, _, files) =
            parse_status("u UU N... 100644 100644 100644 100644 a b c src/conflict.rs\0");
        assert_eq!(files[0].path, "src/conflict.rs");
        assert_eq!(files[0].staged, "U");
        assert_eq!(files[0].unstaged, "U");
    }

    #[test]
    fn marks_untracked_files_on_the_worktree_side() {
        let (_, _, files) = parse_status("? notes.md\0");
        assert_eq!(files[0].path, "notes.md");
        assert_eq!(files[0].staged, ".");
        assert_eq!(files[0].unstaged, "?");
    }

    #[test]
    fn tolerates_paths_with_spaces() {
        let (_, _, files) = parse_status(
            "1 .M N... 100644 100644 100644 abc def my docs/a note.md\0? other notes.md\0",
        );
        let paths: Vec<_> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["my docs/a note.md", "other notes.md"]);
    }

    #[test]
    fn keeps_a_quote_and_a_tab_in_a_path() {
        // The line-delimited form would spell this one `"we\"ird\ttab.txt"`,
        // which is not a path anything can be asked about.
        let (_, _, files) = parse_status("? we\"ird\ttab.txt\0");
        assert_eq!(files[0].path, "we\"ird\ttab.txt");
    }

    #[test]
    fn ignores_headers_ignored_files_and_junk() {
        let (_, _, files) = parse_status(
            "# branch.ab +1 -0\0\
             ! target/debug/roer\0\
             \0\
             1 .M N... 100644 100644 100644 abc def kept.txt\0",
        );
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "kept.txt");
    }

    #[test]
    fn sorts_files_by_path() {
        let (_, _, files) = parse_status("? z.txt\0? a.txt\0? m/b.txt\0");
        let paths: Vec<_> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["a.txt", "m/b.txt", "z.txt"]);
    }

    #[test]
    fn counts_lines_per_file() {
        let stats = numstat(&["3\t1\tsrc/App.tsx", "0\t7\tgone.txt", ""].join("\0"));
        assert_eq!(
            stats.get("src/App.tsx"),
            Some(&Stat {
                added: 3,
                deleted: 1,
                binary: false
            })
        );
        assert_eq!(stats.get("gone.txt").map(|s| s.deleted), Some(7));
    }

    #[test]
    fn reports_a_binary_file_without_counts() {
        let stats = numstat("-\t-\ticons/icon.icns\0");
        let stat = stats.get("icons/icon.icns").expect("row");
        assert!(stat.binary);
        assert_eq!((stat.added, stat.deleted), (0, 0));
    }

    #[test]
    fn attributes_a_rename_to_its_new_path() {
        // A rename's path field is empty, and the move follows it as two
        // records: where it came from, then where it is now.
        let stats = numstat("2\t1\t\0src/old.ts\0src/new.ts\0? kept\0");
        assert_eq!(stats.get("src/new.ts").map(|s| s.added), Some(2));
        assert_eq!(stats.get("src/old.ts"), None);
    }

    #[test]
    fn reads_a_real_repository() {
        // The parsing above is unit-tested against hand-written status
        // records; this is the one test that proves those records are what
        // git emits.
        let dir = scratch("repo");
        std::fs::create_dir_all(dir.join("src")).unwrap();
        let at = dir.to_string_lossy().to_string();

        init(&at);
        std::fs::write(dir.join("src/kept.txt"), "one\ntwo\nthree\n").unwrap();
        must(&at, &["add", "."]);
        commit(&at, "first");

        std::fs::write(dir.join("src/kept.txt"), "one\nTWO\nthree\n").unwrap();
        std::fs::write(dir.join("fresh.md"), "new\nfile\n").unwrap();

        let changes = changes(&at).expect("changes");
        assert_eq!(changes.branch, "main");
        let paths: Vec<_> = changes.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["fresh.md", "src/kept.txt"]);

        let fresh = &changes.files[0];
        assert_eq!(fresh.unstaged, "?");
        // Nothing to compare it against, so every line of it is new.
        assert_eq!((fresh.added, fresh.deleted), (2, 0));
        assert!(fresh.counted);

        let kept = &changes.files[1];
        assert_eq!((kept.staged.as_str(), kept.unstaged.as_str()), (".", "M"));
        assert_eq!((kept.added, kept.deleted), (1, 1));

        let diff = git_diff(changes.root.clone(), "src/kept.txt".to_string(), false).expect("diff");
        assert!(diff.contains("@@"), "{diff}");
        assert!(diff.contains("+TWO"), "{diff}");
        assert!(diff.contains("-two"), "{diff}");

        let added = git_diff(changes.root.clone(), "fresh.md".to_string(), true)
            .expect("diff of an untracked file");
        assert!(added.contains("+new"), "{added}");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    #[cfg(unix)] // Creating a symlink on Windows needs developer mode or admin.
    fn reads_the_names_git_actually_gave_the_files() {
        let dir = scratch("odd");
        let at = dir.to_string_lossy().to_string();
        init(&at);
        std::fs::write(dir.join("plain.txt"), "a\nb\n").unwrap();
        must(&at, &["add", "."]);
        commit(&at, "first");

        must(&at, &["mv", "plain.txt", "moved file.txt"]);
        let awkward = "we\"ird\ttab.txt";
        std::fs::write(dir.join(awkward), "x\n").unwrap();
        std::os::unix::fs::symlink("moved file.txt", dir.join("link.txt")).unwrap();

        let changes = changes(&at).expect("changes");
        let paths: Vec<_> = changes.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["link.txt", "moved file.txt", awkward]);

        let moved = &changes.files[1];
        assert_eq!(moved.staged, "R");
        assert_eq!(moved.renamed_from.as_deref(), Some("plain.txt"));
        // The rename's counts are the new path's, and nothing moved a line.
        assert_eq!((moved.added, moved.deleted), (0, 0));
        assert!(moved.counted);

        // Git diffs a symlink as the single line naming its target.
        assert_eq!(changes.files[0].added, 1);

        let diff = git_diff(changes.root.clone(), awkward.to_string(), true).expect("diff");
        assert!(diff.contains("+x"), "{diff}");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn diffs_the_worktree_before_the_first_commit() {
        let dir = scratch("unborn");
        let at = dir.to_string_lossy().to_string();
        init(&at);
        std::fs::write(dir.join("a.txt"), "staged\n").unwrap();
        must(&at, &["add", "."]);
        std::fs::write(dir.join("a.txt"), "staged\nedited\n").unwrap();

        let diff = git_diff(at.clone(), "a.txt".to_string(), false).expect("diff");
        assert!(diff.contains("+staged"), "{diff}");
        // The index is not the other side: an edit made after staging is part
        // of the change too.
        assert!(diff.contains("+edited"), "{diff}");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn stops_git_once_a_diff_is_too_long_to_show() {
        let dir = scratch("huge");
        let at = dir.to_string_lossy().to_string();
        init(&at);
        std::fs::write(dir.join("huge.txt"), "a line of text\n".repeat(60_000)).unwrap();

        let diff = git_diff(at.clone(), "huge.txt".to_string(), true).expect("diff");
        assert!(diff.contains("diff truncated"), "{}", &diff[..80]);
        assert!(diff.len() < MAX_DIFF_BYTES + 200, "{}", diff.len());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn git_root_finds_the_toplevel_from_a_subdirectory() {
        let dir = scratch("root");
        std::fs::create_dir_all(dir.join("src")).unwrap();
        let at = dir.to_string_lossy().to_string();
        init(&at);

        let from_sub = dir.join("src").to_string_lossy().to_string();
        assert_eq!(git_root(from_sub), Some(crate::testing::canonical(&dir)));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn git_root_is_none_outside_a_repository() {
        let dir = scratch("no-root");
        let at = dir.to_string_lossy().to_string();

        assert_eq!(git_root(at), None);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn says_plainly_when_a_session_is_not_in_a_repository() {
        // git's own answer names `.git` and the walk up the parents, which
        // reads as something broken rather than as a session that simply
        // isn't in a repository.
        let dir = scratch("bare");
        let at = dir.to_string_lossy().to_string();

        // `root` is what the command resolves through before it reads
        // anything, so this is the message the session actually gets.
        let err = root(&at).expect_err("no repository");
        assert_eq!(err, format!("{at} is not in a git repository."));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn counts_the_last_line_without_a_newline() {
        let dir = scratch("count");

        let ended = dir.join("ended.txt");
        std::fs::write(&ended, "a\nb\n").unwrap();
        assert_eq!(count_lines(&ended), (Some(2), false));

        let unfinished = dir.join("unfinished.txt");
        std::fs::write(&unfinished, "a\nb").unwrap();
        assert_eq!(count_lines(&unfinished), (Some(2), false));

        let empty = dir.join("empty.txt");
        std::fs::write(&empty, "").unwrap();
        assert_eq!(count_lines(&empty), (Some(0), false));

        let binary = dir.join("blob.bin");
        std::fs::write(&binary, [0x89, 0x50, 0x00, 0x4e]).unwrap();
        assert_eq!(count_lines(&binary), (None, true));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    #[cfg(unix)] // Creating a symlink on Windows needs developer mode or admin.
    fn gives_no_count_where_there_is_none_to_give() {
        let dir = scratch("nocount");

        // A link counts as the one line naming its target, not as whatever
        // it points at — and a broken one still counts.
        let target = dir.join("target.txt");
        std::fs::write(&target, "a\nb\nc\n").unwrap();
        let link = dir.join("link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert_eq!(count_lines(&link), (Some(1), false));

        // A directory in a status listing is a submodule.
        assert_eq!(count_lines(&dir), (None, false));

        assert_eq!(count_lines(&dir.join("missing.txt")), (None, false));

        let large = dir.join("large.txt");
        std::fs::write(&large, vec![b'x'; super::MAX_COUNT_BYTES as usize + 1]).unwrap();
        assert_eq!(count_lines(&large), (None, false));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn parses_an_ordinary_name_status_record() {
        let files = parse_name_status("M\0src/App.tsx\0");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "src/App.tsx");
        assert_eq!(files[0].staged, ".");
        assert_eq!(files[0].unstaged, "M");
    }

    #[test]
    fn parses_a_rename_name_status_record() {
        let files = parse_name_status("R100\0src/old.ts\0src/new.ts\0");
        assert_eq!(files[0].path, "src/new.ts");
        assert_eq!(files[0].renamed_from.as_deref(), Some("src/old.ts"));
        assert_eq!(files[0].unstaged, "R");
    }

    #[test]
    fn lists_the_commits_a_branch_added_over_its_base() {
        let dir = scratch("branch-commits");
        let at = dir.to_string_lossy().to_string();
        init(&at);

        write(&dir, "a.txt", "one\n");
        must(&at, &["add", "."]);
        commit(&at, "base commit");

        must(&at, &["checkout", "-q", "-b", "feature"]);
        write(&dir, "a.txt", "one\ntwo\n");
        must(&at, &["add", "."]);
        commit(&at, "second commit");
        write(&dir, "b.txt", "new\n");
        must(&at, &["add", "."]);
        commit(&at, "third commit\n\nWhy it was made,\nover two lines.");

        let commits = branch_commits(&at, "feature", "main").expect("commits");
        assert_eq!(commits[0].body, "");
        assert_eq!(commits[1].body, "Why it was made,\nover two lines.");
        let subjects: Vec<_> = commits.iter().map(|c| c.subject.as_str()).collect();
        // Oldest first: stepping through them is reading the branch in the
        // order it was written.
        assert_eq!(subjects, ["second commit", "third commit"]);
        assert!(commits[0].hash.starts_with(&commits[0].short));
        assert!(!commits[0].author.is_empty());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn diffs_one_commit_against_its_own_parent() {
        let dir = scratch("commit-diff");
        let at = dir.to_string_lossy().to_string();
        init(&at);

        write(&dir, "a.txt", "one\n");
        must(&at, &["add", "."]);
        commit(&at, "first");

        write(&dir, "a.txt", "one\ntwo\n");
        write(&dir, "b.txt", "new\n");
        must(&at, &["add", "."]);
        commit(&at, "second");

        let head = git(&at, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        let files = commit_files(&at, &head).expect("files");
        let paths: Vec<_> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["a.txt", "b.txt"]);
        // Nothing about a commit is staged; the letter belongs on the
        // worktree side so `isStaged` on the frontend does not mark it.
        assert_eq!(files[0].staged, ".");
        assert_eq!(files[0].unstaged, "M");
        assert_eq!((files[0].added, files[0].deleted), (1, 0));
        assert_eq!(files[1].unstaged, "A");

        let diff = git_commit_diff(at.clone(), head, "a.txt".to_string()).expect("diff");
        assert!(diff.contains("+two"), "{diff}");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn diffs_a_root_commit_against_the_empty_tree() {
        let dir = scratch("root-commit-diff");
        let at = dir.to_string_lossy().to_string();
        init(&at);

        write(&dir, "a.txt", "one\n");
        must(&at, &["add", "."]);
        commit(&at, "first");

        let head = git(&at, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        let files = commit_files(&at, &head).expect("files");
        assert_eq!(files[0].path, "a.txt");
        assert_eq!(files[0].unstaged, "A");

        let diff = git_commit_diff(at.clone(), head, "a.txt".to_string()).expect("diff");
        assert!(diff.contains("+one"), "{diff}");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn diffs_a_branch_since_its_base_with_uncommitted_and_untracked_work() {
        let dir = scratch("branch-diff");
        let at = dir.to_string_lossy().to_string();
        init(&at);

        write(&dir, "a.txt", "one\n");
        write(&dir, "b.txt", "keep\n");
        must(&at, &["add", "."]);
        commit(&at, "base");
        must(&at, &["checkout", "-q", "-b", "feature"]);
        write(&dir, "a.txt", "one\ntwo\n");
        must(&at, &["add", "."]);
        commit(&at, "on the branch");
        // Moving main on afterwards must not show up as the branch undoing it.
        must(&at, &["checkout", "-q", "main"]);
        write(&dir, "c.txt", "main only\n");
        must(&at, &["add", "."]);
        commit(&at, "main moves on");
        must(&at, &["checkout", "-q", "feature"]);

        write(&dir, "b.txt", "keep\nedited\n");
        write(&dir, "new.txt", "brand new\n");

        let found = branch_diff(&at, None).expect("diff");
        assert_eq!(found.base, "main");
        assert_eq!(found.commits, 1);
        assert!(found.diff.contains("+two"), "{}", found.diff);
        assert!(found.diff.contains("+edited"), "{}", found.diff);
        assert!(found.diff.contains("+brand new"), "{}", found.diff);
        // Named the way a tracked file is, so it lands in the same tree.
        assert!(found.diff.contains("+++ b/new.txt"), "{}", found.diff);
        assert!(!found.diff.contains("c.txt"), "{}", found.diff);

        let named = branch_diff(&at, Some("main")).expect("diff");
        assert_eq!(named.diff, found.diff);
        assert!(branch_diff(&at, Some("nope")).is_err());

        // From main, the feature branch is its commit alone: the edits on disk are main's worktree's now.
        must(&at, &["stash", "-u", "-q"]);
        must(&at, &["checkout", "-q", "main"]);
        write(&dir, "c.txt", "uncommitted on main\n");
        let other = git_branch_diff(at.clone(), None, Some("feature".into())).expect("diff");
        assert_eq!((other.base.as_str(), other.commits), ("main", 1));
        assert!(other.diff.contains("+two"), "{}", other.diff);
        assert!(!other.diff.contains("edited"), "{}", other.diff);
        assert!(!other.diff.contains("c.txt"), "{}", other.diff);
        // Naming the branch checked out is the ordinary diff, worktree and all.
        let here = git_branch_diff(at.clone(), None, Some("main".into())).expect("diff");
        assert!(here.diff.contains("uncommitted on main"), "{}", here.diff);
        assert!(git_branch_diff(at.clone(), None, Some("nope".into())).is_err());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn commits_everything_the_worktree_changed_with_the_message_given() {
        let dir = scratch("commit-all");
        let at = dir.to_string_lossy().to_string();
        init(&at);
        write(&dir, "a.txt", "one\n");
        must(&at, &["add", "."]);
        commit(&at, "first");
        write(&dir, "a.txt", "one\ntwo\n");
        write(&dir, "new.txt", "brand new\n");

        assert!(git_commit_all(at.clone(), "  \n".into()).is_err());
        let short = git_commit_all(at.clone(), "Add two and a new file\n\nWhy, in a line.".into()).expect("commit");
        assert!(git(&at, &["rev-parse", "HEAD"]).unwrap().starts_with(&short));
        assert_eq!(git(&at, &["log", "-1", "--format=%B"]).unwrap().trim(), "Add two and a new file\n\nWhy, in a line.");
        assert_eq!(git(&at, &["status", "--porcelain"]).unwrap(), "");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn on_its_base_a_branch_diff_is_what_is_uncommitted() {
        let dir = scratch("branch-diff-base");
        let at = dir.to_string_lossy().to_string();
        init(&at);
        write(&dir, "a.txt", "one\n");
        must(&at, &["add", "."]);
        commit(&at, "first");
        write(&dir, "a.txt", "one\nmore\n");

        let found = branch_diff(&at, None).expect("diff");
        assert_eq!((found.base.as_str(), found.commits), ("main", 0));
        assert!(found.diff.contains("+more"), "{}", found.diff);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn diffs_many_untracked_files_in_one_go_and_leaves_the_index_alone() {
        let dir = scratch("branch-diff-untracked");
        let at = dir.to_string_lossy().to_string();
        init(&at);
        write(&dir, ".gitignore", "build/\n");
        write(&dir, "a.txt", "one\n");
        must(&at, &["add", "."]);
        commit(&at, "first");
        for n in 0..300 {
            write(&dir, &format!("gen/f{n}.txt"), &format!("line {n}\n"));
        }
        write(&dir, "build/out.txt", "ignored\n");
        write(&dir, "sp ace.txt", "é\n");

        let found = branch_diff(&at, None).expect("diff");
        assert_eq!(found.diff.matches("new file mode").count(), 301, "{}", found.diff);
        assert!(found.diff.contains("+++ b/sp ace.txt"), "{}", found.diff);
        assert!(!found.diff.contains("build/out.txt"), "ignored files stay out");
        let status = git(&at, &["status", "--porcelain"]).unwrap();
        assert!(status.contains("?? gen/"), "the real index has not had them added: {status}");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn with_no_common_ancestor_a_branch_diff_says_so_and_shows_what_is_uncommitted() {
        let dir = scratch("branch-diff-orphan");
        let at = dir.to_string_lossy().to_string();
        init(&at);
        write(&dir, "a.txt", "one\n");
        must(&at, &["add", "."]);
        commit(&at, "first");
        must(&at, &["checkout", "-q", "--orphan", "lonely"]);
        must(&at, &["rm", "-rq", "--cached", "."]);
        write(&dir, "b.txt", "two\n");
        must(&at, &["add", "b.txt"]);
        commit(&at, "elsewhere");
        write(&dir, "b.txt", "two\nthree\n");

        let found = branch_diff(&at, Some("main")).expect("diff");
        assert!(found.note.as_deref().is_some_and(|n| n.contains("no commit in common with main")), "{:?}", found.note);
        assert!(found.diff.contains("+three"), "{}", found.diff);
        assert_eq!(found.commits, 0);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn diffs_a_branch_before_its_first_commit() {
        let dir = scratch("branch-diff-unborn");
        let at = dir.to_string_lossy().to_string();
        init(&at);
        write(&dir, "a.txt", "one\n");

        let found = branch_diff(&at, None).expect("diff");
        assert_eq!((found.base.as_str(), found.commits), ("", 0));
        assert!(found.diff.contains("+one"), "{}", found.diff);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn lists_local_branches() {
        let dir = scratch("branches");
        let at = dir.to_string_lossy().to_string();
        init(&at);
        write(&dir, "a.txt", "one\n");
        must(&at, &["add", "."]);
        commit(&at, "first");
        must(&at, &["checkout", "-q", "-b", "feature"]);

        let names = branches(&at).expect("branches");
        assert_eq!(names, vec!["feature".to_string(), "main".to_string()]);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn compares_with_origins_copy_of_a_named_base_not_a_stale_local_one() {
        let base = scratch("stale-base");
        let remote = base.join("remote.git");
        let work = base.join("work");
        std::fs::create_dir_all(&remote).unwrap();
        std::fs::create_dir_all(&work).unwrap();
        let (remote, work) = (remote.to_str().unwrap(), work.to_str().unwrap());
        must(remote, &["init", "-q", "--bare"]);
        init(work);
        must(work, &["remote", "add", "origin", remote]);
        write(std::path::Path::new(work), "a.txt", "one\n");
        commit_all(work, "first");
        must(work, &["checkout", "-q", "-b", "develop"]);
        must(work, &["push", "-q", "origin", "develop"]);
        // Upstream moves on; the local develop stays where it was.
        write(std::path::Path::new(work), "upstream.txt", "theirs\n");
        commit_all(work, "upstream work");
        must(work, &["push", "-q", "origin", "develop"]);
        must(work, &["reset", "-q", "--hard", "HEAD~1"]);
        // The feature is cut from develop as GitHub has it.
        must(work, &["checkout", "-q", "-b", "feature", "origin/develop"]);
        write(std::path::Path::new(work), "mine.txt", "mine\n");
        commit_all(work, "my work");

        let found = branch_diff(work, Some("develop")).expect("diff");
        assert_eq!(found.base, "origin/develop");
        assert_eq!(found.commits, 1);
        assert!(found.diff.contains("mine.txt"), "{}", found.diff);
        assert!(!found.diff.contains("upstream.txt"), "{}", found.diff);

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn pushes_a_new_branch_and_tracks_its_upstream() {
        let base = scratch("upstream");
        let remote = base.join("remote.git");
        let work = base.join("work");
        std::fs::create_dir_all(&remote).unwrap();
        std::fs::create_dir_all(&work).unwrap();
        let (remote, work) = (remote.to_str().unwrap(), work.to_str().unwrap());
        must(remote, &["init", "-q", "--bare"]);
        init(work);
        must(work, &["remote", "add", "origin", remote]);
        write(std::path::Path::new(work), "a.txt", "one\n");
        must(work, &["add", "a.txt"]);
        commit(work, "first");

        let before = upstream_status(work).unwrap();
        assert_eq!(before, Upstream { upstream: None, ahead: 0, behind: 0 });

        push_upstream(work).unwrap();
        let pushed = upstream_status(work).unwrap();
        assert_eq!(pushed.upstream.as_deref(), Some("origin/main"));
        assert_eq!((pushed.ahead, pushed.behind), (0, 0));

        write(std::path::Path::new(work), "a.txt", "two\n");
        commit_all(work, "second");
        assert_eq!(upstream_status(work).unwrap().ahead, 1);
        push_upstream(work).unwrap();
        assert_eq!(upstream_status(work).unwrap().ahead, 0);

        std::fs::remove_dir_all(&base).ok();
    }

    fn commit_all(at: &str, message: &str) {
        must(at, &["add", "-A"]);
        commit(at, message);
    }
}
