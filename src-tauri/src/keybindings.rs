//! The person's own keyboard shortcuts: which chord each of the app's
//! actions is on, where it is not the default. The frontend owns what the
//! actions are and their defaults; this keeps the overrides, as
//! `{"newSession": {"meta": true, "ctrl": false, "alt": false, "shift": false,
//! "code": "KeyT"}, …}`, and moves the native menu's Agents… item with its
//! action, since a menu's key reaches the menu before the page sees it.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::history::roer_home;

fn bindings_file() -> PathBuf {
    roer_home().join("keybindings.json")
}

fn load_in(path: &Path) -> Map<String, Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn save_in(path: &Path, bindings: &Map<String, Value>) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(bindings)?)?;
    std::fs::rename(&tmp, path)
}

pub fn load() -> Value {
    Value::Object(load_in(&bindings_file()))
}

pub fn save(bindings: Map<String, Value>) -> Result<(), String> {
    save_in(&bindings_file(), &bindings).map_err(|e| e.to_string())
}

/// A chord as a menu accelerator, `Cmd+Shift+,`; `None` for a key the menu
/// cannot spell, which then has no key in the menu at all.
pub(crate) fn accelerator(chord: &Value) -> Option<String> {
    let on = |name: &str| chord.get(name).and_then(Value::as_bool).unwrap_or(false);
    let code = chord.get("code")?.as_str()?;
    let key = if let Some(letter) = code.strip_prefix("Key") {
        letter.to_string()
    } else if let Some(digit) = code.strip_prefix("Digit") {
        digit.to_string()
    } else {
        match code {
            "Comma" => ",",
            "Period" => ".",
            "Slash" => "/",
            "Semicolon" => ";",
            "Quote" => "'",
            "BracketLeft" => "[",
            "BracketRight" => "]",
            "Backslash" => "\\",
            "Minus" => "-",
            "Equal" => "=",
            "Backquote" => "`",
            "ArrowLeft" => "Left",
            "ArrowRight" => "Right",
            "ArrowUp" => "Up",
            "ArrowDown" => "Down",
            "Tab" | "Enter" | "Space" | "Backspace" | "Delete" | "Home" | "End" | "PageUp" | "PageDown" => code,
            f if f.len() <= 3 && f.starts_with('F') && f[1..].chars().all(|c| c.is_ascii_digit()) => f,
            _ => return None,
        }
        .to_string()
    };
    let mut parts = Vec::new();
    for (name, word) in [("ctrl", "Ctrl"), ("alt", "Alt"), ("shift", "Shift"), ("meta", "Cmd")] {
        if on(name) {
            parts.push(word);
        }
    }
    parts.push(&key);
    Some(parts.join("+"))
}

/// The menu's Agents… item, kept so its key can follow the action's.
pub struct AgentsMenuItem(pub tauri::menu::MenuItem<tauri::Wry>);

/// Agents… is on `⌘,` unless the person moved the action elsewhere.
pub(crate) fn agents_accelerator(bindings: &Map<String, Value>) -> Option<String> {
    match bindings.get("agents") {
        Some(chord) => accelerator(chord),
        None => Some("CmdOrCtrl+,".to_string()),
    }
}

#[tauri::command]
pub fn keybindings_get() -> Value {
    load()
}

#[tauri::command]
pub fn keybindings_set(app: tauri::AppHandle, bindings: Map<String, Value>) -> Result<(), String> {
    use tauri::Manager;
    let accelerator = agents_accelerator(&bindings);
    save(bindings)?;
    if let Some(item) = app.try_state::<AgentsMenuItem>() {
        item.0.set_accelerator(accelerator.as_deref()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bindings_are_kept_and_a_missing_or_broken_file_is_none() {
        let dir = crate::testing::scratch("keybindings-are-kept");
        let file = dir.join("keybindings.json");
        assert!(load_in(&file).is_empty());

        let mut bindings = Map::new();
        bindings.insert("newSession".into(), json!({"meta": true, "ctrl": false, "alt": false, "shift": true, "code": "KeyY"}));
        save_in(&file, &bindings).unwrap();
        assert_eq!(load_in(&file), bindings);

        std::fs::write(&file, "not json").unwrap();
        assert!(load_in(&file).is_empty());
    }

    #[test]
    fn a_chord_is_spelled_as_the_menu_takes_it() {
        let chord = |meta, shift, code: &str| json!({"meta": meta, "ctrl": false, "alt": false, "shift": shift, "code": code});
        assert_eq!(accelerator(&chord(true, true, "Comma")).as_deref(), Some("Shift+Cmd+,"));
        assert_eq!(accelerator(&chord(true, false, "KeyK")).as_deref(), Some("Cmd+K"));
        assert_eq!(accelerator(&chord(true, false, "ArrowLeft")).as_deref(), Some("Cmd+Left"));
        assert_eq!(accelerator(&chord(true, false, "F5")).as_deref(), Some("Cmd+F5"));
        assert_eq!(accelerator(&chord(true, false, "IntlBackslash")), None);
    }

    #[test]
    fn agents_stays_on_its_key_until_moved() {
        assert_eq!(agents_accelerator(&Map::new()).as_deref(), Some("CmdOrCtrl+,"));
        let mut moved = Map::new();
        moved.insert("agents".into(), json!({"meta": true, "ctrl": false, "alt": true, "shift": false, "code": "KeyA"}));
        assert_eq!(agents_accelerator(&moved).as_deref(), Some("Alt+Cmd+A"));
    }
}
