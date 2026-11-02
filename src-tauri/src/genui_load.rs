//! What a Generative UI `loadData` message reads, in Roer's panel: a file, or
//! a git command that only reads. The panel fills a data-model path with it,
//! and runs a load given `every` again on its own (`src/generative-ui/loads.ts`).
//!
//! An agent writes the message, and the panel runs it with no one asked, every
//! few seconds if it says so. So this reads only what the session could show
//! anyway and changes nothing: a file under the session's repository or
//! Roer's own folder, and `git` with a subcommand that only reads, never one
//! that writes a file (`--output`) or runs a program a repository names
//! (an external diff, a textconv filter, a file-system monitor).

use std::path::{Path, PathBuf};

/// How much one load hands back: enough for a branch's diff or a list as JSON.
const MAX_BYTES: usize = 4 * 1024 * 1024;

/// The git subcommands a load may run: each reads, and none writes the worktree, the index or a ref.
const GIT_READS: &[&str] = &["diff", "log", "show", "status", "rev-parse", "ls-files", "branch"];

/// Options no load may give git, whatever the subcommand: each writes a file or runs a program.
const GIT_REFUSED: &[&str] = &["--output", "--ext-diff", "--textconv", "-c", "--exec-path", "--git-dir", "--work-tree"];

/// `path` with a leading `~` as the home folder.
fn expand(path: &str) -> Option<PathBuf> {
    if path == "~" {
        return crate::roer::home();
    }
    match path.strip_prefix("~/") {
        Some(rest) => crate::roer::home().map(|home| home.join(rest)),
        None => Some(PathBuf::from(path)),
    }
}

/// `file`, resolved, if it lies under one of `roots` (each resolved too, so a link cannot lead out).
fn inside(file: &Path, roots: &[PathBuf]) -> Option<PathBuf> {
    let real = file.canonicalize().ok()?;
    roots
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .any(|root| real.starts_with(&root))
        .then_some(real)
}

/// Why `argv` is not a git command a load may run, or the arguments to give git: the subcommand first, with
/// `--no-ext-diff` and `--no-textconv` added where it diffs.
fn git_args(argv: &[String]) -> Result<Vec<String>, String> {
    let (Some(git), Some(sub)) = (argv.first(), argv.get(1)) else {
        return Err("a load runs `git <subcommand> …`".into());
    };
    if git != "git" {
        return Err(format!("Roer's panel runs only git for a load, not {git}"));
    }
    if !GIT_READS.contains(&sub.as_str()) {
        return Err(format!("`git {sub}` is not one a load may run (only {})", GIT_READS.join(", ")));
    }
    for arg in &argv[2..] {
        if let Some(bad) = GIT_REFUSED.iter().find(|bad| arg == *bad || arg.starts_with(&format!("{bad}="))) {
            return Err(format!("a load may not give git {bad}"));
        }
    }
    // `git branch` with names would make or delete one: only its listing forms.
    if sub == "branch" && !argv[2..].iter().all(|arg| ["--show-current", "--list", "-a", "-r", "--format"].iter().any(|ok| arg == ok || arg.starts_with("--format="))) {
        return Err("`git branch` only lists for a load (--show-current, --list, -a, -r, --format)".into());
    }
    let mut args = vec![sub.clone()];
    if ["diff", "log", "show"].contains(&sub.as_str()) {
        args.extend(["--no-ext-diff".to_string(), "--no-textconv".to_string()]);
    }
    args.extend(argv[2..].iter().cloned());
    Ok(args)
}

fn capped(mut text: String) -> Result<String, String> {
    if text.len() > MAX_BYTES {
        return Err(format!("it printed more than {} MB", MAX_BYTES / 1024 / 1024));
    }
    text.shrink_to_fit();
    Ok(text)
}

/// What one load reads: `file`'s text, or what `run` prints, for the session whose repository is `cwd`.
pub fn genui_load_core(cwd: &str, run: Option<Vec<String>>, file: Option<String>) -> Result<String, String> {
    match (run, file) {
        (Some(argv), None) => {
            let args = git_args(&argv)?;
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            capped(crate::git::git(cwd, &args)?)
        }
        (None, Some(file)) => {
            let path = expand(&file).ok_or("no home folder for ~")?;
            let path = if path.is_absolute() { path } else { Path::new(cwd).join(path) };
            let roots = [PathBuf::from(cwd), crate::history::roer_home()];
            let real = inside(&path, &roots)
                .ok_or_else(|| format!("{file} is not a file under the session's repository or Roer's folder"))?;
            let size = std::fs::metadata(&real).map_err(|e| format!("{file}: {e}"))?.len();
            if size as usize > MAX_BYTES {
                return Err(format!("{file} is more than {} MB", MAX_BYTES / 1024 / 1024));
            }
            std::fs::read_to_string(&real).map_err(|e| format!("{file}: {e}"))
        }
        _ => Err("a load reads one of run or file".into()),
    }
}

#[tauri::command(async)]
pub fn genui_load(cwd: String, run: Option<Vec<String>>, file: Option<String>) -> Result<String, String> {
    genui_load_core(&cwd, run, file)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn git_runs_only_reads_and_never_a_program_a_repository_names() {
        assert_eq!(git_args(&argv(&["git", "diff", "HEAD"])).unwrap(), argv(&["diff", "--no-ext-diff", "--no-textconv", "HEAD"]));
        assert_eq!(git_args(&argv(&["git", "status", "--short"])).unwrap(), argv(&["status", "--short"]));
        assert!(git_args(&argv(&["git", "commit", "-am", "x"])).is_err());
        assert!(git_args(&argv(&["git", "push"])).is_err());
        assert!(git_args(&argv(&["git", "diff", "--output=/tmp/x"])).is_err());
        assert!(git_args(&argv(&["git", "diff", "--ext-diff"])).is_err());
        assert!(git_args(&argv(&["git", "log", "-c"])).is_err());
        assert!(git_args(&argv(&["git", "branch", "gone"])).is_err());
        assert!(git_args(&argv(&["git", "branch", "--show-current"])).is_ok());
        assert!(git_args(&argv(&["sh", "-c", "rm -rf /"])).is_err());
        assert!(git_args(&argv(&["gh", "pr", "merge"])).is_err());
    }

    #[test]
    fn a_file_is_read_only_under_the_repository() {
        let dir = std::env::temp_dir().join(format!("roer-genui-load-{}", std::process::id()));
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(repo.join("data.json"), "{\"a\":1}").unwrap();
        std::fs::write(dir.join("secret"), "no").unwrap();
        let cwd = repo.to_string_lossy().to_string();
        assert_eq!(genui_load_core(&cwd, None, Some("data.json".into())).unwrap(), "{\"a\":1}");
        assert!(genui_load_core(&cwd, None, Some("../secret".into())).is_err());
        assert!(genui_load_core(&cwd, None, Some(dir.join("secret").to_string_lossy().to_string())).is_err());
        assert!(genui_load_core(&cwd, None, None).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
