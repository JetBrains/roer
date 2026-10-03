//! Bun, downloaded the first time an extension needs it and kept from then on.
//!
//! Most people never make an extension, so Bun isn't shipped inside the app.
//! The first build or server start fetches one pinned release into
//! `$ROER_HOME/bun/<version>/`, checks it against the checksum written here,
//! and every later one finds it on disk. It is fetched with the system's
//! `curl`, which speaks the system's TLS and proxy settings and ships with
//! macOS and Windows 10 and later.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use sha2::{Digest, Sha256};

/// The release fetched, and the SHA-256 of each platform's archive as Bun's
/// own `SHASUMS256.txt` gives it. A new version is a change here.
const VERSION: &str = "1.3.13";
const ASSETS: &[(&str, &str, &str)] = &[
    ("macos", "aarch64", "5467e3f65dba526b9fea98f0cce04efafc0c63e169733ec27b876a3ad32da190"),
    ("macos", "x86_64", "e5a6c8b64f419925232d111ecb13e25f0abf55e54f792341f987623fd0778009"),
    ("linux", "aarch64", "70bae41b3908b0a120e1e58c5c8af30e74afae3b8d11b0d3fdd8e787ddfb4b22"),
    ("linux", "x86_64", "79c0771fa8b92c33aae41e15a0e0d307ea99d0e2f00317c71c6c53237a78e25a"),
    ("windows", "x86_64", "85b14f3e0584218e9b63407b3aa6b90c4835ec5c32435c1f12cb6fc13667c7c9"),
];

/// Bun's name for a platform, in its release archives' names.
fn asset_name(os: &str, arch: &str) -> String {
    let os = if os == "macos" { "darwin" } else { os };
    let arch = if arch == "x86_64" { "x64" } else { arch };
    format!("bun-{os}-{arch}")
}

fn exe_name() -> &'static str {
    if cfg!(windows) { "bun.exe" } else { "bun" }
}

/// Where the downloaded Bun lives once it has been fetched.
pub(crate) fn installed() -> PathBuf {
    crate::extensions::home().join("bun").join(VERSION).join(exe_name())
}

/// One download at a time: a build and a server starting together must not
/// both fetch it.
static FETCHING: Mutex<()> = Mutex::new(());

