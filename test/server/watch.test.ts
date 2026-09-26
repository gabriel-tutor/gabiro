import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { watchBoards } from "../../src/server/watch.js";
import { tempRoot } from "../helpers.js";

const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach((stop) => stop()));

/** Starts watchBoards and returns a helper that waits until onChange has been called for an id. */
function watch(dir: string) {
  const seen: string[] = [];
  const waiters: { id: string; resolve: () => void }[] = [];
  stops.push(
    watchBoards(
      dir,
      (id) => {
        seen.push(id);
        for (const w of waiters.filter((w) => w.id === id)) w.resolve();
      },
      20,
      100,
    ),
  );
  const changed = (id: string, timeoutMs = 2000) =>
    new Promise<void>((resolve, reject) => {
      seen.length = 0;
      const timer = setTimeout(() => reject(new Error(`no change for "${id}" within ${timeoutMs}ms`)), timeoutMs);
      waiters.push({ id, resolve: () => (clearTimeout(timer), resolve()) });
    });
  return { seen, changed };
}

describe("watchBoards", () => {
  it("reports created, changed and deleted boards", async () => {
    const dir = join(await tempRoot(), "boards");
    const w = watch(dir);
    let next = w.changed("a");
    await writeFile(join(dir, "a.json"), "{}");
    await next;
    next = w.changed("a");
    await unlink(join(dir, "a.json"));
    await next;
  });

  it("keeps working after the directory is removed and recreated", async () => {
    const dir = join(await tempRoot(), "boards");
    const w = watch(dir);
    let next = w.changed("a");
    await writeFile(join(dir, "a.json"), "{}");
    await next;
    await rm(dir, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 50));
    await mkdir(dir, { recursive: true });
    next = w.changed("b");
    await writeFile(join(dir, "b.json"), "{}");
    await next;
  });

  it("recreates a missing directory and ignores non-board files", async () => {
    const dir = join(await tempRoot(), "boards");
    const w = watch(dir);
    await rm(dir, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 300));
    await writeFile(join(dir, "notes.txt"), "x");
    const next = w.changed("c");
    await writeFile(join(dir, "c.json"), "{}");
    await next;
    expect(w.seen.every((id) => id === "c")).toBe(true);
  });
});
