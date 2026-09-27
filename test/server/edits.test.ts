import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_OPS_BODY, startCanvasServer, type CanvasServer } from "../../src/server/index.js";
import { BoardService } from "../../src/service/index.js";
import { tempRoot } from "../helpers.js";

const servers: CanvasServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function setup() {
  const root = await tempRoot();
  const svc = new BoardService(root);
  await svc.create({
    title: "Shop",
    kind: "architecture",
    ops: [
      { op: "add_node", id: "web", type: "client", label: "Web" },
      { op: "add_node", id: "api", type: "service", label: "API" },
      { op: "add_edge", from: "web", to: "api", type: "sync" },
    ],
  });
  const server = await startCanvasServer({ root, port: 0, webDir: root, recordInfo: false });
  servers.push(server);
  return { root, svc, server };
}

/** POSTs a raw body with explicit headers (node:http, so Origin and Content-Type are fully controlled). */
function post(port: number, path: string, body: string, headers: Record<string, string>) {
  return new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : {} }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const json = (port: number) => ({ "content-type": "application/json", origin: `http://127.0.0.1:${port}` });

describe("POST /api/boards/:id/ops", () => {
  it("applies ops, saves the board and returns the new revision", async () => {
    const { root, server } = await setup();
    const res = await post(
      server.port,
      "/api/boards/shop/ops",
      JSON.stringify({ ops: [{ op: "update_node", id: "api", position: { x: 500, y: 40 }, pinned: true }], expectedRevision: 1 }),
      json(server.port),
    );
    expect(res.status).toBe(200);
    expect(res.json.board).toMatchObject({ revision: 2 });
    const saved = JSON.parse(await readFile(join(root, ".gabiro/boards/shop.json"), "utf8"));
    expect(saved.nodes.find((n: { id: string }) => n.id === "api")).toMatchObject({ position: { x: 500, y: 40 }, pinned: true });
  });

  it("answers a stale revision with 409 and the latest board", async () => {
    const { svc, server } = await setup();
    await svc.applyChanges("shop", [{ op: "add_node", id: "db", type: "database", label: "DB" }]);
    const res = await post(
      server.port,
      "/api/boards/shop/ops",
      JSON.stringify({ ops: [{ op: "update_node", id: "api", label: "API v2" }], expectedRevision: 1 }),
      json(server.port),
    );
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: "CONFLICT", board: { revision: 2 } });
  });

  it("returns validation errors with the op index, and 404 for unknown boards", async () => {
    const { server } = await setup();
    const bad = await post(
      server.port,
      "/api/boards/shop/ops",
      JSON.stringify({ ops: [{ op: "add_node", id: "x", type: "step", label: "X" }] }),
      json(server.port),
    );
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/^Op #0 \(add_node\) failed/);
    const missing = await post(server.port, "/api/boards/nope/ops", JSON.stringify({ ops: [{ op: "remove_node", id: "a" }] }), json(server.port));
    expect(missing.status).toBe(404);
  });

  it("rejects malformed requests before touching the board", async () => {
    const { server } = await setup();
    const url = "/api/boards/shop/ops";
    expect((await post(server.port, url, "{nope", json(server.port))).status).toBe(400);
    expect((await post(server.port, url, JSON.stringify({ ops: [] }), json(server.port))).json.error).toMatch(/non-empty array/);
    expect((await post(server.port, url, JSON.stringify({ ops: [{ op: "x" }], expectedRevision: "1" }), json(server.port))).status).toBe(400);
    const huge = JSON.stringify({ ops: [{ op: "update_node", id: "api", description: "x".repeat(MAX_OPS_BODY) }] });
    expect((await post(server.port, url, huge, json(server.port))).status).toBe(413);
  });

  it("refuses cross-site edits: foreign Origin (403) and non-JSON bodies (415)", async () => {
    const { root, server } = await setup();
    const body = JSON.stringify({ ops: [{ op: "remove_node", id: "api" }] });
    const foreign = await post(server.port, "/api/boards/shop/ops", body, { "content-type": "application/json", origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    const form = await post(server.port, "/api/boards/shop/ops", body, {
      "content-type": "text/plain",
      origin: `http://127.0.0.1:${server.port}`,
    });
    expect(form.status).toBe(415);
    const saved = JSON.parse(await readFile(join(root, ".gabiro/boards/shop.json"), "utf8"));
    expect(saved.revision).toBe(1);
  });

  it("re-runs auto-layout on POST /layout, keeping pins unless forced", async () => {
    const { svc, server } = await setup();
    await svc.applyChanges("shop", [{ op: "update_node", id: "api", position: { x: 900, y: 900 }, pinned: true }]);
    const kept = await post(server.port, "/api/boards/shop/layout", "", json(server.port));
    expect(kept.status).toBe(200);
    const api = (b: unknown) => (b as { nodes: { id: string; position: unknown; pinned?: boolean }[] }).nodes.find((n) => n.id === "api")!;
    expect(api(kept.json.board)).toMatchObject({ position: { x: 900, y: 900 }, pinned: true });
    const forced = await post(server.port, "/api/boards/shop/layout", JSON.stringify({ force: true }), json(server.port));
    expect(api(forced.json.board).pinned).toBeUndefined();
    expect((await post(server.port, "/api/boards/shop/layout", JSON.stringify({ force: "yes" }), json(server.port))).status).toBe(400);
    const foreign = await post(server.port, "/api/boards/shop/layout", "", { "content-type": "application/json", origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
  });

  it("still refuses other write methods", async () => {
    const { server } = await setup();
    const res = await fetch(`${server.url}/api/boards/shop`, { method: "PUT", body: "{}" });
    expect(res.status).toBe(405);
  });
});

describe("WebSocket frame errors", () => {
  it("survives a protocol-violating frame from a local client", async () => {
    const { server } = await setup();
    const sock = connect(server.port, "127.0.0.1");
    await new Promise((r) => sock.once("connect", r));
    sock.write(
      [
        "GET /ws HTTP/1.1",
        `Host: 127.0.0.1:${server.port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );
    await new Promise((r) => sock.once("data", r));
    // An unmasked client frame is a protocol error ("MASK must be set").
    sock.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
    await new Promise((r) => sock.once("close", r));
    expect((await fetch(`${server.url}/api/health`)).status).toBe(200);
  });
});
