import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { Terminal } from "@xterm/xterm";

/**
 * Measures characters with Unicode 11's widths instead of xterm's default
 * Unicode 6 ones, under which most emoji take one cell. tmux and the
 * program in the pane give them two, so the next character was drawn over
 * an emoji's second half. Call before anything is written, so nothing on
 * screen was measured the old way. Needs `allowProposedApi`.
 *
 * Emoji made of several code points (ZWJ families, flags, skin tones, a
 * symbol turned emoji by VS16) are still measured one code point at a time,
 * and can still disagree with what the program in the pane counts.
 */
export function measureWithUnicode11(terminal: Terminal): void {
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";
}
