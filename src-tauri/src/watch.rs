//! One watch per worktree, so the views are told about changes instead of
//! having to ask.
//!
//! Everything that shows a repository used to learn about a change by being
//! looked at: the diff view reloads when its tab comes to the front, a file
//! tab re-reads when it is activated, and the Go to File index is re-listed
//! on a timer. An agent edits files the whole time you are watching it, so
//! "when you look at it" is the wrong moment.
//!
//! macOS can simply say. A recursive watch here is one kernel-side FSEvents
//! stream, not a walk of the tree — measured at 4.9 ms to arm on a worktree
//! of 1.36M files — so watching costs nothing even where listing costs
//! twenty seconds.
//!
//! **A batch is classified by directory, never by file.** Twenty thousand
//! files written into an ignored build directory arrived here as 66,032
//! events naming 20,002 distinct paths and exactly *one* distinct parent
//! directory. Reducing to the directory is what turns that firehose into a
//! single question for git — answered "ignored" — after which the whole
//! burst reaches neither git nor the UI.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::ffi::OsStr;
use std::path::Path;
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::files::{self, Repos};
use crate::git;

/// Told to the frontend when something under a watched root changed.
pub const CHANGED_EVENT: &str = "roer://files-changed";

/// A batch closes after this much quiet …
const QUIET: Duration = Duration::from_millis(300);

/// … or this long after its first event, whichever comes first. A build that
/// writes continuously would otherwise never leave a gap to close on.
const MAX_WAIT: Duration = Duration::from_secs(2);

/// Distinct directories one batch may name before it gives up naming them
/// and asks for the whole repository to be listed again.
const MAX_DIRS: usize = 4096;

/// Directories one scoped listing may name. Git's cost here grows with the
/// number of pathspecs, not with what they cover: on a big repo one measured
/// at 0.21 s, sixteen at 0.31 s and three hundred at 2.32 s. This is where
/// the cheap part stops, and past it the ladder trades precision for it.
const MAX_SPECS: usize = 24;

/// Paths named in one event to the frontend. Past this it says `broad`
/// instead, and the views treat everything they are showing as suspect.
const MAX_EVENT_PATHS: usize = 64;

/// What changed under one root, as the frontend hears it.
#[derive(Debug, Clone, Serialize)]
pub struct Changed {
    /// The worktree root, in the same spelling the views were given.
    pub root: String,
    /// Repo-relative paths, sorted, at most [`MAX_EVENT_PATHS`] of them.
    pub paths: Vec<String>,
    /// More changed than `paths` names: take it as everything.
    pub broad: bool,
}

/// What one batch came to, once git has been asked which of it matters.
struct Settled {
    /// What the views are told.
    changed: Changed,
    /// The directories to re-list, or `None` for a batch that could not be
    /// narrowed to any — then the snapshot is retired and the next question
    /// pays for a full listing.
    relist: Option<Vec<String>>,
}

/// A live watch. Dropping it closes the channel its thread is reading, which
/// is how the thread is told to end.
pub(crate) struct Watch {
    _watcher: RecommendedWatcher,
}

/// Start watching `root`, reporting to `app` and marking `repos` stale.
pub(crate) fn arm(app: AppHandle, repos: Arc<Mutex<Repos>>, root: String) -> Result<Watch, String> {
    // FSEvents reports canonical paths, and a worktree under `/var` or a
    // symlinked home is reached by a name that is not the one it reports —
    // so the prefix events are stripped of has to be the canonical one, and
    // the root the frontend knows stays whatever it was told.
    let full = Path::new(&root)
        .canonicalize()
        .map_err(|e| format!("could not resolve {root}: {e}"))?;

    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher =
        notify::recommended_watcher(tx).map_err(|e| format!("could not start a watch: {e}"))?;
    watcher
        .watch(&full, RecursiveMode::Recursive)
        .map_err(|e| format!("could not watch {root}: {e}"))?;

    std::thread::spawn(move || run(&app, &repos, &root, &full, &rx));
    Ok(Watch { _watcher: watcher })
}

type Events = Receiver<notify::Result<notify::Event>>;

