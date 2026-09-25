import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changesStructure } from "../../src/service/board-service.js";
import { BoardService } from "../../src/service/index.js";
import { tempRoot } from "../helpers.js";

const exists = (p: string) => stat(p).then(() => true, () => false);

describe("BoardService", () => {
  it("creates a laid-out board from ops and auto-exports Markdown", async () => {
    const root = await tempRoot();
    const svc = new BoardService(root);
    const { board: b } = await svc.create({
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
    const { board: b } = await svc.applyChanges("shop", [{ op: "add_node", id: "db", type: "database", label: "DB" }], 1);
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
    const { board: lr } = await svc.updateBoard("f", { direction: "LR", title: "Flow" });
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

  it("rejects applyChanges before committing when the config is corrupt, leaving the board unchanged", async () => {
    const root = await tempRoot();
    const svc = new BoardService(root);
    await svc.create({ title: "Shop", kind: "architecture" });
    await writeFile(join(root, ".gabiro", "config.json"), "{ not json");
    await expect(svc.applyChanges("shop", [{ op: "add_node", id: "a", type: "service", label: "A" }])).rejects.toMatchObject({
      code: "CORRUPT",
    });
    expect((await svc.get("shop")).revision).toBe(1);
  });

  it("saves the board and reports a warning when the auto-export write fails", async () => {
    const root = await tempRoot();
    // exportDir ("docs/diagrams") is nested under "docs", but "docs" is a regular file here,
    // so mkdir-ing the export dir (and thus the export write) fails.
    await writeFile(join(root, "docs"), "not a directory");
    const svc = new BoardService(root);
    const { board, exportWarning } = await svc.create({ title: "Shop", kind: "architecture" });
    expect(board.id).toBe("shop");
    expect(exportWarning).toBeTruthy();
    expect((await svc.get("shop")).id).toBe("shop");
  });

  it("chooses layout mode 'all' for structural ops and 'auto' otherwise (changesStructure)", () => {
    expect(changesStructure([{ op: "add_edge", from: "a", to: "b", type: "sync" }])).toBe(true);
    expect(changesStructure([{ op: "remove_edge", id: "x" }])).toBe(true);
    expect(changesStructure([{ op: "add_group", id: "g", label: "G", type: "zone" }])).toBe(true);
    expect(changesStructure([{ op: "update_group", id: "g", label: "New" }])).toBe(true);
    expect(changesStructure([{ op: "remove_group", id: "g" }])).toBe(true);
    expect(changesStructure([{ op: "remove_node", id: "a" }])).toBe(true);
    expect(changesStructure([{ op: "update_node", id: "a", groupId: "g" }])).toBe(true);
    expect(changesStructure([{ op: "update_node", id: "a", order: 2 }])).toBe(true);
    expect(changesStructure([{ op: "update_edge", id: "x", order: 2 }])).toBe(true);
    expect(changesStructure([{ op: "add_node", id: "a", type: "service", label: "A" }])).toBe(false);
    expect(changesStructure([{ op: "update_node", id: "a", label: "New label" }])).toBe(false);
  });

  it("re-lays out a whole kanban board when a card moves to another column", async () => {
    const svc = new BoardService(await tempRoot());
    await svc.create({
      title: "Board",
      kind: "kanban",
      ops: [
        { op: "add_group", id: "todo", label: "Todo", type: "column" },
        { op: "add_group", id: "done", label: "Done", type: "column" },
        { op: "add_node", id: "card1", type: "card", label: "Card 1", groupId: "todo" },
      ],
    });
    const { board } = await svc.applyChanges("board", [{ op: "update_node", id: "card1", groupId: "done" }]);
    const cardX = board.nodes.find((n) => n.id === "card1")!.position!.x;
    const doneColumnIndex = board.groups.findIndex((g) => g.id === "done");
    expect(cardX).toBe(doneColumnIndex * 280 + 20);
  });

  it("leaves positions unchanged for a label-only update on a laid-out board", async () => {
    const svc = new BoardService(await tempRoot());
    await svc.create({
      title: "Shop",
      kind: "architecture",
      ops: [
        { op: "add_node", id: "a", type: "service", label: "A" },
        { op: "add_node", id: "b", type: "service", label: "B" },
        { op: "add_edge", from: "a", to: "b", type: "sync" },
      ],
    });
    const before = await svc.get("shop");
    const { board: after } = await svc.applyChanges("shop", [{ op: "update_node", id: "a", label: "A2" }]);
    expect(after.nodes.find((n) => n.id === "a")!.position).toEqual(before.nodes.find((n) => n.id === "a")!.position);
    expect(after.nodes.find((n) => n.id === "b")!.position).toEqual(before.nodes.find((n) => n.id === "b")!.position);
  });
});
