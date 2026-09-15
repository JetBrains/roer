import "@testing-library/jest-dom/vitest";

// jsdom has no ResizeObserver; TerminalView uses one to refit the terminal.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