/// One thread per watched root: batch, ask git what matters, tell everyone.
fn run(app: &AppHandle, repos: &Arc<Mutex<Repos>>, root: &str, full: &Path, rx: &Events) {
    // Kept across batches, because the answer only changes when a
    // `.gitignore` does — and then the whole cache is dropped.
    let mut ignored: HashMap<String, bool> = HashMap::new();

    // The blocking wait for the first event of a batch is also what ends the
    // thread: the channel closes when the watch handle is dropped.
    while let Ok(first) = rx.recv() {
        let Some(settled) = settle(root, collect(rx, first, root, full), &mut ignored) else {
            continue;
        };
        // A patch is what keeps the index current, and a listing scoped to
        // what changed is what makes that affordable. When it cannot be done
        // the snapshot is retired instead — not rebuilt: nobody may be
        // looking at this repository, and the next question is what pays for
        // the listing, which is the bargain every snapshot is already served
        // under.
        if !patched(repos, root, settled.relist.as_deref()) {
            files::mark_stale(repos, root);
        }
        if let Err(e) = app.emit(CHANGED_EVENT, &settled.changed) {
            eprintln!("roer: could not report a change under {root}: {e}");
        }
    }
}

/// Everything else the watch has to say after `first`, up to the first quiet
/// or [`MAX_WAIT`].
fn collect(rx: &Events, first: notify::Result<notify::Event>, root: &str, full: &Path) -> Batch {
    let mut batch = Batch::default();
    batch.take(first, root, full);

    let opened = Instant::now();
    loop {
        let left = MAX_WAIT.saturating_sub(opened.elapsed());
        if left.is_zero() {
            break;
        }
        // Quiet closes the batch; so does the watcher going away, and the
        // next `recv` is where that is noticed and the thread ends.
        let Ok(event) = rx.recv_timeout(if QUIET < left { QUIET } else { left }) else {
            break;
        };
        batch.take(event, root, full);
    }
    batch
}

/// One batch of events, reduced as it arrives.
#[derive(Default)]
struct Batch {
    /// What to ask git about: one entry per changed directory, which is what
    /// keeps a firehose to a single question.
    dirs: HashSet<String>,
    /// Repo-relative paths, for the frontend, bounded by [`MAX_EVENT_PATHS`].
    paths: HashSet<String>,
    /// More changed than `paths` holds.
    broad: bool,
    /// The listing has to be taken whole: the watch dropped events, or the
    /// batch named more directories than it is worth naming.
    full: bool,
    /// A `.gitignore` moved, so every cached answer was given under the old
    /// one.
    ignores: bool,
}

impl Batch {
    fn take(&mut self, event: notify::Result<notify::Event>, root: &str, base: &Path) {
        let event = match event {
            Ok(event) => event,
            // The one failure that has to be loud: the snapshot is now wrong
            // in a way no later event will mention.
            Err(e) => {
                eprintln!("roer: the watch on {root} lost events: {e}");
                self.full = true;
                return;
            }
        };
        if event.need_rescan() {
            self.full = true;
        }

        for path in &event.paths {
            let Some(rel) = relative(base, path) else {
                continue;
            };
            // `.git` churns violently on every stage, commit and `gc`, and
            // changes neither answer: `--cached --others` covers the index
            // either way, and `git status` is re-asked from the worktree's
            // own events.
            if rel == ".git" || rel.starts_with(".git/") {
                continue;
            }
            if Path::new(&rel).file_name() == Some(OsStr::new(".gitignore")) {
                self.ignores = true;
            }

            let dir = unit(&rel);
            if self.dirs.len() < MAX_DIRS {
                self.dirs.insert(dir);
            } else if !self.dirs.contains(&dir) {
                self.full = true;
            }

            if self.paths.len() < MAX_EVENT_PATHS {
                self.paths.insert(rel);
            } else if !self.paths.contains(&rel) {
                self.broad = true;
            }
        }
    }
}

/// Where an absolute path sits inside the worktree, or `None` for one that
/// is not inside it at all.
fn relative(base: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(base).ok()?.to_str()?;
    (!rel.is_empty()).then(|| rel.to_string())
}

/// What a changed path asks to be re-listed.
///
/// Its directory, because everything under one directory is then one
/// question. A path at the top of the worktree stands for itself: its
/// directory is the whole repository, and that is the one pathspec that is
/// never cheap.
fn unit(rel: &str) -> String {
    match rel.rfind('/') {
        Some(slash) => rel[..slash].to_string(),
        None => rel.to_string(),
    }
}

/// What a batch means once git has been asked which of it matters.
///
/// `None` when nothing survives, which is the common case under an ignored
/// build — and then neither the index nor the UI hears about any of it.
fn settle(root: &str, batch: Batch, ignored: &mut HashMap<String, bool>) -> Option<Settled> {
    if batch.ignores {
        ignored.clear();
    }
    let live = keep(root, &batch.dirs, ignored);
    if live.is_empty() && !batch.full {
        return None;
    }

    // A batch that already knows it saw more than it can say cannot be
    // patched from, whatever narrowed out of it.
    let relist = if batch.full { None } else { fit(live) };

    let mut paths: Vec<String> = batch.paths.into_iter().collect();
    paths.sort_unstable();
    Some(Settled {
        changed: Changed {
            root: root.to_string(),
            paths,
            broad: batch.broad || batch.full,
        },
        relist,
    })
}

