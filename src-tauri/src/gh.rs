//! GitHub, through the person's own `gh`.
//!
//! Roer holds no token of its own: `gh` is already logged in wherever someone
//! works with GitHub from a terminal, and shelling out to it means the app
//! sees exactly the account, hosts and permissions the terminal does. Every
//! command here works on the repository a session's directory is in.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

/// Where `gh` usually lives when it is not on the inherited `PATH`, which for
/// an app opened from Finder is only `/usr/bin:/bin:/usr/sbin:/sbin`.
#[cfg(target_os = "macos")]
const INSTALL_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];

/// Linux's package managers put `gh` in `/usr/bin`, which a desktop launcher's
/// `PATH` already reaches; what it misses is Homebrew on Linux and a manual
/// install.
#[cfg(not(any(target_os = "macos", windows)))]
const INSTALL_DIRS: &[&str] = &["/home/linuxbrew/.linuxbrew/bin", "/usr/local/bin"];

/// Where GitHub's own installer, and winget with it, puts `gh`.
#[cfg(windows)]
const INSTALL_DIRS: &[&str] = &[r"C:\Program Files\GitHub CLI"];

#[cfg(windows)]
const GH_FILE: &str = "gh.exe";
#[cfg(not(windows))]
const GH_FILE: &str = "gh";

/// Path to `gh`: `ROER_GH` first, then `PATH`, then the usual install
/// locations — the same order [`crate::roer::bin`] uses for the shim.
pub fn bin() -> String {
    resolve(
        std::env::var("ROER_GH").ok(),
        crate::roer::on_path("gh"),
        |path| std::path::Path::new(path).is_file(),
    )
}

fn resolve(explicit: Option<String>, on_path: bool, exists: impl Fn(&str) -> bool) -> String {
    if let Some(explicit) = explicit.filter(|value| !value.is_empty()) {
        return explicit;
    }
    if on_path {
        return "gh".to_string();
    }
    INSTALL_DIRS
        .iter()
        .map(|dir| std::path::Path::new(dir).join(GH_FILE).to_string_lossy().into_owned())
        .find(|path| exists(path))
        // Nothing found: the plain name, so the error names what is missing.
        .unwrap_or_else(|| "gh".to_string())
}

/// `gh`, told never to prompt — there is nowhere to type an answer — and
/// given a `PATH` that also holds its own directory, because `gh pr create`
/// runs git itself and a Finder-launched app's `PATH` may not reach it.
fn command(dir: &str, args: &[&str]) -> Command {
    let bin = bin();
    let mut path: Vec<PathBuf> = Vec::new();
    if let Some(parent) = std::path::Path::new(&bin).parent().filter(|p| !p.as_os_str().is_empty()) {
        path.push(parent.to_path_buf());
    }
    path.extend(INSTALL_DIRS.iter().map(PathBuf::from));
    if let Some(inherited) = std::env::var_os("PATH") {
        path.extend(std::env::split_paths(&inherited));
    }

    let mut gh = crate::process::command(&bin);
    gh.current_dir(dir)
        .args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1");
    if let Ok(joined) = std::env::join_paths(path) {
        gh.env("PATH", joined);
    }
    gh
}

/// Runs `gh`, optionally with `input` on stdin, and hands back stdout — or
/// gh's own complaint, which is already written for a person to read.
fn gh(dir: &str, args: &[&str], input: Option<&str>) -> Result<String, String> {
    let mut child = command(dir, args)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| spawn_error(&e))?;
    if let Some(input) = input {
        // A PR body is far below the pipe buffer, so writing before reading
        // cannot deadlock the way a large `git check-ignore` batch could.
        let mut pipe = child.stdin.take().expect("stdin is a pipe");
        pipe.write_all(input.as_bytes())
            .map_err(|e| format!("could not write to gh: {e}"))?;
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("could not wait for gh: {e}"))?;
    if !out.status.success() {
        let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if why.is_empty() {
            format!("`gh {}` failed", args.join(" "))
        } else {
            why
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn spawn_error(e: &std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        NOT_INSTALLED.to_string()
    } else {
        format!("could not run gh: {e}")
    }
}

const NOT_INSTALLED: &str = "gh is not installed. Install the GitHub CLI (brew install gh) to use pull requests in Roer.";

/// Whether GitHub is reachable from this directory at all, and as whom — what
/// the Pull Request tab needs to know before it can offer anything.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GhStatus {
    pub installed: bool,
    pub authenticated: bool,
    /// `owner/name` of the GitHub repository this directory belongs to.
    pub repo: Option<String>,
    /// Why one of the above is missing, for the tab to show as is.
    pub message: Option<String>,
}

