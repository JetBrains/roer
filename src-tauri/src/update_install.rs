//! Installing a newer Roer in place of this one, from the update notice:
//! download, check, replace, start again.
//!
//! It takes the files every release already publishes, the ones a person
//! would download by hand, and installs one only when it passes the check
//! its platform has: on macOS, Roer.app signed with JetBrains' Developer ID
//! and notarized; on Windows, the setup signed by JetBrains. Each file must
//! also match the release's `SHA256SUMS.txt`, which on Linux is the only
//! check there is, as it is for a download by hand. An unsigned draft that
//! was published by mistake is turned away rather than installed.
//!
//! Sessions run in tmux, not in the app, so the app quitting to start again
//! leaves every one running; the new app finds them as a relaunch would.
//!
//! Where the app cannot replace itself (a build from the checkout, an app
//! opened straight off the .dmg, an .msi install, a Linux package with no
//! `pkexec` to ask for the password), the notice keeps offering the
//! release's page instead.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use crate::process::command;

/// JetBrains' Apple Developer team, the one Roer.app is signed by.
const TEAM_ID: &str = "2ZEFAR8TH3";
/// The subject JetBrains' Windows code-signing certificate starts with.
const WINDOWS_SIGNER: &str = "CN=JetBrains s.r.o.";
const BUNDLE_ID: &str = "com.jetbrains.roer";
const PKEXEC: &str = "/usr/bin/pkexec";
const PROGRESS_EVENT: &str = "roer://update-progress";

/// How this copy of the app is replaced.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Method {
    /// Roer.app at this path, by the one in the release's .dmg.
    MacApp(PathBuf),
    /// The per-user install the setup .exe made, by the new setup run
    /// without questions; it closes the app and starts it again itself.
    WindowsSetup,
    /// This AppImage, by the new one.
    AppImage(PathBuf),
    /// The installed .deb, through apt behind `pkexec`'s password prompt.
    Deb,
    /// The installed .rpm, the same way.
    Rpm,
}

impl Method {
    /// The release's file for it, as `release.yml` names them.
    fn asset(&self, version: &str) -> String {
        match self {
            Method::MacApp(_) => format!("Roer_{version}_universal.dmg"),
            Method::WindowsSetup => format!("Roer_{version}_x64-setup.exe"),
            Method::AppImage(_) => format!("Roer_{version}_amd64.AppImage"),
            Method::Deb => format!("Roer_{version}_amd64.deb"),
            Method::Rpm => format!("Roer-{version}-1.x86_64.rpm"),
        }
    }
}

/// How this app would replace itself, or None where it cannot.
pub(crate) fn method() -> Option<Method> {
    // The e2e tests' stand-in for an AppImage, in a debug build only.
    if let Some(file) = crate::updates::test_override("ROER_UPDATE_TARGET") {
        return Some(Method::AppImage(PathBuf::from(file)));
    }
    // Only an installed app: a build from the checkout has no `roer` in it.
    crate::roer::shipped()?;
    let exe = std::env::current_exe().ok()?;
    if cfg!(target_os = "macos") {
        let bundle = exe.parent()?.parent()?.parent()?.to_path_buf();
        let text = bundle.to_string_lossy();
        // Straight off the .dmg, or Gatekeeper's translocated copy of a
        // quarantined app: neither is where the app is installed.
        let installed = bundle.extension().is_some_and(|ext| ext == "app")
            && !text.starts_with("/Volumes/")
            && !text.contains("/AppTranslocation/");
        installed.then_some(Method::MacApp(bundle))
    } else if cfg!(windows) {
        // The setup .exe installs per user, under the local app data; the
        // .msi for the whole machine, under Program Files, and a setup run
        // over it would leave two installs.
        let local = std::env::var_os("LOCALAPPDATA").filter(|dir| !dir.is_empty())?;
        exe.starts_with(local).then_some(Method::WindowsSetup)
    } else if cfg!(target_os = "linux") && std::env::consts::ARCH == "x86_64" {
        if let Some(image) = crate::roer::appimage() {
            return Some(Method::AppImage(image));
        }
        if !Path::new(PKEXEC).is_file() {
            return None;
        }
        if succeeds("dpkg-query", &["--show", "roer"]) {
            Some(Method::Deb)
        } else if succeeds("rpm", &["--query", "roer"]) {
            Some(Method::Rpm)
        } else {
            None
        }
    } else {
        None
    }
}

