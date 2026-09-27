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
