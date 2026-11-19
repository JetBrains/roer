/**
 * A picture, a video or a sound from the web, in what someone else wrote: a thread, a comment, a pull request, a file
 * under review, an agent's view. Nothing is fetched until the person asks, since fetching it would tell whoever runs
 * that server the person is reading it, and when; until then it is a placeholder naming where it is from.
 *
 * Drawn at once: a picture carried in the text itself (`data:image/…`), which can call out to no one, one on
 * GitHub's own hosts, which only GitHub hears of, and, as the person chose (`lib/remoteMedia`), one from a host they
 * let through or from any host at all. One shown stays shown for as long as the window is open.
 */
import { useState, type ReactNode } from "react";

import { allowHost, remoteMediaPrefs, useRemoteMediaPrefs } from "./lib/remoteMedia";
import { openSettings, useCanOpenSettings } from "./lib/settingsNav";

/** GitHub's own picture hosts: a pull request's screenshots, avatars, its image proxy. */
const GITHUB_HOSTS = new Set([
  "avatars.githubusercontent.com",
  "user-images.githubusercontent.com",
  "private-user-images.githubusercontent.com",
  "camo.githubusercontent.com",
]);

/** The web addresses the person has asked to see in this window. */
const shown = new Set<string>();

/** Where a source points: inline, on the web (and which host), or neither (a path, which reaches nothing). */
export function whereFrom(src: string): { kind: "inline" } | { kind: "web"; host: string; direct: boolean } | { kind: "other" } {
  if (/^data:(image|video|audio)\//i.test(src)) return { kind: "inline" };
  if (!/^(https?:)?\/\//i.test(src)) return { kind: "other" };
  let url: URL;
  try {
    url = new URL(src, "https://invalid.example");
  } catch {
    return { kind: "other" };
  }
  const github = GITHUB_HOSTS.has(url.hostname) || (url.hostname === "github.com" && url.pathname.startsWith("/user-attachments/"));
  return { kind: "web", host: url.hostname, direct: github };
}

/** Whether `src` may be drawn as it is, without asking: inline, on GitHub, let through, or already asked for. */
export const drawsAtOnce = (src: string, prefs = remoteMediaPrefs()): boolean => {
  const at = whereFrom(src);
  if (at.kind === "inline") return true;
  if (at.kind !== "web") return false;
  return at.direct || shown.has(src) || prefs.always || prefs.hosts.includes(at.host);
};

const NOUN = { image: "Image", video: "Video", audio: "Sound" } as const;

export function RemoteMedia({
  src,
  kind = "image",
  alt,
  children,
}: {
  src: string;
  kind?: keyof typeof NOUN;
  /** What it shows, for the placeholder. */
  alt?: string;
  /** The element itself, drawn once it may be. */
  children: ReactNode;
}) {
  const prefs = useRemoteMediaPrefs();
  const [asked, setAsked] = useState(false);
  const canOpenSettings = useCanOpenSettings();
  const at = whereFrom(src);
  // A path or a scheme that is neither reaches nothing off the page: drawn as it is, or not at all, as before.
  if (asked || at.kind !== "web" || drawsAtOnce(src, prefs)) return <>{children}</>;
  return (
    <span className="remote-media" role="group" aria-label={`${NOUN[kind]} from ${at.host}, not loaded`}>
      <span className="remote-media-what" title={`${src}\nNothing is loaded from ${at.host} until you ask`}>
        {NOUN[kind]} from <strong>{at.host}</strong>
        {alt ? <span className="muted"> · {alt}</span> : null}
      </span>
      <button
        type="button"
        className="link remote-media-show"
        onClick={() => {
          shown.add(src);
          setAsked(true);
        }}
      >
        Show
      </button>
      <button type="button" className="link" title={`Load pictures from ${at.host} without asking, from now on`} onClick={() => allowHost(at.host)}>
        Always from {at.host}
      </button>
      {canOpenSettings ? (
        <button
          type="button"
          className="link muted"
          title="Choose whether pictures from the web load without asking"
          onClick={() => openSettings("privacy")}
        >
          Settings
        </button>
      ) : null}
    </span>
  );
}
