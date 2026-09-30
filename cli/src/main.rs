//! roer — the session contract.
//!
//! The one thing the Roer app runs, and what a terminal types: it owns the
//! tmux socket, the config and the attach semantics, so the engine stays
//! swappable without touching the app. Every command, argument, output and
//! exit code is the one the shell shim had; the app, the skills and the M-h
//! binding all depend on them.

mod agents;
mod mcp;
mod mcp_install;
mod names;
mod records;
mod skills;
mod tasks;
mod tmux;

use std::io::Read;
use std::path::PathBuf;

use serde_json::{json, Value};

use names::{is_agent_id, is_bundle_name, is_pane_id, session_name};
use records::{emit_plugin_ui, emit_pr_draft, publish};
use tasks::Tasks;
use tmux::Tmux;

/// A command's failure: the exit code the shim used for it, and what to say.
///
/// 1 something failed, 2 a usage error, 3 the thing named does not exist or
/// is not ours, 4 a handoff that did not happen, 64 an unknown command.
#[derive(Debug)]
pub struct Fail {
    code: i32,
    message: String,
}

impl Fail {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Fail { code, message: message.into() }
    }
}

type Outcome = Result<(), Fail>;

const USAGE: &str = "\
roer — session host for agent terminals

usage:
  roer                  open this directory's session in the Roer app,
                        creating it if it is not running (same as `roer app`).
                        Inside a session, teleports that session instead.
  roer app [name]       the same, with the session named explicitly
  roer shell [name]     attach this directory's session to this terminal,
                        detaching any other client (terminal or app)
  roer new [name]       create a session that is always a new one, suffixing
                        the name until it is free, with the default agent
                        (`roer agents default`) started in its shell
  roer new --agent <id> [--model <m>] [--effort <e>] [name]
                        same, with that agent: a saved one or a CLI's name
  roer new --shell [name]
                        same, with just the shell
  roer attach [name]    take a session back, detaching whoever holds it;
                        with no name, lists sessions
  roer list             list sessions as TSV:
                        id<TAB>session<TAB>pane<TAB>attached|detached<TAB>cwd<TAB>command<TAB>agent<TAB>title
  roer detach [name]    release the session; it keeps running with no client
  roer resume <id> [--agent <id>]
                        resume an agent's conversation inside a new session
                        (Claude Code's unless --agent names another)
  roer agents           the agents `new` can start: saved ones in
                        ~/.roer/agents and the project's .roer/agents, and
                        every installed CLI (`roer agents help` for more)
  roer handoff          teleport this session into the Roer app (used by the skill)
  roer handoff --pane <id>
                        same, for the M-h key binding, which has no session
                        environment to read the pane from
  roer handoff --resume <id>
                        hand a conversation over when this terminal is not a
                        roer session and so cannot be attached
  roer plugin-ui        read one A2UI v1.0 JSON message from stdin and show
                        it in the app's Generative UI panel, for this
                        session's pane
  roer plugin-ui --pane <id>
                        same, tagged with a pane explicitly rather than the
                        one this shell is running in
  roer plugin-ui-actions
                        print any pending component actions for this
                        session's pane, one JSON object per line, and
                        consume them; prints nothing if none are waiting
  roer plugin-ui-actions --pane <id>
                        same, for an explicit pane
  roer plugin-ui save <name> surface
                        read a createSurface message (components and data
                        model inline) from stdin and save it under <name>
                        in this project's .roer/plugin-ui
  roer plugin-ui save <name> prompt \"<text>\"
                        record the request that produced <name>
  roer plugin-ui load <name>
                        re-show a saved plugin UI in this session's pane
  roer plugin-ui load --pane <id> <name>
                        same, for an explicit pane
  roer task add \"<title>\" [--status <s>] [--body <text>] [--label <l>]...
                        add a personal task to this project's .roer/tasks
                        and print it as JSON; status is todo (the default),
                        doing or done
  roer task list [--status <s>]
                        print this project's tasks, one JSON object per line
  roer task set <id> [--title <t>] [--status <s>] [--body <text>] [--label <l>]...
                        change a task's fields and print it; any --label
                        replaces its labels, and an empty --body clears it
  roer task rm <id>     delete a task
  roer send [--pane <id>]
                        read text from stdin and submit it as a prompt to
                        the program running in the session's pane
  roer pr-draft [--pane <id>]
                        read {\"title\": ..., \"body\": ...} JSON from stdin and
                        fill it into the app's Pull Request form
  roer skills [list]    the skills that drive roer, and whether each is
                        installed for Claude Code (~/.claude/skills)
  roer skills install   link them there, so sessions in any project have
                        them; the app does this itself on launch
  roer skills uninstall remove the ones roer installed, and keep the app
                        from installing them again
                        (each takes --agent <name>; claude is the only one yet)
  roer mcp              serve Roer's MCP tools on stdio: showing a UI in a
                        session's Generative UI panel and reading its clicks
  roer mcp status       whether roer is registered with Claude Code
  roer mcp install      register it there; the app does this on launch
  roer mcp uninstall    unregister roer's own entry, and keep the app from
                        registering it again
                        (each takes --client claude-desktop to act on the
                        Claude app instead, which is left alone otherwise)
  roer diagnose         print what a bug report needs: which roer, tmux and
                        config run, the locale, and how the server sees each
                        client (the app's log includes it)

A session outlives every client, so it can move freely between terminal and
app. Exactly one client holds it at a time.
";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    // No arguments means the app, which is where a session is meant to end up.
    let (cmd, rest) = args.split_first().map_or(("app", &[][..]), |(cmd, rest)| (*cmd, rest));

    // The config is found before anything else, `help` included: the install
    // instructions use `roer help` succeeding as the proof that
    // roer-tmux.conf was found beside the binary.
    let outcome = Roer::new().and_then(|roer| {
        if matches!(cmd, "help" | "-h" | "--help") {
            print!("{USAGE}");
            Ok(())
        } else {
            roer.dispatch(cmd, rest)
        }
    });
    if let Err(fail) = outcome {
        if !fail.message.is_empty() {
            eprintln!("roer: {}", fail.message);
        }
        if fail.code == 64 {
            eprint!("{USAGE}");
        }
        std::process::exit(fail.code);
    }
}

struct Roer {
    tmux: Tmux,
    /// roer-tmux.conf, which the skills ship beside: see `skills`.
    conf: PathBuf,
    /// Where this was run, as the shell sees it: see `here`.
    cwd: String,
    /// Run by the app, which wants to hear which pane it attached: see
    /// `attach_session`.
    report_pane: bool,
}

/// Set by the app on the `roer` it runs in its own terminal. Read once and
/// cleared, since a tmux server this process starts would otherwise hand it
/// to every shell in every session.
const REPORT_PANE: &str = "ROER_REPORT_PANE";

impl Roer {
    fn new() -> Result<Self, Fail> {
        let bin = self_path();
        let conf = find_conf(&bin)?;
        let report_pane = std::env::var_os(REPORT_PANE).is_some_and(|v| !v.is_empty());
        std::env::remove_var(REPORT_PANE);
        let tmux = Tmux::new(conf.clone(), bin.to_string_lossy().into_owned());
        Ok(Roer { tmux, conf, cwd: here(), report_pane })
    }

    fn dispatch(&self, cmd: &str, args: &[&str]) -> Outcome {
        match cmd {
            "app" => self.app(args.first().copied()),
            "shell" => self.shell(args.first().copied()),
            "new" => self.new_session(args),
            "attach" => self.attach(args.first().copied()),
            "list" | "ls" => self.list(),
            "detach" => self.detach(args.first().copied()),
            "resume" => self.resume(args),
            "agents" | "agent" => match args {
                ["help" | "--help" | "-h"] => {
                    println!("{}", agents::USAGE);
                    Ok(())
                }
                // The app, asking where no project is chosen yet, lists only
                // what is certain: the person's agents and the CLIs.
                _ if args.contains(&"--no-project") => {
                    let args: Vec<&str> = args.iter().copied().filter(|arg| *arg != "--no-project").collect();
                    agents::run(&agents::Store::new(None), &args)
                }
                _ => agents::run(&self.agents(), args),
            },
            "handoff" => self.handoff(args),
            "plugin-ui" => match args.first() {
                Some(&"save") => self.plugin_ui_save(&args[1..]),
                Some(&"load") => self.plugin_ui_load(&args[1..]),
                _ => self.plugin_ui(args),
            },
            "plugin-ui-actions" => self.plugin_ui_actions(args),
            "task" | "tasks" => self.task(args),
            "send" => self.send(args),
            "pr-draft" => self.pr_draft(args),
            "skills" => skills::run(&self.conf, args),
            "mcp" => match args.first() {
                None => mcp::serve(self),
                Some(_) => mcp_install::run(args),
            },
            "diagnose" => self.diagnose(),
            other => Err(Fail::new(64, format!("unknown command: {other}"))),
        }
    }

    /// Everything a bug report about sessions or rendering needs and a user
    /// cannot easily find: which binary, config and engine are in use, the
    /// locale tmux decides UTF-8 from, and each client as the server sees it.
    fn diagnose(&self) -> Outcome {
        println!("roer: {}", self_path().display());
        println!("config: {}", self.conf.display());
        for var in ["LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "TMUX", "ROER_SOCKET"] {
            println!("{var}={}", std::env::var(var).unwrap_or_default());
        }
        print!("{}", self.tmux.describe());
        println!("sessions:");
        self.list()
    }

    /// A session's durable identity, unlike its name or pane: a name is freed
    /// the moment the session ends and a pane id is recycled by the server.
    /// Stamped as a tmux user option so it lives exactly as long as the
    /// session. Sessions from before this existed pick one up lazily, the
    /// first time anything looks them up.
    ///
    /// set-option/show-options take a *pane* target even for a session option,
    /// so "=name" needs the trailing colon to mean "the active pane of name's
    /// active window".
    fn ensure_id(&self, name: &str) -> String {
        let target = format!("={name}:");
        let id = self.tmux.read(&["show-options", "-t", &target, "-v", "-q", "@roer_id"]);
        if !id.is_empty() {
            return id;
        }
        let id = new_id();
        self.tmux.ok(&["set-option", "-t", &target, "@roer_id", &id]);
        id
    }

    /// The first name in the series that is free. With no server running
    /// has-session simply fails, which is the answer we want.
    fn free_name(&self, base: &str) -> String {
        let mut name = base.to_string();
        let mut n = 2;
        while self.tmux.has_session(&name) {
            name = format!("{base}-{n}");
            n += 1;
        }
        name
    }

    /// The default: the session in front of you in the app rather than in
    /// this terminal. One session per directory either way — the app is just
    /// another client.
    fn app(&self, name: Option<&str>) -> Outcome {
        // Already inside a roer session: the session to open is this one, and
        // letting go of it is the handoff's job. Being inside somebody else's
        // tmux is not this case and falls through.
        if self.tmux.inside_roer().is_ok() {
            return self.handoff(&[]);
        }
        let name = name.map_or_else(|| session_name(&self.cwd), str::to_string);

        // Created detached: this terminal must not become a client, because
        // the app is about to be one and a session only ever has the one.
        if !self.tmux.has_session(&name) {
            self.create_detached(&name)?;
        }
        self.tmux.announce();
        self.ensure_id(&name);
        let pane = self.tmux.active_pane(&name);
        if pane.is_empty() {
            return Err(Fail::new(1, format!("no pane in session {name}")));
        }

        publish(&["attach", &pane], &name, &self.cwd)?;
        // The terminal stays where it is, so without this the command looks
        // like it did nothing.
        println!("roer: {name} is open in Roer");
        Ok(())
    }

    fn shell(&self, name: Option<&str>) -> Outcome {
        let name = name.map_or_else(|| session_name(&self.cwd), str::to_string);
        // What `new-session -A -D` does, spelled out so the announce can go in
        // between: create the session if it is not running, then attach and
        // evict whichever client holds it.
        if !self.tmux.has_session(&name) {
            self.create_detached(&name)?;
        }
        self.attach_session(&name, true)
    }

    /// Starts a session with no client. With no command tmux runs its
    /// default-shell as a login shell.
    fn create_detached(&self, name: &str) -> Outcome {
        if self.tmux.run(&["new-session", "-d", "-s", name, "-c", &self.cwd])?.success() {
            Ok(())
        } else {
            Err(Fail::new(1, ""))
        }
    }

    /// Becomes the client of a session: announces this binary to it first,
    /// since once tmux has this process there is no running anything after.
    /// `evict` detaches whoever held it.
    ///
    /// For the app, the pane goes out first as a private OSC, which its
    /// terminal reads and never draws: a session the app started has no pane
    /// it could know in advance, and guessing it from what `list` shows
    /// afterwards goes wrong whenever two sessions appear at once.
    fn attach_session(&self, name: &str, evict: bool) -> Outcome {
        self.tmux.announce();
        if self.report_pane {
            let pane = self.tmux.active_pane(name);
            if !pane.is_empty() {
                print!("\x1b]7717;pane={pane}\x07");
                let _ = std::io::Write::flush(&mut std::io::stdout());
            }
        }
        let target = format!("={name}");
        let mut args = vec!["attach"];
        if evict {
            args.push("-d");
        }
        args.extend(["-t", &target]);
        Err(Fail::new(1, self.tmux.exec(&args)))
    }

    /// Always a fresh session, which is what a launcher means by "new":
    /// `shell` reuses the session for a directory on purpose.
    ///
    /// An agent session is what roer is for, so `new` starts one unless
    /// --shell asks otherwise: the default agent, or the one --agent names.
    /// The agent is typed into the new shell rather than made the pane's
    /// command: it then starts with everything the interactive shell sets up
    /// (a server started by the app has only Finder's PATH), and quitting it
    /// leaves a shell behind.
    fn new_session(&self, args: &[&str]) -> Outcome {
        let (agent_id, args) = agents::take_flag(args, "--agent")?;
        let (model, args) = agents::take_flag(&args, "--model")?;
        let (effort, args) = agents::take_flag(&args, "--effort")?;
        let (shell, args): (bool, Vec<&str>) = match args.first() {
            Some(&"--shell") => (true, args[1..].to_vec()),
            _ => (false, args),
        };
        let agent = if shell {
            None
        } else {
            let store = self.agents();
            let id = agent_id.map_or_else(|| store.default_id(), str::to_string);
            let mut agent = store.find(&id).ok_or_else(|| Fail::new(3, format!("no agent called {id}")))?;
            for why in agent.sanitize() {
                eprintln!("roer: {why}, so {} starts without it", agent.name);
            }
            agent.check().map_err(|why| Fail::new(2, why))?;
            if let Some(model) = model {
                agent.model = model.to_string();
            }
            if let Some(effort) = effort {
                agent.effort = effort.to_string();
            }
            agent.check().map_err(|why| Fail::new(2, why))?;
            Some(agent)
        };
        let base = args.first().map_or_else(|| session_name(&self.cwd), |name| (*name).to_string());
        let name = self.free_name(&base);

        // Created detached so the keys can go in before anyone attaches; the
        // shell reads them once it is up. The name is free, so this is always
        // a new session, never a surprise attach to an old one.
        self.create_detached(&name)?;
        if let Some(agent) = agent {
            self.start_agent(&name, &agent, None)?;
        }
        self.attach_session(&name, false)
    }

    /// Types `agent`'s command into the session's shell, and remembers which
    /// agent it was: not every agent titles its pane, and the app names a
    /// session by the agent it runs.
    fn start_agent(&self, name: &str, agent: &agents::Agent, resume: Option<&str>) -> Outcome {
        let command = agent.command_line(resume, true)?;
        let target = format!("={name}:");
        self.tmux.ok(&["set-option", "-t", &target, "@roer_agent", &agent.name]);
        self.tmux.ok(&["set-option", "-t", &target, "@roer_agent_procs", &agent.procs()]);
        self.tmux.ok(&["send-keys", "-t", &target, &command, "Enter"]);
        Ok(())
    }

    /// Saved agents, with the project's own among them.
    fn agents(&self) -> agents::Store {
        let root = self.project_root();
        agents::Store::new(Some(&root))
    }

    fn list(&self) -> Outcome {
        // Stamp any session that predates @roer_id first, so the id column is
        // never empty for a session that exists.
        for session in self.tmux.read(&["list-sessions", "-F", "#{session_name}"]).lines() {
            self.ensure_id(session);
        }
        // The title is whatever the program in the pane last set with OSC 2 —
        // Claude Code keeps a summary of the task there. tmux defaults it to
        // the hostname, which says nothing, so that prints as empty. It goes
        // last because it is free text: a tab in it must not shift the columns
        // before it.
        //
        // The agent is named only while it runs: tmux is asked for the process
        // names it runs as, and the column is left empty once the pane runs
        // anything else, so nothing takes a shell or an editor for an agent.
        let rows = self.tmux.read(&[
            "list-panes",
            "-a",
            "-F",
            "#{@roer_id}\t#{session_name}\t#{pane_id}\t#{?session_attached,attached,detached}\t\
             #{pane_current_path}\t#{pane_current_command}\t#{@roer_agent_procs}\t#{@roer_agent}\t\
             #{?#{||:#{==:#{pane_title},#{host}},#{==:#{pane_title},#{host_short}}},,#{pane_title}}",
        ]);
        for row in rows.lines().filter(|row| !row.is_empty()) {
            let f: Vec<&str> = row.splitn(9, '\t').collect();
            let [id, session, pane, attached, cwd, command, procs, agent, title] = f[..] else {
                println!("{row}");
                continue;
            };
            let agent = if agents::is_live(command, procs) { agent } else { "" };
            println!("{id}\t{session}\t{pane}\t{attached}\t{cwd}\t{command}\t{agent}\t{title}");
        }
        Ok(())
    }

    fn attach(&self, name: Option<&str>) -> Outcome {
        match name {
            None => self.list(),
            Some(name) => {
                self.tmux.announce();
                Err(Fail::new(1, self.tmux.exec(&["attach", "-d", "-t", name])))
            }
        }
    }

    fn detach(&self, name: Option<&str>) -> Outcome {
        let ok = if let Ok(pane) = self.tmux.inside_roer() {
            // Only tmux can name this terminal's own client; psmux can release
            // the session only as a whole.
            self.tmux.detach_self()
                || self.tmux.run(&["detach-client", "-s", &self.tmux.session_of(&pane)])?.success()
        } else if let Some(name) = name {
            self.tmux.run(&["detach-client", "-s", name])?.success()
        } else {
            return Err(Fail::new(2, "outside a session, detach needs a session name"));
        };
        if ok { Ok(()) } else { Err(Fail::new(1, "")) }
    }

    /// Resumes an agent's conversation inside a roer session: the fallback
    /// when the agent was started in a plain terminal Roer can never attach
    /// to. Landing in a roer session makes it teleportable from then on.
    fn resume(&self, args: &[&str]) -> Outcome {
        let (agent_id, args) = agents::take_flag(args, "--agent")?;
        let id = args.first().copied().ok_or_else(|| Fail::new(2, "resume needs an agent session id"))?;
        // Interpolated into a shell command below.
        if !is_agent_id(id) {
            return Err(Fail::new(2, format!("not an agent session id: {id}")));
        }
        let agent_id = agent_id.unwrap_or(agents::FALLBACK);
        let agent = self.agents().find(agent_id).ok_or_else(|| Fail::new(3, format!("no agent called {agent_id}")))?;
        // A free name, not -A: with -A an existing "<dir>-resume" session is
        // attached instead, and tmux discards the command that comes with it.
        //
        // Typed into the session's shell, as `new` does, rather than given to
        // tmux as the pane's command: tmux runs that with the server's own
        // PATH, and a server the app started from Finder has no directory
        // the agent is in, so the pane died at once and there was nothing left
        // to attach. The login shell sets PATH up the way the user's terminal
        // does, and says so on screen if the agent is missing after all.
        //
        // Always asking first, whatever the agent is set to: a transcript
        // carries no permission mode of its own, and a turn that was
        // mid-flight when it was abandoned can start acting the moment it is
        // restored; the person teleporting has not seen what it wants to do.
        let name = self.free_name(&format!("{}-resume", session_name(&self.cwd)));
        // Checked before a session exists, so a CLI that cannot resume leaves
        // nothing behind.
        agent.command_line(Some(id), false)?;
        self.create_detached(&name)?;
        self.start_agent(&name, &agent, Some(id))?;
        self.attach_session(&name, false)
    }

    fn handoff(&self, args: &[&str]) -> Outcome {
        match args {
            ["--resume", rest @ ..] => {
                // The agent is in a plain terminal whose pty Roer can never
                // attach to, so the conversation moves instead of the
                // terminal. Nothing is detached: the caller is told to close
                // the original.
                let agent = rest.first().copied().unwrap_or_default();
                if !is_agent_id(agent) {
                    return Err(Fail::new(2, "--resume needs an agent session id"));
                }
                let short = agent.split('-').next().unwrap_or(agent);
                publish(&["resume", agent], &format!("resume {short}"), &self.cwd)
            }
            ["--pane", rest @ ..] => self.handoff_key(rest.first().copied().unwrap_or_default()),
            _ => self.handoff_here(),
        }
    }

    /// Pressed as a key binding (M-h). tmux has already expanded the pane, and
    /// run-shell gives the command neither TMUX_PANE nor the pane's working
    /// directory, so nothing here may come from the environment.
    fn handoff_key(&self, pane: &str) -> Outcome {
        if !is_pane_id(pane) {
            return Err(Fail::new(2, "--pane needs a pane id like %3"));
        }
        let session = self.tmux.read(&["display-message", "-p", "-t", pane, "#{session_name}"]);
        if session.is_empty() {
            return Err(Fail::new(3, format!("no such pane: {pane}")));
        }
        self.ensure_id(&session);
        let cwd = self.tmux.read(&["display-message", "-p", "-t", pane, "#{pane_current_path}"]);
        let cwd = if cwd.is_empty() { self.cwd.clone() } else { cwd };
        // The client holding the session now, captured before Roer takes it.
        // `detach-client -s` would detach every client of the session, and once
        // the handoff is confirmed the only one left is Roer — so the session
        // would land in the app and be thrown straight back out.
        let held_by = self.tmux.read(&["list-clients", "-t", &format!("={session}"), "-F", "#{client_tty}"]);
        let held_by = held_by.lines().next().unwrap_or_default();

        match publish(&["attach", pane], &session, &cwd) {
            Ok(()) => {
                // Roer's own `attach -d` has usually evicted that client
                // already; this is for one that somehow survived.
                if !held_by.is_empty() {
                    self.tmux.ok(&["detach-client", "-t", held_by]);
                }
                Ok(())
            }
            Err(fail) => {
                // stderr from a backgrounded run-shell goes nowhere, and the
                // session is still in the terminal, so say it on screen.
                self.tmux.ok(&[
                    "display-message",
                    "-t",
                    pane,
                    "roer: Roer did not take the handoff; the session is still here",
                ]);
                Err(fail)
            }
        }
    }

    /// Run inside the session itself, by the skill.
    fn handoff_here(&self) -> Outcome {
        let pane = self.tmux.inside_roer()?;
        let session = self.tmux.session_of(&pane);
        self.ensure_id(&session);

        publish(&["attach", &pane], &session, &self.cwd)?;
        // Best effort: Roer attaches with `attach -d`, which has usually
        // evicted this client already. The session has moved either way.
        self.tmux.detach_self();
        Ok(())
    }

    fn plugin_ui(&self, args: &[&str]) -> Outcome {
        let pane = resolve_pane(&self.tmux, args)?;
        let message = read_json_stdin("plugin-ui needs a JSON message on stdin")?;
        emit_plugin_ui(&pane, message, 1).map(drop)
    }

    /// Saves one piece of a plugin UI bundle under this project's
    /// .roer/plugin-ui/bundles/<name>/, to be shown again later with
    /// `roer plugin-ui load <name>`.
    fn plugin_ui_save(&self, args: &[&str]) -> Outcome {
        let name = args.first().copied().unwrap_or_default();
        check_bundle_name(name)?;
        let body = match args.get(1).copied() {
            Some("surface") => read_stdin("save surface needs a createSurface message on stdin")?,
            Some("prompt") => {
                let text = args.get(2).copied().unwrap_or_default();
                if text.is_empty() {
                    return Err(Fail::new(2, "save prompt needs the request text as an argument"));
                }
                text.to_string()
            }
            Some("surfaceUpdate" | "dataModelUpdate") => return Err(Fail::new(2, PRE_V1_SAVE)),
            _ => return Err(Fail::new(2, "save needs a kind: surface or prompt")),
        };
        self.save_piece(name, args[1], &body)
    }

    /// Writes one piece of bundle `name`: `kind` is surface (a v1.0
    /// createSurface message) or prompt.
    fn save_piece(&self, name: &str, kind: &str, body: &str) -> Outcome {
        check_bundle_name(name)?;
        let file = match kind {
            "surface" => {
                let message: Value = serde_json::from_str(body)
                    .map_err(|e| Fail::new(2, format!("the surface is not JSON: {e}")))?;
                surface_id(&message)?;
                "surface.json"
            }
            "prompt" => "prompt.md",
            _ => return Err(Fail::new(2, "save needs a kind: surface or prompt")),
        };
        let dir = self.bundle_dir(name);
        std::fs::create_dir_all(&dir)
            .map_err(|e| Fail::new(1, format!("could not create {}: {e}", dir.display())))?;
        records::write_atomic(&dir.join(file), &format!("{body}\n"))?;
        if kind == "surface" {
            // Saved as v1.0, what it was before would only make it look like
            // a legacy bundle to whoever reads it next.
            let _ = std::fs::remove_file(dir.join("surface-update.json"));
            let _ = std::fs::remove_file(dir.join("data-model.json"));
        }
        Ok(())
    }

    /// Re-shows a saved plugin UI: its one createSurface message, read back
    /// from disk instead of stdin.
    fn plugin_ui_load(&self, args: &[&str]) -> Outcome {
        let (pane, name) = match args {
            ["--pane", pane, rest @ ..] => (resolve_pane(&self.tmux, &["--pane", pane])?, rest.first().copied()),
            _ => (resolve_pane(&self.tmux, &[])?, args.first().copied()),
        };
        self.load_bundle(&pane, name.unwrap_or_default()).map(drop)
    }

    /// Shows saved bundle `name` in `pane`; the ids of the records sent.
    fn load_bundle(&self, pane: &str, name: &str) -> Result<Vec<String>, Fail> {
        check_bundle_name(name)?;
        let dir = self.bundle_dir(name);
        let surface = dir.join("surface.json");
        if !surface.is_file() && dir.join("surface-update.json").is_file() {
            // Upgrading one needs the component catalog, which only the app
            // has; it rewrites the bundle the first time it opens it.
            return Err(Fail::new(
                3,
                format!("'{name}' was saved before A2UI v1.0; open it once from Roer's Generative UI panel (Open) to upgrade it"),
            ));
        }
        if !surface.is_file() {
            return Err(Fail::new(
                3,
                format!(
                    "no saved plugin UI named '{name}' in {}/.roer/plugin-ui/bundles",
                    self.project_root()
                ),
            ));
        }
        let message = read_json_file(&surface)?;
        let id = surface_id(&message)?.to_string();
        // A surface may already be on screen under this id; v1.0 wants it
        // deleted before it is created again.
        Ok(vec![
            emit_plugin_ui(pane, json!({ "version": "v1.0", "deleteSurface": { "surfaceId": id } }), 1)?,
            emit_plugin_ui(pane, message, 2)?,
        ])
    }

    /// Prints the pending component actions for a pane, oldest first, one JSON
    /// object per line, deleting each as it goes: a click reaches the terminal
    /// exactly once. The app stamps filenames in nanoseconds, so sorted by name
    /// is chronological.
    fn plugin_ui_actions(&self, args: &[&str]) -> Outcome {
        let pane = resolve_pane(&self.tmux, args)?;
        for action in Self::take_actions(&pane)? {
            println!("{action}");
        }
        Ok(())
    }

    /// The pending component actions for `pane`, oldest first, each consumed
    /// as it is taken.
    fn take_actions(pane: &str) -> Result<Vec<String>, Fail> {
        let dir = records::home().join("plugin-ui-actions");
        std::fs::create_dir_all(&dir)
            .map_err(|e| Fail::new(1, format!("could not create {}: {e}", dir.display())))?;

        let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
            .map_err(|e| Fail::new(1, format!("could not read {}: {e}", dir.display())))?
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
            .collect();
        files.sort();

        let mut taken = Vec::new();
        for file in files {
            let Ok(text) = std::fs::read_to_string(&file) else { continue };
            let for_pane = serde_json::from_str::<Value>(&text)
                .is_ok_and(|action| action.get("pane").and_then(Value::as_str) == Some(pane));
            if for_pane {
                taken.push(text.trim_end_matches('\n').to_string());
                let _ = std::fs::remove_file(&file);
            }
        }
        Ok(taken)
    }

    /// Types stdin into a pane as one prompt and submits it: how the app hands
    /// an agent a request without owning the terminal. Bracketed paste (-p)
    /// keeps a multi-line prompt from being submitted line by line; the Enter
    /// goes separately, after the paste has landed.
    fn send(&self, args: &[&str]) -> Outcome {
        let pane = resolve_pane(&self.tmux, args)?;
        let text = read_stdin("send needs the text on stdin")?;

        let buffer = format!("roer-send-{}", std::process::id());
        if !self.tmux.feed(&["load-buffer", "-b", &buffer, "-"], &text) {
            return Err(Fail::new(1, "could not load the text into tmux"));
        }
        if !self.tmux.ok(&["paste-buffer", "-p", "-d", "-b", &buffer, "-t", &pane]) {
            return Err(Fail::new(1, format!("could not paste into {pane}")));
        }
        // A moment for the program to take the paste in; an Enter that arrives
        // inside the paste is just another newline.
        std::thread::sleep(std::time::Duration::from_millis(200));
        if self.tmux.ok(&["send-keys", "-t", &pane, "Enter"]) {
            Ok(())
        } else {
            Err(Fail::new(1, format!("could not submit to {pane}")))
        }
    }

    fn pr_draft(&self, args: &[&str]) -> Outcome {
        let pane = resolve_pane(&self.tmux, args)?;
        let draft = read_json_stdin("pr-draft needs {\"title\": ..., \"body\": ...} JSON on stdin")?;
        emit_pr_draft(&pane, draft)
    }

    /// `roer task …`: the project's personal tasks, see `tasks`.
    fn task(&self, args: &[&str]) -> Outcome {
        let tasks = self.tasks();
        let print = |task: Value| println!("{task}");
        match args {
            ["add", title, rest @ ..] => {
                let mut fields = task_flags(rest)?;
                fields["title"] = (*title).into();
                tasks.add(&fields).map(print)
            }
            ["list" | "ls", rest @ ..] => {
                let status = match rest {
                    [] => None,
                    ["--status", status] => Some(*status),
                    _ => return Err(Fail::new(2, "usage: roer task list [--status <s>]")),
                };
                tasks.list(status).map(|all| all.into_iter().for_each(print))
            }
            ["set", id, rest @ ..] => tasks.update(id, &task_flags(rest)?).map(print),
            ["rm", id] => tasks.remove(id),
            _ => Err(Fail::new(2, "usage: roer task add|list|set|rm (see roer help)")),
        }
    }

    /// This project's task store.
    fn tasks(&self) -> Tasks {
        Tasks::new(&self.project_root())
    }

    /// The project's own bundle store: a plugin UI worth keeping lives with the
    /// project, versioned and shared the way the code that built it is.
    fn bundle_dir(&self, name: &str) -> PathBuf {
        PathBuf::from(self.project_root()).join(".roer/plugin-ui/bundles").join(name)
    }

    /// The repository this was run in, or the directory itself outside one.
    fn project_root(&self) -> String {
        std::process::Command::new("git")
            .args(["-C", &self.cwd, "rev-parse", "--show-toplevel"])
            .stderr(std::process::Stdio::null())
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
            .filter(|root| !root.is_empty())
            .unwrap_or_else(|| self.cwd.clone())
    }
}

/// The pane a `--pane <id>` names or, without one, the pane this shell is in
/// on Roer's server — the same rule `roer handoff` uses.
fn resolve_pane(tmux: &Tmux, args: &[&str]) -> Result<String, Fail> {
    if let ["--pane", rest @ ..] = args {
        let pane = rest.first().copied().unwrap_or_default();
        // Written into a record, so held to the shape tmux produces.
        if !is_pane_id(pane) {
            return Err(Fail::new(2, "--pane needs a pane id like %3"));
        }
        return Ok(pane.to_string());
    }
    tmux.inside_roer()
}

/// `--title`, `--status`, `--body` and `--label` (repeatable) as a task's
/// fields, for `Tasks` to check.
fn task_flags(args: &[&str]) -> Result<Value, Fail> {
    let mut fields = json!({});
    let mut labels: Option<Vec<Value>> = None;
    let mut rest = args.iter();
    while let Some(flag) = rest.next() {
        let key = match *flag {
            "--title" => "title",
            "--status" => "status",
            "--body" => "body",
            "--label" => "label",
            other => return Err(Fail::new(2, format!("unknown task option: {other}"))),
        };
        let Some(value) = rest.next() else {
            return Err(Fail::new(2, format!("{flag} needs a value")));
        };
        if key == "label" {
            labels.get_or_insert_with(Vec::new).push((*value).into());
        } else {
            fields[key] = (*value).into();
        }
    }
    if let Some(labels) = labels {
        fields["labels"] = labels.into();
    }
    Ok(fields)
}

fn check_bundle_name(name: &str) -> Outcome {
    if is_bundle_name(name) {
        Ok(())
    } else {
        Err(Fail::new(2, format!("invalid plugin-ui bundle name: {name} (use letters, digits, - and _ only)")))
    }
}

/// All of stdin, trailing newlines dropped as `$(cat)` dropped them; empty is
/// a usage error, reported as `missing`.
fn read_stdin(missing: &str) -> Result<String, Fail> {
    let mut text = String::new();
    std::io::stdin()
        .read_to_string(&mut text)
        .map_err(|e| Fail::new(1, format!("could not read stdin: {e}")))?;
    let text = text.trim_end_matches(['\n', '\r']).to_string();
    if text.is_empty() {
        return Err(Fail::new(2, missing));
    }
    Ok(text)
}

/// stdin as JSON. Checked here, where the shell shim passed it through
/// verbatim: a broken message used to vanish inside the app, and now the
/// agent that sent it hears about it.
fn read_json_stdin(missing: &str) -> Result<Value, Fail> {
    let text = read_stdin(missing)?;
    serde_json::from_str(&text).map_err(|e| Fail::new(2, format!("stdin is not JSON: {e}")))
}

const PRE_V1_SAVE: &str = "surfaceUpdate and dataModelUpdate are from before A2UI v1.0; save one createSurface \
message with the components and data model inline instead: roer plugin-ui save <name> surface";

/// The surfaceId of a v1.0 createSurface message, or why it isn't one.
fn surface_id(message: &Value) -> Result<&str, Fail> {
    let body = message.get("createSurface").filter(|_| message.get("version") == Some(&json!("v1.0")));
    body.and_then(|b| b.get("surfaceId"))
        .and_then(Value::as_str)
        .ok_or_else(|| Fail::new(2, "a saved surface is one A2UI v1.0 createSurface message: {\"version\": \"v1.0\", \"createSurface\": {\"surfaceId\": ...}}"))
}

fn read_json_file(path: &std::path::Path) -> Result<Value, Fail> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| Fail::new(1, format!("could not read {}: {e}", path.display())))?;
    serde_json::from_str(&text).map_err(|e| Fail::new(1, format!("{} is not JSON: {e}", path.display())))
}

