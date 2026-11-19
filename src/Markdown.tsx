import { Children, isValidElement, useEffect, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Options } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { isRemote } from "./lib/blob";
import { MermaidBlock } from "./MermaidBlock";
import { RemoteMedia } from "./RemoteMedia";
import { Picture } from "./Picture";
import { openUrl } from "./lib/github";
import { termPattern } from "./lib/marks";

/** The class that carries Roer's Markdown styles; a caller's own class goes beside it. */
const BASE = "file-markdown";

/** As much of a rendered tree as marking words needs to know. */
interface Node {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
}

/** A rehype step that puts each occurrence of any of `terms`, in any case,
 * in a <mark>: in the text, never in a link's address or a tag. It runs
 * after sanitizing, which would otherwise take the marks out again. */
function rehypeMarks(terms: readonly string[]) {
  const pattern = termPattern(terms);
  const walk = (pattern: RegExp, node: Node) => {
    if (!node.children) return;
    node.children = node.children.flatMap((child): Node[] => {
      if (child.type !== "text" || !child.value) {
        walk(pattern, child);
        return [child];
      }
      const parts = child.value.split(pattern);
      if (parts.length === 1) return [child];
      return parts
        .map((part, index): Node =>
          index % 2 === 1
            ? { type: "element", tagName: "mark", properties: {}, children: [{ type: "text", value: part }] }
            : { type: "text", value: part },
        )
        .filter((part) => part.type === "element" || part.value);
    });
  };
  return (tree: Node) => {
    if (pattern) walk(pattern, tree);
  };
}

/** Where a picture's bytes come from: a URL for the `<img>`, or null when there is no such file. */
export type ImageSource = (src: string) => Promise<string | null>;

/** A picture the repository holds, read through `source`; its description until it has been. */
function SourcedImage({
  src,
  alt,
  width,
  height,
  source,
}: {
  src?: string;
  alt?: string;
  width?: number | string;
  height?: number | string;
  source: ImageSource;
}) {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setUrl(undefined);
    if (!src) return;
    source(src)
      .then((found) => live && setUrl(found))
      .catch(() => live && setUrl(null));
    return () => {
      live = false;
    };
  }, [src, source]);
  if (!src || url === null) return <span className="muted">[missing image{alt ? `: ${alt}` : ""}]</span>;
  if (url === undefined) return <span className="muted">[image{alt ? `: ${alt}` : ""}]</span>;
  return <Picture src={url} alt={alt ?? ""} width={width} height={height} />;
}

/** Links and sources as react-markdown keeps them (no `javascript:` and the like), and a picture's `data:image/…` too. */
const urlTransform: NonNullable<Options["urlTransform"]> = (url, key, node) =>
  key === "src" && node.tagName === "img" && /^data:image\//i.test(url) ? url : defaultUrlTransform(url);

/** GitHub's cleaning, with pictures carried in the text itself (`data:`) let through: they reach no one. Only an
 * `<img>` takes a `src`, and only a `data:image/…` one is drawn (`RemoteMedia`). */
const SCHEMA = { ...defaultSchema, protocols: { ...defaultSchema.protocols, src: [...(defaultSchema.protocols?.src ?? []), "data"] } };

/** The source of a fenced block's code when it is Mermaid's, else null. */
function mermaidSource(inner: ReactNode): string | null {
  if (!isValidElement<{ className?: string; children?: ReactNode }>(inner)) return null;
  if (!/(^|\s)language-mermaid(\s|$)/.test(inner.props.className ?? "")) return null;
  const text = Children.toArray(inner.props.children).join("");
  return text.replace(/\n$/, "");
}

/**
 * Markdown as GitHub writes it, raw HTML included. The HTML is cleaned with GitHub's own schema (no
 * scripts, no event handlers, no styles), because whoever can comment writes it. A link opens in the
 * browser rather than navigating the app's own window away. `marks` marks words in it, as a search
 * shows what it found. Without `images`, an image is its description, and nothing is fetched to show it.
 * With `image`, a picture the repository holds is read through it, and one on the web is a link to it, not
 * fetched: a file under review must not be able to call out to whoever wrote it.
 */
export function Markdown({
  children,
  className,
  marks,
  images = true,
  image,
}: {
  children: string;
  className?: string;
  /** Words to mark wherever the text holds them: what a search found. */
  marks?: readonly string[];
  images?: boolean;
  image?: ImageSource;
}) {
  const classes = [BASE, ...(className ?? "").split(/\s+/).filter((c) => c && c !== BASE)].join(" ");
  // Made once for the same `images` and `image`: a new object would be new component types to React, and every
  // render would mount the whole text again, redrawing its diagrams and reloading its pictures, which a thread
  // getting a reply would show as the text blinking and changing height.
  const components = useMemo(
    () => ({
          // A ```mermaid block is drawn as its diagram, as GitHub draws one.
          // Not where nothing is to be drawn but text: a conversation's, which shows no pictures either.
          pre: ({ children: inner }: { children?: ReactNode }) => {
            const source = images ? mermaidSource(inner) : null;
            return source === null ? <pre>{inner}</pre> : <MermaidBlock source={source} />;
          },
          a: ({ href, children: text }: { href?: string; children?: ReactNode }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (href) void openUrl(href);
              }}
            >
              {text}
            </a>
          ),
          // A picture from the web is a placeholder until asked for, whoever wrote the text: a file under review, a
          // thread, a comment. One carried in the text (`data:image/…`) shows; one the repository holds is read
          // through `image`.
          ...(images
            ? {
                img: ({ src, alt, width, height }: { src?: string; alt?: string; width?: number | string; height?: number | string }) => {
                  if (!src) return <span className="muted">[image{alt ? `: ${alt}` : ""}]</span>;
                  if (isRemote(src)) {
                    return (
                      <RemoteMedia src={src} alt={alt}>
                        <Picture src={src} alt={alt ?? ""} width={width} height={height} />
                      </RemoteMedia>
                    );
                  }
                  return image ? (
                    <SourcedImage src={src} alt={alt} width={width} height={height} source={image} />
                  ) : (
                    <span className="muted">[image{alt ? `: ${alt}` : ""}]</span>
                  );
                },
              }
            : { img: ({ alt }: { alt?: string }) => <span className="muted">[image{alt ? `: ${alt}` : ""}]</span> }),
    }),
    [images, image],
  );
  return (
    <div className={classes}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={
          [rehypeRaw, [rehypeSanitize, SCHEMA], ...(marks?.length ? [[rehypeMarks, marks]] : [])] as Options["rehypePlugins"]
        }
        components={components}
        urlTransform={urlTransform}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