#[tauri::command(async)]
pub fn gh_status(dir: String) -> GhStatus {
    if let Err(message) = gh(&dir, &["--version"], None) {
        return GhStatus { installed: false, authenticated: false, repo: None, message: Some(message) };
    }
    if gh(&dir, &["auth", "status"], None).is_err() {
        return GhStatus {
            installed: true,
            authenticated: false,
            repo: None,
            message: Some("gh is not logged in. Run `gh auth login` in a terminal.".to_string()),
        };
    }
    match gh(&dir, &["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], None) {
        Ok(repo) => GhStatus {
            installed: true,
            authenticated: true,
            repo: Some(repo.trim().to_string()),
            message: None,
        },
        Err(message) => GhStatus { installed: true, authenticated: true, repo: None, message: Some(message) },
    }
}

/// A pull request, as much as the tab's header shows of it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrSummary {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// `OPEN`, `CLOSED` or `MERGED`.
    pub state: String,
    pub is_draft: bool,
    pub head_ref_name: String,
    /// The commit the branch is at, which a merge is pinned to.
    #[serde(default)]
    pub head_ref_oid: String,
    pub base_ref_name: String,
    /// `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or empty.
    #[serde(default)]
    pub review_decision: Option<String>,
}

const PR_FIELDS: &str = "number,title,url,state,isDraft,headRefName,headRefOid,baseRefName,reviewDecision";

/// The pull request for the branch checked out in `dir`, if there is one.
#[tauri::command(async)]
pub fn gh_pr_for_branch(dir: String) -> Result<Option<PrSummary>, String> {
    pr_view(&dir, None)
}

fn pr_view(dir: &str, which: Option<&str>) -> Result<Option<PrSummary>, String> {
    let mut args = vec!["pr", "view"];
    args.extend(which);
    args.extend(["--json", PR_FIELDS]);
    match gh(dir, &args, None) {
        Ok(json) => serde_json::from_str(&json).map(Some).map_err(|e| e.to_string()),
        Err(why) if is_no_pr(&why) => Ok(None),
        Err(why) => Err(why),
    }
}

/// What `gh pr view` says for a branch nothing has been opened from yet —
/// the ordinary case, not a failure.
fn is_no_pr(stderr: &str) -> bool {
    stderr.contains("no pull requests found")
}

/// Pushes the branch if it needs it, opens a pull request from it, and hands
/// back the one that was made.
#[tauri::command(async)]
pub fn gh_pr_create(dir: String, title: String, body: String, base: String, draft: bool) -> Result<PrSummary, String> {
    let root = crate::git::root(&dir)?;
    let branch = crate::git::git(&root, &["branch", "--show-current"])?.trim().to_string();
    if branch.is_empty() {
        return Err("HEAD is detached; check out a branch to open a pull request from.".to_string());
    }
    if branch == base {
        return Err(format!("{branch} is the base branch; open the pull request from another branch."));
    }
    crate::git::push_upstream(&root)?;

    let mut args = vec![
        "pr", "create", "--title", &title, "--body-file", "-", "--base", &base, "--head", &branch,
    ];
    if draft {
        args.push("--draft");
    }
    let url = gh(&root, &args, Some(&body))?;
    pr_view(&root, Some(url.trim()))?
        .ok_or_else(|| format!("created {} but could not read it back", url.trim()))
}

/// Asks Copilot to review the pull request.
///
/// `@copilot` is what `gh pr edit` understands for it; older `gh`s that do
/// not know it are asked through the REST endpoint with Copilot's bot login.
#[tauri::command(async)]
pub fn gh_request_copilot_review(dir: String, number: u64) -> Result<(), String> {
    let number = number.to_string();
    match gh(&dir, &["pr", "edit", &number, "--add-reviewer", "@copilot"], None) {
        Ok(_) => Ok(()),
        Err(first) => {
            let endpoint = format!("repos/{{owner}}/{{repo}}/pulls/{number}/requested_reviewers");
            gh(
                &dir,
                &["api", "-X", "POST", &endpoint, "-f", "reviewers[]=copilot-pull-request-reviewer[bot]"],
                None,
            )
            .map(|_| ())
            .map_err(|second| format!("{first}\n{second}"))
        }
    }
}

