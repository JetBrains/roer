//! `roer skills`: puts the skills that drive roer where an agent looks for
//! them, so a session in any project, not only this repository, knows how to
//! hand itself over or show a plugin UI.
//!
//! The skills ship beside the config: in the CLI archives next to roer, in
//! Roer.app's Resources, and in a checkout under `.claude/skills`. Each is
//! linked, not copied, into the agent's own skills directory, so updating Roer
//! updates the skills, and they always describe the roer they call.
//!
//! What roer installed is written down under `$ROER_HOME/skills`, and only
//! those entries are ever replaced or removed: a skill of the same name the
//! person made themselves is left alone. The app runs `install --auto` on
//! every launch; that mode never installs for someone who has not said yes
//! (the app asks first, then runs `install`), and it also remembers what the
//! person took away, so a link they delete, or `roer skills uninstall`, stays
//! done.

use std::collections::BTreeSet;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crate::{records, Fail, Outcome};

/// Where a copy (on Windows, where links need privileges) marks itself as
/// roer's, so it can be told from a directory the person made.
const MARKER: &str = ".roer-installed";

pub fn run(conf: &Path, args: &[&str]) -> Outcome {
    let (sub, rest) = args.split_first().map_or(("list", &[][..]), |(sub, rest)| (*sub, rest));
    let mut agent = "claude";
    let mut auto = false;
    let mut rest = rest.iter();
    while let Some(arg) = rest.next() {
        match *arg {
            "--agent" => agent = rest.next().ok_or_else(|| Fail::new(64, "--agent needs a name"))?,
            "--auto" if sub == "install" => auto = true,
            other => return Err(Fail::new(64, format!("unexpected argument: {other}"))),
        }
    }
    let target = Target::new(agent)?;
    let sources = sources(conf)?;
    match sub {
        "install" if auto => target.auto(&sources),
        "install" => target.install(&sources),
        "uninstall" => target.uninstall(),
        "list" | "ls" => target.list(&sources),
        other => Err(Fail::new(64, format!("unknown skills command: {other}"))),
    }
}

/// The skills this roer carries, by name: the directories holding a SKILL.md
/// beside the config, or in a debug build the checkout's `.claude/skills`.
fn sources(conf: &Path) -> Result<Vec<(String, PathBuf)>, Fail> {
    let mut dir = conf.with_file_name("skills");
    if !dir.is_dir() && cfg!(debug_assertions) {
        dir = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../.claude/skills"));
    }
    let entries = std::fs::read_dir(&dir)
        .map_err(|e| Fail::new(1, format!("no skills at {}: {e}", dir.display())))?;
    let mut found: Vec<(String, PathBuf)> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.join("SKILL.md").is_file())
        .filter_map(|path| Some((path.file_name()?.to_str()?.to_owned(), std::fs::canonicalize(&path).ok()?)))
        .collect();
    found.sort();
    Ok(found)
}

/// One agent's skills directory, and what roer remembers about it.
struct Target {
    agent: String,
    /// The agent's own directory: `install --auto` does nothing without it,
    /// so a Mac without the agent gets no directory made for it.
    root: PathBuf,
    dir: PathBuf,
    state: PathBuf,
}

/// What is at a skill's place in the agent's directory.
enum Place {
    Free,
    /// Something roer installed: a link, or a marked copy, it has on record.
    Ours,
    /// Anything else: the person's own, never touched.
    Theirs,
}

