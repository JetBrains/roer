#!/usr/bin/env node
// Builds the landing page into _site/ for GitHub Pages.
//
//   node site/build.mjs            # release data from the GitHub API
//   node site/build.mjs --offline  # no network: links point at the releases page
//
// The download buttons follow the newest *published* release. Every release is
// a prerelease, so GitHub's /releases/latest (which skips prereleases) would
// 404; the version has to be looked up here instead. The changelog is the
// commit subjects between release tags, since release notes carry install
// steps rather than changes. Needs full git history and tags.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "JetBrains/roer";
const BLOG_URL = "blog/";
const CHANGELOG_RELEASES = 4;
const CHANGELOG_ITEMS = 7;
// Commits that say nothing to a user reading the changelog.
const NOISE = /^(Release \d|Bump version|Update README|Nightly:|Test |Address .*review|Fix Copilot review)/;

const SITE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SITE, "..");
const OUT = join(ROOT, "_site");
const offline = process.argv.includes("--offline");

const REPO_URL = `https://github.com/${REPO}`;
const RELEASES_URL = `${REPO_URL}/releases`;
const NIGHTLY_URL = `${REPO_URL}/actions/workflows/nightly-bundles.yml`;

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

const esc = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function token() {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("No GitHub token: set GH_TOKEN, log in with `gh auth login`, or pass --offline.");
  }
}

async function fetchReleases() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
    headers: { Authorization: `Bearer ${token()}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  return res.json();
}

// Links for one OS: a file from the release when it has one, else the fallback.
function pick(release, pattern) {
  return release?.assets?.find((a) => pattern.test(a.name));
}

function downloads(release) {
  const page = release?.html_url ?? RELEASES_URL;
  const dmg = pick(release, /_universal\.dmg$/);
  const cli = pick(release, /^roer-cli-[\d.]+\.tar\.gz$/);
  const linux = pick(release, /\.(deb|rpm|AppImage)$/) || pick(release, /linux.*\.tar\.gz$/);
  const win = pick(release, /_x64-setup\.exe$/);
  const v = release ? release.tag_name.replace(/^v/, "") : null;
  return {
    "dl.mac.app": dmg?.browser_download_url ?? page,
    "dl.mac.appName": dmg?.name ?? "Roer .dmg",
    "dl.mac.cli": cli?.browser_download_url ?? page,
    "dl.mac.cliName": cli?.name ?? "roer CLI .tar.gz",
    "dl.linux.href": linux ? page : NIGHTLY_URL,
    "dl.linux.label": linux ? `Get Roer ${v} for Linux` : "Get the latest Nightly build",
    "dl.win.href": win ? page : NIGHTLY_URL,
    "dl.win.label": win ? `Get Roer ${v} for Windows` : "Get the latest Nightly build",
  };
}

function changelog(published) {
  const tags = git("tag", "--list", "v*", "--sort=-v:refname").split("\n").filter(Boolean);
  const latestPublished = published[0]?.tag_name;
  const isPublished = new Set(published.map((r) => r.tag_name));
  return tags
    .slice(0, CHANGELOG_RELEASES)
    .map((tag, i) => {
      const prev = tags[i + 1];
      const range = prev ? `${prev}..${tag}` : tag;
      const subjects = git("log", "--no-merges", "--format=%s", range)
        .split("\n")
        .filter((s) => s && !NOISE.test(s));
      const shown = subjects.slice(0, CHANGELOG_ITEMS);
      const rest = subjects.length - shown.length;
      const pill =
        tag === latestPublished ? '<span class="pill pill-preview">Latest</span>'
        : offline || isPublished.has(tag) ? ""
        : '<span class="pill">Unreleased</span>';
      const date = git("log", "-1", "--format=%cI", tag);
      const compare = prev ? `${REPO_URL}/compare/${prev}...${tag}` : `${REPO_URL}/commits/${tag}`;
      return `        <article class="release">
          <header><h3>${esc(tag)}</h3><time datetime="${date}">${fmtDate(date)}</time>${pill}</header>
          <ul>
${shown.map((s) => `            <li>${esc(s)}</li>`).join("\n")}
          </ul>
          ${rest > 0 ? `<a class="rest" href="${compare}">and ${rest} more ${rest === 1 ? "change" : "changes"}</a>` : ""}
        </article>`;
    })
    .join("\n");
}

async function main() {
  let published = [];
  if (!offline) {
    published = (await fetchReleases()).filter((r) => !r.draft && r.published_at);
    if (!published.length) throw new Error("No published release found.");
  }
  const latest = published[0];
  const latestTag = latest?.tag_name ?? git("tag", "--list", "v*", "--sort=-v:refname").split("\n")[0];
  const latestDate = latest?.published_at ?? git("log", "-1", "--format=%cI", latestTag);

  const values = {
    blogUrl: BLOG_URL,
    "release.version": latestTag.replace(/^v/, ""),
    "release.url": latest?.html_url ?? RELEASES_URL,
    "release.date": fmtDate(latestDate),
    ...downloads(latest),
    changelog: changelog(published),
  };

  const html = readFileSync(join(SITE, "index.html"), "utf8").replace(/\{\{([\w.]+)\}\}/g, (m, key) => {
    if (!(key in values)) throw new Error(`index.html: no value for ${m}`);
    // The changelog is already HTML; everything else is a plain value.
    return key === "changelog" ? values[key] : esc(values[key]);
  });

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "assets"), { recursive: true });
  mkdirSync(join(OUT, "screenshots"), { recursive: true });
  writeFileSync(join(OUT, "index.html"), html);
  for (const f of ["styles.css", "main.js"]) cpSync(join(SITE, f), join(OUT, f));
  cpSync(join(ROOT, "src-tauri/icons/128x128@2x.png"), join(OUT, "assets/roer.png"));
  cpSync(join(ROOT, "src-tauri/icons/64x64.png"), join(OUT, "assets/favicon.png"));
  const shots = { "diff.png": "diff.png", "Go To File.png": "go-to-file.png", "markdown.png": "markdown.png" };
  for (const [from, to] of Object.entries(shots)) {
    cpSync(join(ROOT, "docs/screenshots", from), join(OUT, "screenshots", to));
  }
  writeFileSync(join(OUT, ".nojekyll"), "");

  console.log(`Built _site/ for Roer ${values["release.version"]}${offline ? " (offline)" : ""}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
