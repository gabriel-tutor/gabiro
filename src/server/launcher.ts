import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GabiroError } from "../core/index.js";
import { withFileLock } from "../store/index.js";
import { isHealthy, isLocalCanvasUrl, isProcessAlive, readServerInfo } from "./info.js";

export { isLocalCanvasUrl } from "./info.js";

/** dist/server/launcher.js -> dist/cli.js */
const defaultCliPath = () => fileURLToPath(new URL("../cli.js", import.meta.url));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Starts a detached opener process; false if it couldn't be spawned (a missing binary fails silently). */
function spawnDetached(cmd: string, args: string[]): boolean {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
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
  return spawnDetached(cmd, args);
}

/** Where `gabiro_open_board` showed the canvas. */
export interface OpenCanvasResult {
  url?: string;
  via: "app" | "browser" | "none";
  /** True when the app accepted the hand-off but hasn't reported a server for the project yet. */
  appPending?: boolean;
}

export interface OpenCanvasOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Whether Gabiro.app is installed. */
  appInstalled?: () => boolean;
  /** Hands a gabiro:// link to the OS; resolves false if that failed. */
  openLink?: (link: string) => Promise<boolean>;
  ensure?: (root: string) => Promise<string>;
  openBrowser?: (url: string) => boolean;
  /** How long to wait for the app to serve the project. Default 8000. */
  appTimeoutMs?: number;
}

/** True when Gabiro.app is in /Applications or ~/Applications, or this process runs from inside it. */
export function isGabiroAppInstalled(): boolean {
  if (/\/Gabiro\.app\/Contents\/MacOS\//.test(process.execPath)) return true;
  return [join("/Applications", "Gabiro.app"), join(homedir(), "Applications", "Gabiro.app")].some((p) => existsSync(p));
}

/** The link that asks Gabiro.app to show a project (and optionally one board). */
export function appLink(root: string, boardId?: string): string {
  const params = new URLSearchParams({ root });
  if (boardId) params.set("board", boardId);
  return `gabiro://open?${params}`;
}

/** Hands a link to `open`; resolves true only if it exits 0 within 5s (false on a non-zero exit, an error, or a timeout). */
function openWithMacOS(link: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn("open", [link], { stdio: "ignore" });
    const timer = setTimeout(() => {
      finish(false);
      child.kill();
    }, 5000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
    child.once("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

/** Polls server.json until it names a server healthy for this root; undefined after `timeoutMs`. */
async function waitForServer(root: string, timeoutMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await readServerInfo(root);
    if (info && (await isHealthy(info.url, root))) return info.url;
    if (Date.now() >= deadline) return undefined;
    await sleep(200);
  }
}

/**
 * Shows this project's canvas (optionally one board). On macOS with Gabiro.app installed it hands
 * the link to the app, which opens or focuses the project's window; once the app accepts the link,
 * it owns showing the board and this never falls back to the browser. Otherwise, or if the link
 * can't be handed to the app, it ensures a canvas server and opens the browser.
 * GABIRO_NO_APP skips the app; GABIRO_NO_BROWSER skips both.
 */
export async function openCanvas(root: string, boardId?: string, options: OpenCanvasOptions = {}): Promise<OpenCanvasResult> {
  const env = options.env ?? process.env;
  const withBoard = (base: string) => (boardId ? `${base}/b/${boardId}` : base);

  const useApp =
    (options.platform ?? process.platform) === "darwin" &&
    !env.GABIRO_NO_APP &&
    !env.GABIRO_NO_BROWSER &&
    (options.appInstalled ?? isGabiroAppInstalled)();
  if (useApp && (await (options.openLink ?? openWithMacOS)(appLink(root, boardId)))) {
    const base = await waitForServer(root, options.appTimeoutMs ?? 8000);
    return base ? { url: withBoard(base), via: "app" } : { via: "app", appPending: true };
  }

  const url = withBoard(await (options.ensure ?? ((r) => ensureCanvasServer(r)))(root));
  const opened = !env.GABIRO_NO_BROWSER && (options.openBrowser ?? openInBrowser)(url);
  return { url, via: opened ? "browser" : "none" };
}
