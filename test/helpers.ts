import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

const dirs: string[] = [];

/** A fresh temp project root, removed after each test. */
export async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gabiro-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
