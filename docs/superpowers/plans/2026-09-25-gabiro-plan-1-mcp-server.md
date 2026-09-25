# Gabiro Plan 1: Headless MCP Server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `gabiro mcp`, a stdio MCP server that lets AI agents create and edit seven kinds of diagram boards stored as JSON in the project, auto-laid out with ELK and auto-exported to Mermaid Markdown.

**Architecture:** A pure `core` (Zod schema, validation, atomic ops) with no I/O; `layout` (elkjs) and `export` (Mermaid/Markdown) are pure functions over a `Board`; `store` persists boards as files with atomic writes, a cross-process lock and revisions; `service` is the single orchestration point used by the `mcp` tools (and, in Plan 2, by the canvas server). Spec: `docs/superpowers/specs/2026-09-25-gabiro-design.md`.

**Tech Stack:** TypeScript 5.9 (ESM, NodeNext), Node ≥ 20, `@modelcontextprotocol/sdk` 1.x, Zod 4, elkjs 0.12, Vitest.

**Scope:** Spec build-order steps 1–3 (core, store, export, mcp, layout). The canvas (`server/`, `web/`, `gabiro serve`, `gabiro_open_board`) is **Plan 2**.

**Verified:** Every code block in this plan was compiled and run before the plan was written: 71 tests pass, `tsc --noEmit` is clean, the Mermaid output for all six diagram kinds parses and renders with the real Mermaid library, and the built CLI works as a stdio MCP server.

---

## File structure

```
package.json, tsconfig.json, tsconfig.build.json, .gitignore, README.md
src/
  version.ts                 VERSION constant
  cli.ts                     `gabiro mcp [--root]` entry point
  core/                      pure domain — no I/O
    errors.ts                GabiroError (code + actionable message)
    kinds.ts                 KINDS and allowed node/edge/group types per kind
    schema.ts                Zod schemas + types for Board, nodes, edges, groups
    board.ts                 slugify, createBoard
    validate.ts              validateBoard: references, uniqueness, kind rules
    ops.ts                   OpSchema, applyOps (atomic batch)
    summary.ts               summarizeBoard (compact text for agents)
    index.ts                 barrel
  export/  mermaid.ts, markdown.ts, index.ts
  layout/  sizes.ts (nodeSize), layout.ts (layoutBoard), index.ts
  store/   store.ts (BoardStore interface), fs-utils.ts (atomic write, file lock),
           file-store.ts (FileStore), config.ts (loadConfig), index.ts
  service/ board-service.ts (BoardService), index.ts
  mcp/     help.ts (tool help text), tools.ts (registerTools), server.ts (createMcpServer, runStdioServer)
test/
  helpers.ts                 tempRoot()
  fixtures/boards.ts         one sample board per kind
  core/*, export/* (+ golden/*.mmd), layout/*, store/*, service/*, mcp/*, e2e/stdio.test.ts
```

Conventions: ESM with `.js` import suffixes (NodeNext). Tests import from module barrels (`src/core/index.js`). Every expected failure is a `GabiroError` whose message says what's wrong and how to fix it.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `.gitignore`
- Create: `src/version.ts`
- Test: `test/version.test.ts`

- [ ] **Step 1: Create project files**

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
    "node": ">=20"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.1",
    "elkjs": "^0.12.0",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@types/node": "^22.20.4",
    "typescript": "~5.9.3",
    "vitest": "^5.0.2"
  }
}
```

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src", "test"]
}
```

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "rootDir": "src" },
  "include": ["src"]
}
```

```text
# .gitignore
node_modules/
dist/
*.tmp
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` written, 0 vulnerabilities.


- [ ] **Step 3: Write the failing test**

```ts
// test/version.test.ts
import { expect, it } from "vitest";
import { VERSION } from "../src/version.js";

it("exposes a semver version", () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run test/version.test.ts`
Expected: FAIL — cannot resolve "../src/version.js"

- [ ] **Step 5: Implement**

```ts
// src/version.ts
export const VERSION = "0.1.0";
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/version.test.ts && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json .gitignore src/version.ts test/version.test.ts
git commit -m "chore: scaffold TypeScript package with vitest"
```

### Task 2: Core types: errors, kinds, schema, createBoard

**Files:**
- Create: `src/core/errors.ts`
- Create: `src/core/kinds.ts`
- Create: `src/core/schema.ts`
- Create: `src/core/board.ts`
- Create: `src/core/index.ts`
- Test: `test/core/board.test.ts`

Board kinds and their allowed types live in one table (`KIND_RULES`); schemas accept the union of all types, and `validateBoard` (next task) enforces the per-kind subset. This task also creates the `src/core/index.ts` barrel; later tasks append to it.

- [ ] **Step 1: Write the failing test**

```ts
// test/core/board.test.ts
import { describe, expect, it } from "vitest";
import { createBoard, slugify } from "../../src/core/index.js";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Checkout – Architecture!")).toBe("checkout-architecture");
  });
  it("rejects text with no usable characters", () => {
    expect(() => slugify("!!!")).toThrow(/explicit id/);
  });
});

