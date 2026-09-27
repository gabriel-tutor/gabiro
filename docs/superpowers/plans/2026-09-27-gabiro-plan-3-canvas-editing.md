# Gabiro Plan 3: Manual Editing in the Canvas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user edit boards directly in the live canvas: drag, add from a palette, rename, connect, delete, edit details in a side panel, undo/redo, and auto-layout. Every edit is saved through the same core `applyOps` the agent uses, and the edits must be safe against cross-site requests.

**Architecture:**
- **Two new endpoints.** The canvas server gets `POST /api/boards/:id/ops` (apply ops, with an optional `expectedRevision`) and `POST /api/boards/:id/layout` (re-run auto-layout). Both refuse cross-site requests: a foreign `Origin` gets 403, and bodies must be `application/json`.
- **Pure gesture logic.** The browser turns gestures into ops with pure, unit-tested helpers (`web/src/edits.ts`). Undo and redo come from diffing boards (`diffOps`).
- **Optimistic edits.** A `useEditor` hook shows each edit immediately, then saves it. On a revision conflict it re-applies the edit once; on failure it reverts and shows a message.
- **Two server fixes from Plan 2's review land first:** a `ws` `'error'` listener with a smaller `maxPayload`, and a cap on `--idle-exit`.

Spec: `docs/superpowers/specs/2026-09-25-gabiro-design.md` §6 (manual editing) and §7.

**Tech Stack:** Existing (TypeScript ESM, Zod, elkjs, MCP SDK, `ws`, React 19, `@xyflow/react` 12, Vite 8, Vitest, `playwright-core`). No new dependencies.

**Verified:** Every code block here was compiled and run before the plan was written:
- 23 test files, 182 tests pass.
- The server and web typechecks are clean, and `npm run build` is warning-free.
- A real-Chromium editing test covering every gesture passes 3 times in a row.
- Screenshots of the editing UI in light and dark mode were reviewed.

Four problems found during that verification are fixed in this plan's code:
- A new palette node was dropped on top of an existing one; it now cascades to a free spot.
- React Flow only connects when you release on a handle; releasing on a node's body now connects too.
- The side panel lost focus when a snapshot arrived; fields now follow the board except while you type in them.
- Undoing a drag left `pinned: false` instead of clearing it; `pinned` now accepts `null`.

**Starting point:** the Plan 2 branch as reviewed: 19 test files, 140 tests passing.

---

## File structure

```
src/core/ops.ts              update_node: pinned accepts null (clears the pin, needed by undo)
src/server/canvas-server.ts  + POST /api/boards/:id/ops and /layout (Origin + JSON-only), ws 'error' listener, maxPayload 64 KB
src/server/index.ts          exports MAX_OPS_BODY
src/cli.ts                   --idle-exit capped at 35000 minutes (setTimeout limit)
web/src/edits.ts             pure: uniqueId, freeSpot, addNodeOps, connectOps, moveOps, deleteOps, diffOps
web/src/history.ts           EditHistory: undo/redo stacks
web/src/api.ts               postOps / postLayout / submitOps (re-apply once on conflict)
web/src/useEditor.ts         optimistic edits + undo/redo on top of the live board
web/src/toFlow.ts            editable option (draggable/selectable/deletable/connectable); groups never deletable
web/src/nodes.tsx            connectable handles (visible on hover); participant draw handles
web/src/Toolbar.tsx          type palette for the board kind, Undo, Redo, Auto-layout
web/src/SidePanel.tsx        node/edge details form (label, type, group/column, tech, description, tags, ERD fields; edge label/type/line/cardinality/order)
web/src/BoardView.tsx        controlled React Flow wired to the editor; drop-on-node connect; keyboard undo/redo; toasts
web/src/styles.css, web/index.html (data: favicon), vite.config.ts (chunk warning 800 KB)
test/server/edits.test.ts, test/web/{edits,history-api}.test.ts, test/e2e/editing.test.ts; updated test/core/ops, test/web/toFlow, test/e2e/cli
README.md                    "Edit in the canvas"
```

Conventions: the same as Plans 1–2. Web code imports only browser-safe shared modules: `src/core/*`, `src/layout/sizes.ts`, `src/server/protocol.ts` and `src/store/store.ts`. Commit trailer:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ
```

---

### Task 1: Core: `pinned: null` clears a pin

**Files:**
- Modify: `src/core/ops.ts`
- Modify (test): `test/core/ops.test.ts`

Undo of a drag must restore "not pinned". Without this, it can only set `pinned: false`, which leaves an extra key in the board.

- [ ] **Step 1: Write the failing test**

Complete updated test file. It adds "clears a pin with pinned: null".

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

  it("clears a pin with pinned: null", () => {
    const pinned = applyOps(empty(), [{ op: "add_node", id: "a", type: "service", label: "A", position: { x: 1, y: 2 }, pinned: true }]);
    const b = applyOps(pinned, [{ op: "update_node", id: "a", pinned: null }]);
    expect(b.nodes[0]).toEqual({ id: "a", type: "service", label: "A", position: { x: 1, y: 2 } });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/core/ops.test.ts`
Expected: FAIL: `Op #0 is malformed at "pinned"` (null isn't accepted yet).

- [ ] **Step 3: Implement**

In `NodePatch`, `pinned` becomes nullable like the other optional fields. Complete file:

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
  pinned: nullable(z.boolean()),
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

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/core && npx tsc --noEmit && npm test`
Expected: all pass (19 files, 141 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/ops.ts test/core/ops.test.ts
git commit -m "feat(core): pinned: null clears a pin" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

### Task 2: Server: edit endpoints and the Plan 2 hardening follow-ups

**Files:**
- Modify: `src/server/canvas-server.ts`
- Modify: `src/server/index.ts`
- Modify: `src/cli.ts`
- Create (test): `test/server/edits.test.ts`
- Modify (test): `test/e2e/cli.test.ts`

How cross-site requests are refused:
- The Host check (Plan 2) blocks DNS rebinding.
- A foreign `Origin` gets 403.
- Only `application/json` bodies are accepted. Browsers can't send those cross-site without a CORS preflight, and this server never answers preflights with CORS headers.

Limits and conflicts:
- Bodies over 256 KB get 413, and at most 500 ops are accepted per request.
- On a CONFLICT (stale `expectedRevision`), the 409 response includes the latest board, so the canvas can re-apply the edit without a second round trip.

Hardening:
- A `ws` `'error'` listener and a 64 KB `maxPayload` stop a protocol-violating frame from a local client from crashing the process.
- `--idle-exit` above 35000 minutes is rejected, because `setTimeout` overflows at 2^31-1 ms.

- [ ] **Step 1: Write the failing tests**

`test/server/edits.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_OPS_BODY, startCanvasServer, type CanvasServer } from "../../src/server/index.js";
import { BoardService } from "../../src/service/index.js";
import { tempRoot } from "../helpers.js";

const servers: CanvasServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function setup() {
  const root = await tempRoot();
  const svc = new BoardService(root);
  await svc.create({
    title: "Shop",
    kind: "architecture",
    ops: [
      { op: "add_node", id: "web", type: "client", label: "Web" },
      { op: "add_node", id: "api", type: "service", label: "API" },
      { op: "add_edge", from: "web", to: "api", type: "sync" },
    ],
  });
  const server = await startCanvasServer({ root, port: 0, webDir: root, recordInfo: false });
  servers.push(server);
  return { root, svc, server };
}

/** POSTs a raw body with explicit headers (node:http, so Origin and Content-Type are fully controlled). */
function post(port: number, path: string, body: string, headers: Record<string, string>) {
  return new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : {} }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const json = (port: number) => ({ "content-type": "application/json", origin: `http://127.0.0.1:${port}` });

