//! The flat file list behind Go to File, and the reader behind a file tab.
//!
//! One snapshot per worktree, held in memory and matched here rather than in
//! the renderer: a big repo with a half a million paths, and handing that across
//! the IPC bridge — once, let alone per keystroke — costs more than the search
//! does. What crosses the bridge is a query and fifty answers.
//!
//! The list is `git ls-files --cached --others --exclude-standard`: what git
//! tracks plus what you have just written, with `.gitignore` respected. A file
//! created a minute ago is findable, and `node_modules` is not in the list at
//! all. Read NUL-delimited for the reason `git.rs` reads status that way — a
//! path may hold anything but NUL, and the line form escapes such a name into
//! a spelling that cannot be opened.
//!
//! Nothing here waits for git. A search against a root nobody has asked about
//! yet answers `indexing` and starts the build behind it, so the popup opens
//! now and fills in when the listing lands.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::AppHandle;

use crate::git;
use crate::watch;

/// How long a snapshot is served before a rebuild starts behind it. Long
/// enough that typing one query is one build; short enough that a file written
/// in the terminal is findable about as soon as you look for it.
const STALE_AFTER: Duration = Duration::from_secs(5);

/// How many times its own build cost a snapshot is allowed to be trusted for.
///
/// A flat staleness window cannot fit both kinds of repository. Five seconds
/// is right for a listing that takes twenty milliseconds, and ruinous for one
/// that takes twenty seconds: the snapshot lands already fifteen seconds past
/// its window, so the next keystroke starts another twenty-second listing and
/// the popup never stops indexing. Charging the window against the measured
/// cost keeps a small repository as fresh as it always was and lets a big repo
/// settle, because the rebuild you cannot afford every five seconds is exactly
/// the one that took twenty seconds to make.
const STALE_FACTOR: u32 = 10;

/// The same, for a root a watch is reporting changes under.
///
/// Patching is what keeps a watched snapshot fresh — about a second behind
/// the worktree — so the full re-listing is no longer how it is kept honest.
/// It is a backstop, for the three ways a watch can be *silently* wrong:
/// FSEvents drops events under load, the escalation ladder gives up on
/// purpose, and a `git rm` inside an ignored directory changes the listing
/// without producing an event that is kept. A twenty-second listing every
/// twenty minutes closes all three by itself, which on an experimental
/// feature is worth more than the twenty seconds. Anything that *announces*
/// itself marks the snapshot stale at once instead of waiting for this.
const WATCHED_FACTOR: u32 = 60;

/// The floor for a watched root, for the same reason: a small repository
/// re-lists in milliseconds, and doing that every five seconds forever to
/// catch a hole the watch has almost certainly not left is not a bargain.
const WATCHED_AFTER: Duration = Duration::from_secs(300);

/// How many worktrees are watched at once.
///
/// A session that `cd`s around should not collect a watch per repository it
/// passed through. The least recently asked about is dropped, and dropping
/// the handle is what ends its thread.
const MAX_WATCHED: usize = 8;

/// The most hits one search will return, however many are asked for.
const MAX_HITS: usize = 200;

/// How many paths make it worth spreading the scan across threads. Below
/// this, starting them costs more than the scan they save.
const SPLIT_OVER: usize = 20_000;

/// A file opened in a tab is read up to here. The viewer is for reading code,
/// and a generated bundle is not that; the rest is reported as cut off rather
/// than pulled into memory and tokenised.
const MAX_FILE_BYTES: u64 = 1024 * 1024;

/// A query shorter than this matches almost every path in a large repository,
/// so it is held to the start of a word: `ap` means `App.tsx`, not the `a`
/// and `p` buried in `shape.rs`.
const ANCHOR_UNDER: usize = 3;

/// A matched character at the start of a word — a path segment, or after `_`,
/// `-`, `.`, a space, or a camelCase hump. This is the bonus that makes `gtf`
/// find `GoToFile.tsx`.
const BOUNDARY: i32 = 14;
/// Any other matched character.
const PLAIN: i32 = 2;
/// Each character continuing an unbroken run, times the length of the run so
/// far: a contiguous match reads as the thing the query named.
const RUN: i32 = 10;
/// The longest run length that still earns more than the one before it.
const RUN_CAP: i32 = 4;
/// A matched character inside the file name rather than the directories.
const IN_NAME: i32 = 6;
/// The whole query fitted inside the file name.
const NAME_ONLY: i32 = 40;
/// The file name starts with the query.
const PREFIX: i32 = 50;
/// The file name *is* the query.
const EXACT: i32 = 120;
/// Per character skipped between two matched ones, to a limit.
const GAP: i32 = -1;
/// The most one gap can cost, so a long directory name does not sink a file.
const GAP_CAP: i32 = -12;
/// Per sixteen characters of path, so the shorter of two equal matches wins.
const LONG: i32 = -1;
/// Per directory level, for the same reason.
const DEEP: i32 = -2;

/// Where one path sits in an [`Index`]'s buffer, and where its file name
/// starts inside it.
struct Span {
    start: u32,
    name: u32,
    end: u32,
}

/// One repository's paths, as a snapshot.
///
/// Every path in one contiguous `String` with a `Vec` of offsets over it,
/// rather than a `Vec<String>`: half a million paths is thirty megabytes of
/// text, and spelling that as half a million separate allocations costs more
/// in headers and allocator churn than the text itself.
pub struct Index {
    buffer: String,
    spans: Vec<Span>,
    /// Bumped when a snapshot replaces another, so a caller can tell that the
    /// answer it is holding was made from an older list.
    generation: u64,
    /// When the *full* listing this descends from was taken, which is what
    /// the staleness window is measured against. A patch carries it forward
    /// rather than resetting it: a patched snapshot is fresh, but the whole
    /// point of the backstop is to catch what patching cannot see, so a
    /// steady stream of patches must not hold it off forever.
    built: Instant,
}

impl Index {
    fn path(&self, at: usize) -> &str {
        self.text(&self.spans[at])
    }

    fn text(&self, span: &Span) -> &str {
        &self.buffer[span.start as usize..span.end as usize]
    }

    /// Where the file name starts within the path at `at`.
    fn name_at(&self, at: usize) -> usize {
        let span = &self.spans[at];
        (span.name - span.start) as usize
    }

    pub fn len(&self) -> usize {
        self.spans.len()
    }
}

/// Sorts, deduplicates and packs a NUL-delimited listing into an index.
///
/// **The listing becomes the buffer.** `git ls-files -z` already hands over
/// every path in one contiguous allocation, which is the exact shape the index
/// wants, so it is kept and spanned in place rather than copied into a second
/// buffer of the same size. On a >1M-file repo that listing is 123 MB;
/// copying it out meant holding two of them plus a `Vec<&str>` of 21 MB, and
/// the build peaked at 313 MB to produce a 137 MB index. Spanning in place
/// peaks a little over the index it returns.
///
/// So the order is inverted against the obvious one: the text is never moved
/// and the *spans* are sorted, comparing the slices they point at. Sorting
/// 12-byte spans also moves a third of what sorting 16-byte fat pointers did.
///
/// `--cached --others` can name one path twice — an unmerged file has an index
/// entry per stage — and sorting is wanted anyway: it is the order the popup
/// shows when nothing has been typed yet. Doing both here rather than with
/// `--deduplicate` keeps the module off a git 2.31 floor.
fn collect(listing: String) -> Result<Index, String> {
    if listing.len() > u32::MAX as usize {
        return Err("this repository holds more path text than the index can hold".to_string());
    }

    // One span per path, found by walking the delimiters. `-z` terminates
    // every entry, so the run after the last NUL is empty and contributes
    // nothing — as does the empty listing of a repository with no files.
    let bytes = listing.as_bytes();
    let mut spans: Vec<Span> = Vec::with_capacity(bytes.iter().filter(|b| **b == 0).count());
    let mut start = 0usize;
    for at in memchr_all(bytes) {
        if at > start {
            spans.push(span(&listing, start, at));
        }
        start = at + 1;
    }
    if start < bytes.len() {
        spans.push(span(&listing, start, bytes.len()));
    }

    // Sorted and deduplicated by the text, which is what the popup orders on
    // and what makes a repeated path one row. The buffer keeps the bytes of a
    // dropped duplicate; an unmerged file is rare enough not to be worth a
    // second pass over 123 MB to reclaim them.
    let text = |one: &Span| &listing[one.start as usize..one.end as usize];
    spans.sort_unstable_by(|a, b| text(a).cmp(text(b)));
    spans.dedup_by(|a, b| text(a) == text(b));

    Ok(Index {
        buffer: listing,
        spans,
        generation: 0,
        built: Instant::now(),
    })
}

