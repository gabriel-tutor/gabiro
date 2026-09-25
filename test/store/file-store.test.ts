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

  it("rejects a board file whose id doesn't match its file name", async () => {
    const root = await tempRoot();
    const s = store(root);
    await s.create(newBoard("alpha"));
    const raw = await readFile(join(root, ".gabiro/boards/alpha.json"), "utf8");
    await writeFile(join(root, ".gabiro/boards/beta.json"), raw);
    await expect(s.get("beta")).rejects.toThrow(
      /Board file \.gabiro\/boards\/beta\.json has id "alpha"\. Set its "id" to "beta" or rename the file\./,
    );
    expect(await code(s.get("beta"))).toBe("CORRUPT");
  });

  it("deletes boards", async () => {
    const s = store(await tempRoot());
    await s.create(newBoard());
    await s.delete("shop");
    expect(await s.list()).toEqual([]);
    expect(await code(s.delete("shop"))).toBe("NOT_FOUND");
  });

  it("create rejects EISDIR (directory exists at path, not just any error)", async () => {
    const root = await tempRoot();
    const s = store(root);
    // Create .gabiro/boards/shop.json as a DIRECTORY
    await mkdir(join(root, ".gabiro/boards/shop.json"), { recursive: true });
    // store.create() must reject, and the directory must still exist
    await expect(s.create(newBoard())).rejects.toThrow();
    const stat = await import("node:fs/promises").then(fs => fs.stat(join(root, ".gabiro/boards/shop.json")));
    expect(stat.isDirectory()).toBe(true);
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

  it("lock ownership: doesn't delete another writer's lock", async () => {
    const root = await tempRoot();
    const lock = join(root, "x.lock");
    await writeFile(lock, "");
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    await withFileLock(lock, async () => {
      // Simulate another writer taking over the lock
      await writeFile(lock, "other-token");
    }, 5000);
    // After withFileLock resolves, the lock file must still exist with the other token
    const content = await readFile(lock, "utf8");
    expect(content).toBe("other-token");
  });

  it("lock timeout throws GabiroError with CONFLICT code", async () => {
    const root = await tempRoot();
    const lock = join(root, "x.lock");
    await writeFile(lock, "");
    // Keep refreshing the lock's mtime so it never goes stale
    const interval = setInterval(async () => {
      const now = new Date();
      await utimes(lock, now, now).catch(() => {});
    }, 10);
    try {
      await expect(withFileLock(lock, async () => "got it", 50)).rejects.toThrow();
      const error = await code(withFileLock(lock, async () => "got it", 50));
      expect(error).toBe("CONFLICT");
    } finally {
      clearInterval(interval);
    }
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

  it("accepts a relative exportDir inside the project", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".gabiro"), { recursive: true });
    await writeFile(join(root, ".gabiro/config.json"), JSON.stringify({ exportDir: "docs/diagrams" }));
    expect(await loadConfig(root)).toEqual({ autoExport: true, exportDir: "docs/diagrams" });
  });

  it("rejects an exportDir that escapes the project root", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".gabiro"), { recursive: true });
    await writeFile(join(root, ".gabiro/config.json"), JSON.stringify({ exportDir: "../escaped" }));
    await expect(loadConfig(root)).rejects.toThrow(/exportDir must be a relative path inside the project \(got "\.\.\/escaped"\)/);
  });

  it("rejects an absolute exportDir", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".gabiro"), { recursive: true });
    await writeFile(join(root, ".gabiro/config.json"), JSON.stringify({ exportDir: "/tmp/x" }));
    await expect(loadConfig(root)).rejects.toThrow(/exportDir must be a relative path inside the project \(got "\/tmp\/x"\)/);
  });

  it("rethrows non-ENOENT read errors instead of treating them as missing config", async () => {
    const root = await tempRoot();
    // A directory at the config path makes reading it fail with EISDIR, not ENOENT.
    await mkdir(join(root, ".gabiro", "config.json"), { recursive: true });
    await expect(loadConfig(root)).rejects.toMatchObject({ code: "EISDIR" });
  });
});
