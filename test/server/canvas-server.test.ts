import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { parseClientMessage } from "../../src/server/client-message.js";
import { startCanvasServer, type CanvasServer, type ServerMessage } from "../../src/server/index.js";
import { BoardService } from "../../src/service/index.js";
import { tempRoot } from "../helpers.js";

const servers: CanvasServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(root: string, extra: { webDir?: string; port?: number; idleExitMs?: number; onIdle?: () => void } = {}) {
  const server = await startCanvasServer({
    root,
    port: extra.port ?? 0,
    webDir: extra.webDir ?? join(root, "no-web"),
    idleExitMs: extra.idleExitMs,
    onIdle: extra.onIdle,
  });
  servers.push(server);
  return server;
}

/** Opens a socket and returns a helper that waits for the next message matching a predicate. */
async function socket(url: string, options?: { origin?: string }) {
  const ws = new WebSocket(url.replace("http", "ws") + "/ws", options);
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

/** GET with an explicit Host header (fetch forbids overriding it). */
function getWithHost(port: number, path: string, host: string | undefined) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", setHost: host !== undefined, headers: host === undefined ? {} : { host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Resolves with the HTTP status of a rejected upgrade, or "open" if the socket connects. */
function tryConnect(url: string, headers: Record<string, string> = {}, origin?: string) {
  return new Promise<number | "open" | "error">((resolve) => {
    const ws = new WebSocket(url.replace("http", "ws") + "/ws", { headers, origin });
    ws.on("open", () => (ws.close(), resolve("open")));
    ws.on("unexpected-response", (_req, res) => (resolve(res.statusCode ?? 0), ws.terminate()));
    ws.on("error", () => resolve("error"));
  });
}

describe("parseClientMessage", () => {
  it("accepts well-formed messages only", () => {
    expect(parseClientMessage('{"type":"subscribe","boardId":"shop"}')).toEqual({ type: "subscribe", boardId: "shop" });
    expect(parseClientMessage('{"type":"subscribe-list"}')).toEqual({ type: "subscribe-list" });
    for (const raw of ["null", "1", '"x"', "[]", "{ broken", '{"type":"nope"}', '{"type":"subscribe","boardId":"../x"}', '{"type":"subscribe"}']) {
      expect(parseClientMessage(raw)).toBeUndefined();
    }
  });
});

describe("canvas server robustness", () => {
  it("survives malformed WebSocket messages and keeps serving the same socket", async () => {
    const root = await tempRoot();
    await new BoardService(root).create({ title: "Shop", kind: "architecture" });
    const s = await start(root);
    const c = await socket(s.url);
    for (const raw of ["null", "1", '"x"', "{ broken", "[]"]) c.ws.send(raw);
    c.send({ type: "subscribe", boardId: "../x" });
    c.send({ type: "subscribe", boardId: 42 });
    c.send({ type: "nope" });
    await new Promise((r) => setTimeout(r, 100));
    expect((await (await fetch(`${s.url}/api/health`)).json()).ok).toBe(true);
    c.send({ type: "subscribe", boardId: "shop" });
    expect(await c.next((m) => m.type === "board")).toMatchObject({ board: { id: "shop" } });
    c.ws.close();
  });

  it("caps subscriptions per socket", async () => {
    const root = await tempRoot();
    await new BoardService(root).create({ title: "Shop", kind: "architecture" });
    const s = await start(root);
    const c = await socket(s.url);
    for (let i = 0; i < 50; i++) c.send({ type: "subscribe", boardId: `b${i}` });
    for (let i = 0; i < 50; i++) await c.next((m) => m.type === "board-error" && m.boardId === `b${i}`);
    c.send({ type: "subscribe", boardId: "shop" });
    await expect(c.next((m) => m.type === "board", 300)).rejects.toThrow(/timed out/);
    c.ws.close();
  });
});

describe("canvas server Host/Origin checks", () => {
  it("rejects HTTP requests with a foreign or missing Host header", async () => {
    const s = await start(await tempRoot());
    const evil = await getWithHost(s.port, "/api/health", "evil.example:1234");
    expect(evil.status).toBe(403);
    expect(JSON.parse(evil.body)).toEqual({
      code: "FORBIDDEN",
      error: `Unexpected Host header. Open the canvas at http://127.0.0.1:${s.port}.`,
    });
    expect((await getWithHost(s.port, "/api/boards", `127.0.0.1:${s.port + 1}`)).status).toBe(403);
    expect((await getWithHost(s.port, "/api/health", undefined)).status).toBe(403);
    for (const host of [`127.0.0.1:${s.port}`, `localhost:${s.port}`, `[::1]:${s.port}`]) {
      expect((await getWithHost(s.port, "/api/health", host)).status).toBe(200);
    }
  });

  it("rejects WebSocket upgrades from foreign origins or hosts", async () => {
    const s = await start(await tempRoot());
    expect(await tryConnect(s.url, {}, "https://evil.example")).toBe(403);
    expect(await tryConnect(s.url, {}, `http://127.0.0.1:${s.port + 1}`)).toBe(403);
    expect(await tryConnect(s.url, { host: "evil.example" })).toBe(403);
  });

  it("accepts WebSocket clients from the canvas origin or without an origin", async () => {
    const root = await tempRoot();
    await new BoardService(root).create({ title: "Shop", kind: "architecture" });
    const s = await start(root);
    for (const origin of [`http://127.0.0.1:${s.port}`, `http://localhost:${s.port}`, undefined]) {
      const c = await socket(s.url, origin ? { origin } : undefined);
      c.send({ type: "subscribe", boardId: "shop" });
      expect(await c.next((m) => m.type === "board")).toMatchObject({ board: { id: "shop" } });
      c.ws.close();
    }
  });
});

describe("canvas server idle exit", () => {
  it("calls onIdle when no client connects", async () => {
    let idle = 0;
    await start(await tempRoot(), { idleExitMs: 150, onIdle: () => idle++ });
    await new Promise((r) => setTimeout(r, 400));
    expect(idle).toBeGreaterThanOrEqual(1);
  });

  it("does not idle while a client is connected, and idles after it leaves", async () => {
    let idle = 0;
    const s = await start(await tempRoot(), { idleExitMs: 150, onIdle: () => idle++ });
    const c = await socket(s.url);
    await new Promise((r) => setTimeout(r, 400));
    expect(idle).toBe(0);
    c.ws.close();
    await new Promise((r) => setTimeout(r, 400));
    expect(idle).toBe(1);
  });

  it("never idles without idleExitMs", async () => {
    let idle = 0;
    await start(await tempRoot(), { onIdle: () => idle++ });
    await new Promise((r) => setTimeout(r, 300));
    expect(idle).toBe(0);
  });
});
