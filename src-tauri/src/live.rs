//! Which past conversations an agent still running has open, and where: in
//! one of Roer's panes, whose live row stands for it, or somewhere else.
//!
//! Claude Code and Junie keep a registry of their running processes, each
//! with the conversation it has open. Codex and Pi keep none, so for them a
//! pane's agent is matched to a conversation by what it was started with and
//! when: `resume <id>` names it, and a new one is the latest begun in the
//! agent's folder since the agent started.

use std::cell::OnceCell;
use std::collections::{HashMap, HashSet};

use crate::claude::ClaudeThread;

/// Where a live agent has a conversation open.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Owner {
    /// In one of Roer's own panes, whose live row stands for it.
    Pane,
    /// Anywhere else: another terminal, an editor, another Roer.
    Elsewhere,
}

/// When a registry says its process started, which is what tells it from
/// another that has since been given its pid.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Started<'a> {
    /// As `ps -o lstart` prints it in UTC (`Mon Jan  5 09:30:00 2026`):
    /// Claude Code's `procStart`.
    Lstart(&'a str),
    /// Milliseconds since the epoch: Junie's `startedAt`, which it writes
    /// once it is up, seconds after it started.
    Millis(u64),
    Unknown,
}

/// An agent running in one of Roer's panes.
#[derive(Clone, Debug, Default)]
pub(crate) struct PaneAgent {
    /// Seconds since the epoch.
    pub started: u64,
    /// The folder it runs in, where that can be read.
    pub cwd: Option<String>,
    /// What it was started with, word by word.
    pub args: Vec<String>,
}

/// The process table, read at most once per listing, and only by a listing
/// that needs it.
#[derive(Default)]
pub(crate) struct Table(OnceCell<Processes>);

impl Table {
    pub(crate) fn get(&self) -> &Processes {
        self.0.get_or_init(Processes::read)
    }
}

/// Who is alive, since when, started with what, and who started whom.
#[cfg(not(windows))]
pub(crate) struct Processes {
    table: HashMap<u64, Proc>,
}

#[cfg(not(windows))]
struct Proc {
    parent: u64,
    /// When it started, as `ps -o lstart` prints it in UTC.
    since: String,
    args: String,
}

/// How long before its process started a registry may say it did: `ps`
/// counts in whole seconds.
#[cfg(not(windows))]
const CLOCK_SLACK: u64 = 2;
/// How long after: Junie says so only once it is up, which takes seconds.
#[cfg(not(windows))]
const STARTUP_SLACK: u64 = 60;

#[cfg(not(windows))]
impl Processes {
    fn read() -> Self {
        let out = crate::process::command("ps")
            .env("TZ", "UTC")
            .env("LC_ALL", "C")
            .args(["-A", "-o", "pid=,ppid=,lstart=,args="])
            .output();
        let text = out.map(|out| String::from_utf8_lossy(&out.stdout).into_owned()).unwrap_or_default();
        let table = text
            .lines()
            .filter_map(|line| {
                let mut fields = line.split_whitespace();
                let pid = fields.next()?.parse().ok()?;
                let parent = fields.next()?.parse().ok()?;
                // `lstart` is always five words: `Thu Oct 22 21:52:54 2026`.
                let since = fields.by_ref().take(5).collect::<Vec<_>>().join(" ");
                let args = fields.collect::<Vec<_>>().join(" ");
                Some((pid, Proc { parent, since, args }))
            })
            .collect();
        Processes { table }
    }

    /// `None` once the process is gone, or its pid has gone to another
    /// process since the registry was written. A pane's process is its
    /// shell, or the agent itself, so the pane is found among the process's
    /// ancestors. `panes` are the processes of Roer's panes; `None` when they
    /// are not known, an older shim's, which is any of them.
    pub(crate) fn owner(&self, pid: u64, started: Started, panes: Option<&HashSet<u64>>) -> Option<Owner> {
        let proc = self.table.get(&pid)?;
        let same = match started {
            Started::Lstart(started) => started.split_whitespace().collect::<Vec<_>>().join(" ") == proc.since,
            Started::Millis(ms) => lstart_epoch(&proc.since)
                .is_some_and(|at| ms / 1000 + CLOCK_SLACK >= at && ms / 1000 <= at + STARTUP_SLACK),
            Started::Unknown => true,
        };
        if !same {
            return None;
        }
        let Some(panes) = panes else {
            return Some(Owner::Pane);
        };
        let mut at = pid;
        for _ in 0..64 {
            if panes.contains(&at) {
                return Some(Owner::Pane);
            }
            match self.table.get(&at) {
                Some(proc) if proc.parent != at && proc.parent != 0 => at = proc.parent,
                _ => break,
            }
        }
        Some(Owner::Elsewhere)
    }