describe("createBoard", () => {
  it("creates an empty board at revision 1 with a slug id", () => {
    const b = createBoard({ title: "Checkout API", kind: "architecture", now: "2026-01-01T00:00:00.000Z" });
    expect(b).toEqual({
      id: "checkout-api",
      title: "Checkout API",
      kind: "architecture",
      revision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      layout: { direction: "LR" },
      groups: [],
      nodes: [],
      edges: [],
    });
  });
  it("defaults flowcharts to top-to-bottom", () => {
    expect(createBoard({ title: "Signup", kind: "flowchart" }).layout.direction).toBe("TB");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/core/board.test.ts`
Expected: FAIL — cannot resolve "../../src/core/index.js"

- [ ] **Step 3: Implement**

```ts
// src/core/errors.ts
export type GabiroErrorCode = "VALIDATION" | "NOT_FOUND" | "EXISTS" | "CONFLICT" | "CORRUPT";

/** An expected, user-facing error. `message` always says what went wrong and how to fix it. */
export class GabiroError extends Error {
  constructor(
    public readonly code: GabiroErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GabiroError";
  }
}
```

```ts
// src/core/kinds.ts
export const KINDS = ["architecture", "flowchart", "sequence", "erd", "mindmap", "freeform", "kanban"] as const;
export type Kind = (typeof KINDS)[number];

export interface KindRules {
  nodeTypes: readonly string[];
  edgeTypes: readonly string[];
  groupTypes: readonly string[];
}

/** Which node/edge/group types each board kind allows. `sticky` is allowed on every kind. */
export const KIND_RULES: Record<Kind, KindRules> = {
  architecture: {
    nodeTypes: ["client", "gateway", "service", "function", "database", "cache", "queue", "storage", "external", "sticky"],
    edgeTypes: ["sync", "async", "data", "dependency"],
    groupTypes: ["zone", "boundary"],
  },
  flowchart: {
    nodeTypes: ["start", "end", "step", "decision", "io", "subprocess", "sticky"],
    edgeTypes: ["flow"],
    groupTypes: ["lane"],
  },
  sequence: { nodeTypes: ["participant", "sticky"], edgeTypes: ["message"], groupTypes: [] },
  erd: { nodeTypes: ["entity", "sticky"], edgeTypes: ["relation"], groupTypes: [] },
  mindmap: { nodeTypes: ["topic", "sticky"], edgeTypes: ["branch"], groupTypes: [] },
  freeform: { nodeTypes: ["sticky", "text", "shape"], edgeTypes: ["link"], groupTypes: ["frame"] },
  kanban: { nodeTypes: ["card", "sticky"], edgeTypes: [], groupTypes: ["column"] },
};

const unique = (xs: string[]) => [...new Set(xs)];
export const ALL_NODE_TYPES = unique(KINDS.flatMap((k) => KIND_RULES[k].nodeTypes)) as [string, ...string[]];
export const ALL_EDGE_TYPES = unique(KINDS.flatMap((k) => KIND_RULES[k].edgeTypes)) as [string, ...string[]];
export const ALL_GROUP_TYPES = unique(KINDS.flatMap((k) => KIND_RULES[k].groupTypes)) as [string, ...string[]];

/** Kinds whose rules allow the given node type, for "did you mean" hints. */
export function kindsAllowingNodeType(type: string): Kind[] {
  return KINDS.filter((k) => KIND_RULES[k].nodeTypes.includes(type) && type !== "sticky");
}
```

```ts
// src/core/schema.ts
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

```ts
// src/core/board.ts
import { GabiroError } from "./errors.js";
import type { Kind } from "./kinds.js";
import type { Board, Direction } from "./schema.js";

/** "Checkout – Architecture!" -> "checkout-architecture" */
export function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  if (!slug) {
    throw new GabiroError("VALIDATION", `Cannot derive an id from "${text}". Pass an explicit id like "my-board".`);
  }
  return slug;
}

export interface NewBoardInput {
  title: string;
  kind: Kind;
  id?: string;
  direction?: Direction;
  now?: string;
}

export function createBoard(input: NewBoardInput): Board {
  const now = input.now ?? new Date().toISOString();
  return {
    id: input.id ?? slugify(input.title),
    title: input.title,
    kind: input.kind,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    layout: { direction: input.direction ?? (input.kind === "flowchart" ? "TB" : "LR") },
    groups: [],
    nodes: [],
    edges: [],
  };
}
```

Create the barrel with the modules that exist so far:

```ts
// src/core/index.ts
export * from "./errors.js";
export * from "./kinds.js";
export * from "./schema.js";
export * from "./board.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/core/board.test.ts && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/index.ts src/core/errors.ts src/core/kinds.ts src/core/schema.ts src/core/board.ts test/core/board.test.ts
git commit -m "feat(core): board schema, kind rules and createBoard"
```

### Task 3: Board validation

**Files:**
- Create: `src/core/validate.ts`
- Modify: `src/core/index.ts`
- Test: `test/core/validate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/core/validate.test.ts
import { describe, expect, it } from "vitest";
import { createBoard, validateBoard, type Board } from "../../src/core/index.js";

function board(kind: Board["kind"], patch: Partial<Board>): Board {
  return { ...createBoard({ title: "T", kind, id: "t" }), ...patch };
}

describe("validateBoard", () => {
  it("accepts a valid architecture board", () => {
    const b = board("architecture", {
      groups: [{ id: "backend", label: "Backend", type: "zone" }],
      nodes: [
        { id: "api", type: "service", label: "API", groupId: "backend" },
        { id: "db", type: "database", label: "DB" },
      ],
      edges: [{ id: "api->db", from: "api", to: "db", type: "sync" }],
    });
    expect(validateBoard(b)).toEqual(b);
  });

  it("rejects duplicate node ids", () => {
    const b = board("architecture", {
      nodes: [
        { id: "api", type: "service", label: "A" },
        { id: "api", type: "service", label: "B" },
      ],
    });
    expect(() => validateBoard(b)).toThrow(/Duplicate node id "api"/);
  });

  it("rejects a node type from another kind and suggests the right kind", () => {
    const b = board("flowchart", { nodes: [{ id: "db", type: "database", label: "DB" }] });
    expect(() => validateBoard(b)).toThrow(/isn't valid on a flowchart board.*Did you mean a architecture board\?/);
  });

  it("allows sticky notes on every kind", () => {
    for (const kind of ["architecture", "flowchart", "sequence", "erd", "mindmap", "freeform", "kanban"] as const) {
      expect(() => validateBoard(board(kind, { nodes: [{ id: "n", type: "sticky", label: "note" }] }))).not.toThrow();
    }
  });

  it("rejects edges to missing nodes", () => {
    const b = board("architecture", {
      nodes: [{ id: "api", type: "service", label: "API" }],
      edges: [{ id: "x", from: "api", to: "ghost", type: "sync" }],
    });
    expect(() => validateBoard(b)).toThrow(/points at node "ghost"/);
  });

  it("rejects unknown groupId and parentId", () => {
    expect(() =>
      validateBoard(board("architecture", { nodes: [{ id: "a", type: "service", label: "A", groupId: "nope" }] })),
    ).toThrow(/groupId "nope"/);
    expect(() =>
      validateBoard(board("architecture", { groups: [{ id: "g", label: "G", type: "zone", parentId: "nope" }] })),
    ).toThrow(/parentId "nope"/);
  });

  it("rejects group parent cycles", () => {
    const b = board("architecture", {
      groups: [
        { id: "a", label: "A", type: "zone", parentId: "b" },
        { id: "b", label: "B", type: "zone", parentId: "a" },
      ],
    });
    expect(() => validateBoard(b)).toThrow(/cycle/);
  });

  it("enforces kind-specific rules", () => {
    expect(() =>
      validateBoard(board("erd", { nodes: [{ id: "n", type: "sticky", label: "x", fields: [{ name: "id", type: "int" }] }] })),
    ).toThrow(/only ERD "entity" nodes/);
    expect(() =>
      validateBoard(
        board("sequence", {
          nodes: [
            { id: "a", type: "participant", label: "A" },
            { id: "b", type: "participant", label: "B" },
          ],
          edges: [{ id: "m", from: "a", to: "b", type: "message" }],
        }),
      ),
    ).toThrow(/needs an "order"/);
    expect(() => validateBoard(board("kanban", { nodes: [{ id: "c", type: "card", label: "C" }] }))).toThrow(
      /must be in a column/,
    );
  });

  it("rejects malformed ids", () => {
    expect(() => validateBoard(board("architecture", { nodes: [{ id: "Bad Id", type: "service", label: "x" }] }))).toThrow(
      /lowercase slug/,
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/core/validate.test.ts`
Expected: FAIL — `validateBoard` is not exported from src/core/index.js

- [ ] **Step 3: Implement**

```ts
// src/core/validate.ts
import { GabiroError } from "./errors.js";
import { KIND_RULES, kindsAllowingNodeType } from "./kinds.js";
import { BoardSchema, type Board } from "./schema.js";

const list = (xs: readonly string[]) => (xs.length ? xs.join(", ") : "(none)");

function fail(message: string): never {
  throw new GabiroError("VALIDATION", message);
}

function assertUnique(kind: string, ids: string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) fail(`Duplicate ${kind} id "${id}". Ids must be unique within a board; pick another id.`);
    seen.add(id);
  }
}

/** Parses the board shape and enforces every cross-reference and kind rule. Returns the parsed board. */
export function validateBoard(input: unknown): Board {
  const parsed = BoardSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    fail(`Invalid board at "${issue.path.join(".")}": ${issue.message}`);
  }
  const board = parsed.data;
  const rules = KIND_RULES[board.kind];

  assertUnique("node", board.nodes.map((n) => n.id));
  assertUnique("edge", board.edges.map((e) => e.id));
  assertUnique("group", board.groups.map((g) => g.id));

  const groupIds = new Set(board.groups.map((g) => g.id));
  const nodeIds = new Set(board.nodes.map((n) => n.id));

  for (const g of board.groups) {
    if (!rules.groupTypes.includes(g.type)) {
      fail(`Group type "${g.type}" isn't valid on a ${board.kind} board. Valid group types: ${list(rules.groupTypes)}.`);
    }
    if (g.parentId !== undefined && !groupIds.has(g.parentId)) {
      fail(`Group "${g.id}" has parentId "${g.parentId}", which doesn't exist. Add that group first or drop parentId.`);
    }
  }
  for (const g of board.groups) {
    const seen = new Set<string>([g.id]);
    let parent = g.parentId;
    while (parent !== undefined) {
      if (seen.has(parent)) fail(`Group "${g.id}" is part of a parentId cycle. A group can't contain itself.`);
      seen.add(parent);
      parent = board.groups.find((x) => x.id === parent)?.parentId;
    }
  }

  for (const n of board.nodes) {
    if (!rules.nodeTypes.includes(n.type)) {
      const other = kindsAllowingNodeType(n.type);
      const hint = other.length ? ` Did you mean a ${other.join(" or ")} board?` : "";
      fail(`Node type "${n.type}" isn't valid on a ${board.kind} board. Valid node types: ${list(rules.nodeTypes)}.${hint}`);
    }
    if (n.groupId !== undefined && !groupIds.has(n.groupId)) {
      fail(`Node "${n.id}" has groupId "${n.groupId}", which doesn't exist. Add the group first or drop groupId.`);
    }
    if (n.fields !== undefined && n.type !== "entity") {
      fail(`Node "${n.id}" has fields, but only ERD "entity" nodes can have fields.`);
    }
    if (board.kind === "kanban" && n.type === "card" && n.groupId === undefined) {
      fail(`Kanban card "${n.id}" must be in a column. Set groupId to a column id (${list(board.groups.map((g) => g.id))}).`);
    }
  }

  for (const e of board.edges) {
    if (!rules.edgeTypes.includes(e.type)) {
      fail(`Edge type "${e.type}" isn't valid on a ${board.kind} board. Valid edge types: ${list(rules.edgeTypes)}.`);
    }
    for (const end of [e.from, e.to]) {
      if (!nodeIds.has(end)) {
        fail(`Edge "${e.id}" points at node "${end}", which doesn't exist. Existing nodes: ${list([...nodeIds])}.`);
      }
    }
    if (e.cardinality !== undefined && e.type !== "relation") {
      fail(`Edge "${e.id}" has a cardinality, but only ERD "relation" edges can have one.`);
    }
    if (e.type === "message" && e.order === undefined) {
      fail(`Sequence message "${e.id}" needs an "order" (1, 2, 3, ...) so messages are drawn top to bottom.`);
    }
  }

  return board;
}
```

Append to `src/core/index.ts`:

```ts
export * from "./validate.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/core/validate.test.ts && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/index.ts src/core/validate.ts test/core/validate.test.ts
git commit -m "feat(core): validate references, uniqueness and kind rules"
```

### Task 4: Atomic ops

**Files:**
- Create: `src/core/ops.ts`
- Modify: `src/core/index.ts`
- Test: `test/core/ops.test.ts`

`applyOps` works on a `structuredClone`, validates after every op, and rethrows errors prefixed with the op index, so a batch is all-or-nothing and the agent knows which op to fix.

- [ ] **Step 1: Write the failing test**

```ts
// test/core/ops.test.ts
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
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/core/ops.test.ts`
Expected: FAIL — `applyOps` is not exported from src/core/index.js

- [ ] **Step 3: Implement**

```ts
// src/core/ops.ts
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
  NodeSchema.extend({ op: z.literal("add_node") }),
  NodePatch.extend({ op: z.literal("update_node"), id: SlugSchema }),
  z.object({ op: z.literal("remove_node"), id: SlugSchema }),
  EdgeSchema.extend({ op: z.literal("add_edge"), id: EdgeSchema.shape.id.optional() }),
  EdgePatch.extend({ op: z.literal("update_edge"), id: EdgeSchema.shape.id }),
  z.object({ op: z.literal("remove_edge"), id: EdgeSchema.shape.id }),
  GroupSchema.extend({ op: z.literal("add_group") }),
  GroupPatch.extend({ op: z.literal("update_group"), id: SlugSchema }),
  z.object({ op: z.literal("remove_group"), id: SlugSchema, cascade: z.boolean().optional() }),
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

Append to `src/core/index.ts`:

```ts
export * from "./ops.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/core/ops.test.ts && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/index.ts src/core/ops.ts test/core/ops.test.ts
git commit -m "feat(core): atomic applyOps with actionable per-op errors"
```

### Task 5: Board summary

**Files:**
- Create: `src/core/summary.ts`
- Modify: `src/core/index.ts`
- Test: `test/core/summary.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/core/summary.test.ts
import { expect, it } from "vitest";
import { applyOps, createBoard, summarizeBoard } from "../../src/core/index.js";

it("summarizes a board one line per entity", () => {
  const b = applyOps(createBoard({ title: "Shop", kind: "architecture", id: "shop" }), [
    { op: "add_group", id: "backend", label: "Backend", type: "zone" },
    { op: "add_node", id: "api", type: "service", label: "API", tech: "Go", groupId: "backend", description: "Stateless" },
    { op: "add_node", id: "db", type: "database", label: "DB" },
    { op: "add_edge", from: "api", to: "db", type: "sync", label: "SQL" },
  ]);
  expect(summarizeBoard(b)).toBe(
    [
      'board shop "Shop" kind=architecture direction=LR revision=1',
      'group backend [zone] "Backend"',
      'node api [service] "API" (Go) in backend — Stateless',
      'node db [database] "DB"',
      'edge api->db [sync] api -> db "SQL"',
    ].join("\n"),
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/core/summary.test.ts`
Expected: FAIL — `summarizeBoard` is not exported from src/core/index.js

- [ ] **Step 3: Implement**

```ts
// src/core/summary.ts
import type { Board, BoardEdge, BoardNode } from "./schema.js";

const q = (s: string) => JSON.stringify(s);

function nodeLine(n: BoardNode): string {
  let line = `node ${n.id} [${n.type}] ${q(n.label)}`;
  if (n.tech) line += ` (${n.tech})`;
  if (n.groupId) line += ` in ${n.groupId}`;
  if (n.order !== undefined) line += ` order=${n.order}`;
  if (n.pinned) line += " pinned";
  if (n.tags?.length) line += ` tags=${n.tags.join(",")}`;
  if (n.fields?.length) {
    const fields = n.fields.map((f) => `${f.name}:${f.type}${f.pk ? " PK" : ""}${f.fk ? " FK" : ""}${f.nullable ? "?" : ""}`);
    line += ` fields=[${fields.join(", ")}]`;
  }
  if (n.description) line += ` — ${n.description}`;
  return line;
}

function edgeLine(e: BoardEdge): string {
  let line = `edge ${e.id} [${e.type}] ${e.from} -> ${e.to}`;
  if (e.label) line += ` ${q(e.label)}`;
  if (e.order !== undefined) line += ` order=${e.order}`;
  if (e.cardinality) line += ` ${e.cardinality}`;
  if (e.style) line += ` ${e.style}`;
  return line;
}

/** Compact, line-per-entity text view of a board — cheap for an agent's context. */
export function summarizeBoard(board: Board): string {
  const lines = [
    `board ${board.id} ${q(board.title)} kind=${board.kind} direction=${board.layout.direction} revision=${board.revision}`,
    ...board.groups.map((g) => `group ${g.id} [${g.type}] ${q(g.label)}${g.parentId ? ` in ${g.parentId}` : ""}`),
    ...board.nodes.map(nodeLine),
    ...board.edges.map(edgeLine),
  ];
  if (!board.nodes.length) lines.push("(empty board — add nodes with gabiro_apply_changes)");
  return lines.join("\n");
}
```

Append to `src/core/index.ts` (final barrel):

```ts
export * from "./summary.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/core/summary.test.ts && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/index.ts src/core/summary.ts test/core/summary.test.ts
git commit -m "feat(core): compact text summary for agents"
```

### Task 6: Test fixtures and Mermaid export

**Files:**
- Create: `test/fixtures/boards.ts`
- Create: `src/export/mermaid.ts`
- Create: `src/export/index.ts`
- Create: `test/export/golden/architecture.mmd`
- Create: `test/export/golden/flowchart.mmd`
- Create: `test/export/golden/sequence.mmd`
- Create: `test/export/golden/erd.mmd`
- Create: `test/export/golden/mindmap.mmd`
- Create: `test/export/golden/kanban.mmd`
- Test: `test/export/mermaid.test.ts`

Mermaid ids replace `-` with `_` and suffix reserved words with `_`, so a node with id `end` works. The golden files were checked with the real Mermaid parser and renderer.

- [ ] **Step 1: Add shared fixtures (one board per kind)**

```ts
// test/fixtures/boards.ts
import { applyOps, createBoard, type Board, type Kind } from "../../src/core/index.js";

const NOW = "2026-01-01T00:00:00.000Z";
const make = (kind: Kind, ops: unknown[]): Board =>
  applyOps(createBoard({ title: `Sample ${kind}`, kind, id: `sample-${kind}`, now: NOW }), ops);

/** One small but representative board per kind. Shared by export, layout and MCP tests. */
export const FIXTURES: Record<Kind, Board> = {
  architecture: make("architecture", [
    { op: "add_group", id: "backend", label: "Backend", type: "zone" },
    { op: "add_group", id: "data", label: "Data", type: "zone", parentId: "backend" },
    { op: "add_node", id: "web", type: "client", label: "Web App" },
    { op: "add_node", id: "api", type: "service", label: "Checkout API", tech: "Node", groupId: "backend", description: "Stateless" },
    { op: "add_node", id: "orders-db", type: "database", label: "Orders DB", groupId: "data" },
    { op: "add_node", id: "events", type: "queue", label: "Events", groupId: "backend" },
    { op: "add_node", id: "stripe", type: "external", label: "Stripe" },
    { op: "add_node", id: "note", type: "sticky", label: "Add a cache?" },
    { op: "add_edge", from: "web", to: "api", type: "sync", label: "HTTPS" },
    { op: "add_edge", from: "api", to: "orders-db", type: "sync" },
    { op: "add_edge", from: "api", to: "events", type: "async", label: "order.created" },
    { op: "add_edge", from: "api", to: "stripe", type: "sync" },
  ]),
  flowchart: make("flowchart", [
    { op: "add_node", id: "start", type: "start", label: "Start" },
    { op: "add_node", id: "valid", type: "decision", label: "Email valid?" },
    { op: "add_node", id: "send", type: "step", label: "Send \"welcome\" mail" },
    { op: "add_node", id: "end", type: "end", label: "Done" },
    { op: "add_edge", from: "start", to: "valid", type: "flow" },
    { op: "add_edge", from: "valid", to: "send", type: "flow", label: "yes" },
    { op: "add_edge", from: "valid", to: "end", type: "flow", label: "no" },
    { op: "add_edge", from: "send", to: "end", type: "flow" },
  ]),
  sequence: make("sequence", [
    { op: "add_node", id: "client", type: "participant", label: "Client", order: 1 },
    { op: "add_node", id: "api", type: "participant", label: "API", order: 2 },
    { op: "add_node", id: "db", type: "participant", label: "DB", order: 3 },
    { op: "add_edge", id: "m1", from: "client", to: "api", type: "message", label: "POST /orders", order: 1 },
    { op: "add_edge", id: "m2", from: "api", to: "db", type: "message", label: "INSERT order", order: 2 },
    { op: "add_edge", id: "m3", from: "api", to: "client", type: "message", label: "201 Created", order: 3, style: "dashed" },
  ]),
  erd: make("erd", [
    { op: "add_node", id: "users", type: "entity", label: "Users", fields: [{ name: "id", type: "uuid", pk: true }, { name: "email", type: "text" }] },
    { op: "add_node", id: "orders", type: "entity", label: "Orders", fields: [{ name: "id", type: "uuid", pk: true }, { name: "user_id", type: "uuid", fk: true }] },
    { op: "add_edge", from: "users", to: "orders", type: "relation", cardinality: "1-n", label: "places" },
  ]),
  mindmap: make("mindmap", [
    { op: "add_node", id: "product", type: "topic", label: "Product" },
    { op: "add_node", id: "growth", type: "topic", label: "Growth" },
    { op: "add_node", id: "seo", type: "topic", label: "SEO" },
    { op: "add_node", id: "infra", type: "topic", label: "Infra" },
    { op: "add_edge", from: "product", to: "growth", type: "branch" },
    { op: "add_edge", from: "growth", to: "seo", type: "branch" },
    { op: "add_edge", from: "product", to: "infra", type: "branch" },
  ]),
  freeform: make("freeform", [
    { op: "add_group", id: "ideas", label: "Ideas", type: "frame" },
    { op: "add_node", id: "idea-1", type: "sticky", label: "Offline mode", groupId: "ideas" },
    { op: "add_node", id: "idea-2", type: "sticky", label: "Dark theme", description: "Users keep asking" },
  ]),
  kanban: make("kanban", [
    { op: "add_group", id: "todo", label: "To Do", type: "column" },
    { op: "add_group", id: "done", label: "Done", type: "column" },
    { op: "add_node", id: "spec", type: "card", label: "Write spec", groupId: "done", order: 1 },
    { op: "add_node", id: "mcp", type: "card", label: "Build MCP", groupId: "todo", order: 2 },
    { op: "add_node", id: "core", type: "card", label: "Build core", groupId: "todo", order: 1 },
  ]),
};
```

- [ ] **Step 2: Add golden files**

`test/export/golden/architecture.mmd` (ends with a newline):

```text
flowchart LR
  subgraph backend["Backend"]
    subgraph data["Data"]
      orders_db[("Orders DB")]
    end
    api["Checkout API<br/><i>Node</i>"]
    events[["Events"]]
  end
  note_>"Add a cache?"]
  stripe{{"Stripe"}}
  web(["Web App"])
  api -.->|"order.created"| events
  api --> orders_db
  api --> stripe
  web -->|"HTTPS"| api
```

`test/export/golden/flowchart.mmd` (ends with a newline):

```text
flowchart TB
  end_(["Done"])
  send["Send #quot;welcome#quot; mail"]
  start(["Start"])
  valid{"Email valid?"}
  send --> end_
  start --> valid
  valid -->|"no"| end_
  valid -->|"yes"| send
```

`test/export/golden/sequence.mmd` (ends with a newline):

```text
sequenceDiagram
  participant client as Client
  participant api as API
  participant db as DB
  client->>api: POST /orders
  api->>db: INSERT order
  api-->>client: 201 Created
```

`test/export/golden/erd.mmd` (ends with a newline):

```text
erDiagram
  orders {
    uuid id PK
    uuid user_id FK
  }
  users {
    uuid id PK
    text email
  }
  users ||--o{ orders : "places"
```

`test/export/golden/mindmap.mmd` (ends with a newline):

```text
mindmap
  product(("Product"))
    growth["Growth"]
      seo["SEO"]
    infra["Infra"]
```

`test/export/golden/kanban.mmd` (ends with a newline):

```text
kanban
  todo[To Do]
    core[Build core]
    mcp[Build MCP]
  done[Done]
    spec[Write spec]
```


- [ ] **Step 3: Write the failing test**

```ts
// test/export/mermaid.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KINDS } from "../../src/core/index.js";
import { toMermaid } from "../../src/export/index.js";
import { FIXTURES } from "../fixtures/boards.js";

const golden = (kind: string) => readFileSync(new URL(`./golden/${kind}.mmd`, import.meta.url), "utf8");

describe("toMermaid", () => {
  for (const kind of KINDS.filter((k) => k !== "freeform")) {
    it(`matches the golden file for ${kind}`, () => {
      expect(toMermaid(FIXTURES[kind]) + "\n").toBe(golden(kind));
    });
  }

  it("returns null for freeform boards", () => {
    expect(toMermaid(FIXTURES.freeform)).toBeNull();
  });

  it("is independent of node insertion order", () => {
    const reversed = { ...FIXTURES.architecture, nodes: [...FIXTURES.architecture.nodes].reverse() };
    expect(toMermaid(reversed)).toBe(toMermaid(FIXTURES.architecture));
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run test/export/mermaid.test.ts`
Expected: FAIL — cannot resolve "../../src/export/index.js"

- [ ] **Step 5: Implement**

```ts
// src/export/mermaid.ts
import type { Board, BoardEdge, BoardGroup, BoardNode } from "../core/index.js";

/** Words Mermaid treats as keywords; used as ids they break the diagram. */
const RESERVED = new Set([
  "end", "graph", "flowchart", "subgraph", "direction", "style", "class", "classdef", "click", "linkstyle",
  "default", "call", "href", "participant", "actor", "loop", "alt", "opt", "else", "par", "and", "rect",
  "note", "critical", "break", "box", "autonumber", "activate", "deactivate", "title", "root",
]);

/** Mermaid-safe identifier: '-' becomes '_' (Mermaid reads '-' as arrows) and keywords get a '_' suffix. */
const mid = (id: string) => {
  const safe = id.replace(/-/g, "_");
  return RESERVED.has(safe) ? `${safe}_` : safe;
};

/** Text for a quoted Mermaid label. */
const text = (s: string) => s.replace(/"/g, "#quot;").replace(/\r?\n/g, "<br/>");

/** Text for unquoted contexts (sequence messages, kanban, ERD). */
const plain = (s: string) => s.replace(/[\r\n;#]+/g, " ").replace(/[[\]{}]/g, "").trim();

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byOrder = <T extends { id: string; order?: number }>(a: T, b: T) =>
  (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || byId(a, b);

const SHAPES: Record<string, [string, string]> = {
  client: ['(["', '"])'],
  gateway: ['[/"', '"\\]'],
  service: ['["', '"]'],
  function: ['>"', '"]'],
  database: ['[("', '")]'],
  cache: ['[("', '")]'],
  queue: ['[["', '"]]'],
  storage: ['[("', '")]'],
  external: ['{{"', '"}}'],
  start: ['(["', '"])'],
  end: ['(["', '"])'],
  step: ['["', '"]'],
  decision: ['{"', '"}'],
  io: ['[/"', '"/]'],
  subprocess: ['[["', '"]]'],
  sticky: ['>"', '"]'],
};

function flowNode(n: BoardNode): string {
  const [open, close] = SHAPES[n.type] ?? ['["', '"]'];
  const label = n.tech ? `${text(n.label)}<br/><i>${text(n.tech)}</i>` : text(n.label);
  return `${mid(n.id)}${open}${label}${close}`;
}

function flowEdge(e: BoardEdge): string {
  const dashed = e.style === "dashed" || (e.style === undefined && e.type === "async");
  const arrow = dashed ? "-.->" : "-->";
  const label = e.label ? `|"${text(e.label)}"|` : "";
  return `${mid(e.from)} ${arrow}${label} ${mid(e.to)}`;
}

function flowchart(board: Board): string {
  const lines = [`flowchart ${board.layout.direction}`];
  const nodes = [...board.nodes].sort(byId);
  const groups = [...board.groups].sort(byId);

  const emitGroup = (g: BoardGroup, depth: number) => {
    const pad = "  ".repeat(depth);
    lines.push(`${pad}subgraph ${mid(g.id)}["${text(g.label)}"]`);
    for (const child of groups.filter((c) => c.parentId === g.id)) emitGroup(child, depth + 1);
    for (const n of nodes.filter((x) => x.groupId === g.id)) lines.push(`${pad}  ${flowNode(n)}`);
    lines.push(`${pad}end`);
  };

  for (const g of groups.filter((x) => x.parentId === undefined)) emitGroup(g, 1);
  for (const n of nodes.filter((x) => x.groupId === undefined)) lines.push(`  ${flowNode(n)}`);
  for (const e of [...board.edges].sort(byId)) lines.push(`  ${flowEdge(e)}`);
  return lines.join("\n");
}

function sequence(board: Board): string {
  const lines = ["sequenceDiagram"];
  const participants = board.nodes.filter((n) => n.type === "participant").sort(byOrder);
  for (const p of participants) lines.push(`  participant ${mid(p.id)} as ${plain(p.label)}`);
  for (const m of [...board.edges].sort(byOrder)) {
    const arrow = m.style === "dashed" ? "-->>" : "->>";
    lines.push(`  ${mid(m.from)}${arrow}${mid(m.to)}: ${plain(m.label ?? "")}`);
  }
  const first = participants[0];
  if (first) {
    for (const s of board.nodes.filter((n) => n.type === "sticky").sort(byId)) {
      lines.push(`  Note over ${mid(first.id)}: ${plain(s.label)}`);
    }
  }
  return lines.join("\n");
}

const CARDINALITY: Record<string, string> = { "1-1": "||--||", "1-n": "||--o{", "n-n": "}o--o{" };
const word = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_");

function erd(board: Board): string {
  const lines = ["erDiagram"];
  for (const n of board.nodes.filter((x) => x.type === "entity").sort(byId)) {
    lines.push(`  ${mid(n.id)} {`);
    for (const f of n.fields ?? []) {
      const keys = [f.pk ? "PK" : "", f.fk ? "FK" : ""].filter(Boolean).join(", ");
      lines.push(`    ${word(f.type)} ${word(f.name)}${keys ? ` ${keys}` : ""}`);
    }
    lines.push("  }");
  }
  for (const e of [...board.edges].sort(byId)) {
    const rel = CARDINALITY[e.cardinality ?? "1-n"];
    lines.push(`  ${mid(e.from)} ${rel} ${mid(e.to)} : "${text(e.label ?? "")}"`);
  }
  return lines.join("\n");
}

function mindmap(board: Board): string {
  const topics = board.nodes.filter((n) => n.type === "topic").sort(byId);
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const e of [...board.edges].sort(byId)) {
    children.set(e.from, [...(children.get(e.from) ?? []), e.to]);
    hasParent.add(e.to);
  }
  const byNodeId = new Map(topics.map((t) => [t.id, t]));
  const roots = topics.filter((t) => !hasParent.has(t.id));
  const lines = ["mindmap"];
  const visited = new Set<string>();

  const emit = (id: string, depth: number) => {
    const t = byNodeId.get(id);
    if (!t || visited.has(id)) return;
    visited.add(id);
    const shape = depth === 1 ? [`((`, `))`] : [`[`, `]`];
    lines.push(`${"  ".repeat(depth)}${mid(id)}${shape[0]}"${text(t.label)}"${shape[1]}`);
    for (const c of children.get(id) ?? []) emit(c, depth + 1);
  };

  if (roots.length === 1) {
    emit(roots[0]!.id, 1);
  } else {
    lines.push(`  root(("${text(board.title)}"))`);
    for (const r of roots.length ? roots : topics) emit(r.id, 2);
  }
  return lines.join("\n");
}

function kanban(board: Board): string {
  const lines = ["kanban"];
  for (const col of board.groups) {
    lines.push(`  ${mid(col.id)}[${plain(col.label)}]`);
    for (const card of board.nodes.filter((n) => n.groupId === col.id).sort(byOrder)) {
      lines.push(`    ${mid(card.id)}[${plain(card.label)}]`);
    }
  }
  return lines.join("\n");
}

/** Mermaid source for a board, or null for kinds Mermaid can't draw (freeform). Output is deterministic. */
export function toMermaid(board: Board): string | null {
  switch (board.kind) {
    case "architecture":
    case "flowchart":
      return flowchart(board);
    case "sequence":
      return sequence(board);
    case "erd":
      return erd(board);
    case "mindmap":
      return mindmap(board);
    case "kanban":
      return kanban(board);
    case "freeform":
      return null;
  }
}
```

Create the export barrel (markdown is added in the next task, so export only mermaid for now):

```ts
// src/export/index.ts
export { toMermaid } from "./mermaid.js";
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/export/mermaid.test.ts && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/export/index.ts test/fixtures/boards.ts test/export/golden src/export/mermaid.ts test/export/mermaid.test.ts
git commit -m "feat(export): deterministic Mermaid for six diagram kinds"
```

### Task 7: Markdown export

**Files:**
- Create: `src/export/markdown.ts`
- Modify: `src/export/index.ts`
- Test: `test/export/markdown.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/export/markdown.test.ts
import { expect, it } from "vitest";
import { toMarkdown, toMermaid } from "../../src/export/index.js";
import { FIXTURES } from "../fixtures/boards.js";

it("wraps the Mermaid diagram with title, provenance, notes and details", () => {
  const md = toMarkdown(FIXTURES.architecture);
  expect(md).toBe(
    [
      "# Sample architecture",
      "",
      "> Generated by gabiro from `.gabiro/boards/sample-architecture.json` (revision 1). Edit the board, not this file.",
      "",
      "```mermaid",
      toMermaid(FIXTURES.architecture),
      "```",
      "",
      "## Notes",
      "",
      "- Add a cache?",
      "",
      "## Details",
      "",
      "- **Checkout API** _(Node)_ — Stateless",
      "",
    ].join("\n"),
  );
});

