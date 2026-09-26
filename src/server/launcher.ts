import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GabiroError } from "../core/index.js";
import { withFileLock } from "../store/index.js";
import { isHealthy, isProcessAlive, readServerInfo } from "./info.js";

/** dist/server/launcher.js -> dist/cli.js */
const defaultCliPath = () => fileURLToPath(new URL("../cli.js", import.meta.url));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Returns true only for URLs matching exactly the local canvas URL pattern (127.0.0.1, localhost, or [::1]). */
export function isLocalCanvasUrl(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/.test(url);
}

/** URL of this project's running canvas (optionally for one board), or undefined if none is recorded as running. */
export async function canvasUrl(root: string, boardId?: string): Promise<string | undefined> {
  const info = await readServerInfo(root);
  if (!info || info.root !== root || !isProcessAlive(info.pid)) return undefined;
  return boardId ? `${info.url}/b/${boardId}` : info.url;
}

export interface EnsureOptions {
  /** Path to the built CLI used to spawn `gabiro serve`. */
  cliPath?: string;
  timeoutMs?: number;
}

/** Minutes without an open canvas after which a server spawned by the launcher exits. */
const SPAWNED_IDLE_EXIT_MINUTES = 30;

/**
 * Returns the base URL of this project's canvas server, starting a detached `gabiro serve` if none
 * is healthy. The spawned server outlives the MCP process, like a normal dev server, and exits
 * after 30 minutes without an open canvas. Concurrent callers are serialized by
 * `.gabiro/server.lock`, so they share one server.
 */
export async function ensureCanvasServer(root: string, options: EnsureOptions = {}): Promise<string> {
  const existing = await readServerInfo(root);
  if (existing && (await isHealthy(existing.url, root))) return existing.url;

  const cliPath = options.cliPath ?? defaultCliPath();
  if (!existsSync(cliPath)) {
    throw new GabiroError("UNAVAILABLE", `Can't start the canvas: ${cliPath} is missing. Run \`npm run build\` in the gabiro package.`);
  }
  const timeoutMs = options.timeoutMs ?? 8000;
  const seeWhy = `Run \`gabiro serve --root ${root}\` in a terminal to see why.`;

  return withFileLock(
    join(root, ".gabiro", "server.lock"),
    async () => {
      // Another caller may have started a server while we waited for the lock.
      const current = await readServerInfo(root);
      if (current && (await isHealthy(current.url, root))) return current.url;

      const child = spawn(
        process.execPath,
        [cliPath, "serve", "--root", root, "--idle-exit", String(SPAWNED_IDLE_EXIT_MINUTES)],
        { detached: true, stdio: "ignore", windowsHide: true },
      );
      let exited: string | undefined;
      const exit = new Promise<void>((resolve) => {
        child.once("exit", (code, signal) => {
          exited = signal ? `signal ${signal}` : `code ${code}`;
          resolve();
        });
        child.once("error", (err) => {
          exited = err.message;
          resolve();
        });
      });
      child.unref();

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await Promise.race([sleep(100), exit]);
        if (exited !== undefined) {
          throw new GabiroError("UNAVAILABLE", `The canvas server exited (${exited}) before it was ready. ${seeWhy}`);
        }
        const info = await readServerInfo(root);
        if (info && info.pid !== current?.pid && (await isHealthy(info.url, root))) return info.url;
      }
      throw new GabiroError("UNAVAILABLE", `The canvas server didn't start within ${Math.round(timeoutMs / 1000)}s. ${seeWhy}`);
    },
    20_000,
  );
}

/** Opens a local canvas URL in the default browser. Returns false when disabled via GABIRO_NO_BROWSER or when the URL isn't a local http(s) canvas URL; true once an opener was launched (a missing opener fails silently). */
export function openInBrowser(url: string): boolean {
  if (process.env.GABIRO_NO_BROWSER) return false;
  if (!isLocalCanvasUrl(url)) return false;
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
