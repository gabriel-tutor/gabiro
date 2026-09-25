import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canvasUrl, ensureCanvasServer, openInBrowser, startCanvasServer, type CanvasServer } from "../../src/server/index.js";
import { GabiroError } from "../../src/core/index.js";
import { tempRoot } from "../helpers.js";

const servers: CanvasServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function writeInfo(root: string, info: object) {
  await mkdir(join(root, ".gabiro"), { recursive: true });
  await writeFile(join(root, ".gabiro/server.json"), JSON.stringify(info));
}

describe("canvasUrl", () => {
  it("is undefined when no server is recorded", async () => {
    expect(await canvasUrl(await tempRoot())).toBeUndefined();
  });

  it("builds board URLs for a live recorded server", async () => {
    const root = await tempRoot();
    await writeInfo(root, { pid: process.pid, port: 4477, url: "http://127.0.0.1:4477", root });
    expect(await canvasUrl(root)).toBe("http://127.0.0.1:4477");
    expect(await canvasUrl(root, "shop")).toBe("http://127.0.0.1:4477/b/shop");
  });

  it("ignores a record left by a dead process or another project", async () => {
    const root = await tempRoot();
    await writeInfo(root, { pid: 2 ** 22 + 12345, port: 1, url: "http://127.0.0.1:1", root });
    expect(await canvasUrl(root)).toBeUndefined();
    await writeInfo(root, { pid: process.pid, port: 1, url: "http://127.0.0.1:1", root: "/elsewhere" });
    expect(await canvasUrl(root)).toBeUndefined();
  });
});

describe("ensureCanvasServer", () => {
  it("reuses a healthy server for the same project without spawning", async () => {
    const root = await tempRoot();
    const s = await startCanvasServer({ root, port: 0, webDir: root });
    servers.push(s);
    expect(await ensureCanvasServer(root, { cliPath: "/definitely/missing/cli.js" })).toBe(s.url);
  });

  it("explains how to fix a missing build instead of spawning", async () => {
    const err = await ensureCanvasServer(await tempRoot(), { cliPath: "/definitely/missing/cli.js" }).catch((e) => e);
    expect(err).toBeInstanceOf(GabiroError);
    expect(err.code).toBe("UNAVAILABLE");
    expect(err.message).toMatch(/npm run build/);
  });
});

describe("openInBrowser", () => {
  it("does nothing when GABIRO_NO_BROWSER is set", () => {
    const before = process.env.GABIRO_NO_BROWSER;
    process.env.GABIRO_NO_BROWSER = "1";
    try {
      expect(openInBrowser("http://127.0.0.1:1")).toBe(false);
    } finally {
      if (before === undefined) delete process.env.GABIRO_NO_BROWSER;
      else process.env.GABIRO_NO_BROWSER = before;
    }
  });
});