/// One path's span, with the offset its file name starts at.
fn span(listing: &str, start: usize, end: usize) -> Span {
    let name = match listing[start..end].rfind('/') {
        Some(slash) => start + slash + 1,
        None => start,
    };
    Span {
        start: start as u32,
        name: name as u32,
        end: end as u32,
    }
}

/// Every NUL in the listing. Spelled out rather than pulled in as a crate:
/// the compiler vectorises this, and it runs once per build, not per query.
fn memchr_all(bytes: &[u8]) -> impl Iterator<Item = usize> + '_ {
    bytes
        .iter()
        .enumerate()
        .filter_map(|(at, byte)| (*byte == 0).then_some(at))
}

fn build(root: &str) -> Result<Index, String> {
    collect(git::git(
        root,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
    )?)
}

/// A new index with everything under `dirs` replaced by what git just listed.
///
/// The `Arc<Index>` design forbids editing an index in place — a query clones
/// the pointer and matches against it without holding the lock — so this
/// produces a new one to swap in, exactly as a full rebuild does.
///
/// Because the spans are sorted by path text, everything under `dir/` is one
/// contiguous range, found with two `partition_point` calls. The entry for
/// `dir` itself is a *second*, one-span range, and that separation is
/// load-bearing: `-` and `.` sort below `/`, so `src` and `src/App.tsx` are
/// not neighbours — `src-old`, `src.bak` and anything else spelled that way
/// sit between them — and one range spanning both would quietly eat them.
fn patch<'a>(old: &'a Index, dirs: &[String], listing: &'a str) -> Result<Index, String> {
    let cuts = ranges(old, dirs);

    // What git says is there now. Sorted and deduplicated for the same
    // reasons `collect` does it: `--cached --others` can name an unmerged
    // path once per stage, and sorted is the order the popup shows.
    let mut fresh: Vec<&str> = listing.split('\0').filter(|one| !one.is_empty()).collect();
    fresh.sort_unstable();
    fresh.dedup();

    // Sized exactly, in one pass over what survives. No delimiters go into
    // the buffer: the spans are what say where a path ends.
    let mut bytes = fresh.iter().map(|one| one.len()).sum::<usize>();
    let mut count = fresh.len();
    for span in survivors(old, &cuts) {
        bytes += (span.end - span.start) as usize;
        count += 1;
    }
    if bytes > u32::MAX as usize {
        return Err("this repository holds more path text than the index can hold".to_string());
    }

    // Two sorted runs merged into one, which is all a patch is once the
    // replaced ranges are out of the way: everything git listed falls inside
    // one of them, so no survivor and no new entry can be out of order.
    let mut buffer = String::with_capacity(bytes);
    let mut spans: Vec<Span> = Vec::with_capacity(count);
    let mut kept = survivors(old, &cuts).peekable();
    let mut added = fresh.into_iter().peekable();
    let mut previous: Option<&'a str> = None;
    loop {
        let path = match (kept.peek(), added.peek()) {
            (Some(span), Some(new)) => {
                if old.text(span) <= *new {
                    old.text(kept.next().expect("peeked"))
                } else {
                    added.next().expect("peeked")
                }
            }
            (Some(_), None) => old.text(kept.next().expect("peeked")),
            (None, Some(_)) => added.next().expect("peeked"),
            (None, None) => break,
        };
        // A path git listed that also survived — it can only be one the
        // ranges did not cover — is one row, not two.
        if previous == Some(path) {
            continue;
        }
        previous = Some(path);
        let start = buffer.len();
        buffer.push_str(path);
        let one = span(&buffer, start, buffer.len());
        spans.push(one);
    }

    Ok(Index {
        buffer,
        spans,
        generation: old.generation,
        // Carried over, not reset: see the field.
        built: old.built,
    })
}

/// The spans `dirs` speaks for, as disjoint index ranges in sorted order.
fn ranges(old: &Index, dirs: &[String]) -> Vec<(usize, usize)> {
    let mut cuts: Vec<(usize, usize)> = Vec::with_capacity(dirs.len() * 2);
    for dir in dirs {
        if dir.is_empty() {
            continue;
        }
        // The directory's own entry, when it has one: a path at the top of
        // the worktree stands for itself rather than for its directory.
        let at = old
            .spans
            .partition_point(|one| old.text(one) < dir.as_str());
        if at < old.spans.len() && old.path(at) == dir {
            cuts.push((at, at + 1));
        }

        // Everything under it. `0` is one past `/`, so `src0` is the first
        // path that is no longer inside `src/`.
        let from = format!("{dir}/");
        let to = format!("{dir}0");
        let lo = old
            .spans
            .partition_point(|one| old.text(one) < from.as_str());
        let hi = old.spans.partition_point(|one| old.text(one) < to.as_str());
        if lo < hi {
            cuts.push((lo, hi));
        }
    }

    // One directory may be inside another — the escalation ladder makes that
    // ordinary — so overlapping ranges are merged before anything walks them.
    cuts.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(cuts.len());
    for cut in cuts {
        match merged.last_mut() {
            Some(last) if cut.0 <= last.1 => last.1 = last.1.max(cut.1),
            _ => merged.push(cut),
        }
    }
    merged
}

/// The old spans the cuts leave alone, in order. A cursor rather than a
/// lookup per span, and no `Vec` of its own: on a big repo that would be
/// another twenty-one megabytes to say nothing new.
fn survivors<'a>(old: &'a Index, cuts: &'a [(usize, usize)]) -> impl Iterator<Item = &'a Span> {
    let mut next = 0usize;
    old.spans.iter().enumerate().filter_map(move |(at, span)| {
        while next < cuts.len() && cuts[next].1 <= at {
            next += 1;
        }
        match cuts.get(next) {
            Some(cut) if cut.0 <= at => None,
            _ => Some(span),
        }
    })
}

/// Swaps in a snapshot with `dirs` re-listed from `listing`.
///
/// `false` when there was nothing to patch, or when the snapshot moved under
/// us — either way the caller falls back to marking the root stale, and the
/// next question pays for a full listing.
///
/// The patch itself runs with the lock released. It copies the path buffer —
/// 123 MB and tens of milliseconds on a big repo — and for all of that time
/// queries go on being answered from the `Arc` they already hold. The swap
/// back in is the only part that takes the lock, and it is a pointer.
pub(crate) fn apply(
    repos: &Arc<Mutex<Repos>>,
    root: &str,
    dirs: &[String],
    listing: &str,
) -> Result<bool, String> {
    let old = {
        let state = repos.lock().map_err(|_| poisoned())?;
        // A full rebuild is already running and will land something newer
        // than this patch could describe, so leave it to it.
        if state.building.contains(root) {
            return Ok(false);
        }
        match state.snapshots.get(root) {
            Some(index) => Arc::clone(index),
            // Nothing to patch. The first question about this root is what
            // builds it, and it will see everything by then.
            None => return Ok(false),
        }
    };

    let mut patched = patch(&old, dirs, listing)?;

    let mut state = repos.lock().map_err(|_| poisoned())?;
    match state.snapshots.get(root) {
        // A rebuild finished while we were merging, so what we merged is a
        // patch of something that is no longer on show.
        Some(current) if current.generation != old.generation => Ok(false),
        _ => {
            state.generation += 1;
            patched.generation = state.generation;
            state.snapshots.insert(root.to_string(), Arc::new(patched));
            // This is what a patch is for: the snapshot is current again
            // without anybody re-listing the repository.
            //
            // Safe to clear because the only thing that sets it is the one
            // watcher thread for this root, which is the thread running
            // this — and a mark from anywhere else is a mark against a
            // snapshot this patch did not descend from, which the generation
            // above has already refused.
            state.stale.remove(root);
            Ok(true)
        }
    }
}

