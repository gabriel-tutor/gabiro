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
