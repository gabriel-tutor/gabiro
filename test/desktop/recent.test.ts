import { mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeProject, MAX_RECENT, RecentProjects } from "../../desktop/src/recent.js";
import { tempRoot } from "../helpers.js";

/** Real paths, since the store records real paths (macOS temp dirs sit behind a /var symlink). */
async function setup() {
  const dir = await realpath(await tempRoot());
  const file = join(dir, "userData", "recent.json");
  return { dir, file, recent: new RecentProjects(file) };
}

async function project(dir: string, name: string) {
  const root = join(dir, name);
  await mkdir(root, { recursive: true });
  return root;
}

describe("RecentProjects", () => {
  it("starts empty and lists newest first", async () => {
    const { dir, recent } = await setup();
    expect(await recent.list()).toEqual([]);
    const a = await project(dir, "a");
    const b = await project(dir, "b");
    await recent.add(a, new Date("2026-01-01T00:00:00Z"));
    await recent.add(b, new Date("2026-01-02T00:00:00Z"));
    expect(await recent.list()).toEqual([
      { root: b, openedAt: "2026-01-02T00:00:00.000Z" },
      { root: a, openedAt: "2026-01-01T00:00:00.000Z" },
    ]);
  });

  it("moves a re-opened project to the top without duplicating it, even through a symlink", async () => {
    const { dir, recent } = await setup();
    const a = await project(dir, "a");
    const b = await project(dir, "b");
    await symlink(a, join(dir, "link-to-a"));
    await recent.add(a);
    await recent.add(b);
    await recent.add(join(dir, "link-to-a"));
    expect((await recent.list()).map((p) => p.root)).toEqual([a, b]);
    expect(await recent.has(join(dir, "link-to-a"))).toBe(true);
  });

  it(`keeps at most ${MAX_RECENT} projects`, async () => {
    const { dir, recent } = await setup();
    for (let i = 0; i < MAX_RECENT + 3; i++) await recent.add(await project(dir, `p${i}`));
    const roots = (await recent.list()).map((p) => p.root);
    expect(roots).toHaveLength(MAX_RECENT);
    expect(roots[0]).toBe(join(dir, `p${MAX_RECENT + 2}`));
  });

  it("serializes concurrent adds so none is lost", async () => {
    const { dir, recent } = await setup();
    const roots = await Promise.all(["a", "b", "c", "d"].map((n) => project(dir, n)));
    await Promise.all(roots.map((r) => recent.add(r)));
    expect((await recent.list()).map((p) => p.root).sort()).toEqual(roots.sort());
  });

  it("treats a corrupt or wrongly shaped file as empty and recovers on the next write", async () => {
    const { dir, file, recent } = await setup();
    await mkdir(join(dir, "userData"));
    await writeFile(file, "{ not json");
    expect(await recent.list()).toEqual([]);
    await writeFile(file, JSON.stringify([{ root: 1 }, { root: "/x", openedAt: "t" }]));
    expect(await recent.list()).toEqual([{ root: "/x", openedAt: "t" }]);
    const a = await project(dir, "a");
    await recent.add(a);
    expect((await recent.list()).map((p) => p.root)).toEqual([a, "/x"]);
  });

  it("forgets a project, and writes atomically (no temp files left behind)", async () => {
    const { dir, file, recent } = await setup();
    const a = await project(dir, "a");
    await recent.add(a);
    await recent.forget(a);
    expect(await recent.list()).toEqual([]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([]);
    expect(await readdir(join(dir, "userData"))).toEqual(["recent.json"]);
  });
});

describe("describeProject", () => {
  it("counts boards and flags missing folders", async () => {
    const dir = await realpath(await tempRoot());
    const root = await project(dir, "shop");
    expect(await describeProject(root)).toEqual({ root, name: "shop", boards: 0, missing: false });
    await mkdir(join(root, ".gabiro", "boards"), { recursive: true });
    await writeFile(join(root, ".gabiro", "boards", "a.json"), "{}");
    await writeFile(join(root, ".gabiro", "boards", "b.json"), "{}");
    await writeFile(join(root, ".gabiro", "boards", "notes.txt"), "");
    expect(await describeProject(root)).toMatchObject({ boards: 2, missing: false });
    await rm(root, { recursive: true });
    expect(await describeProject(root)).toEqual({ root, name: "shop", boards: 0, missing: true });
  });
});
