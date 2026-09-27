# Gabiro — Design Spec

**Date:** 2026-09-25
**Status:** Approved
**Plans:** `docs/superpowers/plans/2026-09-25-gabiro-plan-1-mcp-server.md` (core → MCP, done), `docs/superpowers/plans/2026-09-26-gabiro-plan-2-live-canvas.md` (read-only live canvas + `gabiro_open_board`, done), `docs/superpowers/plans/2026-09-27-gabiro-plan-3-canvas-editing.md` (manual editing). Plan 4: Mac Dock app.

## 1. Summary

Gabiro is a free, self-hosted, Miro-style diagram canvas built for AI agents. An agent (Claude Code, Claude Desktop, Cursor, …) calls MCP tools to create and edit diagrams of a software project — architecture, flows, sequences, data models, brainstorms, plans. The user watches the diagrams update live in a browser canvas, can edit them by hand, and every board is also exported to Mermaid/Markdown so it lives in git next to the code.

### Goals
- An agent can build a complete, good-looking diagram in one tool call, without choosing coordinates.
- The user sees agent changes live and can edit the same board by hand; neither side silently overwrites the other.
- Boards are plain files in the project repo (diffable, versioned, no database).
- Supports seven diagram kinds: architecture, flowchart, sequence, ERD, mind map, freeform, kanban.

### Non-goals (v1)
- Multi-user real-time collaboration, accounts, sharing.
- Cloud hosting / remote MCP transport (the architecture must allow adding it later; see §8).
- Pen/freehand drawing, images, comments, presentation mode, PNG/SVG export.
- Design-review intelligence ("principal engineer" prompts) — phase 2, separate spec.

## 2. Architecture

```
  Agent (Claude Code / Cursor / Claude Desktop)
        │  MCP over stdio
        ▼
  ┌─────────────────┐        ┌──────────────────────────┐
  │  gabiro mcp     │        │  gabiro serve (:4477)     │
  │  (MCP tools)    │        │  HTTP + WebSocket         │
  └───────┬─────────┘        └──────┬──────────▲─────────┘
          │ read/write              │ watch    │ edits from canvas
          ▼                         ▼          │
     ┌──────────────────────────────────────────────┐
     │  .gabiro/boards/<board>.json   (source of truth)
     │  docs/diagrams/<board>.md      (Mermaid export)
     └──────────────────────────────────────────────┘
                                    │ live push
                                    ▼
                          Browser canvas (React Flow)
```

**The board files are the single source of truth.** The MCP process and the canvas server never talk to each other directly; both read and write the same files.

- Agent calls a tool → MCP process updates the board file → the canvas server's file watcher notices → pushes the new board to connected browsers over WebSocket.
- User edits in the browser → canvas server applies the edit through `core` and writes the file → the agent sees it on its next read.

Consequences: any number of agent sessions (or none) can run while the canvas is open or closed; boards diff and merge like code; swapping `FileStore` for another `BoardStore` implementation later enables cloud hosting.

### 2.1 Distribution and commands
One npm package, `gabiro`:
- `npx gabiro mcp` — MCP server over stdio. Install: `claude mcp add gabiro -- npx gabiro mcp`.
- `npx gabiro serve [--port 4477] [--open]` — canvas server.
- Both operate on the project root = current working directory (overridable with `--root`). Data lives in `<root>/.gabiro/`.

### 2.2 Modules

| Module | Responsibility | Depends on |
|---|---|---|
| `core/` | Board schema (Zod), pure operations, validation, revision handling. No I/O. | — |
| `layout/` | ELK auto-layout per diagram kind | core |
| `export/` | Mermaid and Markdown exporters | core |
| `store/` | `BoardStore` interface + `FileStore` implementation (atomic writes, watch) | core |
| `service/` | `BoardService`: the one place combining ops, layout, store and auto-export | core, store, layout, export |
| `mcp/` | MCP tool definitions — thin wrappers over `service` | service, core |
| `server/` | Canvas HTTP + WebSocket server, file watcher, REST for canvas edits | service, core |
| `web/` | React + React Flow canvas, built by Vite into static assets served by `server/` | core (types, ops) |

Both the MCP tools and the canvas apply edits through the same `core` operations, so the same rules apply whoever edits.

### 2.3 Stack
TypeScript, Node ≥ 20.19, `@modelcontextprotocol/sdk`, Zod, elkjs, `@xyflow/react` (React Flow), React, Vite, Vitest, `playwright-core` (browser tests), Node's `fs.watch` (file watching, no extra dependency), ws.

## 3. Data model

