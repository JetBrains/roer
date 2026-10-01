//! Which coding agent a session starts, and how.
//!
//! A *CLI* is a program roer knows how to drive — `claude`, `codex`, `pi`,
//! `gemini`, `junie`, `opencode` — and what it knows is each one's flags: for
//! the model, the reasoning effort, how much it may do unasked, extra
//! instructions, and resuming a conversation. An *agent* is a saved setup for
//! one of them: a Markdown file with YAML frontmatter, the shape Claude Code,
//! opencode, Copilot and Junie use for their own agents, under
//! `~/.roer/agents` for one person or `<project>/.roer/agents` to share with
//! everyone working on the project. Every installed CLI is also an agent of
//! its own, with nothing set: that CLI as it starts by default.
//!
//! The effort and permission values are roer's own, translated per CLI, and
//! a CLI that has no flag for one is said to have none rather than handed a
//! setting it would ignore.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::{records, Fail};

/// The agent a session starts when nothing picks one.
pub const FALLBACK: &str = "claude";

pub struct Cli {
    pub id: &'static str,
    pub label: &'static str,
    pub bin: &'static str,
    /// Each of these is a flag template, `{}` standing for the value.
    model: &'static [&'static str],
    effort: &'static [&'static str],
    /// The effort levels the CLI accepts, weakest first.
    efforts: &'static [&'static str],
    /// What "ask before acting" adds. Also what every resume gets: a restored
    /// turn may start acting at once, before anyone has seen what it wants.
    ask: &'static [&'static str],
    auto: Option<&'static [&'static str]>,
    full: Option<&'static [&'static str]>,
    /// How extra instructions are passed: `{}` is the path of a file that
    /// holds them, `{text}` the file's contents and `{toml}` the same as a
    /// TOML string, both read by the session's shell. Never the text itself:
    /// typed, it would submit the line at its first newline.
    instructions: &'static [&'static str],
    /// Goes first, since for codex it is a subcommand.
    resume: &'static [&'static str],
    /// How to hand the CLI a settings file of roer's own, for the hooks that
    /// report what it is doing (see `status_hooks`); empty for a CLI with no
    /// such thing.
    status: &'static [&'static str],
    /// Offered while nothing better is known: see `models`.
    models: &'static [&'static str],
    /// What tmux calls the agent's process while it runs, which is how
    /// `roer list` tells a running agent from one that has quit. Claude Code
    /// sets its process title to its version: see `is_live`.
    procs: &'static [&'static str],
}

pub const CLIS: &[Cli] = &[
    Cli {
        id: "claude",
        label: "Claude Code",
        bin: "claude",
        model: &["--model", "{}"],
        effort: &["--effort", "{}"],
        efforts: &["low", "medium", "high", "xhigh", "max"],
        ask: &["--permission-mode", "manual"],
        auto: Some(&["--permission-mode", "auto"]),
        full: Some(&["--dangerously-skip-permissions"]),
        instructions: &["--append-system-prompt-file", "{}"],
        resume: &["--resume", "{}"],
        status: &["--settings", "{}"],
        models: &["opus", "sonnet", "haiku", "claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"],
        procs: &["claude"],
    },
    Cli {
        id: "codex",
        label: "Codex",
        bin: "codex",
        model: &["-m", "{}"],
        effort: &["-c", "model_reasoning_effort={}"],
        efforts: &["minimal", "low", "medium", "high", "xhigh"],
        ask: &["-a", "untrusted"],
        auto: Some(&["--approve-for-me"]),
        full: Some(&["--dangerously-bypass-approvals-and-sandbox"]),
        // Added to Codex's own instructions, where model_instructions_file
        // would replace them.
        instructions: &["-c", "developer_instructions={toml}"],
        resume: &["resume", "{}"],
        status: &[],
        models: &["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"],
        procs: &["codex"],
    },
    Cli {
        id: "pi",
        label: "pi",
        bin: "pi",
        model: &["--model", "{}"],
        effort: &["--thinking", "{}"],
        efforts: &["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        ask: &[],
        auto: None,
        full: None,
        instructions: &["--append-system-prompt", "{}"],
        resume: &["--session", "{}"],
        status: &[],
        models: &[],
        procs: &["pi", "node"],
    },
    Cli {
        id: "gemini",
        label: "Gemini CLI",
        bin: "gemini",
        model: &["-m", "{}"],
        effort: &[],
        efforts: &[],
        ask: &[],
        auto: None,
        full: Some(&["--yolo"]),
        instructions: &[],
        resume: &[],
        status: &[],
        models: &["gemini-2.5-pro", "gemini-2.5-flash"],
        procs: &["gemini", "node"],
    },
    Cli {
        id: "junie",
        label: "Junie",
        bin: "junie",
        model: &["--model={}"],
        effort: &["--effort={}"],
        efforts: &["low", "medium", "high"],
        ask: &[],
        auto: None,
        full: Some(&["--brave"]),
        instructions: &["--system-prompt={text}"],
        resume: &["--resume", "--session-id={}"],
        status: &[],
        models: &[],
        procs: &["junie"],
    },
    Cli {
        id: "opencode",
        label: "opencode",
        bin: "opencode",
        model: &["-m", "{}"],
        effort: &[],
        efforts: &[],
        ask: &[],
        auto: None,
        full: None,
        instructions: &[],
        resume: &["-s", "{}"],
        status: &[],
        models: &[],
        procs: &["opencode"],
    },
];

pub fn cli(id: &str) -> Option<&'static Cli> {
    CLIS.iter().find(|cli| cli.id == id)
}

impl Cli {
    fn permissions(&self) -> Vec<&'static str> {
        let mut levels = vec!["ask"];
        levels.extend(self.auto.map(|_| "auto"));
        levels.extend(self.full.map(|_| "full"));
        levels
    }

    fn describe(&self, installed: bool) -> Value {
        json!({
            "id": self.id,
            "label": self.label,
            "bin": self.bin,
            "installed": installed,
            "models": self.models,
            "efforts": self.efforts,
            "permissions": if self.auto.is_none() && self.full.is_none() { vec![] } else { self.permissions() },
            "instructions": !self.instructions.is_empty(),
            "resume": !self.resume.is_empty(),
        })
    }
}

/// One saved setup, or a CLI standing as its own agent.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Agent {
    /// The file name without `.md`: what `--agent` takes.
    pub id: String,
    pub name: String,
    pub description: String,
    pub cli: String,
    /// Only for `cli: custom`: what to run, typed as it is.
    pub command: String,
    pub model: String,
    pub effort: String,
    pub permissions: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub instructions: String,
    /// builtin, user or project.
    pub source: String,
    pub path: String,
}

