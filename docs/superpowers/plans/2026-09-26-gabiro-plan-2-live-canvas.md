# Gabiro Plan 2: Live Canvas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `gabiro serve`, a local browser canvas that draws all seven board kinds and updates live as agents change boards, plus a `gabiro_open_board` MCP tool that starts it and opens the browser.

**Architecture:** The board files stay the single source of truth. A Node HTTP + WebSocket server (`src/server/`) watches `.gabiro/boards/` and pushes full board snapshots to subscribed browsers. It serves a Vite-built React + React Flow app (`web/`) from `dist/web`. The canvas is read-only in this plan; manual editing is Plan 3. ELK edge routes are now stored on edges (`points`), so the canvas draws edges around boxes exactly as the layout engine routed them. The MCP process finds a running canvas through `.gabiro/server.json`, or spawns a detached `gabiro serve`. Spec: `docs/superpowers/specs/2026-09-25-gabiro-design.md` §2, §4 (`gabiro_open_board`), §6 (read-only parts), §7, §9.

**Tech Stack:** Existing (TypeScript 5.9 ESM/NodeNext, Zod 4, elkjs, MCP SDK, Vitest), plus `ws` 8, React 19, `@xyflow/react` 12, Vite 8 + `@vitejs/plugin-react`, and `playwright-core` for browser tests.

**Scope:** Spec build-order step 4. **Not in this plan (Plan 3):** manual editing (drag/pin, rename, palette, connect, delete, side panel, undo), `POST /api/boards/:id/ops`, and conflict re-apply in the browser.

**Verified:** Every code block here was compiled and run before the plan was written. The result: 17 test files and 121 tests pass, repeatedly; server and web typechecks are clean; `npm run build` produces `dist/web`; the browser test passes against real Chromium; and screenshots of all seven kinds, light and dark, were reviewed by eye. That review is why edges follow ELK routes: without them, a flowchart "no" branch ran straight through a box.

**Starting point:** `main` at the end of Plan 1: 13 test files, 89 tests passing.

---

## File structure

```
package.json                 + ws, react, react-dom, @xyflow/react, vite, @vitejs/plugin-react, playwright-core, types
vite.config.ts               builds web/ into dist/web; dev proxy to :4477
vitest.config.ts             keeps tests rooted at the repo (vite.config.ts roots at web/)
src/core/errors.ts           + "UNAVAILABLE" error code
src/core/schema.ts           + edge.points (layout-computed route)
src/core/ops.ts              add_edge can't set points
src/layout/layout.ts         ELK routes -> edge.points (absolute coords; dropped when an end is pinned)
src/server/
  protocol.ts                WebSocket message + health types (shared with web)
  info.ts                    .gabiro/server.json read/write, health check, pid liveness
  watch.ts                   fs.watch on the boards dir, debounced per board
  static.ts                  serves dist/web with index.html fallback for app routes
  canvas-server.ts           HTTP API + static + WebSocket push; port fallback; server.json
  launcher.ts                canvasUrl, ensureCanvasServer (spawn detached `gabiro serve`), openInBrowser
  index.ts                   barrel
src/mcp/tools.ts             + gabiro_open_board, canvasUrl in create/apply results, CanvasAccess injection
src/mcp/server.ts            createMcpServer(root, canvas?)
src/mcp/help.ts              instructions mention gabiro_open_board
src/cli.ts                   + `gabiro serve [--root] [--port] [--open]`
web/
  index.html, tsconfig.json
  src/toFlow.ts              pure: Board -> React Flow nodes/edges (groups, routes, sequence, kanban)
  src/live.ts                reconnecting WebSocket client
  src/hooks.ts               useLiveBoard / useLiveBoards
  src/nodes.tsx              node + edge components
  src/BoardView.tsx, BoardList.tsx, App.tsx, main.tsx, styles.css
test/server/*, test/web/toFlow.test.ts, test/e2e/{browser.ts,canvas.test.ts}; updated test/core/ops, test/layout, test/mcp/tools
```

Conventions: same as Plan 1. The web code imports shared code from `../../src/**` with `.js` suffixes, and Vite resolves them to `.ts`. Web code must only import browser-safe modules: `src/core/*`, `src/layout/sizes.ts`, `src/server/protocol.ts`, `src/store/store.ts` (types). Never import barrels that pull in Node APIs.

Commit trailer for every commit in this plan:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ
```

---

### Task 1: Dependencies, test config, UNAVAILABLE error code

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json (generated)`
- Create: `vitest.config.ts`
- Modify: `src/core/errors.ts`

- [ ] **Step 1: Install the new dependencies**

```bash
npm install ws@^8.21.3
npm install -D @types/ws@^8.18.1 react@^19.3.0 react-dom@^19.3.0 @types/react@^19.3.0 @types/react-dom@^19.3.0 @xyflow/react@^12.12.0 vite@^8.3.1 @vitejs/plugin-react@^6.1.1 playwright-core@^1.63.0
```

Then make `package.json` match exactly. The `engines` field rises to `>=20.19` because Vite 8 needs it; scripts are unchanged for now:

`package.json`:

```json
{
  "name": "gabiro",
  "version": "0.1.0",
  "description": "Agent-first diagram canvas: MCP tools for architecture, flow, sequence, ERD, mind map, freeform and kanban boards",
  "type": "module",
  "license": "MIT",
  "bin": {
    "gabiro": "dist/cli.js"
  },
  "files": [
    "dist"
  ],
  "engines": {
    "node": ">=20.19"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.1",
    "elkjs": "^0.12.0",
    "ws": "^8.21.3",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@types/node": "^22.20.4",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@types/ws": "^8.18.1",
    "@vitejs/plugin-react": "^6.1.1",
    "@xyflow/react": "^12.12.0",
    "playwright-core": "^1.63.0",
    "react": "^19.3.0",
    "react-dom": "^19.3.0",
    "typescript": "~5.9.3",
    "vite": "^8.3.1",
    "vitest": "^5.0.2"
  }
}
```

- [ ] **Step 2: Add the Vitest config**

The Vite config added in Task 7 roots at `web/`. This separate file keeps Vitest rooted at the repo.

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

// Separate from vite.config.ts (whose root is web/) so tests run from the repo root.
export default defineConfig({
  root: ".",
  test: { include: ["test/**/*.test.ts"] },
});
```

- [ ] **Step 3: Add the `UNAVAILABLE` error code (used when the canvas can't start)**

Replace line 1 of `src/core/errors.ts`:

```ts
export type GabiroErrorCode = "VALIDATION" | "NOT_FOUND" | "EXISTS" | "CONFLICT" | "CORRUPT" | "UNAVAILABLE";
```

- [ ] **Step 4: Verify nothing regressed**

Run: `npx tsc --noEmit && npm test`
Expected: typecheck clean; 13 files, 89 tests pass (unchanged from Plan 1).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/core/errors.ts
git commit -m "chore: canvas dependencies, vitest config, UNAVAILABLE error code" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

### Task 2: Store ELK edge routes on edges

**Files:**
- Modify: `src/core/schema.ts`
- Modify: `src/core/ops.ts`
- Modify: `src/layout/layout.ts`
- Modify (test): `test/layout/layout.test.ts`
- Modify (test): `test/core/ops.test.ts`

Why: React Flow draws its own edge paths, which cut straight through boxes. For example, a flowchart "no" branch crossed the step between its ends. The layout engine already computes clean routes, so this task keeps them.

- [ ] **Step 1: Write the failing tests**

Replace both test files with these complete versions. They add two tests to layout, covering routes and pinned/non-ELK kinds, and one to ops, checking that `points` is rejected.

`test/layout/layout.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyOps, KINDS, type Board, type BoardNode } from "../../src/core/index.js";
import { layoutBoard, nodeSize } from "../../src/layout/index.js";
import { FIXTURES } from "../fixtures/boards.js";

function overlaps(a: BoardNode, b: BoardNode): boolean {
  const sa = nodeSize(a);
  const sb = nodeSize(b);
  return (
    a.position!.x < b.position!.x + sb.width &&
    b.position!.x < a.position!.x + sa.width &&
    a.position!.y < b.position!.y + sb.height &&
    b.position!.y < a.position!.y + sa.height
  );
}

describe("layoutBoard", () => {
  for (const kind of KINDS) {
    it(`positions every ${kind} node without overlaps`, async () => {
      const laid = await layoutBoard(FIXTURES[kind]);
      for (const n of laid.nodes) expect(n.position, n.id).toBeDefined();
      for (const a of laid.nodes) {
        for (const b of laid.nodes) {
          if (a.id < b.id) expect(overlaps(a, b), `${a.id} overlaps ${b.id}`).toBe(false);
        }
      }
    });
  }

  it("is deterministic", async () => {
    const a = await layoutBoard(FIXTURES.architecture);
    const b = await layoutBoard(FIXTURES.architecture);
    expect(a).toEqual(b);
  });

  it("does not mutate its input", async () => {
    await layoutBoard(FIXTURES.flowchart);
    expect(FIXTURES.flowchart.nodes.every((n) => n.position === undefined)).toBe(true);
  });

  it("keeps nodes inside their group's area together (group children are laid out as a block)", async () => {
    const laid = await layoutBoard(FIXTURES.architecture);
    const pos = (id: string) => laid.nodes.find((n) => n.id === id)!.position!;
    // web is outside the backend zone; with LR direction it must be left of everything in the zone
    for (const inside of ["api", "events", "orders-db"]) expect(pos("web").x).toBeLessThan(pos(inside).x);
  });

  it("never moves pinned nodes unless forced", async () => {
    const pinned: Board = applyOps(FIXTURES.architecture, [
      { op: "update_node", id: "api", position: { x: 999, y: 999 }, pinned: true },
    ]);
    const all = await layoutBoard(pinned, "all");
    expect(all.nodes.find((n) => n.id === "api")!.position).toEqual({ x: 999, y: 999 });
    const forced = await layoutBoard(pinned, "force");
    const api = forced.nodes.find((n) => n.id === "api")!;
    expect(api.position).not.toEqual({ x: 999, y: 999 });
    expect(api.pinned).toBeUndefined();
  });

  it("auto mode leaves a fully positioned board alone", async () => {
    const laid = await layoutBoard(FIXTURES.architecture);
    const moved = applyOps(laid, [{ op: "update_node", id: "web", position: { x: 5, y: 5 } }]);
    expect(await layoutBoard(moved, "auto")).toEqual(moved);
  });

  it("auto mode re-places unpinned nodes when a new node arrives", async () => {
    const laid = await layoutBoard(FIXTURES.architecture);
    const grown = applyOps(laid, [{ op: "add_node", id: "cache", type: "cache", label: "Redis" }]);
    const relaid = await layoutBoard(grown, "auto");
    expect(relaid.nodes.find((n) => n.id === "cache")!.position).toBeDefined();
  });

  it("freeform only places new nodes, to the right of existing content", async () => {
    const board = applyOps(FIXTURES.freeform, [
      { op: "update_node", id: "idea-1", position: { x: 0, y: 0 } },
      { op: "update_node", id: "idea-2", position: { x: 300, y: 0 } },
      { op: "add_node", id: "idea-3", type: "sticky", label: "New" },
    ]);
    const laid = await layoutBoard(board);
    expect(laid.nodes.find((n) => n.id === "idea-1")!.position).toEqual({ x: 0, y: 0 });
    expect(laid.nodes.find((n) => n.id === "idea-2")!.position).toEqual({ x: 300, y: 0 });
    expect(laid.nodes.find((n) => n.id === "idea-3")!.position!.x).toBeGreaterThanOrEqual(460);
  });

  it("orders sequence participants and kanban cards by `order`", async () => {
    const seq = await layoutBoard(FIXTURES.sequence);
    const x = (id: string) => seq.nodes.find((n) => n.id === id)!.position!.x;
    expect(x("client")).toBeLessThan(x("api"));
    expect(x("api")).toBeLessThan(x("db"));

    const kb = await layoutBoard(FIXTURES.kanban);
    const p = (id: string) => kb.nodes.find((n) => n.id === id)!.position!;
    expect(p("core").x).toBe(p("mcp").x);
    expect(p("core").y).toBeLessThan(p("mcp").y);
    expect(p("spec").x).toBeGreaterThan(p("core").x);
  });

  it("records ELK edge routes from the source box to the target box, including inside nested groups", async () => {
    for (const fixture of [FIXTURES.flowchart, FIXTURES.architecture]) {
      const laid = await layoutBoard(fixture);
      const near = (p: { x: number; y: number }, id: string) => {
        const n = laid.nodes.find((x) => x.id === id)!;
        const { width, height } = nodeSize(n);
        return p.x >= n.position!.x - 1 && p.x <= n.position!.x + width + 1 && p.y >= n.position!.y - 1 && p.y <= n.position!.y + height + 1;
      };
      for (const e of laid.edges) {
        expect(e.points!.length, e.id).toBeGreaterThanOrEqual(2);
        expect(near(e.points![0]!, e.from), `${e.id} starts at ${e.from}`).toBe(true);
        expect(near(e.points!.at(-1)!, e.to), `${e.id} ends at ${e.to}`).toBe(true);
      }
    }
  });

  it("drops routes that touch pinned nodes, and never routes non-ELK kinds", async () => {
    const pinned = applyOps(await layoutBoard(FIXTURES.architecture), [
      { op: "update_node", id: "stripe", position: { x: 2000, y: 2000 }, pinned: true },
    ]);
    const relaid = await layoutBoard(pinned, "all");
    expect(relaid.edges.find((e) => e.id === "api->stripe")!.points).toBeUndefined();
    expect(relaid.edges.find((e) => e.id === "web->api")!.points).toBeDefined();
    const seq = await layoutBoard(FIXTURES.sequence);
    expect(seq.edges.every((e) => e.points === undefined)).toBe(true);
  });
});
```

`test/core/ops.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyOps, createBoard, GabiroError, type Board } from "../../src/core/index.js";

const empty = (kind: Board["kind"] = "architecture") => createBoard({ title: "T", kind, id: "t" });

