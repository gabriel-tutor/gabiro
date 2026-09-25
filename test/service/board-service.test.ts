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