it("lists freeform items instead of a diagram", () => {
  expect(toMarkdown(FIXTURES.freeform)).toBe(
    [
      "# Sample freeform",
      "",
      "> Generated by gabiro from `.gabiro/boards/sample-freeform.json` (revision 1). Edit the board, not this file.",
      "",
      "## Items",
      "",
      "- Offline mode",
      "- **Dark theme** — Users keep asking",
      "",
    ].join("\n"),
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/export/markdown.test.ts`
Expected: FAIL — `toMarkdown` is not exported from src/export/index.js

- [ ] **Step 3: Implement**

```ts
// src/export/markdown.ts
import type { Board, BoardNode } from "../core/index.js";
import { toMermaid } from "./mermaid.js";

function noteLine(n: BoardNode): string {
  const tech = n.tech ? ` _(${n.tech})_` : "";
  return n.description ? `- **${n.label}**${tech} — ${n.description}` : `- ${n.label}${tech}`;
}

/** Markdown document for a board: title, Mermaid block, and notes that Mermaid can't show. */
export function toMarkdown(board: Board): string {
  const parts = [
    `# ${board.title}`,
    `> Generated by gabiro from \`.gabiro/boards/${board.id}.json\` (revision ${board.revision}). Edit the board, not this file.`,
  ];

  const mermaid = toMermaid(board);
  if (mermaid) parts.push("```mermaid\n" + mermaid + "\n```");

  const sortedNodes = [...board.nodes].sort((a, b) => (a.id < b.id ? -1 : 1));
  if (board.kind === "freeform") {
    const items = sortedNodes.map(noteLine);
    if (items.length) parts.push("## Items\n\n" + items.join("\n"));
  } else {
    const stickies = sortedNodes.filter((n) => n.type === "sticky").map((n) => `- ${n.label}`);
    if (stickies.length) parts.push("## Notes\n\n" + stickies.join("\n"));
    const details = sortedNodes.filter((n) => n.type !== "sticky" && n.description).map(noteLine);
    if (details.length) parts.push("## Details\n\n" + details.join("\n"));
  }
  return parts.join("\n\n") + "\n";
}
```

Replace `src/export/index.ts`:

```ts
// src/export/index.ts
export { toMermaid } from "./mermaid.js";
export { toMarkdown } from "./markdown.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/export/markdown.test.ts && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/export/index.ts src/export/markdown.ts test/export/markdown.test.ts
git commit -m "feat(export): Markdown document with Mermaid block and notes"
```

### Task 8: ELK auto-layout

**Files:**
- Create: `src/layout/sizes.ts`
- Create: `src/layout/layout.ts`
- Create: `src/layout/index.ts`
- Test: `test/layout/layout.test.ts`

Positions are absolute. Architecture/flowchart/ERD use ELK `layered` with groups as compound nodes; mindmap uses `mrtree`; sequence, kanban and freeform use simple deterministic placement. elkjs is CommonJS, so it is loaded with `createRequire` (a default import isn't constructable under NodeNext).

- [ ] **Step 1: Write the failing test**

```ts
// test/layout/layout.test.ts
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
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/layout/layout.test.ts`
Expected: FAIL — cannot resolve "../../src/layout/index.js"

- [ ] **Step 3: Implement**

```ts
// src/layout/sizes.ts
import type { BoardNode } from "../core/index.js";

export interface Size {
  width: number;
  height: number;
}

const SIZES: Record<string, Size> = {
  decision: { width: 150, height: 100 },
  database: { width: 160, height: 90 },
  cache: { width: 160, height: 90 },
  storage: { width: 160, height: 90 },
  start: { width: 140, height: 50 },
  end: { width: 140, height: 50 },
  sticky: { width: 160, height: 120 },
  text: { width: 200, height: 40 },
  topic: { width: 160, height: 50 },
  card: { width: 240, height: 80 },
  participant: { width: 160, height: 60 },
};

/** Rendered size of a node. The canvas uses the same numbers so layout and drawing agree. */
export function nodeSize(node: BoardNode): Size {
  if (node.type === "entity") return { width: 220, height: 44 + 26 * (node.fields?.length ?? 0) };
  return SIZES[node.type] ?? { width: 180, height: 70 };
}
```

```ts
// src/layout/layout.ts
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
      placed = await elkPositions(next);
  }
  for (const n of next.nodes) {
    const p = placed.get(n.id);
    if (p && (movable(n) || !n.position)) n.position = p;
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

async function elkPositions(board: Board): Promise<Map<string, Position>> {
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
  const out = new Map<string, Position>();
  const walk = (node: ElkNode, offset: Position) => {
    for (const child of node.children ?? []) {
      const abs = { x: offset.x + (child.x ?? 0), y: offset.y + (child.y ?? 0) };
      if (!child.id.startsWith("group:")) out.set(child.id, round(abs));
      walk(child, abs);
    }
  };
  walk(result, { x: 0, y: 0 });
  return out;
}
```

```ts
// src/layout/index.ts
export { layoutBoard, type LayoutMode } from "./layout.js";
export { nodeSize, type Size } from "./sizes.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/layout/layout.test.ts && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/layout/sizes.ts src/layout/layout.ts src/layout/index.ts test/layout/layout.test.ts
git commit -m "feat(layout): ELK layout with pinning and per-kind strategies"
```

### Task 9: File store

**Files:**
- Create: `test/helpers.ts`
- Create: `src/store/store.ts`
- Create: `src/store/fs-utils.ts`
- Create: `src/store/file-store.ts`
- Create: `src/store/config.ts`
- Create: `src/store/index.ts`
- Test: `test/store/file-store.test.ts`

- [ ] **Step 1: Add the temp-directory test helper**

```ts
// test/helpers.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

const dirs: string[] = [];

/** A fresh temp project root, removed after each test. */
export async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gabiro-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
```


- [ ] **Step 2: Write the failing test**

```ts
// test/store/file-store.test.ts
import { mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyOps, createBoard, GabiroError } from "../../src/core/index.js";
import { FileStore, loadConfig, withFileLock } from "../../src/store/index.js";
import { tempRoot } from "../helpers.js";

const NOW = "2026-01-01T00:00:00.000Z";
const store = (root: string) => new FileStore(root, () => NOW);
const newBoard = (id = "shop") => createBoard({ title: "Shop", kind: "architecture", id });

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return e instanceof GabiroError ? e.code : `other: ${(e as Error).message}`;
  }
}

describe("FileStore", () => {
  it("creates, reads and lists boards as pretty JSON files", async () => {
    const root = await tempRoot();
    const s = store(root);
    await s.create(newBoard());
    const raw = await readFile(join(root, ".gabiro/boards/shop.json"), "utf8");
    expect(JSON.parse(raw)).toMatchObject({ id: "shop", revision: 1, createdAt: NOW });
    expect(raw).toContain('\n  "title": "Shop"');
    expect((await s.get("shop")).title).toBe("Shop");
    expect(await s.list()).toEqual([{ id: "shop", title: "Shop", kind: "architecture", nodeCount: 0, updatedAt: NOW }]);
  });

  it("refuses to create a board that exists", async () => {
    const s = store(await tempRoot());
    await s.create(newBoard());
    expect(await code(s.create(newBoard()))).toBe("EXISTS");
  });

  it("returns NOT_FOUND for missing boards and lists existing ones in the message", async () => {
    const s = store(await tempRoot());
    await s.create(newBoard("a"));
    await expect(s.get("b")).rejects.toThrow(/No board "b". Existing boards: a\./);
  });

  it("rejects ids that could escape the boards directory", async () => {
    const s = store(await tempRoot());
    expect(await code(s.get("../etc/passwd"))).toBe("VALIDATION");
  });

  it("update bumps revision and keeps id/createdAt", async () => {
    const s = store(await tempRoot());
    await s.create(newBoard());
    const saved = await s.update("shop", (b) =>
      applyOps({ ...b, id: "hijack" }, [{ op: "add_node", id: "api", type: "service", label: "API" }]),
    );
    expect(saved).toMatchObject({ id: "shop", revision: 2, createdAt: NOW });
    expect((await s.get("shop")).nodes.map((n) => n.id)).toEqual(["api"]);
  });

  it("update rejects a stale expectedRevision", async () => {
    const s = store(await tempRoot());
    await s.create(newBoard());
    await s.update("shop", (b) => b);
    await expect(s.update("shop", (b) => b, 1)).rejects.toThrow(/at revision 2, you sent 1/);
    expect(await code(s.update("shop", (b) => b, 2))).toBe("resolved");
  });

  it("serialises concurrent writers from separate store instances", async () => {
    const root = await tempRoot();
    await store(root).create(newBoard());
    const writers = Array.from({ length: 20 }, (_, i) =>
      store(root).update("shop", (b) => applyOps(b, [{ op: "add_node", id: `n${i}`, type: "service", label: `N${i}` }])),
    );
    await Promise.all(writers);
    const final = await store(root).get("shop");
    expect(final.revision).toBe(21);
    expect(final.nodes).toHaveLength(20);
    expect((await readdir(join(root, ".gabiro/boards"))).sort()).toEqual(["shop.json"]);
  });

  it("marks corrupt files and never overwrites them", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".gabiro/boards"), { recursive: true });
    await writeFile(join(root, ".gabiro/boards/bad.json"), "{ not json");
    const s = store(root);
    await expect(s.get("bad")).rejects.toThrow(/\.gabiro\/boards\/bad\.json is invalid.*won't overwrite/);
    expect(await code(s.update("bad", (b) => b))).toBe("CORRUPT");
    expect(await readFile(join(root, ".gabiro/boards/bad.json"), "utf8")).toBe("{ not json");
    expect((await s.list())[0]).toMatchObject({ id: "bad", kind: "unknown" });
  });

  it("deletes boards", async () => {
    const s = store(await tempRoot());
    await s.create(newBoard());
    await s.delete("shop");
    expect(await s.list()).toEqual([]);
    expect(await code(s.delete("shop"))).toBe("NOT_FOUND");
  });
});