describe("applyOps", () => {
  it("adds groups, nodes and edges; later ops can reference earlier ones", () => {
    const b = applyOps(empty(), [
      { op: "add_group", id: "backend", label: "Backend", type: "zone" },
      { op: "add_node", id: "api", type: "service", label: "API", groupId: "backend" },
      { op: "add_node", id: "db", type: "database", label: "DB" },
      { op: "add_edge", from: "api", to: "db", type: "sync" },
    ]);
    expect(b.groups.map((g) => g.id)).toEqual(["backend"]);
    expect(b.nodes.map((n) => n.id)).toEqual(["api", "db"]);
    expect(b.edges).toEqual([{ id: "api->db", from: "api", to: "db", type: "sync" }]);
  });

  it("suffixes default edge ids on collision", () => {
    const b = applyOps(empty(), [
      { op: "add_node", id: "a", type: "service", label: "A" },
      { op: "add_node", id: "b", type: "service", label: "B" },
      { op: "add_edge", from: "a", to: "b", type: "sync" },
      { op: "add_edge", from: "a", to: "b", type: "async" },
    ]);
    expect(b.edges.map((e) => e.id)).toEqual(["a->b", "a->b#2"]);
  });

  it("does not mutate the input board", () => {
    const before = empty();
    applyOps(before, [{ op: "add_node", id: "a", type: "service", label: "A" }]);
    expect(before.nodes).toEqual([]);
  });

  it("is all-or-nothing and names the failing op index", () => {
    const start = empty();
    let error: unknown;
    try {
      applyOps(start, [
        { op: "add_node", id: "a", type: "service", label: "A" },
        { op: "add_edge", from: "a", to: "ghost", type: "sync" },
      ]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GabiroError);
    expect((error as Error).message).toMatch(/^Op #1 \(add_edge\) failed: .*"ghost".*Nothing was changed\.$/);
    expect(start.nodes).toEqual([]);
  });

  it("reports malformed ops with the field path", () => {
    expect(() => applyOps(empty(), [{ op: "add_node", id: "a", type: "service" }])).toThrow(
      /Op #0 is malformed at "label"/,
    );
    expect(() => applyOps(empty(), [{ op: "explode" }])).toThrow(/Op #0 is malformed/);
  });

  it("rejects unknown op fields instead of silently dropping them", () => {
    const withEdge = applyOps(empty(), [
      { op: "add_node", id: "a", type: "service", label: "A" },
      { op: "add_node", id: "b", type: "service", label: "B" },
      { op: "add_edge", from: "a", to: "b", type: "sync" },
    ]);
    expect(() => applyOps(withEdge, [{ op: "update_edge", id: "a->b", to: "a" }])).toThrow(
      /Op #0 is malformed.*"to"/,
    );
    expect(() => applyOps(empty(), [{ op: "add_node", id: "a", type: "service", label: "A", groupID: "g" }])).toThrow(
      /Op #0 is malformed.*"groupID"/,
    );
  });

  it("updates fields and clears them with null", () => {
    const b = applyOps(empty(), [
      { op: "add_group", id: "g", label: "G", type: "zone" },
      { op: "add_node", id: "a", type: "service", label: "A", tech: "Go", groupId: "g" },
      { op: "update_node", id: "a", label: "A2", tech: null, groupId: null },
    ]);
    expect(b.nodes[0]).toEqual({ id: "a", type: "service", label: "A2" });
  });

  it("removing a node removes its edges", () => {
    const b = applyOps(empty(), [
      { op: "add_node", id: "a", type: "service", label: "A" },
      { op: "add_node", id: "b", type: "service", label: "B" },
      { op: "add_edge", from: "a", to: "b", type: "sync" },
      { op: "remove_node", id: "b" },
    ]);
    expect(b.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(b.edges).toEqual([]);
  });

  it("errors on unknown ids for update/remove", () => {
    expect(() => applyOps(empty(), [{ op: "remove_node", id: "nope" }])).toThrow(/No node with id "nope"/);
    expect(() => applyOps(empty(), [{ op: "update_edge", id: "x", label: "y" }])).toThrow(/No edge with id "x"/);
  });

  it("refuses to remove a non-empty group unless cascade", () => {
    const withGroup = applyOps(empty(), [
      { op: "add_group", id: "g", label: "G", type: "zone" },
      { op: "add_node", id: "a", type: "service", label: "A", groupId: "g" },
    ]);
    expect(() => applyOps(withGroup, [{ op: "remove_group", id: "g" }])).toThrow(/still contains: a/);
    const b = applyOps(withGroup, [{ op: "remove_group", id: "g", cascade: true }]);
    expect(b.groups).toEqual([]);
    expect(b.nodes[0]!.groupId).toBeUndefined();
  });

  it("does not let ops set layout-computed edge routes", () => {
    const b = applyOps(empty(), [
      { op: "add_node", id: "a", type: "service", label: "A" },
      { op: "add_node", id: "b", type: "service", label: "B" },
    ]);
    expect(() => applyOps(b, [{ op: "add_edge", from: "a", to: "b", type: "sync", points: [{ x: 0, y: 0 }] }])).toThrow(
      /Op #0 is malformed.*points/,
    );
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/layout test/core/ops.test.ts`
Expected: FAIL: the routes test (`e.points` is undefined) and the ops test (the op is accepted instead of rejected as malformed).

- [ ] **Step 3: Implement**

Add `points` to the edge schema, keep it out of `add_edge`, and record ELK's routes in the layout. ELK section coordinates are relative to the edge's `container` group, so they're offset by that group's absolute position. Complete files:

`src/core/schema.ts`:

```ts
import { z } from "zod";
import { ALL_EDGE_TYPES, ALL_GROUP_TYPES, ALL_NODE_TYPES, KINDS } from "./kinds.js";

export const SlugSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must be a lowercase slug like 'orders-db' (a-z, 0-9, '-')");

export const PositionSchema = z.object({ x: z.number(), y: z.number() });

export const FieldSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  pk: z.boolean().optional(),
  fk: z.boolean().optional(),
  nullable: z.boolean().optional(),
});

export const NodeSchema = z.object({
  id: SlugSchema,
  type: z.enum(ALL_NODE_TYPES),
  label: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  tech: z.string().max(100).optional(),
  groupId: SlugSchema.optional(),
  tags: z.array(z.string()).optional(),
  color: z.string().optional(),
  position: PositionSchema.optional(),
  pinned: z.boolean().optional(),
  order: z.number().int().optional(),
  fields: z.array(FieldSchema).optional(),
});

export const EdgeSchema = z.object({
  id: z.string().min(1).max(140),
  from: SlugSchema,
  to: SlugSchema,
  type: z.enum(ALL_EDGE_TYPES),
  label: z.string().max(200).optional(),
  order: z.number().int().optional(),
  style: z.enum(["solid", "dashed"]).optional(),
  cardinality: z.enum(["1-1", "1-n", "n-n"]).optional(),
  /** Route computed by the layout engine (start, bends, end). Never set by agents or users. */
  points: z.array(PositionSchema).optional(),
});

export const GroupSchema = z.object({
  id: SlugSchema,
  label: z.string().min(1).max(200),
  type: z.enum(ALL_GROUP_TYPES),
  parentId: SlugSchema.optional(),
});

export const BoardSchema = z.object({
  id: SlugSchema,
  title: z.string().min(1).max(200),
  kind: z.enum(KINDS),
  revision: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  layout: z.object({ direction: z.enum(["LR", "TB"]) }),
  groups: z.array(GroupSchema),
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
});

export type Position = z.infer<typeof PositionSchema>;
export type Field = z.infer<typeof FieldSchema>;
export type BoardNode = z.infer<typeof NodeSchema>;
export type BoardEdge = z.infer<typeof EdgeSchema>;
export type BoardGroup = z.infer<typeof GroupSchema>;
export type Board = z.infer<typeof BoardSchema>;
export type Direction = Board["layout"]["direction"];
```

`src/core/ops.ts`:

```ts
import { z } from "zod";
import { GabiroError } from "./errors.js";
import { EdgeSchema, GroupSchema, NodeSchema, SlugSchema, type Board } from "./schema.js";
import { validateBoard } from "./validate.js";

/** Optional node fields that an update may clear by sending null. */
const nullable = <T extends z.ZodType>(s: T) => s.nullable().optional();

const NodePatch = z.object({
  type: NodeSchema.shape.type.optional(),
  label: NodeSchema.shape.label.optional(),
  description: nullable(z.string().max(2000)),
  tech: nullable(z.string().max(100)),
  groupId: nullable(SlugSchema),
  tags: nullable(z.array(z.string())),
  color: nullable(z.string()),
  position: nullable(NodeSchema.shape.position.unwrap()),
  pinned: z.boolean().optional(),
  order: nullable(z.number().int()),
  fields: nullable(NodeSchema.shape.fields.unwrap()),
});

const EdgePatch = z.object({
  type: EdgeSchema.shape.type.optional(),
  label: nullable(z.string().max(200)),
  order: nullable(z.number().int()),
  style: nullable(EdgeSchema.shape.style.unwrap()),
  cardinality: nullable(EdgeSchema.shape.cardinality.unwrap()),
});

const GroupPatch = z.object({
  label: GroupSchema.shape.label.optional(),
  type: GroupSchema.shape.type.optional(),
  parentId: nullable(SlugSchema),
});

export const OpSchema = z.discriminatedUnion("op", [
  NodeSchema.extend({ op: z.literal("add_node") }).strict(),
  NodePatch.extend({ op: z.literal("update_node"), id: SlugSchema }).strict(),
  z.object({ op: z.literal("remove_node"), id: SlugSchema }).strict(),
  EdgeSchema.omit({ points: true }).extend({ op: z.literal("add_edge"), id: EdgeSchema.shape.id.optional() }).strict(),
  EdgePatch.extend({ op: z.literal("update_edge"), id: EdgeSchema.shape.id }).strict(),
  z.object({ op: z.literal("remove_edge"), id: EdgeSchema.shape.id }).strict(),
  GroupSchema.extend({ op: z.literal("add_group") }).strict(),
  GroupPatch.extend({ op: z.literal("update_group"), id: SlugSchema }).strict(),
  z.object({ op: z.literal("remove_group"), id: SlugSchema, cascade: z.boolean().optional() }).strict(),
]);
export type Op = z.infer<typeof OpSchema>;

/** Copies patch keys onto target; a null value deletes the key. */
function patch<T extends object>(target: T, changes: Record<string, unknown>): void {
  const t = target as Record<string, unknown>;
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    if (value === null) delete t[key];
    else t[key] = value;
  }
}

function notFound(what: string, id: string, existing: string[]): never {
  const known = existing.length ? existing.join(", ") : "(none)";
  throw new GabiroError("NOT_FOUND", `No ${what} with id "${id}". Existing ${what}s: ${known}.`);
}

function defaultEdgeId(board: Board, from: string, to: string): string {
  const base = `${from}->${to}`;
  const taken = new Set(board.edges.map((e) => e.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}#${n}`)) n++;
  return `${base}#${n}`;
}

function applyOne(board: Board, op: Op): void {
  switch (op.op) {
    case "add_node": {
      const { op: _, ...node } = op;
      board.nodes.push(node);
      return;
    }
    case "update_node": {
      const { op: _, id, ...changes } = op;
      const node = board.nodes.find((n) => n.id === id) ?? notFound("node", id, board.nodes.map((n) => n.id));
      patch(node, changes);
      return;
    }
    case "remove_node": {
      if (!board.nodes.some((n) => n.id === op.id)) notFound("node", op.id, board.nodes.map((n) => n.id));
      board.nodes = board.nodes.filter((n) => n.id !== op.id);
      board.edges = board.edges.filter((e) => e.from !== op.id && e.to !== op.id);
      return;
    }
    case "add_edge": {
      const { op: _, id, ...edge } = op;
      board.edges.push({ id: id ?? defaultEdgeId(board, edge.from, edge.to), ...edge });
      return;
    }
    case "update_edge": {
      const { op: _, id, ...changes } = op;
      const edge = board.edges.find((e) => e.id === id) ?? notFound("edge", id, board.edges.map((e) => e.id));
      patch(edge, changes);
      return;
    }
    case "remove_edge": {
      if (!board.edges.some((e) => e.id === op.id)) notFound("edge", op.id, board.edges.map((e) => e.id));
      board.edges = board.edges.filter((e) => e.id !== op.id);
      return;
    }
    case "add_group": {
      const { op: _, ...group } = op;
      board.groups.push(group);
      return;
    }
    case "update_group": {
      const { op: _, id, ...changes } = op;
      const group = board.groups.find((g) => g.id === id) ?? notFound("group", id, board.groups.map((g) => g.id));
      patch(group, changes);
      return;
    }
    case "remove_group": {
      if (!board.groups.some((g) => g.id === op.id)) notFound("group", op.id, board.groups.map((g) => g.id));
      const childNodes = board.nodes.filter((n) => n.groupId === op.id);
      const childGroups = board.groups.filter((g) => g.parentId === op.id);
      if ((childNodes.length || childGroups.length) && !op.cascade) {
        const children = [...childNodes, ...childGroups].map((c) => c.id).join(", ");
        throw new GabiroError(
          "VALIDATION",
          `Group "${op.id}" still contains: ${children}. Move them out first, or pass cascade: true to ungroup them.`,
        );
      }
      for (const n of childNodes) delete n.groupId;
      for (const g of childGroups) delete g.parentId;
      board.groups = board.groups.filter((g) => g.id !== op.id);
      return;
    }
  }
}

/**
 * Applies ops in order to a copy of the board and returns the new board.
 * All-or-nothing: the first invalid op throws, naming its index, and the input board is untouched.
 */
export function applyOps(board: Board, rawOps: unknown[]): Board {
  let draft = structuredClone(board);
  rawOps.forEach((raw, index) => {
    const label = `Op #${index}`;
    const parsed = OpSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      const at = issue.path.length ? ` at "${issue.path.join(".")}"` : "";
      throw new GabiroError("VALIDATION", `${label} is malformed${at}: ${issue.message}. Nothing was changed.`);
    }
    try {
      applyOne(draft, parsed.data);
      draft = validateBoard(draft);
    } catch (err) {
      if (err instanceof GabiroError) {
        throw new GabiroError(err.code, `${label} (${parsed.data.op}) failed: ${err.message} Nothing was changed.`);
      }
      throw err;
    }
  });
  return draft;
}
```

`src/layout/layout.ts`:

```ts
import { createRequire } from "node:module";
import type { ELK, ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api.js";
import type { Board, BoardNode, Position } from "../core/index.js";
import { nodeSize } from "./sizes.js";

/**
 * - "auto":  if any node lacks a position, re-place every unpinned node; otherwise change nothing.
 * - "all":   re-place every unpinned node.
 * - "force": re-place every node and clear `pinned`.
 */
export type LayoutMode = "auto" | "all" | "force";

// elkjs is CommonJS; createRequire sidesteps default-export interop differences between tsc and Node.
const ElkConstructor = createRequire(import.meta.url)("elkjs/lib/elk.bundled.js") as new () => ELK;
const elk = new ElkConstructor();
const GAP = 40;

/** Returns a copy of the board with positions filled in according to `mode`. Deterministic. */
export async function layoutBoard(board: Board, mode: LayoutMode = "auto"): Promise<Board> {
  const next = structuredClone(board);
  if (mode === "force") for (const n of next.nodes) delete n.pinned;
  if (mode === "auto" && next.nodes.every((n) => n.position)) return next;

  const movable = (n: BoardNode) => !n.pinned;
  let placed: Map<string, Position>;
  let routes = new Map<string, Position[]>();
  switch (next.kind) {
    case "freeform":
      placed = freeformPositions(next);
      break;
    case "sequence":
      placed = sequencePositions(next);
      break;
    case "kanban":
      placed = kanbanPositions(next);
      break;
    default:
      ({ positions: placed, routes } = await elkPositions(next));
  }
  for (const n of next.nodes) {
    const p = placed.get(n.id);
    if (p && (movable(n) || !n.position)) n.position = p;
  }
  // ELK routed every edge as if nothing were pinned, so a route touching a pinned node is wrong: drop it.
  const pinned = new Set(next.nodes.filter((n) => n.pinned).map((n) => n.id));
  for (const e of next.edges) {
    const route = routes.get(e.id);
    if (route && !pinned.has(e.from) && !pinned.has(e.to)) e.points = route;
    else delete e.points;
  }
  return next;
}

const round = (p: Position): Position => ({ x: Math.round(p.x), y: Math.round(p.y) });
const byOrder = (a: BoardNode, b: BoardNode) =>
  (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || (a.id < b.id ? -1 : 1);

/** Freeform never rearranges: only nodes without a position get a grid slot right of existing content. */
function freeformPositions(board: Board): Map<string, Position> {
  const out = new Map<string, Position>();
  const positioned = board.nodes.filter((n) => n.position);
  let x = positioned.length ? Math.max(...positioned.map((n) => n.position!.x + nodeSize(n).width)) + GAP * 2 : 0;
  let y = 0;
  let row = 0;
  for (const n of board.nodes.filter((m) => !m.position)) {
    out.set(n.id, { x, y });
    y += nodeSize(n).height + GAP;
    if (++row === 4) {
      row = 0;
      y = 0;
      x += 200 + GAP;
    }
  }
  return out;
}

/** Participants in a row, ordered by `order`. Messages are drawn by the canvas between lifelines. */
function sequencePositions(board: Board): Map<string, Position> {
  const out = new Map<string, Position>();
  board.nodes
    .filter((n) => n.type === "participant")
    .sort(byOrder)
    .forEach((n, i) => out.set(n.id, { x: i * 220, y: 0 }));
  const stickies = board.nodes.filter((n) => n.type === "sticky");
  stickies.forEach((n, i) => out.set(n.id, { x: i * 200, y: -180 }));
  return out;
}

/** Columns left to right in group order; cards stacked by `order`. */
function kanbanPositions(board: Board): Map<string, Position> {
  const out = new Map<string, Position>();
  board.groups.forEach((col, i) => {
    let y = 60;
    for (const card of board.nodes.filter((n) => n.groupId === col.id).sort(byOrder)) {
      out.set(card.id, { x: i * 280 + 20, y });
      y += nodeSize(card).height + 16;
    }
  });
  const loose = board.nodes.filter((n) => n.groupId === undefined);
  loose.forEach((n, i) => out.set(n.id, { x: board.groups.length * 280 + 20, y: 60 + i * 140 }));
  return out;
}

async function elkPositions(board: Board): Promise<{ positions: Map<string, Position>; routes: Map<string, Position[]> }> {
  const direction = board.layout.direction === "LR" ? "RIGHT" : "DOWN";
  const sorted = [...board.nodes].sort((a, b) => (a.id < b.id ? -1 : 1));

  const toElkNode = (n: BoardNode): ElkNode => ({ id: n.id, ...nodeSize(n) });
  const buildGroup = (groupId: string | undefined): ElkNode[] => [
    ...board.groups
      .filter((g) => g.parentId === groupId)
      .map((g) => ({
        id: `group:${g.id}`,
        layoutOptions: { "elk.padding": "[top=48,left=24,bottom=24,right=24]" },
        children: buildGroup(g.id),
      })),
    ...sorted.filter((n) => n.groupId === groupId).map(toElkNode),
  ];

  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": board.kind === "mindmap" ? "mrtree" : "layered",
      "elk.direction": direction,
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.spacing.nodeNode": "50",
      "elk.layered.spacing.nodeNodeBetweenLayers": "80",
      "elk.spacing.componentComponent": "80",
    },
    children: buildGroup(undefined),
    edges: board.edges.map((e): ElkExtendedEdge => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  };

  const result = await elk.layout(graph);
  const positions = new Map<string, Position>();
  const offsets = new Map<string, Position>([["root", { x: 0, y: 0 }]]);
  const walk = (node: ElkNode, offset: Position) => {
    for (const child of node.children ?? []) {
      const abs = { x: offset.x + (child.x ?? 0), y: offset.y + (child.y ?? 0) };
      if (child.id.startsWith("group:")) offsets.set(child.id, abs);
      else positions.set(child.id, round(abs));
      walk(child, abs);
    }
  };
  walk(result, { x: 0, y: 0 });

  // Edge sections are relative to the edge's container (the group ELK placed it in), not the root.
  const routes = new Map<string, Position[]>();
  for (const edge of (result.edges ?? []) as (ElkExtendedEdge & { container?: string })[]) {
    const section = edge.sections?.[0];
    if (!section) continue;
    const base = offsets.get(edge.container ?? "root") ?? { x: 0, y: 0 };
    const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
    routes.set(edge.id, points.map((p) => round({ x: base.x + p.x, y: base.y + p.y })));
  }
  return { positions, routes };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/layout test/core && npx tsc --noEmit && npm test`
Expected: all pass (13 files, 92 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/schema.ts src/core/ops.ts src/layout/layout.ts test/layout/layout.test.ts test/core/ops.test.ts
git commit -m "feat(layout): store ELK edge routes so edges go around boxes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

### Task 3: Canvas server: API, static app, live WebSocket push

**Files:**
- Create: `src/server/protocol.ts`
- Create: `src/server/info.ts`
- Create: `src/server/watch.ts`
- Create: `src/server/static.ts`
- Create: `src/server/canvas-server.ts`
- Create: `src/server/index.ts`
- Test: `test/server/canvas-server.test.ts`

The server binds to 127.0.0.1. It tries port 4477 and then the next 19 ports; port 0 means any free port, which the tests use. Boards are pushed as full snapshots: after a subscribe, and whenever the watcher sees `<id>.json` change. Corrupt or deleted boards become `board-error` messages. The HTTP API is GET-only in this plan.

- [ ] **Step 1: Write the failing test**

`test/server/canvas-server.test.ts`:

```ts
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startCanvasServer, type CanvasServer, type ServerMessage } from "../../src/server/index.js";
import { BoardService } from "../../src/service/index.js";
import { tempRoot } from "../helpers.js";

const servers: CanvasServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(root: string, extra: { webDir?: string; port?: number } = {}) {
  const server = await startCanvasServer({ root, port: extra.port ?? 0, webDir: extra.webDir ?? join(root, "no-web") });
  servers.push(server);
  return server;
}

/** Opens a socket and returns a helper that waits for the next message matching a predicate. */
async function socket(url: string) {
  const ws = new WebSocket(url.replace("http", "ws") + "/ws");
  const inbox: ServerMessage[] = [];
  const waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString()) as ServerMessage;
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(msg);
    else inbox.push(msg);
  });
  await new Promise((r) => ws.once("open", r));
  const next = (pred: (m: ServerMessage) => boolean, timeoutMs = 3000) =>
    new Promise<ServerMessage>((resolve, reject) => {
      const i = inbox.findIndex(pred);
      if (i >= 0) return resolve(inbox.splice(i, 1)[0]!);
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
      waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  return { ws, send: (m: unknown) => ws.send(JSON.stringify(m)), next };
}

const CHECKOUT = [
  { op: "add_node", id: "web", type: "client", label: "Web" },
  { op: "add_node", id: "api", type: "service", label: "API" },
  { op: "add_edge", from: "web", to: "api", type: "sync" },
];

describe("canvas server HTTP", () => {
  it("reports health with its project root", async () => {
    const root = await tempRoot();
    const s = await start(root);
    const body = await (await fetch(`${s.url}/api/health`)).json();
    expect(body).toMatchObject({ ok: true, root, pid: process.pid });
  });

  it("lists and returns boards as JSON, with GabiroError codes on failure", async () => {
    const root = await tempRoot();
    await new BoardService(root).create({ title: "Shop", kind: "architecture", ops: CHECKOUT });
    const s = await start(root);
    expect((await (await fetch(`${s.url}/api/boards`)).json()).boards).toMatchObject([{ id: "shop", nodeCount: 2 }]);
    expect((await (await fetch(`${s.url}/api/boards/shop`)).json()).board.nodes).toHaveLength(2);
    const missing = await fetch(`${s.url}/api/boards/nope`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "NOT_FOUND" });
    expect((await fetch(`${s.url}/api/boards/shop`, { method: "POST" })).status).toBe(405);
  });

  it("serves the web app with an index.html fallback for app routes, and never outside webDir", async () => {
    const root = await tempRoot();
    const webDir = join(root, "web");
    await mkdir(join(webDir, "assets"), { recursive: true });
    await writeFile(join(webDir, "index.html"), "<html>canvas</html>");
    await writeFile(join(webDir, "assets", "app.js"), "console.log(1)");
    await writeFile(join(root, "secret.txt"), "secret");
    const s = await start(root, { webDir });
    expect(await (await fetch(`${s.url}/`)).text()).toBe("<html>canvas</html>");
    expect(await (await fetch(`${s.url}/b/shop`)).text()).toBe("<html>canvas</html>");
    const js = await fetch(`${s.url}/assets/app.js`);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect((await fetch(`${s.url}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${s.url}/%2e%2e/secret.txt`)).status).toBe(404);
  });

  it("explains a missing web build", async () => {
    const s = await start(await tempRoot());
    const res = await fetch(`${s.url}/`);
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/npm run build/);
  });

  it("falls back to the next port when the first is taken", async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    const taken = (blocker.address() as { port: number }).port;
    try {
      const s = await start(await tempRoot(), { port: taken });
      expect(s.port).toBeGreaterThan(taken);
    } finally {
      blocker.close();
    }
  });

  it("records itself in .gabiro/server.json and removes it on close", async () => {
    const root = await tempRoot();
    const s = await startCanvasServer({ root, port: 0, webDir: root });
    const info = JSON.parse(await readFile(join(root, ".gabiro/server.json"), "utf8"));
    expect(info).toEqual({ pid: process.pid, port: s.port, url: s.url, root });
    await s.close();
    await expect(stat(join(root, ".gabiro/server.json"))).rejects.toThrow();
  });
});

describe("canvas server live updates", () => {
  it("sends a snapshot on subscribe and pushes every change", async () => {
    const root = await tempRoot();
    const svc = new BoardService(root);
    await svc.create({ title: "Shop", kind: "architecture", ops: CHECKOUT });
    const s = await start(root);
    const c = await socket(s.url);
    c.send({ type: "subscribe", boardId: "shop" });
    const first = await c.next((m) => m.type === "board");
    expect(first).toMatchObject({ type: "board", board: { id: "shop", revision: 1 } });

    await svc.applyChanges("shop", [{ op: "add_node", id: "db", type: "database", label: "DB" }]);
    const pushed = await c.next((m) => m.type === "board" && m.board.revision === 2);
    expect(pushed.type === "board" && pushed.board.nodes.map((n) => n.id)).toContain("db");
    c.ws.close();
  });

  it("pushes the board list to list subscribers when boards are created", async () => {
    const root = await tempRoot();
    const s = await start(root);
    const c = await socket(s.url);
    c.send({ type: "subscribe-list" });
    expect(await c.next((m) => m.type === "boards")).toEqual({ type: "boards", boards: [] });
    await new BoardService(root).create({ title: "Shop", kind: "architecture" });
    const update = await c.next((m) => m.type === "boards" && m.boards.length === 1);
    expect(update).toMatchObject({ boards: [{ id: "shop" }] });
    c.ws.close();
  });

  it("reports corrupt and deleted boards as board-error messages", async () => {
    const root = await tempRoot();
    const svc = new BoardService(root);
    await svc.create({ title: "Shop", kind: "architecture" });
    const s = await start(root);
    const c = await socket(s.url);
    c.send({ type: "subscribe", boardId: "shop" });
    await c.next((m) => m.type === "board");

    await writeFile(join(root, ".gabiro/boards/shop.json"), "{ broken");
    expect(await c.next((m) => m.type === "board-error")).toMatchObject({ boardId: "shop", code: "CORRUPT" });

    await svc.store.delete("shop");
    expect(await c.next((m) => m.type === "board-error" && m.code === "NOT_FOUND")).toMatchObject({ boardId: "shop" });
    c.ws.close();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/server/canvas-server.test.ts`
Expected: FAIL: cannot resolve `../../src/server/index.js`.

- [ ] **Step 3: Implement**

`protocol.ts` imports `BoardListItem` from `../store/store.js`, not from the store barrel, so the web app can share these types without pulling in Node modules.

`src/server/protocol.ts`:

```ts
import type { Board } from "../core/index.js";
import type { BoardListItem } from "../store/store.js";

/** Messages the browser sends over the /ws socket. */
export type ClientMessage = { type: "subscribe"; boardId: string } | { type: "subscribe-list" };

/** Messages the canvas server pushes to the browser. Boards are always sent as full snapshots. */
export type ServerMessage =
  | { type: "board"; board: Board }
  | { type: "board-error"; boardId: string; code: string; message: string }
  | { type: "boards"; boards: BoardListItem[] };

/** Response of GET /api/health; `root` lets a client confirm the server belongs to its project. */
export interface HealthResponse {
  ok: true;
  root: string;
  version: string;
  pid: number;
}
```

`src/server/info.ts`:

```ts
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../store/index.js";
import type { HealthResponse } from "./protocol.js";

/** Contents of `.gabiro/server.json`, written by a running canvas server. */
export interface ServerInfo {
  pid: number;
  port: number;
  url: string;
  root: string;
}

export const serverInfoPath = (root: string) => join(root, ".gabiro", "server.json");

export async function writeServerInfo(info: ServerInfo): Promise<void> {
  await writeFileAtomic(serverInfoPath(info.root), JSON.stringify(info, null, 2) + "\n");
}

/** Returns the recorded server, or undefined if the file is missing or unreadable. */
export async function readServerInfo(root: string): Promise<ServerInfo | undefined> {
  try {
    const info = JSON.parse(await readFile(serverInfoPath(root), "utf8")) as ServerInfo;
    return typeof info.url === "string" && typeof info.pid === "number" ? info : undefined;
  } catch {
    return undefined;
  }
}

/** Removes server.json, but only if it still describes this process (a newer server may have replaced it). */
export async function clearServerInfo(root: string, pid = process.pid): Promise<void> {
  const info = await readServerInfo(root);
  if (info?.pid === pid) await rm(serverInfoPath(root), { force: true });
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True if a gabiro canvas server for exactly this project root answers at `url`. */
export async function isHealthy(url: string, root: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return false;
    const body = (await res.json()) as Partial<HealthResponse>;
    return body.ok === true && body.root === root;
  } catch {
    return false;
  }
}
```

`src/server/watch.ts`:

```ts
import { watch, type FSWatcher } from "node:fs";
import { mkdirSync } from "node:fs";

const BOARD_FILE = /^([a-z0-9][a-z0-9-]*)\.json$/;

/**
 * Calls `onChange(boardId)` when `<dir>/<id>.json` is created, changed or removed.
 * Events are debounced per board, so an atomic write (temp file + rename) fires once.
 */
export function watchBoards(dir: string, onChange: (boardId: string) => void, debounceMs = 40): () => void {
  mkdirSync(dir, { recursive: true });
  const timers = new Map<string, NodeJS.Timeout>();
  const watcher: FSWatcher = watch(dir, (_event, filename) => {
    const id = filename ? BOARD_FILE.exec(filename.toString())?.[1] : undefined;
    if (!id) return;
    clearTimeout(timers.get(id));
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        onChange(id);
      }, debounceMs),
    );
  });
  return () => {
    watcher.close();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };
}
```

`src/server/static.ts`:

```ts
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/**
 * Serves the built canvas from `webDir`. Paths without an extension (app routes like /b/my-board)
 * get index.html so the browser app can route them. Never serves files outside `webDir`.
 */
export async function serveStatic(webDir: string, pathname: string, res: ServerResponse): Promise<void> {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  const isAppRoute = extname(rel) === "";
  const file = join(webDir, isAppRoute ? "index.html" : rel);
  if (file !== webDir && !file.startsWith(webDir.endsWith(sep) ? webDir : webDir + sep)) {
    res.writeHead(404).end("Not found");
    return;
  }
  try {
    const body = await readFile(file);
    const cache = isAppRoute ? "no-cache" : "public, max-age=31536000, immutable";
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": cache });
    res.end(body);
  } catch {
    if (isAppRoute) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("The gabiro canvas isn't built. Run `npm run build` in the gabiro package.");
    } else {
      res.writeHead(404).end("Not found");
    }
  }
}
```

`src/server/canvas-server.ts`:

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { GabiroError } from "../core/index.js";
import { BoardService } from "../service/index.js";
import { VERSION } from "../version.js";
import { clearServerInfo, writeServerInfo } from "./info.js";
import type { ClientMessage, HealthResponse, ServerMessage } from "./protocol.js";
import { serveStatic } from "./static.js";
import { watchBoards } from "./watch.js";

export const DEFAULT_PORT = 4477;
const PORT_ATTEMPTS = 20;

export interface CanvasServerOptions {
  root: string;
  /** First port to try; the next free port is used if it is taken. 0 picks any free port. */
  port?: number;
  host?: string;
  /** Directory with the built web app. Defaults to dist/web next to this module. */
  webDir?: string;
  /** Write .gabiro/server.json so MCP tools can find this server. Default true. */
  recordInfo?: boolean;
}

export interface CanvasServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** dist/server/canvas-server.js -> dist/web */
export const defaultWebDir = () => fileURLToPath(new URL("../web", import.meta.url));

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function errorStatus(code: string): number {
  return code === "NOT_FOUND" ? 404 : code === "VALIDATION" ? 400 : code === "CONFLICT" ? 409 : 500;
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/** Starts the canvas: JSON API, static web app, and live board pushes over WebSocket at /ws. */
export async function startCanvasServer(options: CanvasServerOptions): Promise<CanvasServer> {
  const { root, host = "127.0.0.1", recordInfo = true } = options;
  const webDir = options.webDir ?? defaultWebDir();
  const service = new BoardService(root);

  const http = createServer((req, res) => {
    handleHttp(req, res).catch((err) => sendJson(res, 500, { code: "INTERNAL", error: (err as Error).message }));
  });

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { code: "VALIDATION", error: "The canvas API is read-only in this version." });
      return;
    }
    if (pathname === "/api/health") {
      const body: HealthResponse = { ok: true, root, version: VERSION, pid: process.pid };
      sendJson(res, 200, body);
      return;
    }
    if (pathname === "/api/boards") {
      sendJson(res, 200, { boards: await service.list() });
      return;
    }
    const match = /^\/api\/boards\/([^/]+)$/.exec(pathname);
    if (match) {
      try {
        sendJson(res, 200, { board: await service.get(decodeURIComponent(match[1]!)) });
      } catch (err) {
        if (!(err instanceof GabiroError)) throw err;
        sendJson(res, errorStatus(err.code), { code: err.code, error: err.message });
      }
      return;
    }
    if (pathname.startsWith("/api/")) {
      sendJson(res, 404, { code: "NOT_FOUND", error: `Unknown API route ${pathname}` });
      return;
    }
    await serveStatic(webDir, pathname, res);
  }

  // --- live updates -------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true });
  const boardSubs = new Map<WebSocket, Set<string>>();
  const listSubs = new Set<WebSocket>();

  const send = (ws: WebSocket, msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  async function boardMessage(boardId: string): Promise<ServerMessage> {
    try {
      return { type: "board", board: await service.get(boardId) };
    } catch (err) {
      const code = err instanceof GabiroError ? err.code : "INTERNAL";
      return { type: "board-error", boardId, code, message: (err as Error).message };
    }
  }

  http.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    boardSubs.set(ws, new Set());
    ws.on("close", () => {
      boardSubs.delete(ws);
      listSubs.delete(ws);
    });
    ws.on("message", async (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return;
      }
      if (msg.type === "subscribe" && typeof msg.boardId === "string") {
        boardSubs.get(ws)?.add(msg.boardId);
        send(ws, await boardMessage(msg.boardId));
      } else if (msg.type === "subscribe-list") {
        listSubs.add(ws);
        send(ws, { type: "boards", boards: await service.list() });
      }
    });
  });

  const stopWatching = watchBoards(join(root, ".gabiro", "boards"), async (boardId) => {
    const watchers = [...boardSubs].filter(([, ids]) => ids.has(boardId)).map(([ws]) => ws);
    if (watchers.length) {
      const msg = await boardMessage(boardId);
      for (const ws of watchers) send(ws, msg);
    }
    if (listSubs.size) {
      const msg: ServerMessage = { type: "boards", boards: await service.list() };
      for (const ws of listSubs) send(ws, msg);
    }
  });

  // --- listen, falling back to the next free port --------------------------
  const firstPort = options.port ?? DEFAULT_PORT;
  let port = -1;
  for (let attempt = 0; attempt < (firstPort === 0 ? 1 : PORT_ATTEMPTS); attempt++) {
    try {
      port = await listen(http, firstPort === 0 ? 0 : firstPort + attempt, host);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        stopWatching();
        throw err;
      }
    }
  }
  if (port < 0) {
    stopWatching();
    throw new GabiroError(
      "UNAVAILABLE",
      `Ports ${firstPort}-${firstPort + PORT_ATTEMPTS - 1} are all in use. Start the canvas with --port <free port>.`,
    );
  }

  const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;
  if (recordInfo) await writeServerInfo({ pid: process.pid, port, url, root });

  return {
    url,
    port,
    async close() {
      stopWatching();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      if (recordInfo) await clearServerInfo(root);
    },
  };
}
```

The barrel for now; Task 4 adds the launcher exports:

`src/server/index.ts`:

```ts
export { startCanvasServer, DEFAULT_PORT, type CanvasServer, type CanvasServerOptions } from "./canvas-server.js";
export { readServerInfo, type ServerInfo } from "./info.js";
export type { ClientMessage, ServerMessage, HealthResponse } from "./protocol.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/server/canvas-server.test.ts && npx tsc --noEmit`
Expected: 9 tests pass. Run the file 3 times to confirm the file-watch tests are stable.

- [ ] **Step 5: Commit**

```bash
git add src/server/protocol.ts src/server/info.ts src/server/watch.ts src/server/static.ts src/server/canvas-server.ts src/server/index.ts test/server/canvas-server.test.ts
git commit -m "feat(server): canvas HTTP API, static app and live WebSocket push" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

### Task 4: Launcher: find, start and open the canvas

**Files:**
- Create: `src/server/launcher.ts`
- Modify: `src/server/index.ts`
- Test: `test/server/launcher.test.ts`

`ensureCanvasServer` reuses the recorded server if `/api/health` answers for the same project root. Otherwise it spawns `node dist/cli.js serve --root <root>` detached, so the canvas outlives the MCP process like a normal dev server, and polls `server.json` for up to 8 s. Spawning needs the built CLI; the end-to-end test in Task 8 covers it.

- [ ] **Step 1: Write the failing test**

`test/server/launcher.test.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canvasUrl, ensureCanvasServer, openInBrowser, startCanvasServer, type CanvasServer } from "../../src/server/index.js";
import { GabiroError } from "../../src/core/index.js";
import { tempRoot } from "../helpers.js";

const servers: CanvasServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function writeInfo(root: string, info: object) {
  await mkdir(join(root, ".gabiro"), { recursive: true });
  await writeFile(join(root, ".gabiro/server.json"), JSON.stringify(info));
}

describe("canvasUrl", () => {
  it("is undefined when no server is recorded", async () => {
    expect(await canvasUrl(await tempRoot())).toBeUndefined();
  });

  it("builds board URLs for a live recorded server", async () => {
    const root = await tempRoot();
    await writeInfo(root, { pid: process.pid, port: 4477, url: "http://127.0.0.1:4477", root });
    expect(await canvasUrl(root)).toBe("http://127.0.0.1:4477");
    expect(await canvasUrl(root, "shop")).toBe("http://127.0.0.1:4477/b/shop");
  });

  it("ignores a record left by a dead process or another project", async () => {
    const root = await tempRoot();
    await writeInfo(root, { pid: 2 ** 22 + 12345, port: 1, url: "http://127.0.0.1:1", root });
    expect(await canvasUrl(root)).toBeUndefined();
    await writeInfo(root, { pid: process.pid, port: 1, url: "http://127.0.0.1:1", root: "/elsewhere" });
    expect(await canvasUrl(root)).toBeUndefined();
  });
});

describe("ensureCanvasServer", () => {
  it("reuses a healthy server for the same project without spawning", async () => {
    const root = await tempRoot();
    const s = await startCanvasServer({ root, port: 0, webDir: root });
    servers.push(s);
    expect(await ensureCanvasServer(root, { cliPath: "/definitely/missing/cli.js" })).toBe(s.url);
  });

  it("explains how to fix a missing build instead of spawning", async () => {
    const err = await ensureCanvasServer(await tempRoot(), { cliPath: "/definitely/missing/cli.js" }).catch((e) => e);
    expect(err).toBeInstanceOf(GabiroError);
    expect(err.code).toBe("UNAVAILABLE");
    expect(err.message).toMatch(/npm run build/);
  });
});

describe("openInBrowser", () => {
  it("does nothing when GABIRO_NO_BROWSER is set", () => {
    const before = process.env.GABIRO_NO_BROWSER;
    process.env.GABIRO_NO_BROWSER = "1";
    try {
      expect(openInBrowser("http://127.0.0.1:1")).toBe(false);
    } finally {
      if (before === undefined) delete process.env.GABIRO_NO_BROWSER;
      else process.env.GABIRO_NO_BROWSER = before;
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/server/launcher.test.ts`
Expected: FAIL: `canvasUrl` / `ensureCanvasServer` / `openInBrowser` are not exported from `src/server/index.js`.

- [ ] **Step 3: Implement**

`src/server/launcher.ts`:

```ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GabiroError } from "../core/index.js";
import { isHealthy, isProcessAlive, readServerInfo } from "./info.js";

/** dist/server/launcher.js -> dist/cli.js */
const defaultCliPath = () => fileURLToPath(new URL("../cli.js", import.meta.url));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** URL of this project's running canvas (optionally for one board), or undefined if none is recorded as running. */
export async function canvasUrl(root: string, boardId?: string): Promise<string | undefined> {
  const info = await readServerInfo(root);
  if (!info || info.root !== root || !isProcessAlive(info.pid)) return undefined;
  return boardId ? `${info.url}/b/${boardId}` : info.url;
}

export interface EnsureOptions {
  /** Path to the built CLI used to spawn `gabiro serve`. */
  cliPath?: string;
  timeoutMs?: number;
}

/**
 * Returns the base URL of this project's canvas server, starting a detached `gabiro serve` if none
 * is healthy. The spawned server outlives the MCP process, like a normal dev server.
 */
export async function ensureCanvasServer(root: string, options: EnsureOptions = {}): Promise<string> {
  const existing = await readServerInfo(root);
  if (existing && (await isHealthy(existing.url, root))) return existing.url;

  const cliPath = options.cliPath ?? defaultCliPath();
  if (!existsSync(cliPath)) {
    throw new GabiroError("UNAVAILABLE", `Can't start the canvas: ${cliPath} is missing. Run \`npm run build\` in the gabiro package.`);
  }
  const child = spawn(process.execPath, [cliPath, "serve", "--root", root], { detached: true, stdio: "ignore" });
  child.unref();

  const deadline = Date.now() + (options.timeoutMs ?? 8000);
  while (Date.now() < deadline) {
    await sleep(100);
    const info = await readServerInfo(root);
    if (info && info.pid !== existing?.pid && (await isHealthy(info.url, root))) return info.url;
  }
  throw new GabiroError(
    "UNAVAILABLE",
    `The canvas server didn't start within ${Math.round((options.timeoutMs ?? 8000) / 1000)}s. Run \`gabiro serve --root ${root}\` in a terminal to see why.`,
  );
}

/** Opens `url` in the default browser. Returns false when disabled via GABIRO_NO_BROWSER or when no opener exists. */
export function openInBrowser(url: string): boolean {
  if (process.env.GABIRO_NO_BROWSER) return false;
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
```

Replace the barrel:

`src/server/index.ts`:

```ts
export { startCanvasServer, DEFAULT_PORT, type CanvasServer, type CanvasServerOptions } from "./canvas-server.js";
export { canvasUrl, ensureCanvasServer, openInBrowser } from "./launcher.js";
export { readServerInfo, type ServerInfo } from "./info.js";
export type { ClientMessage, ServerMessage, HealthResponse } from "./protocol.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/server && npx tsc --noEmit`
Expected: 15 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/launcher.ts src/server/index.ts test/server/launcher.test.ts
git commit -m "feat(server): launcher to find, start and open the canvas" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

### Task 5: MCP: gabiro_open_board and canvas links

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/mcp/help.ts`
- Modify (test): `test/mcp/tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Complete updated test file. It uses a fake `CanvasAccess`, so no server or browser starts, and adds `gabiro_open_board` to the expected tool list plus two new tests.

`test/mcp/tools.test.ts`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../../src/mcp/server.js";
import type { CanvasAccess } from "../../src/mcp/tools.js";
import { tempRoot } from "../helpers.js";

/** A canvas that is "not running" unless told otherwise, and records what it was asked to open. */
function fakeCanvas(running?: string) {
  const opened: string[] = [];
  const canvas: CanvasAccess = {
    url: async (_root, boardId) => (running ? (boardId ? `${running}/b/${boardId}` : running) : undefined),
    ensure: async () => running ?? "http://127.0.0.1:4477",
    open: (url) => (opened.push(url), true),
  };
  return { canvas, opened };
}

async function connect(canvas: CanvasAccess = fakeCanvas().canvas) {
  const root = await tempRoot();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(root, canvas).connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;
  return { client, call, text, root };
}

const CHECKOUT_OPS = [
  { op: "add_group", id: "backend", label: "Backend", type: "zone" },
  { op: "add_node", id: "web", type: "client", label: "Web App" },
  { op: "add_node", id: "api", type: "service", label: "Checkout API", groupId: "backend" },
  { op: "add_node", id: "db", type: "database", label: "Orders DB", tech: "Postgres", groupId: "backend" },
  { op: "add_edge", from: "web", to: "api", type: "sync", label: "HTTPS" },
  { op: "add_edge", from: "api", to: "db", type: "sync" },
];

describe("gabiro MCP server", () => {
  it("exposes the tools with annotations and server instructions", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "gabiro_apply_changes",
      "gabiro_auto_layout",
      "gabiro_create_board",
      "gabiro_delete_board",
      "gabiro_export",
      "gabiro_get_board",
      "gabiro_list_boards",
      "gabiro_open_board",
      "gabiro_update_board",
    ]);
    expect(tools.find((t) => t.name === "gabiro_get_board")!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "gabiro_delete_board")!.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === "gabiro_create_board")!.inputSchema.properties).toHaveProperty("ops");
    expect(client.getInstructions()).toContain("gabiro_create_board");
  });

  it("builds a whole diagram in one call and reads it back", async () => {
    const { call, text } = await connect();
    const created = await call("gabiro_create_board", { title: "Checkout", kind: "architecture", ops: CHECKOUT_OPS });
    expect(created.isError).toBeFalsy();
    expect(created.structuredContent).toEqual({ boardId: "checkout", revision: 1, nodes: 3, edges: 2, groups: 1 });
    expect(text(created)).toContain('node db [database] "Orders DB" (Postgres) in backend');

    const summary = await call("gabiro_get_board", { boardId: "checkout" });
    expect(text(summary)).toMatch(/^board checkout "Checkout" kind=architecture/);

    const json = await call("gabiro_get_board", { boardId: "checkout", format: "json" });
    const board = (json.structuredContent as { board: { nodes: { position?: unknown }[] } }).board;
    expect(board.nodes.every((n) => n.position)).toBe(true);

    const mermaid = await call("gabiro_get_board", { boardId: "checkout", format: "mermaid" });
    expect(text(mermaid)).toContain("web -->|\"HTTPS\"| api");

    const list = await call("gabiro_list_boards");
    expect(text(list)).toMatch(/^checkout "Checkout" kind=architecture nodes=3/);
  });

  it("applies changes with a delta report and rejects stale revisions", async () => {
    const { call, text } = await connect();
    await call("gabiro_create_board", { title: "Checkout", kind: "architecture", ops: CHECKOUT_OPS });
    const changed = await call("gabiro_apply_changes", {
      boardId: "checkout",
      expectedRevision: 1,
      ops: [
        { op: "add_node", id: "cache", type: "cache", label: "Redis" },
        { op: "add_edge", from: "api", to: "cache", type: "sync" },
      ],
    });
    expect(text(changed)).toBe('Board "checkout" is at revision 2: 4 nodes, 3 edges, 1 groups. Change: +1 nodes, +1 edges.');

    const stale = await call("gabiro_apply_changes", { boardId: "checkout", expectedRevision: 1, ops: [] });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toMatch(/revision 2, you sent 1/);
  });

  it("returns actionable errors instead of throwing", async () => {
    const { call, text } = await connect();
    await call("gabiro_create_board", { title: "Flow", kind: "flowchart" });
    const bad = await call("gabiro_apply_changes", {
      boardId: "flow",
      ops: [{ op: "add_node", id: "db", type: "database", label: "DB" }],
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/Op #0 \(add_node\) failed: Node type "database" isn't valid on a flowchart board/);

    const missing = await call("gabiro_get_board", { boardId: "nope" });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/No board "nope". Existing boards: flow\./);
  });

  it("updates, re-lays out, exports and deletes", async () => {
    const { call, text } = await connect();
    await call("gabiro_create_board", { title: "Checkout", kind: "architecture", ops: CHECKOUT_OPS });
    expect((await call("gabiro_update_board", { boardId: "checkout", direction: "TB" })).structuredContent).toMatchObject({ revision: 2 });
    expect((await call("gabiro_auto_layout", { boardId: "checkout", force: true })).structuredContent).toMatchObject({ revision: 3 });

    const exported = await call("gabiro_export", { boardId: "checkout", format: "markdown", write: true });
    expect(text(exported)).toMatch(/^Wrote docs[/\\]diagrams[/\\]checkout\.md/);

    const deleted = await call("gabiro_delete_board", { boardId: "checkout" });
    expect(deleted.structuredContent).toEqual({ boardId: "checkout", deleted: true });
    expect(text(await call("gabiro_list_boards"))).toMatch(/No boards yet/);
  });

  it("opens the canvas for a board, starting it through the canvas access", async () => {
    const { canvas, opened } = fakeCanvas();
    const { call, text } = await connect(canvas);
    await call("gabiro_create_board", { title: "Checkout", kind: "architecture", ops: CHECKOUT_OPS });
    const r = await call("gabiro_open_board", { boardId: "checkout" });
    expect(r.structuredContent).toEqual({ url: "http://127.0.0.1:4477/b/checkout", opened: true });
    expect(text(r)).toBe("Opened http://127.0.0.1:4477/b/checkout in the browser.");
    expect(opened).toEqual(["http://127.0.0.1:4477/b/checkout"]);

    const missing = await call("gabiro_open_board", { boardId: "nope" });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/No board "nope"/);
  });

  it("links the live canvas in create/apply results only when it is running", async () => {
    const off = await connect();
    const quiet = await off.call("gabiro_create_board", { title: "Checkout", kind: "architecture", ops: CHECKOUT_OPS });
    expect(quiet.structuredContent).not.toHaveProperty("canvasUrl");

    const on = await connect(fakeCanvas("http://127.0.0.1:4480").canvas);
    const created = await on.call("gabiro_create_board", { title: "Checkout", kind: "architecture", ops: CHECKOUT_OPS });
    expect(created.structuredContent).toMatchObject({ canvasUrl: "http://127.0.0.1:4480/b/checkout" });
    expect(on.text(created)).toContain("Canvas: http://127.0.0.1:4480/b/checkout");
    const changed = await on.call("gabiro_apply_changes", {
      boardId: "checkout",
      ops: [{ op: "add_node", id: "cache", type: "cache", label: "Redis" }],
    });
    expect(changed.structuredContent).toMatchObject({ canvasUrl: "http://127.0.0.1:4480/b/checkout" });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/mcp`
Expected: FAIL: type error / `CanvasAccess` not exported; `gabiro_open_board` missing from the tool list.

- [ ] **Step 3: Implement**

The tools import only `../server/launcher.js`, never the server barrel, so the MCP process doesn't load `ws`.

`src/mcp/tools.ts`:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GabiroError, KINDS, SlugSchema, summarizeBoard, type Board } from "../core/index.js";
import { canvasUrl, ensureCanvasServer, openInBrowser } from "../server/launcher.js";
import type { BoardService } from "../service/index.js";
import { OPS_HELP } from "./help.js";

/** How the tools reach the canvas. Injected so tests don't spawn servers or browsers. */
export interface CanvasAccess {
  /** URL of the running canvas (for a board), or undefined if none is running. */
  url(root: string, boardId?: string): Promise<string | undefined>;
  /** Base URL of the canvas, starting it if needed. */
  ensure(root: string): Promise<string>;
  /** Tries to open a URL in the user's browser. */
  open(url: string): boolean;
}

export const defaultCanvas: CanvasAccess = {
  url: canvasUrl,
  ensure: (root) => ensureCanvasServer(root),
  open: openInBrowser,
};

type Payload = { text: string; data: Record<string, unknown> };

/** Runs a tool body; expected errors become isError results the agent can act on. */
async function run(body: () => Promise<Payload>): Promise<CallToolResult> {
  try {
    const { text, data } = await body();
    return { content: [{ type: "text", text }], structuredContent: data };
  } catch (err) {
    const message = err instanceof GabiroError ? err.message : `Unexpected error: ${(err as Error).message ?? String(err)}`;
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

const counts = (b: Board) => ({ nodes: b.nodes.length, edges: b.edges.length, groups: b.groups.length });

function changeReport(board: Board, before?: Board): Payload {
  const after = counts(board);
  let text = `Board "${board.id}" is at revision ${board.revision}: ${after.nodes} nodes, ${after.edges} edges, ${after.groups} groups.`;
  if (before) {
    const prev = counts(before);
    const delta = (["nodes", "edges", "groups"] as const)
      .map((k) => ({ k, d: after[k] - prev[k] }))
      .filter(({ d }) => d !== 0)
      .map(({ k, d }) => `${d > 0 ? "+" : ""}${d} ${k}`);
    if (delta.length) text += ` Change: ${delta.join(", ")}.`;
  }
  return { text, data: { boardId: board.id, revision: board.revision, ...after } };
}

/** Appends a non-fatal auto-export warning to a payload, when there is one. */
function withExportWarning(payload: Payload, exportWarning?: string): Payload {
  if (!exportWarning) return payload;
  return {
    text: `${payload.text} Saved, but auto-export failed: ${exportWarning}`,
    data: { ...payload.data, exportWarning },
  };
}

/** Adds the live canvas link for a board when the canvas server is running. */
async function withCanvasUrl(payload: Payload, url: string | undefined): Promise<Payload> {
  if (!url) return payload;
  return { text: `${payload.text}\nCanvas: ${url}`, data: { ...payload.data, canvasUrl: url } };
}

const opsParam = z.array(z.object({ op: z.string() }).passthrough()).describe(OPS_HELP);
const boardIdParam = SlugSchema.describe('Board id, e.g. "checkout-architecture" (see gabiro_list_boards)');

export function registerTools(server: McpServer, service: BoardService, canvas: CanvasAccess = defaultCanvas): void {
  server.registerTool(
    "gabiro_list_boards",
    {
      title: "List boards",
      description: "List all diagram boards in this project with id, title, kind, node count and last update.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      run(async () => {
        const boards = await service.list();
        const text = boards.length
          ? boards
              .map((b) => `${b.id} "${b.title}" kind=${b.kind} nodes=${b.nodeCount} updated=${b.updatedAt}${b.error ? ` ERROR: ${b.error}` : ""}`)
              .join("\n")
          : "No boards yet. Create one with gabiro_create_board.";
        return { text, data: { boards } };
      }),
  );

  server.registerTool(
    "gabiro_create_board",
    {
      title: "Create board",
      description:
        "Create a diagram board, optionally with its full content in one call via ops. Nodes are auto-laid out. " +
        "Kinds: architecture (services, databases, queues…), flowchart (steps/decisions), sequence (ordered messages), " +
        "erd (entities with fields), mindmap (topics), freeform (sticky notes), kanban (columns and cards).",
      inputSchema: {
        title: z.string().min(1).max(200).describe('Human title, e.g. "Checkout – Architecture"'),
        kind: z.enum(KINDS).describe("Diagram kind; decides which node/edge/group types are allowed"),
        id: SlugSchema.optional().describe("Board id; defaults to a slug of the title"),
        direction: z.enum(["LR", "TB"]).optional().describe("Layout direction: LR (left→right, default) or TB (top→bottom, default for flowchart)"),
        ops: opsParam.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ title, kind, id, direction, ops }) =>
      run(async () => {
        const result = await service.create({ title, kind, id, direction, ops });
        const report = await withCanvasUrl(changeReport(result.board), await canvas.url(service.root, result.board.id));
        return withExportWarning({ text: `${report.text}\n\n${summarizeBoard(result.board)}`, data: report.data }, result.exportWarning);
      }),
  );

  server.registerTool(
    "gabiro_get_board",
    {
      title: "Get board",
      description:
        'Read a board. format "summary" (default) is a compact one-line-per-item view; "json" is the full board including positions; "mermaid" is the diagram source.',
      inputSchema: {
        boardId: boardIdParam,
        format: z.enum(["summary", "json", "mermaid"]).default("summary"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ boardId, format }) =>
      run(async () => {
        if (format === "mermaid") {
          const { content } = await service.export(boardId, "mermaid");
          const board = await service.get(boardId);
          return { text: content, data: { boardId, revision: board.revision, format } };
        }
        const board = await service.get(boardId);
        if (format === "json") return { text: JSON.stringify(board, null, 2), data: { board } };
        return { text: summarizeBoard(board), data: { boardId, revision: board.revision, format } };
      }),
  );

  server.registerTool(
    "gabiro_apply_changes",
    {
      title: "Apply changes",
      description:
        "Add, update or remove nodes, edges and groups on a board in one atomic batch. On error nothing changes and the message names the failing op. New nodes are auto-laid out; nodes the user moved (pinned) stay put.",
      inputSchema: {
        boardId: boardIdParam,
        ops: opsParam,
        expectedRevision: z
          .number()
          .int()
          .optional()
          .describe("Revision you last saw. If the board changed since (e.g. the user edited it), the call fails instead of overwriting."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    ({ boardId, ops, expectedRevision }) =>
      run(async () => {
        const before = await service.get(boardId);
        const result = await service.applyChanges(boardId, ops, expectedRevision);
        const report = await withCanvasUrl(changeReport(result.board, before), await canvas.url(service.root, boardId));
        return withExportWarning(report, result.exportWarning);
      }),
  );

  server.registerTool(
    "gabiro_update_board",
    {
      title: "Update board",
      description: "Rename a board or change its layout direction (changing direction re-lays out unpinned nodes).",
      inputSchema: {
        boardId: boardIdParam,
        title: z.string().min(1).max(200).optional(),
        direction: z.enum(["LR", "TB"]).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ boardId, title, direction }) =>
      run(async () => {
        const result = await service.updateBoard(boardId, { title, direction });
        return withExportWarning(changeReport(result.board), result.exportWarning);
      }),
  );

  server.registerTool(
    "gabiro_auto_layout",
    {
      title: "Auto-layout",
      description: "Re-run automatic layout. Pinned nodes (moved by the user) keep their place unless force is true.",
      inputSchema: {
        boardId: boardIdParam,
        force: z.boolean().default(false).describe("Also move pinned nodes and unpin them"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ boardId, force }) =>
      run(async () => {
        const result = await service.autoLayout(boardId, force);
        return withExportWarning(changeReport(result.board), result.exportWarning);
      }),
  );

  server.registerTool(
    "gabiro_export",
    {
      title: "Export board",
      description:
        'Export a board as Mermaid or Markdown. With write=true the file is saved under the export dir (default docs/diagrams). Boards are also auto-exported to <exportDir>/<id>.md on every change unless disabled in .gabiro/config.json.',
      inputSchema: {
        boardId: boardIdParam,
        format: z.enum(["mermaid", "markdown"]),
        write: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ boardId, format, write }) =>
      run(async () => {
        const { content, path } = await service.export(boardId, format, write);
        return { text: path ? `Wrote ${path}\n\n${content}` : content, data: { boardId, format, ...(path ? { path } : {}) } };
      }),
  );

  server.registerTool(
    "gabiro_open_board",
    {
      title: "Open canvas",
      description:
        "Show a board (or the board list) in the live browser canvas, starting the local canvas server if needed. The canvas updates live as boards change.",
      inputSchema: { boardId: boardIdParam.optional().describe("Board to show; omit for the list of boards") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ boardId }) =>
      run(async () => {
        if (boardId) await service.get(boardId);
        const base = await canvas.ensure(service.root);
        const url = boardId ? `${base}/b/${boardId}` : base;
        const opened = canvas.open(url);
        const text = opened ? `Opened ${url} in the browser.` : `The canvas is running at ${url} — open it in a browser.`;
        return { text, data: { url, opened } };
      }),
  );

  server.registerTool(
    "gabiro_delete_board",
    {
      title: "Delete board",
      description: "Delete a board and its auto-exported Markdown file. It remains recoverable from git history if committed.",
      inputSchema: { boardId: boardIdParam },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ boardId }) =>
      run(async () => {
        await service.delete(boardId);
        return { text: `Deleted board "${boardId}".`, data: { boardId, deleted: true } };
      }),
  );
}
```

`src/mcp/server.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BoardService } from "../service/index.js";
import { VERSION } from "../version.js";
import { SERVER_INSTRUCTIONS } from "./help.js";
import { defaultCanvas, registerTools, type CanvasAccess } from "./tools.js";

export function createMcpServer(root: string, canvas: CanvasAccess = defaultCanvas): McpServer {
  const server = new McpServer({ name: "gabiro", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, new BoardService(root), canvas);
  return server;
}

export async function runStdioServer(root: string): Promise<void> {
  const server = createMcpServer(root);
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; logs go to stderr.
  console.error(`gabiro MCP server ${VERSION} running on stdio (project root: ${root})`);
}
```

`src/mcp/help.ts`:

```ts
import { KIND_RULES, KINDS } from "../core/index.js";

const kindLines = KINDS.map((k) => {
  const r = KIND_RULES[k];
  const nodes = r.nodeTypes.filter((t) => t !== "sticky").join("|");
  const edges = r.edgeTypes.join("|") || "none";
  const groups = r.groupTypes.join("|") || "none";
  return `- ${k}: nodes ${nodes}; edges ${edges}; groups ${groups}`;
}).join("\n");

/** Shared reference text for the ops parameter. Generated from KIND_RULES so it never drifts. */
export const OPS_HELP = `Ordered list of changes, applied atomically (all or nothing). Later ops may reference ids created by earlier ones.
Each op is an object with "op" and these fields:
- add_node {id, type, label, description?, tech?, groupId?, tags?, color?, order?, fields?: [{name, type, pk?, fk?, nullable?}]}
- update_node {id, ...fields to change}  (null clears a field)
- remove_node {id}  (also removes its edges)
- add_edge {from, to, type, id?, label?, order?, style?: "solid"|"dashed", cardinality?: "1-1"|"1-n"|"n-n"}  (id defaults to "from->to")
- update_edge {id, ...fields} (from/to can't change: remove the edge and add a new one) / remove_edge {id}
- add_group {id, label, type, parentId?} / update_group {id, ...fields} / remove_group {id, cascade?}
Ids are lowercase slugs like "orders-db". Don't send positions; the layout engine places nodes.
Allowed types by board kind ("sticky" notes are allowed on every kind):
${kindLines}
Kind-specific: ERD entities take "fields" and relations take "cardinality"; sequence messages need "order" (1,2,3…), style "dashed" for replies; kanban cards need groupId (their column) and "order".`;

export const SERVER_INSTRUCTIONS = `Gabiro draws software diagrams (architecture, flowchart, sequence, erd, mindmap, freeform, kanban) as boards stored in the project under .gabiro/boards, with Mermaid exports in docs/diagrams.
Workflow: call gabiro_list_boards to reuse existing boards; build a new diagram in ONE gabiro_create_board call with all ops; refine with gabiro_apply_changes, passing the revision you last saw as expectedRevision.
Use gabiro_get_board (format "summary") to re-read a board, because the user may have edited it. Record open questions and risks as "sticky" nodes.
When the user wants to see a diagram, call gabiro_open_board to show it in the live canvas.`;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/mcp && npx tsc --noEmit && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts src/mcp/server.ts src/mcp/help.ts test/mcp/tools.test.ts
git commit -m "feat(mcp): gabiro_open_board and live canvas links in results" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

### Task 6: Web: board-to-React-Flow mapping (pure)

**Files:**
- Create: `web/tsconfig.json`
- Create: `web/src/toFlow.ts`
- Test: `test/web/toFlow.test.ts`

All geometry decisions live here, so they're unit-testable without a browser:
- Group boxes wrap their contents, and outer boxes sit underneath.
- Kanban columns sit in fixed lanes, and empty columns are drawn too.
- Sequence lifelines grow with the number of messages.
- An edge uses its ELK route when the route still starts and ends on its boxes; otherwise it falls back to `smoothstep`.
- `changedIds` ignores layout-only differences, so a re-layout doesn't highlight everything.

- [ ] **Step 1: Write the failing test**

`test/web/toFlow.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyOps, type Board } from "../../src/core/index.js";
import { layoutBoard, nodeSize } from "../../src/layout/index.js";
import { changedIds, MESSAGE_GAP, toFlow } from "../../web/src/toFlow.js";
import { FIXTURES } from "../fixtures/boards.js";

const laid = (b: Board) => layoutBoard(b);

type Box = { position: { x: number; y: number }; width?: number; height?: number };
function contains(outer: Box, inner: Box): boolean {
  return (
    outer.position.x <= inner.position.x &&
    outer.position.y <= inner.position.y &&
    outer.position.x + outer.width! >= inner.position.x + inner.width! &&
    outer.position.y + outer.height! >= inner.position.y + inner.height!
  );
}

describe("toFlow", () => {
  it("maps nodes to shape components at their board positions and sizes", async () => {
    const board = await laid(FIXTURES.architecture);
    const { nodes } = toFlow(board);
    const api = nodes.find((n) => n.id === "api")!;
    const source = board.nodes.find((n) => n.id === "api")!;
    expect(api).toMatchObject({ type: "shape", position: source.position, ...nodeSize(source), draggable: false });
    expect(api.data).toMatchObject({ node: source, kind: "architecture", changed: false });
  });

  it("draws groups as boxes that enclose their nodes and nested groups, outer boxes underneath", async () => {
    const { nodes } = toFlow(await laid(FIXTURES.architecture));
    const backend = nodes.find((n) => n.id === "group:backend")!;
    const data = nodes.find((n) => n.id === "group:data")!;
    for (const id of ["api", "events"]) expect(contains(backend, nodes.find((n) => n.id === id)!)).toBe(true);
    expect(contains(data, nodes.find((n) => n.id === "orders-db")!)).toBe(true);
    expect(contains(backend, data)).toBe(true);
    expect(backend.zIndex).toBeLessThan(data.zIndex!);
    expect(data.zIndex).toBeLessThan(nodes.find((n) => n.id === "api")!.zIndex!);
  });

  it("styles edges: dashed + animated for async, labels, arrows except on mind maps and ERDs", async () => {
    const { edges } = toFlow(await laid(FIXTURES.architecture));
    const async = edges.find((e) => e.id === "api->events")!;
    expect(async).toMatchObject({ animated: true, label: "order.created", style: { strokeDasharray: "6 4" } });
    expect(edges.find((e) => e.id === "web->api")).toMatchObject({ label: "HTTPS", markerEnd: { type: "arrowclosed" } });
    expect(toFlow(await laid(FIXTURES.mindmap)).edges[0]!.markerEnd).toBeUndefined();
    expect(toFlow(await laid(FIXTURES.erd)).edges[0]).toMatchObject({ label: "places (1:n)", markerEnd: undefined });
  });

  it("draws edges along the layout's route, falling back to smoothstep when a node moved off it", async () => {
    const board = await laid(FIXTURES.flowchart);
    const routed = toFlow(board).edges.find((e) => e.id === "valid->end")!;
    expect(routed.type).toBe("routed");
    expect((routed.data as { points: unknown[] }).points).toEqual(board.edges.find((e) => e.id === "valid->end")!.points);

    const moved = applyOps(board, [{ op: "update_node", id: "end", position: { x: 900, y: 900 } }]);
    expect(toFlow(moved).edges.find((e) => e.id === "valid->end")!.type).toBe("smoothstep");
  });

  it("renders sequence messages as ordered horizontal message edges below tall lifelines", async () => {
    const { nodes, edges } = toFlow(await laid(FIXTURES.sequence));
    expect(edges.map((e) => [e.id, e.type])).toEqual([
      ["m1", "message"],
      ["m2", "message"],
      ["m3", "message"],
    ]);
    const ys = edges.map((e) => (e.data as { y: number }).y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(edges[2]!.data).toMatchObject({ dashed: true, label: "201 Created" });
    const client = nodes.find((n) => n.id === "client")!;
    expect(client.type).toBe("participant");
    expect(client.height).toBeGreaterThan(ys.at(-1)! + MESSAGE_GAP / 2);
  });

  it("draws every kanban column, including empty ones, around its cards", async () => {
    const board = await laid(applyOps(FIXTURES.kanban, [{ op: "add_group", id: "later", label: "Later", type: "column" }]));
    const { nodes } = toFlow(board);
    const todo = nodes.find((n) => n.id === "group:todo")!;
    for (const id of ["core", "mcp"]) expect(contains(todo, nodes.find((n) => n.id === id)!)).toBe(true);
    const later = nodes.find((n) => n.id === "group:later")!;
    expect(later.position.x).toBeGreaterThan(todo.position.x);
    expect(later.height).toBeGreaterThan(0);
  });

  it("flags changed nodes and edges", async () => {
    const board = await laid(FIXTURES.architecture);
    const { nodes, edges } = toFlow(board, new Set(["api", "web->api"]));
    expect((nodes.find((n) => n.id === "api")!.data as { changed: boolean }).changed).toBe(true);
    expect(edges.find((e) => e.id === "web->api")!.className).toBe("gb-flash");
  });
});

describe("changedIds", () => {
  it("returns ids of added or modified nodes and edges, nothing for a first load", async () => {
    const before = await laid(FIXTURES.architecture);
    const after = applyOps(before, [
      { op: "update_node", id: "api", label: "Checkout API v2" },
      { op: "add_node", id: "cache", type: "cache", label: "Redis" },
      { op: "add_edge", from: "api", to: "cache", type: "sync" },
    ]);
    expect([...changedIds(before, after)].sort()).toEqual(["api", "api->cache", "cache"]);
    expect(changedIds(undefined, after).size).toBe(0);
  });

  it("ignores layout-only differences (positions, pins, routes)", async () => {
    const before = await laid(FIXTURES.architecture);
    const relaid = await layoutBoard(applyOps(before, [{ op: "update_node", id: "api", position: { x: 1, y: 1 }, pinned: true }]), "force");
    expect(changedIds(before, relaid).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/web`
Expected: FAIL: cannot resolve `../../web/src/toFlow.js`.

- [ ] **Step 3: Implement**

`web/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": []
  },
  "include": ["src"]
}
```

`web/src/toFlow.ts`:

```ts
import type { Edge, Node } from "@xyflow/react";
import type { Board, BoardEdge, BoardGroup, BoardNode, Position } from "../../src/core/index.js";
import { nodeSize } from "../../src/layout/sizes.js";

/** Vertical distance between sequence messages, and the space above the first one. */
export const MESSAGE_GAP = 50;
const HEADER = 60;
const GROUP_PAD = 24;
const GROUP_LABEL = 32;
const KANBAN_COLUMN = { stride: 280, inset: 10, width: 260, minHeight: 200 };

export interface ShapeData extends Record<string, unknown> {
  node: BoardNode;
  kind: Board["kind"];
  direction: Board["layout"]["direction"];
  changed: boolean;
}
export interface GroupData extends Record<string, unknown> {
  group: BoardGroup;
}
export interface MessageData extends Record<string, unknown> {
  y: number;
  label: string;
  dashed: boolean;
  changed: boolean;
}

export interface RoutedData extends Record<string, unknown> {
  points: Position[];
}

export interface Flow {
  nodes: Node[];
  edges: Edge[];
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const rectOf = (n: BoardNode): Rect => ({ ...(n.position ?? { x: 0, y: 0 }), ...nodeSize(n) });

function union(rects: Rect[]): Rect | undefined {
  if (!rects.length) return undefined;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** Rectangles for groups: kanban columns sit in fixed lanes; other groups wrap their contents. */
function groupRects(board: Board): Map<string, Rect> {
  const rects = new Map<string, Rect>();
  if (board.kind === "kanban") {
    board.groups.forEach((col, i) => {
      const cards = board.nodes.filter((n) => n.groupId === col.id).map(rectOf);
      const bottom = Math.max(KANBAN_COLUMN.minHeight, ...cards.map((r) => r.y + r.height + GROUP_PAD));
      rects.set(col.id, { x: i * KANBAN_COLUMN.stride + KANBAN_COLUMN.inset, y: 0, width: KANBAN_COLUMN.width, height: bottom });
    });
    return rects;
  }
  const visit = (g: BoardGroup): Rect | undefined => {
    if (rects.has(g.id)) return rects.get(g.id);
    const inner = union([
      ...board.nodes.filter((n) => n.groupId === g.id).map(rectOf),
      ...board.groups.filter((c) => c.parentId === g.id).map(visit).filter((r): r is Rect => !!r),
    ]);
    if (!inner) return undefined;
    const rect = {
      x: inner.x - GROUP_PAD,
      y: inner.y - GROUP_PAD - GROUP_LABEL,
      width: inner.width + GROUP_PAD * 2,
      height: inner.height + GROUP_PAD * 2 + GROUP_LABEL,
    };
    rects.set(g.id, rect);
    return rect;
  };
  board.groups.forEach(visit);
  return rects;
}

function depth(board: Board, g: BoardGroup): number {
  let d = 0;
  for (let p = g.parentId; p; p = board.groups.find((x) => x.id === p)?.parentId) d++;
  return d;
}

const within = (p: Position, r: Rect, slack = 2) =>
  p.x >= r.x - slack && p.x <= r.x + r.width + slack && p.y >= r.y - slack && p.y <= r.y + r.height + slack;

/** The layout's route, if it still starts on the source box and ends on the target box. */
function usableRoute(e: BoardEdge, rects: Map<string, Rect>): Position[] | undefined {
  const [first, last] = [e.points?.[0], e.points?.at(-1)];
  const [from, to] = [rects.get(e.from), rects.get(e.to)];
  return first && last && from && to && within(first, from) && within(last, to) ? e.points : undefined;
}

const byOrder = (a: BoardEdge, b: BoardEdge) => (a.order ?? 0) - (b.order ?? 0) || (a.id < b.id ? -1 : 1);

function isDashed(e: BoardEdge): boolean {
  return e.style === "dashed" || (e.style === undefined && e.type === "async");
}

function edgeLabel(e: BoardEdge): string | undefined {
  if (e.cardinality) {
    const card = e.cardinality.replace("-", ":");
    return e.label ? `${e.label} (${card})` : card;
  }
  return e.label;
}

/**
 * Converts a board into React Flow nodes and edges. Pure: positions come from the board
 * (already laid out by the server), sizes from the shared nodeSize table.
 * `changed` marks ids to highlight because they changed in the latest update.
 */
export function toFlow(board: Board, changed: ReadonlySet<string> = new Set()): Flow {
  const messages = board.kind === "sequence" ? board.edges.filter((e) => e.type === "message").sort(byOrder) : [];
  const lifeline = HEADER + (messages.length + 1) * MESSAGE_GAP;

  const groups: Node[] = [];
  const rects = groupRects(board);
  for (const g of board.groups) {
    const r = rects.get(g.id);
    if (!r) continue;
    groups.push({
      id: `group:${g.id}`,
      type: "group-box",
      position: { x: r.x, y: r.y },
      width: r.width,
      height: r.height,
      data: { group: g } satisfies GroupData,
      zIndex: depth(board, g),
      draggable: false,
      selectable: false,
    });
  }

  const nodes: Node[] = board.nodes.map((n) => {
    const size = nodeSize(n);
    const type = n.type === "entity" ? "entity" : n.type === "participant" ? "participant" : "shape";
    return {
      id: n.id,
      type,
      position: n.position ?? { x: 0, y: 0 },
      width: size.width,
      height: n.type === "participant" ? lifeline : size.height,
      data: { node: n, kind: board.kind, direction: board.layout.direction, changed: changed.has(n.id) } satisfies ShapeData,
      zIndex: 100,
      draggable: false,
    };
  });

  const nodeRects = new Map(board.nodes.map((n) => [n.id, rectOf(n)]));
  const edges: Edge[] =
    board.kind === "sequence"
      ? messages.map((e, i) => ({
          id: e.id,
          source: e.from,
          target: e.to,
          type: "message",
          data: { y: HEADER + (i + 1) * MESSAGE_GAP, label: e.label ?? "", dashed: isDashed(e), changed: changed.has(e.id) } satisfies MessageData,
          zIndex: 200,
        }))
      : board.edges.map((e) => {
          const route = usableRoute(e, nodeRects);
          return {
          id: e.id,
          source: e.from,
          target: e.to,
          type: route ? "routed" : board.kind === "mindmap" ? "default" : "smoothstep",
          ...(route ? { data: { points: route } satisfies RoutedData } : {}),
          label: edgeLabel(e),
          animated: e.type === "async",
          className: changed.has(e.id) ? "gb-flash" : undefined,
          style: isDashed(e) ? { strokeDasharray: "6 4" } : undefined,
          markerEnd: board.kind === "mindmap" || board.kind === "erd" ? undefined : { type: "arrowclosed" as const },
          zIndex: 200,
          };
        });

  return { nodes: [...groups, ...nodes], edges };
}

/** JSON of an entity without layout-only fields, so a re-layout alone doesn't count as a change. */
function meaning(entity: object): string {
  const { position: _p, pinned: _pin, points: _pts, ...rest } = entity as Record<string, unknown>;
  return JSON.stringify(rest);
}

/** Ids of nodes and edges whose content differs between two revisions of a board (layout moves ignored). */
export function changedIds(before: Board | undefined, after: Board): Set<string> {
  const out = new Set<string>();
  if (!before) return out;
  const prevNodes = new Map(before.nodes.map((n) => [n.id, meaning(n)]));
  const prevEdges = new Map(before.edges.map((e) => [e.id, meaning(e)]));
  for (const n of after.nodes) if (prevNodes.get(n.id) !== meaning(n)) out.add(n.id);
  for (const e of after.edges) if (prevEdges.get(e.id) !== meaning(e)) out.add(e.id);
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/web && npx tsc --noEmit && npx tsc --noEmit -p web`
Expected: 9 tests pass; both typechecks clean.

- [ ] **Step 5: Commit**

```bash
git add web/tsconfig.json web/src/toFlow.ts test/web/toFlow.test.ts
git commit -m "feat(web): map boards to React Flow nodes and edges" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

### Task 7: Web: the canvas app and its build

**Files:**
- Create: `vite.config.ts`
- Create: `web/index.html`
- Create: `web/src/live.ts`
- Create: `web/src/hooks.ts`
- Create: `web/src/nodes.tsx`
- Create: `web/src/BoardView.tsx`
- Create: `web/src/BoardList.tsx`
- Create: `web/src/App.tsx`
- Create: `web/src/main.tsx`
- Create: `web/src/styles.css`
- Modify: `package.json`

The canvas is read-only: nodes aren't draggable or connectable. It uses `colorMode="system"` plus CSS variables for light and dark. The minimap appears only on boards with more than 12 nodes, because on small boards it covers content.

- [ ] **Step 1: Add the Vite config and switch the scripts**

`vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The canvas web app lives in web/ and is built into dist/web, which `gabiro serve` serves.
// `npm run dev:web` serves it with hot reload and proxies the API to a running `gabiro serve`.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4477",
      "/ws": { target: "ws://127.0.0.1:4477", ws: true },
    },
  },
});
```

`package.json`:

```json
{
  "name": "gabiro",
  "version": "0.1.0",
  "description": "Agent-first diagram canvas: MCP tools for architecture, flow, sequence, ERD, mind map, freeform and kanban boards",
  "type": "module",
  "license": "MIT",
  "bin": {
    "gabiro": "dist/cli.js"
  },
  "files": [
    "dist"
  ],
  "engines": {
    "node": ">=20.19"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json && vite build",
    "typecheck": "tsc --noEmit && tsc --noEmit -p web",
    "test": "vitest run",
    "dev:web": "vite"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.1",
    "elkjs": "^0.12.0",
    "ws": "^8.21.3",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@types/node": "^22.20.4",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@types/ws": "^8.18.1",
    "@vitejs/plugin-react": "^6.1.1",
    "@xyflow/react": "^12.12.0",
    "playwright-core": "^1.63.0",
    "react": "^19.3.0",
    "react-dom": "^19.3.0",
    "typescript": "~5.9.3",
    "vite": "^8.3.1",
    "vitest": "^5.0.2"
  }
}
```

- [ ] **Step 2: Add the app**

`web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>gabiro</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/src/live.ts`:

```ts
import type { ClientMessage, ServerMessage } from "../../src/server/protocol.js";

type Listener = (msg: ServerMessage) => void;
type StatusListener = (connected: boolean) => void;

/** WebSocket connection to the canvas server that re-subscribes and reconnects with backoff. */
export class LiveClient {
  private ws?: WebSocket;
  private readonly subscriptions: ClientMessage[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly statusListeners = new Set<StatusListener>();
  private closed = false;
  private attempt = 0;

  constructor(private readonly url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`) {
    this.connect();
  }

  private connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      for (const sub of this.subscriptions) ws.send(JSON.stringify(sub));
      this.statusListeners.forEach((l) => l(true));
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as ServerMessage;
      this.listeners.forEach((l) => l(msg));
    };
    ws.onclose = () => {
      this.statusListeners.forEach((l) => l(false));
      if (!this.closed) setTimeout(() => this.connect(), Math.min(5000, 250 * 2 ** this.attempt++));
    };
  }

  subscribe(msg: ClientMessage): void {
    this.subscriptions.push(msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
```

`web/src/hooks.ts`:

```ts
import { useEffect, useState } from "react";
import type { Board } from "../../src/core/index.js";
import type { BoardListItem } from "../../src/store/store.js";
import { LiveClient } from "./live.js";
import { changedIds } from "./toFlow.js";

const FLASH_MS = 1500;

export interface LiveBoard {
  board?: Board;
  /** Set when the board can't be shown as-is (missing, corrupt); the last good board stays visible. */
  error?: { code: string; message: string };
  changed: Set<string>;
  connected: boolean;
}

/** Subscribes to one board and keeps the latest snapshot, plus which ids just changed. */
export function useLiveBoard(boardId: string): LiveBoard {
  const [state, setState] = useState<LiveBoard>({ changed: new Set(), connected: false });

  useEffect(() => {
    const client = new LiveClient();
    client.subscribe({ type: "subscribe", boardId });
    const offStatus = client.onStatus((connected) => setState((s) => ({ ...s, connected })));
    const offMessage = client.onMessage((msg) => {
      if (msg.type === "board" && msg.board.id === boardId) {
        setState((s) => ({ ...s, board: msg.board, error: undefined, changed: changedIds(s.board, msg.board) }));
      } else if (msg.type === "board-error" && msg.boardId === boardId) {
        setState((s) => ({ ...s, error: { code: msg.code, message: msg.message } }));
      }
    });
    return () => {
      offStatus();
      offMessage();
      client.close();
    };
  }, [boardId]);

  useEffect(() => {
    if (!state.changed.size) return;
    const timer = setTimeout(() => setState((s) => ({ ...s, changed: new Set() })), FLASH_MS);
    return () => clearTimeout(timer);
  }, [state.changed]);

  return state;
}

/** Subscribes to the list of boards. `undefined` until the first list arrives. */
export function useLiveBoards(): BoardListItem[] | undefined {
  const [boards, setBoards] = useState<BoardListItem[]>();
  useEffect(() => {
    const client = new LiveClient();
    client.subscribe({ type: "subscribe-list" });
    const off = client.onMessage((msg) => {
      if (msg.type === "boards") setBoards(msg.boards);
    });
    return () => {
      off();
      client.close();
    };
  }, []);
  return boards;
}
```

`web/src/nodes.tsx`:

```tsx
import { BaseEdge, Handle, Position, type EdgeProps, type NodeProps, type Node, type Edge } from "@xyflow/react";
import type { GroupData, MessageData, RoutedData, ShapeData } from "./toFlow.js";

/** Invisible connection points; edges are drawn by the server's data, not by the user (read-only canvas). */
function Handles({ direction }: { direction: "LR" | "TB" }) {
  const [target, source] = direction === "LR" ? [Position.Left, Position.Right] : [Position.Top, Position.Bottom];
  return (
    <>
      <Handle type="target" position={target} isConnectable={false} className="gb-handle" />
      <Handle type="source" position={source} isConnectable={false} className="gb-handle" />
    </>
  );
}

const flash = (changed: boolean) => (changed ? " gb-flash" : "");

export function ShapeNode({ data }: NodeProps<Node<ShapeData>>) {
  const { node, direction, changed } = data;
  return (
    <div className={`gb-node gb-${node.type}${flash(changed)}`} title={node.description}>
      <Handles direction={direction} />
      <div className="gb-label">{node.label}</div>
      {node.tech && <div className="gb-tech">{node.tech}</div>}
      {node.type === "sticky" && node.description && <div className="gb-desc">{node.description}</div>}
    </div>
  );
}

export function EntityNode({ data }: NodeProps<Node<ShapeData>>) {
  const { node, direction, changed } = data;
  return (
    <div className={`gb-entity${flash(changed)}`}>
      <Handles direction={direction} />
      <div className="gb-entity-title">{node.label}</div>
      {(node.fields ?? []).map((f) => (
        <div key={f.name} className="gb-field">
          <span className="gb-field-name">
            {f.name}
            {f.nullable ? "?" : ""}
          </span>
          <span className="gb-field-type">{f.type}</span>
          <span className="gb-field-keys">{[f.pk && "PK", f.fk && "FK"].filter(Boolean).join(" ")}</span>
        </div>
      ))}
    </div>
  );
}

export function ParticipantNode({ data }: NodeProps<Node<ShapeData>>) {
  const { node, changed } = data;
  return (
    <div className="gb-participant">
      <Handle type="target" position={Position.Top} isConnectable={false} className="gb-handle" />
      <Handle type="source" position={Position.Top} isConnectable={false} className="gb-handle" />
      <div className={`gb-participant-head${flash(changed)}`}>{node.label}</div>
      <div className="gb-lifeline" />
    </div>
  );
}

export function GroupBox({ data }: NodeProps<Node<GroupData>>) {
  return (
    <div className={`gb-group gb-group-${data.group.type}`}>
      <div className="gb-group-label">{data.group.label}</div>
    </div>
  );
}

/** A sequence message: a horizontal arrow between two lifelines at its row's height. */
export function MessageEdge({ id, sourceX, sourceY, targetX, data }: EdgeProps<Edge<MessageData>>) {
  if (!data) return null;
  const y = sourceY + data.y;
  const self = Math.abs(sourceX - targetX) < 1;
  const dir = targetX >= sourceX ? 1 : -1;
  const path = self
    ? `M ${sourceX} ${y} h 40 v 20 h -40`
    : `M ${sourceX} ${y} L ${targetX - dir * 8} ${y}`;
  const tipX = self ? sourceX : targetX;
  const tipY = self ? y + 20 : y;
  const tipDir = self ? -1 : dir;
  const head = `${tipX},${tipY} ${tipX - tipDir * 9},${tipY - 5} ${tipX - tipDir * 9},${tipY + 5}`;
  const labelX = self ? sourceX + 48 : (sourceX + targetX) / 2;
  return (
    <g className={`gb-message${data.changed ? " gb-flash" : ""}`} data-id={id}>
      <path d={path} fill="none" strokeDasharray={data.dashed ? "6 4" : undefined} />
      <polygon points={head} />
      <text x={labelX} y={self ? y + 4 : y - 7} textAnchor={self ? "start" : "middle"}>
        {data.label}
      </text>
    </g>
  );
}

/** An edge drawn along the route the layout engine computed, so it goes around boxes instead of through them. */
export function RoutedEdge({ data, markerEnd, style, label, labelStyle, labelBgStyle }: EdgeProps<Edge<RoutedData>>) {
  const points = data?.points ?? [];
  if (points.length < 2) return null;
  const path = points.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ");
  const mid = Math.floor((points.length - 1) / 2);
  const [a, b] = [points[mid]!, points[mid + 1]!];
  return (
    <BaseEdge
      path={path}
      markerEnd={markerEnd}
      style={style}
      label={label}
      labelX={(a.x + b.x) / 2}
      labelY={(a.y + b.y) / 2}
      labelStyle={labelStyle}
      labelBgStyle={labelBgStyle}
      labelShowBg
      labelBgPadding={[4, 2]}
    />
  );
}

export const nodeTypes = { shape: ShapeNode, entity: EntityNode, participant: ParticipantNode, "group-box": GroupBox };
export const edgeTypes = { message: MessageEdge, routed: RoutedEdge };
```

`web/src/BoardView.tsx`:

```tsx
import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { useMemo } from "react";
import { useLiveBoard } from "./hooks.js";
import { edgeTypes, nodeTypes } from "./nodes.js";
import { toFlow } from "./toFlow.js";

/** Small boards fit on screen; a minimap would only cover part of them. */
const MINIMAP_MIN_NODES = 12;

export function BoardView({ boardId }: { boardId: string }) {
  const { board, error, changed, connected } = useLiveBoard(boardId);
  const flow = useMemo(() => (board ? toFlow(board, changed) : undefined), [board, changed]);

  return (
    <div className="gb-page">
      <header className="gb-header">
        <a href="/" className="gb-back">
          ← Boards
        </a>
        <h1>{board?.title ?? boardId}</h1>
        {board && (
          <span className="gb-meta">
            {board.kind} · revision {board.revision}
          </span>
        )}
        <span className={`gb-status ${connected ? "on" : "off"}`} title={connected ? "Live" : "Reconnecting…"}>
          {connected ? "● live" : "○ reconnecting"}
        </span>
      </header>
      {error && (
        <div className="gb-banner" role="alert">
          <strong>{error.code === "NOT_FOUND" ? "This board no longer exists." : "This board can't be loaded."}</strong>{" "}
          {error.message}
          {board && " Showing the last good version."}
        </div>
      )}
      <main className="gb-canvas">
        {flow ? (
          <ReactFlowProvider>
            <ReactFlow
              nodes={flow.nodes}
              edges={flow.edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              nodesDraggable={false}
              nodesConnectable={false}
              edgesFocusable={false}
              colorMode="system"
              fitView
              minZoom={0.1}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={24} />
              <Controls showInteractive={false} />
              {flow.nodes.length > MINIMAP_MIN_NODES && <MiniMap pannable zoomable />}
            </ReactFlow>
          </ReactFlowProvider>
        ) : (
          !error && <p className="gb-empty">Loading…</p>
        )}
      </main>
    </div>
  );
}
```

`web/src/BoardList.tsx`:

```tsx
import { useLiveBoards } from "./hooks.js";

export function BoardList() {
  const boards = useLiveBoards();
  return (
    <div className="gb-page">
      <header className="gb-header">
        <h1>gabiro</h1>
        <span className="gb-meta">boards in this project</span>
      </header>
      <main className="gb-list">
        {boards === undefined && <p className="gb-empty">Loading…</p>}
        {boards?.length === 0 && (
          <p className="gb-empty">
            No boards yet. Ask your agent to create one, e.g. “Map this repo’s architecture as a gabiro board.”
          </p>
        )}
        <ul>
          {boards?.map((b) => (
            <li key={b.id} className={b.error ? "gb-list-error" : undefined}>
              <a href={`/b/${b.id}`}>
                <span className="gb-list-title">{b.title}</span>
                <span className="gb-kind">{b.kind}</span>
                <span className="gb-list-meta">
                  {b.error ? b.error : `${b.nodeCount} nodes · updated ${new Date(b.updatedAt).toLocaleString()}`}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
```

`web/src/App.tsx`:

```tsx
import { BoardList } from "./BoardList.js";
import { BoardView } from "./BoardView.js";

/** Two routes, resolved from the URL: "/" lists boards, "/b/<id>" shows one. */
export function App() {
  const match = /^\/b\/([^/]+)\/?$/.exec(window.location.pathname);
  return match ? <BoardView boardId={decodeURIComponent(match[1]!)} /> : <BoardList />;
}
```

`web/src/main.tsx`:

```tsx
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`web/src/styles.css`:

```css
:root {
  --bg: #f7f7f5;
  --surface: #ffffff;
  --text: #1d1d1f;
  --muted: #6b6b70;
  --stroke: #c9c9cf;
  --accent: #3b6fe0;
  --flash: rgba(59, 111, 224, 0.45);
  --group: rgba(59, 111, 224, 0.06);
  --group-stroke: rgba(59, 111, 224, 0.35);
  --sticky: #fff4b8;
  --sticky-stroke: #e3cf6a;
  --danger-bg: #fdecea;
  --danger: #a4231b;
  --t-client: #eef1f6;
  --t-gateway: #ecebfb;
  --t-service: #e8f0fe;
  --t-function: #f3e8fd;
  --t-database: #e6f4ea;
  --t-cache: #fdeaea;
  --t-queue: #fef1e0;
  --t-storage: #e3f5f3;
  --t-decision: #fff1d6;
  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141416;
    --surface: #1f1f23;
    --text: #ececef;
    --muted: #9a9aa2;
    --stroke: #3d3d45;
    --accent: #7ea2ff;
    --flash: rgba(126, 162, 255, 0.55);
    --group: rgba(126, 162, 255, 0.07);
    --group-stroke: rgba(126, 162, 255, 0.4);
    --sticky: #4a4220;
    --sticky-stroke: #7a6c2c;
    --danger-bg: #3b1a17;
    --danger: #ffb4ab;
    --t-client: #262a31;
    --t-gateway: #2a2840;
    --t-service: #1f2a40;
    --t-function: #33243f;
    --t-database: #1e3326;
    --t-cache: #3d2224;
    --t-queue: #3d2e1b;
    --t-storage: #1b3533;
    --t-decision: #3d321a;
    color-scheme: dark;
  }
}

* {
  box-sizing: border-box;
}
html,
body,
#root {
  height: 100%;
  margin: 0;
}
body {
  background: var(--bg);
  color: var(--text);
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
}
a {
  color: var(--accent);
  text-decoration: none;
}

/* page chrome */
.gb-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.gb-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--stroke);
  background: var(--surface);
  flex-wrap: wrap;
}
.gb-header h1 {
  font-size: 16px;
  margin: 0;
}
.gb-meta,
.gb-status {
  color: var(--muted);
  font-size: 12px;
}
.gb-status {
  margin-left: auto;
}
.gb-status.on {
  color: #2e9e5b;
}
.gb-banner {
  padding: 8px 16px;
  background: var(--danger-bg);
  color: var(--danger);
  font-size: 13px;
}
.gb-canvas {
  flex: 1;
  min-height: 0;
}
.gb-empty {
  color: var(--muted);
  padding: 24px 16px;
}

/* board list */
.gb-list {
  max-width: 760px;
  width: 100%;
  margin: 0 auto;
  padding: 16px;
}
.gb-list ul {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 8px;
}
.gb-list a {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2px 12px;
  padding: 12px 14px;
  border: 1px solid var(--stroke);
  border-radius: 10px;
  background: var(--surface);
  color: var(--text);
}
.gb-list a:hover {
  border-color: var(--accent);
}
.gb-list-title {
  font-weight: 600;
}
.gb-kind {
  font-size: 12px;
  color: var(--accent);
}
.gb-list-meta {
  grid-column: 1 / -1;
  color: var(--muted);
  font-size: 12px;
}
.gb-list-error .gb-list-meta {
  color: var(--danger);
}

/* nodes */
.gb-handle {
  opacity: 0;
  pointer-events: none;
}
.gb-node {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 2px;
  padding: 8px 10px;
  text-align: center;
  background: var(--surface);
  border: 1.5px solid var(--stroke);
  border-radius: 8px;
  color: var(--text);
  overflow: hidden;
}
.gb-label {
  font-weight: 600;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.gb-tech {
  font-size: 11px;
  color: var(--muted);
}
.gb-desc {
  font-size: 12px;
  color: var(--muted);
  text-align: left;
}
.gb-client {
  background: var(--t-client);
  border-radius: 999px;
}
.gb-gateway {
  background: var(--t-gateway);
  border-radius: 4px 4px 18px 18px;
}
.gb-service {
  background: var(--t-service);
}
.gb-function {
  background: var(--t-function);
  border-style: dashed;
}
.gb-database,
.gb-cache,
.gb-storage {
  border-radius: 50% / 16%;
}
.gb-database {
  background: var(--t-database);
}
.gb-cache {
  background: var(--t-cache);
}
.gb-storage {
  background: var(--t-storage);
}
.gb-queue {
  background: var(--t-queue);
  border-left-width: 6px;
  border-right-width: 6px;
}
.gb-external {
  border-style: dashed;
  border-radius: 24px;
  background: transparent;
}
.gb-start,
.gb-end,
.gb-topic {
  border-radius: 999px;
}
.gb-start,
.gb-end {
  background: var(--t-client);
}
.gb-decision {
  border: none;
  background: var(--t-decision);
  clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
  padding: 20px 28px;
}
.gb-io {
  background: var(--t-queue);
  clip-path: polygon(10% 0, 100% 0, 90% 100%, 0 100%);
  border: none;
}
.gb-subprocess {
  border-left-width: 5px;
  border-right-width: 5px;
  border-style: double;
}
.gb-sticky {
  background: var(--sticky);
  border-color: var(--sticky-stroke);
  border-radius: 2px;
  align-items: flex-start;
  justify-content: flex-start;
  text-align: left;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.12);
}
.gb-text {
  background: transparent;
  border: none;
}
.gb-card {
  border-left: 4px solid var(--accent);
  align-items: flex-start;
  text-align: left;
}

/* ERD entity */
.gb-entity {
  width: 100%;
  height: 100%;
  background: var(--surface);
  border: 1.5px solid var(--stroke);
  border-radius: 8px;
  overflow: hidden;
  font-size: 12px;
}
.gb-entity-title {
  font-weight: 600;
  padding: 10px;
  height: 44px;
  background: var(--t-service);
  border-bottom: 1px solid var(--stroke);
}
.gb-field {
  display: grid;
  grid-template-columns: 1fr auto 28px;
  gap: 6px;
  height: 26px;
  align-items: center;
  padding: 0 10px;
}
.gb-field-type {
  color: var(--muted);
}
.gb-field-keys {
  color: var(--accent);
  font-weight: 600;
  font-size: 10px;
}

/* sequence */
.gb-participant {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.gb-participant-head {
  width: 100%;
  height: 60px;
  display: grid;
  place-items: center;
  font-weight: 600;
  background: var(--t-service);
  border: 1.5px solid var(--stroke);
  border-radius: 8px;
}
.gb-lifeline {
  flex: 1;
  border-left: 1.5px dashed var(--stroke);
}
.gb-message path {
  stroke: var(--text);
  stroke-width: 1.5;
}
.gb-message polygon {
  fill: var(--text);
}
.gb-message text {
  fill: var(--text);
  font-size: 12px;
}

/* groups */
.gb-group {
  width: 100%;
  height: 100%;
  background: var(--group);
  border: 1.5px solid var(--group-stroke);
  border-radius: 12px;
}
.gb-group-boundary,
.gb-group-frame {
  border-style: dashed;
}
.gb-group-lane {
  border-radius: 0;
}
.gb-group-column {
  background: var(--surface);
  border-color: var(--stroke);
}
.gb-group-label {
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

/* highlight what just changed */
@keyframes gb-flash {
  from {
    box-shadow: 0 0 0 6px var(--flash);
  }
  to {
    box-shadow: 0 0 0 0 transparent;
  }
}
.gb-flash {
  animation: gb-flash 1.4s ease-out;
}
.react-flow__edge.gb-flash path,
g.gb-message.gb-flash path {
  stroke: var(--accent);
}
```

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck && npm run build && ls dist/web dist/web/assets`
Expected: both typechecks clean; `dist/web/index.html` plus one `.js` and one `.css` in `dist/web/assets` (about 130 KB of JS gzipped).

- [ ] **Step 4: Check it by hand**

```bash
node --input-type=module -e '
import { BoardService } from "./dist/service/index.js";
import { startCanvasServer } from "./dist/server/index.js";
const root = "/tmp/gabiro-try";
const flow = [
  { op: "add_node", id: "start", type: "start", label: "Start" },
  { op: "add_node", id: "ok", type: "decision", label: "Valid?" },
  { op: "add_node", id: "work", type: "step", label: "Work" },
  { op: "add_node", id: "done", type: "end", label: "Done" },
  { op: "add_edge", from: "start", to: "ok", type: "flow" },
  { op: "add_edge", from: "ok", to: "work", type: "flow", label: "yes" },
  { op: "add_edge", from: "ok", to: "done", type: "flow", label: "no" },
  { op: "add_edge", from: "work", to: "done", type: "flow" },
];
await new BoardService(root).create({ title: "Try", kind: "flowchart", ops: flow }).catch(() => {});
const server = await startCanvasServer({ root });
console.log(`${server.url}/b/try`);
'
```

Open the printed URL. Expected: the flowchart, with the "no" branch routed around the Work step, a "● live" indicator in the header, and no errors in the browser console. Stop it with Ctrl-C. (Task 8 adds the `gabiro serve` command.)

- [ ] **Step 5: Commit**

```bash
git add vite.config.ts package.json web/index.html web/src/live.ts web/src/hooks.ts web/src/nodes.tsx web/src/BoardView.tsx web/src/BoardList.tsx web/src/App.tsx web/src/main.tsx web/src/styles.css
git commit -m "feat(web): live canvas app with shapes for every board kind" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

### Task 8: `gabiro serve`, end-to-end tests, README

**Files:**
- Modify: `src/cli.ts`
- Create: `test/e2e/browser.ts`
- Test: `test/e2e/canvas.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write the failing end-to-end tests**

`test/e2e/browser.ts`:

```ts
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

/**
 * A Chromium binary for browser tests: $GABIRO_CHROMIUM, the preinstalled /opt/pw-browsers/chromium,
 * or one installed by `npx playwright install chromium`. Undefined means browser tests are skipped.
 */
export function findChromium(): string | undefined {
  const candidates = [process.env.GABIRO_CHROMIUM, "/opt/pw-browsers/chromium"];
  try {
    candidates.push(chromium.executablePath());
  } catch {
    // playwright-core has no bundled browser registry entry; fine.
  }
  return candidates.find((p): p is string => !!p && existsSync(p));
}
```

`test/e2e/canvas.test.ts`:

```ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";
import { startCanvasServer } from "../../src/server/index.js";
import { BoardService } from "../../src/service/index.js";
import { tempRoot } from "../helpers.js";
import { findChromium } from "./browser.js";

const dist = fileURLToPath(new URL("../../dist/", import.meta.url));
const cli = join(dist, "cli.js");
const webDir = join(dist, "web");
const built = existsSync(cli) && existsSync(join(webDir, "index.html"));
const chromiumPath = findChromium();

async function health(url: string) {
  return (await fetch(`${url}/api/health`)).json() as Promise<{ ok: boolean; root: string; pid: number }>;
}

describe.skipIf(!built)("canvas end-to-end (run `npm run build` first)", () => {
  it("`gabiro serve` prints its URL, serves the app, and cleans up on SIGTERM", async () => {
    const root = await tempRoot();
    const child = spawn(process.execPath, [cli, "serve", "--root", root, "--port", "0"]);
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        const m = /running at (http:\/\/\S+)/.exec(chunk.toString());
        if (m) resolve(m[1]!);
      });
      child.once("exit", (code) => reject(new Error(`serve exited early with ${code}`)));
    });
    expect(await health(url)).toMatchObject({ ok: true, root });
    expect(await (await fetch(`${url}/b/anything`)).text()).toContain('<div id="root">');
    const exited = new Promise<number | null>((r) => child.once("exit", r));
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(existsSync(join(root, ".gabiro/server.json"))).toBe(false);
  }, 20_000);

  it("gabiro_open_board starts a detached canvas server for the project", async () => {
    const root = await tempRoot();
    const client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, "mcp", "--root", root],
        env: { ...(process.env as Record<string, string>), GABIRO_NO_BROWSER: "1" },
      }),
    );
    let pid: number | undefined;
    try {
      await client.callTool({ name: "gabiro_create_board", arguments: { title: "Shop", kind: "architecture" } });
      const r = (await client.callTool({ name: "gabiro_open_board", arguments: { boardId: "shop" } })) as CallToolResult;
      expect(r.isError).toBeFalsy();
      const { url, opened } = r.structuredContent as { url: string; opened: boolean };
      expect(opened).toBe(false);
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/b\/shop$/);
      const info = JSON.parse(await readFile(join(root, ".gabiro/server.json"), "utf8"));
      pid = info.pid;
      expect(await health(info.url)).toMatchObject({ ok: true, root });

      const again = (await client.callTool({ name: "gabiro_open_board", arguments: {} })) as CallToolResult;
      expect((again.structuredContent as { url: string }).url).toBe(info.url);
    } finally {
      await client.close();
      if (pid) process.kill(pid, "SIGTERM");
    }
  }, 30_000);

  it.skipIf(!chromiumPath)("the browser canvas renders a board and shows agent changes live", async () => {
    const root = await tempRoot();
    const svc = new BoardService(root);
    await svc.create({
      title: "Checkout",
      kind: "architecture",
      ops: [
        { op: "add_node", id: "web", type: "client", label: "Web App" },
        { op: "add_node", id: "api", type: "service", label: "Checkout API" },
        { op: "add_edge", from: "web", to: "api", type: "sync", label: "HTTPS" },
      ],
    });
    const server = await startCanvasServer({ root, port: 0, webDir, recordInfo: false });
    const browser = await chromium.launch({ executablePath: chromiumPath });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${server.url}/b/checkout`);
      await page.getByText("Checkout API").waitFor();
      await page.getByText("● live").waitFor();
      expect(await page.locator(".react-flow__node").count()).toBe(2);

      await svc.applyChanges("checkout", [
        { op: "add_node", id: "cache", type: "cache", label: "Redis Cache" },
        { op: "add_edge", from: "api", to: "cache", type: "sync" },
      ]);
      await page.getByText("Redis Cache").waitFor({ timeout: 5000 });
      expect(await page.locator(".gb-flash").count()).toBeGreaterThan(0);
      await page.getByText("revision 2").waitFor();

      await page.goto(`${server.url}/`);
      await page.getByText("Checkout").first().waitFor();
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await server.close();
    }
  }, 30_000);
});
```

- [ ] **Step 2: Build and run them to verify they fail**

Run: `npm run build && npx vitest run test/e2e/canvas.test.ts`
Expected: FAIL: the `serve` test ("serve exited early with 1", because `serve` isn't a command yet) and the `gabiro_open_board` test (the spawned server never becomes healthy, so it fails with UNAVAILABLE). The browser test may already pass: it starts the server in-process.

- [ ] **Step 3: Implement `gabiro serve`**

`src/cli.ts`:

```ts
#!/usr/bin/env node
import { resolve } from "node:path";
import { runStdioServer } from "./mcp/server.js";
import { DEFAULT_PORT, openInBrowser, startCanvasServer } from "./server/index.js";
import { VERSION } from "./version.js";

const USAGE = `gabiro ${VERSION}

Usage:
  gabiro mcp [--root <dir>]                       Run the MCP server over stdio
  gabiro serve [--root <dir>] [--port <n>] [--open] Run the live canvas (default port ${DEFAULT_PORT})

The project root defaults to the current directory.

Add to Claude Code:
  claude mcp add gabiro -- npx -y gabiro mcp`;

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (args.includes("--root") && option(args, "--root") === undefined) {
    console.error("--root needs a directory");
    process.exitCode = 1;
    return;
  }
  const root = resolve(option(args, "--root") ?? process.cwd());
  switch (command) {
    case "mcp":
      await runStdioServer(root);
      return;
    case "serve": {
      const portArg = option(args, "--port");
      const port = portArg === undefined ? DEFAULT_PORT : Number(portArg);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        console.error(`--port needs a number between 0 and 65535 (got "${portArg}")`);
        process.exitCode = 1;
        return;
      }
      const server = await startCanvasServer({ root, port });
      console.log(`gabiro canvas running at ${server.url} (project root: ${root})`);
      if (args.includes("--open")) openInBrowser(server.url);
      const stop = () => void server.close().then(() => process.exit(0));
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      return;
    }
    case "--version":
    case "-v":
      console.log(VERSION);
      return;
    default:
      console.error(USAGE);
      process.exitCode = command === undefined || command === "--help" || command === "-h" ? 0 : 1;
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 4: Build and run the tests to verify they pass**

Run: `npm run build && npx vitest run test/e2e && npm test && npm run typecheck`
Expected: all end-to-end tests pass, the browser test included when Chromium is found. Full suite: 17 files, 121 tests. Afterwards, `pgrep -af "cli.js serve"` shows no leftover servers.

- [ ] **Step 5: Update the README**

`README.md`:

````markdown
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

The canvas updates live as the agent changes a board, and highlights what just changed. The same diagrams are in `docs/diagrams/<board>.md`, which renders on GitHub and in VS Code's Markdown preview.

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
````

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts test/e2e/browser.ts test/e2e/canvas.test.ts README.md
git commit -m "feat(cli): gabiro serve; canvas end-to-end tests; README" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

### Task 9: Try it with a real agent

**Files:**

- [ ] **Step 1: Wire it into a sample project**

```bash
mkdir -p /tmp/gabiro-demo && cd /tmp/gabiro-demo && git init -q
claude mcp add gabiro -- node <absolute path to repo>/dist/cli.js mcp
```

- [ ] **Step 2: Ask the agent to draw and open a board**

Prompt: "Using gabiro, draw the architecture of a checkout system (web client, API gateway, checkout service, orders Postgres, Redis cache, Kafka events, Stripe; backend services in a zone) and open it in the canvas."

Expected: one `gabiro_create_board` call, then `gabiro_open_board`. The browser shows the board with routed edges. Then ask "add a fraud-check service between checkout and Stripe". The canvas updates without a reload, and the new node flashes.

- [ ] **Step 3: Note any rough edges**

Record anything confusing in the agent's tool use or the canvas rendering. Fix tool wording in `src/mcp/help.ts` / `src/mcp/tools.ts` if needed, then commit:

```bash
git add src/mcp
git commit -m "docs(mcp): clarify tool descriptions from canvas trial" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

---

## Deferred to Plan 3 (manual editing)
The following move to Plan 3:
- Dragging, with nodes pinned where you drop them.
- Rename by double-clicking.
- A type palette on the toolbar.
- Drawing edges between handles.
- Deleting with the Delete key.
- A side panel for description, tech, fields and tags.
- Undo/redo.
- `POST /api/boards/:id/ops` with `expectedRevision`.
- Re-applying the user's edit once after a revision conflict.