fn succeeds(program: &str, args: &[&str]) -> bool {
    command(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    /// `download`, `verify`, `install` or `restart`.
    stage: &'static str,
    /// Bytes downloaded so far.
    received: u64,
    /// The download's size, when GitHub said.
    total: Option<u64>,
}

/// One update at a time, whatever the notice lets through.
static INSTALLING: AtomicBool = AtomicBool::new(false);

/// Downloads `version`, checks it, puts it in place of this app and starts
/// it, quitting this one. Says how far it got as `roer://update-progress`.
/// Returns only if it failed, with the app as it was.
#[tauri::command(async)]
pub fn update_install(app: AppHandle, version: String) -> Result<(), String> {
    if crate::updates::version(&version).is_none() {
        return Err(format!("{version} is not a version"));
    }
    let method = method().ok_or("This copy of Roer cannot update itself. Download the new version instead.")?;
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("Roer is already updating".into());
    }
    let emit = |stage: &'static str, received: u64, total: Option<u64>| {
        let _ = app.emit(PROGRESS_EVENT, Progress { stage, received, total });
    };
    let dir = crate::history::roer_home().join("update");
    let result = install(&method, &version, &dir, &emit);
    match result {
        Ok(mut relaunch) => {
            emit("restart", 0, None);
            if let Err(err) = relaunch.spawn() {
                INSTALLING.store(false, Ordering::SeqCst);
                return Err(format!("Roer {version} is installed, but could not be started ({err}). Quit Roer and open it again."));
            }
            // On Windows the setup is still to run and needs its own file;
            // elsewhere what was downloaded is spent.
            if method != Method::WindowsSetup {
                let _ = std::fs::remove_dir_all(&dir);
            }
            app.exit(0);
            Ok(())
        }
        Err(err) => {
            INSTALLING.store(false, Ordering::SeqCst);
            eprintln!("roer: update to {version} failed: {err}");
            Err(err)
        }
    }
}

/// Everything up to the start of the new app, which is what it returns.
fn install(method: &Method, version: &str, dir: &Path, emit: &dyn Fn(&'static str, u64, Option<u64>)) -> Result<Command, String> {
    // What an earlier try left behind, the Windows setup of the last update included.
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    // Before the install changes what it points at: a replaced Linux
    // executable reads as "… (deleted)".
    let exe = std::env::current_exe().map_err(|e| format!("could not tell where Roer is: {e}"))?;

    let asset = method.asset(version);
    let release = format!("{}/download/v{version}", crate::updates::releases());
    let sums = fetch_text(&format!("{release}/SHA256SUMS.txt"))?;
    let expected = checksum_for(&sums, &asset).ok_or_else(|| format!("the release lists no checksum for {asset}"))?;
    let file = dir.join(&asset);
    download(&format!("{release}/{asset}"), &file, &|received, total| emit("download", received, total))?;

    emit("verify", 0, None);
    let actual = sha256(&file)?;
    if actual != expected {
        return Err(format!("the downloaded {asset} does not match the release's checksum"));
    }

    emit("install", 0, None);
    match method {
        Method::MacApp(bundle) => {
            install_mac(&file, bundle, version, dir)?;
            // Through Launch Services, as Finder opens it.
            Ok(after_exit(Path::new("/usr/bin/open"), &[bundle.as_os_str()]))
        }
        Method::WindowsSetup => {
            check_windows(&file)?;
            // Passive: a progress bar and no questions. It closes this app,
            // installs over it in place, and with /R starts it again.
            let mut setup = command(&file);
            setup.args(["/P", "/UPDATE", "/R"]);
            Ok(setup)
        }
        Method::AppImage(image) => {
            replace_file(&file, image)?;
            Ok(after_exit(image, &[]))
        }
        Method::Deb | Method::Rpm => {
            install_package(method, &file, version)?;
            Ok(after_exit(&exe, &[]))
        }
    }
}

/// The checksum `SHA256SUMS.txt` gives for `name`, in `shasum`'s layout:
/// the hash, then the name, with a `*` before it for binary mode.
fn checksum_for(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let (hash, file) = line.trim().split_once(char::is_whitespace)?;
        let file = file.trim_start();
        let file = file.strip_prefix('*').unwrap_or(file);
        let valid = hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit());
        (file == name && valid).then(|| hash.to_ascii_lowercase())
    })
}

