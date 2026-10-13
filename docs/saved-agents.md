# Saved agents

`roer new` starts the default agent in the new session's shell; `roer new --agent <id>` starts another, and `--model`/`--effort` override it once. Every installed CLI is an agent as it comes (`claude`, `codex`, `pi`, `junie`). A saved agent is a Markdown file with YAML frontmatter, the format Claude Code, opencode and Copilot use for their own agents:

```markdown
---
name: Reviewer
description: Careful reviewer for PR feedback
cli: codex              # claude | codex | pi | junie | custom
model: gpt-5.5
effort: high            # translated to each CLI's own flag
permissions: ask        # ask | auto | full
args: ["--search"]
---
Review the diff. Report bugs first, style last.
```

`~/.roer/agents/<id>.md` is yours alone; `<project>/.roer/agents/<id>.md` is committed and shared. The body is added to the agent's instructions where the CLI takes extra ones: Claude Code and pi read it from a file, Junie gets it as `--system-prompt` and Codex as `developer_instructions`, both read in by the shell (`$(cat …)`) so the text itself is never typed. Keys roer does not know are kept when the app saves the file.

- `roer agents` lists them, `*` marking the default; `roer agents default <id>` changes it (`ROER_AGENT` overrides it for one shell).
- `roer agents command <id>` prints exactly what the agent types into its session.
- `roer resume <id> --agent codex` resumes a Codex conversation; the Resume list shows Codex conversations beside Claude Code's.