    /// The agent running in each of `panes`, where there is one: the first
    /// process, the pane's own or one it started, whose command `is_agent`
    /// says it is.
    pub(crate) fn in_panes(&self, panes: &[u64], is_agent: impl Fn(&[&str]) -> bool) -> Vec<PaneAgent> {
        let mut children: HashMap<u64, Vec<u64>> = HashMap::new();
        for (&pid, proc) in &self.table {
            children.entry(proc.parent).or_default().push(pid);
        }
        let mut found = Vec::new();
        for &pane in panes {
            let mut queue = std::collections::VecDeque::from([pane]);
            let mut seen = HashSet::new();
            while let Some(pid) = queue.pop_front() {
                if !seen.insert(pid) {
                    continue;
                }
                let Some(proc) = self.table.get(&pid) else { continue };
                let words: Vec<&str> = proc.args.split_whitespace().collect();
                if is_agent(&words) {
                    found.push(PaneAgent {
                        started: lstart_epoch(&proc.since).unwrap_or(0),
                        cwd: cwd_of(pid),
                        args: words.iter().map(|word| word.to_string()).collect(),
                    });
                    break;
                }
                queue.extend(children.get(&pid).into_iter().flatten());
            }
        }
        found
    }
}

/// Where a process runs, from `/proc` where there is one, else from `lsof`.
#[cfg(not(windows))]
fn cwd_of(pid: u64) -> Option<String> {
    if let Ok(path) = std::fs::read_link(format!("/proc/{pid}/cwd")) {
        return Some(path.to_string_lossy().into_owned());
    }
    let out = crate::process::command("lsof").args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"]).output().ok()?;
    String::from_utf8_lossy(&out.stdout).lines().find_map(|line| line.strip_prefix('n').map(str::to_string))
}

/// Windows has no `ps`. `tasklist` filtered to one pid prints its row, or
/// an "INFO: No tasks" line — and exits 0 either way, so the answer is in
/// what it prints: the pid as a quoted CSV field. It says nothing of who
/// started whom, so a live conversation is taken for one in a pane, and left
/// to its live row, as before any could be told apart; and no pane's agent
/// can be found.
#[cfg(windows)]
pub(crate) struct Processes;

#[cfg(windows)]
impl Processes {
    fn read() -> Self {
        Processes
    }

    pub(crate) fn owner(&self, pid: u64, _started: Started, _panes: Option<&HashSet<u64>>) -> Option<Owner> {
        crate::process::command("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .is_ok_and(|out| String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\"")))
            .then_some(Owner::Pane)
    }

    pub(crate) fn in_panes(&self, _panes: &[u64], _is_agent: impl Fn(&[&str]) -> bool) -> Vec<PaneAgent> {
        Vec::new()
    }
}

/// Whether a command is `bin`'s: run as itself, or as a script by `node`.
pub(crate) fn runs(words: &[&str], bin: &str) -> bool {
    let name = |word: &str| word.rsplit(['/', '\\']).next().unwrap_or(word).trim_end_matches(".exe").to_string();
    match words {
        [first, ..] if name(first) == bin => true,
        [runner, script, ..] if matches!(name(runner).as_str(), "node" | "bun" | "deno") => name(script) == bin,
        _ => false,
    }
}

/// How long before the agent started a conversation it began may say it
/// began: the two clocks are read apart.
const BEGUN_SLACK: u64 = 5;