/// Which ways of merging the repository's settings allow.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MergeMethods {
    #[serde(rename(deserialize = "mergeCommitAllowed"))]
    pub merge: bool,
    #[serde(rename(deserialize = "squashMergeAllowed"))]
    pub squash: bool,
    #[serde(rename(deserialize = "rebaseMergeAllowed"))]
    pub rebase: bool,
}

#[tauri::command(async)]
pub fn gh_merge_methods(dir: String) -> Result<MergeMethods, String> {
    let json = gh(
        &dir,
        &["repo", "view", "--json", "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed"],
        None,
    )?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

/// `gh pr merge`'s flag for a method, and nothing for anything else: the
/// method arrives from the webview and becomes an argument.
fn merge_flag(method: &str) -> Option<&'static str> {
    match method {
        "merge" => Some("--merge"),
        "squash" => Some("--squash"),
        "rebase" => Some("--rebase"),
        _ => None,
    }
}

/// Merges the pull request into its base, which closes it.
///
/// Pinned to `head`, the commit the person was looking at when they
/// confirmed: if anything was pushed since, GitHub refuses rather than
/// merging code nobody on this screen has seen. The branch is left alone,
/// here and on GitHub.
#[tauri::command(async)]
pub fn gh_pr_merge(dir: String, number: u64, method: String, head: String) -> Result<PrSummary, String> {
    let flag = merge_flag(&method).ok_or_else(|| format!("unknown merge method: {method}"))?;
    if head.is_empty() {
        return Err("the pull request's head commit is unknown; refresh and try again".to_string());
    }
    let number = number.to_string();
    gh(&dir, &["pr", "merge", &number, flag, "--match-head-commit", &head], None)?;
    pr_view(&dir, Some(&number))?.ok_or_else(|| format!("merged #{number} but could not read it back"))
}

/// The system's own "open this" command, and the arguments that go before
/// the link: `open` on macOS, the freedesktop `xdg-open` on Linux, and on
/// Windows the URL handler `start` would reach — called directly, because
/// `cmd /c start` would read the `&` in a query string as a second command.
#[cfg(target_os = "macos")]
const OPENER: (&str, &[&str]) = ("/usr/bin/open", &[]);
#[cfg(windows)]
const OPENER: (&str, &[&str]) = ("rundll32", &["url.dll,FileProtocolHandler"]);
#[cfg(not(any(target_os = "macos", windows)))]
const OPENER: (&str, &[&str]) = ("xdg-open", &[]);

/// Opens a GitHub page in the person's browser. Only web links: this is
/// handed URLs that came back from GitHub, and nothing else should reach
/// the opener, which would just as happily launch a file or an app.
#[tauri::command(async)]
pub fn open_url(url: String) -> Result<(), String> {
    if !is_web_link(&url) {
        return Err(format!("not a web link: {url}"));
    }
    let (opener, before) = OPENER;
    let status = crate::process::command(opener)
        .args(before)
        .arg(&url)
        .status()
        .map_err(|e| format!("could not open {url}: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("could not open {url}: `{opener}` exited with {status}"))
    }
}

fn is_web_link(url: &str) -> bool {
    url.starts_with("https://") && !url.chars().any(char::is_whitespace)
}

/// Everything the tab shows about a pull request's review: who is still
/// expected to review, the reviews submitted, and the inline threads.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrReview {
    pub pending_reviewers: Vec<String>,
    pub reviews: Vec<Review>,
    pub threads: Vec<ReviewThread>,
    /// GitHub had more threads, or more comments in a thread, than one query
    /// fetches: what is shown (and what "select all" picks) is not all of it.
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub author: String,
    /// `COMMENTED`, `APPROVED`, `CHANGES_REQUESTED`, `DISMISSED` or `PENDING`.
    pub state: String,
    pub body: String,
    pub submitted_at: Option<String>,
    pub url: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThread {
    pub id: String,
    pub is_resolved: bool,
    pub is_outdated: bool,
    pub path: String,
    /// The line in the current diff; gone once the code it was on has moved.
    pub line: Option<u32>,
    /// The line it was written against, which an outdated thread still has.
    pub original_line: Option<u32>,
    pub comments: Vec<ReviewComment>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    pub author: String,
    pub body: String,
    pub created_at: String,
    pub url: String,
    pub diff_hunk: String,
}

/// One round trip for the whole review. `{owner}` and `{repo}` are filled in
/// by `gh api` from the directory's own repository.
const REVIEW_QUERY: &str = r#"
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewRequests(first: 20) {
        nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Team { name } } }
      }
      reviews(last: 30) {
        nodes { author { login } state body submittedAt url }
      }
      reviewThreads(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          id isResolved isOutdated path line originalLine
          comments(first: 50) { pageInfo { hasNextPage } nodes { author { login } body createdAt url diffHunk } }
        }
      }
    }
  }
}
"#;