/// `dirs` reduced to at most [`MAX_SPECS`] pathspecs, or `None` when it
/// cannot be.
///
/// Three hundred precise directories cost git 2.32 s; the handful of coarse
/// subtrees they sit in cost 0.31 s and cover all of them. So the deepest
/// directories give up their last component, all of them in one sweep, until
/// few enough are left — at most as many sweeps as the deepest path is deep.
///
/// Reaching the top of the worktree is where it stops: a pathspec there is
/// the whole repository, which is the one listing this exists to avoid, so
/// the caller is told to retire the snapshot instead.
fn fit(dirs: Vec<String>) -> Option<Vec<String>> {
    // Sorted, because that is the order git is happiest asked in and the
    // order a test can assert; a set, because collapsing makes duplicates.
    let mut specs: BTreeSet<String> = dirs.into_iter().collect();
    while specs.len() > MAX_SPECS {
        let deepest = specs.iter().map(|one| depth(one)).max()?;
        if deepest == 0 {
            return None;
        }
        specs = specs
            .into_iter()
            .map(|one| {
                if depth(&one) == deepest {
                    parent(&one)
                } else {
                    one
                }
            })
            .collect();
    }
    Some(specs.into_iter().collect())
}

/// How far down the worktree a directory sits. The top is zero.
fn depth(dir: &str) -> usize {
    dir.matches('/').count()
}

/// The directory holding `dir`, or `dir` itself at the top of the worktree —
/// where there is nothing above it but the repository.
fn parent(dir: &str) -> String {
    match dir.rfind('/') {
        Some(slash) => dir[..slash].to_string(),
        None => dir.to_string(),
    }
}

/// Re-lists `dirs` and patches the snapshot from it. `false` when the index
/// is no better off for it and the snapshot should be retired instead.
fn patched(repos: &Arc<Mutex<Repos>>, root: &str, dirs: Option<&[String]>) -> bool {
    let Some(dirs) = dirs else { return false };
    let listing = match relist(root, dirs) {
        Ok(listing) => listing,
        Err(e) => {
            eprintln!("roer: could not list what changed under {root}: {e}");
            return false;
        }
    };
    match files::apply(repos, root, dirs, &listing) {
        Ok(done) => done,
        Err(e) => {
            eprintln!("roer: could not patch the index for {root}: {e}");
            false
        }
    }
}

/// What git says is under `dirs` now — the same listing a full build takes,
/// asked about a few directories instead of a repository.
fn relist(root: &str, dirs: &[String]) -> Result<String, String> {
    let specs: Vec<String> = dirs.iter().map(|dir| git::literal(dir)).collect();
    let mut args = vec![
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
    ];
    args.extend(specs.iter().map(String::as_str));
    git::git(root, &args)
}

/// The directories git does not ignore, asked in one batch and remembered.
fn keep(root: &str, dirs: &HashSet<String>, ignored: &mut HashMap<String, bool>) -> Vec<String> {
    let mut live = Vec::new();
    let mut ask = Vec::new();
    for dir in dirs {
        match known(dir, ignored) {
            Some(true) => {}
            Some(false) => live.push(dir.clone()),
            None => ask.push(dir.clone()),
        }
    }
    if ask.is_empty() {
        return live;
    }

    let answer = asked(root, &ask);
    for dir in ask {
        let is_ignored = answer.contains(&dir);
        ignored.insert(dir.clone(), is_ignored);
        if !is_ignored {
            live.push(dir);
        }
    }
    live
}

/// What the cache already knows about a directory, ancestors included: under
/// an ignored directory everything is ignored, so one answer settles a whole
/// subtree without asking again.
fn known(dir: &str, ignored: &HashMap<String, bool>) -> Option<bool> {
    let mut at = Some(dir);
    while let Some(part) = at {
        if ignored.get(part) == Some(&true) {
            return Some(true);
        }
        at = part.rfind('/').map(|slash| &part[..slash]);
    }
    ignored.get(dir).copied()
}

