"use strict";

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---- Hero demo -------------------------------------------------------------
   Replays what an agent does through `roer mcp`'s show_ui, or by piping each
   message to `roer plugin-ui`. surfaceUpdates merge into one tree, dataModelUpdate seeds
   the checkboxes, and nothing is live until beginRendering arrives. */
(function demo() {
  const term = document.getElementById("term");
  const surface = document.getElementById("surface");
  const status = document.getElementById("status");
  const replay = document.getElementById("replay");
  const apply = document.getElementById("gate-apply");
  const cancel = document.getElementById("gate-cancel");
  const boxes = [...surface.querySelectorAll('input[type="checkbox"]')];
  const parts = Object.fromEntries(
    [...surface.querySelectorAll("[data-id]")].map((el) => [el.dataset.id, el]),
  );

  const msg = (kind, detail) =>
    `<span class="t-msg">  | roer plugin-ui  <b>${kind.padEnd(16)}</b><i>${detail}</i></span>`;

  // [delay before step in ms, terminal line (html) or null, effect]
  const script = [
    [300, { cls: "t-prompt", type: "Before you commit, let me pick which changes go in." }],
    [700, { cls: "t-agent", html: "I'll put an approval gate in Roer's panel." }],
    [600, { html: msg("surfaceUpdate", "Card  Text  Text  Divider") }, () => show("card", "heading", "sub", "divider")],
    [550, { html: msg("surfaceUpdate", "Checkbox  watch.rs") }, () => show("c1")],
    [380, { html: msg("surfaceUpdate", "Checkbox  tabs.ts") }, () => show("c2")],
    [380, { html: msg("surfaceUpdate", "Checkbox  README.md") }, () => show("c3")],
    [450, { html: msg("surfaceUpdate", "ButtonRow  Cancel · Apply selected") }, () => show("row")],
    [550, { html: msg("dataModelUpdate", "changes: watch, tabs, readme = true") }, () => boxes.forEach((b) => (b.checked = true))],
    [650, { html: msg("beginRendering", "approval-gate") }, goLive],
    [500, { cls: "t-agent", html: 'Waiting for your pick in the panel. <span class="caret"></span>' }],
  ];

  let timers = [];
  let done = false;

  function line({ cls = "", html = "", type = null }) {
    const li = document.createElement("li");
    li.className = cls;
    li.innerHTML = html;
    term.appendChild(li);
    if (type) typeInto(li, type);
    return li;
  }

  function typeInto(el, text) {
    if (reduceMotion) { el.textContent = text; return; }
    let i = 0;
    const tick = () => {
      el.textContent = text.slice(0, ++i);
      if (i < text.length) timers.push(setTimeout(tick, 18));
    };
    tick();
  }

  function show(...ids) { ids.forEach((id) => (parts[id].dataset.shown = "1")); }

  function setStatus(state, label) { status.dataset.state = state; status.textContent = label; }

  function goLive() {
    surface.dataset.live = "1";
    surface.inert = false;
    setStatus("live", "Live");
  }

  function reset() {
    timers.forEach(clearTimeout);
    timers = [];
    done = false;
    term.innerHTML = "";
    surface.dataset.live = "0";
    // Not just unclickable: inert also keeps keyboard focus off the drafts.
    surface.inert = true;
    Object.values(parts).forEach((el) => (el.dataset.shown = "0"));
    boxes.forEach((b) => (b.checked = false));
    apply.disabled = cancel.disabled = false;
    setStatus("draft", "Drafting");
  }

  function play() {
    reset();
    if (reduceMotion) {
      script.forEach(([, l, fx]) => { if (l) line(l); if (fx) fx(); });
      return;
    }
    // The prompt types for a while; later steps wait for it to finish.
    let at = 0;
    script.forEach(([delay, l, fx], i) => {
      at += delay + (i === 1 ? script[0][1].type.length * 18 : 0);
      timers.push(setTimeout(() => { if (l) line(l); if (fx) fx(); }, at));
    });
  }

  function finish(text, cls) {
    if (done) return;
    done = true;
    term.querySelector(".caret")?.remove();
    line({ cls, html: text });
    apply.disabled = cancel.disabled = true;
    setStatus("idle", "Done");
  }

  apply.addEventListener("click", () => {
    const picked = boxes.filter((b) => b.checked);
    const left = boxes.filter((b) => !b.checked).map((b) => b.dataset.name);
    if (!picked.length) return finish("✗ Nothing selected. Nothing committed.", "t-no");
    const tail = left.length ? `  (left out: ${left.join(", ")})` : "";
    finish(`✓ Ran cargo fmt, committed ${picked.length} of ${boxes.length} changes${tail}`, "t-ok");
  });
  cancel.addEventListener("click", () => finish("✗ Cancelled. Nothing committed.", "t-no"));
  replay.addEventListener("click", play);

  play();
})();

/* ---- Review screenshots: the feature list is the tab strip ------------------ */
(function reviewTabs() {
  const img = document.getElementById("shot");
  const tabs = [...document.querySelectorAll('.shots [role="tab"]')];
  tabs.forEach((tab) =>
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
      img.src = tab.dataset.src;
      img.alt = tab.dataset.alt;
    }),
  );
  // Warm the cache so switching is instant.
  window.addEventListener("load", () => tabs.forEach((t) => { new Image().src = t.dataset.src; }));
})();

/* ---- Install: OS tabs, preselected from the visitor's platform -------------- */
(function osTabs() {
  const tabs = [...document.querySelectorAll('.os-tabs [role="tab"]')];
  const select = (tab) =>
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
    });
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      const next = tabs[(i + step + tabs.length) % tabs.length];
      select(next);
      next.focus();
    });
  });
  const p = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent).toLowerCase();
  const id = p.includes("win") ? "os-win" : p.includes("linux") && !p.includes("android") ? "os-linux" : "os-mac";
  select(document.getElementById(id));
})();

/* ---- Copy buttons ------------------------------------------------------------ */
document.querySelectorAll(".cmd .copy").forEach((btn) =>
  btn.addEventListener("click", async () => {
    const code = btn.parentElement.querySelector("code");
    try {
      await navigator.clipboard.writeText(code.textContent);
      btn.textContent = "Copied";
    } catch {
      const range = document.createRange();
      range.selectNodeContents(code);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      btn.textContent = "Selected";
    }
    setTimeout(() => (btn.textContent = "Copy"), 1600);
  }),
);