/// The ids of `threads` open in `agents`, panes' agents of the one CLI:
/// the one each was resumed with, by `resumed`, and else the latest begun in
/// its folder since it started. Two started in one folder each take one, the
/// later agent the later conversation, so which is whose may be swapped;
/// that both are left to their live rows is what counts.
pub(crate) fn open_in(
    threads: &[ClaudeThread],
    agents: &[PaneAgent],
    resumed: impl Fn(&[String]) -> Option<String>,
) -> HashSet<String> {
    let mut open = HashSet::new();
    let mut fresh = Vec::new();
    for agent in agents {
        match resumed(&agent.args) {
            Some(id) => {
                open.insert(id);
            }
            None => fresh.push(agent),
        }
    }
    fresh.sort_by_key(|agent| std::cmp::Reverse(agent.started));
    for agent in fresh {
        let Some(cwd) = &agent.cwd else { continue };
        let latest = threads
            .iter()
            .filter(|thread| &thread.cwd == cwd && !open.contains(&thread.id))
            .filter(|thread| thread.created_at.is_some_and(|at| at + BEGUN_SLACK >= agent.started))
            .max_by_key(|thread| thread.created_at);
        if let Some(thread) = latest {
            open.insert(thread.id.clone());
        }
    }
    open
}

/// The word after `flag`, or what follows `flag=`.
pub(crate) fn flag_value(args: &[String], flag: &str) -> Option<String> {
    let joined = format!("{flag}=");
    args.iter().enumerate().find_map(|(at, word)| {
        if word == flag {
            args.get(at + 1).cloned()
        } else {
            word.strip_prefix(&joined).map(str::to_string)
        }
    })
}

/// Days from 1970-01-01 to a date, by the proleptic Gregorian calendar.
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let mp = (i64::from(month) + 9) % 12;
    let doy = (153 * mp + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn epoch(year: i64, month: u32, day: u32, h: u32, m: u32, s: u32) -> Option<u64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || h > 23 || m > 59 || s > 60 {
        return None;
    }
    let secs = days_from_civil(year, month, day) * 86_400 + i64::from(h * 3600 + m * 60 + s);
    u64::try_from(secs).ok()
}

/// `Thu Oct 22 21:52:54 2026`, in UTC, as seconds since the epoch.
pub(crate) fn lstart_epoch(text: &str) -> Option<u64> {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let words: Vec<&str> = text.split_whitespace().collect();
    let [_, month, day, time, year] = words[..] else { return None };
    let month = MONTHS.iter().position(|name| *name == month)? as u32 + 1;
    let mut hms = time.split(':').map(str::parse::<u32>);
    let (h, m, s) = (hms.next()?.ok()?, hms.next()?.ok()?, hms.next()?.ok()?);
    epoch(year.parse().ok()?, month, day.parse().ok()?, h, m, s)
}