### 3.1 Board
```jsonc
// .gabiro/boards/checkout-architecture.json
{
  "id": "checkout-architecture",      // slug, equals file name
  "title": "Checkout System – Architecture",
  "kind": "architecture",             // architecture | flowchart | sequence | erd | mindmap | freeform | kanban
  "revision": 12,                     // incremented on every successful write
  "createdAt": "2026-09-25T10:00:00Z",
  "updatedAt": "2026-09-25T11:30:00Z",
  "layout": { "direction": "LR" },    // LR | TB
  "groups": [ { "id": "backend", "label": "Backend (VPC)", "type": "zone", "parentId": null } ],
  "nodes": [
    { "id": "api", "type": "service", "label": "Checkout API", "tech": "Node/Fastify",
      "groupId": "backend", "description": "Stateless, horizontally scaled",
      "tags": ["critical-path"], "color": null,
      "position": { "x": 320, "y": 80 }, "pinned": false }
  ],
  "edges": [
    { "id": "api->orders-db", "from": "api", "to": "orders-db", "type": "sync", "label": "SQL writes" }
  ]
}
```

### 3.2 Entities
- **Node:** `id`, `type`, `label` (required); optional `description`, `tech`, `groupId`, `tags[]`, `color`, `position {x,y}`, `pinned` (default false), `order` (sequence participants, kanban cards), `fields[]` (ERD only: `{name, type, pk?, fk?, nullable?}`).
- **Edge:** `id` (default `"<from>-><to>"`, suffixed `#2`, `#3` on collision), `from`, `to`, `type`; optional `label`, `order` (sequence), `style` (`solid` | `dashed`, default by type), `cardinality` (ERD: `1-1` | `1-n` | `n-n`), `points` (route computed by the ELK layout; never set through ops; dropped when an end is pinned — the canvas falls back to its own routing when a route no longer touches both boxes).
- **Group:** `id`, `label`, `type`; optional `parentId` (nested zones).

IDs are human-readable slugs (`^[a-z0-9][a-z0-9-]*$`, max 64 chars) chosen by the caller.

### 3.3 Allowed types per kind
A `sticky` node is allowed on every kind.