describe("withFileLock", () => {
  it("takes over a stale lock", async () => {
    const root = await tempRoot();
    const lock = join(root, "x.lock");
    await writeFile(lock, "");
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    expect(await withFileLock(lock, async () => "got it", 5000)).toBe("got it");
  });
});

describe("loadConfig", () => {
  it("defaults when missing and merges partial config", async () => {
    const root = await tempRoot();
    expect(await loadConfig(root)).toEqual({ autoExport: true, exportDir: "docs/diagrams" });
    await mkdir(join(root, ".gabiro"), { recursive: true });
    await writeFile(join(root, ".gabiro/config.json"), JSON.stringify({ autoExport: false }));
    expect(await loadConfig(root)).toEqual({ autoExport: false, exportDir: "docs/diagrams" });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/store/file-store.test.ts`
Expected: FAIL — cannot resolve "../../src/store/index.js"

- [ ] **Step 4: Implement**

```ts
// src/store/store.ts
import type { Board, Kind } from "../core/index.js";

export interface BoardListItem {
  id: string;
  title: string;
  kind: Kind | "unknown";
  nodeCount: number;
  updatedAt: string;
  /** Set when the file can't be read; the board is listed so the user can see and fix it. */
  error?: string;
}

/** Persistence boundary. FileStore is the local implementation; a database store can replace it later. */
export interface BoardStore {
  list(): Promise<BoardListItem[]>;
  /** Throws NOT_FOUND or CORRUPT. */
  get(id: string): Promise<Board>;
  /** Writes a new board. Throws EXISTS. */
  create(board: Board): Promise<Board>;
  /**
   * Reads the latest board under a lock, applies `change`, validates, bumps `revision`,
   * sets `updatedAt` and writes atomically. Throws CONFLICT if `expectedRevision` is stale.
   */
  update(id: string, change: (board: Board) => Board | Promise<Board>, expectedRevision?: number): Promise<Board>;
  /** Throws NOT_FOUND. */
  delete(id: string): Promise<void>;
}
```

```ts
// src/store/fs-utils.ts
import { randomBytes } from "node:crypto";
import { mkdir, open, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Write via temp file + rename so readers never see a half-written file. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Cross-process mutex using an exclusive lock file. A lock older than `staleMs`
 * is assumed to belong to a crashed process and is taken over.
 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, staleMs = 5000): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + staleMs * 2;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const age = await stat(lockPath).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > staleMs) await unlink(lockPath).catch(() => {});
      else if (Date.now() > deadline) throw new Error(`Timed out waiting for lock ${lockPath}`);
      else await sleep(20);
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}
```

```ts
// src/store/file-store.ts
import { readdir, readFile, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { GabiroError, SlugSchema, validateBoard, type Board } from "../core/index.js";
import { withFileLock, writeFileAtomic } from "./fs-utils.js";
import type { BoardListItem, BoardStore } from "./store.js";

/** Stores each board as `<root>/.gabiro/boards/<id>.json`. */
export class FileStore implements BoardStore {
  readonly dir: string;

  constructor(
    private readonly root: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.dir = join(root, ".gabiro", "boards");
  }

  pathFor(id: string): string {
    if (!SlugSchema.safeParse(id).success) {
      throw new GabiroError("VALIDATION", `"${id}" isn't a valid board id. Board ids are slugs like "checkout-architecture".`);
    }
    return join(this.dir, `${id}.json`);
  }

  async list(): Promise<BoardListItem[]> {
    const files = await readdir(this.dir).catch(() => [] as string[]);
    const items: BoardListItem[] = [];
    for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
      const id = file.slice(0, -".json".length);
      try {
        const b = await this.get(id);
        items.push({ id, title: b.title, kind: b.kind, nodeCount: b.nodes.length, updatedAt: b.updatedAt });
      } catch (err) {
        items.push({ id, title: id, kind: "unknown", nodeCount: 0, updatedAt: "", error: (err as Error).message });
      }
    }
    return items;
  }

  async get(id: string): Promise<Board> {
    const path = this.pathFor(id);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        const known = (await readdir(this.dir).catch(() => [] as string[]))
          .filter((f) => f.endsWith(".json"))
          .map((f) => f.slice(0, -5));
        throw new GabiroError(
          "NOT_FOUND",
          `No board "${id}". Existing boards: ${known.length ? known.join(", ") : "(none — create one with gabiro_create_board)"}.`,
        );
      }
      throw err;
    }
    try {
      return validateBoard(JSON.parse(raw));
    } catch (err) {
      const where = relative(this.root, path);
      throw new GabiroError(
        "CORRUPT",
        `Board file ${where} is invalid (${(err as Error).message}). Fix it by hand or delete it; gabiro won't overwrite it.`,
      );
    }
  }

  async create(board: Board): Promise<Board> {
    const path = this.pathFor(board.id);
    return withFileLock(`${path}.lock`, async () => {
      const exists = await readFile(path).then(() => true, () => false);
      if (exists) {
        throw new GabiroError("EXISTS", `Board "${board.id}" already exists. Pick another id, or edit it with gabiro_apply_changes.`);
      }
      const now = this.now();
      const saved = validateBoard({ ...board, revision: 1, createdAt: now, updatedAt: now });
      await writeFileAtomic(path, JSON.stringify(saved, null, 2) + "\n");
      return saved;
    });
  }

  async update(id: string, change: (board: Board) => Board | Promise<Board>, expectedRevision?: number): Promise<Board> {
    const path = this.pathFor(id);
    return withFileLock(`${path}.lock`, async () => {
      const current = await this.get(id);
      if (expectedRevision !== undefined && expectedRevision !== current.revision) {
        throw new GabiroError(
          "CONFLICT",
          `Board "${id}" is at revision ${current.revision}, you sent ${expectedRevision}. It changed since you read it — call gabiro_get_board and retry.`,
        );
      }
      const changed = await change(structuredClone(current));
      const saved = validateBoard({
        ...changed,
        id: current.id,
        createdAt: current.createdAt,
        revision: current.revision + 1,
        updatedAt: this.now(),
      });
      await writeFileAtomic(path, JSON.stringify(saved, null, 2) + "\n");
      return saved;
    });
  }

  async delete(id: string): Promise<void> {
    const path = this.pathFor(id);
    await withFileLock(`${path}.lock`, async () => {
      try {
        await unlink(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new GabiroError("NOT_FOUND", `No board "${id}".`);
        throw err;
      }
    });
  }
}
```

```ts
// src/store/config.ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { GabiroError } from "../core/index.js";

const ConfigSchema = z.object({
  autoExport: z.boolean().default(true),
  exportDir: z.string().min(1).default("docs/diagrams"),
});
export type GabiroConfig = z.infer<typeof ConfigSchema>;

/** Reads `<root>/.gabiro/config.json`; missing file or keys fall back to defaults. */
export async function loadConfig(root: string): Promise<GabiroConfig> {
  const path = join(root, ".gabiro", "config.json");
  const raw = await readFile(path, "utf8").catch(() => "{}");
  try {
    return ConfigSchema.parse(JSON.parse(raw));
  } catch (err) {
    throw new GabiroError("CORRUPT", `.gabiro/config.json is invalid (${(err as Error).message}). Fix or delete it.`);
  }
}
```

```ts
// src/store/index.ts
export type { BoardListItem, BoardStore } from "./store.js";
export { FileStore } from "./file-store.js";
export { loadConfig, type GabiroConfig } from "./config.js";
export { withFileLock, writeFileAtomic } from "./fs-utils.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/store/file-store.test.ts && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add test/helpers.ts src/store/store.ts src/store/fs-utils.ts src/store/file-store.ts src/store/config.ts src/store/index.ts test/store/file-store.test.ts
git commit -m "feat(store): file store with atomic writes, locking and revisions"
```

### Task 10: Board service

**Files:**
- Create: `src/service/board-service.ts`
- Create: `src/service/index.ts`
- Test: `test/service/board-service.test.ts`

`BoardService` is the only place that combines core, layout, store and export. The MCP tools use it now, and the canvas server will use it in Plan 2.

- [ ] **Step 1: Write the failing test**

```ts
// test/service/board-service.test.ts
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BoardService } from "../../src/service/index.js";
import { tempRoot } from "../helpers.js";

