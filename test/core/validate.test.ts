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
    expect(() => validateBoard(b)).toThrow(/isn't valid on a flowchart board.*Did you mean an architecture board\?/);
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

  it("rejects a group id equal to a node id", () => {
    const b = board("architecture", {
      groups: [{ id: "shared", label: "Shared", type: "zone" }],
      nodes: [{ id: "shared", type: "service", label: "Shared" }],
    });
    expect(() => validateBoard(b)).toThrow(
      /Id "shared" is used by both a node and a group\. Node and group ids share one namespace; rename one of them\./,
    );
  });

  it("rejects malformed ids", () => {
    expect(() => validateBoard(board("architecture", { nodes: [{ id: "Bad Id", type: "service", label: "x" }] }))).toThrow(
      /lowercase slug/,
    );
  });
});