impl Agent {
    fn builtin(cli: &Cli) -> Agent {
        Agent {
            id: cli.id.to_string(),
            name: cli.label.to_string(),
            cli: cli.id.to_string(),
            source: "builtin".to_string(),
            ..Agent::default()
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "cli": self.cli,
            "command": self.command,
            "model": self.model,
            "effort": self.effort,
            "permissions": self.permissions,
            "args": self.args,
            "env": self.env,
            "instructions": self.instructions,
            "source": self.source,
            "path": self.path,
        })
    }

    pub fn from_json(value: &Value) -> Agent {
        let text = |key: &str| value.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string();
        Agent {
            id: text("id"),
            name: text("name"),
            description: text("description"),
            cli: text("cli"),
            command: text("command"),
            model: text("model"),
            effort: text("effort"),
            permissions: text("permissions"),
            args: value
                .get("args")
                .and_then(Value::as_array)
                .map(|args| args.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default(),
            env: value
                .get("env")
                .and_then(Value::as_object)
                .map(|env| {
                    env.iter()
                        .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
                        .collect()
                })
                .unwrap_or_default(),
            instructions: value.get("instructions").and_then(Value::as_str).unwrap_or_default().trim().to_string(),
            source: text("source"),
            path: text("path"),
        }
    }

    /// The process names `is_live` looks for, as recorded on the session.
    pub fn procs(&self) -> String {
        if self.cli == "custom" {
            // The program the command starts, as tmux would name it.
            let program = self.command.split_whitespace().find(|word| !word.contains('=')).unwrap_or_default();
            let name = Path::new(program).file_name().and_then(|n| n.to_str()).unwrap_or(program);
            return name.trim_end_matches(".exe").to_string();
        }
        cli(&self.cli).map(|cli| cli.procs.join(" ")).unwrap_or_default()
    }

    /// Whether the agent can be run as it is written, and if not, why.
    pub fn check(&self) -> Result<(), String> {
        match self.problems().into_iter().next() {
            Some((why, _)) => Err(why),
            None => Ok(()),
        }
    }

    /// Everything wrong with the agent as written, each with the field that
    /// dropping would put right, when dropping one would.
    fn problems(&self) -> Vec<(String, Option<Field>)> {
        let mut problems = Vec::new();
        // Typed into a shell as `NAME=value`, so a name is held to the one
        // shape every shell reads as nothing but a name.
        for key in self.env.keys().filter(|key| !is_env_name(key)) {
            problems.push((format!("not an environment variable name: {key:?}"), Some(Field::Env(key.clone()))));
        }
        let unsupported = |what: &str, label: &str| format!("{label} takes no {what}");
        if self.cli == "custom" {
            if self.command.is_empty() {
                problems.insert(0, ("a custom agent needs a command".into(), None));
            }
            // A custom command is run as it is written, with nothing added.
            let label = "a custom agent";
            if !self.model.is_empty() {
                problems.push((unsupported("model", label), Some(Field::Model)));
            }
            if !self.effort.is_empty() {
                problems.push((unsupported("reasoning effort", label), Some(Field::Effort)));
            }
            if !self.permissions.is_empty() {
                problems.push((unsupported("permission level", label), Some(Field::Permissions)));
            }
            if !self.instructions.is_empty() {
                problems.push((unsupported("extra instructions", label), Some(Field::Instructions)));
            }
            return problems;
        }
        let Some(cli) = cli(&self.cli) else {
            problems.insert(0, (format!("unknown cli: {}", self.cli), None));
            return problems;
        };
        if !self.effort.is_empty() && !cli.efforts.contains(&self.effort.as_str()) {
            let why = if cli.efforts.is_empty() {
                format!("{} has no reasoning effort setting", cli.label)
            } else {
                format!("{} takes effort {}", cli.label, cli.efforts.join(", "))
            };
            problems.push((why, Some(Field::Effort)));
        }
        if !self.permissions.is_empty() && !cli.permissions().contains(&self.permissions.as_str()) {
            let why = format!("{} has no \"{}\" permission level", cli.label, self.permissions);
            problems.push((why, Some(Field::Permissions)));
        }
        if !self.instructions.is_empty() && cli.instructions.is_empty() {
            problems.push((unsupported("extra instructions", cli.label), Some(Field::Instructions)));
        }
        problems
    }

    /// Drops what the CLI cannot take, saying what went, so a file edited by
    /// hand or brought from elsewhere still starts. The editor never saves one.
    pub fn sanitize(&mut self) -> Vec<String> {
        let mut dropped = Vec::new();
        for (why, field) in self.problems() {
            match field {
                None => return vec![why],
                Some(Field::Model) => self.model.clear(),
                Some(Field::Effort) => self.effort.clear(),
                Some(Field::Permissions) => self.permissions.clear(),
                Some(Field::Instructions) => self.instructions.clear(),
                Some(Field::Env(key)) => {
                    self.env.remove(&key);
                }
            }
            dropped.push(why);
        }
        dropped
    }

    /// The words that start this agent, program first. `prompt` is where the
    /// instructions are, when there are any; `status` is roer's settings file
    /// for the CLI, when it takes one.
    fn words(&self, resume: Option<&str>, prompt: Option<&Prompt>, status: Option<&Path>) -> Result<Vec<Word>, Fail> {
        if self.cli == "custom" {
            if resume.is_some() {
                return Err(Fail::new(2, format!("{} cannot resume a conversation", self.name)));
            }
            let mut words = vec![self.command.clone()];
            words.extend(self.args.iter().cloned());
            return Ok(words.into_iter().map(Word::Plain).collect());
        }
        let cli = cli(&self.cli).ok_or_else(|| Fail::new(2, format!("unknown cli: {}", self.cli)))?;
        let fill = |template: &[&str], value: &str| -> Vec<String> {
            template.iter().map(|word| word.replace("{}", value)).collect()
        };
        let mut words = vec![cli.bin.to_string()];
        if let Some(id) = resume {
            if cli.resume.is_empty() {
                return Err(Fail::new(2, format!("{} cannot resume a conversation by id", cli.label)));
            }
            words.extend(fill(cli.resume, id));
        }
        if !self.model.is_empty() && !cli.model.is_empty() {
            words.extend(fill(cli.model, &self.model));
        }
        if !self.effort.is_empty() && cli.efforts.contains(&self.effort.as_str()) {
            words.extend(fill(cli.effort, &self.effort));
        }
        let permissions = match (resume, self.permissions.as_str()) {
            (Some(_), _) => cli.ask,
            (None, "auto") => cli.auto.unwrap_or(cli.ask),
            (None, "full") => cli.full.unwrap_or(cli.ask),
            // A new session asks only when the agent says so: otherwise the
            // CLI's own default, which its user may have configured.
            (None, "ask") => cli.ask,
            (None, _) => &[],
        };
        words.extend(permissions.iter().map(|word| word.to_string()));
        let mut words: Vec<Word> = words.into_iter().map(Word::Plain).collect();
        if let Some(prompt) = prompt {
            for template in cli.instructions {
                words.push(prompt.word(template));
            }
        }
        if let Some(status) = status {
            words.extend(fill(cli.status, &status.to_string_lossy()).into_iter().map(Word::Plain));
        }
        let args = if resume.is_some() { without_permission_flags(&self.args) } else { self.args.clone() };
        words.extend(args.into_iter().map(Word::Plain));
        Ok(words)
    }

    /// The line typed into the session's shell. The instructions go through a
    /// file, since typing them would submit the line at their first newline.
    pub fn command_line(&self, resume: Option<&str>, write_prompt: bool) -> Result<String, Fail> {
        self.command_line_with(resume, write_prompt, None)
    }

    /// Whether the CLI takes roer's status hooks.
    pub fn takes_status(&self) -> bool {
        self.cli != "custom" && cli(&self.cli).is_some_and(|cli| !cli.status.is_empty())
    }

    /// `command_line`, with roer's status settings file handed to a CLI that
    /// takes one.
    pub fn command_line_with(&self, resume: Option<&str>, write_prompt: bool, status: Option<&Path>) -> Result<String, Fail> {
        let prompt = if self.instructions.is_empty() {
            None
        } else {
            let prompt = Prompt::for_text(&self.instructions);
            if write_prompt {
                prompt.write(&self.instructions)?;
            }
            Some(prompt)
        };
        if let Some(key) = self.env.keys().find(|key| !is_env_name(key)) {
            return Err(Fail::new(2, format!("not an environment variable name: {key:?}")));
        }
        let words = self.words(resume, prompt.as_ref(), status)?;
        let mut line = String::new();
        for (key, value) in &self.env {
            if cfg!(windows) {
                line.push_str(&format!("$env:{key}={}; ", quote(value)));
            } else {
                line.push_str(&format!("{key}={} ", quote(value)));
            }
        }
        // A custom command is typed as the person wrote it, pipes and all.
        let (program, rest) = words.split_first().expect("words start with the program");
        match program {
            Word::Plain(program) if self.cli == "custom" => line.push_str(program),
            program => line.push_str(&program.typed()),
        }
        for word in rest {
            line.push(' ');
            line.push_str(&word.typed());
        }
        Ok(line)
    }
}

