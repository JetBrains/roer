//! Puts the `roer` Roer.app carries on the user's `PATH`, so that installing
//! the .dmg is the whole install: a terminal can type `roer shell` as soon as
//! the app has been opened once.
//!
//! The link goes in `~/.local/bin`, which needs no password and is where
//! Claude Code's own installer puts `claude`, so for most people it is on
//! `PATH` already. Only when a login shell still cannot find `roer` does the
//! app ask, once, for an administrator's password to link it into
//! `/usr/local/bin`, which every Mac has on `PATH`.
//!
//! It also has that `roer` install the skills it carries for Claude Code, and
//! register itself as an MCP server with Claude Code, so
//! sessions in any project know how to hand themselves over and show a UI.
//! `roer skills` and `roer mcp` own what that means, including staying out
//! once the person removes them.

use std::io::ErrorKind;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use crate::process::command;

const SYSTEM_LINK: &str = "/usr/local/bin/roer";

/// Links the bundled `roer` onto `PATH`, off the main thread: asking a login
/// shell can take a while, and the password prompt waits on the person.
pub fn install() {
    if !cfg!(target_os = "macos") {
        return;
    }
    std::thread::spawn(|| {
        if let Err(err) = link() {
            eprintln!("roer: could not put roer on PATH: {err}");
        }
    });
}

fn link() -> std::io::Result<()> {
    let Some(cli) = crate::roer::bundled() else {
        return Ok(());
    };
    // Straight off the .dmg, or from wherever Gatekeeper's translocation
    // copied a quarantined app, the path is gone by the next launch. The
    // copy in Applications links itself when it is opened.
    let cli_str = cli.to_string_lossy();
    if cli_str.starts_with("/Volumes/") || cli_str.contains("/AppTranslocation/") {
        return Ok(());
    }
    let Some(home) = crate::roer::home() else {
        return Ok(());
    };
    link_user(&cli, &home.join(".local/bin/roer"))?;
    install_auto(&cli, "skills");
    install_auto(&cli, "mcp");

    if shell_finds_roer() != Some(false) || taken(Path::new(SYSTEM_LINK), &cli) {
        return Ok(());
    }
    let declined = crate::history::roer_home().join("cli-link-declined");
    if declined.exists() {
        return Ok(());
    }
    if !link_system(&cli) {
        // Cancelled: asked once, not at every launch.
        std::fs::create_dir_all(declined.parent().unwrap_or(Path::new(".")))?;
        std::fs::write(&declined, "")?;
    }
    Ok(())
}

/// `roer <what> install --auto`: what is new installed, what is there kept
/// pointing at this app, nothing the person removed brought back.
fn install_auto(cli: &Path, what: &str) {
    let out = command(cli).args([what, "install", "--auto"]).stdin(Stdio::null()).output();
    match out {
        Ok(out) if out.status.success() && out.stderr.is_empty() => {}
        Ok(out) => eprintln!("roer: {what} install: {}", String::from_utf8_lossy(&out.stderr).trim()),
        Err(err) => eprintln!("roer: could not run {what} install: {err}"),
    }
}

/// `link` pointing at `cli`, replacing a link that points elsewhere: an older
/// app's, or the one the CLI tarball's install instructions made. A real
/// file there is someone's own install and is left alone.
fn link_user(cli: &Path, link: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(link) {
        Ok(meta) if meta.file_type().is_symlink() => {
            if points_at(link, cli) {
                return Ok(());
            }
            std::fs::remove_file(link)?;
        }
        Ok(_) => return Ok(()),
        Err(err) if err.kind() == ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }
    std::fs::create_dir_all(link.parent().unwrap_or(Path::new(".")))?;
    symlink(cli, link)
}

