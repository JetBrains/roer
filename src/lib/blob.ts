/**
 * What a view needs to draw a file that is not text: whether it is a picture,
 * how to put its bytes into an `<img>`, and where a picture a Markdown file
 * names really is.
 */

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Whether the webview can draw `path` as a picture, going by its name. */
export const isImage = (path: string): boolean => extension(path) in IMAGE_TYPES;

/** A picture's bytes, base64, as a URL an `<img>` takes. An SVG drawn this way runs no script. */
export const imageUrl = (path: string, base64: string): string =>
  `data:${IMAGE_TYPES[extension(path)] ?? "application/octet-stream"};base64,${base64}`;

/** Base64 bytes as text, UTF-8, with anything that is not replaced. */
export function decodeText(base64: string): string {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** How big `base64`'s bytes are, for a picture's caption. */
export function byteSize(base64: string): string {
  const bytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Whether `src` is somewhere else than the repository: a web address, or any other scheme. */
export const isRemote = (src: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//");

/**
 * The repository path a picture in the Markdown file at `from` names, as
 * GitHub reads it: relative to the file, or to the repository when it starts
 * with `/`. Null for a web address, or for one that climbs out of the
 * repository.
 */
export function resolvePath(from: string, src: string): string | null {
  if (!src || isRemote(src)) return null;
  const bare = src.replace(/[?#].*$/, "");
  let decoded: string;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    decoded = bare;
  }
  const start = decoded.startsWith("/") ? [] : from.split("/").slice(0, -1);
  const parts = [...start];
  for (const part of decoded.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length > 0 ? parts.join("/") : null;
}
