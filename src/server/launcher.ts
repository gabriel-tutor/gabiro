import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GabiroError } from "../core/index.js";
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

/**
 * Returns the base URL of this project's canvas server, starting a detached `gabiro serve` if none
 * is healthy. The spawned server outlives the MCP process, like a normal dev server.
 */
export async function ensureCanvasServer(root: string, options: EnsureOptions = {}): Promise<string> {
  const existing = await readServerInfo(root);
  if (existing && (await isHealthy(existing.url, root))) return existing.url;

  const cliPath = options.cliPath ?? defaultCliPath();
  if (!existsSync(cliPath)) {
    throw new GabiroError("UNAVAILABLE", `Can't start the canvas: ${cliPath} is missing. Run \`npm run build\` in the gabiro package.`);
  }
  const child = spawn(process.execPath, [cliPath, "serve", "--root", root], { detached: true, stdio: "ignore" });
  child.unref();

  const deadline = Date.now() + (options.timeoutMs ?? 8000);
  while (Date.now() < deadline) {
    await sleep(100);
    const info = await readServerInfo(root);
    if (info && info.pid !== existing?.pid && (await isHealthy(info.url, root))) return info.url;
  }
  throw new GabiroError(
    "UNAVAILABLE",
    `The canvas server didn't start within ${Math.round((options.timeoutMs ?? 8000) / 1000)}s. Run \`gabiro serve --root ${root}\` in a terminal to see why.`,
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
