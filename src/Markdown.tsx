import { type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { openUrl } from "./lib/github";

/** The class that carries Roer's Markdown styles; a caller's own class goes beside it. */
const BASE = "file-markdown";

/**
 * Markdown as GitHub writes it, raw HTML included. The HTML is cleaned with GitHub's own schema (no
 * scripts, no event handlers, no styles), because whoever can comment writes it. A link opens in the
 * browser rather than navigating the app's own window away.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  const classes = [BASE, ...(className ?? "").split(/\s+/).filter((c) => c && c !== BASE)].join(" ");
  return (
    <div className={classes}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, defaultSchema]]}
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
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