/// Whether a pane running `command` is running the agent whose process names
/// are `procs`: once it quits, the pane runs the shell again, and whatever the
/// person starts next is not the agent.
pub fn is_live(command: &str, procs: &str) -> bool {
    let is_version = command.contains('.')
        && command.split('.').all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()));
    procs.split(' ').any(|proc| !proc.is_empty() && (proc == command || (proc == "claude" && is_version)))
}

/// A setting `sanitize` can drop.
enum Field {
    Model,
    Effort,
    Permissions,
    Instructions,
    Env(String),
}

/// A portable environment variable name.
fn is_env_name(key: &str) -> bool {
    let mut chars = key.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Flags that change what an agent may do unasked, in every CLI roer knows,
/// with whether each takes the next word as its value. A resume drops them
/// from an agent's extra arguments, so that nothing an agent file says can
/// undo the asking a resume promises.
const PERMISSION_FLAGS: &[(&str, bool)] = &[
    ("--dangerously-skip-permissions", false),
    ("--allow-dangerously-skip-permissions", false),
    ("--permission-mode", true),
    ("--dangerously-bypass-approvals-and-sandbox", false),
    ("--approve-for-me", false),
    ("--full-auto", false),
    ("-a", true),
    ("--ask-for-approval", true),
    ("-s", true),
    ("--sandbox", true),
    ("-y", false),
    ("--yolo", false),
    ("--approval-mode", true),
    ("--brave", false),
];

fn without_permission_flags(args: &[String]) -> Vec<String> {
    let mut kept = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let flag = arg.split_once('=').map_or(arg.as_str(), |(flag, _)| flag);
        match PERMISSION_FLAGS.iter().find(|(name, _)| *name == flag) {
            Some((_, takes_value)) => {
                if *takes_value && !arg.contains('=') {
                    iter.next();
                }
            }
            None => kept.push(arg.clone()),
        }
    }
    kept
}

/// One word of the command line.
enum Word {
    Plain(String),
    /// `before` followed by the contents of `path`, which the session's shell
    /// reads when it runs the line.
    Read { before: String, path: PathBuf },
}

impl Word {
    fn typed(&self) -> String {
        match self {
            Word::Plain(word) => quote(word),
            // Inside double quotes, so the contents stay one word; the text
            // before them is a flag's name and never needs escaping there.
            Word::Read { before, path } if cfg!(windows) => {
                format!("\"{before}$(Get-Content -Raw {})\"", quote(&path.to_string_lossy()))
            }
            Word::Read { before, path } => format!("\"{before}$(cat {})\"", quote(&path.to_string_lossy())),
        }
    }
}

/// Where an agent's instructions are put for its CLI to read. Kept by what
/// they say, so two agents with the same ones, or one run twice, share them.
struct Prompt {
    /// The text as it is.
    text: PathBuf,
    /// The text as a TOML string, for a CLI that reads instructions as
    /// configuration: JSON's escapes are TOML's too.
    toml: PathBuf,
}

impl Prompt {
    fn for_text(text: &str) -> Prompt {
        let dir = records::home().join("agents").join(".prompts");
        let stem = format!("{:08x}", crate::names::cksum(text.as_bytes()));
        Prompt { text: dir.join(format!("{stem}.md")), toml: dir.join(format!("{stem}.toml")) }
    }

    fn write(&self, text: &str) -> Result<(), Fail> {
        let fail = |path: &Path, e: std::io::Error| Fail::new(1, format!("could not write {}: {e}", path.display()));
        if let Some(dir) = self.text.parent() {
            std::fs::create_dir_all(dir).map_err(|e| fail(dir, e))?;
        }
        std::fs::write(&self.text, format!("{text}\n")).map_err(|e| fail(&self.text, e))?;
        std::fs::write(&self.toml, Value::String(text.to_string()).to_string()).map_err(|e| fail(&self.toml, e))
    }

    fn word(&self, template: &str) -> Word {
        for (placeholder, path) in [("{text}", &self.text), ("{toml}", &self.toml)] {
            if let Some((before, _)) = template.split_once(placeholder) {
                return Word::Read { before: before.to_string(), path: path.clone() };
            }
        }
        Word::Plain(template.replace("{}", &self.text.to_string_lossy()))
    }
}

