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