/// `2026-10-22T19:53:02.123Z`, or with an offset for its zone, as seconds
/// since the epoch.
pub(crate) fn rfc3339_epoch(text: &str) -> Option<u64> {
    let number = |range: std::ops::Range<usize>| text.get(range)?.parse::<u32>().ok();
    if text.len() < 19 || text.as_bytes()[10] != b'T' && text.as_bytes()[10] != b' ' {
        return None;
    }
    let at = epoch(
        i64::from(number(0..4)?),
        number(5..7)?,
        number(8..10)?,
        number(11..13)?,
        number(14..16)?,
        number(17..19)?,
    )?;
    let zone = text[19..].trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    let offset = match zone.as_bytes().first() {
        None | Some(b'Z' | b'z') => 0,
        Some(&sign @ (b'+' | b'-')) => {
            let hours: i64 = zone.get(1..3)?.parse().ok()?;
            let minutes: i64 = zone.get(4..6).or_else(|| zone.get(3..5)).unwrap_or("0").parse().ok()?;
            let secs = hours * 3600 + minutes * 60;
            if sign == b'+' { secs } else { -secs }
        }
        _ => return None,
    };
    u64::try_from(at as i64 - offset).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thread(id: &str, cwd: &str, created_at: Option<u64>) -> ClaudeThread {
        ClaudeThread {
            id: id.to_string(),
            agent: "codex".to_string(),
            cwd: cwd.to_string(),
            title: id.to_string(),
            updated_at: created_at.unwrap_or(0),
            branch: None,
            open_elsewhere: false,
            created_at,
        }
    }

    fn agent(started: u64, cwd: &str, args: &[&str]) -> PaneAgent {
        PaneAgent { started, cwd: Some(cwd.to_string()), args: args.iter().map(|word| word.to_string()).collect() }
    }

    fn resumed(args: &[String]) -> Option<String> {
        args.iter().position(|word| word == "resume").and_then(|at| args.get(at + 1).cloned())
    }

    #[test]
    fn reads_the_times_ps_and_transcripts_write() {
        assert_eq!(lstart_epoch("Thu Jan  1 00:00:00 1970"), Some(0));
        assert_eq!(lstart_epoch("Thu Oct 22 19:52:54 2026"), Some(1_792_698_774));
        assert_eq!(rfc3339_epoch("2026-10-22T19:52:54.123Z"), Some(1_792_698_774));
        assert_eq!(rfc3339_epoch("2026-10-22T21:52:54+02:00"), Some(1_792_698_774));
        assert_eq!(rfc3339_epoch("2026-10-22T18:52:54-0100"), Some(1_792_698_774));
        assert_eq!(rfc3339_epoch("yesterday"), None);
        assert_eq!(lstart_epoch("Thu Foo 22 19:52:54 2026"), None);
    }

    #[test]
    fn a_resumed_agent_has_the_conversation_it_was_resumed_with() {
        let threads = [thread("old", "/w", Some(100)), thread("new", "/w", Some(5_000))];
        let open = open_in(&threads, &[agent(4_000, "/w", &["codex", "resume", "old"])], resumed);
        assert_eq!(open, HashSet::from(["old".to_string()]));
    }

    #[test]
    fn a_new_agent_has_the_latest_conversation_begun_in_its_folder_since() {
        let threads = [
            thread("before", "/w", Some(1_000)),
            thread("since", "/w", Some(4_010)),
            thread("then", "/w", Some(4_500)),
            thread("elsewhere", "/other", Some(4_900)),
            thread("unknown", "/w", None),
        ];
        let open = open_in(&threads, &[agent(4_000, "/w", &["codex"])], resumed);
        assert_eq!(open, HashSet::from(["then".to_string()]));
    }

    #[test]
    fn two_agents_in_one_folder_each_have_one() {
        let threads = [thread("a", "/w", Some(1_010)), thread("b", "/w", Some(2_010)), thread("older", "/w", Some(10))];
        let agents = [agent(1_000, "/w", &["codex"]), agent(2_000, "/w", &["codex"])];
        let open = open_in(&threads, &agents, resumed);
        assert_eq!(open, HashSet::from(["a".to_string(), "b".to_string()]));
    }

    #[test]
    fn an_agent_yet_to_begin_one_has_none() {
        let threads = [thread("before", "/w", Some(1_000))];
        assert!(open_in(&threads, &[agent(4_000, "/w", &["codex"])], resumed).is_empty());
    }

    #[test]
    fn tells_a_command_by_its_name_or_its_script() {
        assert!(runs(&["codex"], "codex"));
        assert!(runs(&["/opt/homebrew/bin/codex", "resume", "x"], "codex"));
        assert!(runs(&["node", "/usr/local/lib/node_modules/.bin/pi", "--session", "x"], "pi"));
        assert!(runs(&["C:\\tools\\pi.exe"], "pi"));
        assert!(!runs(&["vim", "pi"], "pi"), "a file named for it is not it");
        assert!(!runs(&["/bin/zsh"], "codex"));
    }

    #[test]
    fn reads_a_flag_either_way() {
        let args: Vec<String> = ["pi", "--session", "abc", "--session-id=def"].iter().map(|w| w.to_string()).collect();
        assert_eq!(flag_value(&args, "--session").as_deref(), Some("abc"));
        assert_eq!(flag_value(&args, "--session-id").as_deref(), Some("def"));
        assert_eq!(flag_value(&args, "--model"), None);
    }

    /// This test process stands for an agent in a pane: the pane's process is
    /// its parent, and the agent is found among what that started.
    #[cfg(unix)]
    #[test]
    fn finds_the_agent_a_pane_started() {
        let me = std::env::current_exe().unwrap();
        let name = me.file_name().unwrap().to_string_lossy().into_owned();
        let pane = u64::from(std::os::unix::process::parent_id());
        let found = Processes::read().in_panes(&[pane], |words| runs(words, &name));
        assert_eq!(found.len(), 1, "{found:?}");
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(found[0].cwd.as_deref().map(std::path::Path::new), Some(cwd.as_path()));
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        assert!(found[0].started <= now && found[0].started + 3600 > now, "{found:?}");
    }
}
