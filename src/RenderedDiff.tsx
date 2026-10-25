import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Markdown } from "./Markdown";
import { Picture } from "./Picture";
import { byteSize, decodeText, imageUrl, isImage, resolvePath } from "./lib/blob";
import { definitions, diffBlocks } from "./lib/mdDiff";

/** A file's bytes, base64, on one side of a diff; null where it does not exist. */
export type LoadFile = (path: string, side: "old" | "new") => Promise<string | null>;

/** Both sides of one file, read together; `undefined` while reading. */
function useSides(load: LoadFile, path: string, oldPath: string) {
  const [sides, setSides] = useState<{ old: string | null; now: string | null } | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSides(undefined);
    setError(null);
    void Promise.all([load(oldPath, "old"), load(path, "new")])
      .then(([old, now]) => live && setSides({ old, now }))
      .catch((cause: unknown) => live && setError(String(cause)));
    return () => {
      live = false;
    };
  }, [load, path, oldPath]);
  return { sides, error };
}

/** A picture before and after, one above the other so each has the whole width: one of the two when it was
 * added or deleted. */
export function ImageDiff({ path, oldPath, load }: { path: string; oldPath: string; load: LoadFile }) {
  const { sides, error } = useSides(load, path, oldPath);
  if (error) return <p className="error">{error}</p>;
  if (!sides) return <p className="muted pad">Loading the picture…</p>;
  if (sides.old === null && sides.now === null) return <p className="muted pad">The picture is in neither version.</p>;
  const one = (label: string, at: string, base64: string | null, kind: "del" | "add") =>
    base64 === null ? null : (
      <figure className={`image-side ${kind}`}>
        <figcaption className="muted">
          {label} · {byteSize(base64)}
        </figcaption>
        <Picture src={imageUrl(at, base64)} alt={`${at}, ${label.toLowerCase()}`} />
      </figure>
    );
  return (
    <div className="image-diff" aria-label="Picture">
      {one(sides.now === null ? "Deleted" : "Before", oldPath, sides.old, "del")}
      {one(sides.old === null ? "Added" : "After", path, sides.now, "add")}
    </div>
  );
}

/**
 * A Markdown file's change drawn rendered: block by block, what was taken
 * out marked red and what came in green, pictures included, read from the
 * side of the diff the block is on.
 */
export function MarkdownDiff({ path, oldPath, load }: { path: string; oldPath: string; load: LoadFile }) {
  const { sides, error } = useSides(load, path, oldPath);
  const blocks = useMemo(() => {
    if (!sides) return null;
    const before = sides.old === null ? "" : decodeText(sides.old);
    const after = sides.now === null ? "" : decodeText(sides.now);
    return { list: diffBlocks(before, after), oldDefs: definitions(before), newDefs: definitions(after) };
  }, [sides]);

  const picture = useCallback(
    (side: "old" | "new") => async (src: string) => {
      const at = resolvePath(side === "old" ? oldPath : path, src);
      if (!at || !isImage(at)) return null;
      const base64 = await load(at, side);
      return base64 === null ? null : imageUrl(at, base64);
    },
    [load, path, oldPath],
  );
  // One function per side, so a picture is not read again on every render.
  const oldPicture = useMemo(() => picture("old"), [picture]);
  const newPicture = useMemo(() => picture("new"), [picture]);

  // The first change in view once the file has been drawn: in a long file it is rarely near the top. Pictures
  // above it push it down as they arrive, so it is brought back after each, until the reader scrolls.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const at = box.current;
    if (!at) return;
    const show = () => at.querySelector(".md-block.del, .md-block.add")?.scrollIntoView?.({ block: "center" });
    show();
    const stop = () => at.removeEventListener("load", show, true);
    at.addEventListener("load", show, true);
    const scroller = at.closest(".diff") ?? at;
    for (const kind of ["wheel", "keydown", "pointerdown"]) scroller.addEventListener(kind, stop, { once: true });
    return () => {
      stop();
      for (const kind of ["wheel", "keydown", "pointerdown"]) scroller.removeEventListener(kind, stop);
    };
  }, [blocks]);

  if (error) return <p className="error">{error}</p>;
  if (!blocks) return <p className="muted pad">Rendering…</p>;
  const changed = blocks.list.filter((block) => block.kind !== "same").length;
  return (
    <div className="md-diff" aria-label="Rendered" ref={box}>
      {changed === 0 ? <p className="muted pad">Nothing changed that shows once rendered: whitespace, say.</p> : null}
      {blocks.list.map((block, i) => {
        const defs = block.kind === "del" ? blocks.oldDefs : blocks.newDefs;
        return (
          <div key={i} className={`md-block ${block.kind}`} data-kind={block.kind}>
            <Markdown image={block.kind === "del" ? oldPicture : newPicture}>
              {defs ? `${block.text}\n\n${defs}` : block.text}
            </Markdown>
          </div>
        );
      })}
    </div>
  );
}
