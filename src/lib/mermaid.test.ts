import { describe, expect, it } from "vitest";

import { offline } from "./mermaid";

describe("a drawn diagram", () => {
  it("keeps nothing that reaches out: no @import, no url() but its own markers, no image or link off the drawing", () => {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
      "<style>@import url(https://evil.example/x.css); #a{fill:url(https://evil.example/p.png)}</style>",
      '<path marker-end="url(#arrow-end)" style="background: url(\'//evil.example/q\')"/>',
      '<image href="https://evil.example/r.png"/><img src="http://evil.example/s.gif"/><a xlink:href="#local">x</a>',
      "</svg>",
    ].join("");
    const out = offline(svg);
    expect(out).not.toMatch(/evil\.example/);
    // What the drawing needs of itself stays: its namespaces, its arrowheads, a link within it.
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(out).toContain("url(#arrow-end)");
    expect(out).toContain('xlink:href="#local"');
  });
});
