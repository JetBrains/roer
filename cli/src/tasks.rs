//! `roer task`: the personal work items an agent keeps for you, with the
//! project, one JSON file per task under `.roer/tasks/`.
//!
//! One file each, not one list: two agents in two sessions of the same
//! project can add and edit tasks at once without either rewriting the
//! other's. An id is claimed by creating its file, which only one of them can
//! do, so neither needs a lock.
//!
//! A task is the store's own shape of a work item — what a board draws with
//! `WorkItem` beside a GitHub issue or a YouTrack ticket, as `source:
//! "personal"`. The fields are few on purpose: the ones every tracker has.

use std::io::{ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::records::now_rfc3339;
use crate::Fail;

/// The lanes a personal task moves through.
pub const STATUSES: &[&str] = &["todo", "doing", "done"];

/// The fields a caller may set; `id` and the timestamps are the store's.
const FIELDS: &[&str] = &["title", "status", "body", "labels"];

pub struct Tasks {
    dir: PathBuf,
}

impl Tasks {
    pub fn new(project_root: &str) -> Tasks {
        Tasks { dir: Path::new(project_root).join(".roer/tasks") }
    }

    /// Creates a task from `fields` (`title` required) and returns it.
    pub fn add(&self, fields: &Value) -> Result<Value, Fail> {
        let fields = checked(fields)?;
        let title = fields.get("title").and_then(Value::as_str).unwrap_or_default();
        if title.trim().is_empty() {
            return Err(Fail::new(2, "a task needs a title"));
        }
        std::fs::create_dir_all(&self.dir)
            .map_err(|e| Fail::new(1, format!("could not create {}: {e}", self.dir.display())))?;

        let now = now_rfc3339();
        let mut task = json!({ "id": "", "title": title, "status": "todo" });
        merge(&mut task, &fields);
        task["created"] = now.clone().into();
        task["updated"] = now.into();

        // The next number after the highest taken; if another agent claims it
        // between the look and the create, try the one after.
        let mut n = self.numbers().into_iter().max().unwrap_or(0) + 1;
        loop {
            let id = format!("T-{n}");
            let path = self.path(&id);
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    task["id"] = id.into();
                    // Written straight into the file `create_new` just
                    // claimed, rather than through a temp-file-and-rename: the
                    // destination always already exists at this point (we
                    // just created it), and replacing an existing file by
                    // rename is not dependable on Windows.
                    return file
                        .write_all(pretty(&task).as_bytes())
                        .map(|()| task)
                        .map_err(|e| Fail::new(1, format!("could not write {}: {e}", path.display())));
                }
                Err(e) if e.kind() == ErrorKind::AlreadyExists => n += 1,
                Err(e) => return Err(Fail::new(1, format!("could not create {}: {e}", path.display()))),
            }
        }
    }

    /// Changes the given fields of task `id` and returns it.
    pub fn update(&self, id: &str, fields: &Value) -> Result<Value, Fail> {
        let fields = checked(fields)?;
        if fields.get("title").and_then(Value::as_str).is_some_and(|t| t.trim().is_empty()) {
            return Err(Fail::new(2, "a task needs a title"));
        }
        check_id(id)?;
        let path = self.path(id);
        let mut file = std::fs::OpenOptions::new().read(true).write(true).open(&path).map_err(|e| match e.kind()
        {
            ErrorKind::NotFound => Fail::new(3, format!("no task {id}")),
            _ => Fail::new(1, format!("could not open {}: {e}", path.display())),
        })?;
        // Held across the whole read-merge-write below, so two agents
        // updating the same task at once serialise instead of one silently
        // discarding the other's change: both would otherwise read the same
        // old JSON and the later write would overwrite the earlier field.
        file.lock().map_err(|e| Fail::new(1, format!("could not lock {}: {e}", path.display())))?;
        let mut text = String::new();
        file.read_to_string(&mut text)
            .map_err(|e| Fail::new(1, format!("could not read {}: {e}", path.display())))?;
        let mut task: Value = serde_json::from_str(&text)
            .map_err(|e| Fail::new(1, format!("{} is not JSON: {e}", path.display())))?;
        merge(&mut task, &fields);
        task["updated"] = now_rfc3339().into();
        let out = pretty(&task);
        file.set_len(0)
            .and_then(|()| file.seek(SeekFrom::Start(0)).map(|_| ()))
            .and_then(|()| file.write_all(out.as_bytes()))
            .map_err(|e| Fail::new(1, format!("could not write {}: {e}", path.display())))?;
        Ok(task)
    }

    pub fn get(&self, id: &str) -> Result<Value, Fail> {
        check_id(id)?;
        let path = self.path(id);
        let text = std::fs::read_to_string(&path).map_err(|e| match e.kind() {
            ErrorKind::NotFound => Fail::new(3, format!("no task {id}")),
            _ => Fail::new(1, format!("could not read {}: {e}", path.display())),
        })?;
        serde_json::from_str(&text).map_err(|e| Fail::new(1, format!("{} is not JSON: {e}", path.display())))
    }

    /// Every task, oldest first, or only those with `status`. A file that
    /// doesn't parse — one claimed a moment ago, or edited by hand into
    /// something else — is left out rather than failing the whole list.
    pub fn list(&self, status: Option<&str>) -> Result<Vec<Value>, Fail> {
        if let Some(status) = status {
            check_status(status)?;
        }
        let mut numbers = self.numbers();
        numbers.sort_unstable();
        Ok(numbers
            .into_iter()
            .filter_map(|n| self.get(&format!("T-{n}")).ok())
            .filter(|task| status.is_none_or(|s| task["status"] == s))
            .collect())
    }

    pub fn remove(&self, id: &str) -> Result<(), Fail> {
        check_id(id)?;
        std::fs::remove_file(self.path(id)).map_err(|e| match e.kind() {
            ErrorKind::NotFound => Fail::new(3, format!("no task {id}")),
            _ => Fail::new(1, format!("could not remove task {id}: {e}")),
        })
    }

    fn path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    /// The numbers of the tasks on disk, in no particular order.
    fn numbers(&self) -> Vec<u64> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return Vec::new() };
        entries
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name();
                let id = name.to_str()?.strip_suffix(".json")?;
                task_number(id)
            })
            .collect()
    }
}

