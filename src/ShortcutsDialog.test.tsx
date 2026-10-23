import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { invoke } from "./lib/backend";
import { setCustomChords } from "./lib/keys";
import { ShortcutsDialog } from "./ShortcutsDialog";

vi.mock("./lib/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/backend")>()),
  invoke: vi.fn(async () => undefined),
}));

const press = (init: KeyboardEventInit) => fireEvent.keyDown(window, init);
const keyOf = (name: string) => screen.getByText(name).closest("div")!.querySelector("kbd")!;

describe("ShortcutsDialog", () => {
  afterEach(() => {
    setCustomChords({});
    vi.mocked(invoke).mockClear();
  });

  it("moves a shortcut to the keys pressed next, keeps it, and puts it back", async () => {
    const onClose = vi.fn();
    render(<ShortcutsDialog tabs={["Workspace", "Terminal"]} onClose={onClose} />);
    expect(keyOf("New session")).toHaveTextContent("⌘T");
    expect(keyOf("Terminal")).toHaveTextContent("⌘2");

    fireEvent.click(screen.getByRole("button", { name: "Change the key for New session" }));
    expect(keyOf("New session")).toHaveTextContent("Press keys…");
    // A modifier alone is not the keys yet.
    press({ key: "Meta", code: "MetaLeft", metaKey: true });
    press({ key: "k", code: "KeyK", metaKey: true });

    expect(keyOf("New session")).toHaveTextContent("⌘K");
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("keybindings_set", {
        bindings: { newSession: { meta: true, ctrl: false, alt: false, shift: false, code: "KeyK" } },
      }),
    );
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Put New session back on its own key" }));
    expect(keyOf("New session")).toHaveTextContent("⌘T");
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("keybindings_set", { bindings: {} }));
  });

  it("says why keys are refused, waits for others, and Escape leaves it as it was", () => {
    const onClose = vi.fn();
    render(<ShortcutsDialog onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Change the key for New session" }));
    press({ key: "o", code: "KeyO", metaKey: true, shiftKey: true });
    expect(screen.getByText("⇧⌘O: Search sessions and files is on it already.")).toBeInTheDocument();
    expect(keyOf("New session")).toHaveTextContent("Press keys…");

    // Escape ends the recording, not the sheet.
    press({ key: "Escape", code: "Escape" });
    expect(keyOf("New session")).toHaveTextContent("⌘T");
    expect(onClose).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("puts every one back at once", async () => {
    setCustomChords({ newSession: { meta: true, ctrl: false, alt: false, shift: false, code: "KeyK" } });
    render(<ShortcutsDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Put every one back" }));
    expect(keyOf("New session")).toHaveTextContent("⌘T");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("keybindings_set", { bindings: {} }));
  });
});
