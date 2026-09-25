import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { GabiroError } from "../core/index.js";
import { BoardService } from "../service/index.js";
import { VERSION } from "../version.js";
import { clearServerInfo, writeServerInfo } from "./info.js";
import type { ClientMessage, HealthResponse, ServerMessage } from "./protocol.js";
import { serveStatic } from "./static.js";
import { watchBoards } from "./watch.js";

export const DEFAULT_PORT = 4477;
const PORT_ATTEMPTS = 20;

export interface CanvasServerOptions {
  root: string;
  /** First port to try; the next free port is used if it is taken. 0 picks any free port. */
  port?: number;
  host?: string;
  /** Directory with the built web app. Defaults to dist/web next to this module. */
  webDir?: string;
  /** Write .gabiro/server.json so MCP tools can find this server. Default true. */
  recordInfo?: boolean;
}

export interface CanvasServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** dist/server/canvas-server.js -> dist/web */
export const defaultWebDir = () => fileURLToPath(new URL("../web", import.meta.url));

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function errorStatus(code: string): number {
  return code === "NOT_FOUND" ? 404 : code === "VALIDATION" ? 400 : code === "CONFLICT" ? 409 : 500;
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/** Starts the canvas: JSON API, static web app, and live board pushes over WebSocket at /ws. */
export async function startCanvasServer(options: CanvasServerOptions): Promise<CanvasServer> {
  const { root, host = "127.0.0.1", recordInfo = true } = options;
  const webDir = options.webDir ?? defaultWebDir();
  const service = new BoardService(root);

  const http = createServer((req, res) => {
    handleHttp(req, res).catch((err) => sendJson(res, 500, { code: "INTERNAL", error: (err as Error).message }));
  });

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { code: "VALIDATION", error: "The canvas API is read-only in this version." });
      return;
    }
    if (pathname === "/api/health") {
      const body: HealthResponse = { ok: true, root, version: VERSION, pid: process.pid };
      sendJson(res, 200, body);
      return;
    }
    if (pathname === "/api/boards") {
      sendJson(res, 200, { boards: await service.list() });
      return;
    }
    const match = /^\/api\/boards\/([^/]+)$/.exec(pathname);
    if (match) {
      try {
        sendJson(res, 200, { board: await service.get(decodeURIComponent(match[1]!)) });
      } catch (err) {
        if (!(err instanceof GabiroError)) throw err;
        sendJson(res, errorStatus(err.code), { code: err.code, error: err.message });
      }
      return;
    }
    if (pathname.startsWith("/api/")) {
      sendJson(res, 404, { code: "NOT_FOUND", error: `Unknown API route ${pathname}` });
      return;
    }
    await serveStatic(webDir, pathname, res);
  }

  // --- live updates -------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true });
  const boardSubs = new Map<WebSocket, Set<string>>();
  const listSubs = new Set<WebSocket>();

  const send = (ws: WebSocket, msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  async function boardMessage(boardId: string): Promise<ServerMessage> {
    try {
      return { type: "board", board: await service.get(boardId) };
    } catch (err) {
      const code = err instanceof GabiroError ? err.code : "INTERNAL";
      return { type: "board-error", boardId, code, message: (err as Error).message };
    }
  }

  http.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    boardSubs.set(ws, new Set());
    ws.on("close", () => {
      boardSubs.delete(ws);
      listSubs.delete(ws);
    });
    ws.on("message", async (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return;
      }
      if (msg.type === "subscribe" && typeof msg.boardId === "string") {
        boardSubs.get(ws)?.add(msg.boardId);
        send(ws, await boardMessage(msg.boardId));
      } else if (msg.type === "subscribe-list") {
        listSubs.add(ws);
        send(ws, { type: "boards", boards: await service.list() });
      }
    });
  });

  const stopWatching = watchBoards(join(root, ".gabiro", "boards"), async (boardId) => {
    const watchers = [...boardSubs].filter(([, ids]) => ids.has(boardId)).map(([ws]) => ws);
    if (watchers.length) {
      const msg = await boardMessage(boardId);
      for (const ws of watchers) send(ws, msg);
    }
    if (listSubs.size) {
      const msg: ServerMessage = { type: "boards", boards: await service.list() };
      for (const ws of listSubs) send(ws, msg);
    }
  });

  // --- listen, falling back to the next free port --------------------------
  const firstPort = options.port ?? DEFAULT_PORT;
  let port = -1;
  for (let attempt = 0; attempt < (firstPort === 0 ? 1 : PORT_ATTEMPTS); attempt++) {
    try {
      port = await listen(http, firstPort === 0 ? 0 : firstPort + attempt, host);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        stopWatching();
        throw err;
      }
    }
  }
  if (port < 0) {
    stopWatching();
    throw new GabiroError(
      "UNAVAILABLE",
      `Ports ${firstPort}-${firstPort + PORT_ATTEMPTS - 1} are all in use. Start the canvas with --port <free port>.`,
    );
  }

  const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;
  if (recordInfo) await writeServerInfo({ pid: process.pid, port, url, root });

  return {
    url,
    port,
    async close() {
      stopWatching();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      if (recordInfo) await clearServerInfo(root);
    },
  };
}