fn sha256(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(crate::bun_fetch::hex(&hasher.finalize()))
}

fn curl_error(out: &std::process::Output) -> String {
    let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
    format!("could not reach GitHub: {}", if why.is_empty() { "curl failed".into() } else { why })
}

fn fetch_text(url: &str) -> Result<String, String> {
    let out = command("curl")
        .args(["--fail", "--silent", "--show-error", "--location", "--max-time", "30"])
        .arg(url)
        .output()
        .map_err(|e| format!("could not run curl: {e}"))?;
    if !out.status.success() {
        return Err(curl_error(&out));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Downloads `url` to `to`, telling `progress` how much has arrived a few
/// times a second.
fn download(url: &str, to: &Path, progress: &dyn Fn(u64, Option<u64>)) -> Result<(), String> {
    let total = size_of(url);
    let mut curl = command("curl")
        .args(["--fail", "--silent", "--show-error", "--location", "--retry", "2", "--connect-timeout", "15", "--output"])
        .arg(to)
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run curl: {e}"))?;
    loop {
        match curl.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(e) => return Err(format!("curl: {e}")),
        }
        progress(std::fs::metadata(to).map(|meta| meta.len()).unwrap_or(0), total);
        std::thread::sleep(Duration::from_millis(250));
    }
    let out = curl.wait_with_output().map_err(|e| format!("curl: {e}"))?;
    if !out.status.success() {
        return Err(curl_error(&out));
    }
    Ok(())
}

/// The download's size, for the progress bar; None when GitHub won't say.
fn size_of(url: &str) -> Option<u64> {
    let out = command("curl")
        .args(["--fail", "--silent", "--head", "--location", "--max-time", "15"])
        .arg(url)
        .output()
        .ok()?;
    out.status.success().then(|| content_length(&String::from_utf8_lossy(&out.stdout))).flatten()
}

/// The last `Content-Length` in a chain of answers: the file's, after the
/// redirects to where it is stored.
fn content_length(headers: &str) -> Option<u64> {
    headers
        .lines()
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim().eq_ignore_ascii_case("content-length").then(|| value.trim().parse().ok())?
        })
        .next_back()
        .filter(|&size| size > 0)
}

/// Runs `cmd` to the end; on failure says `what`, with what it printed.
fn run(cmd: &mut Command, what: &str) -> Result<std::process::Output, String> {
    let out = cmd.stdin(Stdio::null()).output().map_err(|e| format!("{what}: {e}"))?;
    if !out.status.success() {
        let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if why.is_empty() { what.to_string() } else { format!("{what}: {why}") });
    }
    Ok(out)
}