| Kind | Node types | Edge types | Group types |
|---|---|---|---|
| architecture | client, gateway, service, function, database, cache, queue, storage, external | sync, async, data, dependency | zone, boundary |
| flowchart | start, end, step, decision, io, subprocess | flow | lane |
| sequence | participant | message (`style: dashed` = return/async), requires `order` | — |
| erd | entity (with `fields`) | relation (with `cardinality`) | — |
| mindmap | topic | branch | — |
| freeform | sticky, text, shape | link | frame |
| kanban | card (with `order`) | — | column (a card's `groupId` is its column) |

### 3.4 Validation rules
- Node, edge and group IDs are unique within their collection on a board.
- Edge `from`/`to` reference existing nodes; `groupId` and `parentId` reference existing groups; no group parent cycles.
- Node, edge and group types must be allowed for the board kind.
- ERD `fields` only on `entity`; `cardinality` only on `relation`; sequence `message` edges require `order`; kanban `card` nodes require a `groupId` (their column).
- Removing a node removes its edges. Removing a group requires it to be empty unless `cascade: true`, which un-groups its children.

Every error states the offending op/entity, the problem, and the fix (valid values, or a suggestion such as "Did you mean an architecture board?").

### 3.5 Positions and pinning
- Positions are optional on input. After every change, nodes without positions are placed by `layout/`.
- A node the user drags in the canvas becomes `pinned: true`; re-layout never moves pinned nodes unless `force: true`.
- `freeform` boards never auto-layout; new nodes without a position are placed on a simple grid to the right of existing content.

## 4. MCP tools

All tools are prefixed `gabiro_`, take Zod-validated input, and return a short text summary plus `structuredContent`.

| Tool | Input (main fields) | Output | Annotations |
|---|---|---|---|
| `gabiro_list_boards` | — | `[{id, title, kind, nodeCount, updatedAt}]` | readOnly |
| `gabiro_create_board` | `title`, `kind`, `id?` (default slug of title), `direction?`, `ops?` | board summary, `revision`, `canvasUrl` | — |
| `gabiro_get_board` | `boardId`, `format`: `summary` (default) \| `json` \| `mermaid` | board in requested format, `revision` | readOnly |
| `gabiro_apply_changes` | `boardId`, `ops[]`, `expectedRevision?` | change summary, new `revision`, `canvasUrl` | destructive |
| `gabiro_update_board` | `boardId`, `title?`, `direction?` | new `revision` | idempotent |
| `gabiro_auto_layout` | `boardId`, `force?` | new `revision` | idempotent |
| `gabiro_open_board` | `boardId?` | `canvasUrl` (starts server if needed, opens browser) | idempotent |
| `gabiro_export` | `boardId`, `format`: `mermaid` \| `markdown`, `write?` | exported text, written path | — |
| `gabiro_delete_board` | `boardId` | confirmation | destructive |

**Ops** (for `apply_changes` and `create_board.ops`): `add_node`, `update_node`, `remove_node`, `add_edge`, `update_edge`, `remove_edge`, `add_group`, `update_group`, `remove_group`. Update ops take `id` plus the fields to change (partial patch).

**Atomicity:** an ops list is applied to an in-memory copy in order; if any op fails validation, nothing is written and the error names the op index. Later ops may reference entities added by earlier ops in the same list.

**Summary format** (`get_board` default): one line per group, node and edge, e.g. `node api [service] "Checkout API" (Node/Fastify) in backend`. It's compact so agents keep context small; `json` is for when coordinates are needed.

**`gabiro_open_board`** (delivered with the canvas in Plan 2; `canvasUrl` fields likewise): checks for a running server via `.gabiro/server.json` (`{pid, port}`) and a health request; if none, spawns `gabiro serve` detached and waits for health. Browser opening uses the platform opener; on failure it just returns the URL.

## 5. Export

- Config `.gabiro/config.json`: `{ "autoExport": true, "exportDir": "docs/diagrams" }` (defaults if the file is missing).
- With `autoExport`, every successful write regenerates `<exportDir>/<boardId>.md`, containing the title, a Mermaid code block, and a Markdown list of stickies/descriptions.
- Mapping: architecture and flowchart → `flowchart` (groups → `subgraph`, dashed edges → `-.->`); sequence → `sequenceDiagram`; erd → `erDiagram`; mindmap → `mindmap`; kanban → `kanban`; freeform → Markdown list only.
- Labels are escaped for Mermaid; ids map `-` to `_` and Mermaid keywords (e.g. `end`) get a `_` suffix; output is deterministic (sorted by id) so git diffs are clean.

## 6. Canvas (web)

- **Home** (`/`): board list and "New board" (title + kind).
- **Board** (`/b/:boardId`): React Flow canvas with pan/zoom, minimap, fit-view, light/dark theme.
- **Rendering:** a custom React component per node type (service box, DB cylinder, queue, cache, cloud for external, diamond for decision, ERD table with field rows, sticky, kanban column/card, sequence lifeline with ordered message rows). Groups are drawn as labelled translucent zones/swimlanes. Edges: solid = sync, dashed = async/return, arrowheads, labels, crow's-foot for ERD cardinality.
- **Manual editing (Plan 3):** drag (sets `pinned`; kanban cards change column/slot, sequence participants reorder), double-click to rename (focuses the side panel), a toolbar palette to add nodes of allowed types (placed at the view centre, cascading to a free spot), drag from a handle onto another node to connect, Delete key to remove, side panel for label/type/group/tech/description/tags/ERD fields and edge label/type/line/cardinality/order, Auto-layout button (`POST /api/boards/:id/layout`), undo/redo for the user's own edits (computed by diffing boards; `update_node` accepts `pinned: null` to clear a pin).
- **Transport:** the browser sends `{type:"subscribe", boardId}` (or `{type:"subscribe-list"}`) over the `/ws` WebSocket and receives full board snapshots (boards are small; no diffing in v1), or `board-error` for missing/corrupt boards. Edits (Plan 3) are sent as ops via `POST /api/boards/:id/ops` with `expectedRevision`. Nodes whose content changed (layout moves excluded) flash briefly.
- **Conflict in the browser:** on a revision conflict the browser reloads the latest board and re-applies the user's pending op once; if it still fails, it shows the error.

## 7. Error handling

- All ops are validated in `core` before any write; errors are actionable (see §3.4).
- **Revision conflict:** `apply_changes` with a stale `expectedRevision` fails with `Board is at revision N, you sent M — call gabiro_get_board and retry.` Without `expectedRevision`, ops apply to the latest revision (they are id-based, so this is safe for additive edits).
- **Atomic writes:** write to `<file>.tmp` then rename. A per-board lock file (`<board>.json.lock`, stale after 5 s) serialises concurrent writers across processes.
- **Corrupt board file:** `get_board`/canvas show it read-only with the parse error; no tool overwrites it until it's fixed by hand or deleted.
- **Server absent:** MCP tools work without the canvas server (file-only). Port taken → `serve` tries the next free port and records it in `.gabiro/server.json`.

## 8. Extensibility (designed for, not built)

- **Cloud mode:** add a streamable-HTTP MCP transport and a `BoardStore` backed by a database; `core`, `layout` and `export` are unchanged.
- **Phase 2 — design-review prompts:** MCP prompts (`design_review`, `scalability_check`, `system_design`) that guide the agent to critique a board and add `sticky` findings. They only use existing tools.

## 9. Testing

- **core:** Vitest unit tests for every op, every validation rule, atomic multi-op failure, and revision conflicts.
- **export:** golden-file tests, one fixture board per kind → expected Mermaid.
- **layout:** deterministic output, pinned nodes don't move, no overlapping node bounding boxes.
- **store:** atomic write, lock contention across two writers, corrupt file handling.
- **mcp:** in-process MCP client tests calling each tool against a temp directory.
- **server + web:** Playwright smoke test: an op applied through the store appears in the browser; dragging a node in the browser updates the file with `pinned: true`.

## 10. Build order

1. `core` + `store` + `export` — usable headless (agent produces Mermaid).
2. `mcp` tools — installable in Claude Code.
3. `layout` (ELK).
4. `server` + `web` — rendering all seven kinds, live sync.
5. Manual editing in the canvas.
6. Phase 2 (separate spec): design-review prompts.