/// ASCII case folded, and anything else left alone. Full Unicode folding
/// would allocate per character, and a path is overwhelmingly ASCII.
fn fold(c: char) -> char {
    c.to_ascii_lowercase()
}

fn fold_byte(b: u8) -> u8 {
    if b.is_ascii_uppercase() {
        b + 32
    } else {
        b
    }
}

/// A query, prepared once per search.
struct Needle {
    /// Folded query bytes, for the prefilter.
    bytes: Vec<u8>,
    /// The same query as folded characters, for the scoring pass.
    chars: Vec<char>,
    /// A query naming a directory as well as a file, which is matched against
    /// the whole path rather than preferring the file name.
    has_slash: bool,
}

impl Needle {
    /// `None` for a query with nothing in it to match.
    fn new(query: &str) -> Option<Needle> {
        // Spaces are dropped rather than matched: nothing in a path is a
        // space often enough to be worth failing a query over.
        let chars: Vec<char> = query
            .chars()
            .filter(|c| !c.is_whitespace())
            .map(fold)
            .collect();
        if chars.is_empty() {
            return None;
        }
        let mut bytes = Vec::with_capacity(query.len());
        let mut buffer = [0u8; 4];
        for c in &chars {
            bytes.extend_from_slice(c.encode_utf8(&mut buffer).as_bytes());
        }
        Some(Needle {
            has_slash: chars.contains(&'/'),
            bytes,
            chars,
        })
    }
}

/// Whether every byte of the needle appears in `hay`, in order.
///
/// The hot loop: it is asked about every path in the repository, so it folds
/// case as it goes and allocates nothing. A non-ASCII needle byte compares as
/// itself, which is safe — a UTF-8 continuation byte cannot be mistaken for an
/// ASCII letter — and the character-aware pass in [`place`] rejects the few
/// odd pairings that slip through here.
fn subsequence(hay: &[u8], needle: &[u8]) -> bool {
    let mut k = 0;
    for &b in hay {
        if fold_byte(b) == needle[k] {
            k += 1;
            if k == needle.len() {
                return true;
            }
        }
    }
    false
}

/// Matches the needle against `hay`, writing the byte offset of every matched
/// character into `at`.
///
/// Two passes: forward to find the earliest place the query can finish, then
/// backwards from there, which pulls the matched characters into the tightest
/// cluster ending there. Forward-greedy alone reports the first `a` in a path
/// when the one the reader means is the one in the file name.
fn place(hay: &str, needle: &[char], at: &mut Vec<u32>) -> bool {
    let mut k = 0;
    let mut end = None;
    for (i, c) in hay.char_indices() {
        if fold(c) == needle[k] {
            k += 1;
            if k == needle.len() {
                end = Some(i + c.len_utf8());
                break;
            }
        }
    }
    let Some(end) = end else { return false };

    at.clear();
    at.resize(needle.len(), 0);
    let mut k = needle.len();
    for (i, c) in hay[..end].char_indices().rev() {
        if fold(c) == needle[k - 1] {
            k -= 1;
            at[k] = i as u32;
            if k == 0 {
                break;
            }
        }
    }
    true
}

/// The character at `pos`, and the one before it.
fn around(hay: &str, pos: usize) -> (char, Option<char>) {
    let here = hay[pos..].chars().next().expect("a matched character");
    (here, hay[..pos].chars().next_back())
}

/// Whether a character starts a word, which is where a reader's eye goes.
fn boundary(here: char, before: Option<char>) -> bool {
    match before {
        None => true,
        Some(b) => {
            matches!(b, '/' | '_' | '-' | '.' | ' ') || (here.is_uppercase() && b.is_lowercase())
        }
    }
}

/// Whether the matched characters are one unbroken run.
fn contiguous(hay: &str, at: &[u32]) -> bool {
    at.windows(2).all(|pair| {
        let from = pair[0] as usize;
        hay[from..]
            .chars()
            .next()
            .is_some_and(|c| from + c.len_utf8() == pair[1] as usize)
    })
}

/// Where the last matched character ends.
fn ends(hay: &str, at: &[u32]) -> usize {
    let last = *at.last().expect("a match") as usize;
    last + hay[last..].chars().next().map_or(0, char::len_utf8)
}

/// A short query has to land on the start of a word to count at all.
fn anchored(needle: &Needle, hay: &str, at: &[u32]) -> bool {
    if needle.chars.len() >= ANCHOR_UNDER {
        return true;
    }
    let pos = at[0] as usize;
    let (here, before) = around(hay, pos);
    boundary(here, before)
}

/// What a placed match is worth. `name_at` is where the file name starts in
/// `hay`, which is where the reader is usually looking.
fn value(hay: &str, name_at: usize, at: &[u32]) -> i32 {
    let mut score = 0;
    let mut run = 0;
    let mut after: Option<usize> = None;

    for &offset in at {
        let pos = offset as usize;
        let (here, before) = around(hay, pos);

        score += if boundary(here, before) {
            BOUNDARY
        } else {
            PLAIN
        };
        if pos >= name_at {
            score += IN_NAME;
        }

        match after {
            Some(previous) if previous == pos => {
                run += 1;
                score += RUN * run.min(RUN_CAP);
            }
            Some(previous) => {
                run = 0;
                let skipped = hay[previous..pos].chars().count() as i32;
                score += (GAP * skipped).max(GAP_CAP);
            }
            None => run = 0,
        }
        after = Some(pos + here.len_utf8());
    }
    score
}

/// The penalty a path carries whatever it matched: of two equally good
/// matches, the shorter and shallower path is the one meant.
fn shape(path: &str) -> i32 {
    LONG * (path.len() as i32 / 16) + DEEP * path.matches('/').count() as i32
}

/// What `path` is worth for this needle, with the matched offsets left in
/// `at`, or `None` if it does not really match after all.
fn rank(path: &str, name_at: usize, needle: &Needle, at: &mut Vec<u32>) -> Option<i32> {
    // A query with no slash in it is a question about a file name first:
    // `apptsx` means `App.tsx`, not `a`/`p`/`p`/`t`/`s`/`x` scattered down a
    // path. Only if the name cannot hold the whole query is the path tried.
    if !needle.has_slash {
        let name = &path[name_at..];
        if place(name, &needle.chars, at) && anchored(needle, name, at) {
            let mut score = value(name, 0, at) + NAME_ONLY + shape(path);
            if at[0] == 0 && contiguous(name, at) {
                score += if ends(name, at) == name.len() {
                    EXACT
                } else {
                    PREFIX
                };
            }
            // The offsets were taken inside the name; a caller wants them in
            // the path.
            for offset in at.iter_mut() {
                *offset += name_at as u32;
            }
            return Some(score);
        }
    }

    if !place(path, &needle.chars, at) || !anchored(needle, path, at) {
        return None;
    }
    Some(value(path, name_at, at) + shape(path))
}

/// A candidate on the way to the top of the list. Held instead of a [`Hit`]
/// because it is comparable and costs no allocation.
#[derive(Debug, Eq, PartialEq)]
struct Ranked {
    score: i32,
    len: u32,
    at: u32,
}

impl Ord for Ranked {
    fn cmp(&self, other: &Self) -> Ordering {
        // Better is greater: a higher score, then a shorter path, then the
        // earlier entry in the listing — so the order never depends on which
        // candidate happened to be scored first.
        self.score
            .cmp(&other.score)
            .then_with(|| other.len.cmp(&self.len))
            .then_with(|| other.at.cmp(&self.at))
    }
}

