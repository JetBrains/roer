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

2. Before you write code, settle where the data comes from:

   - Look for a tool the project already has for the service, such as a
     skill or a script, and prefer it to one you write.
   - Run it once, read-only, and keep a real sample of its output. When it
     can't run, stop and tell the user. Don't write a parser for output you
     have not seen.
   - Find its limits now: paging, sorting, filters, the size of one page.
     A tool that reads only the first page decides what the views can be.
   - Check each value you rely on against the sample: whether line numbers
     count from 0 or 1, the form of paths, the query syntax.

3. Ask the user which writes the tab may do, if any, and for each one
   whether they want a confirm step before it. Read-only is a valid answer,
   and so is "no confirm step". The guide's "Writing to another service"
   shows how to build each answer.
4. Plan one tab. Put a list and the item opened from it in that tab as two
   views, as the Changes tab does.
5. Write the folder. `roer ext new <id>` is a starting point. Edit its files
   with the Read, Edit and Write tools: a shell command on a folder outside
   the project can ask for approval each time.
6. Load it and read what comes back:

   ```sh
   roer ext dev <dir>
   ```

   The `extension_dev` tool does the same. Fix every build or activation
   error it reports and run it again. `roer ext logs <id>` has what the tab
   threw while rendering, and what the server threw.
7. Tell the user the tab is up and what you have not seen or tested, then
   iterate on what they say.
8. When they're happy, run `roer ext install <dir>` (or `extension_install`)
   so the extension survives a restart.

Changing an existing extension means editing its folder: `roer ext list`
shows where each one lives. Removing one is `roer ext remove <id>`.

For something the user wants to see once rather than keep, use the
Generative UI panel (`show_ui`) instead.
