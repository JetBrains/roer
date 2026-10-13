<img src="src-tauri/icons/128x128@2x.png" width="64" height="64" alt="Roer icon">

# roer

Roer is a workspace for terminal coding agents.

- Run any agent CLI.
- Review its changes, from diff to merged PR.
- Let it draw the UI you need, beside the session.

**[Download the latest release](https://github.com/JetBrains/roer/releases/latest)** for macOS, Linux or Windows. Installing, the MCP server and the skills: [docs/install.md](docs/install.md).

**Extensions.** Ask your agent for a tab ("make me a tab that…"), or click **+** in the strip, and it writes one from Roer's own UI components. Roer reloads it on every save. Here, a tab with GitHub issues and todos.

![A Roer extension tab with GitHub issues and todos](docs/screenshots/Extension.png)

**Generative UI.** The agent draws what you need beside the session: a dashboard, a plan to approve, a diagram. A view you keep coming back to can become a tab.

![A dashboard the agent drew in the Generative UI panel](docs/screenshots/gen-ui-dashboard.png)

**Changes and pull requests.** Step through a branch's commits against its base and each commit's files. Commit from there, with Claude drafting the message. Open the PR, request a Copilot review, decide on each review thread right on the diff and send the decisions to the session, then merge. Arrow keys and ⌘+arrows step through commits and files.

![Branch diff view](docs/screenshots/diff.png)

**Go to File** (`⌘⇧O`). Fuzzy-matched jump to any changed file, straight from the diff view.

![Go to File](docs/screenshots/Go%20To%20File.png)

**Sessions that move.** A running `claude` hands off from your terminal to the app without restarting. Sessions live in tmux on a private socket, so they outlive the app. Start Claude Code, Codex, Pi or Junie, in a worktree of its own if you like, or [save an agent](docs/saved-agents.md) with a model, effort and instructions.

![Claude session in Roer](docs/screenshots/claude.png)

**Markdown preview.** Read any changed Markdown file rendered.

![Markdown preview](docs/screenshots/markdown.png)

More: [extensions](docs/extensions.md) · [running Roer on a server](docs/self-hosting.md).