/// Where this was run, as the shell sees it. `$PWD` keeps the symlinks a
/// shell was cd'd through, where the OS's answer resolves them — and the
/// session name hashes this path, so reading the other one would rename every
/// session opened from a symlinked directory. `$PWD` is only trusted while it
/// is still the same directory.
fn here() -> String {
    let real = std::env::current_dir().unwrap_or_default();
    if let Some(pwd) = std::env::var_os("PWD").map(PathBuf::from) {
        let same = std::fs::canonicalize(&pwd).ok() == std::fs::canonicalize(&real).ok();
        if pwd.is_absolute() && same {
            return pwd.to_string_lossy().into_owned();
        }
    }
    real.to_string_lossy().into_owned()
}

/// This binary, with symlinks resolved: installing is `ln -s` onto `PATH`,
/// and the config sits beside the real file, not the link.
///
/// On Windows canonicalizing adds the `\\?\` long-path prefix, which then
/// shows in every M-h binding and trips up tools that do not expect it.
fn self_path() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("roer"));
    let real = std::fs::canonicalize(&exe).unwrap_or(exe);
    match real.to_str() {
        Some(path) if cfg!(windows) => PathBuf::from(without_long_prefix(path)),
        _ => real,
    }
}

/// A Windows path without its `\\?\` long-path prefix. A network share keeps
/// the `\\` it is addressed by: `\\?\UNC\server\share` is `\\server\share`,
/// where dropping the prefix alone would leave `UNC\server\share`, a relative
/// path.
fn without_long_prefix(path: &str) -> String {
    if let Some(share) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{share}");
    }
    path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::without_long_prefix;

    #[test]
    fn finds_the_config_in_the_app_bundle_only_from_inside_one() {
        assert_eq!(
            super::bundle_conf(Path::new("/Applications/Roer.app/Contents/MacOS/roer")),
            Some(PathBuf::from("/Applications/Roer.app/Contents/Resources/roer-tmux.conf"))
        );
        assert_eq!(super::bundle_conf(Path::new("/Users/me/.roer/bin/roer")), None);
    }

    #[test]
    fn drops_the_long_path_prefix_but_keeps_a_share_absolute() {
        assert_eq!(without_long_prefix(r"\\?\C:\Roer\roer\roer.exe"), r"C:\Roer\roer\roer.exe");
        assert_eq!(without_long_prefix(r"\\?\UNC\server\share\roer.exe"), r"\\server\share\roer.exe");
        assert_eq!(without_long_prefix(r"C:\Roer\roer.exe"), r"C:\Roer\roer.exe");
        assert_eq!(without_long_prefix(r"\\server\share\roer.exe"), r"\\server\share\roer.exe");
    }
}