impl PartialOrd for Ranked {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// One path worth showing.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    /// Repo-relative and slash-separated, as git spells it.
    pub path: String,
    /// Byte offset where the file name starts, so a row can dim the directory
    /// without having to split the path again.
    pub name_at: u32,
    pub score: i32,
    /// Byte offsets of the matched characters, for emphasis in the row. Byte
    /// offsets rather than character indices because that is what slicing a
    /// string takes, on both sides of the bridge.
    pub at: Vec<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hits {
    /// The worktree these paths are relative to.
    pub root: String,
    /// Bumped whenever a snapshot is replaced, so a caller can tell that a
    /// newer answer is available for a query it has already asked.
    pub generation: u64,
    /// A build is running: these hits come from an older list, or from none.
    pub indexing: bool,
    /// Files in the snapshot that was searched.
    pub total: usize,
    /// How many matched in all, before the limit was applied.
    pub matched: usize,
    /// The line from a `path:42` query, for the viewer to scroll to.
    pub line: Option<u32>,
    pub hits: Vec<Hit>,
}

/// The best `limit` paths for `query`, and how many matched in all.
/// Ranks one slice of the index, keeping the best `limit` of it.
///
/// Whole and separate so that one thread and many run exactly the same code,
/// and so the ranking can be tested without a thread in sight.
fn scan(
    index: &Index,
    needle: &Needle,
    range: std::ops::Range<usize>,
    limit: usize,
) -> (usize, Vec<Ranked>) {
    let mut best: BinaryHeap<std::cmp::Reverse<Ranked>> = BinaryHeap::with_capacity(limit + 1);
    let mut at: Vec<u32> = Vec::with_capacity(needle.chars.len());
    let mut matched = 0;

    for i in range {
        let path = index.path(i);
        // The cheap test first: this is what rejects almost everything, and
        // scoring only ever sees what survives it.
        if !subsequence(path.as_bytes(), &needle.bytes) {
            continue;
        }
        let Some(score) = rank(path, index.name_at(i), needle, &mut at) else {
            continue;
        };
        matched += 1;

        let ranked = Ranked {
            score,
            len: path.len() as u32,
            at: i as u32,
        };
        if best.len() < limit {
            best.push(std::cmp::Reverse(ranked));
        } else if best
            .peek()
            .is_some_and(|std::cmp::Reverse(worst)| &ranked > worst)
        {
            best.pop();
            best.push(std::cmp::Reverse(ranked));
        }
    }

    (
        matched,
        best.into_iter().map(|std::cmp::Reverse(one)| one).collect(),
    )
}

/// Scans the whole index, on as many threads as the machine offers.
///
/// The prefilter has to read every path, so at half a million of them one
/// core cannot keep a keystroke inside a frame however tight the loop is.
/// Each thread keeps its own best `limit` and the winners are merged, which
/// reaches the answer one thread would have: ranking a path never depends on
/// any other path, and `Ranked` orders on the path's own index, so ties break
/// the same way whatever order the parts come back in.
fn sweep(index: &Index, needle: &Needle, limit: usize) -> (usize, Vec<Ranked>) {
    let total = index.spans.len();
    let threads = std::thread::available_parallelism()
        .map_or(1, std::num::NonZeroUsize::get)
        .min(total / SPLIT_OVER)
        .max(1);
    if threads == 1 {
        return scan(index, needle, 0..total, limit);
    }

    let chunk = total.div_ceil(threads);
    std::thread::scope(|scope| {
        let parts: Vec<_> = (0..threads)
            .map(|n| {
                let range = (n * chunk).min(total)..((n + 1) * chunk).min(total);
                scope.spawn(move || scan(index, needle, range, limit))
            })
            .collect();

        let mut matched = 0;
        let mut ranked = Vec::with_capacity(threads * limit);
        for part in parts {
            // A panic in here is a bug in the matcher rather than a bad
            // query, and there is no sensible answer to give instead of one.
            let (count, best) = part
                .join()
                .unwrap_or_else(|panic| std::panic::resume_unwind(panic));
            matched += count;
            ranked.extend(best);
        }
        (matched, ranked)
    })
}

fn search(index: &Index, query: &str, limit: usize) -> (usize, Vec<Hit>) {
    let Some(needle) = Needle::new(query) else {
        return (0, Vec::new());
    };

    let (matched, mut ranked) = sweep(index, &needle, limit);
    ranked.sort_unstable_by(|a, b| b.cmp(a));
    ranked.truncate(limit);
    let mut at: Vec<u32> = Vec::with_capacity(needle.chars.len());

    // Where the matched characters landed is wanted only for the rows that
    // will be shown, so it is worked out here rather than kept for every
    // candidate above.
    let hits = ranked
        .iter()
        .map(|one| {
            let i = one.at as usize;
            let path = index.path(i);
            let name_at = index.name_at(i);
            rank(path, name_at, &needle, &mut at);
            Hit {
                path: path.to_string(),
                name_at: name_at as u32,
                score: one.score,
                at: at.clone(),
            }
        })
        .collect();

    (matched, hits)
}

/// Splits a trailing `:42` off a query, the way IntelliJ does: a path pasted
/// out of a stack trace should land on the line it names.
fn split_line(query: &str) -> (Option<u32>, &str) {
    let Some((head, tail)) = query.rsplit_once(':') else {
        return (None, query);
    };
    if head.is_empty() || tail.is_empty() || !tail.bytes().all(|b| b.is_ascii_digit()) {
        return (None, query);
    }
    match tail.parse() {
        Ok(line) => (Some(line), head),
        Err(_) => (None, query),
    }
}

#[derive(Default)]
pub(crate) struct Repos {
    snapshots: HashMap<String, Arc<Index>>,
    /// Roots with a build in flight, so a burst of keystrokes is one build.
    building: HashSet<String>,
    /// Roots the watcher has seen something change under, which are stale
    /// whatever their age.
    stale: HashSet<String>,
    /// Live watches, by root. Held here so a root is watched once however
    /// often it is asked about.
    watchers: HashMap<String, Watched>,
    /// How long the last build for a root took, which is what its next
    /// staleness window is measured against.
    took: HashMap<String, Duration>,
    /// Why the last build for a root failed. Reported once and then cleared,
    /// so the next query tries again instead of asking forever.
    failed: HashMap<String, String>,
    generation: u64,
}

/// One worktree's watch, and when it was last worth having.
struct Watched {
    /// Dropping this ends the watch and the thread reading from it.
    _watch: watch::Watch,
    touched: Instant,
}

/// Every repository the app has been asked about, by worktree root.
#[derive(Default)]
pub struct FileIndex {
    repos: Arc<Mutex<Repos>>,
}

fn poisoned() -> String {
    "the file index is poisoned".to_string()
}

/// Start watching a worktree, so the views are told about changes instead of
/// having to ask for them.
///
/// Called from every command that resolves a root, and idempotent because of
/// it: opening the diff view is what asks for live diffs, and never opening
/// it asks for nothing. Arming is cheap enough to do from a per-keystroke
/// path — a recursive FSEvents watch is kernel-side, 4.9 ms on a worktree of
/// 1.36M files — but it is still done once.
pub(crate) fn watch_root<S: crate::events::Sink>(app: &S, state: &FileIndex, root: &str) {
    let Ok(mut repos) = state.repos.lock() else {
        return;
    };
    if let Some(watched) = repos.watchers.get_mut(root) {
        watched.touched = Instant::now();
        return;
    }

    while repos.watchers.len() >= MAX_WATCHED {
        let Some(oldest) = repos
            .watchers
            .iter()
            .min_by_key(|(_, watched)| watched.touched)
            .map(|(root, _)| root.clone())
        else {
            break;
        };
        repos.watchers.remove(&oldest);
    }

    match watch::arm(app.clone(), Arc::clone(&state.repos), root.to_string()) {
        Ok(watch) => {
            repos.watchers.insert(
                root.to_string(),
                Watched {
                    _watch: watch,
                    touched: Instant::now(),
                },
            );
        }
        // Not fatal, and not worth an error on screen: without a watch the
        // views go back to asking, which is what they did before.
        Err(e) => eprintln!("roer: {e}"),
    }
}

/// Retire a root's snapshot: something under it changed.
///
/// Not a rebuild. Nobody may be looking at this repository, and the next
/// question is what pays for the listing — the same bargain every snapshot
/// is already served under, on a much shorter fuse.
pub(crate) fn mark_stale(repos: &Arc<Mutex<Repos>>, root: &str) {
    if let Ok(mut repos) = repos.lock() {
        repos.stale.insert(root.to_string());
    }
}

/// How long a snapshot is trusted, given what the last build for it cost.
///
/// A root nobody has timed yet gets [`STALE_AFTER`], which is also the floor:
/// a listing that takes no time at all is still not worth taking twice in a
/// keystroke.
fn window(took: Option<Duration>, watched: bool) -> Duration {
    let (factor, floor) = if watched {
        (WATCHED_FACTOR, WATCHED_AFTER)
    } else {
        (STALE_FACTOR, STALE_AFTER)
    };
    took.map_or(floor, |took| took.saturating_mul(factor).max(floor))
}

/// Lists a repository on a thread of its own and swaps the result in.
fn rebuild(repos: &Arc<Mutex<Repos>>, root: String) {
    let repos = Arc::clone(repos);
    std::thread::spawn(move || {
        let started = Instant::now();
        let built = build(&root);
        let took = started.elapsed();
        let Ok(mut state) = repos.lock() else { return };
        state.building.remove(&root);
        // Recorded whether it worked or not: a listing that takes twenty
        // seconds to fail should not be retried on the next keystroke either.
        state.took.insert(root.clone(), took);
        match built {
            Ok(mut index) => {
                state.generation += 1;
                index.generation = state.generation;
                state.snapshots.insert(root, Arc::new(index));
            }
            Err(why) => {
                state.failed.insert(root, why);
            }
        }
    });
}

/// The paths in the session's repository that match `query`.
///
/// Answers from whatever snapshot exists and says so: a root nobody has asked
/// about yet is reported as `indexing` with no hits, and a snapshot past
/// [`STALE_AFTER`] is served as it is while a fresh listing is taken behind
/// it. The popup is never made to wait on git.
///
/// `async` is load-bearing and not decoration: Tauri runs a plain synchronous
/// command **on the main thread**, so every keystroke would block the UI for
/// a `git rev-parse` and a scan of the whole index — 35 ms of it on a big repo
/// of 1.36M paths, on every keystroke and on every poll behind a build. This
/// form runs the same body on the async runtime instead, where it can take as
/// long as it likes without the window noticing.
#[tauri::command(async)]
pub fn files_search(
    app: AppHandle,
    state: tauri::State<'_, FileIndex>,
    cwd: String,
    query: String,
    limit: usize,
) -> Result<Hits, String> {
    files_search_core(&app, &state, cwd, query, limit)
}

/// The search itself, generic over the host's [`crate::events::Sink`] so
/// `roer-server` can call it with nothing of Tauri about it.
pub(crate) fn files_search_core<S: crate::events::Sink>(
    app: &S,
    state: &FileIndex,
    cwd: String,
    query: String,
    limit: usize,
) -> Result<Hits, String> {
    let root = git::root(&cwd)?;
    watch_root(app, state, &root);
    let (line, query) = split_line(&query);

    let (snapshot, indexing) = {
        let mut repos = state.repos.lock().map_err(|_| poisoned())?;
        if let Some(why) = repos.failed.remove(&root) {
            return Err(why);
        }
        let snapshot = repos.snapshots.get(&root).cloned();
        let stale = match snapshot.as_ref() {
            // The watcher's word beats the clock in both directions: a root
            // it has seen change is stale however new the snapshot is, and
            // one it has stayed quiet about still ages out, because the
            // things a watch can miss are exactly the ones it cannot report.
            Some(index) => {
                repos.stale.contains(&root)
                    || index.built.elapsed()
                        > window(
                            repos.took.get(&root).copied(),
                            repos.watchers.contains_key(&root),
                        )
            }
            None => true,
        };
        // `insert` answers whether it was already in there, which is what
        // keeps a burst of keystrokes to one `git ls-files`.
        if stale && repos.building.insert(root.clone()) {
            // Cleared as the build starts, not when it lands: a change
            // during the listing has to survive it.
            repos.stale.remove(&root);
            rebuild(&state.repos, root.clone());
        }
        let indexing = repos.building.contains(&root);
        (snapshot, indexing)
    };

    let Some(index) = snapshot else {
        return Ok(Hits {
            root,
            generation: 0,
            indexing: true,
            total: 0,
            matched: 0,
            line,
            hits: Vec::new(),
        });
    };

    let (matched, hits) = search(&index, query, limit.clamp(1, MAX_HITS));
    Ok(Hits {
        root,
        generation: index.generation,
        indexing,
        total: index.len(),
        matched,
        line,
        hits,
    })
}

/// A file's text, as much of it as is worth showing.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    pub text: String,
    /// Lines in `text`, which is what the viewer sizes its scrollbar from.
    pub lines: usize,
    /// The file goes on past what was read.
    pub truncated: bool,
    /// Nothing to show: the viewer says so rather than drawing bytes.
    pub binary: bool,
    /// The whole file's size, whatever was read of it.
    pub bytes: u64,
}

