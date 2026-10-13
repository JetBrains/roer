import { beforeEach, describe, expect, it } from "vitest";

import { VISITS_BEFORE_OFFER, noteShown, offerTab, stopOfferingTab } from "./returns";

const hour = 60 * 60 * 1000;

describe("view returns", () => {
  beforeEach(() => localStorage.clear());

  it("offers a view as a tab once the person has come back to it enough", () => {
    for (let visit = 1; visit < VISITS_BEFORE_OFFER; visit++) noteShown("/a", "board", visit * hour);
    expect(offerTab("/a", "board")).toBe(false);
    noteShown("/a", "board", VISITS_BEFORE_OFFER * hour);
    expect(offerTab("/a", "board")).toBe(true);
    expect(offerTab("/b", "board")).toBe(false);
  });

  it("counts an agent redrawing a view while it works as one visit", () => {
    for (let minute = 0; minute < 10; minute++) noteShown("/a", "board", minute * 60 * 1000);
    expect(offerTab("/a", "board")).toBe(false);
  });

  it("stops offering once declined", () => {
    for (let visit = 1; visit <= VISITS_BEFORE_OFFER; visit++) noteShown("/a", "board", visit * hour);
    stopOfferingTab("/a", "board");
    noteShown("/a", "board", 10 * hour);
    expect(offerTab("/a", "board")).toBe(false);
  });
});
