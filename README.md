# gabiro

A free, self-hosted, agent-first diagram tool. AI agents (Claude Code, Claude Desktop, Cursor, …) call gabiro's MCP tools to draw your system as **architecture, flowchart, sequence, ERD, mind map, freeform and kanban** boards. Boards are JSON files in your repo (`.gabiro/boards/`), and every change is auto-exported to Mermaid Markdown (`docs/diagrams/`) so it renders on GitHub and lives in git next to the code.

A local browser canvas shows every board live while the agent works on it.

## Install (from source)

```bash
git clone <this repo> gabiro && cd gabiro
npm install
npm run build
```

Register it with Claude Code **from inside the project you want to diagram**:

```bash
claude mcp add gabiro -- node /absolute/path/to/gabiro/dist/cli.js mcp
```

The server uses the directory it is started in as the project root. Pass `--root <dir>` to override.

## Use

Ask your agent things like:

- "Map this repo's architecture as a gabiro board."
- "Draw the sequence of our login flow, from the browser through the auth service to the DB."
- "Make an ERD of the Prisma schema."
- "Add a Redis cache between the API and Postgres, and a sticky note about invalidation."

To watch the diagram, ask "open it in gabiro" (the agent calls `gabiro_open_board`), or run the canvas yourself:

```bash
node /absolute/path/to/gabiro/dist/cli.js serve --open   # http://127.0.0.1:4477, next free port if taken
```

A canvas started by `gabiro_open_board` stops after 30 minutes with no canvas tab open; `gabiro serve` runs until you stop it (or pass `--idle-exit <minutes>`). The server only answers on 127.0.0.1/localhost.

The canvas updates live as the agent changes a board, and highlights what just changed. The same diagrams are in `docs/diagrams/<board>.md`, which renders on GitHub and in VS Code's Markdown preview.

## Edit in the canvas

You and the agent edit the same board, and both see each other's changes live.

- **Move**: drag a node. It stays where you drop it (it's pinned), even when the agent re-runs the layout. Drag kanban cards between columns, and sequence participants to reorder them.
- **Add**: pick a type from the toolbar. The palette only offers types the board kind allows.
- **Rename and details**: double-click a node, or select it, then edit the label, type, group, tech, description, tags and ERD fields in the side panel. Fields save when they lose focus or you press Enter.
- **Connect**: drag from a node's handle (shown on hover) onto another node.
- **Delete**: select, then press Delete or Backspace.
- **Undo / redo**: ⌘Z / ⇧⌘Z (Ctrl+Z / Ctrl+Shift+Z elsewhere). This undoes only your own edits.
- **Auto-layout**: tidy everything except the nodes you pinned. Auto-layout is not undoable.

If the agent changes the board while you're editing, your edit is re-applied on top of its change. If that isn't possible (for example, the agent deleted the node you were editing), you get a message explaining why.

## Tools

| Tool | What it does |
|---|---|
| `gabiro_list_boards` | List boards |
| `gabiro_create_board` | Create a board, optionally with all of its content in one call |
| `gabiro_get_board` | Read a board as `summary`, `json` or `mermaid` |
| `gabiro_apply_changes` | Atomic batch of add/update/remove ops for nodes, edges and groups |
| `gabiro_update_board` | Rename a board or change its direction |
| `gabiro_auto_layout` | Re-run layout (pinned nodes stay unless `force`) |
| `gabiro_export` | Mermaid or Markdown, optionally written to disk |
| `gabiro_open_board` | Show a board in the live canvas, starting it if needed |
| `gabiro_delete_board` | Delete a board and its export |

## Config

`.gabiro/config.json` (optional):

```json
{ "autoExport": true, "exportDir": "docs/diagrams" }
```

## Develop

```bash
npm run build     # server (tsc) + canvas (vite) into dist/
npm test          # unit, MCP and server tests; e2e/browser tests run after a build
npm run typecheck # server and web
npm run dev:web   # canvas with hot reload; proxies the API to a running `gabiro serve`
```

Browser tests use Chromium from `$GABIRO_CHROMIUM`, `/opt/pw-browsers/chromium`, or `npx playwright install chromium`; they are skipped when none is found. Set `GABIRO_NO_BROWSER=1` to stop gabiro from opening browser windows.