/// Where `path` really is, refusing anything that leaves the worktree.
///
/// Canonicalised on both sides, so neither `../` in the path nor a symlink
/// pointing out of the repository can be used to read elsewhere: a viewer is
/// handed a path by a fuzzy search, and that path is only trustworthy to the
/// extent it is checked.
fn resolve(root: &str, path: &str) -> Result<PathBuf, String> {
    let base = Path::new(root)
        .canonicalize()
        .map_err(|e| format!("could not read {root}: {e}"))?;
    let full = base
        .join(path)
        .canonicalize()
        .map_err(|e| format!("could not read {path}: {e}"))?;
    if !full.starts_with(&base) {
        return Err(format!("{path} is outside the repository"));
    }
    Ok(full)
}

/// One file's text for a file tab.
///
/// `async` for the reason [`files_search`] is: this canonicalises two paths
/// and reads up to a megabyte off disk, and the main thread should not be the
/// one waiting for a cold file.
#[tauri::command(async)]
pub fn file_read(
    app: AppHandle,
    state: tauri::State<'_, FileIndex>,
    root: String,
    path: String,
) -> Result<FileText, String> {
    file_read_core(&app, &state, root, path)
}

/// The reading itself, generic over the host the same way
/// [`files_search_core`] is.
pub(crate) fn file_read_core<S: crate::events::Sink>(
    app: &S,
    state: &FileIndex,
    root: String,
    path: String,
) -> Result<FileText, String> {
    // Opening a file is asking to be told when it changes.
    watch_root(app, state, &root);
    read(&root, &path)
}

/// The reading itself, with nothing of Tauri about it so a test can call it.
fn read(root: &str, path: &str) -> Result<FileText, String> {
    let full = resolve(root, path)?;
    let meta = std::fs::metadata(&full).map_err(|e| format!("could not read {path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{path} is not a file"));
    }
    let bytes = meta.len();

    let file = std::fs::File::open(&full).map_err(|e| format!("could not read {path}: {e}"))?;
    // One byte past the cap is what tells a file ending exactly there from one
    // that goes on.
    let mut read = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut read)
        .map_err(|e| format!("could not read {path}: {e}"))?;
    let truncated = read.len() as u64 > MAX_FILE_BYTES;
    if truncated {
        read.truncate(MAX_FILE_BYTES as usize);
    }

    // The same test git makes, and for the same reason: there is no useful
    // rendering of a file with a NUL in it.
    if read.iter().take(git::SNIFF_BYTES).any(|&b| b == 0) {
        return Ok(FileText {
            text: String::new(),
            lines: 0,
            truncated,
            binary: true,
            bytes,
        });
    }

    // Lossy, which also covers the multi-byte character the cap may have cut
    // in half.
    let text = String::from_utf8_lossy(&read).into_owned();
    let newlines = text.matches('\n').count();
    let lines = newlines + usize::from(!text.is_empty() && !text.ends_with('\n'));
    Ok(FileText {
        text,
        lines,
        truncated,
        binary: false,
        bytes,
    })
}

/// One line `files_grep` found.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct GrepHit {
    /// Repo-relative, as git spells it.
    pub path: String,
    pub line: u32,
    /// The line, cut to its first 300 characters.
    pub text: String,
}

/// The lines of the repository holding `cwd` that contain `pattern`, as a
/// plain string: tracked files and new ones, `.gitignore` respected, binary
/// files skipped. For extensions (`files.grep` in the `roer` SDK).
#[tauri::command(async)]
pub fn files_grep(
    app: AppHandle,
    state: tauri::State<'_, FileIndex>,
    cwd: String,
    pattern: String,
    limit: Option<usize>,
) -> Result<Vec<GrepHit>, String> {
    files_grep_core(&app, &state, cwd, pattern, limit)
}

