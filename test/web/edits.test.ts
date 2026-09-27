import { describe, expect, it } from "vitest";
import { applyOps, type Board } from "../../src/core/index.js";
import { layoutBoard } from "../../src/layout/index.js";
import { addNodeOps, connectOps, deleteOps, diffOps, freeSpot, moveOps, typeChangeOps, uniqueId } from "../../web/src/edits.js";
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

describe("typeChangeOps", () => {
  it("clears fields when a node stops being an ERD entity", () => {
    const users = FIXTURES.erd.nodes.find((n) => n.id === "users")!;
    const ops = typeChangeOps(FIXTURES.erd, users, "sticky");
    expect(ops).toEqual([{ op: "update_node", id: "users", type: "sticky", fields: null }]);
    expect(applyOps(FIXTURES.erd, ops).nodes.find((n) => n.id === "users")).not.toHaveProperty("fields");
  });

  it("puts a node that becomes a kanban card into the first column", () => {
    const board = applyOps(FIXTURES.kanban, [{ op: "add_node", id: "idea", type: "sticky", label: "Idea" }]);
    const idea = board.nodes.find((n) => n.id === "idea")!;
    const ops = typeChangeOps(board, idea, "card");
    expect(ops).toEqual([{ op: "update_node", id: "idea", type: "card", groupId: "todo" }]);
    expect(() => applyOps(board, ops)).not.toThrow();
    const core = board.nodes.find((n) => n.id === "core")!;
    expect(typeChangeOps(board, core, "sticky")).toEqual([{ op: "update_node", id: "core", type: "sticky" }]);
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
