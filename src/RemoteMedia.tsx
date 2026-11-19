/**
 * A picture, a video or a sound from the web, in what someone else wrote: a thread, a comment, a pull request, a file
 * under review, an agent's view. Nothing is fetched until the person asks, since fetching it would tell whoever runs
 * that server the person is reading it, and when; until then it is a placeholder naming where it is from.
 *
 * Drawn at once: a picture carried in the text itself (`data:image/…`), which can call out to no one, and one on
 * GitHub's own hosts, which only GitHub hears of. One shown stays shown for as long as the window is open.
 */
import { useState, type ReactNode } from "react";

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

/** Whether `src` may be drawn as it is, without asking: inline, on GitHub, or already asked for. */
export const drawsAtOnce = (src: string): boolean => {
  const at = whereFrom(src);
  return at.kind === "inline" || (at.kind === "web" && (at.direct || shown.has(src)));
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
  const [asked, setAsked] = useState(() => drawsAtOnce(src));
  const at = whereFrom(src);
  // A path or a scheme that is neither reaches nothing off the page: drawn as it is, or not at all, as before.
  if (asked || at.kind !== "web") return <>{children}</>;
  return (
    <button
      type="button"
      className="remote-media"
      title={`${src}\nNothing is loaded from ${at.host} until you ask`}
      onClick={() => {
        shown.add(src);
        setAsked(true);
      }}
    >
      <span className="remote-media-what">
        {NOUN[kind]} from <strong>{at.host}</strong>
        {alt ? <span className="muted"> · {alt}</span> : null}
      </span>
      <span className="remote-media-show">Show</span>
    </button>
  );
}
