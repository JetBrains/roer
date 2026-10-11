import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";

import { measureWithUnicode11 } from "./unicodeWidth";

/** The cells `text` takes on a fresh line: how far the cursor moves. */
async function cellsOf(terminal: Terminal, text: string): Promise<number> {
  await new Promise<void>((done) => terminal.write(`\r\n${text}`, done));
  return terminal.buffer.active.cursorX;
}

describe("measureWithUnicode11", () => {
  it("gives an emoji the two cells tmux gives it, so the next character lands after it", async () => {
    const before = new Terminal({ allowProposedApi: true });
    expect(await cellsOf(before, "🐬a")).toBe(2);

    const terminal = new Terminal({ allowProposedApi: true });
    measureWithUnicode11(terminal);
    expect(terminal.unicode.activeVersion).toBe("11");
    expect(await cellsOf(terminal, "🐬a")).toBe(3);
    expect(await cellsOf(terminal, "✅ ok")).toBe(5);
    expect(await cellsOf(terminal, "日本")).toBe(4);
    expect(await cellsOf(terminal, "plain")).toBe(5);
    terminal.dispose();
    before.dispose();
  });
});
