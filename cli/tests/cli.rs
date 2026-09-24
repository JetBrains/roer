//! `roer` run as the app and a terminal run it: the real binary against a
//! real tmux, each test on a server and a `$ROER_HOME` of its own so they run
//! in parallel and never touch the sessions of whoever runs them.
#![cfg(unix)]

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

struct Env {
    socket: String,
    home: PathBuf,
    /// A directory to run in, standing in for a project.
    dir: PathBuf,
}

impl Env {
    fn new(name: &str) -> Env {
        let root = std::env::temp_dir().join(format!("roer-cli-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("project");
        std::fs::create_dir_all(&dir).unwrap();
        // canonicalize: macOS's temp dir is behind /var -> /private/var, and
        // tmux reports pane paths resolved.
        let root = std::fs::canonicalize(&root).unwrap();
        Env {
            socket: format!("roer-test-{name}-{}", std::process::id()),
            home: root.join("home"),
            dir: root.join("project"),
        }
    }

    fn roer(&self, args: &[&str]) -> Command {
        let mut roer = Command::new(env!("CARGO_BIN_EXE_roer"));
        roer.args(args)
            .current_dir(&self.dir)
            .env("PWD", &self.dir)
            .env("ROER_SOCKET", &self.socket)
            .env("ROER_HOME", &self.home)
            // Something that is not an app, so a handoff never launches one.
            .env("ROER_APP", "/nonexistent/roer-test-app")
            .env_remove("TMUX")
            .env_remove("TMUX_PANE")
            .env_remove("ROER_TMUX_CONF");
        roer
    }

    fn run(&self, args: &[&str]) -> Output {
        self.roer(args).stdin(Stdio::null()).output().unwrap()
    }

    fn run_with(&self, args: &[&str], stdin: &str) -> Output {
        let mut child = self.roer(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
        child.wait_with_output().unwrap()
    }

    /// tmux on this test's server, directly, for arranging and inspecting.
    fn tmux(&self, args: &[&str]) -> String {
        let conf = concat!(env!("CARGO_MANIFEST_DIR"), "/../scripts/roer-tmux.conf");
        let out = Command::new("tmux").args(["-L", &self.socket, "-f", conf]).args(args).output().unwrap();
        String::from_utf8_lossy(&out.stdout).trim_end().to_string()
    }

    /// Records the app would see in one of `$ROER_HOME`'s directories, in order.
    fn records(&self, dir: &str) -> Vec<Value> {
        let Ok(entries) = std::fs::read_dir(self.home.join(dir)) else { return vec![] };
        let mut paths: Vec<PathBuf> = entries.map(|e| e.unwrap().path()).collect();
        paths.sort();
        paths.iter().map(|p| serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()).collect()
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        self.tmux(&["kill-server"]);
        // The second server `in_a_terminal` starts, if this test made one.
        let _ = Command::new("tmux").args(["-L", &format!("{}-outer", self.socket), "kill-server"]).status();
        let _ = std::fs::remove_dir_all(self.home.parent().unwrap());
    }
}

fn code(out: &Output) -> i32 {
    out.status.code().unwrap_or(-1)
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

/// Stands in for the app: claims every handoff it sees and then either shows
/// it (deletes the record) or reports that it could not.
struct FakeApp {
    stop: Arc<AtomicBool>,
    seen: Arc<Mutex<Vec<Value>>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl FakeApp {
    fn start(env: &Env, succeed: bool) -> FakeApp {
        let dir = env.home.join("handoffs");
        let stop = Arc::new(AtomicBool::new(false));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (stop2, seen2) = (stop.clone(), seen.clone());
        let thread = std::thread::spawn(move || {
            while !stop2.load(Ordering::Relaxed) {
                for path in std::fs::read_dir(&dir).into_iter().flatten().map(|e| e.unwrap().path()) {
                    if path.extension().is_none_or(|ext| ext != "json") {
                        continue;
                    }
                    let claimed = PathBuf::from(format!("{}.claimed", path.display()));
                    if std::fs::rename(&path, &claimed).is_err() {
                        continue;
                    }
                    let record = std::fs::read_to_string(&claimed).unwrap();
                    seen2.lock().unwrap().push(serde_json::from_str(&record).unwrap());
                    if succeed {
                        std::fs::remove_file(&claimed).unwrap();
                    } else {
                        std::fs::write(format!("{}.failed", path.display()), "").unwrap();
                        std::fs::remove_file(&claimed).unwrap();
                    }
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        });
        FakeApp { stop, seen, thread: Some(thread) }
    }

    fn seen(&self) -> Vec<Value> {
        self.seen.lock().unwrap().clone()
    }
}

impl Drop for FakeApp {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.thread.take().unwrap().join().unwrap();
    }
}

/// The name the shell shim gave a directory: its basename and the low 16
/// bits of `cksum` of its path. Computed here with the system's own `cksum`
/// so the binary is checked against the formula, not against itself.
fn shim_name(dir: &Path) -> String {
    let path = dir.to_string_lossy();
    let out = Command::new("sh")
        .arg("-c")
        .arg(r#"sum=$(printf '%s' "$1" | cksum | cut -d' ' -f1); printf '%04x' "$((sum & 0xffff))""#)
        .arg("sh")
        .arg(&*path)
        .output()
        .unwrap();
    format!("{}-{}", dir.file_name().unwrap().to_string_lossy(), String::from_utf8_lossy(&out.stdout))
}

/// The pane of a detached session started on this test's server for the
/// purpose, running `command`.
fn pane(env: &Env, session: &str, command: &str) -> String {
    let dir = env.dir.to_string_lossy();
    env.tmux(&["new-session", "-d", "-s", session, "-c", &dir, "-x", "80", "-y", "24", command]);
    env.tmux(&["list-panes", "-t", &format!("={session}"), "-F", "#{pane_id}"])
}

#[test]
fn app_opens_this_directorys_session_and_hands_it_over() {
    let env = Env::new("app");
    let app = FakeApp::start(&env, true);

    let out = env.run(&[]);
    assert_eq!(code(&out), 0, "{}", stderr(&out));
    let name = shim_name(&env.dir);
    assert_eq!(String::from_utf8_lossy(&out.stdout), format!("roer: {name} is open in Roer\n"));

    let seen = app.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0]["args"][0], "attach");
    assert!(seen[0]["args"][1].as_str().unwrap().starts_with('%'));
    assert_eq!(seen[0]["label"], name.as_str());
    assert_eq!(seen[0]["cwd"], env.dir.to_string_lossy().as_ref());

    // The session was created detached, stamped with an id, and told where
    // M-h should find this binary.
    let list = String::from_utf8_lossy(&env.run(&["list"]).stdout).into_owned();
    let row: Vec<&str> = list.lines().next().unwrap().split('\t').collect();
    assert_eq!(row.len(), 7, "{list}");
    assert_eq!(row[0].len(), 36, "a uuid: {}", row[0]);
    assert_eq!(row[1], name);
    assert_eq!(row[3], "detached");
    assert_eq!(row[4], env.dir.to_string_lossy());
    let bin = std::fs::canonicalize(env!("CARGO_BIN_EXE_roer")).unwrap();
    assert_eq!(env.tmux(&["show-options", "-t", &format!("={name}:"), "-v", "@roer_bin"]), bin.to_string_lossy());

    // A second `roer` is the same session, not another one.
    assert_eq!(code(&env.run(&[])), 0);
    let list = String::from_utf8_lossy(&env.run(&["list"]).stdout).into_owned();
    assert_eq!(list.lines().count(), 1, "{list}");
    assert_eq!(list.split('\t').next(), Some(row[0]), "the id is kept");
}

#[test]
fn a_symlinked_directory_keeps_the_name_the_shell_gave_it() {
    let env = Env::new("symlink");
    let _app = FakeApp::start(&env, true);
    let link = env.dir.parent().unwrap().join("linked");
    std::os::unix::fs::symlink(&env.dir, &link).unwrap();

    let out = env.roer(&[]).env("PWD", &link).stdin(Stdio::null()).output().unwrap();
    assert_eq!(code(&out), 0, "{}", stderr(&out));
    assert_eq!(String::from_utf8_lossy(&out.stdout), format!("roer: {} is open in Roer\n", shim_name(&link)));
}

#[test]
fn a_handoff_the_app_could_not_open_moves_nothing() {
    let env = Env::new("failed");
    let _app = FakeApp::start(&env, false);
    let out = env.run(&[]);
    assert_eq!(code(&out), 4);
    assert!(stderr(&out).contains("Roer could not open the session; nothing moved"), "{}", stderr(&out));
    assert!(env.records("handoffs").is_empty(), "no record is left behind");
}

#[test]
fn a_handoff_nobody_claims_is_cancelled() {
    let env = Env::new("unclaimed");
    let out = env.run(&[]);
    assert_eq!(code(&out), 4);
    assert!(stderr(&out).contains("did not take the session within 10s"), "{}", stderr(&out));
    let left: Vec<_> = std::fs::read_dir(env.home.join("handoffs")).unwrap().collect();
    assert!(left.is_empty(), "the cancelled record is gone: {left:?}");
}

#[test]
fn the_m_h_binding_hands_over_the_pane_it_names() {
    let env = Env::new("key");
    let app = FakeApp::start(&env, true);
    let pane = pane(&env, "work", "sh");

    let out = env.run(&["handoff", "--pane", &pane]);
    assert_eq!(code(&out), 0, "{}", stderr(&out));
    let seen = app.seen();
    assert_eq!(seen[0]["args"], serde_json::json!(["attach", pane]));
    assert_eq!(seen[0]["label"], "work");
    assert_eq!(seen[0]["cwd"], env.dir.to_string_lossy().as_ref());

    assert_eq!(code(&env.run(&["handoff", "--pane", "3"])), 2);
    assert_eq!(code(&env.run(&["handoff", "--pane", "%999"])), 3);
}

#[test]
fn a_conversation_hands_over_by_its_id() {
    let env = Env::new("resume");
    let app = FakeApp::start(&env, true);
    assert_eq!(code(&env.run(&["handoff", "--resume", "0f3c-9a"])), 0);
    let seen = app.seen();
    assert_eq!(seen[0]["args"], serde_json::json!(["resume", "0f3c-9a"]));
    assert_eq!(seen[0]["label"], "resume 0f3c");

    assert_eq!(code(&env.run(&["handoff", "--resume", "x;y"])), 2);
    assert_eq!(code(&env.run(&["resume"])), 2);
    assert_eq!(code(&env.run(&["resume", "$(id)"])), 2);
}

#[test]
fn send_pastes_the_text_and_submits_it() {
    let env = Env::new("send");
    let out_file = env.dir.join("typed");
    let pane = pane(&env, "agent", &format!("cat > '{}'", out_file.display()));

    let out = env.run_with(&["send", "--pane", &pane], "draft a PR\n");
    assert_eq!(code(&out), 0, "{}", stderr(&out));
    let mut typed = String::new();
    for _ in 0..50 {
        typed = std::fs::read_to_string(&out_file).unwrap_or_default();
        if typed.ends_with('\n') {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(typed, "draft a PR\n");

    assert_eq!(code(&env.run_with(&["send", "--pane", &pane], "")), 2);
}

#[test]
fn plugin_ui_messages_reach_the_app_tagged_with_their_pane() {
    let env = Env::new("plugin-ui");
    let out = env.run_with(&["plugin-ui", "--pane", "%4"], r#"{"kind":"surfaceUpdate","surfaceId":"s"}"#);
    assert_eq!(code(&out), 0, "{}", stderr(&out));
    let records = env.records("plugin-ui");
    assert_eq!(records, vec![serde_json::json!({"pane": "%4", "message": {"kind": "surfaceUpdate", "surfaceId": "s"}})]);

    let out = env.run_with(&["plugin-ui", "--pane", "%4"], "{not json");
    assert_eq!(code(&out), 2);
    assert_eq!(code(&env.run_with(&["plugin-ui", "--pane", "%4"], "")), 2);
    // Outside a session and with no pane named, there is no pane to tag.
    assert_eq!(code(&env.run_with(&["plugin-ui"], "{}")), 2);
}

#[test]
fn a_saved_plugin_ui_loads_back_in_order() {
    let env = Env::new("bundle");
    assert_eq!(code(&env.run_with(&["plugin-ui", "save", "issues", "surfaceUpdate"], r#"{"kind":"surfaceUpdate"}"#)), 0);
    assert_eq!(code(&env.run_with(&["plugin-ui", "save", "issues", "dataModelUpdate"], r#"{"kind":"dataModelUpdate"}"#)), 0);
    assert_eq!(code(&env.run(&["plugin-ui", "save", "issues", "prompt", "show open issues"])), 0);
    let bundle = env.dir.join(".roer/plugin-ui/bundles/issues");
    assert_eq!(std::fs::read_to_string(bundle.join("prompt.md")).unwrap(), "show open issues\n");

    let out = env.run(&["plugin-ui", "load", "--pane", "%2", "issues"]);
    assert_eq!(code(&out), 0, "{}", stderr(&out));
    let kinds: Vec<Value> = env.records("plugin-ui").iter().map(|r| r["message"]["kind"].clone()).collect();
    assert_eq!(kinds, ["surfaceUpdate", "dataModelUpdate", "beginRendering"]);
    assert_eq!(env.records("plugin-ui")[2]["message"]["surfaceId"], "issues");

    assert_eq!(code(&env.run(&["plugin-ui", "load", "--pane", "%2", "missing"])), 3);
    assert_eq!(code(&env.run(&["plugin-ui", "save", "../up", "prompt", "x"])), 2);
    assert_eq!(code(&env.run(&["plugin-ui", "save", "issues", "other"])), 2);
}

#[test]
fn actions_are_delivered_to_their_pane_once_and_in_order() {
    let env = Env::new("actions");
    let dir = env.home.join("plugin-ui-actions");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("2.json"), r#"{"pane":"%1","name":"second"}"#).unwrap();
    std::fs::write(dir.join("1.json"), r#"{"pane":"%1","name":"first"}"#).unwrap();
    std::fs::write(dir.join("3.json"), r#"{"pane":"%9","name":"elsewhere"}"#).unwrap();

    let out = env.run(&["plugin-ui-actions", "--pane", "%1"]);
    assert_eq!(code(&out), 0, "{}", stderr(&out));
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        "{\"pane\":\"%1\",\"name\":\"first\"}\n{\"pane\":\"%1\",\"name\":\"second\"}\n"
    );
    assert!(env.run(&["plugin-ui-actions", "--pane", "%1"]).stdout.is_empty(), "consumed");
    assert!(dir.join("3.json").exists(), "another pane's action is left alone");
}

#[test]
fn a_pr_draft_reaches_the_app() {
    let env = Env::new("pr-draft");
    let out = env.run_with(&["pr-draft", "--pane", "%5"], r#"{"title":"T","body":"line 1\nline 2"}"#);
    assert_eq!(code(&out), 0, "{}", stderr(&out));
    assert_eq!(env.records("pr-draft"), vec![serde_json::json!({"pane": "%5", "draft": {"title": "T", "body": "line 1\nline 2"}})]);
}

#[test]
fn usage_errors_keep_their_exit_codes() {
    let env = Env::new("usage");
    let out = env.run(&["frobnicate"]);
    assert_eq!(code(&out), 64);
    assert!(stderr(&out).contains("unknown command: frobnicate"));
    assert!(stderr(&out).contains("usage:"));

    let help = env.run(&["--help"]);
    assert_eq!(code(&help), 0);
    assert!(String::from_utf8_lossy(&help.stdout).starts_with("roer — session host"));

    assert_eq!(code(&env.run(&["detach"])), 2);
    assert_eq!(code(&env.run(&["handoff"])), 2, "outside a session");
    assert_eq!(code(&env.roer(&["handoff"]).env("TMUX", "/nonexistent/other,1,0").output().unwrap()), 3);
}

#[test]
fn a_missing_config_is_reported() {
    let env = Env::new("conf");
    let out = env.roer(&["list"]).env("ROER_TMUX_CONF", "/nonexistent/roer-tmux.conf").output().unwrap();
    assert_eq!(code(&out), 1);
    assert!(stderr(&out).contains("missing config at /nonexistent/roer-tmux.conf"), "{}", stderr(&out));
    // help too: it is how an install proves the config was found.
    let help = env.roer(&["help"]).env("ROER_TMUX_CONF", "/nonexistent/roer-tmux.conf").output().unwrap();
    assert_eq!(code(&help), 1);
}

/// Runs `roer args...` in a pane of a second tmux server, which gives it the
/// terminal `shell`, `new` and `attach` need to become a tmux client of the
/// test's own server. Returns once that server shows the session `wait_for`
/// with a client attached.
fn in_a_terminal(env: &Env, args: &[&str], wait_for: &str) {
    let outer = format!("{}-outer", env.socket);
    let bin = env!("CARGO_BIN_EXE_roer");
    // env -u TMUX: the outer pane is itself inside tmux, and a client started
    // there refuses to nest.
    let command = format!(
        "cd '{}' && env -u TMUX ROER_SOCKET='{}' ROER_HOME='{}' '{bin}' {}",
        env.dir.display(),
        env.socket,
        env.home.display(),
        args.join(" ")
    );
    let status = Command::new("tmux")
        .args(["-L", &outer, "-f", "/dev/null", "new-session", "-d", "-x", "80", "-y", "24", &command])
        .status()
        .unwrap();
    assert!(status.success());
    for _ in 0..100 {
        let attached = env.tmux(&["list-sessions", "-F", "#{session_name} #{session_attached}"]);
        if attached.lines().any(|line| line == format!("{wait_for} 1")) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("{wait_for} never attached: {}", env.tmux(&["list-sessions"]));
}

/// Ends the terminal `in_a_terminal` made, so the next one starts clean.
fn kill_outer(env: &Env) {
    let _ = Command::new("tmux").args(["-L", &format!("{}-outer", env.socket), "kill-server"]).status();
}

#[test]
fn shell_attaches_this_directorys_session_to_the_terminal() {
    let env = Env::new("shell");
    let name = shim_name(&env.dir);
    in_a_terminal(&env, &["shell"], &name);
    let bin = std::fs::canonicalize(env!("CARGO_BIN_EXE_roer")).unwrap();
    assert_eq!(
        env.tmux(&["show-options", "-t", &format!("={name}:"), "-v", "@roer_bin"]),
        bin.to_string_lossy(),
        "announced before the attach too"
    );
    kill_outer(&env);
}

#[test]
fn new_always_makes_another_session_and_starts_claude_in_it() {
    let env = Env::new("new");
    let name = shim_name(&env.dir);
    env.tmux(&["new-session", "-d", "-s", &name]);

    in_a_terminal(&env, &["new"], &format!("{name}-2"));
    let mut typed = String::new();
    for _ in 0..50 {
        typed = env.tmux(&["capture-pane", "-p", "-t", &format!("={name}-2:")]);
        if typed.contains("claude") {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(typed.contains("claude"), "claude was typed into the new shell: {typed}");
    kill_outer(&env);

    in_a_terminal(&env, &["new", "--shell", "scratch"], "scratch");
    kill_outer(&env);
}

#[test]
fn attach_takes_a_named_session_back() {
    let env = Env::new("attach");
    env.tmux(&["new-session", "-d", "-s", "held"]);
    in_a_terminal(&env, &["attach", "held"], "held");
    kill_outer(&env);
}

/// M-h's command is pasted together by tmux and then read by sh, so the path
/// it runs must arrive as one word whatever it contains. Taken from the
/// config itself, expanded by tmux in a pane, and run by sh as run-shell does.
#[test]
fn the_m_h_binding_calls_a_path_with_shell_characters_in_it() {
    let env = Env::new("quoting");
    let odd = env.dir.join("we ird $HOME `touch pwned` \"q\"");
    std::fs::create_dir_all(&odd).unwrap();
    let marker = env.dir.join("called");
    let script = odd.join("roer");
    std::fs::write(&script, format!("#!/bin/sh\necho \"$@\" > '{}'\n", marker.display())).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

    let pane = pane(&env, "work", "sh");
    env.tmux(&["set-option", "-t", "=work:", "@roer_bin", &script.to_string_lossy()]);

    // The binding as the config writes it: run-shell -b '<command>'.
    let conf = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../scripts/roer-tmux.conf")).unwrap();
    let line = conf.lines().find(|line| line.starts_with("bind -n M-h ")).unwrap();
    let command = line.split_once("run-shell -b '").unwrap().1.strip_suffix('\'').unwrap();
    let expanded = env.tmux(&["display-message", "-p", "-t", &pane, command]);

    let status = Command::new("sh").arg("-c").arg(&expanded).current_dir(&env.dir).status().unwrap();
    assert!(status.success(), "{expanded}");
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), format!("handoff --pane {pane}\n"));
    assert!(!env.dir.join("pwned").exists(), "nothing in the path was run: {expanded}");
}
