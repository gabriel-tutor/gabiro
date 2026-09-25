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