/// A word as the session's shell reads it back: left bare when that is safe,
/// so the line shown before a session starts reads like one typed by hand.
fn quote(word: &str) -> String {
    let plain = !word.is_empty()
        && word.chars().all(|c| c.is_ascii_alphanumeric() || "_-./=:@%+,".contains(c));
    if plain {
        word.to_string()
    } else if cfg!(windows) {
        format!("'{}'", word.replace('\'', "''"))
    } else {
        format!("'{}'", word.replace('\'', r"'\''"))
    }
}

/// An agent id: a file name that is also safe as a tmux option and a word
/// on a command line.
pub fn is_agent_name(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.starts_with(['.', '-'])
        && id.chars().all(|c| c.is_ascii_alphanumeric() || "_-.".contains(c))
}

/// An id made from a display name: "Fast pi" is `fast-pi`.
pub fn slug(name: &str) -> String {
    let mut slug = String::new();
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '.' {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    slug.trim_end_matches(['-', '.']).to_string()
}

// ---------------------------------------------------------------------------
// The files.

/// Frontmatter keys roer reads, in the order it writes them. Any other key is
/// kept as it was: the file is the person's.
const KEYS: [&str; 9] = ["name", "description", "cli", "command", "model", "effort", "permissions", "args", "env"];

/// A parsed agent file: the fields roer knows and, verbatim, the ones it
/// does not.
struct Parsed {
    agent: Agent,
    other: Vec<(String, String)>,
}

fn parse(text: &str) -> Parsed {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut agent = Agent::default();
    let mut other = Vec::new();
    let Some(rest) = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n")) else {
        agent.instructions = text.trim().to_string();
        return Parsed { agent, other };
    };
    let (front, body) = match rest.find("\n---") {
        Some(at) => {
            let after = &rest[at + 4..];
            (&rest[..at], after.split_once('\n').map_or("", |(_, body)| body))
        }
        None => (rest, ""),
    };
    agent.instructions = body.trim().to_string();

    // Each top-level key with the indented lines under it.
    let mut entries: Vec<(String, String, Vec<String>)> = Vec::new();
    for line in front.lines() {
        let line = line.trim_end_matches('\r');
        if line.starts_with([' ', '\t', '-']) && !entries.is_empty() {
            entries.last_mut().expect("checked").2.push(line.to_string());
        } else if let Some((key, value)) = line.split_once(':') {
            if !key.trim().is_empty() && !key.trim_start().starts_with('#') {
                entries.push((key.trim().to_string(), value.trim().to_string(), Vec::new()));
            }
        }
    }
    for (key, value, lines) in entries {
        match key.as_str() {
            "name" => agent.name = scalar(&value),
            "description" => agent.description = scalar(&value),
            "cli" => agent.cli = scalar(&value),
            "command" => agent.command = scalar(&value),
            "model" => agent.model = scalar(&value),
            "effort" => agent.effort = scalar(&value),
            "permissions" => agent.permissions = scalar(&value),
            "args" => agent.args = list(&value, &lines),
            "env" => agent.env = map(&value, &lines),
            _ => {
                let mut raw = format!("{key}: {value}").trim_end().to_string();
                for line in lines {
                    raw.push('\n');
                    raw.push_str(&line);
                }
                other.push((key, raw));
            }
        }
    }
    Parsed { agent, other }
}

/// One YAML scalar: quoted either way, or plain with a trailing comment.
fn scalar(value: &str) -> String {
    let value = value.trim();
    if value.starts_with('"') {
        if let Ok(Value::String(s)) = serde_json::from_str::<Value>(quoted_prefix(value, '"')) {
            return s;
        }
    }
    if let Some(inner) = value.strip_prefix('\'') {
        if let Some(end) = find_single_quote_end(inner) {
            return inner[..end].replace("''", "'");
        }
    }
    let value = match value.find(" #") {
        Some(at) => &value[..at],
        None if value.starts_with('#') => "",
        None => value,
    };
    let value = value.trim();
    if value == "~" || value == "null" { String::new() } else { value.to_string() }
}

fn quoted_prefix(value: &str, quote: char) -> &str {
    let mut escaped = false;
    for (i, c) in value.char_indices().skip(1) {
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == quote {
            return &value[..=i];
        }
    }
    value
}