/// The search itself, for either host.
pub(crate) fn files_grep_core<S: crate::events::Sink>(
    app: &S,
    state: &FileIndex,
    cwd: String,
    pattern: String,
    limit: Option<usize>,
) -> Result<Vec<GrepHit>, String> {
    let root = git::root(&cwd)?;
    // Searching the repository is asking to be told when it changes, so a
    // tab that greps hears `files.changed` and can search again.
    watch_root(app, state, &root);
    let limit = limit.unwrap_or(500).min(5000);
    let out = git::run(
        &root,
        &["grep", "-n", "-I", "-z", "--untracked", "--exclude-standard", "--fixed-strings", "-e", &pattern],
    )?;
    // 1 is git grep's "nothing matched".
    if !out.status.success() && out.status.code() != Some(1) {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(parse_grep(&String::from_utf8_lossy(&out.stdout), limit))
}

/// `path\0line\0text` per line, which is what `-z` makes of `git grep -n`.
fn parse_grep(listing: &str, limit: usize) -> Vec<GrepHit> {
    listing
        .lines()
        .filter_map(|row| {
            let mut parts = row.splitn(3, '\0');
            let path = parts.next()?.to_string();
            let line = parts.next()?.parse().ok()?;
            let text: String = parts.next()?.chars().take(300).collect();
            Some(GrepHit { path, line, text })
        })
        .take(limit)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        build, collect, patch, ranges, read, resolve, scan, search, split_line, subsequence, sweep,
        window, Duration, Index, Needle, SPLIT_OVER, STALE_AFTER, WATCHED_AFTER,
    };
    use super::{parse_grep, GrepHit};
    use crate::testing::{commit, init, must, scratch, write};

    #[test]
    fn grep_rows_split_on_nul_whatever_the_text_holds() {
        let hits = parse_grep("src/a.ts\x0012\x00\t// TODO: x:y\nb.md\x003\x00TODO\n", 10);
        assert_eq!(hits[0], GrepHit { path: "src/a.ts".into(), line: 12, text: "\t// TODO: x:y".into() });
        assert_eq!(hits[1].line, 3);
        assert_eq!(parse_grep("a\x001\x00x\nb\x002\x00y\n", 1).len(), 1);
    }

    /// An index over these paths, listed the way `git ls-files -z` lists
    /// them: every entry NUL-terminated, including the last.
    fn index(paths: &[&str]) -> Index {
        collect(listing(paths)).expect("an index")
    }

    fn listing<S: AsRef<str>>(paths: &[S]) -> String {
        paths.iter().fold(String::new(), |mut all, path| {
            all.push_str(path.as_ref());
            all.push('\0');
            all
        })
    }

    #[test]
    fn trusts_a_snapshot_for_longer_the_more_it_cost_to_make() {
        // Nothing measured yet, and a listing quick enough that the floor is
        // what answers: a keystroke must not start a build per keystroke.
        assert_eq!(window(None, false), STALE_AFTER);
        assert_eq!(window(Some(Duration::from_millis(20)), false), STALE_AFTER);

        // The case that made this a function. `git ls-files` over a 1.36M-file
        // big repo takes twenty seconds, so a flat five-second window handed
        // back a snapshot that was already stale on arrival and the popup
        // rebuilt forever. Twenty seconds of work buys two hundred of trust.
        assert_eq!(
            window(Some(Duration::from_secs(20)), false),
            Duration::from_secs(200)
        );

        // A watched root is kept current by patches, so the clock is only
        // the backstop: the same big repo re-lists every twenty minutes
        // instead of every three, and a quick one every five minutes
        // instead of every five seconds.
        assert_eq!(window(None, true), WATCHED_AFTER);
        assert_eq!(window(Some(Duration::from_millis(20)), true), WATCHED_AFTER);
        assert_eq!(
            window(Some(Duration::from_secs(20)), true),
            Duration::from_secs(1200)
        );
    }

    /// Every path in an index, which is what a patch has to be judged on.
    fn paths(index: &Index) -> Vec<&str> {
        (0..index.len()).map(|at| index.path(at)).collect()
    }

    #[test]
    fn puts_what_git_just_listed_in_its_sorted_place() {
        let old = index(&["README.md", "src/App.tsx", "src/lib/tabs.ts"]);
        let one = patch(
            &old,
            &["src".to_string()],
            &listing(&["src/App.tsx", "src/Code.tsx"]),
        )
        .expect("a patched index");

        // `src/Code.tsx` appeared. `src/lib/tabs.ts` is gone with everything
        // else under the pathspec that the listing did not name — a
        // directory pathspec lists its whole subtree, so not being in the
        // answer means not being there. `README.md` was never covered and is
        // untouched.
        assert_eq!(
            paths(&one),
            vec!["README.md", "src/App.tsx", "src/Code.tsx"]
        );
    }

    #[test]
    fn drops_what_git_no_longer_lists() {
        let old = index(&["src/App.tsx", "src/gone.ts"]);
        let one =
            patch(&old, &["src".to_string()], &listing(&["src/App.tsx"])).expect("a patched index");
        assert_eq!(paths(&one), vec!["src/App.tsx"]);
        // And the buffer holds only live text: the deleted path is not
        // sitting in it unreferenced.
        assert_eq!(one.buffer, "src/App.tsx");
    }

    #[test]
    fn keeps_a_patched_snapshot_measured_from_its_full_listing() {
        let old = index(&["src/App.tsx"]);
        let one =
            patch(&old, &["src".to_string()], &listing(&["src/App.tsx"])).expect("a patched index");
        // Not reset. Patches are exactly what the backstop cannot see, so a
        // steady stream of them must not hold the full listing off forever.
        assert_eq!(one.built, old.built);
    }

    #[test]
    fn leaves_a_path_listed_twice_as_one_row() {
        // What an unmerged file looks like: one entry per stage.
        let old = index(&["src/App.tsx"]);
        let one = patch(
            &old,
            &["src".to_string()],
            &listing(&["src/App.tsx", "src/App.tsx", "src/App.tsx"]),
        )
        .expect("a patched index");
        assert_eq!(paths(&one), vec!["src/App.tsx"]);
    }

    #[test]
    fn replaces_a_path_at_the_top_of_the_worktree_without_touching_its_neighbours() {
        let old = index(&["README.md", "package.json", "src/App.tsx"]);
        // A file at the top stands for itself, so the pathspec is the file.
        let one = patch(&old, &["README.md".to_string()], &listing::<&str>(&[]))
            .expect("a patched index");
        assert_eq!(paths(&one), vec!["package.json", "src/App.tsx"]);
    }

    #[test]
    fn takes_a_directory_and_its_subtree_as_two_ranges() {
        // The case a single range would silently eat. `-` is 0x2D and `.` is
        // 0x2E, both below `/` at 0x2F, so `src-old` and `src.bak` sort
        // between `src` and anything inside `src/`.
        let old = index(&[
            "src",
            "src-old",
            "src.bak",
            "src/App.tsx",
            "src/lib/tabs.ts",
            "src0",
        ]);
        let cuts = ranges(&old, &["src".to_string()]);
        // `src` itself, and then its subtree — with the three neighbours in
        // between left out of both.
        assert_eq!(cuts, vec![(0, 1), (3, 5)]);

        let one =
            patch(&old, &["src".to_string()], &listing(&["src/App.tsx"])).expect("a patched index");
        assert_eq!(
            paths(&one),
            vec!["src-old", "src.bak", "src/App.tsx", "src0"]
        );
    }

    #[test]
    fn merges_a_directory_asked_about_inside_another() {
        // Which the collapsing ladder makes ordinary: a batch can name both
        // `src` and `src/lib` before anything reduces it.
        let old = index(&["src/App.tsx", "src/lib/tabs.ts"]);
        let cuts = ranges(&old, &["src/lib".to_string(), "src".to_string()]);
        assert_eq!(cuts, vec![(0, 2)]);

        let one = patch(
            &old,
            &["src/lib".to_string(), "src".to_string()],
            &listing(&["src/App.tsx"]),
        )
        .expect("a patched index");
        assert_eq!(paths(&one), vec!["src/App.tsx"]);
    }

    /// The scoped listing a batch takes, as [`crate::watch`] assembles it.
    fn scoped(root: &str, dirs: &[&str]) -> String {
        let specs: Vec<String> = dirs.iter().map(|dir| crate::git::literal(dir)).collect();
        let mut args = vec![
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
            "--",
        ];
        args.extend(specs.iter().map(String::as_str));
        crate::git::git(root, &args).expect("a scoped listing")
    }

    #[test]
    fn follows_a_real_worktree_through_a_scoped_listing() {
        let dir = scratch("files-patched");
        let root = dir.to_str().expect("a utf-8 path");
        init(root);
        write(&dir, ".gitignore", "target/\n");
        write(&dir, "src/App.tsx", "export {};\n");
        must(root, &["add", "-A"]);
        commit(root, "first");

        let index = build(root).expect("an index");
        assert_eq!(paths(&index), vec![".gitignore", "src/App.tsx"]);

        // An agent writes a file, and a build drops something into an
        // ignored directory at the same time.
        write(&dir, "src/Code.tsx", "export {};\n");
        write(&dir, "target/debug/roer", "a binary\n");
        let index = patch(&index, &["src"].map(String::from), &scoped(root, &["src"]))
            .expect("a patched index");
        assert_eq!(
            paths(&index),
            vec![".gitignore", "src/App.tsx", "src/Code.tsx"]
        );
        // Findable, which is the whole point: no full listing was taken.
        let (_, hits) = search(&index, "code", 5);
        assert_eq!(
            hits.first().map(|hit| hit.path.as_str()),
            Some("src/Code.tsx")
        );

        // And gone again when it goes, without the rest of the index moving.
        std::fs::remove_file(dir.join("src/Code.tsx")).expect("removed");
        let index = patch(&index, &["src"].map(String::from), &scoped(root, &["src"]))
            .expect("a patched index");
        assert_eq!(paths(&index), vec![".gitignore", "src/App.tsx"]);

        std::fs::remove_dir_all(&dir).expect("cleaned up");
    }

    #[test]
    fn re_lists_a_directory_whose_name_looks_like_a_glob() {
        let dir = scratch("files-literal");
        let root = dir.to_str().expect("a utf-8 path");
        init(root);
        write(&dir, "a[1]/kept.ts", "export {};\n");
        write(&dir, "README.md", "# hi\n");
        must(root, &["add", "-A"]);

        let old = build(root).expect("an index");
        let listed = crate::git::git(
            root,
            &[
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
                "--",
                &crate::git::literal("a[1]"),
            ],
        )
        .expect("a scoped listing");
        // Read as a glob, `a[1]` is the character class `1` and matches
        // nothing at all — so the patch would delete the directory.
        assert_eq!(listed, "a[1]/kept.ts\0");

        let one = patch(&old, &["a[1]".to_string()], &listed).expect("a patched index");
        assert_eq!(paths(&one), vec!["README.md", "a[1]/kept.ts"]);
    }

    #[test]
    fn spans_the_listing_in_place_without_copying_it() {
        // The buffer *is* what git handed over, NULs and all. What keeps the
        // separators out of every answer is that a span bounds each path.
        let index = collect(listing(&["src/App.tsx", "README.md"])).expect("an index");
        assert_eq!(index.buffer, "src/App.tsx\0README.md\0");
        assert_eq!(index.len(), 2);
        assert_eq!(index.path(0), "README.md");
        assert_eq!(index.path(1), "src/App.tsx");
        assert_eq!(index.name_at(1), "src/".len());
    }

    #[test]
    fn reads_a_listing_however_it_is_terminated() {
        // git terminates every entry, but a listing that stops without a
        // final NUL must not lose its last path, and an empty one is the
        // honest answer for a repository holding no files at all.
        assert_eq!(collect(String::new()).expect("an index").len(), 0);
        assert_eq!(collect("\0\0".to_string()).expect("an index").len(), 0);

        let unterminated = collect("a.rs\0b.rs".to_string()).expect("an index");
        assert_eq!(unterminated.len(), 2);
        assert_eq!(unterminated.path(1), "b.rs");
    }

    #[test]
    fn keeps_one_row_for_a_path_listed_twice() {
        // An unmerged file has an index entry per stage, so `--cached` names
        // it once per side of the conflict.
        let index = collect(listing(&["b.rs", "a.rs", "b.rs", "b.rs"])).expect("an index");
        let paths: Vec<_> = (0..index.len()).map(|i| index.path(i)).collect();
        assert_eq!(paths, ["a.rs", "b.rs"]);
    }

    /// The paths a query finds, best first.
    fn found(index: &Index, query: &str) -> Vec<String> {
        search(index, query, 20)
            .1
            .into_iter()
            .map(|hit| hit.path)
            .collect()
    }

    /// The characters a query lit up in the one path it found.
    fn marked(index: &Index, query: &str) -> String {
        let (_, hits) = search(index, query, 1);
        let hit = hits.first().expect("a hit");
        hit.at
            .iter()
            .map(|&at| {
                hit.path[at as usize..]
                    .chars()
                    .next()
                    .expect("a character at a match")
            })
            .collect()
    }

    #[test]
    fn sorts_and_deduplicates_the_listing() {
        let index = index(&["z.txt", "a.txt", "m/b.txt", "a.txt"]);
        let paths: Vec<_> = (0..index.len()).map(|i| index.path(i)).collect();
        assert_eq!(paths, ["a.txt", "m/b.txt", "z.txt"]);
    }

    #[test]
    fn knows_where_a_file_name_starts() {
        let index = index(&["deep/inside/here.rs", "top.rs"]);
        assert_eq!(&index.path(0)[index.name_at(0)..], "here.rs");
        assert_eq!(&index.path(1)[index.name_at(1)..], "top.rs");
    }

    #[test]
    fn the_prefilter_folds_case_and_keeps_order() {
        assert!(subsequence(b"src/App.tsx", b"apptsx"));
        assert!(subsequence(b"src/App.tsx", b"src"));
        // Out of order is not a match, however many of the letters are there.
        assert!(!subsequence(b"src/App.tsx", b"xsttppa"));
        assert!(!subsequence(b"src/App.tsx", b"zz"));
    }

    #[test]
    fn prefers_the_file_name_to_the_directories() {
        let index = index(&["app/p/t/s/x/other.rs", "src/App.tsx"]);
        assert_eq!(found(&index, "apptsx")[0], "src/App.tsx");
    }

    #[test]
    fn puts_an_exact_file_name_first() {
        let index = index(&["docs/git.rs.md", "src/lib/git.ts", "src-tauri/src/git.rs"]);
        assert_eq!(found(&index, "git.rs")[0], "src-tauri/src/git.rs");
    }

    #[test]
    fn reads_initials_as_word_starts() {
        // The camel humps of a file name beat the same letters found loose in
        // a path, which is what makes initials worth typing.
        let index = index(&["graph/tf/thing.txt", "src/GoToFile.tsx"]);
        assert_eq!(found(&index, "gtf")[0], "src/GoToFile.tsx");
    }

    #[test]
    fn a_slash_in_the_query_asks_about_the_directory() {
        let index = index(&["src-tauri/src/git.rs", "src/lib/git.ts"]);
        let hits = found(&index, "lib/git");
        assert_eq!(hits, ["src/lib/git.ts"]);
    }

    #[test]
    fn prefers_the_shorter_of_two_equal_matches() {
        let index = index(&["a/very/deep/place/notes.md", "notes.md"]);
        assert_eq!(found(&index, "notes.md")[0], "notes.md");
    }

    #[test]
    fn holds_a_very_short_query_to_the_start_of_a_word() {
        let index = index(&["src/App.tsx", "src/shape.rs"]);
        // `shape` holds an `a` and a `p`, but not where a reader would look.
        assert_eq!(found(&index, "ap"), ["src/App.tsx"]);
    }

    #[test]
    fn marks_the_characters_it_matched() {
        let index = index(&["src/GoToFile.tsx"]);
        assert_eq!(marked(&index, "gtf"), "GTF");
        // Tightened towards the end: the `tsx` of the extension, not the `t`
        // of `GoTo` and whatever follows.
        assert_eq!(marked(&index, "tsx"), "tsx");
    }

    #[test]
    fn marks_the_right_characters_on_a_path_that_is_not_ascii() {
        // Offsets are bytes, and a path may hold anything but NUL; a count of
        // characters would slide off the letter it meant by one per multi-byte
        // character earlier in the path.
        let index = index(&["src/café/Unicode.tsx"]);
        let (_, hits) = search(&index, "unicode", 1);
        let hit = hits.first().expect("a hit");
        for &at in &hit.at {
            assert!(
                hit.path.is_char_boundary(at as usize),
                "{at} is not a character boundary in {}",
                hit.path
            );
        }
        assert_eq!(marked(&index, "unicode"), "Unicode");
    }

    #[test]
    fn matches_a_character_outside_ascii_as_it_is_typed() {
        // Case is folded for ASCII only — full Unicode folding allocates per
        // character, and this is the loop that runs half a million times. A
        // letter outside ASCII still matches itself, so the file is findable.
        let index = index(&["src/café/Ünicode.tsx"]);
        assert_eq!(found(&index, "café"), ["src/café/Ünicode.tsx"]);
        assert_eq!(found(&index, "Ünic"), ["src/café/Ünicode.tsx"]);
        assert!(found(&index, "ünic").is_empty());
    }

    #[test]
    fn counts_every_match_but_returns_only_what_was_asked_for() {
        let paths = ["a/one.rs", "b/one.rs", "c/one.rs", "d/one.rs"];
        let (matched, hits) = search(&index(&paths), "one", 2);
        assert_eq!(matched, 4);
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn an_empty_query_matches_nothing() {
        let index = index(&["src/App.tsx"]);
        assert_eq!(search(&index, "", 20).0, 0);
        assert_eq!(search(&index, "   ", 20).0, 0);
    }

    #[test]
    fn takes_a_line_number_off_the_end_of_a_query() {
        assert_eq!(split_line("src/git.rs:246"), (Some(246), "src/git.rs"));
        // A path may hold a colon, and a Windows-ish drive letter is not a
        // line number either.
        assert_eq!(split_line("odd:name.txt"), (None, "odd:name.txt"));
        assert_eq!(split_line("src/git.rs:"), (None, "src/git.rs:"));
        assert_eq!(split_line(":246"), (None, ":246"));
    }

    #[test]
    fn splitting_the_scan_across_threads_changes_no_answer() {
        // Over `SPLIT_OVER` by enough that the search really does spread, with
        // names built to tie on score so the tiebreaks are exercised too.
        let names = ["Handler.kt", "handler.rs", "Handler.tsx", "handled.kt"];
        // Distinct paths, but zero-padded to one length and drawing on four
        // names, so thousands of them score exactly alike and only the
        // tiebreak on position in the index can separate them.
        let paths: Vec<String> = (0..80_000)
            .map(|i| format!("pkg/mod{i:05}/src/{}", names[i % names.len()]))
            .collect();
        let index = collect(listing(&paths)).expect("an index");
        assert!(index.len() > SPLIT_OVER * 2, "too small to split");

        for query in ["handler", "h", "pkg/mod12/handler", "handler.kt", "zz"] {
            let needle = Needle::new(query).expect("a needle");

            let (whole, mut one) = scan(&index, &needle, 0..index.len(), 50);
            one.sort_unstable_by(|a, b| b.cmp(a));
            one.truncate(50);

            let (parts, mut many) = sweep(&index, &needle, 50);
            many.sort_unstable_by(|a, b| b.cmp(a));
            many.truncate(50);

            assert_eq!(whole, parts, "{query}: counted a different number");
            assert_eq!(one, many, "{query}: ranked a different fifty");
        }
    }

    /// Not run by default: it is a measurement, not an assertion about
    /// behaviour, and it wants a release build to mean anything.
    ///
    /// `cargo test --release --lib -- --ignored --nocapture searches_a_big_repo`
    #[test]
    #[ignore]
    fn searches_a_big_repo_in_a_few_milliseconds() {
        let mut paths = Vec::with_capacity(500_000);
        for i in 0..500_000 {
            paths.push(format!(
                "packages/module{}/src/main/kotlin/com/example/service{}/Handler{}Impl.kt",
                i % 900,
                i % 70,
                i
            ));
        }
        let index = collect(listing(&paths)).expect("an index");
        assert_eq!(index.len(), 500_000);

        for query in [
            "handler",
            "hi",
            "h4711impl.kt",
            "service12/handler",
            "zzzzz",
        ] {
            let started = std::time::Instant::now();
            let (matched, hits) = search(&index, query, 50);
            println!(
                "{query:>18}: {:>8.2?}  {matched} matched, {} shown",
                started.elapsed(),
                hits.len()
            );
        }
    }

    #[test]
    fn lists_what_git_tracks_and_what_is_new_but_not_what_is_ignored() {
        let dir = scratch("files");
        let at = dir.to_string_lossy().to_string();
        init(&at);

        write(&dir, ".gitignore", "ignored/\n*.log\n");
        write(&dir, "src/kept.rs", "fn main() {}\n");
        must(&at, &["add", "."]);
        commit(&at, "first");

        // One written since the commit, and two git has been told to ignore.
        write(&dir, "src/fresh.rs", "fn fresh() {}\n");
        write(&dir, "ignored/junk.rs", "noise\n");
        write(&dir, "noisy.log", "noise\n");

        let index = build(&at).expect("an index");
        let paths: Vec<_> = (0..index.len()).map(|i| index.path(i)).collect();
        assert_eq!(paths, [".gitignore", "src/fresh.rs", "src/kept.rs"]);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_a_file_and_counts_its_lines() {
        let dir = scratch("read");
        let at = dir.to_string_lossy().to_string();
        write(&dir, "src/App.tsx", "one\ntwo\nthree\n");

        let file = read(&at, "src/App.tsx").expect("the file");
        assert_eq!(file.text, "one\ntwo\nthree\n");
        assert_eq!(file.lines, 3);
        assert!(!file.truncated && !file.binary);
        assert_eq!(file.bytes, 14);

        // A last line with no newline is still a line.
        write(&dir, "unfinished.txt", "a\nb");
        assert_eq!(read(&at, "unfinished.txt").expect("the file").lines, 2);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn says_when_a_file_is_binary_or_cut_short() {
        let dir = scratch("bounds");
        let at = dir.to_string_lossy().to_string();

        std::fs::write(dir.join("blob.bin"), [0x89, 0x50, 0x00, 0x4e]).unwrap();
        let binary = read(&at, "blob.bin").expect("the file");
        assert!(binary.binary);
        assert!(binary.text.is_empty());

        write(&dir, "huge.txt", &"a line of text\n".repeat(100_000));
        let huge = read(&at, "huge.txt").expect("the file");
        assert!(huge.truncated);
        assert!(huge.text.len() as u64 <= super::MAX_FILE_BYTES);
        // The size reported is the file's, not what was read of it.
        assert!(huge.bytes > super::MAX_FILE_BYTES);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    #[cfg(unix)] // Creating a symlink on Windows needs developer mode or admin.
    fn refuses_to_read_outside_the_repository() {
        let dir = scratch("escape");
        let at = dir.to_string_lossy().to_string();
        write(&dir, "inside.txt", "fine\n");
        std::fs::write(dir.join("..").join("outside.txt"), "not fine\n").unwrap();

        let err = resolve(&at, "../outside.txt").expect_err("refused");
        assert!(err.contains("outside the repository"), "{err}");
        // A link out of the worktree is the same move by another route.
        std::os::unix::fs::symlink("../outside.txt", dir.join("link.txt")).unwrap();
        let err = read(&at, "link.txt").expect_err("refused");
        assert!(err.contains("outside the repository"), "{err}");

        assert!(resolve(&at, "inside.txt").is_ok());

        let _ = std::fs::remove_file(dir.join("..").join("outside.txt"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
