//! Past-session history: a deliberate, narrow exception to roer holding no
//! session state of its own.
//!
//! `tmux` stays the sole source of truth for anything live. This file
//! persists only enough to answer "what used to be here" once a session's
//! process has ended and tmux has forgotten it — never a pane id, attach
//! state, command line, or PTY output. Deleting `sessions.json` costs only
//! history, never live functionality.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::roer::SessionInfo;

const VERSION: u32 = 1;

/// Mirrors the shim's own resolution, `ROER_HOME` included.
pub(crate) fn roer_home() -> PathBuf {
    match std::env::var("ROER_HOME") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => crate::roer::home().unwrap_or_default().join(".roer"),
    }
}

fn sessions_file() -> PathBuf {
    roer_home().join("sessions.json")
}

/// Seconds since the epoch. Plain and sortable, and the frontend already
/// has `Date` to turn it into whatever it wants to show.
type Timestamp = u64;

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Record {
    id: String,
    name: String,
    cwd: String,
    #[serde(rename = "createdAt")]
    created_at: Timestamp,
    #[serde(rename = "updatedAt")]
    updated_at: Timestamp,
    #[serde(rename = "endedAt", default, skip_serializing_if = "Option::is_none")]
    ended_at: Option<Timestamp>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Store {
    version: u32,
    sessions: BTreeMap<String, Record>,
}

impl Default for Store {
    fn default() -> Self {
        Store {
            version: VERSION,
            sessions: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PastSession {
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub ended_at: Timestamp,
}

fn load(path: &std::path::Path) -> Store {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Store::default();
    };
    // A version mismatch (or corrupt JSON) drops the file wholesale rather
    // than migrating field-by-field: this is history, not state anything
    // depends on.
    match serde_json::from_str::<Store>(&raw) {
        Ok(store) if store.version == VERSION => store,
        _ => Store::default(),
    }
}

fn save(path: &std::path::Path, store: &Store) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(store)?)?;
    std::fs::rename(&tmp, path)
}

fn now() -> Timestamp {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Reconciles the current live sessions against history and returns past
/// sessions (ended, never re-seen live), most recently ended first.
///
/// Every live id is upserted: `createdAt` is set once, `updatedAt` refreshed
/// every call. Every id that was live before but is absent now gets
/// `endedAt` set, once — a reappearing id (the same tmux session, or the
/// name reused for a new one after `ensure_id` mints a fresh id for it)
/// clears it, since `id` is only ever reused by the *same* underlying
/// session.
pub fn reconcile(live: &[SessionInfo]) -> Vec<PastSession> {
    reconcile_in(&sessions_file(), live)
}

fn reconcile_in(path: &std::path::Path, live: &[SessionInfo]) -> Vec<PastSession> {
    let mut store = load(path);
    let stamp = now();

    let live_ids: std::collections::HashSet<&str> =
        live.iter().map(|s| s.id.as_str()).collect();

    for session in live {
        if session.id.is_empty() {
            continue;
        }
        store
            .sessions
            .entry(session.id.clone())
            .and_modify(|r| {
                r.name = session.session.clone();
                r.cwd = session.cwd.clone();
                r.updated_at = stamp.clone();
                r.ended_at = None;
            })
            .or_insert_with(|| Record {
                id: session.id.clone(),
                name: session.session.clone(),
                cwd: session.cwd.clone(),
                created_at: stamp.clone(),
                updated_at: stamp.clone(),
                ended_at: None,
            });
    }

    for record in store.sessions.values_mut() {
        if !live_ids.contains(record.id.as_str()) && record.ended_at.is_none() {
            record.ended_at = Some(stamp);
        }
    }

    if let Err(e) = save(path, &store) {
        eprintln!("roer: could not write {}: {e}", path.display());
    }

    let mut past: Vec<PastSession> = store
        .sessions
        .values()
        .filter_map(|r| {
            r.ended_at.map(|ended_at| PastSession {
                id: r.id.clone(),
                name: r.name.clone(),
                cwd: r.cwd.clone(),
                created_at: r.created_at,
                updated_at: r.updated_at,
                ended_at,
            })
        })
        .collect();
    past.sort_by(|a, b| b.ended_at.cmp(&a.ended_at));
    past
}

#[cfg(test)]
mod tests {
    use super::*;

    // Each test gets its own file rather than pointing `ROER_HOME` at a temp
    // dir: that env var is process-wide, and `cargo test` runs these
    // concurrently, so two tests racing to set it would each other's writes
    // land in the wrong directory.
    fn temp_file() -> PathBuf {
        std::env::temp_dir().join(format!(
            "roer-history-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn session(id: &str, name: &str) -> SessionInfo {
        SessionInfo {
            id: id.to_string(),
            session: name.to_string(),
            pane: "%0".to_string(),
            attached: true,
            cwd: "/tmp".to_string(),
            command: "zsh".to_string(),
            agent: String::new(),
            title: String::new(),
            activity: 0,
            bell: false,
        }
    }

    #[test]
    fn a_vanished_id_is_marked_ended_exactly_once() {
        let file = temp_file();

        let live = vec![session("abc", "one")];
        let past = reconcile_in(&file, &live);
        assert!(past.is_empty());

        let past = reconcile_in(&file, &[]);
        assert_eq!(past.len(), 1);
        assert_eq!(past[0].id, "abc");
        let ended_first = past[0].ended_at;

        let past = reconcile_in(&file, &[]);
        assert_eq!(past[0].ended_at, ended_first);

        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn a_reappearing_id_clears_ended_at() {
        let file = temp_file();

        reconcile_in(&file, &[session("abc", "one")]);
        let past = reconcile_in(&file, &[]);
        assert_eq!(past.len(), 1);

        let past = reconcile_in(&file, &[session("abc", "one")]);
        assert!(past.is_empty());

        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn a_bad_or_missing_version_drops_the_file() {
        let file = temp_file();
        std::fs::write(&file, r#"{"version":999,"sessions":{}}"#).unwrap();

        let past = reconcile_in(&file, &[session("abc", "one")]);
        assert!(past.is_empty());
        let past = reconcile_in(&file, &[]);
        assert_eq!(past.len(), 1);

        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn the_write_is_atomic_no_tmp_file_left_behind() {
        let file = temp_file();

        reconcile_in(&file, &[session("abc", "one")]);
        assert!(file.is_file());
        assert!(!file.with_extension("json.tmp").exists());

        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn never_persists_pane_attach_or_command() {
        let file = temp_file();

        reconcile_in(&file, &[session("abc", "one")]);
        reconcile_in(&file, &[]);
        let raw = std::fs::read_to_string(&file).unwrap();
        assert!(!raw.contains("pane"));
        assert!(!raw.contains("attached"));
        assert!(!raw.contains("command"));

        std::fs::remove_file(&file).ok();
    }
}