/// The downloaded Bun, fetched now unless it was before. `on_start` hears
/// when a download really begins, so the caller can say why it is waiting.
pub(crate) fn fetch(on_start: impl FnOnce(&str)) -> Result<PathBuf, String> {
    let _guard = FETCHING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let target = installed();
    // Fetched before, or by the call this one waited behind.
    if target.is_file() {
        return Ok(target);
    }
    let (os, arch) = (std::env::consts::OS, std::env::consts::ARCH);
    let Some((_, _, sha)) = ASSETS.iter().find(|(o, a, _)| *o == os && *a == arch) else {
        return Err(format!("there is no Bun release for {os} on {arch}"));
    };
    let name = asset_name(os, arch);
    on_start(&format!("downloading Bun {VERSION} (about 25 MB, once)"));

    let dir = target.parent().expect("a version folder");
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    // Unpacked aside and moved in whole, so a half-written Bun is never found.
    let partial = dir.join(format!(".partial-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&partial);
    std::fs::create_dir_all(&partial).map_err(|e| format!("{}: {e}", partial.display()))?;
    let result = download(&name, &partial).and_then(|archive| unpack(&archive, sha, &partial));
    let result = result.and_then(|exe| std::fs::rename(&exe, &target).map_err(|e| format!("{}: {e}", target.display())));
    let _ = std::fs::remove_dir_all(&partial);
    result.map(|()| target)
}

fn download(name: &str, into: &Path) -> Result<PathBuf, String> {
    let url = format!("https://github.com/oven-sh/bun/releases/download/bun-v{VERSION}/{name}.zip");
    let archive = into.join("bun.zip");
    let out = crate::process::command("curl")
        .args(["--fail", "--silent", "--show-error", "--location", "--retry", "2", "--output"])
        .arg(&archive)
        .arg(&url)
        .output()
        .map_err(|e| format!("could not run curl: {e}"))?;
    if !out.status.success() {
        let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!("could not download {url}: {}", if why.is_empty() { "curl failed".into() } else { why }));
    }
    Ok(archive)
}

/// Checks the archive against `sha`, then takes the one executable out of it.
fn unpack(archive: &Path, sha: &str, into: &Path) -> Result<PathBuf, String> {
    let bytes = std::fs::read(archive).map_err(|e| format!("{}: {e}", archive.display()))?;
    let got = hex(&Sha256::digest(&bytes));
    if got != sha {
        return Err(format!("the downloaded Bun is not the one expected (sha256 {got}, not {sha})"));
    }
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("the Bun archive: {e}"))?;
    let index = (0..zip.len())
        .find(|&i| zip.by_index(i).is_ok_and(|entry| entry.name().rsplit('/').next() == Some(exe_name())))
        .ok_or_else(|| format!("the Bun archive holds no {}", exe_name()))?;
    let mut entry = zip.by_index(index).map_err(|e| format!("the Bun archive: {e}"))?;
    let mut exe = Vec::new();
    entry.read_to_end(&mut exe).map_err(|e| format!("the Bun archive: {e}"))?;
    let path = into.join(exe_name());
    std::fs::write(&path, exe).map_err(|e| format!("{}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    Ok(path)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A zip laid out as Bun's are: one folder holding the executable.
    fn archive(at: &Path, exe: &[u8]) -> (PathBuf, String) {
        let path = at.join("bun.zip");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.add_directory("bun-test/", options).unwrap();
        zip.start_file(format!("bun-test/{}", exe_name()), options).unwrap();
        zip.write_all(exe).unwrap();
        zip.finish().unwrap();
        let sha = hex(&Sha256::digest(std::fs::read(&path).unwrap()));
        (path, sha)
    }

    /// The real download, against GitHub, into the `ROER_HOME` it is run with:
    /// `ROER_HOME=$(mktemp -d) cargo test --lib -- --ignored fetches_bun_once`
    #[test]
    #[ignore]
    fn fetches_bun_once() {
        assert!(std::env::var("ROER_HOME").is_ok_and(|h| !h.is_empty()), "set ROER_HOME to a scratch folder");
        let mut said = Vec::new();
        let bun = fetch(|what| said.push(what.to_string())).expect("fetched");
        assert_eq!(said.len(), 1, "{said:?}");
        let out = std::process::Command::new(&bun).arg("--version").output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), VERSION);

        // Fetched before: found on disk, nothing downloaded.
        let again = fetch(|what| panic!("downloaded again: {what}")).expect("found");
        assert_eq!(again, bun);
    }

    #[test]
    fn the_agents_guide_names_the_bun_roer_downloads() {
        let guide = include_str!("../../cli/src/ext/guide.md");
        assert!(guide.contains(&format!("~/.roer/bun/{VERSION}/bun")), "update cli/src/ext/guide.md to Bun {VERSION}");
    }

    #[test]
    fn names_each_platform_the_way_bun_releases_do() {
        assert_eq!(asset_name("macos", "aarch64"), "bun-darwin-aarch64");
        assert_eq!(asset_name("windows", "x86_64"), "bun-windows-x64");
        assert_eq!(asset_name("linux", "x86_64"), "bun-linux-x64");
    }

    #[test]
    fn has_a_checksum_for_the_platforms_roer_ships_on() {
        for (os, arch) in [("macos", "aarch64"), ("macos", "x86_64"), ("windows", "x86_64")] {
            let sha = ASSETS.iter().find(|(o, a, _)| *o == os && *a == arch).map(|(_, _, s)| *s);
            assert!(sha.is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())), "{os} {arch}");
        }
    }

    #[test]
    fn takes_the_executable_out_of_an_archive_that_matches_its_checksum() {
        let dir = crate::testing::scratch("bun-unpack");
        let (zip, sha) = archive(&dir, b"#!/bin/sh\necho 1.3.13\n");
        let exe = unpack(&zip, &sha, &dir).expect("unpacked");
        assert_eq!(std::fs::read(&exe).unwrap(), b"#!/bin/sh\necho 1.3.13\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&exe).unwrap().permissions().mode() & 0o777, 0o755);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_an_archive_that_is_not_the_one_expected() {
        let dir = crate::testing::scratch("bun-tampered");
        let (zip, _) = archive(&dir, b"not bun");
        let error = unpack(&zip, &"0".repeat(64), &dir).unwrap_err();
        assert!(error.contains("not the one expected"), "{error}");
        assert!(!dir.join(exe_name()).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