#[cfg(unix)]
fn symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(not(unix))]
fn symlink(_target: &Path, _link: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Whether `link` needs nothing from us: it already points at `cli`, or it
/// is a real file, someone's own install that `ln -sf` would destroy.
fn taken(link: &Path, cli: &Path) -> bool {
    match std::fs::symlink_metadata(link) {
        Ok(meta) => !meta.file_type().is_symlink() || points_at(link, cli),
        Err(_) => false,
    }
}

fn points_at(link: &Path, target: &Path) -> bool {
    std::fs::read_link(link).is_ok_and(|to| to == target)
}

/// Whether the person's shell, started as a new terminal starts it, finds a
/// `roer`: any `roer`, since one they installed themselves is theirs to keep.
/// Interactive as well as login, because `PATH` is as often set in `.zshrc`
/// as in `.zprofile`. None when the shell could not say in time, which is
/// never a reason to ask for a password.
fn shell_finds_roer() -> Option<bool> {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into());
    let mut child = command(&shell)
        .args(["-ilc", "command -v roer"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while child.try_wait().ok()?.is_none() {
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let out = child.wait_with_output().ok()?;
    // Whatever a shell's startup files print comes first; the answer is last.
    let last = String::from_utf8_lossy(&out.stdout).lines().rev().find(|l| !l.trim().is_empty()).map(str::to_owned);
    Some(out.status.success() && last.is_some_and(|l| l.trim_end().ends_with("/roer")))
}

/// Links `cli` as `/usr/local/bin/roer` behind macOS's own password prompt.
/// The path reaches the script as an argument, never pasted into it, so no
/// character in it can be read as AppleScript or shell. False if it was
/// refused or cancelled.
fn link_system(cli: &Path) -> bool {
    let script = [
        "on run argv",
        "do shell script \"mkdir -p /usr/local/bin && ln -sfn \" & quoted form of item 1 of argv & \" /usr/local/bin/roer\" \
         with prompt \"Roer wants to add the roer command to /usr/local/bin, so that your terminals can find it.\" \
         with administrator privileges",
        "end run",
    ];
    let mut osascript = command("osascript");
    for line in script {
        osascript.arg("-e").arg(line);
    }
    osascript
        .arg(cli)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(all(test, unix))]
mod tests {
    use super::{link_user, points_at, taken};

    fn dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("roer-cli-link-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn links_where_nothing_was() {
        let dir = dir("new");
        let link = dir.join(".local/bin/roer");
        link_user(&dir.join("Roer.app/Contents/MacOS/roer"), &link).unwrap();
        assert!(points_at(&link, &dir.join("Roer.app/Contents/MacOS/roer")));
    }

    #[test]
    fn replaces_a_link_to_another_roer() {
        let dir = dir("moved");
        let link = dir.join("roer");
        std::os::unix::fs::symlink(dir.join(".roer/bin/roer"), &link).unwrap();
        link_user(&dir.join("Roer.app/Contents/MacOS/roer"), &link).unwrap();
        assert!(points_at(&link, &dir.join("Roer.app/Contents/MacOS/roer")));
    }

    #[test]
    fn a_real_file_or_our_own_link_is_never_replaced_behind_the_password() {
        let dir = dir("system");
        let cli = dir.join("Roer.app/Contents/MacOS/roer");
        let own = dir.join("own");
        std::fs::write(&own, "#!/bin/sh\n").unwrap();
        assert!(taken(&own, &cli));
        let ours = dir.join("ours");
        std::os::unix::fs::symlink(&cli, &ours).unwrap();
        assert!(taken(&ours, &cli));
        let stale = dir.join("stale");
        std::os::unix::fs::symlink(dir.join("gone/roer"), &stale).unwrap();
        assert!(!taken(&stale, &cli));
        assert!(!taken(&dir.join("missing"), &cli));
    }

    #[test]
    fn leaves_a_real_file_alone() {
        let dir = dir("own");
        let link = dir.join("roer");
        std::fs::write(&link, "#!/bin/sh\n").unwrap();
        link_user(&dir.join("Roer.app/Contents/MacOS/roer"), &link).unwrap();
        assert_eq!(std::fs::read_to_string(&link).unwrap(), "#!/bin/sh\n");
    }
}