/// Takes Roer.app out of the .dmg, checks it, and puts it where `bundle` is.
fn install_mac(dmg: &Path, bundle: &Path, version: &str, dir: &Path) -> Result<(), String> {
    let mount = dir.join("mount");
    std::fs::create_dir_all(&mount).map_err(|e| format!("could not create {}: {e}", mount.display()))?;
    run(
        command("hdiutil").args(["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint"]).arg(&mount).arg(dmg),
        "could not open the .dmg",
    )?;
    let staged = dir.join("Roer.app");
    // ditto, never cp: it keeps the symlinks and attributes the signature
    // depends on.
    let copied = run(command("ditto").arg(mount.join("Roer.app")).arg(&staged), "could not copy Roer.app out of the .dmg");
    if run(command("hdiutil").args(["detach", "-quiet"]).arg(&mount), "").is_err() {
        let _ = run(command("hdiutil").args(["detach", "-quiet", "-force"]).arg(&mount), "");
    }
    copied?;
    check_mac(&staged, version)?;
    replace_dir(bundle, &staged, version)
}

/// The code requirement Roer.app has to meet: a Developer ID, which only
/// Apple issues, of JetBrains' team.
fn mac_requirement() -> String {
    format!("=anchor apple generic and certificate leaf[subject.OU] = \"{TEAM_ID}\"")
}

/// Roer.app as JetBrains signed it, notarized, and the version asked for.
fn check_mac(app: &Path, version: &str) -> Result<(), String> {
    run(
        command("codesign").args(["--verify", "--deep", "--strict"]).arg(format!("-R{}", mac_requirement())).arg(app),
        "the Roer.app in the .dmg is not signed by JetBrains",
    )?;
    let assessed = command("spctl")
        .args(["--assess", "--type", "execute", "-vv"])
        .arg(app)
        .output()
        .map_err(|e| format!("could not run spctl: {e}"))?;
    if !assessed.status.success() || !String::from_utf8_lossy(&assessed.stderr).contains("source=Notarized Developer ID") {
        return Err("the Roer.app in the .dmg is not notarized by Apple".into());
    }
    let plist = app.join("Contents/Info.plist");
    let read = |key: &str| {
        run(command("plutil").args(["-extract", key, "raw", "-o", "-"]).arg(&plist), "could not read Roer.app's Info.plist")
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    if read("CFBundleIdentifier")? != BUNDLE_ID {
        return Err("the .dmg holds some other app than Roer".into());
    }
    let found = read("CFBundleShortVersionString")?;
    if found != version {
        return Err(format!("the .dmg holds Roer {found}, not {version}"));
    }
    Ok(())
}

/// Puts `staged` where `target` is, keeping `target` until the new one is
/// in place, and putting it back if it could not be. Behind macOS's password
/// prompt when the folder it is in is not the person's to change.
fn replace_dir(target: &Path, staged: &Path, version: &str) -> Result<(), String> {
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let aside = target.with_file_name(format!(".{name}.replaced-{}", std::process::id()));
    match std::fs::rename(target, &aside) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::PermissionDenied && cfg!(target_os = "macos") => {
            return replace_dir_as_admin(target, &aside, staged, version);
        }
        Err(e) => return Err(format!("could not move {} aside: {e}", target.display())),
    }
    // A rename unless the two are on different volumes.
    let moved = std::fs::rename(staged, target)
        .map_err(|e| e.to_string())
        .or_else(|_| run(command("ditto").arg(staged).arg(target), "could not copy the new Roer.app in").map(|_| ()));
    if let Err(err) = moved {
        let _ = std::fs::remove_dir_all(target);
        let _ = std::fs::rename(&aside, target);
        return Err(err);
    }
    // The running app's files go with it; it has them open, so it carries on.
    let _ = std::fs::remove_dir_all(&aside);
    Ok(())
}