/// Which of `dirs` git ignores, in one call.
///
/// Anything that is not a plain answer is read as "ignores nothing", which
/// costs a listing that was not needed — the safe direction, against
/// silently dropping a directory that did change.
fn asked(root: &str, dirs: &[String]) -> HashSet<String> {
    let mut input = String::new();
    for dir in dirs {
        input.push_str(dir);
        input.push('\0');
    }

    let fed = match git::feed(root, &["check-ignore", "-z", "--stdin"], input) {
        Ok(fed) => fed,
        Err(e) => {
            eprintln!("roer: could not ask git what it ignores under {root}: {e}");
            return HashSet::new();
        }
    };
    // 0 is "some of these are ignored" and 1 is "none of them are". Anything
    // else is git having failed, and it says why on stderr.
    if !matches!(fed.code, Some(0) | Some(1)) {
        eprintln!(
            "roer: could not ask git what it ignores under {root}: {}",
            fed.stderr.trim()
        );
        return HashSet::new();
    }
    fed.stdout
        .split('\0')
        .filter(|one| !one.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};
    use std::path::{Path, PathBuf};

    use notify::event::{CreateKind, EventKind};
    use notify::{Event, Watcher};

    use super::{collect, fit, known, relative, settle, unit, Batch, MAX_EVENT_PATHS, MAX_SPECS};
    use crate::testing::{init, must, scratch, write};

    /// A create event naming every one of `paths`, as the watcher sees them:
    /// absolute, under the worktree.
    fn event(base: &Path, paths: &[&str]) -> notify::Result<Event> {
        Ok(Event {
            kind: EventKind::Create(CreateKind::Any),
            paths: paths.iter().map(|one| base.join(one)).collect(),
            attrs: Default::default(),
        })
    }

    fn batch(base: &Path, paths: &[&str]) -> Batch {
        let mut batch = Batch::default();
        batch.take(event(base, paths), "/repo", base);
        batch
    }

    #[test]
    fn stands_a_directory_in_for_every_file_under_it() {
        let base = PathBuf::from("/repo");
        let batch = batch(
            &base,
            &["src/App.tsx", "src/lib/files.ts", "src/lib/tabs.ts"],
        );
        // Three files, two directories — and twenty thousand files in one
        // directory would still be one.
        assert_eq!(
            batch.dirs,
            HashSet::from(["src".to_string(), "src/lib".to_string()])
        );
    }

    #[test]
    fn keeps_a_path_at_the_top_of_the_worktree_as_itself() {
        // Its directory is the whole repository, and listing that is the one
        // thing this is all here to avoid.
        assert_eq!(unit("README.md"), "README.md");
        assert_eq!(unit("src/App.tsx"), "src");
    }

    #[test]
    fn ignores_the_churn_inside_dot_git() {
        let base = PathBuf::from("/repo");
        let batch = batch(&base, &[".git/index", ".git/objects/ab/cdef", ".gitignore"]);
        // Only the `.gitignore`, which is not inside `.git` at all.
        assert_eq!(batch.dirs, HashSet::from([".gitignore".to_string()]));
        assert!(batch.ignores);
    }

    #[test]
    fn notices_a_gitignore_anywhere_in_the_tree() {
        let base = PathBuf::from("/repo");
        assert!(batch(&base, &["src/lib/.gitignore"]).ignores);
        // Not every file whose name merely ends that way.
        assert!(!batch(&base, &["src/notes.gitignore"]).ignores);
    }

    #[test]
    fn says_broad_rather_than_naming_more_paths_than_it_promised() {
        let base = PathBuf::from("/repo");
        let many: Vec<String> = (0..MAX_EVENT_PATHS + 10)
            .map(|i| format!("src/f{i}.ts"))
            .collect();
        let batch = batch(&base, &many.iter().map(String::as_str).collect::<Vec<_>>());
        assert_eq!(batch.paths.len(), MAX_EVENT_PATHS);
        assert!(batch.broad);
    }

    #[test]
    fn drops_a_path_that_is_not_under_the_worktree() {
        let base = Path::new("/repo");
        assert_eq!(
            relative(base, Path::new("/repo/src/App.tsx")).as_deref(),
            Some("src/App.tsx")
        );
        assert_eq!(relative(base, Path::new("/elsewhere/App.tsx")), None);
        // The root itself names nothing inside it.
        assert_eq!(relative(base, base), None);
    }

    #[test]
    fn takes_an_ignored_directory_as_settling_everything_under_it() {
        let mut ignored = HashMap::from([("target".to_string(), true)]);
        assert_eq!(known("target/debug/deps", &ignored), Some(true));
        assert_eq!(known("src", &ignored), None);
        ignored.insert("src".to_string(), false);
        assert_eq!(known("src", &ignored), Some(false));
    }

    #[test]
    fn drops_a_batch_git_ignores_entirely() {
        let dir = scratch("watch-ignored");
        let root = dir.to_str().expect("a utf-8 path");
        init(root);
        write(&dir, ".gitignore", "target/\n");
        write(&dir, "src/App.tsx", "export {};\n");
        must(root, &["add", "-A"]);

        let mut ignored = HashMap::new();
        let mut batch = Batch::default();
        batch.dirs.insert("target/debug".to_string());
        batch.paths.insert("target/debug/roer".to_string());
        // Nothing to tell anyone: a `cargo build` is not a change to the
        // repository, however many events it fires.
        assert!(settle(root, batch, &mut ignored).is_none());
        assert_eq!(ignored.get("target/debug"), Some(&true));

        let mut batch = Batch::default();
        batch.dirs.insert("src".to_string());
        batch.paths.insert("src/App.tsx".to_string());
        let settled = settle(root, batch, &mut ignored).expect("a change worth reporting");
        assert_eq!(settled.changed.paths, vec!["src/App.tsx".to_string()]);
        assert!(!settled.changed.broad);
        // And that one directory is what the scoped listing will ask about.
        assert_eq!(settled.relist.as_deref(), Some(&["src".to_string()][..]));
        // Asked once and remembered, so the next thousand events under it
        // cost nothing.
        assert_eq!(ignored.get("src"), Some(&false));
    }

    #[test]
    fn reports_a_batch_it_could_not_narrow_even_with_nothing_left_in_it() {
        let dir = scratch("watch-rescan");
        let root = dir.to_str().expect("a utf-8 path");
        init(root);

        // A watch that dropped events knows only that something happened.
        let batch = Batch {
            full: true,
            ..Default::default()
        };
        let settled = settle(root, batch, &mut HashMap::new()).expect("a change worth reporting");
        assert!(settled.changed.paths.is_empty());
        assert!(settled.changed.broad);
        // Nothing to scope a listing to, so the snapshot is retired and the
        // next question takes the full one.
        assert!(settled.relist.is_none());
    }

    #[test]
    fn collapses_more_directories_than_it_will_ask_git_about() {
        let deep: Vec<String> = (0..MAX_SPECS + 10)
            .map(|i| format!("src/lib/part{i}/inner"))
            .collect();
        let fitted = fit(deep).expect("a listing worth scoping");
        assert!(fitted.len() <= MAX_SPECS);
        // The deepest gave up their last component first, and then the next,
        // until one subtree covered the lot.
        assert_eq!(fitted, vec!["src/lib".to_string()]);
    }

    #[test]
    fn leaves_a_listing_it_can_already_afford_alone() {
        let few = vec!["src".to_string(), "docs/api".to_string()];
        // Sorted, which is the order git is asked in — and nothing dropped.
        assert_eq!(
            fit(few).expect("a listing worth scoping"),
            vec!["docs/api".to_string(), "src".to_string()]
        );
    }

    #[test]
    fn gives_up_rather_than_asking_for_the_whole_repository() {
        // Too many directories at the top of the worktree to narrow, and
        // their parent is the repository — the one listing worth avoiding.
        let top: Vec<String> = (0..MAX_SPECS + 1).map(|i| format!("dir{i}")).collect();
        assert!(fit(top).is_none());
    }
    #[test]
    fn hears_a_file_appear_in_the_worktree() {
        let dir = scratch("watch-live");
        let root = dir.to_str().expect("a utf-8 path");
        init(root);
        // The prefix events are stripped of, which under `/var` is not the
        // name the directory was made under.
        let base = dir.canonicalize().expect("a real path");

        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = notify::recommended_watcher(tx).expect("a watcher");
        watcher
            .watch(&base, notify::RecursiveMode::Recursive)
            .expect("a watch");

        write(&dir, "live.txt", "written by an agent\n");

        // Bounded, so a watch that never fires fails the test rather than
        // hanging the suite.
        let first = rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("an event");
        let batch = collect(&rx, first, root, &base);
        let settled = settle(root, batch, &mut HashMap::new()).expect("a change worth reporting");

        assert!(
            settled.changed.paths.iter().any(|one| one == "live.txt"),
            "expected live.txt among {:?}",
            settled.changed.paths
        );
        // A file at the top of the worktree stands for itself, so that is
        // the one pathspec the scoped listing goes out with.
        assert_eq!(
            settled.relist.as_deref(),
            Some(&["live.txt".to_string()][..])
        );

        drop(watcher);
        std::fs::remove_dir_all(&dir).expect("cleaned up");
    }
}
