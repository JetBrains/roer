---
name: roer-extension-authoring
description: Make a Roer extension, a tab of its own in the Roer app's stage written in React, and load and install it. Use when the user asks for a tab, panel or view in Roer that they will keep coming back to ("make me a tab that…"), or to change, fix or remove one they have.
---

# Make a Roer extension

A Roer extension is a folder holding an `extension.json` and an `app.tsx`.
Roer builds it with Bun, adds its tab to the strip beside Terminal and
Changes, and rebuilds and reloads it on every save.

## Do this

1. Read the whole guide and the API's types before writing anything. Get
   them from the `roer:extensions/1` resource of the `roer` MCP server,
   from its `describe_extension_api` tool, or by running:

   ```sh
   roer ext guide
   ```

   The API is what the guide declares. Don't guess at anything else.

2. Write the folder. `roer ext new <id>` is a starting point.
3. Load it and read what comes back:

   ```sh
   roer ext dev <dir>
   ```

   The `extension_dev` tool does the same. Fix every build or activation
   error it reports and run it again. `roer ext logs <id>` has what the tab
   threw while rendering.
4. Tell the user the tab is up, then iterate on what they say.
5. When they're happy, run `roer ext install <dir>` (or `extension_install`)
   so the extension survives a restart.

Changing an existing extension means editing its folder: `roer ext list`
shows where each one lives. Removing one is `roer ext remove <id>`.

For something the user wants to see once rather than keep, use the
Generative UI panel (`show_ui`) instead.
