import "@testing-library/jest-dom/vitest";

// jsdom has no ResizeObserver; TerminalView uses one to refit the terminal.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Shortcuts follow the platform (see lib/keys). Tests are written against
// macOS unless they say otherwise; jsdom reports no platform of its own.
Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
