import { expect, it } from "vitest";
import { applyOps, createBoard, summarizeBoard } from "../../src/core/index.js";

it("collapses newlines in a node description to spaces", () => {
  const b = applyOps(createBoard({ title: "Shop", kind: "architecture", id: "shop" }), [
    { op: "add_node", id: "api", type: "service", label: "API", description: "Line one\n  Line two\r\nLine three" },
  ]);
  expect(summarizeBoard(b)).toContain('node api [service] "API" — Line one Line two Line three');
});

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
