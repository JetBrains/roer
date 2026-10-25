import { useEffect, useState, type ReactNode } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { isRemote } from "./lib/blob";
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
  return (
    <div className={classes}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={
          [rehypeRaw, [rehypeSanitize, defaultSchema], ...(marks?.length ? [[rehypeMarks, marks]] : [])] as Options["rehypePlugins"]
        }
        components={{
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
          ...(images && image
            ? {
                img: ({ src, alt, width, height }: { src?: string; alt?: string; width?: number | string; height?: number | string }) =>
                  src && isRemote(src) ? (
                    <a
                      href={src}
                      title={src}
                      onClick={(e) => {
                        e.preventDefault();
                        void openUrl(src);
                      }}
                    >
                      [image{alt ? `: ${alt}` : ""}]
                    </a>
                  ) : (
                    <SourcedImage src={src} alt={alt} width={width} height={height} source={image} />
                  ),
              }
            : {}),
          ...(images ? {} : { img: ({ alt }: { alt?: string }) => <span className="muted">[image{alt ? `: ${alt}` : ""}]</span> }),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