/// `replace_dir`, as root. The paths reach the shell as arguments, quoted by
/// AppleScript, so nothing in them is read as AppleScript or shell.
fn replace_dir_as_admin(target: &Path, aside: &Path, staged: &Path, version: &str) -> Result<(), String> {
    let prompt = format!("Roer wants to install version {version} in place of this one.");
    let script = [
        "on run argv",
        "set {dest, oldCopy, newCopy, why} to {quoted form of item 1 of argv, quoted form of item 2 of argv, quoted form of item 3 of argv, item 4 of argv}",
        "do shell script \"/bin/mv \" & dest & \" \" & oldCopy & \" && { /usr/bin/ditto \" & newCopy & \" \" & dest & \" || { /bin/rm -rf \" & dest & \"; /bin/mv \" & oldCopy & \" \" & dest & \"; exit 1; }; } && /bin/rm -rf \" & oldCopy \
         with prompt why with administrator privileges",
        "end run",
    ];
    let mut osascript = command("osascript");
    for line in script {
        osascript.arg("-e").arg(line);
    }
    let out = osascript
        .arg(target)
        .arg(aside)
        .arg(staged)
        .arg(prompt)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not run osascript: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    // -128 is "User canceled."
    if String::from_utf8_lossy(&out.stderr).contains("-128") {
        return Err("The password was not given, so Roer was not updated.".into());
    }
    Err(format!("could not replace {}: {}", target.display(), String::from_utf8_lossy(&out.stderr).trim()))
}

/// The setup signed by JetBrains, with a signature Windows trusts. The path
/// reaches PowerShell as an environment variable, never pasted into the
/// command, so no character in it is read as PowerShell.
fn check_windows(setup: &Path) -> Result<(), String> {
    let out = run(
        command("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command"])
            .arg("$s = Get-AuthenticodeSignature -LiteralPath $env:ROER_UPDATE_FILE; \"$($s.Status)|$($s.SignerCertificate.Subject)\"")
            .env("ROER_UPDATE_FILE", setup),
        "could not check the setup's signature",
    )?;
    let answer = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if signed_by_jetbrains(&answer) {
        Ok(())
    } else {
        Err("the downloaded setup is not signed by JetBrains".into())
    }
}

/// PowerShell's `Status|Subject` for a signature.
fn signed_by_jetbrains(answer: &str) -> bool {
    answer.split_once('|').is_some_and(|(status, subject)| status == "Valid" && subject.starts_with(WINDOWS_SIGNER))
}

/// Puts `new` where `target` is: copied beside it first, so the swap is one
/// rename and a failed copy leaves the old one whole.
fn replace_file(new: &Path, target: &Path) -> Result<(), String> {
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let partial = target.with_file_name(format!(".{name}.update-{}", std::process::id()));
    let result = std::fs::copy(new, &partial)
        .and_then(|_| {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&partial, std::fs::Permissions::from_mode(0o755))?;
            }
            std::fs::rename(&partial, target)
        })
        .map_err(|e| format!("could not replace {}: {e}", target.display()));
    if result.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    result
}

/// Installs the package through apt, or rpm, as root: `pkexec` asks for the
/// password the way the desktop does.
fn install_package(method: &Method, file: &Path, version: &str) -> Result<(), String> {
    let mut pkexec = command(PKEXEC);
    if *method == Method::Deb && Path::new("/usr/bin/apt-get").is_file() {
        // apt rather than dpkg, so a dependency a new version added comes too.
        pkexec.args(["/usr/bin/apt-get", "install", "--yes"]).arg(file);
    } else if *method == Method::Deb {
        pkexec.args(["/usr/bin/dpkg", "--install"]).arg(file);
    } else {
        pkexec.args(["/usr/bin/rpm", "--upgrade"]).arg(file);
    }
    let out = pkexec.stdin(Stdio::null()).output().map_err(|e| format!("could not run pkexec: {e}"))?;
    match out.status.code() {
        Some(0) => Ok(()),
        Some(126) => Err("The password was not given, so Roer was not updated.".into()),
        Some(127) => Err(format!("Installing Roer {version} was not allowed. Download it and install it yourself instead.")),
        _ => {
            let why = String::from_utf8_lossy(&out.stderr);
            let last = why.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or("it failed");
            Err(format!("could not install the package: {}", last.trim()))
        }
    }
}

