import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startCanvasServer, type CanvasServer, type ServerMessage } from "../../src/server/index.js";
import { BoardService } from "../../src/service/index.js";
import { tempRoot } from "../helpers.js";

const servers: CanvasServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(root: string, extra: { webDir?: string; port?: number } = {}) {
  const server = await startCanvasServer({ root, port: extra.port ?? 0, webDir: extra.webDir ?? join(root, "no-web") });
  servers.push(server);
  return server;
}

/** Opens a socket and returns a helper that waits for the next message matching a predicate. */
async function socket(url: string) {
  const ws = new WebSocket(url.replace("http", "ws") + "/ws");
  const inbox: ServerMessage[] = [];
  const waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString()) as ServerMessage;
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(msg);
    else inbox.push(msg);
  });
  await new Promise((r) => ws.once("open", r));
  const next = (pred: (m: ServerMessage) => boolean, timeoutMs = 3000) =>
    new Promise<ServerMessage>((resolve, reject) => {
      const i = inbox.findIndex(pred);
      if (i >= 0) return resolve(inbox.splice(i, 1)[0]!);
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
      waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  return { ws, send: (m: unknown) => ws.send(JSON.stringify(m)), next };
}

const CHECKOUT = [
  { op: "add_node", id: "web", type: "client", label: "Web" },
  { op: "add_node", id: "api", type: "service", label: "API" },
  { op: "add_edge", from: "web", to: "api", type: "sync" },
];

describe("canvas server HTTP", () => {
  it("reports health with its project root", async () => {
    const root = await tempRoot();
    const s = await start(root);
    const body = await (await fetch(`${s.url}/api/health`)).json();
    expect(body).toMatchObject({ ok: true, root, pid: process.pid });
  });

  it("lists and returns boards as JSON, with GabiroError codes on failure", async () => {
    const root = await tempRoot();
    await new BoardService(root).create({ title: "Shop", kind: "architecture", ops: CHECKOUT });
    const s = await start(root);
    expect((await (await fetch(`${s.url}/api/boards`)).json()).boards).toMatchObject([{ id: "shop", nodeCount: 2 }]);
    expect((await (await fetch(`${s.url}/api/boards/shop`)).json()).board.nodes).toHaveLength(2);
    const missing = await fetch(`${s.url}/api/boards/nope`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "NOT_FOUND" });
    expect((await fetch(`${s.url}/api/boards/shop`, { method: "POST" })).status).toBe(405);
  });

  it("serves the web app with an index.html fallback for app routes, and never outside webDir", async () => {
    const root = await tempRoot();
    const webDir = join(root, "web");
    await mkdir(join(webDir, "assets"), { recursive: true });
    await writeFile(join(webDir, "index.html"), "<html>canvas</html>");
    await writeFile(join(webDir, "assets", "app.js"), "console.log(1)");
    await writeFile(join(root, "secret.txt"), "secret");
    const s = await start(root, { webDir });
    expect(await (await fetch(`${s.url}/`)).text()).toBe("<html>canvas</html>");
    expect(await (await fetch(`${s.url}/b/shop`)).text()).toBe("<html>canvas</html>");
    const js = await fetch(`${s.url}/assets/app.js`);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect((await fetch(`${s.url}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${s.url}/%2e%2e/secret.txt`)).status).toBe(404);
  });

  it("explains a missing web build", async () => {
    const s = await start(await tempRoot());
    const res = await fetch(`${s.url}/`);
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/npm run build/);
  });

  it("falls back to the next port when the first is taken", async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    const taken = (blocker.address() as { port: number }).port;
    try {
      const s = await start(await tempRoot(), { port: taken });
      expect(s.port).toBeGreaterThan(taken);
    } finally {
      blocker.close();
    }
  });

  it("records itself in .gabiro/server.json and removes it on close", async () => {
    const root = await tempRoot();
    const s = await startCanvasServer({ root, port: 0, webDir: root });
    const info = JSON.parse(await readFile(join(root, ".gabiro/server.json"), "utf8"));
    expect(info).toEqual({ pid: process.pid, port: s.port, url: s.url, root });
    await s.close();
    await expect(stat(join(root, ".gabiro/server.json"))).rejects.toThrow();
  });
});

describe("canvas server live updates", () => {
  it("sends a snapshot on subscribe and pushes every change", async () => {
    const root = await tempRoot();
    const svc = new BoardService(root);
    await svc.create({ title: "Shop", kind: "architecture", ops: CHECKOUT });
    const s = await start(root);
    const c = await socket(s.url);
    c.send({ type: "subscribe", boardId: "shop" });
    const first = await c.next((m) => m.type === "board");
    expect(first).toMatchObject({ type: "board", board: { id: "shop", revision: 1 } });

    await svc.applyChanges("shop", [{ op: "add_node", id: "db", type: "database", label: "DB" }]);
    const pushed = await c.next((m) => m.type === "board" && m.board.revision === 2);
    expect(pushed.type === "board" && pushed.board.nodes.map((n) => n.id)).toContain("db");
    c.ws.close();
  });

  it("pushes the board list to list subscribers when boards are created", async () => {
    const root = await tempRoot();
    const s = await start(root);
    const c = await socket(s.url);
    c.send({ type: "subscribe-list" });
    expect(await c.next((m) => m.type === "boards")).toEqual({ type: "boards", boards: [] });
    await new BoardService(root).create({ title: "Shop", kind: "architecture" });
    const update = await c.next((m) => m.type === "boards" && m.boards.length === 1);
    expect(update).toMatchObject({ boards: [{ id: "shop" }] });
    c.ws.close();
  });

  it("reports corrupt and deleted boards as board-error messages", async () => {
    const root = await tempRoot();
    const svc = new BoardService(root);
    await svc.create({ title: "Shop", kind: "architecture" });
    const s = await start(root);
    const c = await socket(s.url);
    c.send({ type: "subscribe", boardId: "shop" });
    await c.next((m) => m.type === "board");

    await writeFile(join(root, ".gabiro/boards/shop.json"), "{ broken");
    expect(await c.next((m) => m.type === "board-error")).toMatchObject({ boardId: "shop", code: "CORRUPT" });

    await svc.store.delete("shop");
    expect(await c.next((m) => m.type === "board-error" && m.code === "NOT_FOUND")).toMatchObject({ boardId: "shop" });
    c.ws.close();
  });
});
