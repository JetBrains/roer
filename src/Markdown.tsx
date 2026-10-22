import { type ReactNode } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

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

/**
 * Markdown as GitHub writes it, raw HTML included. The HTML is cleaned with GitHub's own schema (no
 * scripts, no event handlers, no styles), because whoever can comment writes it. A link opens in the
 * browser rather than navigating the app's own window away. `marks` marks words in it, as a search
 * shows what it found. Without `images`, an image is its description, and nothing is fetched to show it.
 */
export function Markdown({
  children,
  className,
  marks,
  images = true,
}: {
  children: string;
  className?: string;
  /** Words to mark wherever the text holds them: what a search found. */
  marks?: readonly string[];
  images?: boolean;
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
          ...(images ? {} : { img: ({ alt }: { alt?: string }) => <span className="muted">[image{alt ? `: ${alt}` : ""}]</span> }),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