fn find_single_quote_end(inner: &str) -> Option<usize> {
    let bytes = inner.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\'' {
            if bytes.get(i + 1) == Some(&b'\'') {
                i += 2;
                continue;
            }
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Items of a flow sequence, `[a, "b c"]`, split at commas outside quotes.
fn flow_items(inner: &str) -> Vec<String> {
    let mut items = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for c in inner.chars() {
        match quote {
            Some(q) => {
                current.push(c);
                if escaped {
                    escaped = false;
                } else if c == '\\' && q == '"' {
                    escaped = true;
                } else if c == q {
                    quote = None;
                }
            }
            None if c == '"' || c == '\'' => {
                quote = Some(c);
                current.push(c);
            }
            None if c == ',' => items.push(std::mem::take(&mut current)),
            None => current.push(c),
        }
    }
    items.push(current);
    items.into_iter().map(|item| item.trim().to_string()).filter(|item| !item.is_empty()).collect()
}

fn list(value: &str, lines: &[String]) -> Vec<String> {
    if let Some(inner) = value.strip_prefix('[').and_then(|v| v.trim_end().strip_suffix(']')) {
        return flow_items(inner).iter().map(|item| scalar(item)).collect();
    }
    if !value.is_empty() {
        return vec![scalar(value)];
    }
    lines
        .iter()
        .filter_map(|line| line.trim_start().strip_prefix('-'))
        .map(scalar)
        .filter(|item| !item.is_empty())
        .collect()
}

fn map(value: &str, lines: &[String]) -> BTreeMap<String, String> {
    let pairs: Vec<String> = match value.strip_prefix('{').and_then(|v| v.trim_end().strip_suffix('}')) {
        Some(inner) => flow_items(inner),
        None => lines.iter().map(|line| line.trim().to_string()).collect(),
    };
    pairs
        .iter()
        .filter_map(|pair| pair.split_once(':'))
        .map(|(key, value)| (scalar(key), scalar(value)))
        .filter(|(key, _)| !key.is_empty())
        .collect()
}

/// A value as YAML reads it back: JSON's quoting, which YAML accepts, when a
/// plain scalar could be misread.
fn yaml(value: &str) -> String {
    let plain = !value.is_empty()
        && value.chars().all(|c| c.is_ascii_alphanumeric() || " _-./@+()".contains(c))
        && !value.starts_with([' ', '-', '@'])
        && !value.ends_with(' ')
        && !matches!(value.to_ascii_lowercase().as_str(), "true" | "false" | "yes" | "no" | "null" | "on" | "off" | "~")
        && value.parse::<f64>().is_err();
    if plain { value.to_string() } else { Value::String(value.to_string()).to_string() }
}

fn render(agent: &Agent, other: &[(String, String)]) -> String {
    let mut out = String::from("---\n");
    let mut put = |key: &str, value: &str| {
        if !value.is_empty() {
            out.push_str(&format!("{key}: {}\n", yaml(value)));
        }
    };
    put("name", &agent.name);
    put("description", &agent.description);
    put("cli", &agent.cli);
    put("command", &agent.command);
    put("model", &agent.model);
    put("effort", &agent.effort);
    put("permissions", &agent.permissions);
    if !agent.args.is_empty() {
        let items: Vec<String> = agent.args.iter().map(|arg| Value::String(arg.clone()).to_string()).collect();
        out.push_str(&format!("args: [{}]\n", items.join(", ")));
    }
    if !agent.env.is_empty() {
        out.push_str("env:\n");
        for (key, value) in &agent.env {
            out.push_str(&format!("  {key}: {}\n", Value::String(value.clone())));
        }
    }
    for (key, raw) in other {
        if !KEYS.contains(&key.as_str()) {
            out.push_str(raw);
            out.push('\n');
        }
    }
    out.push_str("---\n");
    if !agent.instructions.is_empty() {
        out.push('\n');
        out.push_str(&agent.instructions);
        out.push('\n');
    }
    out
}

// ---------------------------------------------------------------------------
// Where they live, and which one is the default.

pub struct Store {
    user: PathBuf,
    /// The project's `.roer`, when there is a project.
    project: Option<PathBuf>,
}

impl Store {
    pub fn new(project_root: Option<&str>) -> Store {
        let user = records::home();
        // A home directory is not a project: its `.roer` is the person's own.
        let project = project_root.map(|root| Path::new(root).join(".roer")).filter(|dir| !same_dir(dir, &user));
        Store { user, project }
    }

    fn dir(&self, scope: &str) -> Result<PathBuf, Fail> {
        match scope {
            "user" => Ok(self.user.join("agents")),
            "project" => self
                .project
                .as_ref()
                .map(|dir| dir.join("agents"))
                .ok_or_else(|| Fail::new(2, "not in a project, so there is nowhere to share an agent")),
            other => Err(Fail::new(2, format!("unknown scope: {other} (user or project)"))),
        }
    }

    fn read_dir(&self, scope: &str) -> Vec<Agent> {
        let Ok(dir) = self.dir(scope) else { return Vec::new() };
        let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
        let mut agents: Vec<Agent> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("md"))
            .filter_map(|path| {
                let id = path.file_stem()?.to_str()?.to_string();
                if !is_agent_name(&id) {
                    return None;
                }
                let mut agent = parse(&std::fs::read_to_string(&path).ok()?).agent;
                if agent.name.is_empty() {
                    agent.name = id.clone();
                }
                if agent.cli.is_empty() {
                    agent.cli = FALLBACK.to_string();
                }
                agent.id = id;
                agent.source = scope.to_string();
                agent.path = path.to_string_lossy().into_owned();
                Some(agent)
            })
            .collect();
        agents.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        agents
    }

    /// Project agents first, then the person's, then the CLIs themselves; an
    /// id seen once hides the same id further down.
    pub fn all(&self) -> Vec<Agent> {
        let mut agents: Vec<Agent> = Vec::new();
        let builtins = CLIS.iter().map(Agent::builtin);
        for agent in self.read_dir("project").into_iter().chain(self.read_dir("user")).chain(builtins) {
            if !agents.iter().any(|seen| seen.id == agent.id) {
                agents.push(agent);
            }
        }
        agents
    }

    pub fn find(&self, id: &str) -> Option<Agent> {
        self.all().into_iter().find(|agent| agent.id == id)
    }

    fn settings_file(&self, scope: &str) -> Result<PathBuf, Fail> {
        match scope {
            "user" => Ok(self.user.join("settings.json")),
            _ => self.dir("project").map(|dir| dir.with_file_name("settings.json")),
        }
    }

    fn settings(&self, scope: &str) -> Map<String, Value> {
        self.settings_file(scope)
            .ok()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default()
    }

    fn default_in(&self, scope: &str) -> Option<String> {
        self.settings(scope).get("defaultAgent").and_then(Value::as_str).map(str::to_string).filter(|id| !id.is_empty())
    }

    /// `ROER_AGENT`, then the project's choice, then the person's, then
    /// Claude Code. A default naming an agent that is gone falls through.
    pub fn default_id(&self) -> String {
        let chosen = std::env::var("ROER_AGENT").ok().filter(|id| !id.is_empty());
        chosen
            .into_iter()
            .chain(self.default_in("project"))
            .chain(self.default_in("user"))
            .find(|id| self.find(id).is_some())
            .unwrap_or_else(|| FALLBACK.to_string())
    }

    pub fn set_default(&self, scope: &str, id: Option<&str>) -> Result<(), Fail> {
        if let Some(id) = id {
            if self.find(id).is_none() {
                return Err(Fail::new(3, format!("no agent called {id}")));
            }
        }
        let path = self.settings_file(scope)?;
        let mut settings = self.settings(scope);
        match id {
            Some(id) => settings.insert("defaultAgent".into(), id.into()),
            None => settings.remove("defaultAgent"),
        };
        write(&path, &format!("{}\n", serde_json::to_string_pretty(&Value::Object(settings)).unwrap_or_default()))
    }

    /// Writes `agent` into `scope`, as a new file or over the one at `from`,
    /// whose keys roer does not know are kept. Returns what was saved.
    pub fn save(&self, scope: &str, mut agent: Agent, from: Option<&str>) -> Result<Agent, Fail> {
        agent.name = agent.name.trim().to_string();
        if agent.name.is_empty() {
            return Err(Fail::new(2, "an agent needs a name"));
        }
        if agent.id.is_empty() {
            agent.id = slug(&agent.name);
        }
        if !is_agent_name(&agent.id) {
            return Err(Fail::new(2, format!("not a usable agent id: {:?} (letters, digits, - _ .)", agent.id)));
        }
        agent.check().map_err(|why| Fail::new(2, why))?;
        let dir = self.dir(scope)?;
        let path = dir.join(format!("{}.md", agent.id));
        let from = from.filter(|from| !from.is_empty()).map(PathBuf::from);
        if let Some(from) = &from {
            if !self.owns(from) {
                return Err(Fail::new(3, format!("not an agent file: {}", from.display())));
            }
        }
        if path.exists() && from.as_deref() != Some(path.as_path()) {
            return Err(Fail::new(2, format!("there is already an agent called {}", agent.id)));
        }
        let other = from
            .as_ref()
            .and_then(|from| std::fs::read_to_string(from).ok())
            .map(|text| parse(&text).other)
            .unwrap_or_default();
        write(&path, &render(&agent, &other))?;
        if let Some(from) = from.filter(|from| *from != path) {
            let _ = std::fs::remove_file(from);
        }
        agent.source = scope.to_string();
        agent.path = path.to_string_lossy().into_owned();
        Ok(agent)
    }

    pub fn remove(&self, scope: &str, id: &str) -> Result<(), Fail> {
        if !is_agent_name(id) {
            return Err(Fail::new(2, format!("not an agent id: {id}")));
        }
        let path = self.dir(scope)?.join(format!("{id}.md"));
        std::fs::remove_file(&path).map_err(|_| Fail::new(3, format!("no {scope} agent called {id}")))
    }

    /// Whether `path` is an agent file in one of the two directories, so a
    /// path handed in can never make roer overwrite or delete anything else.
    fn owns(&self, path: &Path) -> bool {
        let is_md = path.extension().and_then(|e| e.to_str()) == Some("md");
        let dirs = ["user", "project"].into_iter().filter_map(|scope| self.dir(scope).ok());
        is_md && dirs.into_iter().any(|dir| path.parent() == Some(dir.as_path()))
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    a == b || matches!((std::fs::canonicalize(a), std::fs::canonicalize(b)), (Ok(a), Ok(b)) if a == b)
}

fn write(path: &Path, text: &str) -> Result<(), Fail> {
    let fail = |e: std::io::Error| Fail::new(1, format!("could not write {}: {e}", path.display()));
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(fail)?;
    }
    let partial = path.with_extension("partial");
    std::fs::write(&partial, text).map_err(fail)?;
    std::fs::rename(&partial, path).map_err(fail)
}

// ---------------------------------------------------------------------------
// Which CLIs are installed, and what models each offers.

/// The CLIs found on `PATH`, and failing that, on the one the person's own
/// shell sets up: an app started from Finder has only the system's.
pub fn installed() -> Vec<&'static str> {
    let mut found: Vec<&'static str> = CLIS.iter().filter(|cli| on_path(cli.bin)).map(|cli| cli.id).collect();
    if found.len() == CLIS.len() || cfg!(windows) {
        return found;
    }
    let missing: Vec<&str> = CLIS.iter().filter(|cli| !found.contains(&cli.id)).map(|cli| cli.bin).collect();
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
    let script = format!("command -v {} 2>/dev/null; true", missing.join(" "));
    let out = std::process::Command::new(shell)
        .args(["-ilc", &script])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output();
    if let Ok(out) = out {
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let name = Path::new(line.trim()).file_name().and_then(|n| n.to_str()).unwrap_or_default();
            if line.trim().starts_with('/') {
                if let Some(cli) = CLIS.iter().find(|cli| cli.bin == name && !found.contains(&cli.id)) {
                    found.push(cli.id);
                }
            }
        }
    }
    CLIS.iter().map(|cli| cli.id).filter(|id| found.contains(id)).collect()
}

