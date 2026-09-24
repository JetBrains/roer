//! What a session is called, which must never change between versions: a
//! directory's session is found again by recomputing its name, so a name that
//! came out differently after an upgrade would strand every running session
//! behind a new, empty one.

use std::path::Path;

/// POSIX `cksum`'s CRC: the one the shell shim piped every path through, so
/// it is kept bit for bit rather than swapped for a better hash.
///
/// CRC-32 with polynomial 0x04C11DB7, most significant bit first, no initial
/// value, the message length appended low byte first, and the result
/// complemented.
pub fn cksum(data: &[u8]) -> u32 {
    fn feed(crc: u32, byte: u8) -> u32 {
        let mut crc = crc ^ (u32::from(byte) << 24);
        for _ in 0..8 {
            crc = if crc & 0x8000_0000 != 0 { (crc << 1) ^ 0x04C1_1DB7 } else { crc << 1 };
        }
        crc
    }

    let mut crc = data.iter().fold(0, |crc, &byte| feed(crc, byte));
    let mut len = data.len();
    while len > 0 {
        crc = feed(crc, (len & 0xff) as u8);
        len >>= 8;
    }
    !crc
}

/// Distinguishes two directories that share a basename. 16 bits is ample for
/// the handful of same-named directories one person has open at once.
pub fn path_hash(path: &str) -> String {
    format!("{:04x}", cksum(path.as_bytes()) & 0xffff)
}

/// A session belongs to a directory, not to a directory *name*: without the
/// hash, /work/api and /tmp/api share one session and `roer` in the second
/// silently hands you a shell sitting in the first. The basename stays in
/// front so the name is still something you can recognise and type.
///
/// tmux forbids "." and ":" in session names; everything unusual folds to
/// "-", one per character as macOS's `tr` did.
pub fn session_name(dir: &str) -> String {
    let base = Path::new(dir)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let safe: String = base
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' })
        .collect();
    let safe = if safe.is_empty() { "root".to_string() } else { safe };
    format!("{safe}-{}", path_hash(dir))
}

/// A Claude conversation id, which is interpolated into a shell command and a
/// record, so it is held to the shape of one.
pub fn is_agent_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// A pane id exactly as tmux prints one: `%` and digits.
pub fn is_pane_id(pane: &str) -> bool {
    pane.strip_prefix('%')
        .is_some_and(|digits| !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()))
}

/// A bundle name is a single path segment on disk. Matches the app's own
/// validator exactly, so a bundle saved from one side can be read from the
/// other.
pub fn is_bundle_name(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cksum_matches_posix() {
        // Values from `printf '%s' ... | cksum` on macOS and GNU coreutils.
        assert_eq!(cksum(b""), 4294967295);
        assert_eq!(cksum(b"a"), 1220704766);
        assert_eq!(cksum(b"/Users/test/project"), cksum_of_system("/Users/test/project"));
    }

    /// The system's own answer, where there is one to ask.
    fn cksum_of_system(text: &str) -> u32 {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let Ok(mut child) = Command::new("cksum").stdin(Stdio::piped()).stdout(Stdio::piped()).spawn()
        else {
            return cksum(text.as_bytes());
        };
        child.stdin.take().unwrap().write_all(text.as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        String::from_utf8_lossy(&out.stdout).split_whitespace().next().unwrap().parse().unwrap()
    }

    #[test]
    fn cksum_agrees_with_the_system_across_lengths() {
        // Lengths past 255 exercise the multi-byte length suffix.
        for len in [1, 7, 255, 256, 300, 70_000] {
            let text: String = (0..len).map(|i| char::from(b'a' + (i % 26) as u8)).collect();
            assert_eq!(cksum(text.as_bytes()), cksum_of_system(&text), "length {len}");
        }
    }

    #[test]
    fn names_a_session_after_its_directory_and_path() {
        let name = session_name("/work/api");
        assert!(name.starts_with("api-"));
        assert_eq!(name.len(), "api-".len() + 4);
        assert_ne!(name, session_name("/tmp/api"));
    }

    #[test]
    fn folds_what_tmux_forbids() {
        assert!(session_name("/work/my.app:v2").starts_with("my-app-v2-"));
        assert!(session_name("/").starts_with("root-"));
        // One dash per character, not per byte.
        assert!(session_name("/work/café").starts_with("caf--"));
        assert!(!session_name("/work/café").starts_with("caf---"));
    }

    #[test]
    fn validates_ids() {
        assert!(is_agent_id("0f3c-4a"));
        assert!(!is_agent_id("x; rm -rf /"));
        assert!(!is_agent_id(""));
        assert!(is_pane_id("%12"));
        assert!(!is_pane_id("%"));
        assert!(!is_pane_id("12"));
        assert!(is_bundle_name("issues_v2-1"));
        assert!(!is_bundle_name("../x"));
    }
}
