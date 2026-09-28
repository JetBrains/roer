"use strict";

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