fn on_path(name: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else { return false };
    let names: Vec<String> = if cfg!(windows) {
        vec![format!("{name}.exe"), format!("{name}.cmd"), name.to_string()]
    } else {
        vec![name.to_string()]
    };
    std::env::split_paths(&path).any(|dir| names.iter().any(|file| dir.join(file).is_file()))
}

/// The models a CLI knows of, as it lists them itself where it can: pi and
/// opencode print them, codex keeps a cache of the ones the account has.
pub fn models(id: &str) -> Vec<String> {
    let fixed = || cli(id).map(|cli| cli.models.iter().map(|m| m.to_string()).collect()).unwrap_or_default();
    let listed = match id {
        "codex" => {
            let path = records::user_home().join(".codex/models_cache.json");
            std::fs::read_to_string(path)
                .ok()
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                .and_then(|value| value.get("models").and_then(Value::as_array).cloned())
                .map(|models| {
                    models
                        .iter()
                        .filter_map(|m| m.get("slug").or_else(|| m.get("id")).and_then(Value::as_str))
                        .filter(|slug| !slug.contains("auto-review"))
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        }
        "pi" => login_shell_lines("pi --list-models")
            .iter()
            .skip(1)
            .filter_map(|line| {
                let mut columns = line.split_whitespace();
                Some(format!("{}/{}", columns.next()?, columns.next()?))
            })
            .collect(),
        "opencode" => login_shell_lines("opencode models")
            .into_iter()
            .filter(|line| line.contains('/') && !line.contains(' '))
            .collect(),
        _ => Vec::new(),
    };
    if listed.is_empty() { fixed() } else { listed }
}

fn login_shell_lines(command: &str) -> Vec<String> {
    if cfg!(windows) {
        return Vec::new();
    }
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
    std::process::Command::new(shell)
        .args(["-ilc", command])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).lines().map(|l| l.trim_end().to_string()).collect())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// `roer agents`.

pub const USAGE: &str = "\
usage: roer agents [list] [--json]
       roer agents show <id>
       roer agents command [<id>]      (no id: an agent as JSON on stdin)
       roer agents models <cli>
       roer agents save [--scope user|project] [--from <path>]   (JSON on stdin)
       roer agents rm <id> [--scope user|project]
       roer agents default [<id> | --clear] [--scope user|project]";

pub fn run(store: &Store, args: &[&str]) -> Result<(), Fail> {
    let (scope, args) = take_flag(args, "--scope")?;
    let scope = scope.unwrap_or("user");
    match args.as_slice() {
        [] | ["list" | "ls"] => {
            print_list(store);
            Ok(())
        }
        ["list" | "ls", "--json"] | ["--json"] => {
            let installed = installed();
            let clis: Vec<Value> = CLIS.iter().map(|cli| cli.describe(installed.contains(&cli.id))).collect();
            let agents: Vec<Value> = store.all().iter().map(Agent::to_json).collect();
            let out = json!({
                "agents": agents,
                "clis": clis,
                "default": store.default_id(),
                "defaults": { "user": store.default_in("user"), "project": store.default_in("project") },
                "project": store.project.is_some(),
            });
            println!("{out}");
            Ok(())
        }
        ["show", id] => {
            let agent = store.find(id).ok_or_else(|| Fail::new(3, format!("no agent called {id}")))?;
            println!("{}", agent.to_json());
            Ok(())
        }
        ["command"] => {
            let agent = Agent::from_json(&stdin_json()?);
            println!("{}", agent.command_line(None, false)?);
            Ok(())
        }
        ["command", id] => {
            let agent = store.find(id).ok_or_else(|| Fail::new(3, format!("no agent called {id}")))?;
            println!("{}", agent.command_line(None, false)?);
            Ok(())
        }
        ["models", id] => {
            for model in models(id) {
                println!("{model}");
            }
            Ok(())
        }
        ["save", rest @ ..] => {
            let (from, rest) = take_flag(rest, "--from")?;
            if !rest.is_empty() {
                return Err(Fail::new(2, USAGE));
            }
            let agent = store.save(scope, Agent::from_json(&stdin_json()?), from)?;
            println!("{}", agent.to_json());
            Ok(())
        }
        ["rm" | "remove", id] => store.remove(scope, id),
        ["default"] => {
            println!("{}", store.default_id());
            Ok(())
        }
        ["default", "--clear"] => store.set_default(scope, None),
        ["default", id] => store.set_default(scope, Some(id)),
        _ => Err(Fail::new(2, USAGE)),
    }
}

fn print_list(store: &Store) {
    let installed = installed();
    let default = store.default_id();
    for agent in store.all() {
        let cli_installed = agent.cli == "custom" || installed.contains(&agent.cli.as_str());
        if agent.source == "builtin" && !cli_installed {
            continue;
        }
        let mark = if agent.id == default { "*" } else { " " };
        let detail: Vec<&str> = [agent.cli.as_str(), agent.model.as_str(), agent.effort.as_str()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect();
        let missing = if cli_installed { "" } else { "  (not installed)" };
        println!("{mark} {:<20} {:<32} {}{missing}", agent.id, detail.join(" · "), agent.source);
    }
}

/// Removes `--flag value` (or `--flag=value`) from anywhere in `args`. A
/// flag with no value is a usage error, never taken as absent.
pub fn take_flag<'a>(args: &[&'a str], flag: &str) -> Result<(Option<&'a str>, Vec<&'a str>), Fail> {
    let mut value = None;
    let mut rest = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if *arg == flag {
            match iter.next() {
                Some(next) if !next.starts_with("--") => value = Some(*next),
                _ => return Err(Fail::new(2, format!("{flag} needs a value"))),
            }
        } else if let Some(v) = arg.strip_prefix(flag).and_then(|v| v.strip_prefix('=')) {
            if v.is_empty() {
                return Err(Fail::new(2, format!("{flag} needs a value")));
            }
            value = Some(v);
        } else {
            rest.push(*arg);
        }
    }
    Ok((value, rest))
}

