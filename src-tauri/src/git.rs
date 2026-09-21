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
use std::path::Path;
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
    pub files: Vec<FileChange>,
}

/// Git, told not to interact: a prompt would hang the app with nowhere to
/// type, and the optional index refresh takes a lock that a terminal session
/// in the same repo may be holding.
pub(crate) fn command(dir: &str, args: &[&str]) -> Command {
    let mut git = Command::new("git");
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
    let mut child = command(dir, args)
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
}

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
    let format = format!("%H{FIELD_SEP}%h{FIELD_SEP}%an{FIELD_SEP}%at{FIELD_SEP}%s");
    let range = format!("{base}..{branch}");
    let out = git(root, &["log", "--reverse", &format!("--format={format}"), &range])?;
    Ok(out.lines().filter(|line| !line.is_empty()).filter_map(parse_commit).collect())
}

fn parse_commit(line: &str) -> Option<Commit> {
    let mut fields = line.splitn(5, FIELD_SEP);
    Some(Commit {
        hash: fields.next()?.to_string(),
        short: fields.next()?.to_string(),
        author: fields.next()?.to_string(),
        date: fields.next()?.parse().ok()?,
        subject: fields.next()?.to_string(),
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
    let root = root(&cwd)?;
    // Looking at the diff is asking to be told when it changes.
    crate::files::watch_root(&app, &state, &root);
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
    let (branch, mut files) = parse_status(&status);

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
fn parse_status(text: &str) -> (String, Vec<FileChange>) {
    let mut branch = String::new();
    let mut files: Vec<FileChange> = Vec::new();

    let mut records = text.split('\0').filter(|record| !record.is_empty());
    while let Some(record) = records.next() {
        if let Some(head) = record.strip_prefix("# branch.head ") {
            branch = head.to_string();
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
    (branch, files)
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
        branch_commits, branches, changes, commit_files, count_lines, git, git_commit_diff,
        git_diff, git_root, numstat, parse_name_status, parse_status, root, Stat, MAX_DIFF_BYTES,
    };
    use crate::testing::{commit, init, must, scratch, write};

    #[test]
    fn reads_the_branch_and_an_ordinary_change() {
        let (branch, files) = parse_status(
            "# branch.oid 1234\0\
             # branch.head changes-view\0\
             1 .M N... 100644 100644 100644 abc def src/App.tsx\0",
        );
        assert_eq!(branch, "changes-view");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "src/App.tsx");
        assert_eq!(files[0].staged, ".");
        assert_eq!(files[0].unstaged, "M");
        assert_eq!(files[0].renamed_from, None);
    }

    #[test]
    fn keeps_the_two_status_letters_apart() {
        // Staged an edit, then edited again: both sides have something.
        let (_, files) = parse_status("1 MM N... 100644 100644 100644 abc def a.txt\0");
        assert_eq!(files[0].staged, "M");
        assert_eq!(files[0].unstaged, "M");
    }

    #[test]
    fn parses_a_rename_with_its_original_path() {
        let (_, files) =
            parse_status("2 R. N... 100644 100644 100644 abc def R100 src/new.ts\0src/old.ts\0");
        assert_eq!(files[0].path, "src/new.ts");
        assert_eq!(files[0].renamed_from.as_deref(), Some("src/old.ts"));
        assert_eq!(files[0].staged, "R");
    }

    #[test]
    fn parses_an_unmerged_file() {
        let (_, files) =
            parse_status("u UU N... 100644 100644 100644 100644 a b c src/conflict.rs\0");
        assert_eq!(files[0].path, "src/conflict.rs");
        assert_eq!(files[0].staged, "U");
        assert_eq!(files[0].unstaged, "U");
    }

    #[test]
    fn marks_untracked_files_on_the_worktree_side() {
        let (_, files) = parse_status("? notes.md\0");
        assert_eq!(files[0].path, "notes.md");
        assert_eq!(files[0].staged, ".");
        assert_eq!(files[0].unstaged, "?");
    }

    #[test]
    fn tolerates_paths_with_spaces() {
        let (_, files) = parse_status(
            "1 .M N... 100644 100644 100644 abc def my docs/a note.md\0? other notes.md\0",
        );
        let paths: Vec<_> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["my docs/a note.md", "other notes.md"]);
    }

    #[test]
    fn keeps_a_quote_and_a_tab_in_a_path() {
        // The line-delimited form would spell this one `"we\"ird\ttab.txt"`,
        // which is not a path anything can be asked about.
        let (_, files) = parse_status("? we\"ird\ttab.txt\0");
        assert_eq!(files[0].path, "we\"ird\ttab.txt");
    }

    #[test]
    fn ignores_headers_ignored_files_and_junk() {
        let (_, files) = parse_status(
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
        let (_, files) = parse_status("? z.txt\0? a.txt\0? m/b.txt\0");
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

        // git resolves symlinks in its answer (macOS's `/tmp` is one, into
        // `/private/tmp`), so the expectation is canonicalized too.
        let canonical = std::fs::canonicalize(&dir)
            .unwrap()
            .to_string_lossy()
            .to_string();
        let from_sub = dir.join("src").to_string_lossy().to_string();
        assert_eq!(git_root(from_sub), Some(canonical));

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
        commit(&at, "third commit");

        let commits = branch_commits(&at, "feature", "main").expect("commits");
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
}