/// Starts `program` once this process has gone: with the single-instance
/// plugin, a new app started any sooner would hand itself to this one and
/// quit. In a session of its own, so this app's exit takes nothing with it,
/// and without the AppImage's variables, which belong to this run of it.
fn after_exit(program: &Path, args: &[&std::ffi::OsStr]) -> Command {
    after_exit_of(std::process::id(), program, args)
}

fn after_exit_of(pid: u32, program: &Path, args: &[&std::ffi::OsStr]) -> Command {
    let mut waiter = command("/bin/sh");
    waiter
        .args(["-c", "pid=$1; shift; while kill -0 \"$pid\" 2>/dev/null; do sleep 0.2; done; exec \"$@\"", "sh"])
        .arg(pid.to_string())
        .arg(program)
        .args(args)
        .env_remove("APPIMAGE")
        .env_remove("APPDIR")
        .env_remove("ARGV0")
        .env_remove("OWD")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid is async-signal-safe and touches no memory.
        unsafe {
            waiter.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    waiter
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUMS: &str = "\
232450ffa013360754d66f232a602de3c7f93e82bd96ffcea368b2bb05198da9  Roer_0.9.10_universal.dmg
0d17dfbc1de4c8b8bd2cd1d1be5b76155ceb1b61f5362e1d1427b9635981cab1  Roer_0.9.10_amd64.deb
59FC5FE4E2B6CDEEF3B8D7C2827FF01C5BD384002483D53E8A4210CA7507172D *Roer_0.9.10_x64-setup.exe
nothex  Roer_0.9.10_amd64.AppImage
";

    #[test]
    fn finds_each_files_checksum() {
        assert_eq!(
            checksum_for(SUMS, "Roer_0.9.10_universal.dmg").as_deref(),
            Some("232450ffa013360754d66f232a602de3c7f93e82bd96ffcea368b2bb05198da9")
        );
        // Binary mode's `*`, and upper case, as other tools write them.
        assert_eq!(
            checksum_for(SUMS, "Roer_0.9.10_x64-setup.exe").as_deref(),
            Some("59fc5fe4e2b6cdeef3b8d7c2827ff01c5bd384002483d53e8a4210ca7507172d")
        );
        assert_eq!(checksum_for(SUMS, "Roer_0.9.10_amd64.AppImage"), None);
        assert_eq!(checksum_for(SUMS, "Roer_0.9.10_amd64.rpm"), None);
        // A name is matched whole.
        assert_eq!(checksum_for(SUMS, "universal.dmg"), None);
    }

    #[test]
    fn names_the_files_release_yml_publishes() {
        let names: Vec<String> = [
            Method::MacApp(PathBuf::from("/Applications/Roer.app")),
            Method::WindowsSetup,
            Method::AppImage(PathBuf::from("/home/me/Roer.AppImage")),
            Method::Deb,
            Method::Rpm,
        ]
        .iter()
        .map(|method| method.asset("0.9.10"))
        .collect();
        for name in &names {
            assert!(SUMS_0_9_10.contains(name.as_str()), "{name} is not among the release's files");
        }
    }

    /// v0.9.10's SHA256SUMS.txt, the names only.
    const SUMS_0_9_10: &str = "Roer_0.9.10_universal.dmg Roer_0.9.10_amd64.deb Roer-0.9.10-1.x86_64.rpm \
        Roer_0.9.10_amd64.AppImage Roer_0.9.10_x64-setup.exe Roer_0.9.10_x64_en-US.msi";

    #[test]
    fn the_size_is_the_last_answers() {
        let headers = "HTTP/2 302 \r\ncontent-length: 0\r\nlocation: https://x\r\n\r\nHTTP/2 200 \r\nContent-Length: 25144105\r\n\r\n";
        assert_eq!(content_length(headers), Some(25144105));
        assert_eq!(content_length("HTTP/2 302 \r\ncontent-length: 0\r\n\r\n"), None);
        assert_eq!(content_length(""), None);
    }

    #[test]
    fn only_a_valid_jetbrains_signature_passes() {
        assert!(signed_by_jetbrains("Valid|CN=JetBrains s.r.o., O=JetBrains s.r.o., L=Praha, C=CZ"));
        assert!(!signed_by_jetbrains("NotSigned|"));
        assert!(!signed_by_jetbrains("HashMismatch|CN=JetBrains s.r.o., O=JetBrains s.r.o."));
        assert!(!signed_by_jetbrains("Valid|CN=Someone Else"));
        assert!(!signed_by_jetbrains("Valid|O=x, CN=JetBrains s.r.o."));
    }

    #[test]
    fn the_requirement_names_the_team() {
        assert_eq!(mac_requirement(), "=anchor apple generic and certificate leaf[subject.OU] = \"2ZEFAR8TH3\"");
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("roer-update-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_folder_is_replaced_whole() {
        let dir = scratch("dir");
        let target = dir.join("Roer.app");
        std::fs::create_dir_all(target.join("Contents")).unwrap();
        std::fs::write(target.join("Contents/old"), "0.9.9").unwrap();
        let staged = dir.join("staged/Roer.app");
        std::fs::create_dir_all(staged.join("Contents")).unwrap();
        std::fs::write(staged.join("Contents/new"), "0.9.10").unwrap();

        replace_dir(&target, &staged, "0.9.10").unwrap();
        assert!(target.join("Contents/new").is_file());
        assert!(!target.join("Contents/old").exists());
        // Nothing is left beside it.
        let left: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(left.len(), 2, "{left:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_replace_keeps_the_old_folder() {
        let dir = scratch("dir-fail");
        let target = dir.join("Roer.app");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("old"), "0.9.9").unwrap();
        // Nothing staged, so neither the rename nor the copy can work.
        assert!(replace_dir(&target, &dir.join("missing.app"), "0.9.10").is_err());
        assert!(target.join("old").is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_file_is_replaced_and_runnable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("file");
        let target = dir.join("Roer.AppImage");
        std::fs::write(&target, "old").unwrap();
        let new = dir.join("downloaded");
        std::fs::write(&new, "new").unwrap();
        replace_file(&new, &target).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");
        assert_eq!(std::fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o755);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The whole install but the restart, from the real release, over a
    /// stand-in Roer.app in a scratch folder:
    /// `cargo test --lib -- --ignored installs_a_real_release`
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn installs_a_real_release() {
        let dir = scratch("real");
        let target = dir.join("Applications/Roer.app");
        std::fs::create_dir_all(target.join("Contents")).unwrap();
        let method = Method::MacApp(target.clone());
        let stages = std::sync::Mutex::new(Vec::new());
        let emit = |stage: &'static str, _: u64, _: Option<u64>| {
            let mut stages = stages.lock().unwrap();
            if stages.last() != Some(&stage) {
                stages.push(stage);
            }
        };
        install(&method, "0.9.10", &dir.join("update"), &emit).unwrap();
        assert_eq!(*stages.lock().unwrap(), ["download", "verify", "install"]);
        check_mac(&target, "0.9.10").unwrap();
        // Another version than the one asked for is refused.
        assert!(check_mac(&target, "0.9.11").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn starts_the_program_once_this_process_is_gone() {
        let dir = scratch("relaunch");
        let mark = dir.join("started");
        // A stand-in for this app: a child that quits after a moment.
        let mut app = Command::new("/bin/sh").args(["-c", "sleep 0.5"]).spawn().unwrap();
        let mut waiting = after_exit_of(app.id(), Path::new("/usr/bin/touch"), &[mark.as_os_str()]).spawn().unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert!(!mark.exists(), "started before the app quit");
        app.wait().unwrap();
        waiting.wait().unwrap();
        assert!(mark.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