fn stdin_json() -> Result<Value, Fail> {
    let mut raw = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut raw)
        .map_err(|e| Fail::new(1, format!("could not read stdin: {e}")))?;
    serde_json::from_str(&raw).map_err(|e| Fail::new(2, format!("not JSON: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(cli: &str) -> Agent {
        Agent { id: "a".into(), name: "A".into(), cli: cli.into(), ..Agent::default() }
    }

    #[test]
    fn reads_the_frontmatter_it_knows_and_keeps_the_rest() {
        let text = "---\nname: Reviewer\ndescription: \"Careful: very\"\ncli: codex\nmodel: gpt-5.5 # newest\n\
                    effort: high\nargs: [\"--search\", 'a b']\nenv:\n  CODEX_HOME: ~/.codex-work\ntools:\n  - Read\n  - Grep\n---\n\nReview it.\n";
        let parsed = parse(text);
        assert_eq!(parsed.agent.name, "Reviewer");
        assert_eq!(parsed.agent.description, "Careful: very");
        assert_eq!(parsed.agent.model, "gpt-5.5");
        assert_eq!(parsed.agent.args, vec!["--search", "a b"]);
        assert_eq!(parsed.agent.env.get("CODEX_HOME").map(String::as_str), Some("~/.codex-work"));
        assert_eq!(parsed.agent.instructions, "Review it.");
        assert_eq!(parsed.other, vec![("tools".to_string(), "tools:\n  - Read\n  - Grep".to_string())]);

        let again = parse(&render(&parsed.agent, &parsed.other));
        assert_eq!(again.agent, parsed.agent);
        assert_eq!(again.other, parsed.other);
    }

    #[test]
    fn reads_block_lists_and_a_file_with_no_frontmatter() {
        let parsed = parse("---\nargs:\n  - --search\n  - \"x y\"\n---\n");
        assert_eq!(parsed.agent.args, vec!["--search", "x y"]);
        assert_eq!(parse("Just instructions.").agent.instructions, "Just instructions.");
    }

    #[test]
    fn builds_each_clis_flags() {
        let mut codex = agent("codex");
        codex.model = "gpt-5.5".into();
        codex.effort = "high".into();
        codex.args = vec!["--search".into()];
        assert_eq!(codex.command_line(None, false).unwrap(), "codex -m gpt-5.5 -c model_reasoning_effort=high --search");

        let mut junie = agent("junie");
        junie.model = "gpt-5.5".into();
        junie.effort = "low".into();
        junie.permissions = "full".into();
        assert_eq!(junie.command_line(None, false).unwrap(), "junie --model=gpt-5.5 --effort=low --brave");
    }

    /// Only the path is typed; the shell reads the text in when it runs the
    /// line, as one word however many lines it has.
    #[test]
    fn instructions_are_read_by_the_shell_not_typed() {
        let text = "Review the diff.\nSay \"why\" and it's $HOME.";
        let prompt = Prompt::for_text(text);
        // PowerShell under psmux, sh everywhere else.
        let read = |path: &Path| {
            let path = quote(&path.to_string_lossy());
            if cfg!(windows) { format!("$(Get-Content -Raw {path})") } else { format!("$(cat {path})") }
        };
        let mut junie = agent("junie");
        junie.instructions = text.into();
        let line = junie.command_line(None, false).unwrap();
        assert_eq!(line, format!("junie \"--system-prompt={}\"", read(&prompt.text)));

        let mut codex = agent("codex");
        codex.instructions = text.into();
        let line = codex.command_line(None, false).unwrap();
        assert_eq!(line, format!("codex -c \"developer_instructions={}\"", read(&prompt.toml)));

        let mut claude = agent("claude");
        claude.instructions = text.into();
        let line = claude.command_line(None, false).unwrap();
        assert_eq!(line, format!("claude --append-system-prompt-file {}", quote(&prompt.text.to_string_lossy())));
    }

    /// What the shell reads back for Codex is the text as TOML reads it.
    #[cfg(unix)]
    #[test]
    fn the_toml_copy_reads_back_through_the_shell() {
        let text = "Review the diff.\nSay \"why\" and it's $HOME.";
        let dir = std::env::temp_dir().join(format!("roer-prompt-{}", std::process::id()));
        let written = Prompt { text: dir.join("p.md"), toml: dir.join("p.toml") };
        written.write(text).unwrap();
        let out = std::process::Command::new("sh")
            .args(["-c", &format!("printf %s \"$(cat '{}')\"", written.toml.display())])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), r#""Review the diff.\nSay \"why\" and it's $HOME.""#);
        let _ = std::fs::remove_dir_all(dir);

        let mut claude = agent("claude");
        claude.env.insert("FOO".into(), "a b".into());
        claude.permissions = "auto".into();
        assert_eq!(claude.command_line(None, false).unwrap(), "FOO='a b' claude --permission-mode auto");
    }

    #[test]
    fn a_resume_always_asks_first() {
        let mut claude = agent("claude");
        claude.permissions = "full".into();
        assert_eq!(
            claude.command_line(Some("abc-123"), false).unwrap(),
            "claude --resume abc-123 --permission-mode manual"
        );
        assert_eq!(agent("codex").command_line(Some("abc"), false).unwrap(), "codex resume abc -a untrusted");
        assert!(agent("gemini").command_line(Some("abc"), false).is_err());
    }

    #[test]
    fn hands_claude_the_status_hooks_and_no_one_else() {
        let path = std::path::Path::new("/home/me/.roer/claude-status.json");
        let claude = agent("claude");
        assert!(claude.takes_status());
        assert_eq!(
            claude.command_line_with(None, false, Some(path)).unwrap(),
            "claude --settings /home/me/.roer/claude-status.json"
        );
        let codex = agent("codex");
        assert!(!codex.takes_status());
        assert_eq!(codex.command_line_with(None, false, Some(path)).unwrap(), "codex");
    }

    #[test]
        fn refuses_settings_a_cli_would_ignore() {
        let mut gemini = agent("gemini");
        gemini.effort = "high".into();
        assert!(gemini.check().is_err());
        let mut gemini = agent("gemini");
        gemini.instructions = "Be brief.".into();
        assert!(gemini.check().is_err());
        let mut pi = agent("pi");
        pi.effort = "max".into();
        pi.instructions = "Be brief.".into();
        assert!(pi.check().is_ok());
    }

    #[test]
    fn a_hand_written_file_starts_without_what_its_cli_cannot_take() {
        let mut gemini = agent("gemini");
        gemini.effort = "max".into();
        gemini.instructions = "Be brief.".into();
        assert_eq!(gemini.sanitize().len(), 2);
        assert!(gemini.check().is_ok());
        assert!(gemini.effort.is_empty() && gemini.instructions.is_empty());
    }

    #[test]
    fn a_resume_drops_extra_arguments_that_would_skip_asking() {
        let mut claude = agent("claude");
        claude.args = vec!["--dangerously-skip-permissions".into(), "--permission-mode".into(), "auto".into(), "--verbose".into()];
        assert_eq!(
            claude.command_line(Some("abc"), false).unwrap(),
            "claude --resume abc --permission-mode manual --verbose"
        );
        let mut codex = agent("codex");
        codex.args = vec!["--ask-for-approval=never".into(), "-s".into(), "danger-full-access".into(), "--search".into()];
        assert_eq!(codex.command_line(Some("abc"), false).unwrap(), "codex resume abc -a untrusted --search");
        // A new session keeps them: the agent asked for them.
        assert!(claude.command_line(None, false).unwrap().contains("--dangerously-skip-permissions"));
    }

    #[test]
    fn an_environment_name_can_never_carry_a_command() {
        let mut claude = agent("claude");
        claude.env.insert("X=1;touch /tmp/pwn;#".into(), "v".into());
        assert!(claude.check().is_err());
        assert!(claude.command_line(None, false).is_err());
        assert_eq!(claude.sanitize().len(), 1);
        assert!(claude.env.is_empty());
        claude.env.insert("_OK_1".into(), "v".into());
        assert!(claude.check().is_ok());
    }

    #[test]
    fn a_custom_agent_takes_nothing_but_its_command_and_arguments() {
        let mut custom = agent("custom");
        custom.command = "aider".into();
        assert!(custom.check().is_ok());
        custom.model = "sonnet".into();
        custom.instructions = "Be brief.".into();
        assert!(custom.check().is_err());
        assert_eq!(custom.sanitize().len(), 2);
        assert!(custom.check().is_ok());
    }

    #[test]
    fn a_flag_without_its_value_is_a_usage_error() {
        assert!(take_flag(&["--agent"], "--agent").is_err());
        assert!(take_flag(&["--agent", "--shell"], "--agent").is_err());
        assert!(take_flag(&["--agent="], "--agent").is_err());
        let (value, rest) = take_flag(&["x", "--agent=codex"], "--agent").unwrap();
        assert_eq!((value, rest), (Some("codex"), vec!["x"]));
    }

    #[test]
    fn an_agent_is_live_only_while_its_own_program_runs() {
        assert!(is_live("codex", &agent("codex").procs()));
        assert!(is_live("node", &agent("pi").procs()));
        assert!(is_live("2.1.284", &agent("claude").procs()));
        assert!(!is_live("zsh", &agent("codex").procs()));
        assert!(!is_live("vim", &agent("claude").procs()));
        assert!(!is_live("vim", ""));
        let mut custom = agent("custom");
        custom.command = "FOO=1 /usr/local/bin/aider --model x".into();
        assert_eq!(custom.procs(), "aider");
    }

    #[test]
    fn makes_ids_from_names() {
        assert_eq!(slug("Fast pi"), "fast-pi");
        assert_eq!(slug("  Review: strict! "), "review-strict");
        assert!(is_agent_name("fast-pi"));
        assert!(!is_agent_name("../x"));
        assert!(!is_agent_name("-x"));
    }

    #[test]
    fn saves_renames_and_picks_a_default() {
        let root = std::env::temp_dir().join(format!("roer-agents-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let store = Store { user: root.join("home"), project: Some(root.join("proj/.roer")) };

        let mut draft = agent("pi");
        draft.id = String::new();
        draft.name = "Fast pi".into();
        draft.effort = "low".into();
        let saved = store.save("user", draft.clone(), None).unwrap();
        assert_eq!(saved.id, "fast-pi");
        assert!(store.save("user", draft.clone(), None).is_err(), "a second one of the same name");

        let mut renamed = saved.clone();
        renamed.id = String::new();
        renamed.name = "Quick pi".into();
        let moved = store.save("project", renamed, Some(&saved.path)).unwrap();
        assert!(!Path::new(&saved.path).exists());
        assert_eq!(store.find("quick-pi").unwrap().source, "project");

        assert_eq!(store.default_id(), FALLBACK);
        store.set_default("user", Some("quick-pi")).unwrap();
        assert_eq!(store.default_id(), "quick-pi");
        store.remove("project", &moved.id).unwrap();
        assert_eq!(store.default_id(), FALLBACK, "a default that is gone falls through");
        assert!(store.save("user", draft, Some("/etc/passwd")).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
