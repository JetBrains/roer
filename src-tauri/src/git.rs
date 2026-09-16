//! Local changes for the session's own repository.
//!
//! Two calls and no state: the tree asks for every changed file at once, and
//! the pane on the right asks for one file's diff when it is selected. Both
//! shell out to `git`, because a libgit2 binding would have to be taught the
//! same rules and would still be wrong about the index.
//!
//! Porcelain v2 is the only status format with a documented, stable contract,
//! and it is the only one that reports the index and the worktree separately —
//! which is the difference between "staged" and "not staged" on screen.

use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Output};

use serde::Serialize;

/// An untracked file is read from disk to count its lines. Anything larger is
/// listed without counts rather than pulled into memory.
const MAX_COUNT_BYTES: u64 = 2 * 1024 * 1024;

/// Enough of a file to tell text from binary. Git uses the same trick.
const SNIFF_BYTES: usize = 8000;

/// A diff long enough to stall the renderer is cut short instead.
const MAX_DIFF_BYTES: usize = 400_000;

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

/// Runs git without letting it interact: a prompt would hang the app with
/// nowhere to type, and the optional index refresh takes a lock that a
/// terminal session in the same repo may be holding.
fn run(dir: &str, args: &[&str]) -> Result<Output, String> {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        // Without this git escapes any non-ASCII path, and the escaped name
        // is not a path that can be diffed.
        .args(["-c", "core.quotePath=false"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .map_err(|e| format!("could not run git: {e}"))
}

/// Standard output of a git command that is expected to succeed.
fn git(dir: &str, args: &[&str]) -> Result<String, String> {
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
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Whether the repository has a commit yet. A fresh `git init` has none, and
/// every diff against `HEAD` fails there.
fn has_head(root: &str) -> bool {
    run(root, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .map(|out| out.status.success())
        .unwrap_or(false)
}

/// Everything changed in the session's repository, staged or not.
#[tauri::command]
pub fn git_changes(cwd: String) -> Result<Changes, String> {
    if cwd.is_empty() {
        return Err("no directory for this session".to_string());
    }
    // Not `git()`: git's own wording names `.git` and the walk up the
    // parents, which reads as something broken. A session simply being
    // outside a repository is the ordinary case here.
    let out = run(&cwd, &["rev-parse", "--show-toplevel"])?;
    let root = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || root.is_empty() {
        return Err(format!("{cwd} is not in a git repository."));
    }

    let status = git(
        &root,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
        ],
    )?;
    let (branch, mut files) = parse_status(&status);

    // One pass for every tracked file's line counts, rather than a `git`
    // process per row: a repository mid-refactor has hundreds of rows.
    let head = has_head(&root);
    let counts = if head {
        numstat(&git(&root, &["diff", "--numstat", "-M", "HEAD"])?)
    } else {
        HashMap::new()
    };

    for file in &mut files {
        match counts.get(&file.path) {
            Some(stat) => {
                file.added = stat.added;
                file.deleted = stat.deleted;
                file.binary = stat.binary;
            }
            // Untracked files are in no diff, so their whole content counts as
            // added. The same goes for everything when there is no HEAD.
            None => {
                let (added, binary) = count_lines(&Path::new(&root).join(&file.path));
                file.added = added;
                file.binary = binary;
            }
        }
    }

    Ok(Changes {
        root,
        branch,
        files,
    })
}

/// One file's unified diff against HEAD, staged changes included.
///
/// `untracked` cannot be inferred here: the file is in no index and no
/// commit, so git has nothing to compare it against unless it is told to
/// treat it as a pair of paths.
#[tauri::command]
pub fn git_diff(root: String, path: String, untracked: bool) -> Result<String, String> {
    let spec = format!("./{path}");
    let out = if untracked {
        run(
            &root,
            &["diff", "--no-color", "--no-index", "--", "/dev/null", &spec],
        )?
    } else if has_head(&root) {
        run(&root, &["diff", "--no-color", "-M", "HEAD", "--", &path])?
    } else {
        // Nothing to diff against, so the index is the only other side.
        run(&root, &["diff", "--no-color", "--cached", "--", &path])?
    };

    // `--no-index` reports "these differ" as exit code 1, which is the
    // ordinary outcome here rather than a failure.
    if !out.status.success() && out.stdout.is_empty() {
        let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if why.is_empty() {
            format!("could not diff {path}")
        } else {
            why
        });
    }

    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    Ok(cap(text))
}

/// Cuts an enormous diff short on a character boundary, and says so, so the
/// pane shows the start of the change instead of freezing on it.
fn cap(mut text: String) -> String {
    if text.len() <= MAX_DIFF_BYTES {
        return text;
    }
    let mut end = MAX_DIFF_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push_str("\nroer: diff truncated — the rest is too large to show.\n");
    text
}

/// Branch name and changed files, from `status --porcelain=v2`.
fn parse_status(text: &str) -> (String, Vec<FileChange>) {
    let mut branch = String::new();
    let mut files: Vec<FileChange> = Vec::new();

    for line in text.lines() {
        if let Some(head) = line.strip_prefix("# branch.head ") {
            branch = head.to_string();
            continue;
        }
        let Some((kind, rest)) = line.split_once(' ') else {
            continue;
        };
        let parsed = match kind {
            "1" => ordinary(rest),
            "2" => renamed(rest),
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

/// `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>`
fn renamed(rest: &str) -> Option<FileChange> {
    let mut fields = rest.splitn(9, ' ');
    let xy = fields.next()?;
    for _ in 0..7 {
        fields.next()?;
    }
    let (path, original) = fields.next()?.split_once('\t')?;
    Some(change(xy, path, Some(original.to_string())))
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

/// `--numstat` rows: `<added>\t<deleted>\t<path>`, with `-` for a binary file.
fn numstat(text: &str) -> HashMap<String, Stat> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.splitn(3, '\t');
            let added = fields.next()?;
            let deleted = fields.next()?;
            let path = numstat_path(fields.next()?);
            Some((
                path,
                Stat {
                    added: added.parse().unwrap_or(0),
                    deleted: deleted.parse().unwrap_or(0),
                    binary: added == "-",
                },
            ))
        })
        .collect()
}

/// The new path of a `--numstat` row. Rename detection makes the path field a
/// move description — `old => new`, or `kept/{old => new}/tail` when the parts
/// share a prefix — and status reports renames under the new name, so that is
/// the half these counts belong to.
fn numstat_path(spec: &str) -> String {
    let Some((before, after)) = spec.split_once(" => ") else {
        return spec.to_string();
    };
    match before.split_once('{') {
        Some((prefix, _)) => {
            let (moved, tail) = after.split_once('}').unwrap_or((after, ""));
            format!("{prefix}{moved}{tail}")
        }
        None => after.to_string(),
    }
}

/// Lines in a file on disk, and whether it is binary. Used for the files git
/// has never seen, which are in no diff and so in no `--numstat` output.
fn count_lines(path: &Path) -> (u32, bool) {
    let Ok(meta) = std::fs::metadata(path) else {
        return (0, false);
    };
    // A symlink or a directory entry (a submodule) has no lines to count.
    if !meta.is_file() || meta.len() > MAX_COUNT_BYTES {
        return (0, false);
    }
    let Ok(bytes) = std::fs::read(path) else {
        return (0, false);
    };
    if bytes.is_empty() {
        return (0, false);
    }
    if bytes.iter().take(SNIFF_BYTES).any(|&b| b == 0) {
        return (0, true);
    }
    let newlines = bytes.iter().filter(|&&b| b == b'\n').count();
    // A file whose last line has no newline still shows that line.
    let lines = newlines + usize::from(*bytes.last().unwrap() != b'\n');
    (lines.min(u32::MAX as usize) as u32, false)
}

#[cfg(test)]
mod tests {
    use super::{count_lines, numstat, numstat_path, parse_status, Stat};

    #[test]
    fn reads_the_branch_and_an_ordinary_change() {
        let (branch, files) = parse_status(
            "# branch.oid 1234\n\
             # branch.head changes-view\n\
             1 .M N... 100644 100644 100644 abc def src/App.tsx\n",
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
        let (_, files) = parse_status("1 MM N... 100644 100644 100644 abc def a.txt\n");
        assert_eq!(files[0].staged, "M");
        assert_eq!(files[0].unstaged, "M");
    }

    #[test]
    fn parses_a_rename_with_its_original_path() {
        let (_, files) =
            parse_status("2 R. N... 100644 100644 100644 abc def R100 src/new.ts\tsrc/old.ts\n");
        assert_eq!(files[0].path, "src/new.ts");
        assert_eq!(files[0].renamed_from.as_deref(), Some("src/old.ts"));
        assert_eq!(files[0].staged, "R");
    }

    #[test]
    fn parses_an_unmerged_file() {
        let (_, files) =
            parse_status("u UU N... 100644 100644 100644 100644 a b c src/conflict.rs\n");
        assert_eq!(files[0].path, "src/conflict.rs");
        assert_eq!(files[0].staged, "U");
        assert_eq!(files[0].unstaged, "U");
    }

    #[test]
    fn marks_untracked_files_on_the_worktree_side() {
        let (_, files) = parse_status("? notes.md\n");
        assert_eq!(files[0].path, "notes.md");
        assert_eq!(files[0].staged, ".");
        assert_eq!(files[0].unstaged, "?");
    }

    #[test]
    fn tolerates_paths_with_spaces() {
        let (_, files) = parse_status(
            "1 .M N... 100644 100644 100644 abc def my docs/a note.md\n? other notes.md\n",
        );
        let paths: Vec<_> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["my docs/a note.md", "other notes.md"]);
    }

    #[test]
    fn ignores_headers_ignored_files_and_junk() {
        let (_, files) = parse_status(
            "# branch.ab +1 -0\n\
             ! target/debug/roer\n\
             \n\
             1 .M N... 100644 100644 100644 abc def kept.txt\n",
        );
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "kept.txt");
    }

    #[test]
    fn sorts_files_by_path() {
        let (_, files) = parse_status("? z.txt\n? a.txt\n? m/b.txt\n");
        let paths: Vec<_> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["a.txt", "m/b.txt", "z.txt"]);
    }

    #[test]
    fn counts_lines_per_file() {
        let stats = numstat("3\t1\tsrc/App.tsx\n0\t7\tgone.txt\n");
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
        let stats = numstat("-\t-\ticons/icon.icns\n");
        let stat = stats.get("icons/icon.icns").expect("row");
        assert!(stat.binary);
        assert_eq!((stat.added, stat.deleted), (0, 0));
    }

    #[test]
    fn attributes_a_rename_to_its_new_path() {
        assert_eq!(numstat_path("src/old.ts => src/new.ts"), "src/new.ts");
        // The braces hold the part that changed; everything else is shared.
        assert_eq!(
            numstat_path("src/{old => new}/index.ts"),
            "src/new/index.ts"
        );
        assert_eq!(numstat_path("plain/path.ts"), "plain/path.ts");
    }

    #[test]
    fn reads_a_real_repository() {
        // The parsing above is unit-tested against hand-written status lines;
        // this is the one test that proves those lines are what git emits.
        let dir = std::env::temp_dir().join(format!("roer-repo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        let at = dir.to_string_lossy().to_string();

        let must = |args: &[&str]| {
            let out = super::run(&at, args).unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        must(&["-c", "init.defaultBranch=main", "init", "-q"]);
        must(&["config", "user.email", "test@example.invalid"]);
        must(&["config", "user.name", "Roer Test"]);
        std::fs::write(dir.join("src/kept.txt"), "one\ntwo\nthree\n").unwrap();
        must(&["add", "."]);
        // Signing is a global setting, and a test must not depend on a key.
        must(&["-c", "commit.gpgsign=false", "commit", "-qm", "first"]);

        std::fs::write(dir.join("src/kept.txt"), "one\nTWO\nthree\n").unwrap();
        std::fs::write(dir.join("fresh.md"), "new\nfile\n").unwrap();

        let changes = super::git_changes(at.clone()).expect("changes");
        assert_eq!(changes.branch, "main");
        let paths: Vec<_> = changes.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["fresh.md", "src/kept.txt"]);

        let fresh = &changes.files[0];
        assert_eq!(fresh.unstaged, "?");
        // Nothing to compare it against, so every line of it is new.
        assert_eq!((fresh.added, fresh.deleted), (2, 0));

        let kept = &changes.files[1];
        assert_eq!((kept.staged.as_str(), kept.unstaged.as_str()), (".", "M"));
        assert_eq!((kept.added, kept.deleted), (1, 1));

        let diff =
            super::git_diff(changes.root.clone(), "src/kept.txt".to_string(), false).expect("diff");
        assert!(diff.contains("@@"), "{diff}");
        assert!(diff.contains("+TWO"), "{diff}");
        assert!(diff.contains("-two"), "{diff}");

        let added = super::git_diff(changes.root.clone(), "fresh.md".to_string(), true)
            .expect("diff of an untracked file");
        assert!(added.contains("+new"), "{added}");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn says_plainly_when_a_session_is_not_in_a_repository() {
        // git's own answer names `.git` and the walk up the parents, which
        // reads as something broken rather than as a session that simply
        // isn't in a repository.
        let dir = std::env::temp_dir().join(format!("roer-bare-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let at = dir.to_string_lossy().to_string();

        let err = super::git_changes(at.clone()).expect_err("no repository");
        assert_eq!(err, format!("{at} is not in a git repository."));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn counts_the_last_line_without_a_newline() {
        let dir = std::env::temp_dir().join(format!("roer-git-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let ended = dir.join("ended.txt");
        std::fs::write(&ended, "a\nb\n").unwrap();
        assert_eq!(count_lines(&ended), (2, false));

        let unfinished = dir.join("unfinished.txt");
        std::fs::write(&unfinished, "a\nb").unwrap();
        assert_eq!(count_lines(&unfinished), (2, false));

        let empty = dir.join("empty.txt");
        std::fs::write(&empty, "").unwrap();
        assert_eq!(count_lines(&empty), (0, false));

        let binary = dir.join("blob.bin");
        std::fs::write(&binary, [0x89, 0x50, 0x00, 0x4e]).unwrap();
        assert_eq!(count_lines(&binary), (0, true));

        assert_eq!(count_lines(&dir.join("missing.txt")), (0, false));

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