describe("POST /api/boards/:id/ops", () => {
  it("applies ops, saves the board and returns the new revision", async () => {
    const { root, server } = await setup();
    const res = await post(
      server.port,
      "/api/boards/shop/ops",
      JSON.stringify({ ops: [{ op: "update_node", id: "api", position: { x: 500, y: 40 }, pinned: true }], expectedRevision: 1 }),
      json(server.port),
    );
    expect(res.status).toBe(200);
    expect(res.json.board).toMatchObject({ revision: 2 });
    const saved = JSON.parse(await readFile(join(root, ".gabiro/boards/shop.json"), "utf8"));
    expect(saved.nodes.find((n: { id: string }) => n.id === "api")).toMatchObject({ position: { x: 500, y: 40 }, pinned: true });
  });

  it("answers a stale revision with 409 and the latest board", async () => {
    const { svc, server } = await setup();
    await svc.applyChanges("shop", [{ op: "add_node", id: "db", type: "database", label: "DB" }]);
    const res = await post(
      server.port,
      "/api/boards/shop/ops",
      JSON.stringify({ ops: [{ op: "update_node", id: "api", label: "API v2" }], expectedRevision: 1 }),
      json(server.port),
    );
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: "CONFLICT", board: { revision: 2 } });
  });

  it("returns validation errors with the op index, and 404 for unknown boards", async () => {
    const { server } = await setup();
    const bad = await post(
      server.port,
      "/api/boards/shop/ops",
      JSON.stringify({ ops: [{ op: "add_node", id: "x", type: "step", label: "X" }] }),
      json(server.port),
    );
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/^Op #0 \(add_node\) failed/);
    const missing = await post(server.port, "/api/boards/nope/ops", JSON.stringify({ ops: [{ op: "remove_node", id: "a" }] }), json(server.port));
    expect(missing.status).toBe(404);
  });

  it("rejects malformed requests before touching the board", async () => {
    const { server } = await setup();
    const url = "/api/boards/shop/ops";
    expect((await post(server.port, url, "{nope", json(server.port))).status).toBe(400);
    expect((await post(server.port, url, JSON.stringify({ ops: [] }), json(server.port))).json.error).toMatch(/non-empty array/);
    expect((await post(server.port, url, JSON.stringify({ ops: [{ op: "x" }], expectedRevision: "1" }), json(server.port))).status).toBe(400);
    const huge = JSON.stringify({ ops: [{ op: "update_node", id: "api", description: "x".repeat(MAX_OPS_BODY) }] });
    expect((await post(server.port, url, huge, json(server.port))).status).toBe(413);
  });

  it("refuses cross-site edits: foreign Origin (403) and non-JSON bodies (415)", async () => {
    const { root, server } = await setup();
    const body = JSON.stringify({ ops: [{ op: "remove_node", id: "api" }] });
    const foreign = await post(server.port, "/api/boards/shop/ops", body, { "content-type": "application/json", origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    const form = await post(server.port, "/api/boards/shop/ops", body, {
      "content-type": "text/plain",
      origin: `http://127.0.0.1:${server.port}`,
    });
    expect(form.status).toBe(415);
    const saved = JSON.parse(await readFile(join(root, ".gabiro/boards/shop.json"), "utf8"));
    expect(saved.revision).toBe(1);
  });

  it("re-runs auto-layout on POST /layout, keeping pins unless forced", async () => {
    const { svc, server } = await setup();
    await svc.applyChanges("shop", [{ op: "update_node", id: "api", position: { x: 900, y: 900 }, pinned: true }]);
    const kept = await post(server.port, "/api/boards/shop/layout", "", json(server.port));
    expect(kept.status).toBe(200);
    const api = (b: unknown) => (b as { nodes: { id: string; position: unknown; pinned?: boolean }[] }).nodes.find((n) => n.id === "api")!;
    expect(api(kept.json.board)).toMatchObject({ position: { x: 900, y: 900 }, pinned: true });
    const forced = await post(server.port, "/api/boards/shop/layout", JSON.stringify({ force: true }), json(server.port));
    expect(api(forced.json.board).pinned).toBeUndefined();
    expect((await post(server.port, "/api/boards/shop/layout", JSON.stringify({ force: "yes" }), json(server.port))).status).toBe(400);
    const foreign = await post(server.port, "/api/boards/shop/layout", "", { "content-type": "application/json", origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
  });

  it("still refuses other write methods", async () => {
    const { server } = await setup();
    const res = await fetch(`${server.url}/api/boards/shop`, { method: "PUT", body: "{}" });
    expect(res.status).toBe(405);
  });
});

describe("WebSocket frame errors", () => {
  it("survives a protocol-violating frame from a local client", async () => {
    const { server } = await setup();
    const sock = connect(server.port, "127.0.0.1");
    await new Promise((r) => sock.once("connect", r));
    sock.write(
      [
        "GET /ws HTTP/1.1",
        `Host: 127.0.0.1:${server.port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );
    await new Promise((r) => sock.once("data", r));
    // An unmasked client frame is a protocol error ("MASK must be set").
    sock.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
    await new Promise((r) => sock.once("close", r));
    expect((await fetch(`${server.url}/api/health`)).status).toBe(200);
  });
});
```

`test/e2e/cli.test.ts`:

```ts
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

function run(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args]);
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

it.skipIf(!existsSync(cli))("prints an error and exits 1 when --root has no value", async () => {
  const { code, stderr } = await run(["mcp", "--root"]);
  expect(code).toBe(1);
  expect(stderr).toContain("--root needs a directory");
});

it.skipIf(!existsSync(cli))("rejects an --idle-exit longer than setTimeout can hold", async () => {
  const { code, stderr } = await run(["serve", "--port", "0", "--idle-exit", "36000"]);
  expect(code).toBe(1);
  expect(stderr).toContain("--idle-exit needs a number of minutes between 0 and 35000");
});
```

- [ ] **Step 2: Build and run them to verify they fail**

Run: `npm run build && npx vitest run test/server/edits.test.ts test/e2e/cli.test.ts`
Expected: FAIL:
- `MAX_OPS_BODY` is not exported (a type error).
- POSTs get 405.
- The unmasked-frame test reports an unhandled `RangeError: Invalid WebSocket frame: MASK must be set`.
- `--idle-exit 36000` is accepted.

- [ ] **Step 3: Implement**

Complete files:

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
import { parseClientMessage } from "./client-message.js";
import type { HealthResponse, ServerMessage } from "./protocol.js";
import { serveStatic } from "./static.js";
import { watchBoards } from "./watch.js";

export const DEFAULT_PORT = 4477;
const PORT_ATTEMPTS = 20;
/** Board subscriptions allowed per WebSocket; further subscribe messages are ignored. */
export const MAX_SUBSCRIPTIONS = 50;
/** Largest WebSocket frame accepted; clients only send tiny subscribe messages. */
export const MAX_WS_PAYLOAD = 64 * 1024;
/** Largest edit request body (POST /api/boards/:id/ops). */
export const MAX_OPS_BODY = 256 * 1024;
/** Most ops accepted in one edit request. */
export const MAX_OPS_PER_REQUEST = 500;

export interface CanvasServerOptions {
  root: string;
  /** First port to try; the next free port is used if it is taken. 0 picks any free port. */
  port?: number;
  host?: string;
  /** Directory with the built web app. Defaults to dist/web next to this module. */
  webDir?: string;
  /** Write .gabiro/server.json so MCP tools can find this server. Default true. */
  recordInfo?: boolean;
  /** Call `onIdle` after this many ms without any WebSocket client (including right after start). Off by default. */
  idleExitMs?: number;
  onIdle?: () => void;
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

/** Reads a request body up to `limit` bytes; resolves undefined when it is larger. */
function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(tooLarge ? undefined : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Validates the body of an edit request: `{ ops: object[], expectedRevision?: integer }`. */
function parseEditRequest(raw: string): { ops: unknown[]; expectedRevision?: number } | string {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return "The request body isn't valid JSON.";
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return 'Send a JSON object like {"ops": [...], "expectedRevision": 3}.';
  const { ops, expectedRevision } = body as Record<string, unknown>;
  if (!Array.isArray(ops) || ops.length === 0) return '"ops" must be a non-empty array of ops.';
  if (ops.length > MAX_OPS_PER_REQUEST) return `Send at most ${MAX_OPS_PER_REQUEST} ops per request.`;
  if (expectedRevision !== undefined && !Number.isInteger(expectedRevision)) return '"expectedRevision" must be an integer.';
  return { ops, expectedRevision: expectedRevision as number | undefined };
}

/** Validates the body of a layout request: `{ force?: boolean }` (an empty body means `{}`). */
function parseLayoutRequest(raw: string): { force: boolean } | string {
  if (raw.trim() === "") return { force: false };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return "The request body isn't valid JSON.";
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return 'Send a JSON object like {"force": false}.';
  const { force } = body as Record<string, unknown>;
  if (force !== undefined && typeof force !== "boolean") return '"force" must be true or false.';
  return { force: force === true };
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
  /** The bound port; set once listening. Host/Origin allowlists are tied to it. */
  let port = -1;

  // Only accept requests addressed to this loopback server, which blocks DNS rebinding,
  // and WebSocket upgrades from its own pages (or non-browser clients without an Origin).
  const allowedHosts = () => [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  const hostAllowed = (req: IncomingMessage) => req.headers.host !== undefined && allowedHosts().includes(req.headers.host);
  const originAllowed = (req: IncomingMessage) =>
    req.headers.origin === undefined || allowedHosts().some((h) => req.headers.origin === `http://${h}`);

  // requireHostHeader: false lets the Host check below answer a missing Host with the same 403.
  const http = createServer({ requireHostHeader: false }, (req, res) => {
    if (!hostAllowed(req)) {
      sendJson(res, 403, { code: "FORBIDDEN", error: `Unexpected Host header. Open the canvas at http://127.0.0.1:${port}.` });
      return;
    }
    handleHttp(req, res).catch((err) => sendJson(res, 500, { code: "INTERNAL", error: (err as Error).message }));
  });

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    const edit = /^\/api\/boards\/([^/]+)\/(ops|layout)$/.exec(pathname);
    if (edit && req.method === "POST") {
      await handleEdit(req, res, decodeURIComponent(edit[1]!), edit[2] as "ops" | "layout");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { code: "VALIDATION", error: "Use GET, or POST to /api/boards/<id>/ops to edit a board." });
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

  /**
   * POST /api/boards/:id/ops (apply ops) and /api/boards/:id/layout (re-run auto-layout) — the
   * canvas's edits. Cross-site requests are refused twice over: a foreign Origin gets 403, and only
   * application/json bodies are accepted (which browsers can't send cross-site without a CORS
   * preflight this server never approves).
   */
  async function handleEdit(req: IncomingMessage, res: ServerResponse, boardId: string, action: "ops" | "layout"): Promise<void> {
    if (!originAllowed(req)) {
      sendJson(res, 403, { code: "FORBIDDEN", error: "Edits are only accepted from the canvas page itself." });
      return;
    }
    if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      sendJson(res, 415, { code: "VALIDATION", error: "Send the edit as application/json." });
      return;
    }
    const raw = await readBody(req, MAX_OPS_BODY);
    if (raw === undefined) {
      sendJson(res, 413, { code: "VALIDATION", error: `The edit is larger than ${MAX_OPS_BODY / 1024} KB.` });
      return;
    }
    const parsed = action === "ops" ? parseEditRequest(raw) : parseLayoutRequest(raw);
    if (typeof parsed === "string") {
      sendJson(res, 400, { code: "VALIDATION", error: parsed });
      return;
    }
    try {
      const { board, exportWarning } =
        "ops" in parsed
          ? await service.applyChanges(boardId, parsed.ops, parsed.expectedRevision)
          : await service.autoLayout(boardId, parsed.force);
      sendJson(res, 200, { board, ...(exportWarning ? { exportWarning } : {}) });
    } catch (err) {
      if (!(err instanceof GabiroError)) throw err;
      // On a conflict, send the latest board so the canvas can re-apply its edit without another round trip.
      const latest = err.code === "CONFLICT" ? await service.get(boardId).catch(() => undefined) : undefined;
      sendJson(res, errorStatus(err.code), { code: err.code, error: err.message, ...(latest ? { board: latest } : {}) });
    }
  }

  // --- live updates -------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
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
    if (!hostAllowed(req) || !originAllowed(req)) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  // --- idle exit -----------------------------------------------------------
  let idleTimer: NodeJS.Timeout | undefined;
  const armIdle = () => {
    if (options.idleExitMs === undefined || idleTimer || boardSubs.size > 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      options.onIdle?.();
    }, options.idleExitMs);
  };
  const disarmIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  wss.on("connection", (ws) => {
    boardSubs.set(ws, new Set());
    disarmIdle();
    // Without an 'error' listener, a malformed or oversized frame would crash the process.
    ws.on("error", (err) => {
      console.error("gabiro canvas: closing a WebSocket after an error:", err.message);
      ws.terminate();
    });
    ws.on("close", () => {
      boardSubs.delete(ws);
      listSubs.delete(ws);
      armIdle();
    });
    ws.on("message", async (raw) => {
      try {
        const msg = parseClientMessage(raw.toString());
        if (msg?.type === "subscribe") {
          const ids = boardSubs.get(ws);
          if (!ids || (!ids.has(msg.boardId) && ids.size >= MAX_SUBSCRIPTIONS)) return;
          ids.add(msg.boardId);
          send(ws, await boardMessage(msg.boardId));
        } else if (msg?.type === "subscribe-list") {
          listSubs.add(ws);
          send(ws, { type: "boards", boards: await service.list() });
        }
      } catch (err) {
        console.error("gabiro canvas: failed to handle a WebSocket message:", err);
      }
    });
  });

  const stopWatching = watchBoards(join(root, ".gabiro", "boards"), async (boardId) => {
    try {
      const watchers = [...boardSubs].filter(([, ids]) => ids.has(boardId)).map(([ws]) => ws);
      if (watchers.length) {
        const msg = await boardMessage(boardId);
        for (const ws of watchers) send(ws, msg);
      }
      if (listSubs.size) {
        const msg: ServerMessage = { type: "boards", boards: await service.list() };
        for (const ws of listSubs) send(ws, msg);
      }
    } catch (err) {
      console.error(`gabiro canvas: failed to push changes to board "${boardId}":`, err);
    }
  });

  // --- listen, falling back to the next free port --------------------------
  const firstPort = options.port ?? DEFAULT_PORT;
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
  armIdle();

  return {
    url,
    port,
    async close() {
      disarmIdle();
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

`src/server/index.ts`:

```ts
export { startCanvasServer, DEFAULT_PORT, MAX_OPS_BODY, type CanvasServer, type CanvasServerOptions } from "./canvas-server.js";
export { canvasUrl, ensureCanvasServer, isLocalCanvasUrl, openInBrowser } from "./launcher.js";
export { readServerInfo, type ServerInfo } from "./info.js";
export type { ClientMessage, ServerMessage, HealthResponse } from "./protocol.js";
```

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
  gabiro serve [--root <dir>] [--port <n>] [--open] [--idle-exit <minutes>]
                                                  Run the live canvas (default port ${DEFAULT_PORT});
                                                  --idle-exit stops it after that long with no open canvas

The project root defaults to the current directory.

Add to Claude Code:
  claude mcp add gabiro -- npx -y gabiro mcp`;

/** setTimeout overflows above 2^31-1 ms (about 35,791 minutes). */
const MAX_IDLE_MINUTES = 35_000;

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
      const idleArg = option(args, "--idle-exit");
      const idleMinutes = idleArg === undefined ? undefined : Number(idleArg);
      if (args.includes("--idle-exit") && !(idleMinutes !== undefined && idleMinutes > 0 && idleMinutes <= MAX_IDLE_MINUTES)) {
        console.error(`--idle-exit needs a number of minutes between 0 and ${MAX_IDLE_MINUTES} (got "${idleArg}")`);
        process.exitCode = 1;
        return;
      }
      // Last line of defence: a stray rejection must not take the canvas down.
      process.on("unhandledRejection", (err) => console.error("gabiro canvas:", err));
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        void server.close().then(() => process.exit(0));
      };
      const server = await startCanvasServer({
        root,
        port,
        idleExitMs: idleMinutes === undefined ? undefined : idleMinutes * 60_000,
        onIdle: () => {
          console.log("gabiro canvas: no open canvas, stopping (--idle-exit)");
          stop();
        },
      });
      console.log(`gabiro canvas running at ${server.url} (project root: ${root})`);
      if (args.includes("--open")) openInBrowser(server.url);
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

- [ ] **Step 4: Build and run the tests**

Run: `npm run build && npx vitest run test/server test/e2e/cli.test.ts && npx tsc --noEmit && npm test`
Expected: all pass (20 files, 150 tests). Run `npx vitest run test/server` 3 times to confirm stability.

- [ ] **Step 5: Commit**

```bash
git add src/server/canvas-server.ts src/server/index.ts src/cli.ts test/server/edits.test.ts test/e2e/cli.test.ts
git commit -m "feat(server): canvas edit endpoints; ws error listener; cap --idle-exit" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

### Task 3: Web: pure edit helpers (gestures to ops, and diffs for undo)

**Files:**
- Create: `web/src/edits.ts`
- Create (test): `test/web/edits.test.ts`

What each gesture becomes:
- **Dropped node:** pinned where it was dropped.
- **Dropped kanban card:** moves to the column under it, takes the slot at its height, and renumbers both columns.
- **Dropped sequence participant:** reordered by its x position.
- **Palette add:** the node is centred on the view, cascading to a free spot if something is already there.

`diffOps(from, to)` is the undo/redo engine. The tests check that it round-trips drag, add, connect, delete-with-edges, rename-and-clear, edge restyle, group removal and nested groups.

- [ ] **Step 1: Write the failing test**

`test/web/edits.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyOps, type Board } from "../../src/core/index.js";
import { layoutBoard } from "../../src/layout/index.js";
import { addNodeOps, connectOps, deleteOps, diffOps, freeSpot, moveOps, uniqueId } from "../../web/src/edits.js";
import { FIXTURES } from "../fixtures/boards.js";

const laid = (b: Board) => layoutBoard(b);

/** Board content without layout routes, sorted, for comparing boards after a round trip. */
function content(b: Board) {
  const sort = <T extends { id: string }>(xs: T[]) => [...xs].sort((x, y) => (x.id < y.id ? -1 : 1));
  return {
    nodes: sort(b.nodes),
    edges: sort(b.edges.map(({ points: _p, ...e }) => e)),
    groups: sort(b.groups),
  };
}

describe("uniqueId", () => {
  it("suffixes ids already used by nodes or groups", () => {
    expect(uniqueId(FIXTURES.architecture, "cache")).toBe("cache");
    expect(uniqueId(FIXTURES.architecture, "api")).toBe("api-2");
    expect(uniqueId(FIXTURES.architecture, "backend")).toBe("backend-2");
  });
});

describe("addNodeOps", () => {
  it("adds a node centred on the given point, with a readable unique id and label", () => {
    const ops = addNodeOps(FIXTURES.architecture, "service", { x: 100.4, y: 55.6 });
    expect(ops).toEqual([{ op: "add_node", id: "new-service", type: "service", label: "New service", position: { x: 10, y: 21 } }]);
    const twice = applyOps(applyOps(FIXTURES.architecture, ops), addNodeOps(applyOps(FIXTURES.architecture, ops), "service", { x: 0, y: 0 }));
    expect(twice.nodes.map((n) => n.id)).toContain("new-service-2");
  });

  it("puts kanban cards at the end of the first column and orders sequence participants", () => {
    const [card] = addNodeOps(FIXTURES.kanban, "card", { x: 0, y: 0 });
    expect(card).toMatchObject({ groupId: "todo", order: 3 });
    expect(card).not.toHaveProperty("position");
    expect(addNodeOps({ ...FIXTURES.kanban, groups: [], nodes: [] }, "card", { x: 0, y: 0 })).toEqual([]);
    expect(addNodeOps(FIXTURES.sequence, "participant", { x: 0, y: 0 })[0]).toMatchObject({ order: 4 });
  });

  it("gives new ERD entities an id field, and every result applies cleanly", () => {
    expect(addNodeOps(FIXTURES.erd, "entity", { x: 0, y: 0 })[0]).toMatchObject({ label: "Entity", fields: [{ name: "id", pk: true }] });
    for (const board of Object.values(FIXTURES)) {
      const type = board.kind === "kanban" ? "card" : "sticky";
      expect(() => applyOps(board, addNodeOps(board, type, { x: 5, y: 5 }))).not.toThrow();
    }
  });
});

describe("freeSpot", () => {
  it("keeps a free position and steps diagonally off occupied ones", async () => {
    const board = await laid(FIXTURES.architecture);
    const size = { width: 180, height: 70 };
    expect(freeSpot(board, { x: -5000, y: -5000 }, size)).toEqual({ x: -5000, y: -5000 });
    const api = board.nodes.find((n) => n.id === "api")!.position!;
    const spot = freeSpot(board, api, size);
    expect(spot.x - api.x).toBe(spot.y - api.y);
    expect(spot.x).toBeGreaterThan(api.x);
    const placed = applyOps(board, [{ op: "add_node", id: "probe", type: "service", label: "P", position: spot }]);
    expect(freeSpot(placed, spot, size)).not.toEqual(spot);
  });
});

describe("connectOps", () => {
  it("uses the kind's default edge type, with sequence order and ERD cardinality", () => {
    expect(connectOps(FIXTURES.architecture, "web", "stripe")).toEqual([{ op: "add_edge", from: "web", to: "stripe", type: "sync" }]);
    expect(connectOps(FIXTURES.sequence, "db", "client")[0]).toMatchObject({ type: "message", order: 4 });
    expect(connectOps(FIXTURES.erd, "orders", "users")[0]).toMatchObject({ type: "relation", cardinality: "1-n" });
    expect(connectOps(FIXTURES.kanban, "core", "mcp")).toEqual([]);
  });
});

describe("moveOps", () => {
  it("pins a dropped node where it was dropped", () => {
    expect(moveOps(FIXTURES.architecture, "api", { x: 301.7, y: 99.2 })).toEqual([
      { op: "update_node", id: "api", position: { x: 302, y: 99 }, pinned: true },
    ]);
  });

  it("moves a kanban card to the column under it, into the slot at its height", async () => {
    const board = await laid(FIXTURES.kanban);
    const ops = moveOps(board, "core", { x: 300, y: 0 });
    const after = await layoutBoard(applyOps(board, ops), "all");
    const done = after.nodes.filter((n) => n.groupId === "done").sort((a, b) => a.order! - b.order!);
    expect(done.map((n) => n.id)).toEqual(["core", "spec"]);
    expect(after.nodes.find((n) => n.id === "mcp")).toMatchObject({ groupId: "todo", order: 1 });
  });

  it("reorders sequence participants by where they were dropped", async () => {
    const board = await laid(FIXTURES.sequence);
    const after = applyOps(board, moveOps(board, "db", { x: -50, y: 0 }));
    const order = after.nodes.filter((n) => n.type === "participant").sort((a, b) => a.order! - b.order!);
    expect(order.map((n) => n.id)).toEqual(["db", "client", "api"]);
  });
});

describe("deleteOps", () => {
  it("removes nodes and only the edges that won't disappear with them", () => {
    const ops = deleteOps(FIXTURES.architecture, ["api", "ghost"], ["api->events", "web->api"].concat("missing"));
    expect(ops).toEqual([{ op: "remove_node", id: "api" }]);
    expect(deleteOps(FIXTURES.architecture, [], ["web->api"])).toEqual([{ op: "remove_edge", id: "web->api" }]);
    expect(() => applyOps(FIXTURES.architecture, deleteOps(FIXTURES.architecture, ["api"], ["web->api"]))).not.toThrow();
  });
});

describe("diffOps (undo/redo)", () => {
  const edits: [string, (b: Board) => unknown[]][] = [
    ["drag", (b) => moveOps(b, "api", { x: 999, y: 5 })],
    ["add", (b) => addNodeOps(b, "cache", { x: 1, y: 2 })],
    ["connect", (b) => connectOps(b, "web", "stripe")],
    ["delete node with edges", (b) => deleteOps(b, ["api"], [])],
    ["rename + clear tech", () => [{ op: "update_node", id: "api", label: "API v2", tech: null }]],
    ["edge restyle", () => [{ op: "update_edge", id: "web->api", label: null, style: "dashed" }]],
    ["group removal", () => [{ op: "remove_group", id: "data", cascade: true }]],
  ];
  for (const [name, edit] of edits) {
    it(`round-trips: ${name}`, async () => {
      const before = await laid(FIXTURES.architecture);
      const after = applyOps(before, edit(before));
      expect(content(applyOps(after, diffOps(after, before)))).toEqual(content(before));
      expect(content(applyOps(before, diffOps(before, after)))).toEqual(content(after));
    });
  }

  it("is empty for identical boards and ignores layout routes", async () => {
    const board = await laid(FIXTURES.flowchart);
    const stripped = { ...board, edges: board.edges.map(({ points: _p, ...e }) => e) };
    expect(diffOps(board, stripped)).toEqual([]);
  });

  it("restores nested groups", async () => {
    const before = await laid(FIXTURES.architecture);
    const after = applyOps(before, [
      { op: "remove_group", id: "data", cascade: true },
      { op: "remove_group", id: "backend", cascade: true },
    ]);
    expect(content(applyOps(after, diffOps(after, before)))).toEqual(content(before));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/web/edits.test.ts`
Expected: FAIL: cannot resolve `../../web/src/edits.js`.

- [ ] **Step 3: Implement**

`web/src/edits.ts`:

```ts
import { KIND_RULES, slugify, type Board, type BoardEdge, type BoardGroup, type BoardNode, type Op, type Position } from "../../src/core/index.js";
import { nodeSize } from "../../src/layout/sizes.js";

/**
 * Pure helpers that turn canvas gestures into board ops. The server applies them through the same
 * core `applyOps` the agent uses, so the same validation rules apply whoever edits.
 */

/** Kanban lane geometry; matches the layout (src/layout/layout.ts) and toFlow's column boxes. */
const KANBAN_STRIDE = 280;

/** `base` if unused on the board, else `base-2`, `base-3`, … (ids are shared by nodes and groups). */
export function uniqueId(board: Board, base: string): string {
  const taken = new Set([...board.nodes.map((n) => n.id), ...board.groups.map((g) => g.id)]);
  const root = base.slice(0, 60);
  if (!taken.has(root)) return root;
  let n = 2;
  while (taken.has(`${root}-${n}`)) n++;
  return `${root}-${n}`;
}

const DEFAULT_LABELS: Record<string, string> = {
  database: "Database",
  queue: "Queue",
  external: "External system",
  decision: "Decision?",
  io: "Input / output",
  subprocess: "Subprocess",
  entity: "Entity",
  sticky: "Note",
  text: "Text",
};
const labelFor = (type: string) => DEFAULT_LABELS[type] ?? `New ${type}`;
const maxOrder = (items: { order?: number }[]) => Math.max(0, ...items.map((i) => i.order ?? 0));

const CASCADE = 40;

/** `position`, or the first spot down and to the right of it where a node of `size` overlaps nothing. */
export function freeSpot(board: Board, position: Position, size: { width: number; height: number }): Position {
  const overlaps = (p: Position) =>
    board.nodes.some((n) => {
      if (!n.position) return false;
      const s = nodeSize(n);
      return p.x < n.position.x + s.width && n.position.x < p.x + size.width && p.y < n.position.y + s.height && n.position.y < p.y + size.height;
    });
  let spot = { x: Math.round(position.x), y: Math.round(position.y) };
  for (let i = 0; i < 50 && overlaps(spot); i++) spot = { x: spot.x + CASCADE, y: spot.y + CASCADE };
  return spot;
}

/** Ops to add a node of `type` from the palette, centred on `position` (or the nearest free spot). */
export function addNodeOps(board: Board, type: string, position: Position): Op[] {
  const label = labelFor(type);
  const node: Op & { op: "add_node" } = { op: "add_node", id: uniqueId(board, slugify(label)), type: type as BoardNode["type"], label };
  if (board.kind === "kanban" && type === "card") {
    const column = board.groups[0];
    if (!column) return [];
    node.groupId = column.id;
    node.order = maxOrder(board.nodes.filter((n) => n.groupId === column.id)) + 1;
  } else if (board.kind === "sequence" && type === "participant") {
    node.order = maxOrder(board.nodes.filter((n) => n.type === "participant")) + 1;
  }
  if (type === "entity") node.fields = [{ name: "id", type: "uuid", pk: true }];
  if (node.order === undefined) {
    const size = nodeSize(node as BoardNode);
    node.position = freeSpot(board, { x: position.x - size.width / 2, y: position.y - size.height / 2 }, size);
  }
  return [node];
}

/** Ops to connect two nodes with the board kind's default edge type; [] when the kind has no edges. */
export function connectOps(board: Board, from: string, to: string): Op[] {
  const type = KIND_RULES[board.kind].edgeTypes[0];
  if (!type) return [];
  const edge: Op & { op: "add_edge" } = { op: "add_edge", from, to, type: type as BoardEdge["type"] };
  if (board.kind === "sequence") edge.order = maxOrder(board.edges) + 1;
  if (board.kind === "erd") edge.cardinality = "1-n";
  return [edge];
}

/** Renumbers `ids` as 1, 2, 3… and returns update ops for the ones whose order changed. */
function reorder(board: Board, ids: string[]): Op[] {
  return ids.flatMap((id, i) => {
    const node = board.nodes.find((n) => n.id === id);
    return node && node.order !== i + 1 ? [{ op: "update_node" as const, id, order: i + 1 }] : [];
  });
}

/**
 * Ops for a node the user dropped at `position`:
 * - kanban cards move to the column under them and take their slot by height;
 * - sequence participants take their slot by horizontal position;
 * - everything else stays exactly where it was dropped (position + pinned).
 */
export function moveOps(board: Board, nodeId: string, position: Position): Op[] {
  const node = board.nodes.find((n) => n.id === nodeId);
  if (!node) return [];
  if (board.kind === "kanban" && node.type === "card" && board.groups.length) {
    const index = Math.min(board.groups.length - 1, Math.max(0, Math.floor((position.x + 120) / KANBAN_STRIDE)));
    const column = board.groups[index]!;
    const ops: Op[] = column.id !== node.groupId ? [{ op: "update_node", id: nodeId, groupId: column.id }] : [];
    const cards = board.nodes
      .filter((n) => n.groupId === column.id && n.id !== nodeId)
      .sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0));
    const slot = cards.filter((c) => (c.position?.y ?? 0) < position.y).length;
    const ids = cards.map((c) => c.id);
    ids.splice(slot, 0, nodeId);
    const moved = { ...board, nodes: board.nodes.map((n) => (n.id === nodeId ? { ...n, groupId: column.id } : n)) };
    // Close the gap in the column the card left.
    const left = node.groupId !== column.id
      ? board.nodes
          .filter((n) => n.groupId === node.groupId && n.id !== nodeId)
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.position?.y ?? 0) - (b.position?.y ?? 0))
          .map((n) => n.id)
      : [];
    return [...ops, ...reorder(moved, ids), ...reorder(moved, left)];
  }
  if (board.kind === "sequence" && node.type === "participant") {
    const others = board.nodes
      .filter((n) => n.type === "participant" && n.id !== nodeId)
      .sort((a, b) => (a.position?.x ?? 0) - (b.position?.x ?? 0));
    const ids = others.map((n) => n.id);
    ids.splice(others.filter((n) => (n.position?.x ?? 0) < position.x).length, 0, nodeId);
    return reorder(board, ids);
  }
  return [{ op: "update_node", id: nodeId, position: { x: Math.round(position.x), y: Math.round(position.y) }, pinned: true }];
}

/** Ops to delete nodes (their edges go with them) and edges. */
export function deleteOps(board: Board, nodeIds: string[], edgeIds: string[]): Op[] {
  const nodes = new Set(nodeIds.filter((id) => board.nodes.some((n) => n.id === id)));
  const edges = edgeIds.filter((id) => {
    const e = board.edges.find((x) => x.id === id);
    return e && !nodes.has(e.from) && !nodes.has(e.to);
  });
  return [...edges.map((id) => ({ op: "remove_edge" as const, id })), ...[...nodes].map((id) => ({ op: "remove_node" as const, id }))];
}

const NODE_PATCH_KEYS = ["type", "label", "description", "tech", "groupId", "tags", "color", "position", "pinned", "order", "fields"] as const;
const EDGE_PATCH_KEYS = ["type", "label", "order", "style", "cardinality"] as const;
const GROUP_PATCH_KEYS = ["label", "type", "parentId"] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Patch that turns `from` into `to` for the given keys; keys absent in `to` become null (cleared). */
function patch(from: object, to: object, keys: readonly string[]): Record<string, unknown> {
  const f = from as Record<string, unknown>;
  const t = to as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (same(f[key], t[key])) continue;
    out[key] = t[key] === undefined ? null : t[key];
  }
  return out;
}

const withoutPoints = ({ points: _p, ...edge }: BoardEdge) => edge;

/**
 * Ops that turn board `from` into board `to` (nodes, edges and groups; layout routes ignored).
 * Undo is `diffOps(after, before)`, redo is `diffOps(before, after)`.
 */
export function diffOps(from: Board, to: Board): Op[] {
  const byId = <T extends { id: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, x]));
  const [fromNodes, toNodes] = [byId(from.nodes), byId(to.nodes)];
  const [fromEdges, toEdges] = [byId(from.edges), byId(to.edges)];
  const [fromGroups, toGroups] = [byId(from.groups), byId(to.groups)];
  const ops: Op[] = [];

  const removedNodes = from.nodes.filter((n) => !toNodes.has(n.id)).map((n) => n.id);
  const gone = new Set(removedNodes);
  for (const e of from.edges) if (!toEdges.has(e.id) && !gone.has(e.from) && !gone.has(e.to)) ops.push({ op: "remove_edge", id: e.id });
  for (const id of removedNodes) ops.push({ op: "remove_node", id });

  const addedGroups: BoardGroup[] = to.groups.filter((g) => !fromGroups.has(g.id));
  for (const g of addedGroups) ops.push({ op: "add_group", ...g, parentId: undefined });
  for (const g of addedGroups) if (g.parentId) ops.push({ op: "update_group", id: g.id, parentId: g.parentId });
  for (const n of to.nodes) if (!fromNodes.has(n.id)) ops.push({ op: "add_node", ...n });
  for (const e of to.edges) if (!fromEdges.has(e.id)) ops.push({ op: "add_edge", ...withoutPoints(e) });

  for (const n of to.nodes) {
    const prev = fromNodes.get(n.id);
    const changes = prev ? patch(prev, n, NODE_PATCH_KEYS) : {};
    if (Object.keys(changes).length) ops.push({ op: "update_node", id: n.id, ...changes } as Op);
  }
  for (const e of to.edges) {
    const prev = fromEdges.get(e.id);
    const changes = prev ? patch(prev, e, EDGE_PATCH_KEYS) : {};
    if (Object.keys(changes).length) ops.push({ op: "update_edge", id: e.id, ...changes } as Op);
  }
  for (const g of to.groups) {
    const prev = fromGroups.get(g.id);
    const changes = prev ? patch(prev, g, GROUP_PATCH_KEYS) : {};
    if (Object.keys(changes).length) ops.push({ op: "update_group", id: g.id, ...changes } as Op);
  }
  for (const g of from.groups) if (!toGroups.has(g.id)) ops.push({ op: "remove_group", id: g.id, cascade: true });
  return ops;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/web && npx tsc --noEmit && npx tsc --noEmit -p web && npm test`
Expected: all pass (21 files, 169 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/edits.ts test/web/edits.test.ts
git commit -m "feat(web): pure helpers turning canvas gestures into ops" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

### Task 4: Web: undo history and the edit API client

**Files:**
- Create: `web/src/history.ts`
- Create: `web/src/api.ts`
- Create (test): `test/web/history-api.test.ts`

- [ ] **Step 1: Write the failing test**

`test/web/history-api.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Board, Op } from "../../src/core/index.js";
import { submitOps, type EditResult, type PostOps } from "../../web/src/api.js";
import { EditHistory } from "../../web/src/history.js";
import { FIXTURES } from "../fixtures/boards.js";

const rev = (revision: number): Board => ({ ...FIXTURES.architecture, revision });

describe("EditHistory", () => {
  it("undoes and redoes in order, and a new edit clears redo", () => {
    const h = new EditHistory();
    const a = { before: rev(1), after: rev(2) };
    const b = { before: rev(2), after: rev(3) };
    h.push(a);
    h.push(b);
    expect(h.undo()).toBe(b);
    expect(h.canRedo).toBe(true);
    expect(h.redo()).toBe(b);
    expect(h.undo()).toBe(b);
    h.push({ before: rev(2), after: rev(4) });
    expect(h.canRedo).toBe(false);
  });

  it("keeps at most `limit` edits and can put back a failed undo", () => {
    const h = new EditHistory(2);
    for (let i = 1; i <= 3; i++) h.push({ before: rev(i), after: rev(i + 1) });
    expect(h.undo()?.after.revision).toBe(4);
    expect(h.undo()?.after.revision).toBe(3);
    expect(h.undo()).toBeUndefined();
    const h2 = new EditHistory();
    const e = { before: rev(1), after: rev(2) };
    h2.push(e);
    h2.undo();
    h2.restore(e, "undo");
    expect(h2.canUndo).toBe(true);
    expect(h2.canRedo).toBe(false);
  });
});

describe("submitOps", () => {
  const ops: Op[] = [{ op: "update_node", id: "api", label: "API v2" }];

  function fakePost(results: EditResult[]) {
    const calls: (number | undefined)[] = [];
    const post: PostOps = async (_id, _ops, expected) => {
      calls.push(expected);
      return results.shift()!;
    };
    return { post, calls };
  }

  it("sends once when the revision is current", async () => {
    const { post, calls } = fakePost([{ ok: true, board: rev(2) }]);
    expect(await submitOps("x", ops, 1, post)).toMatchObject({ ok: true });
    expect(calls).toEqual([1]);
  });

  it("re-applies once on a conflict, against the latest revision", async () => {
    const { post, calls } = fakePost([
      { ok: false, status: 409, code: "CONFLICT", error: "stale", board: rev(5) },
      { ok: true, board: rev(6) },
    ]);
    expect(await submitOps("x", ops, 1, post)).toMatchObject({ ok: true, board: { revision: 6 } });
    expect(calls).toEqual([1, 5]);
  });

  it("gives up after the second attempt, and never retries other errors", async () => {
    const conflict = { ok: false as const, status: 409, code: "CONFLICT", error: "stale", board: rev(5) };
    const twice = fakePost([conflict, { ...conflict, board: rev(6) }]);
    expect(await submitOps("x", ops, 1, twice.post)).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(twice.calls).toEqual([1, 5]);
    const invalid = fakePost([{ ok: false, status: 400, code: "VALIDATION", error: "Op #0 failed" }]);
    expect(await submitOps("x", ops, 1, invalid.post)).toMatchObject({ ok: false, code: "VALIDATION" });
    expect(invalid.calls).toEqual([1]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/web/history-api.test.ts`
Expected: FAIL: cannot resolve `../../web/src/api.js`.

- [ ] **Step 3: Implement**

`web/src/history.ts`:

```ts
import type { Board } from "../../src/core/index.js";

/** One edit made in this canvas: the board just before it, and the board the server saved. */
export interface HistoryEntry {
  before: Board;
  after: Board;
}

/** Undo/redo stacks for the user's own canvas edits (agent edits are not undone). */
export class EditHistory {
  private done: HistoryEntry[] = [];
  private undone: HistoryEntry[] = [];

  constructor(private readonly limit = 100) {}

  /** Records a new edit; it clears the redo stack. */
  push(entry: HistoryEntry): void {
    this.done.push(entry);
    if (this.done.length > this.limit) this.done.shift();
    this.undone = [];
  }

  /** The edit to undo next, moved to the redo stack. */
  undo(): HistoryEntry | undefined {
    const entry = this.done.pop();
    if (entry) this.undone.push(entry);
    return entry;
  }

  /** The edit to redo next, moved back to the undo stack. */
  redo(): HistoryEntry | undefined {
    const entry = this.undone.pop();
    if (entry) this.done.push(entry);
    return entry;
  }

  /** Puts an entry back where it came from after its undo/redo request failed. */
  restore(entry: HistoryEntry, from: "undo" | "redo"): void {
    if (from === "undo") {
      this.undone.pop();
      this.done.push(entry);
    } else {
      this.done.pop();
      this.undone.push(entry);
    }
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }
}
```

`web/src/api.ts`:

```ts
import type { Board, Op } from "../../src/core/index.js";

export type EditResult =
  | { ok: true; board: Board; exportWarning?: string }
  | { ok: false; status: number; code: string; error: string; board?: Board };

export type PostOps = (boardId: string, ops: Op[], expectedRevision?: number) => Promise<EditResult>;

/** POSTs ops to the canvas server (same origin). Network failures come back as a result, not a throw. */
export const postOps: PostOps = async (boardId, ops, expectedRevision) => {
  try {
    const res = await fetch(`/api/boards/${encodeURIComponent(boardId)}/ops`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ops, expectedRevision }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return { ok: true, board: body.board as Board, exportWarning: body.exportWarning as string | undefined };
    return {
      ok: false,
      status: res.status,
      code: String(body.code ?? "ERROR"),
      error: String(body.error ?? `Request failed (${res.status})`),
      board: body.board as Board | undefined,
    };
  } catch {
    return { ok: false, status: 0, code: "NETWORK", error: "Can't reach the gabiro canvas server. Is `gabiro serve` still running?" };
  }
};

/** Asks the canvas server to re-run auto-layout for a board. */
export async function postLayout(boardId: string, force: boolean): Promise<EditResult> {
  try {
    const res = await fetch(`/api/boards/${encodeURIComponent(boardId)}/layout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return { ok: true, board: body.board as Board };
    return { ok: false, status: res.status, code: String(body.code ?? "ERROR"), error: String(body.error ?? `Request failed (${res.status})`) };
  } catch {
    return { ok: false, status: 0, code: "NETWORK", error: "Can't reach the gabiro canvas server. Is `gabiro serve` still running?" };
  }
}

/**
 * Sends an edit made against `revision`. If someone else changed the board meanwhile (409), the
 * same ops are re-applied once on top of the latest board; if that fails too, the error is returned.
 */
export async function submitOps(boardId: string, ops: Op[], revision: number, post: PostOps = postOps): Promise<EditResult> {
  const first = await post(boardId, ops, revision);
  if (first.ok || first.code !== "CONFLICT" || !first.board) return first;
  return post(boardId, ops, first.board.revision);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/web && npx tsc --noEmit -p web && npm test`
Expected: all pass (22 files, 174 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/history.ts web/src/api.ts test/web/history-api.test.ts
git commit -m "feat(web): undo history and edit API client with conflict re-apply" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

### Task 5: Web: editable flow mapping and connectable handles

**Files:**
- Modify: `web/src/toFlow.ts`
- Modify: `web/src/nodes.tsx`
- Modify (test): `test/web/toFlow.test.ts`

- [ ] **Step 1: Write the failing test**

Complete updated test file. It adds "is read-only by default and editable on request".

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

  it("is read-only by default and editable on request (groups never draggable or deletable)", async () => {
    const board = await laid(FIXTURES.architecture);
    const readOnly = toFlow(board);
    const api = (f: ReturnType<typeof toFlow>) => f.nodes.find((n) => n.id === "api")!;
    expect(api(readOnly)).toMatchObject({ draggable: false, selectable: false, deletable: false });
    expect((api(readOnly).data as { connectable: boolean }).connectable).toBe(false);
    const editable = toFlow(board, new Set(), { editable: true });
    expect(api(editable)).toMatchObject({ draggable: true, selectable: true, deletable: true });
    expect((api(editable).data as { connectable: boolean }).connectable).toBe(true);
    expect(editable.nodes.find((n) => n.id === "group:backend")).toMatchObject({ draggable: false, deletable: false });
    expect(editable.edges.every((e) => e.selectable && e.deletable)).toBe(true);
    const kanban = toFlow(await laid(FIXTURES.kanban), new Set(), { editable: true });
    expect((kanban.nodes.find((n) => n.id === "core")!.data as { connectable: boolean }).connectable).toBe(false);
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

Run: `npx vitest run test/web/toFlow.test.ts`
Expected: FAIL: `deletable` / `connectable` are missing, and the `editable` option is ignored.

- [ ] **Step 3: Implement**

`web/src/toFlow.ts`:

```ts
import type { Edge, Node } from "@xyflow/react";
import { KIND_RULES, type Board, type BoardEdge, type BoardGroup, type BoardNode, type Position } from "../../src/core/index.js";
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
  /** Whether the user can draw edges from this node's handles. */
  connectable: boolean;
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
export interface FlowOptions {
  /** Editable canvas: nodes can be dragged, selected, connected and deleted. Default false (read-only). */
  editable?: boolean;
}

export function toFlow(board: Board, changed: ReadonlySet<string> = new Set(), options: FlowOptions = {}): Flow {
  const editable = options.editable ?? false;
  const connectable = editable && KIND_RULES[board.kind].edgeTypes.length > 0;
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
      deletable: false,
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
      data: { node: n, kind: board.kind, direction: board.layout.direction, changed: changed.has(n.id), connectable } satisfies ShapeData,
      zIndex: 100,
      draggable: editable,
      selectable: editable,
      deletable: editable,
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
          selectable: editable,
          deletable: editable,
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
          selectable: editable,
          deletable: editable,
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

`web/src/nodes.tsx`:

```tsx
import { BaseEdge, Handle, Position, type EdgeProps, type NodeProps, type Node, type Edge } from "@xyflow/react";
import type { GroupData, MessageData, RoutedData, ShapeData } from "./toFlow.js";

/** Connection points: invisible on a read-only canvas, shown on hover when the user can draw edges. */
function Handles({ direction, connectable }: { direction: "LR" | "TB"; connectable: boolean }) {
  const [target, source] = direction === "LR" ? [Position.Left, Position.Right] : [Position.Top, Position.Bottom];
  const className = connectable ? "gb-handle gb-connectable" : "gb-handle";
  return (
    <>
      <Handle type="target" position={target} isConnectable={connectable} className={className} />
      <Handle type="source" position={source} isConnectable={connectable} className={className} />
    </>
  );
}

const flash = (changed: boolean) => (changed ? " gb-flash" : "");

export function ShapeNode({ data }: NodeProps<Node<ShapeData>>) {
  const { node, direction, changed, connectable } = data;
  return (
    <div className={`gb-node gb-${node.type}${flash(changed)}`} title={node.description}>
      <Handles direction={direction} connectable={connectable} />
      <div className="gb-label">{node.label}</div>
      {node.tech && <div className="gb-tech">{node.tech}</div>}
      {node.type === "sticky" && node.description && <div className="gb-desc">{node.description}</div>}
    </div>
  );
}

export function EntityNode({ data }: NodeProps<Node<ShapeData>>) {
  const { node, direction, changed, connectable } = data;
  return (
    <div className={`gb-entity${flash(changed)}`}>
      <Handles direction={direction} connectable={connectable} />
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
  const { node, changed, connectable } = data;
  return (
    <div className="gb-participant">
      {/* The first handles anchor message arrows at the lifeline's centre; the extra pair lets the user draw new messages. */}
      <Handle type="target" position={Position.Top} isConnectable={false} className="gb-handle" />
      <Handle type="source" position={Position.Top} isConnectable={false} className="gb-handle" />
      {connectable && (
        <>
          <Handle id="draw-in" type="target" position={Position.Left} className="gb-handle gb-connectable" />
          <Handle id="draw-out" type="source" position={Position.Right} className="gb-handle gb-connectable" />
        </>
      )}
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

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/web && npx tsc --noEmit -p web && npm test`
Expected: all pass (22 files, 175 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/toFlow.ts web/src/nodes.tsx test/web/toFlow.test.ts
git commit -m "feat(web): editable flow mapping and connectable handles" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

### Task 6: Web: the editing UI

**Files:**
- Create: `web/src/useEditor.ts`
- Create: `web/src/Toolbar.tsx`
- Create: `web/src/SidePanel.tsx`
- Modify: `web/src/BoardView.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/index.html`
- Modify: `vite.config.ts`

Design points:
- **Nodes and edges are React Flow *controlled* state.** They are rebuilt from every board snapshot while keeping the user's selection. Local `remove` changes are dropped: deletions only happen by saving ops.
- **The side panel's fields are drafts.** They follow the board (for example, when an agent edits the same node) except while the user is typing in them. Keying the form on the board revision loses focus whenever a snapshot arrives.
- **Connecting on drop.** React Flow only connects on a handle, so `onConnectEnd` also connects when the pointer is released over another node's body.
- **Keyboard undo/redo is ignored while typing** in an input, textarea or select.

- [ ] **Step 1: Add the editor hook, toolbar and side panel**

`web/src/useEditor.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { applyOps, type Board, type Op } from "../../src/core/index.js";
import { postLayout, submitOps, type EditResult } from "./api.js";
import { diffOps } from "./edits.js";
import { EditHistory, type HistoryEntry } from "./history.js";

export interface Editor {
  /** What the canvas shows: the server's board, or the optimistic result of an edit in flight. */
  board?: Board;
  /** Applies ops locally at once, then saves them; reverts and reports on failure. */
  apply(ops: Op[]): Promise<void>;
  /** Re-runs auto-layout on the server (pinned nodes stay unless `force`). */
  autoLayout(force?: boolean): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * Optimistic editing on top of the live board. Edits show immediately, are saved through the
 * canvas server (re-applied once on a revision conflict), and are recorded for undo/redo.
 */
export function useEditor(serverBoard: Board | undefined, onError: (message: string) => void): Editor {
  const history = useRef(new EditHistory());
  const [optimistic, setOptimistic] = useState<Board>();
  const [, setVersion] = useState(0);
  const latestRevision = useRef(serverBoard?.revision ?? 0);

  // A newer server snapshot replaces any optimistic board.
  useEffect(() => {
    latestRevision.current = serverBoard?.revision ?? 0;
    setOptimistic((o) => (o && serverBoard && serverBoard.revision >= o.revision ? undefined : o));
  }, [serverBoard]);

  const shown = optimistic ?? serverBoard;
  const shownRef = useRef(shown);
  shownRef.current = shown;

  /** Saves ops made against the shown board; returns the saved board, or undefined on failure. */
  const save = useCallback(
    async (ops: Op[]): Promise<{ before: Board; after: Board } | undefined> => {
      const before = shownRef.current;
      if (!before || !ops.length) return undefined;
      try {
        setOptimistic({ ...applyOps(before, ops), revision: before.revision });
      } catch (err) {
        onError((err as Error).message);
        return undefined;
      }
      const result: EditResult = await submitOps(before.id, ops, before.revision);
      if (!result.ok) {
        setOptimistic(undefined);
        onError(result.error);
        return undefined;
      }
      if (result.exportWarning) onError(`Saved, but the Markdown export failed: ${result.exportWarning}`);
      setOptimistic(result.board.revision > latestRevision.current ? result.board : undefined);
      return { before, after: result.board };
    },
    [onError],
  );

  const apply = useCallback(
    async (ops: Op[]) => {
      const saved = await save(ops);
      if (saved) history.current.push(saved);
      setVersion((v) => v + 1);
    },
    [save],
  );

  const step = useCallback(
    async (direction: "undo" | "redo") => {
      const entry: HistoryEntry | undefined = direction === "undo" ? history.current.undo() : history.current.redo();
      if (!entry) return;
      const ops = direction === "undo" ? diffOps(entry.after, entry.before) : diffOps(entry.before, entry.after);
      const saved = ops.length ? await save(ops) : { before: entry.after, after: entry.after };
      if (!saved) history.current.restore(entry, direction);
      setVersion((v) => v + 1);
    },
    [save],
  );

  const autoLayout = useCallback(
    async (force = false) => {
      const board = shownRef.current;
      if (!board) return;
      const result = await postLayout(board.id, force);
      if (!result.ok) onError(result.error);
      else if (result.board.revision > latestRevision.current) setOptimistic(result.board);
    },
    [onError],
  );

  return {
    board: shown,
    apply,
    autoLayout,
    undo: useCallback(() => step("undo"), [step]),
    redo: useCallback(() => step("redo"), [step]),
    canUndo: history.current.canUndo,
    canRedo: history.current.canRedo,
  };
}
```

`web/src/Toolbar.tsx`:

```tsx
import { KIND_RULES, type Kind } from "../../src/core/index.js";

interface ToolbarProps {
  kind: Kind;
  onAdd(type: string): void;
  onUndo(): void;
  onRedo(): void;
  onLayout(): void;
  canUndo: boolean;
  canRedo: boolean;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? "⌘" : "Ctrl+";

/** Palette of the node types this board kind allows, plus undo/redo and auto-layout. */
export function Toolbar({ kind, onAdd, onUndo, onRedo, onLayout, canUndo, canRedo }: ToolbarProps) {
  return (
    <div className="gb-toolbar" role="toolbar" aria-label="Board tools">
      <span className="gb-toolbar-label">Add</span>
      {KIND_RULES[kind].nodeTypes.map((type) => (
        <button key={type} type="button" className="gb-tool" onClick={() => onAdd(type)} title={`Add a ${type}`}>
          {type}
        </button>
      ))}
      <span className="gb-toolbar-gap" />
      <button type="button" className="gb-tool" onClick={onUndo} disabled={!canUndo} title={`Undo (${mod}Z)`}>
        Undo
      </button>
      <button type="button" className="gb-tool" onClick={onRedo} disabled={!canRedo} title={`Redo (${mod}Shift+Z)`}>
        Redo
      </button>
      <button type="button" className="gb-tool" onClick={onLayout} title="Re-run auto-layout (nodes you moved stay put)">
        Auto-layout
      </button>
    </div>
  );
}
```

`web/src/SidePanel.tsx`:

```tsx
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { KIND_RULES, type Board, type BoardEdge, type BoardNode, type Field, type Op } from "../../src/core/index.js";
import { deleteOps } from "./edits.js";

export type Selection = { kind: "node"; id: string } | { kind: "edge"; id: string };

interface SidePanelProps {
  board: Board;
  selection: Selection;
  onApply(ops: Op[]): void;
  labelRef: RefObject<HTMLInputElement | null>;
}

/** Commits a text field on Enter (textareas commit on blur only). */
const enterBlurs = (e: KeyboardEvent<HTMLInputElement>) => {
  if (e.key === "Enter") e.currentTarget.blur();
};
const orNull = (text: string) => (text.trim() === "" ? null : text.trim());

/**
 * A text field's draft: follows the board's value (e.g. when an agent edits it) except while the
 * user is typing in it, and saves through `commit` when it loses focus.
 */
function useDraft(value: string, commit: (draft: string) => void) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  return {
    value: draft,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
      if (draft !== value) commit(draft);
    },
  };
}

/** Details of the selected node or edge. Every field saves when it loses focus or changes. */
export function SidePanel({ board, selection, onApply, labelRef }: SidePanelProps) {
  if (selection.kind === "node") {
    const node = board.nodes.find((n) => n.id === selection.id);
    return node ? <NodeForm key={node.id} board={board} node={node} onApply={onApply} labelRef={labelRef} /> : null;
  }
  const edge = board.edges.find((e) => e.id === selection.id);
  return edge ? <EdgeForm key={edge.id} board={board} edge={edge} onApply={onApply} labelRef={labelRef} /> : null;
}

function NodeForm({ board, node, onApply, labelRef }: { board: Board; node: BoardNode } & Omit<SidePanelProps, "board" | "selection">) {
  const update = (changes: Record<string, unknown>) => onApply([{ op: "update_node", id: node.id, ...changes } as Op]);
  const label = useDraft(node.label, (v) => v.trim() && update({ label: v.trim() }));
  const tech = useDraft(node.tech ?? "", (v) => update({ tech: orNull(v) }));
  const description = useDraft(node.description ?? "", (v) => update({ description: orNull(v) }));
  const tags = useDraft((node.tags ?? []).join(", "), (v) => {
    const list = v.split(",").map((t) => t.trim()).filter(Boolean);
    if (list.join(",") !== (node.tags ?? []).join(",")) update({ tags: list.length ? list : null });
  });
  const rules = KIND_RULES[board.kind];

  return (
    <aside className="gb-panel" aria-label="Selected node">
      <h2>{node.label}</h2>
      <label>
        Label
        <input ref={labelRef} {...label} onKeyDown={enterBlurs} />
      </label>
      <label>
        Type
        <select value={node.type} onChange={(e) => update({ type: e.target.value })}>
          {rules.nodeTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      {rules.groupTypes.length > 0 && board.groups.length > 0 && (
        <label>
          {board.kind === "kanban" ? "Column" : "Group"}
          <select value={node.groupId ?? ""} onChange={(e) => update({ groupId: e.target.value || null })}>
            {board.kind !== "kanban" && <option value="">(none)</option>}
            {board.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Tech
        <input {...tech} placeholder="e.g. PostgreSQL 16" onKeyDown={enterBlurs} />
      </label>
      <label>
        Description
        <textarea {...description} rows={3} />
      </label>
      <label>
        Tags
        <input {...tags} placeholder="comma, separated" onKeyDown={enterBlurs} />
      </label>
      {node.type === "entity" && (
        <FieldsEditor key={JSON.stringify(node.fields ?? [])} fields={node.fields ?? []} onChange={(fields) => update({ fields })} />
      )}
      <button type="button" className="gb-danger" onClick={() => onApply(deleteOps(board, [node.id], []))}>
        Delete node
      </button>
    </aside>
  );
}

function FieldsEditor({ fields, onChange }: { fields: Field[]; onChange(fields: Field[]): void }) {
  const [rows, setRows] = useState(fields);
  const commit = (next: Field[]) => {
    setRows(next);
    const valid = next.filter((f) => f.name.trim() && f.type.trim());
    if (JSON.stringify(valid) !== JSON.stringify(fields)) onChange(valid);
  };
  const setRow = (i: number, patch: Partial<Field>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="gb-fields">
      <legend>Fields</legend>
      {rows.map((f, i) => (
        <div key={i} className="gb-field-row">
          <input aria-label="Field name" value={f.name} onChange={(e) => setRow(i, { name: e.target.value })} onBlur={() => commit(rows)} />
          <input aria-label="Field type" value={f.type} onChange={(e) => setRow(i, { type: e.target.value })} onBlur={() => commit(rows)} />
          {(["pk", "fk", "nullable"] as const).map((flag) => (
            <label key={flag} className="gb-check">
              <input
                type="checkbox"
                checked={!!f[flag]}
                onChange={(e) => commit(rows.map((r, j) => (j === i ? { ...r, [flag]: e.target.checked || undefined } : r)))}
              />
              {flag === "nullable" ? "null" : flag.toUpperCase()}
            </label>
          ))}
          <button type="button" aria-label="Remove field" onClick={() => commit(rows.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
      <button type="button" onClick={() => setRows([...rows, { name: "", type: "text" }])}>
        Add field
      </button>
    </fieldset>
  );
}

function EdgeForm({ board, edge, onApply, labelRef }: { board: Board; edge: BoardEdge } & Omit<SidePanelProps, "board" | "selection">) {
  const update = (changes: Record<string, unknown>) => onApply([{ op: "update_edge", id: edge.id, ...changes } as Op]);
  const label = useDraft(edge.label ?? "", (v) => update({ label: orNull(v) }));
  const order = useDraft(String(edge.order ?? ""), (v) => Number.isInteger(Number(v)) && Number(v) >= 1 && update({ order: Number(v) }));
  const name = (id: string) => board.nodes.find((n) => n.id === id)?.label ?? id;

  return (
    <aside className="gb-panel" aria-label="Selected edge">
      <h2>
        {name(edge.from)} → {name(edge.to)}
      </h2>
      <label>
        Label
        <input ref={labelRef} {...label} onKeyDown={enterBlurs} />
      </label>
      <label>
        Type
        <select value={edge.type} onChange={(e) => update({ type: e.target.value })}>
          {KIND_RULES[board.kind].edgeTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label>
        Line
        <select value={edge.style ?? ""} onChange={(e) => update({ style: e.target.value || null })}>
          <option value="">default</option>
          <option value="solid">solid</option>
          <option value="dashed">dashed</option>
        </select>
      </label>
      {board.kind === "erd" && (
        <label>
          Cardinality
          <select value={edge.cardinality ?? "1-n"} onChange={(e) => update({ cardinality: e.target.value })}>
            {["1-1", "1-n", "n-n"].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      )}
      {board.kind === "sequence" && (
        <label>
          Order
          <input type="number" min={1} {...order} onKeyDown={enterBlurs} />
        </label>
      )}
      <button type="button" className="gb-danger" onClick={() => onApply(deleteOps(board, [], [edge.id]))}>
        Delete edge
      </button>
    </aside>
  );
}
```

- [ ] **Step 2: Wire the board view**

Complete files:

`web/src/BoardView.tsx`:

```tsx
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  type Node,
  type NodeChange,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Board } from "../../src/core/index.js";
import { addNodeOps, connectOps, deleteOps, moveOps } from "./edits.js";
import { useLiveBoard } from "./hooks.js";
import { edgeTypes, nodeTypes } from "./nodes.js";
import { SidePanel, type Selection } from "./SidePanel.js";
import { toFlow } from "./toFlow.js";
import { Toolbar } from "./Toolbar.js";
import { useEditor, type Editor } from "./useEditor.js";

/** Small boards fit on screen; a minimap would only cover part of them. */
const MINIMAP_MIN_NODES = 12;
const TOAST_MS = 6000;

export function BoardView({ boardId }: { boardId: string }) {
  const live = useLiveBoard(boardId);
  const [toast, setToast] = useState<string>();
  const editor = useEditor(live.board, useCallback((message: string) => setToast(message), []));
  // A corrupt or deleted board stays visible read-only.
  const editable = !!editor.board && !live.error;

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(undefined), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const board = editor.board;
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
        <span className={`gb-status ${live.connected ? "on" : "off"}`} title={live.connected ? "Live" : "Reconnecting…"}>
          {live.connected ? "● live" : "○ reconnecting"}
        </span>
      </header>
      {live.error && (
        <div className="gb-banner" role="alert">
          <strong>{live.error.code === "NOT_FOUND" ? "This board no longer exists." : "This board can't be loaded."}</strong>{" "}
          {live.error.message}
          {board && " Showing the last good version (read-only)."}
        </div>
      )}
      {toast && (
        <div className="gb-toast" role="status">
          {toast}
          <button type="button" aria-label="Dismiss" onClick={() => setToast(undefined)}>
            ×
          </button>
        </div>
      )}
      <main className="gb-canvas">
        {board ? (
          <ReactFlowProvider>
            <Canvas board={board} changed={live.changed} editor={editor} editable={editable} />
          </ReactFlowProvider>
        ) : (
          !live.error && <p className="gb-empty">Loading…</p>
        )}
      </main>
    </div>
  );
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

function Canvas({ board, changed, editor, editable }: { board: Board; changed: Set<string>; editor: Editor; editable: boolean }) {
  const flow = useMemo(() => toFlow(board, changed, { editable }), [board, changed, editable]);
  const [nodes, setNodes] = useState<Node[]>(flow.nodes);
  const [edges, setEdges] = useState<Edge[]>(flow.edges);
  const [selection, setSelection] = useState<Selection>();
  const { screenToFlowPosition } = useReactFlow();
  const container = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);

  // Take every new board, keeping what the user has selected.
  useEffect(() => {
    setNodes((prev) => {
      const selected = new Set(prev.filter((n) => n.selected).map((n) => n.id));
      return flow.nodes.map((n) => (selected.has(n.id) ? { ...n, selected: true } : n));
    });
    setEdges((prev) => {
      const selected = new Set(prev.filter((e) => e.selected).map((e) => e.id));
      return flow.edges.map((e) => (selected.has(e.id) ? { ...e, selected: true } : e));
    });
  }, [flow]);

  // Deletions go through the board (onDelete), never straight into local state.
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((ns) => applyNodeChanges(changes.filter((c) => c.type !== "remove"), ns));
  }, []);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((es) => applyEdgeChanges(changes.filter((c) => c.type !== "remove"), es));
  }, []);

  const onSelectionChange = useCallback(({ nodes: ns, edges: es }: OnSelectionChangeParams) => {
    const node = ns.find((n) => !n.id.startsWith("group:"));
    setSelection(node ? { kind: "node", id: node.id } : es[0] ? { kind: "edge", id: es[0].id } : undefined);
  }, []);

  /**
   * React Flow only connects when the pointer is released on a handle. Releasing anywhere on
   * another node's body should connect too, so finish those drags here.
   */
  const onConnectEnd = (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (state.isValid || !state.fromNode) return;
    const point = "changedTouches" in event ? event.changedTouches[0] : event;
    if (!point) return;
    const target = document.elementFromPoint(point.clientX, point.clientY)?.closest<HTMLElement>(".react-flow__node");
    const to = target?.dataset.id;
    if (to && to !== state.fromNode.id && !to.startsWith("group:")) void editor.apply(connectOps(board, state.fromNode.id, to));
  };

  const addNode = (type: string) => {
    const rect = container.current?.getBoundingClientRect();
    const center = rect ? screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) : { x: 0, y: 0 };
    void editor.apply(addNodeOps(board, type, center));
  };

  // Keyboard undo/redo, except while typing in a field.
  useEffect(() => {
    if (!editable) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || isTyping(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) void editor.undo();
      else if ((key === "z" && e.shiftKey) || key === "y") void editor.redo();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editable, editor]);

  return (
    <div className="gb-editor">
      {editable && (
        <Toolbar
          kind={board.kind}
          onAdd={addNode}
          onUndo={() => void editor.undo()}
          onRedo={() => void editor.redo()}
          onLayout={() => void editor.autoLayout()}
          canUndo={editor.canUndo}
          canRedo={editor.canRedo}
        />
      )}
      <div className="gb-workspace">
        <div className="gb-flow" ref={container}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onSelectionChange={onSelectionChange}
            onNodeDragStop={(_e, _node, dragged) =>
              void editor.apply(dragged.filter((n) => !n.id.startsWith("group:")).flatMap((n) => moveOps(board, n.id, n.position)))
            }
            onConnect={(c) => c.source && c.target && void editor.apply(connectOps(board, c.source, c.target))}
            onConnectEnd={onConnectEnd}
            onDelete={({ nodes: ns, edges: es }) =>
              void editor.apply(deleteOps(board, ns.map((n) => n.id).filter((id) => !id.startsWith("group:")), es.map((e) => e.id)))
            }
            onNodeDoubleClick={(_e, node) => {
              if (!editable || node.id.startsWith("group:")) return;
              setSelection({ kind: "node", id: node.id });
              setTimeout(() => labelRef.current?.select(), 0);
            }}
            nodesDraggable={editable}
            nodesConnectable={editable}
            elementsSelectable={editable}
            deleteKeyCode={editable ? ["Delete", "Backspace"] : null}
            connectionMode={ConnectionMode.Loose}
            colorMode="system"
            fitView
            minZoom={0.1}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} />
            <Controls showInteractive={false} />
            {flow.nodes.length > MINIMAP_MIN_NODES && <MiniMap pannable zoomable />}
          </ReactFlow>
        </div>
        {editable && selection && <SidePanel board={board} selection={selection} onApply={(ops) => void editor.apply(ops)} labelRef={labelRef} />}
      </div>
    </div>
  );
}
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

/* editing */
.gb-canvas {
  display: flex;
  flex-direction: column;
}
.gb-editor {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.gb-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--stroke);
  background: var(--surface);
}
.gb-toolbar-label {
  font-size: 12px;
  color: var(--muted);
}
.gb-toolbar-gap {
  flex: 1;
}
.gb-tool,
.gb-panel button {
  font: inherit;
  font-size: 12px;
  padding: 4px 10px;
  border: 1px solid var(--stroke);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
}
.gb-tool:hover:not(:disabled),
.gb-panel button:hover {
  border-color: var(--accent);
}
.gb-tool:disabled {
  opacity: 0.45;
  cursor: default;
}
.gb-workspace {
  display: flex;
  flex: 1;
  min-height: 0;
}
.gb-flow {
  flex: 1;
  min-width: 0;
}
.gb-panel {
  width: 280px;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 12px 14px;
  border-left: 1px solid var(--stroke);
  background: var(--surface);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.gb-panel h2 {
  font-size: 14px;
  margin: 0;
  overflow-wrap: anywhere;
}
.gb-panel label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
.gb-panel input,
.gb-panel select,
.gb-panel textarea {
  font: inherit;
  font-size: 13px;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--stroke);
  border-radius: 6px;
  padding: 5px 7px;
}
.gb-panel .gb-danger {
  margin-top: 6px;
  color: var(--danger);
}
.gb-fields {
  border: 1px solid var(--stroke);
  border-radius: 6px;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.gb-fields legend {
  font-size: 12px;
  color: var(--muted);
}
/* Name and type share the first line; the key flags and remove button wrap onto the second. */
.gb-field-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  align-items: center;
  padding-bottom: 6px;
  border-bottom: 1px dashed var(--stroke);
}
.gb-field-row input:not([type="checkbox"]) {
  flex: 1 1 40%;
  min-width: 0;
}
.gb-panel .gb-check {
  flex-direction: row;
  align-items: center;
  gap: 2px;
  font-size: 10px;
}
.gb-toast {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  background: var(--danger-bg);
  color: var(--danger);
  font-size: 13px;
}
.gb-toast button {
  margin-left: auto;
  border: none;
  background: none;
  color: inherit;
  font-size: 16px;
  cursor: pointer;
}
.gb-handle.gb-connectable {
  width: 10px;
  height: 10px;
  background: var(--accent);
  border: 2px solid var(--surface);
}
.react-flow__node:hover .gb-handle.gb-connectable,
.react-flow__node.selected .gb-handle.gb-connectable,
.react-flow__handle.connectingfrom,
.react-flow__handle.connectingto {
  opacity: 1;
  pointer-events: auto;
}
.gb-handle.gb-connectable {
  pointer-events: auto;
}
.react-flow__node.selected > .gb-node,
.react-flow__node.selected > .gb-entity,
.react-flow__node.selected .gb-participant-head {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.react-flow__edge.selected path {
  stroke: var(--accent);
}
```

`web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>gabiro</title>
    <link rel="icon" href="data:," />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The canvas web app lives in web/ and is built into dist/web, which `gabiro serve` serves.
// `npm run dev:web` serves it with hot reload and proxies the API to a running `gabiro serve`.
export default defineConfig({
  root: "web",
  plugins: [react()],
  // The bundle includes the core validation (zod) so canvas edits fail fast with the same messages
  // agents get; ~160 KB gzipped is fine for a local app, so the default 500 KB warning is raised.
  build: { outDir: "../dist/web", emptyOutDir: true, chunkSizeWarningLimit: 800 },
  server: {
    proxy: {
      // The canvas server only accepts its own Host and Origin, so rewrite both.
      "/api": { target: "http://127.0.0.1:4477", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:4477", ws: true, changeOrigin: true, headers: { origin: "http://127.0.0.1:4477" } },
    },
  },
});
```

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck && npm run build 2>&1 | grep -iE "warn|error"; npm test`
Expected: typechecks clean; the build prints no warnings (the grep finds nothing); all tests pass (22 files, 175 tests). The browser test in Task 7 covers the UI.

- [ ] **Step 4: Commit**

```bash
git add web/src/useEditor.ts web/src/Toolbar.tsx web/src/SidePanel.tsx web/src/BoardView.tsx web/src/styles.css web/index.html vite.config.ts
git commit -m "feat(web): edit boards in the canvas" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

### Task 7: Browser editing test and README

**Files:**
- Create (test): `test/e2e/editing.test.ts`
- Modify: `README.md`

The browser test drives the built app like a user would:
1. Drag a node (it gets pinned).
2. Add a node from the palette and rename it by double-clicking.
3. Edit a node's details in the side panel.
4. Connect two nodes by dropping onto the other node.
5. Delete with the Delete key, then undo and redo.
6. Edit again after an agent has changed the board, so the edit is re-applied after a conflict.
7. Run auto-layout, and check that pinned nodes stay put and there are no page errors.

It owns its temp dir, because `tempRoot()` is cleaned after every test and the suite shares one board across steps.

- [ ] **Step 1: Write the browser test**

`test/e2e/editing.test.ts`:

```ts
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Board } from "../../src/core/index.js";
import { startCanvasServer, type CanvasServer } from "../../src/server/index.js";
import { BoardService } from "../../src/service/index.js";
import { findChromium } from "./browser.js";

const webDir = fileURLToPath(new URL("../../dist/web", import.meta.url));
const chromiumPath = findChromium();

/** Polls the saved board until `check` passes (edits are saved asynchronously). */
async function until(svc: BoardService, check: (b: Board) => boolean, timeoutMs = 5000): Promise<Board> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const board = await svc.get("shop");
    if (check(board)) return board;
    if (Date.now() > deadline) throw new Error(`Board never reached the expected state: ${JSON.stringify(board.nodes.map((n) => n.id))}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);

async function dragBy(page: Page, id: string, dx: number, dy: number) {
  const box = (await node(page, id).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 12 });
  await page.mouse.up();
}

describe.skipIf(!existsSync(join(webDir, "index.html")) || !chromiumPath)("canvas editing in a real browser (run `npm run build` first)", () => {
  // One board shared by the steps below, so this suite manages its own temp dir
  // (test/helpers' tempRoot() is cleaned after every test).
  let root: string;
  let server: CanvasServer;
  let svc: BoardService;
  let page: Page;
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  const errors: string[] = [];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "gabiro-edit-"));
    svc = new BoardService(root);
    await svc.create({
      title: "Shop",
      kind: "architecture",
      ops: [
        { op: "add_node", id: "web", type: "client", label: "Web App" },
        { op: "add_node", id: "api", type: "service", label: "Checkout API" },
        { op: "add_node", id: "db", type: "database", label: "Orders DB" },
        { op: "add_edge", from: "web", to: "api", type: "sync" },
        { op: "add_edge", from: "api", to: "db", type: "sync" },
      ],
    });
    server = await startCanvasServer({ root, port: 0, webDir, recordInfo: false });
    browser = await chromium.launch({ executablePath: chromiumPath });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${server.url}/b/shop`);
    await page.getByText("● live").waitFor();
    await node(page, "api").waitFor();
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    await rm(root, { recursive: true, force: true });
  });

  it("drags a node and pins it where it was dropped", async () => {
    const before = (await svc.get("shop")).nodes.find((n) => n.id === "api")!.position!;
    await dragBy(page, "api", 120, 140);
    const saved = await until(svc, (b) => b.nodes.find((n) => n.id === "api")!.pinned === true);
    const after = saved.nodes.find((n) => n.id === "api")!.position!;
    expect(after.y).toBeGreaterThan(before.y + 50);
  }, 15_000);

  it("adds a node from the palette and renames it by double-clicking", async () => {
    await page.getByRole("toolbar").getByRole("button", { name: "cache", exact: true }).click();
    await until(svc, (b) => b.nodes.some((n) => n.id === "new-cache"));
    await node(page, "new-cache").dblclick();
    const label = page.getByRole("complementary", { name: "Selected node" }).getByLabel("Label");
    await expect.poll(() => label.evaluate((el) => el === document.activeElement)).toBe(true);
    await label.fill("Redis");
    await label.press("Enter");
    await until(svc, (b) => b.nodes.find((n) => n.id === "new-cache")?.label === "Redis");
  }, 15_000);

  it("edits details in the side panel", async () => {
    await node(page, "db").click();
    const panel = page.getByRole("complementary", { name: "Selected node" });
    await panel.getByLabel("Tech").fill("PostgreSQL 16");
    await panel.getByLabel("Tech").press("Enter");
    await until(svc, (b) => b.nodes.find((n) => n.id === "db")?.tech === "PostgreSQL 16");
  }, 15_000);

  it("connects two nodes by dragging from a handle onto the other node", async () => {
    // Close the side panel (click empty canvas) and fit everything into view first.
    await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
    await page.getByRole("button", { name: "Fit View" }).click();
    await node(page, "db").hover();
    const handle = node(page, "db").locator(".react-flow__handle.source");
    const from = (await handle.boundingBox())!;
    const to = (await node(page, "new-cache").boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
    await page.mouse.up();
    await until(svc, (b) => b.edges.some((e) => e.from === "db" && e.to === "new-cache"));
  }, 15_000);

  it("deletes with the Delete key, then undoes and redoes", async () => {
    await node(page, "new-cache").click();
    await page.keyboard.press("Delete");
    await until(svc, (b) => !b.nodes.some((n) => n.id === "new-cache") && !b.edges.some((e) => e.to === "new-cache"));
    await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
    await page.keyboard.press("Control+z");
    const restored = await until(svc, (b) => b.nodes.some((n) => n.id === "new-cache"));
    expect(restored.nodes.find((n) => n.id === "new-cache")?.label).toBe("Redis");
    expect(restored.edges.some((e) => e.from === "db" && e.to === "new-cache")).toBe(true);
    await page.keyboard.press("Control+Shift+z");
    await until(svc, (b) => !b.nodes.some((n) => n.id === "new-cache"));
  }, 20_000);

  it("keeps editing after an agent changes the board (conflict re-applied)", async () => {
    await svc.applyChanges("shop", [{ op: "add_node", id: "agent-note", type: "sticky", label: "Agent was here" }]);
    await page.getByText("Agent was here").waitFor();
    await svc.applyChanges("shop", [{ op: "update_node", id: "agent-note", label: "Agent was here again" }]);
    // The page may not have the newest revision yet; the edit must still land.
    await node(page, "web").click();
    const panel = page.getByRole("complementary", { name: "Selected node" });
    await panel.getByLabel("Description").fill("SPA served by CDN");
    await panel.getByLabel("Label").click();
    await until(svc, (b) => b.nodes.find((n) => n.id === "web")?.description === "SPA served by CDN");
  }, 15_000);

  it("re-runs auto-layout without moving pinned nodes, and reported no page errors", async () => {
    const pinned = (await svc.get("shop")).nodes.find((n) => n.id === "api")!.position;
    const revision = (await svc.get("shop")).revision;
    await page.getByRole("button", { name: "Auto-layout" }).click();
    const after = await until(svc, (b) => b.revision > revision);
    expect(after.nodes.find((n) => n.id === "api")!.position).toEqual(pinned);
    expect(errors).toEqual([]);
  }, 15_000);
});
```

- [ ] **Step 2: Build and run it**

Run: `npm run build && npx vitest run test/e2e/editing.test.ts`
Expected: 7 tests pass. Run the file 3 times to confirm stability. Chromium comes from `$GABIRO_CHROMIUM`, `/opt/pw-browsers/chromium`, or a Playwright install; the test is skipped when none is found.

- [ ] **Step 3: Update the README**

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
- **Auto-layout**: tidy everything except the nodes you pinned.

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
````

- [ ] **Step 4: Full verification**

Run: `npm run typecheck && npm run build && npm test`
Expected: all pass (23 files, 182 tests). Afterwards `ps -eo pid,args | grep "cli.js serve" | grep -v grep` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/editing.test.ts README.md
git commit -m "test(e2e): edit boards in a real browser; README editing guide" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

### Task 8: Try it by hand

**Files:**

- [ ] **Step 1: Run the canvas on a real board**

```bash
npm run build
node dist/cli.js serve --root /tmp/gabiro-edit-demo --open
```

In another terminal, have an agent create a board (or use `gabiro_create_board` via the MCP server) in `/tmp/gabiro-edit-demo`.

- [ ] **Step 2: Check each gesture**

- Drag a node, then click Auto-layout: the node stays put.
- Add, rename, connect and delete.
- Use ⌘Z/⇧⌘Z, or Ctrl+Z / Ctrl+Shift+Z.
- Edit ERD fields in the side panel.
- Have the agent change the board while a node is selected: the panel shows the agent's change unless you're typing in that field.

Note anything that feels wrong for follow-up.

---

## Out of scope (possible later work)
- Dragging a node into or out of a zone to change its group (the side panel's Group select covers this for now).
- Group editing: rename, add or delete zones and columns from the canvas.
- Multi-select alignment tools, and copy/paste.
- Presence and cursors for several people. The Mac Dock app is Plan 4.
