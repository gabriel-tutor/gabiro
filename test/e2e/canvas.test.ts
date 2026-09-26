import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";
import { startCanvasServer } from "../../src/server/index.js";
import { BoardService } from "../../src/service/index.js";
import { tempRoot } from "../helpers.js";
import { findChromium } from "./browser.js";

const dist = fileURLToPath(new URL("../../dist/", import.meta.url));
const cli = join(dist, "cli.js");
const webDir = join(dist, "web");
const built = existsSync(cli) && existsSync(join(webDir, "index.html"));
const chromiumPath = findChromium();

async function health(url: string) {
  return (await fetch(`${url}/api/health`)).json() as Promise<{ ok: boolean; root: string; pid: number }>;
}

describe.skipIf(!built)("canvas end-to-end (run `npm run build` first)", () => {
  it("`gabiro serve` prints its URL, serves the app, and cleans up on SIGTERM", async () => {
    const root = await tempRoot();
    const child = spawn(process.execPath, [cli, "serve", "--root", root, "--port", "0"]);
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        const m = /running at (http:\/\/\S+)/.exec(chunk.toString());
        if (m) resolve(m[1]!);
      });
      child.once("exit", (code) => reject(new Error(`serve exited early with ${code}`)));
    });
    expect(await health(url)).toMatchObject({ ok: true, root });
    expect(await (await fetch(`${url}/b/anything`)).text()).toContain('<div id="root">');
    const exited = new Promise<number | null>((r) => child.once("exit", r));
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(existsSync(join(root, ".gabiro/server.json"))).toBe(false);
  }, 20_000);

  it("gabiro_open_board starts a detached canvas server for the project", async () => {
    const root = await tempRoot();
    const client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, "mcp", "--root", root],
        env: { ...(process.env as Record<string, string>), GABIRO_NO_BROWSER: "1" },
      }),
    );
    let pid: number | undefined;
    try {
      await client.callTool({ name: "gabiro_create_board", arguments: { title: "Shop", kind: "architecture" } });
      const r = (await client.callTool({ name: "gabiro_open_board", arguments: { boardId: "shop" } })) as CallToolResult;
      expect(r.isError).toBeFalsy();
      const { url, opened } = r.structuredContent as { url: string; opened: boolean };
      expect(opened).toBe(false);
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/b\/shop$/);
      const info = JSON.parse(await readFile(join(root, ".gabiro/server.json"), "utf8"));
      pid = info.pid;
      expect(await health(info.url)).toMatchObject({ ok: true, root });

      const again = (await client.callTool({ name: "gabiro_open_board", arguments: {} })) as CallToolResult;
      expect((again.structuredContent as { url: string }).url).toBe(info.url);
    } finally {
      await client.close();
      if (pid) process.kill(pid, "SIGTERM");
    }
  }, 30_000);

  it.skipIf(!chromiumPath)("the browser canvas renders a board and shows agent changes live", async () => {
    const root = await tempRoot();
    const svc = new BoardService(root);
    await svc.create({
      title: "Checkout",
      kind: "architecture",
      ops: [
        { op: "add_node", id: "web", type: "client", label: "Web App" },
        { op: "add_node", id: "api", type: "service", label: "Checkout API" },
        { op: "add_edge", from: "web", to: "api", type: "sync", label: "HTTPS" },
      ],
    });
    const server = await startCanvasServer({ root, port: 0, webDir, recordInfo: false });
    const browser = await chromium.launch({ executablePath: chromiumPath });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${server.url}/b/checkout`);
      await page.getByText("Checkout API").waitFor();
      await page.getByText("● live").waitFor();
      expect(await page.locator(".react-flow__node").count()).toBe(2);

      await svc.applyChanges("checkout", [
        { op: "add_node", id: "cache", type: "cache", label: "Redis Cache" },
        { op: "add_edge", from: "api", to: "cache", type: "sync" },
      ]);
      await page.getByText("Redis Cache").waitFor({ timeout: 5000 });
      expect(await page.locator(".gb-flash").count()).toBeGreaterThan(0);
      await page.getByText("revision 2").waitFor();

      await page.goto(`${server.url}/`);
      await page.getByText("Checkout").first().waitFor();
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await server.close();
    }
  }, 30_000);
});