/// `T-` and a number: also the file's name, so nothing else may pass.
pub fn task_number(id: &str) -> Option<u64> {
    let digits = id.strip_prefix("T-")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

fn check_id(id: &str) -> Result<(), Fail> {
    task_number(id).map(|_| ()).ok_or_else(|| Fail::new(2, format!("not a task id: {id} (like T-3)")))
}

fn check_status(status: &str) -> Result<(), Fail> {
    if STATUSES.contains(&status) {
        Ok(())
    } else {
        Err(Fail::new(2, format!("status is one of {}, not {status}", STATUSES.join(", "))))
    }
}

/// `fields` as the settable fields of a task, each the right type. Unknown
/// keys are refused rather than stored: a misspelt `stauts` should say so,
/// not sit in the file doing nothing.
fn checked(fields: &Value) -> Result<Map<String, Value>, Fail> {
    let Some(fields) = fields.as_object() else {
        return Err(Fail::new(2, "a task's fields are a JSON object"));
    };
    let mut out = Map::new();
    for (key, value) in fields {
        match key.as_str() {
            "title" | "body" => {
                let Some(text) = value.as_str() else {
                    return Err(Fail::new(2, format!("`{key}` is text")));
                };
                out.insert(key.clone(), text.into());
            }
            "status" => {
                let status = value.as_str().unwrap_or_default();
                check_status(status)?;
                out.insert(key.clone(), status.into());
            }
            "labels" => {
                let labels = value.as_array().filter(|l| l.iter().all(Value::is_string));
                let Some(labels) = labels else {
                    return Err(Fail::new(2, "`labels` is a list of text"));
                };
                out.insert(key.clone(), Value::Array(labels.clone()));
            }
            _ => {
                return Err(Fail::new(2, format!("a task has no field `{key}` (it has {})", FIELDS.join(", "))));
            }
        }
    }
    Ok(out)
}

/// Sets each of `fields` on `task`; an empty body or label list clears it.
fn merge(task: &mut Value, fields: &Map<String, Value>) {
    for (key, value) in fields {
        let empty = value.as_str() == Some("") || value.as_array().is_some_and(Vec::is_empty);
        if empty && key != "title" {
            task.as_object_mut().expect("a task is an object").remove(key);
        } else {
            task[key] = value.clone();
        }
    }
}

fn pretty(task: &Value) -> String {
    serde_json::to_string_pretty(task).expect("a JSON value serialises") + "\n"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(name: &str) -> (Tasks, PathBuf) {
        let root = std::env::temp_dir().join(format!("roer-tasks-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        (Tasks::new(root.to_str().unwrap()), root)
    }

    #[test]
    fn adds_numbers_updates_lists_and_removes() {
        let (tasks, root) = store("lifecycle");
        let a = tasks.add(&json!({ "title": "Write the RFC" })).unwrap();
        let b = tasks.add(&json!({ "title": "Review it", "labels": ["docs"] })).unwrap();
        let created = b["created"].clone();
        assert_eq!((a["id"].as_str(), a["status"].as_str()), (Some("T-1"), Some("todo")));
        assert_eq!(b["id"], "T-2");
        assert!(root.join(".roer/tasks/T-2.json").is_file());

        let b = tasks.update("T-2", &json!({ "status": "doing", "labels": [] })).unwrap();
        assert_eq!(b["status"], "doing");
        assert!(b.get("labels").is_none(), "an empty list clears the field");
        assert_eq!(b["created"], created, "an update keeps when it was created");

        let doing: Vec<Value> = tasks.list(Some("doing")).unwrap();
        assert_eq!(doing.len(), 1);
        assert_eq!(tasks.list(None).unwrap().iter().map(|t| t["id"].clone()).collect::<Vec<_>>(), ["T-1", "T-2"]);

        tasks.remove("T-1").unwrap();
        // A removed number is not reused while a later one exists.
        assert_eq!(tasks.add(&json!({ "title": "Third" })).unwrap()["id"], "T-3");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn concurrent_updates_to_different_fields_both_stick() {
        use std::sync::{Arc, Barrier};

        let (tasks, root) = store("concurrent");
        let tasks = Arc::new(tasks);
        let id = tasks.add(&json!({ "title": "Shared" })).unwrap()["id"].as_str().unwrap().to_string();

        // Without a lock around update's read-merge-write, both threads can
        // read the same pre-update JSON and the later write then overwrites
        // the earlier one's field instead of both landing.
        let barrier = Arc::new(Barrier::new(2));
        let a = {
            let (tasks, id, barrier) = (Arc::clone(&tasks), id.clone(), Arc::clone(&barrier));
            std::thread::spawn(move || {
                barrier.wait();
                tasks.update(&id, &json!({ "status": "doing" })).unwrap();
            })
        };
        let b = {
            let (tasks, id, barrier) = (Arc::clone(&tasks), id.clone(), Arc::clone(&barrier));
            std::thread::spawn(move || {
                barrier.wait();
                tasks.update(&id, &json!({ "labels": ["urgent"] })).unwrap();
            })
        };
        a.join().unwrap();
        b.join().unwrap();

        let task = tasks.get(&id).unwrap();
        assert_eq!(task["status"], "doing");
        assert_eq!(task["labels"], json!(["urgent"]));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn refuses_what_a_task_cannot_hold() {
        let (tasks, root) = store("refuse");
        assert_eq!(tasks.add(&json!({ "title": " " })).unwrap_err().code, 2);
        assert_eq!(tasks.add(&json!({ "title": "x", "status": "blocked" })).unwrap_err().code, 2);
        assert_eq!(tasks.add(&json!({ "title": "x", "stauts": "done" })).unwrap_err().code, 2);
        assert_eq!(tasks.add(&json!({ "title": "x", "labels": [1] })).unwrap_err().code, 2);
        assert_eq!(tasks.update("T-9", &json!({})).unwrap_err().code, 3);
        assert_eq!(tasks.get("../secrets").unwrap_err().code, 2);
        assert_eq!(tasks.list(Some("nope")).unwrap_err().code, 2);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_half_claimed_file_is_skipped_and_its_number_passed_over() {
        let (tasks, root) = store("claimed");
        std::fs::create_dir_all(root.join(".roer/tasks")).unwrap();
        std::fs::write(root.join(".roer/tasks/T-1.json"), "").unwrap();
        assert!(tasks.list(None).unwrap().is_empty());
        assert_eq!(tasks.add(&json!({ "title": "After" })).unwrap()["id"], "T-2");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn task_ids_are_t_and_a_number() {
        assert_eq!(task_number("T-12"), Some(12));
        for bad in ["T-", "T-1a", "t-1", "T-1/..", "12", ""] {
            assert_eq!(task_number(bad), None, "{bad}");
        }
    }
}