/// roer-tmux.conf: beside the binary, as the CLI archives ship them; else in
/// the app bundle's Resources, when this is the roer inside Roer.app; else
/// `ROER_TMUX_CONF`; else, in a debug build, the checkout's own copy, since
/// `cli/target/debug/roer` sits nowhere near `scripts/`.
fn find_conf(bin: &std::path::Path) -> Result<PathBuf, Fail> {
    let beside = bin.with_file_name("roer-tmux.conf");
    if beside.is_file() {
        return Ok(beside);
    }
    if let Some(bundled) = bundle_conf(bin).filter(|conf| conf.is_file()) {
        return Ok(bundled);
    }
    if let Some(conf) = std::env::var_os("ROER_TMUX_CONF").filter(|v| !v.is_empty()).map(PathBuf::from) {
        return if conf.is_file() {
            Ok(conf)
        } else {
            Err(Fail::new(1, format!("missing config at {} (ROER_TMUX_CONF)", conf.display())))
        };
    }
    if cfg!(debug_assertions) {
        let checkout = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../scripts/roer-tmux.conf"));
        if checkout.is_file() {
            return Ok(checkout);
        }
    }
    Err(Fail::new(1, format!("missing config at {}", beside.display())))
}

/// Where Roer.app keeps the config for the roer it carries in
/// `Contents/MacOS`: in `Contents/Resources`, since a signed bundle holds only
/// code in `MacOS`. None for a binary anywhere else.
fn bundle_conf(bin: &std::path::Path) -> Option<PathBuf> {
    let macos = bin.parent().filter(|dir| dir.ends_with("Contents/MacOS"))?;
    Some(macos.parent()?.join("Resources").join("roer-tmux.conf"))
}

/// A random, lowercase UUID v4, as `uuidgen | tr A-Z a-z` gave. The standard
/// library's hasher keys come from the OS's random source, which is all the
/// randomness an id that only has to be unique needs.
fn new_id() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let half = || {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
        hasher.finish()
    };
    let bytes = [half().to_be_bytes(), half().to_be_bytes()].concat();
    let mut b: [u8; 16] = bytes.try_into().unwrap_or([0; 16]);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}