const exists = (p: string) => stat(p).then(() => true, () => false);

describe("BoardService", () => {
  it("creates a laid-out board from ops and auto-exports Markdown", async () => {
    const root = await tempRoot();
    const svc = new BoardService(root);
    const b = await svc.create({
      title: "Shop",
      kind: "architecture",
      ops: [
        { op: "add_node", id: "web", type: "client", label: "Web" },
        { op: "add_node", id: "api", type: "service", label: "API" },
        { op: "add_edge", from: "web", to: "api", type: "sync" },
      ],
    });
    expect(b.id).toBe("shop");
    expect(b.nodes.every((n) => n.position)).toBe(true);
    const md = await readFile(join(root, "docs/diagrams/shop.md"), "utf8");
    expect(md).toContain("web --> api");
  });

  it("applies changes, re-exports and honours expectedRevision", async () => {
    const root = await tempRoot();
    const svc = new BoardService(root);
    await svc.create({ title: "Shop", kind: "architecture" });
    const b = await svc.applyChanges("shop", [{ op: "add_node", id: "db", type: "database", label: "DB" }], 1);
    expect(b.revision).toBe(2);
    expect(await readFile(join(root, "docs/diagrams/shop.md"), "utf8")).toContain('db[("DB")]');
    await expect(svc.applyChanges("shop", [], 1)).rejects.toThrow(/revision 2, you sent 1/);
  });

  it("re-lays out when the direction changes", async () => {
    const svc = new BoardService(await tempRoot());
    await svc.create({
      title: "F",
      kind: "flowchart",
      ops: [
        { op: "add_node", id: "a", type: "step", label: "A" },
        { op: "add_node", id: "b", type: "step", label: "B" },
        { op: "add_edge", from: "a", to: "b", type: "flow" },
      ],
    });
    const lr = await svc.updateBoard("f", { direction: "LR", title: "Flow" });
    const pos = (id: string) => lr.nodes.find((n) => n.id === id)!.position!;
    expect(lr.title).toBe("Flow");
    expect(pos("b").x).toBeGreaterThan(pos("a").x);
  });

  it("exports on demand, writing to the export dir", async () => {
    const root = await tempRoot();
    const svc = new BoardService(root);
    await svc.create({ title: "Shop", kind: "architecture", ops: [{ op: "add_node", id: "a", type: "service", label: "A" }] });
    const r = await svc.export("shop", "mermaid", true);
    expect(r.path).toBe(join("docs", "diagrams", "shop.mmd"));
    expect(await readFile(join(root, r.path!), "utf8")).toBe(r.content);
    await svc.create({ title: "Wall", kind: "freeform" });
    await expect(svc.export("wall", "mermaid")).rejects.toThrow(/use format "markdown"/i);
  });

  it("delete removes the board and its auto-export", async () => {
    const root = await tempRoot();
    const svc = new BoardService(root);
    await svc.create({ title: "Shop", kind: "architecture" });
    await svc.delete("shop");
    expect(await svc.list()).toEqual([]);
    expect(await exists(join(root, "docs/diagrams/shop.md"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/service/board-service.test.ts`
Expected: FAIL — cannot resolve "../../src/service/index.js"

- [ ] **Step 3: Implement**

```ts
// src/service/board-service.ts
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { applyOps, createBoard, GabiroError, type Board, type Direction, type Kind } from "../core/index.js";
import { toMarkdown, toMermaid } from "../export/index.js";
import { layoutBoard } from "../layout/index.js";
import { FileStore, loadConfig, writeFileAtomic, type BoardListItem, type BoardStore } from "../store/index.js";

export interface CreateBoardInput {
  title: string;
  kind: Kind;
  id?: string;
  direction?: Direction;
  ops?: unknown[];
}

export type ExportFormat = "mermaid" | "markdown";

/**
 * The one place that combines ops, layout, storage and export.
 * MCP tools (and later the canvas server) call this; they never touch the store directly.
 */
export class BoardService {
  constructor(
    readonly root: string,
    readonly store: BoardStore = new FileStore(root),
  ) {}

  list(): Promise<BoardListItem[]> {
    return this.store.list();
  }

  get(id: string): Promise<Board> {
    return this.store.get(id);
  }

  async create(input: CreateBoardInput): Promise<Board> {
    let board = createBoard(input);
    if (input.ops?.length) board = applyOps(board, input.ops);
    const saved = await this.store.create(await layoutBoard(board));
    await this.autoExport(saved);
    return saved;
  }

  async applyChanges(id: string, ops: unknown[], expectedRevision?: number): Promise<Board> {
    const saved = await this.store.update(id, (b) => layoutBoard(applyOps(b, ops)), expectedRevision);
    await this.autoExport(saved);
    return saved;
  }

  async updateBoard(id: string, changes: { title?: string; direction?: Direction }): Promise<Board> {
    const saved = await this.store.update(id, (b) => {
      const next: Board = { ...b, title: changes.title ?? b.title, layout: { direction: changes.direction ?? b.layout.direction } };
      return next.layout.direction !== b.layout.direction ? layoutBoard(next, "all") : next;
    });
    await this.autoExport(saved);
    return saved;
  }

  async autoLayout(id: string, force = false): Promise<Board> {
    const saved = await this.store.update(id, (b) => layoutBoard(b, force ? "force" : "all"));
    await this.autoExport(saved);
    return saved;
  }

  async delete(id: string): Promise<void> {
    await this.store.delete(id);
    const config = await loadConfig(this.root);
    await rm(join(this.root, config.exportDir, `${id}.md`), { force: true });
  }

  /** Returns the exported text; with `write`, also saves it under the configured export dir. */
  async export(id: string, format: ExportFormat, write = false): Promise<{ content: string; path?: string }> {
    const board = await this.store.get(id);
    let content: string;
    if (format === "mermaid") {
      const mermaid = toMermaid(board);
      if (mermaid === null) {
        throw new GabiroError("VALIDATION", `Freeform boards have no Mermaid form. Use format "markdown" instead.`);
      }
      content = mermaid + "\n";
    } else {
      content = toMarkdown(board);
    }
    if (!write) return { content };
    const config = await loadConfig(this.root);
    const path = join(config.exportDir, `${id}.${format === "mermaid" ? "mmd" : "md"}`);
    await writeFileAtomic(join(this.root, path), content);
    return { content, path };
  }

  private async autoExport(board: Board): Promise<void> {
    const config = await loadConfig(this.root);
    if (config.autoExport) await writeFileAtomic(join(this.root, config.exportDir, `${board.id}.md`), toMarkdown(board));
  }
}
```

```ts
// src/service/index.ts
export { BoardService, type CreateBoardInput, type ExportFormat } from "./board-service.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/service/board-service.test.ts && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/service/board-service.ts src/service/index.ts test/service/board-service.test.ts
git commit -m "feat(service): orchestrate ops, layout, storage and auto-export"
```

### Task 11: MCP tools and server

**Files:**
- Create: `src/mcp/help.ts`
- Create: `src/mcp/tools.ts`
- Create: `src/mcp/server.ts`
- Test: `test/mcp/tools.test.ts`

`ops` is typed loosely in the tool schema (`{op: string}` passthrough) on purpose: the SDK's generic validation errors are replaced by `applyOps`'s per-op messages, and the tool list stays small. The allowed types per kind are generated from `KIND_RULES` into the parameter description.

- [ ] **Step 1: Write the failing test**

```ts
// test/mcp/tools.test.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../../src/mcp/server.js";
import { tempRoot } from "../helpers.js";

async function connect() {
  const root = await tempRoot();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(root).connect(serverSide);
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
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/mcp/tools.test.ts`
Expected: FAIL — cannot resolve "../../src/mcp/server.js"

- [ ] **Step 3: Implement**

```ts
// src/mcp/help.ts
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
- update_edge {id, ...fields} / remove_edge {id}
- add_group {id, label, type, parentId?} / update_group {id, ...fields} / remove_group {id, cascade?}
Ids are lowercase slugs like "orders-db". Don't send positions; the layout engine places nodes.
Allowed types by board kind ("sticky" notes are allowed on every kind):
${kindLines}
Kind-specific: ERD entities take "fields" and relations take "cardinality"; sequence messages need "order" (1,2,3…), style "dashed" for replies; kanban cards need groupId (their column) and "order".`;

export const SERVER_INSTRUCTIONS = `Gabiro draws software diagrams (architecture, flowchart, sequence, erd, mindmap, freeform, kanban) as boards stored in the project under .gabiro/boards, with Mermaid exports in docs/diagrams.
Workflow: call gabiro_list_boards to reuse existing boards; build a new diagram in ONE gabiro_create_board call with all ops; refine with gabiro_apply_changes, passing the revision you last saw as expectedRevision.
Use gabiro_get_board (format "summary") to re-read a board, because the user may have edited it. Record open questions and risks as "sticky" nodes.`;
```

```ts
// src/mcp/tools.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GabiroError, KINDS, SlugSchema, summarizeBoard, type Board } from "../core/index.js";
import type { BoardService } from "../service/index.js";
import { OPS_HELP } from "./help.js";

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

const opsParam = z.array(z.object({ op: z.string() }).passthrough()).describe(OPS_HELP);
const boardIdParam = SlugSchema.describe('Board id, e.g. "checkout-architecture" (see gabiro_list_boards)');

export function registerTools(server: McpServer, service: BoardService): void {
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
        const board = await service.create({ title, kind, id, direction, ops });
        const report = changeReport(board);
        return { text: `${report.text}\n\n${summarizeBoard(board)}`, data: report.data };
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
        const after = await service.applyChanges(boardId, ops, expectedRevision);
        return changeReport(after, before);
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
    ({ boardId, title, direction }) => run(async () => changeReport(await service.updateBoard(boardId, { title, direction }))),
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
    ({ boardId, force }) => run(async () => changeReport(await service.autoLayout(boardId, force))),
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

```ts
// src/mcp/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BoardService } from "../service/index.js";
import { VERSION } from "../version.js";
import { SERVER_INSTRUCTIONS } from "./help.js";
import { registerTools } from "./tools.js";

export function createMcpServer(root: string): McpServer {
  const server = new McpServer({ name: "gabiro", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, new BoardService(root));
  return server;
}

export async function runStdioServer(root: string): Promise<void> {
  const server = createMcpServer(root);
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; logs go to stderr.
  console.error(`gabiro MCP server ${VERSION} running on stdio (project root: ${root})`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/mcp/tools.test.ts && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/help.ts src/mcp/tools.ts src/mcp/server.ts test/mcp/tools.test.ts
git commit -m "feat(mcp): gabiro_* tools over the board service"
```

### Task 12: CLI, build and stdio end-to-end test

**Files:**
- Create: `README.md`
- Create: `src/cli.ts`
- Test: `test/e2e/stdio.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/e2e/stdio.test.ts
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { expect, it } from "vitest";
import { tempRoot } from "../helpers.js";

const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

it.skipIf(!existsSync(cli))("runs the built CLI as a stdio MCP server (run `npm run build` first)", async () => {
  const root = await tempRoot();
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--root", root] }));
  try {
    const r = (await client.callTool({
      name: "gabiro_create_board",
      arguments: { title: "Login", kind: "sequence", ops: [
        { op: "add_node", id: "user", type: "participant", label: "User", order: 1 },
        { op: "add_node", id: "auth", type: "participant", label: "Auth", order: 2 },
        { op: "add_edge", from: "user", to: "auth", type: "message", label: "login", order: 1 },
      ] },
    })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ boardId: "login", revision: 1, nodes: 2 });
  } finally {
    await client.close();
  }
}, 20_000);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/e2e/stdio.test.ts`
Expected: FAIL — the test is SKIPPED because `dist/cli.js` doesn't exist yet

- [ ] **Step 3: Implement**

```ts
// src/cli.ts
#!/usr/bin/env node
import { resolve } from "node:path";
import { runStdioServer } from "./mcp/server.js";
import { VERSION } from "./version.js";

const USAGE = `gabiro ${VERSION}

Usage:
  gabiro mcp [--root <dir>]   Run the MCP server over stdio (project root defaults to the current directory)

Add to Claude Code:
  claude mcp add gabiro -- npx -y gabiro mcp`;

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  const root = resolve(option(args, "--root") ?? process.cwd());
  switch (command) {
    case "mcp":
      await runStdioServer(root);
      return;
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

````markdown
# gabiro

A free, self-hosted, agent-first diagram tool. AI agents (Claude Code, Claude Desktop, Cursor, …) call gabiro's MCP tools to draw your system as **architecture, flowchart, sequence, ERD, mind map, freeform and kanban** boards. Boards are JSON files in your repo (`.gabiro/boards/`), and every change is auto-exported to Mermaid Markdown (`docs/diagrams/`) so it renders on GitHub and lives in git next to the code.

> The live browser canvas is coming in the next milestone. Today you get the MCP server plus Mermaid exports.

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

Then open `docs/diagrams/<board>.md` (it renders on GitHub or in VS Code's Markdown preview).

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
| `gabiro_delete_board` | Delete a board and its export |

## Config

`.gabiro/config.json` (optional):

```json
{ "autoExport": true, "exportDir": "docs/diagrams" }
```

## Develop

```bash
npm test          # unit + MCP tests (the stdio e2e test runs after `npm run build`)
npm run typecheck
```
````

- [ ] **Step 4: Build, then run the e2e test and the whole suite**

Run: `npm run build && npx vitest run test/e2e/stdio.test.ts && npm test && npx tsc --noEmit`
Expected: build succeeds; the e2e test PASSES (not skipped); full suite: 12 files, 71 tests passed.

Also check the CLI by hand:

Run: `node dist/cli.js; echo exit=$?` → prints usage, `exit=0`.
Run: `node dist/cli.js bogus; echo exit=$?` → prints usage, `exit=1`.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts README.md test/e2e/stdio.test.ts
git commit -m "feat(cli): gabiro mcp command, README"
```

### Task 13: Try it with a real agent

- [ ] **Step 1: Register the server in a sample project**

```bash
mkdir -p /tmp/gabiro-demo && cd /tmp/gabiro-demo && git init -q
claude mcp add gabiro -- node <absolute path to repo>/dist/cli.js mcp
```

- [ ] **Step 2: Ask the agent for a diagram**

Prompt: "Using gabiro, draw an architecture board for a checkout system: web client, API gateway, checkout service, orders Postgres, Redis cache, Kafka events, Stripe. Group backend services in a zone."

Expected: one `gabiro_create_board` call; `.gabiro/boards/checkout*.json` and `docs/diagrams/checkout*.md` exist; the Markdown renders in VS Code's preview or on GitHub.

- [ ] **Step 3: Note any tool-description confusion** (wrong types tried, extra calls) and tighten the wording in `src/mcp/help.ts` / `src/mcp/tools.ts`. Commit if changed:

```bash
git add src/mcp && git commit -m "docs(mcp): clarify tool descriptions from agent trial"
```

---

## Deferred to Plan 2 (canvas)
`gabiro serve`, `.gabiro/server.json`, `gabiro_open_board`, `canvasUrl` in tool results, the file watcher and WebSocket push, the React Flow UI, manual editing, the corrupt-board read-only view, and the Playwright smoke test.
