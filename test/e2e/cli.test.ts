import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

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
