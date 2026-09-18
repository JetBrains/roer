//! Scratch repositories for the tests, shared by the modules that need one.
//!
//! Hand-rolled rather than `tempfile`: a test dependency is still a
//! dependency, and a directory named after its test and this process is
//! enough to let the whole suite run in parallel.

use std::path::PathBuf;

/// An empty directory of this test's own, gone by the end of it.
pub(crate) fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("roer-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Runs git and fails the test with git's own complaint if it refuses.
pub(crate) fn must(at: &str, args: &[&str]) {
    let out = crate::git::run(at, args).unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// A repository that can commit without a key or a global identity.
pub(crate) fn init(at: &str) {
    must(at, &["-c", "init.defaultBranch=main", "init", "-q"]);
    must(at, &["config", "user.email", "test@example.invalid"]);
    must(at, &["config", "user.name", "Roer Test"]);
}

pub(crate) fn commit(at: &str, message: &str) {
    // Signing is a global setting, and a test must not depend on a key.
    must(
        at,
        &["-c", "commit.gpgsign=false", "commit", "-qm", message],
    );
}

/// Writes a file, making the directories above it first.
pub(crate) fn write(at: &std::path::Path, path: &str, text: &str) {
    let full = at.join(path);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(full, text).unwrap();
}
