import { allThreads, defineExtension, fileRead, gitRoot, replyToThread, resolveDir, setThread, startThread, type Anchor } from "roer";

/** A trimmed string argument, or "" when it is not one. */
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** A positive whole number argument, or 0. */
const count = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0);

/** Threads, for agents: an answer in one the person started, and a thread of the agent's own. Each thread is with
 * one session, the one its words go to; the threads are drawn by the views they were left in. */
export default defineExtension((roer) => {
  const unanswer = roer.tools.register({
    name: "answer",
    description:
      "Answer in a Roer thread: a comment the user left on something on screen (lines of a file, parts of a view). " +
      "Call it with the thread id their prompt names and your answer in markdown: what you did about their " +
      "comment, or your answer to their question. It only adds your reply to the thread; the user reads it where " +
      "they left the comment and may reply again.",
    inputSchema: {
      type: "object",
      properties: {
        thread: { type: "string", description: "The thread's id, from the user's prompt." },
        text: { type: "string", description: "Your answer, markdown." },
        author: { type: "string", description: "Your name as the user knows you, e.g. Claude." },
      },
      required: ["thread", "text"],
    },
    async run(args, { pane }) {
      const id = text(args.thread);
      const words = text(args.text);
      if (!id || !words) throw new Error("`thread` and `text` are required");
      const thread = allThreads().find((one) => one.id === id);
      if (!thread || !replyToThread(id, text(args.author) || "Agent", words, false)) {
        throw new Error(`No thread "${id}" in Roer.`);
      }
      // A thread with no session yet is with whoever answers it.
      if (!thread.session && pane) setThread(id, { session: { pane } });
      return "Added your answer to the thread; the user reads it where they left the comment. Don't act on it further unless they reply.";
    },
  });

  const uncomment = roer.tools.register({
    name: "comment",
    description:
      "Leave a comment of your own for the user, on lines of a file (`path`, `line`, optional `end`) or on parts " +
      "of a Generative UI view you drew (`surface` and the ids of its components in `parts`): a question you need " +
      "answered, or something to look at, shown where it is about. It starts a thread that is yours: the user's " +
      "reply comes back to this session as a prompt naming the thread, and you answer it with threads__answer.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "A file, relative to the repository's root." },
        line: { type: "integer", minimum: 1, description: "Its first line, numbered as the file is on disk now." },
        end: { type: "integer", minimum: 1, description: "Its last line, for a range." },
        surface: { type: "string", description: "A view's surfaceId, for a comment on parts of it." },
        parts: { type: "array", items: { type: "string" }, description: "The ids of the view's components it is about." },
        text: { type: "string", description: "Your comment, markdown." },
        author: { type: "string", description: "Your name as the user knows you, e.g. Claude." },
      },
      required: ["text"],
    },
    async run(args, { cwd, pane }) {
      const words = text(args.text);
      if (!words) throw new Error("`text` is required");
      const dir = await resolveDir(cwd, pane);
      const root = await gitRoot(dir);
      if (!root) throw new Error(`${dir} is not in a git repository`);
      const author = text(args.author) || "Agent";
      const session = pane ? { session: { pane, cwd: dir } } : {};

      const surface = text(args.surface);
      if (surface) {
        const parts = Array.isArray(args.parts) ? args.parts.map(text).filter(Boolean) : [];
        if (parts.length === 0) throw new Error("`parts` names none of the view's components");
        const anchors: Anchor[] = parts.map((id) => ({ kind: "part", id }));
        const thread = startThread({ root, view: `ui:${surface}`, anchors, text: words, author, ...session });
        return `Left your comment on ${parts.join(", ")} of the view as thread "${thread.id}". Their reply comes to you as a prompt naming the thread.`;
      }

      const path = text(args.path).replace(/^\.\//, "");
      const line = count(args.line);
      if (!path || !line) throw new Error("Give `path` and `line` for a file, or `surface` and `parts` for a view");
      const file = await fileRead(root, path).catch(() => null);
      if (!file || file.binary) throw new Error(`No text file ${path} in ${root}`);
      // The newline that ends the last line starts no line of its own.
      const lines = file.text.replace(/\n$/, "").split("\n");
      const end = Math.max(line, count(args.end) || line);
      if (end > lines.length) throw new Error(`${path} has ${lines.length} lines`);
      const anchor: Anchor = { kind: "line", path, line, ...(end > line ? { end } : {}), code: lines.slice(line - 1, end).join("\n") };
      const thread = startThread({ root, anchors: [anchor], text: words, author, ...session });
      return `Left your comment on ${path}:${line}${end > line ? `-${end}` : ""} as thread "${thread.id}"; the user sees it when they open the file in Roer. Their reply comes to you as a prompt naming the thread.`;
    },
  });

  return () => {
    unanswer();
    uncomment();
  };
});
