//! Whether a newer Roer is out, so the app can say so.
//!
//! The answer is GitHub's latest release of this repository, which only ever
//! names a published one: a draft waiting to be signed, or a pre-release, is
//! never offered. It is fetched with the system's `curl`, as `bun_fetch` does.
//! The app only tells; downloading and installing is still the person's.

use serde::Serialize;

const LATEST: &str = "https://api.github.com/repos/JetBrains/roer/releases/latest";
const RELEASES: &str = "https://github.com/JetBrains/roer/releases";

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// The version running.
    pub current: String,
    /// The latest published release, as `0.9.3`.
    pub latest: String,
    /// `latest` is newer than `current`.
    pub newer: bool,
    /// The person chose to skip `latest` when it was offered before.
    pub skipped: bool,
    /// The release's page, where its notes and downloads are.
    pub url: String,
}

/// `$ROER_HOME/update-skipped` holds the one version the person skipped.
fn skipped_record() -> std::path::PathBuf {
    crate::history::roer_home().join("update-skipped")
}

/// The latest release against this one. `automatic` is the app checking on
/// its own, which a build from the checkout never does: it is not the
/// release it shares a version number with.
#[tauri::command(async)]
pub fn update_check(automatic: bool) -> Result<Option<UpdateStatus>, String> {
    if automatic && cfg!(debug_assertions) {
        return Ok(None);
    }
    let out = crate::process::command("curl")
        .args(["--fail", "--silent", "--show-error", "--location", "--max-time", "15"])
        .args(["--header", "Accept: application/vnd.github+json"])
        .arg(LATEST)
        .output()
        .map_err(|e| format!("could not run curl: {e}"))?;
    if !out.status.success() {
        let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!("could not reach GitHub: {}", if why.is_empty() { "curl failed".into() } else { why }));
    }
    let skipped = std::fs::read_to_string(skipped_record()).unwrap_or_default();
    status(env!("CARGO_PKG_VERSION"), &out.stdout, skipped.trim()).map(Some)
}

/// Don't offer `version` again; a later one still is.
#[tauri::command(async)]
pub fn update_skip(version: String) -> Result<(), String> {
    let path = skipped_record();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    }
    std::fs::write(&path, version).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// Reads GitHub's answer. The page's address is built here from the tag
/// rather than taken from the answer, since it goes on to the opener.
fn status(current: &str, body: &[u8], skipped: &str) -> Result<UpdateStatus, String> {
    let release: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("GitHub's answer is not JSON: {e}"))?;
    let tag = release["tag_name"].as_str().ok_or("GitHub's answer names no release")?;
    let latest = tag.strip_prefix('v').unwrap_or(tag);
    let Some(parsed) = version(latest) else {
        return Err(format!("the latest release, {tag}, is not a version"));
    };
    Ok(UpdateStatus {
        current: current.to_string(),
        latest: latest.to_string(),
        newer: version(current).is_some_and(|running| parsed > running),
        skipped: skipped == latest,
        url: format!("{RELEASES}/tag/{tag}"),
    })
}

/// `1.2.3` as numbers, so 0.10.0 comes after 0.9.2. Nothing else is a version.
fn version(text: &str) -> Option<(u64, u64, u64)> {
    let mut parts = text.split('.').map(|part| part.parse::<u64>().ok());
    let found = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str) -> Vec<u8> {
        serde_json::json!({ "tag_name": tag, "html_url": "https://example.com/elsewhere" }).to_string().into_bytes()
    }

    #[test]
    fn a_later_release_is_newer() {
        let found = status("0.9.2", &release("v0.10.0"), "").unwrap();
        assert_eq!(
            found,
            UpdateStatus {
                current: "0.9.2".into(),
                latest: "0.10.0".into(),
                newer: true,
                skipped: false,
                url: "https://github.com/JetBrains/roer/releases/tag/v0.10.0".into(),
            }
        );
    }

    #[test]
    fn the_same_or_an_earlier_release_is_not() {
        assert!(!status("0.9.2", &release("v0.9.2"), "").unwrap().newer);
        assert!(!status("0.9.2", &release("v0.9.1"), "").unwrap().newer);
    }

    #[test]
    fn a_skipped_release_says_so() {
        assert!(status("0.9.2", &release("v0.9.3"), "0.9.3").unwrap().skipped);
        assert!(!status("0.9.2", &release("v0.9.4"), "0.9.3").unwrap().skipped);
    }

    #[test]
    fn a_tag_that_is_not_a_version_is_an_error() {
        assert!(status("0.9.2", &release("nightly"), "").is_err());
        assert!(status("0.9.2", &release("v1.0.0-rc.1"), "").is_err());
        assert!(status("0.9.2", b"{}", "").is_err());
    }
}
