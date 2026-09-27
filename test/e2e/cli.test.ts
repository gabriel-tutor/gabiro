import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gabiro-e2e-"));
  dirs.push(dir);
  return dir;
}

function run(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args]);
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

it.skipIf(!existsSync(cli))("prints an error and exits 1 when --root has no value", async () => {
  const { code, stderr } = await run(["mcp", "--root"]);
  expect(code).toBe(1);
  expect(stderr).toContain("--root needs a directory");
});

it.skipIf(!existsSync(cli))("rejects an --idle-exit longer than setTimeout can hold", async () => {
  const { code, stderr } = await run(["serve", "--port", "0", "--idle-exit", "36000"]);
  expect(code).toBe(1);
  expect(stderr).toContain("--idle-exit needs a number of minutes greater than 0 and at most 35000");
});

it.skipIf(!existsSync(cli))("rejects --idle-exit 0", async () => {
  const { code, stderr } = await run(["serve", "--port", "0", "--idle-exit", "0"]);
  expect(code).toBe(1);
  expect(stderr).toContain("--idle-exit needs a number of minutes greater than 0 and at most 35000");
});

it.skipIf(!existsSync(cli))("exits 1 with a clear error when --root doesn't exist", async () => {
  const missing = join(await tempRoot(), "nope");
  const { code, stderr } = await run(["serve", "--root", missing]);
  expect(code).toBe(1);
  expect(stderr).toContain("doesn't exist");
});

it.skipIf(!existsSync(cli))("canonicalizes a symlinked --root before printing it", async () => {
  const real = await tempRoot();
  const parent = await tempRoot();
  const link = join(parent, "link-to-real");
  await symlink(real, link, "dir");
  const child = spawn(process.execPath, [cli, "serve", "--root", link, "--port", "0"]);
  let stdout = "";
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.includes("project root:")) resolve();
      });
      child.on("error", reject);
      child.on("close", (code) => reject(new Error(`serve exited early with code ${code}: ${stdout}`)));
      setTimeout(() => reject(new Error(`timed out waiting for startup line: ${stdout}`)), 10_000);
    });
  } finally {
    child.kill();
  }
  expect(stdout).toContain(`project root: ${realpathSync(real)}`);
});
