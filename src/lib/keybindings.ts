/**
 * The person's own keys, kept by the backend in `~/.roer/keybindings.json`
 * (see `src-tauri/src/keybindings.rs`), which also moves the macOS menu's
 * Agents… item with its action. `./keys` holds them while the app runs.
 */
import { invoke } from "./backend";
import { customChords, defaultChordOf, sameChord, setCustomChords, type ActionId, type Chord } from "./keys";

/** Takes up the keys kept from last time. Without any, the defaults stand. */
export async function loadKeybindings(): Promise<void> {
  try {
    setCustomChords(await invoke<Partial<Record<string, Chord>>>("keybindings_get"));
  } catch {
    /* the defaults, then */
  }
}

/** Puts `action` on `chord`, or back on its default with `null`, at once
 * and for next time. One on its default is not kept, so a later default
 * reaches it. */
export async function bindKey(action: ActionId, chord: Chord | null): Promise<void> {
  const next = { ...customChords() };
  if (chord && !sameChord(chord, defaultChordOf(action))) next[action] = chord;
  else delete next[action];
  setCustomChords(next);
  await invoke("keybindings_set", { bindings: next });
}

/** Every action back on its default. */
export async function resetKeybindings(): Promise<void> {
  setCustomChords({});
  await invoke("keybindings_set", { bindings: {} });
}