#[tauri::command(async)]
pub fn gh_pr_review(dir: String, number: u64) -> Result<PrReview, String> {
    let number = format!("number={number}");
    let query = format!("query={REVIEW_QUERY}");
    let json = gh(
        &dir,
        &["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-F", &number, "-f", &query],
        None,
    )?;
    parse_review(&json)
}

// The GraphQL response, only as deep as the fields above.

#[derive(Deserialize)]
struct Nodes<T> {
    nodes: Vec<T>,
    #[serde(default, rename = "pageInfo")]
    page_info: PageInfo,
}

#[derive(Default, Deserialize)]
struct PageInfo {
    #[serde(default, rename = "hasNextPage")]
    has_next_page: bool,
}

#[derive(Deserialize)]
struct Actor {
    login: Option<String>,
    name: Option<String>,
}

#[derive(Deserialize)]
struct RawRequest {
    #[serde(rename = "requestedReviewer")]
    requested_reviewer: Option<Actor>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawReview {
    author: Option<Actor>,
    state: String,
    body: String,
    submitted_at: Option<String>,
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawThread {
    id: String,
    is_resolved: bool,
    is_outdated: bool,
    path: String,
    line: Option<u32>,
    original_line: Option<u32>,
    comments: Nodes<RawComment>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawComment {
    author: Option<Actor>,
    body: String,
    created_at: String,
    url: String,
    diff_hunk: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPullRequest {
    review_requests: Nodes<RawRequest>,
    reviews: Nodes<RawReview>,
    review_threads: Nodes<RawThread>,
}

/// A deleted account comes back as a null author; GitHub shows it as ghost.
fn who(actor: Option<Actor>) -> String {
    actor
        .and_then(|a| a.login.or(a.name))
        .unwrap_or_else(|| "ghost".to_string())
}

fn parse_review(json: &str) -> Result<PrReview, String> {
    let value: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    if let Some(errors) = value.get("errors").filter(|e| !e.is_null()) {
        return Err(format!("GitHub rejected the review query: {errors}"));
    }
    let pr = value
        .pointer("/data/repository/pullRequest")
        .filter(|pr| !pr.is_null())
        .ok_or("no such pull request")?;
    let pr: RawPullRequest = serde_json::from_value(pr.clone()).map_err(|e| e.to_string())?;
    let truncated = pr.review_threads.page_info.has_next_page
        || pr.review_threads.nodes.iter().any(|t| t.comments.page_info.has_next_page);

    Ok(PrReview {
        pending_reviewers: pr
            .review_requests
            .nodes
            .into_iter()
            .filter_map(|r| r.requested_reviewer)
            .map(|a| who(Some(a)))
            .collect(),
        reviews: pr
            .reviews
            .nodes
            .into_iter()
            .map(|r| Review {
                author: who(r.author),
                state: r.state,
                body: r.body,
                submitted_at: r.submitted_at,
                url: r.url,
            })
            .collect(),
        threads: pr
            .review_threads
            .nodes
            .into_iter()
            .map(|t| ReviewThread {
                id: t.id,
                is_resolved: t.is_resolved,
                is_outdated: t.is_outdated,
                path: t.path,
                line: t.line,
                original_line: t.original_line,
                comments: t
                    .comments
                    .nodes
                    .into_iter()
                    .map(|c| ReviewComment {
                        author: who(c.author),
                        body: c.body,
                        created_at: c.created_at,
                        url: c.url,
                        diff_hunk: c.diff_hunk,
                    })
                    .collect(),
            })
            .collect(),
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_an_explicit_gh_then_path_then_an_install_location() {
        assert_eq!(resolve(Some("/x/gh".into()), true, |_| true), "/x/gh");
        assert_eq!(resolve(Some(String::new()), true, |_| true), "gh");
        let installed = std::path::Path::new(INSTALL_DIRS[INSTALL_DIRS.len() - 1]).join(GH_FILE);
        let installed = installed.to_string_lossy();
        assert_eq!(resolve(None, false, |p| p == installed), installed);
        assert_eq!(resolve(None, false, |_| false), "gh");
    }

    #[test]
    fn reads_the_merge_methods_a_repository_allows() {
        let json = r#"{"mergeCommitAllowed":false,"rebaseMergeAllowed":true,"squashMergeAllowed":true}"#;
        let methods: MergeMethods = serde_json::from_str(json).unwrap();
        assert_eq!(methods, MergeMethods { merge: false, squash: true, rebase: true });
        // And goes to the frontend under its own short names.
        let out = serde_json::to_value(&methods).unwrap();
        assert_eq!(out, serde_json::json!({"merge": false, "squash": true, "rebase": true}));
    }

    #[test]
    fn only_the_three_merge_methods_become_flags() {
        assert_eq!(merge_flag("squash"), Some("--squash"));
        assert_eq!(merge_flag("merge"), Some("--merge"));
        assert_eq!(merge_flag("rebase"), Some("--rebase"));
        assert_eq!(merge_flag("--admin"), None);
        assert_eq!(merge_flag(""), None);
    }

    #[test]
    fn opens_only_web_links() {
        assert!(is_web_link("https://github.com/o/r/pull/1"));
        assert!(!is_web_link("file:///etc/passwd"));
        assert!(!is_web_link("/Applications/Calculator.app"));
        assert!(!is_web_link("https://x -a Calculator"));
    }

    #[test]
    fn a_branch_without_a_pull_request_is_not_an_error() {
        assert!(is_no_pr("no pull requests found for branch \"feature\""));
        assert!(!is_no_pr("HTTP 401: Bad credentials"));
    }

    #[test]
    fn reads_a_pull_request_summary() {
        let json = r#"{"baseRefName":"main","headRefName":"feat","isDraft":false,"number":19,
            "reviewDecision":"","state":"OPEN","title":"Add a thing","url":"https://github.com/o/r/pull/19"}"#;
        let pr: PrSummary = serde_json::from_str(json).unwrap();
        assert_eq!(pr.number, 19);
        assert_eq!(pr.head_ref_name, "feat");
        assert!(!pr.is_draft);
    }

    #[test]
    fn reads_reviewers_reviews_and_threads() {
        let json = r#"{"data":{"repository":{"pullRequest":{
            "reviewRequests":{"nodes":[{"requestedReviewer":{"__typename":"Bot","login":"copilot-pull-request-reviewer"}},
                                        {"requestedReviewer":{"__typename":"Team","name":"core"}}]},
            "reviews":{"nodes":[{"author":null,"state":"COMMENTED","body":"Looks fine","submittedAt":"2026-09-01T00:00:00Z","url":"u1"}]},
            "reviewThreads":{"pageInfo":{"hasNextPage":false},"nodes":[{"id":"T1","isResolved":false,"isOutdated":true,"path":"src/a.ts",
                "line":null,"originalLine":12,
                "comments":{"nodes":[{"author":{"login":"copilot-pull-request-reviewer"},"body":"Off by one",
                    "createdAt":"2026-09-01T00:00:00Z","url":"u2","diffHunk":"@@ -1 +1 @@\n-a\n+b"}]}}]}
        }}}}"#;
        let review = parse_review(json).unwrap();
        assert_eq!(review.pending_reviewers, ["copilot-pull-request-reviewer", "core"]);
        assert_eq!(review.reviews[0].author, "ghost");
        let thread = &review.threads[0];
        assert_eq!((thread.line, thread.original_line), (None, Some(12)));
        assert!(thread.is_outdated);
        assert_eq!(thread.comments[0].body, "Off by one");
        assert!(!review.truncated);
    }

    #[test]
    fn says_when_github_had_more_than_one_query_fetched() {
        let json = |threads: bool, comments: bool| {
            format!(
                r#"{{"data":{{"repository":{{"pullRequest":{{
                "reviewRequests":{{"nodes":[]}}, "reviews":{{"nodes":[]}},
                "reviewThreads":{{"pageInfo":{{"hasNextPage":{threads}}},"nodes":[{{"id":"T1","isResolved":false,
                    "isOutdated":false,"path":"a","line":1,"originalLine":1,
                    "comments":{{"pageInfo":{{"hasNextPage":{comments}}},"nodes":[]}}}}]}}
            }}}}}}}}"#
            )
        };
        assert!(!parse_review(&json(false, false)).unwrap().truncated);
        assert!(parse_review(&json(true, false)).unwrap().truncated);
        assert!(parse_review(&json(false, true)).unwrap().truncated);
    }

    #[test]
    fn reports_graphql_errors_and_missing_pull_requests() {
        assert!(parse_review(r#"{"errors":[{"message":"nope"}]}"#).unwrap_err().contains("nope"));
        assert!(parse_review(r#"{"data":{"repository":{"pullRequest":null}}}"#).is_err());
    }
}