impl Target {
    fn new(agent: &str) -> Result<Self, Fail> {
        let root = match agent {
            "claude" => std::env::var_os("CLAUDE_CONFIG_DIR")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| records::user_home().join(".claude")),
            other => return Err(Fail::new(64, format!("unknown agent: {other} (known: claude)"))),
        };
        Ok(Target {
            agent: agent.to_owned(),
            dir: root.join("skills"),
            root,
            state: records::home().join("skills"),
        })
    }

    /// `roer skills install`: every skill, taking back an earlier uninstall.
    fn install(&self, sources: &[(String, PathBuf)]) -> Outcome {
        let mut installed = self.read("installed");
        let mut removed = self.read("removed");
        for (name, source) in sources {
            removed.remove(name);
            let dest = self.dir.join(name);
            match self.place(&dest, installed.contains(name)) {
                Place::Theirs => {
                    println!("{name}: left {} alone, it is not one roer installed", dest.display());
                    continue;
                }
                Place::Ours if is_current(&dest, source) => println!("{name}: up to date"),
                Place::Ours => {
                    remove(&dest).map_err(|e| io_fail(&dest, e))?;
                    put(source, &dest).map_err(|e| io_fail(&dest, e))?;
                    println!("{name}: updated at {}", dest.display());
                }
                Place::Free => {
                    put(source, &dest).map_err(|e| io_fail(&dest, e))?;
                    println!("{name}: installed at {}", dest.display());
                }
            }
            installed.insert(name.clone());
        }
        self.prune(sources, &mut installed);
        self.write("installed", &installed)?;
        self.write("removed", &removed)?;
        self.forget("declined")
    }

    /// What the app runs on launch: refreshes what is there, and installs a
    /// skill new in this roer, but only for someone who installed before —
    /// never a first install, and never what the person removed.
    fn auto(&self, sources: &[(String, PathBuf)]) -> Outcome {
        let opted_in = self.path("installed").exists();
        if !opted_in || self.path("declined").exists() || !self.root.is_dir() {
            return Ok(());
        }
        let mut installed = self.read("installed");
        let mut removed = self.read("removed");
        for (name, source) in sources {
            if removed.contains(name) {
                continue;
            }
            let dest = self.dir.join(name);
            let known = installed.contains(name);
            match self.place(&dest, known) {
                // Installed before and gone now, or replaced with their own:
                // the person's doing, so it stays that way.
                Place::Free | Place::Theirs if known => {
                    installed.remove(name);
                    removed.insert(name.clone());
                }
                Place::Theirs => {}
                Place::Ours if is_current(&dest, source) => {}
                Place::Ours => {
                    remove(&dest).map_err(|e| io_fail(&dest, e))?;
                    put(source, &dest).map_err(|e| io_fail(&dest, e))?;
                }
                Place::Free => {
                    put(source, &dest).map_err(|e| io_fail(&dest, e))?;
                    installed.insert(name.clone());
                }
            }
        }
        self.prune(sources, &mut installed);
        self.write("installed", &installed)?;
        self.write("removed", &removed)
    }

    /// `roer skills uninstall`: removes what roer installed, and keeps the app
    /// from installing it again until `roer skills install`.
    fn uninstall(&self) -> Outcome {
        let installed = self.read("installed");
        for name in &installed {
            let dest = self.dir.join(name);
            if let Place::Ours = self.place(&dest, true) {
                remove(&dest).map_err(|e| io_fail(&dest, e))?;
                println!("{name}: removed from {}", dest.display());
            }
        }
        self.write("installed", &BTreeSet::new())?;
        self.write("removed", &BTreeSet::new())?;
        self.write("declined", &BTreeSet::new())?;
        println!("Roer will not install its skills for {} again; `roer skills install` brings them back.", self.agent);
        Ok(())
    }

    /// `roer skills list`: each skill, and whether it is installed.
    fn list(&self, sources: &[(String, PathBuf)]) -> Outcome {
        let installed = self.read("installed");
        let removed = self.read("removed");
        for (name, source) in sources {
            let dest = self.dir.join(name);
            let status = match self.place(&dest, installed.contains(name)) {
                Place::Ours if is_current(&dest, source) => "installed",
                Place::Ours => "outdated",
                Place::Theirs => "not roer's",
                Place::Free if removed.contains(name) => "removed",
                Place::Free => "not installed",
            };
            println!("{name}\t{status}\t{}", dest.display());
        }
        if self.path("declined").exists() {
            println!("The app will not install these for {}; `roer skills install` turns that back on.", self.agent);
        }
        Ok(())
    }

    fn place(&self, dest: &Path, known: bool) -> Place {
        match std::fs::symlink_metadata(dest) {
            Err(e) if e.kind() == ErrorKind::NotFound => Place::Free,
            Ok(meta) if known && (meta.file_type().is_symlink() || dest.join(MARKER).is_file()) => Place::Ours,
            _ => Place::Theirs,
        }
    }

    /// Takes away what roer installed of a skill it no longer carries.
    fn prune(&self, sources: &[(String, PathBuf)], installed: &mut BTreeSet<String>) {
        installed.retain(|name| {
            if sources.iter().any(|(carried, _)| carried == name) {
                return true;
            }
            let dest = self.dir.join(name);
            if let Place::Ours = self.place(&dest, true) {
                let _ = remove(&dest);
            }
            false
        });
    }

    fn path(&self, what: &str) -> PathBuf {
        self.state.join(format!("{}-{what}", self.agent))
    }

    fn read(&self, what: &str) -> BTreeSet<String> {
        let text = std::fs::read_to_string(self.path(what)).unwrap_or_default();
        text.lines().filter(|line| !line.is_empty()).map(str::to_owned).collect()
    }

    fn write(&self, what: &str, names: &BTreeSet<String>) -> Outcome {
        let path = self.path(what);
        std::fs::create_dir_all(&self.state).map_err(|e| io_fail(&self.state, e))?;
        let text: String = names.iter().map(|name| format!("{name}\n")).collect();
        std::fs::write(&path, text).map_err(|e| io_fail(&path, e))
    }

    fn forget(&self, what: &str) -> Outcome {
        let path = self.path(what);
        match std::fs::remove_file(&path) {
            Err(e) if e.kind() != ErrorKind::NotFound => Err(io_fail(&path, e)),
            _ => Ok(()),
        }
    }
}

fn io_fail(path: &Path, e: std::io::Error) -> Fail {
    Fail::new(1, format!("{}: {e}", path.display()))
}

/// Whether `dest` already is `source`. A copy is never current: it is copied
/// again, which is cheap, rather than compared.
fn is_current(dest: &Path, source: &Path) -> bool {
    std::fs::read_link(dest).is_ok_and(|to| to == source)
}

#[cfg(unix)]
fn put(source: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest.parent().unwrap_or(Path::new(".")))?;
    std::os::unix::fs::symlink(source, dest)
}

#[cfg(not(unix))]
fn put(source: &Path, dest: &Path) -> std::io::Result<()> {
    copy_dir(source, dest)?;
    std::fs::write(dest.join(MARKER), "")
}

#[cfg(not(unix))]
fn copy_dir(source: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let to = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), to)?;
        }
    }
    Ok(())
}

fn remove(dest: &Path) -> std::io::Result<()> {
    if std::fs::symlink_metadata(dest)?.file_type().is_symlink() {
        std::fs::remove_file(dest)
    } else {
        std::fs::remove_dir_all(dest)
    }
}
