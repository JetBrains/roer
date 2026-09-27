//! Drafted pull requests, terminal → app.
//!
//! The Pull Request tab asks the session's agent to draft a title and body,
//! and the agent answers with `roer pr-draft`, which drops a record into
//! ~/.roer/pr-draft. Same fire-and-forget shape as a plugin-UI message, so
//! it rides the same watcher; the tab fills its form from whichever record
//! is tagged with the pane it is showing.

use serde::{Deserialize, Serialize};

pub const PR_DRAFT_EVENT: &str = "roer://pr-draft";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct PrDraft {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct PrDraftRecord {
    pub pane: String,
    pub draft: PrDraft,
}

pub fn watch<S: crate::events::Sink>(app: S) -> notify::Result<()> {
    let dir = crate::history::roer_home().join("pr-draft");
    crate::plugin_ui::watch_records::<PrDraftRecord, S>(app, dir, PR_DRAFT_EVENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_record_the_shim_writes() {
        let raw = r#"{"pane": "%4", "draft": {"title": "Add PR tab", "body": "Line one\nLine two"}}"#;
        let record: PrDraftRecord = serde_json::from_str(raw).unwrap();
        assert_eq!(record.pane, "%4");
        assert_eq!(record.draft.title, "Add PR tab");
        assert_eq!(record.draft.body, "Line one\nLine two");
    }
}
