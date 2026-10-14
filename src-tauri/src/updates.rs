//! Whether a newer Roer is out, so the app can say so.
//!
//! The answer is GitHub's latest release of this repository, which only ever
//! names a published one: a draft waiting to be signed, or a pre-release, is
//! never offered. It is read from where the releases page's `latest` redirects
//! rather than from GitHub's API, which allows 60 requests an hour to everyone
//! behind one address, so a shared VPN or office exit soon runs out of them.
//! It is fetched with the system's `curl`, as `bun_fetch` does.
//! The app only tells; downloading and installing is still the person's.

use serde::Serialize;

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
    // Only the headers of the first answer: its redirect is what's wanted.
    let out = crate::process::command("curl")
        .args(["--fail", "--silent", "--show-error", "--head", "--max-time", "15"])
        .arg(format!("{RELEASES}/latest"))
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

/// Reads GitHub's answer, the headers of a redirect to the latest release's
/// page. The page's address is built here from the tag rather than taken
/// from the answer, since it goes on to the opener.
fn status(current: &str, headers: &[u8], skipped: &str) -> Result<UpdateStatus, String> {
    let headers = String::from_utf8_lossy(headers);
    let location = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim().eq_ignore_ascii_case("location").then(|| value.trim())
        })
        .ok_or("GitHub's answer names no release")?;
    // With no release at all, `latest` sends to the list of releases instead.
    let tag = location
        .split_once("/releases/tag/")
        .map(|(_, tag)| tag.trim_end_matches('/'))
        .filter(|tag| !tag.is_empty() && !tag.contains(['/', '?', '#']))
        .ok_or("GitHub's answer names no release")?;
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
        format!("HTTP/2 302 \r\ndate: Wed, 14 Oct 2026 21:35:12 GMT\r\nLocation: https://github.com/JetBrains/roer/releases/tag/{tag}\r\n\r\n")
            .into_bytes()
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
    }

    #[test]
    fn a_redirect_to_no_release_is_an_error() {
        assert!(status("0.9.2", b"HTTP/2 200 \r\n\r\n", "").is_err());
        let to_list = b"HTTP/2 302 \r\nlocation: https://github.com/JetBrains/roer/releases\r\n\r\n";
        assert!(status("0.9.2", to_list, "").is_err());
    }
}
