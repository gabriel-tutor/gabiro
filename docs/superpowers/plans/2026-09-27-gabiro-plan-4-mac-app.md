# Gabiro Plan 4: Mac Dock App — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `Gabiro.app`, an Electron app you launch from the Dock. It has a start window with recent projects, one window per project showing its live canvas, and `gabiro://` deep links, so `gabiro_open_board` brings the board up in the app. It bundles the gabiro CLI so agents can connect without Node, and GitHub Actions builds a universal `.dmg`.

**Architecture:**
- **Main process.** The Electron main process (`desktop/src/main.ts`) imports the built server from `dist/`. Its logic lives in small modules that don't import Electron, so Vitest tests them directly:
  - `deeplink.ts` parses links;
  - `recent.ts` is the recent-projects store;
  - `projects.ts` is `ProjectManager`, with its window and server factories injected;
  - `agent-setup.ts` builds the setup snippets.
- **Windows.** Project windows load the project's canvas server over HTTP and are sandboxed. They can only navigate within their server's origin.
- **Start window.** A local page with a four-function preload bridge.
- **Agent side.** `openCanvas` in `src/server/launcher.ts` sends `gabiro://open?...` to the app when it is installed on macOS, and falls back to the browser.

Spec: `docs/superpowers/specs/2026-09-27-gabiro-mac-app-design.md`.

**Tech Stack:** Existing (TypeScript ESM, Vitest, `playwright-core`, React 19, Vite 8) plus **`electron` ^44.4.5** and **`electron-builder` ^26.15.3** as devDependencies.

**Verified:** Every code block here was compiled and run before the plan was written.
- **Tests:** 29 test files and 229 tests pass under `xvfb-run -a npm test`, including the two Electron smoke tests (3 runs in a row). The server, web and desktop typechecks are clean, and `npm run build` is warning-free.
- **Packaging on Linux** (`electron-builder --dir`, since macOS can't run here): `resources/bin/gabiro` keeps its exec bit. The bundled CLI runs from inside `app.asar` on Electron's own Node (`ELECTRON_RUN_AS_NODE=1`) and resolves its bundle from a `Gabiro.app/Contents/{MacOS,Resources}` layout. It covers `--version`, MCP over stdio including ELK layout, `gabiro serve` serving the web app out of the asar, and `gabiro_open_board` spawning a detached `serve` on the same binary.
- **Screenshots:** the start window (with a missing project) and a canvas window with "Switch project" were reviewed.

Found while verifying, and handled in this plan's code:
- Playwright's `click()` waits forever on a navigation the app cancels (`gabiro://start`), so the smoke test clicks through the DOM.
- A fully unsigned universal build shows as "damaged" on Apple Silicon, so the app is ad-hoc signed (`identity: "-"`, `hardenedRuntime: false`). The spec was updated to match.
- The smoke tests need a 60 s timeout, and `--no-sandbox` on Linux (root containers, and AppArmor on Ubuntu CI runners).
- The recent-projects tests use real paths, because macOS temp dirs sit behind a `/var` → `/private/var` symlink.

**Can't be verified in this Linux container** (the macOS CI job and the README checklist cover these): `open-url` delivery from macOS, the Dock menu, Gatekeeper, and the universal `.dmg` itself.

**Starting point:** the Plan 3 branch as reviewed (HEAD `9208e8b`): 23 test files, 196 tests passing.

---

## File structure

```
src/server/launcher.ts        + openCanvas (app via gabiro:// on macOS, else browser), appLink, isGabiroAppInstalled
src/server/index.ts           exports them, plus isHealthy
src/mcp/tools.ts              CanvasAccess.show replaces ensure/open; gabiro_open_board reports via app/browser/none
web/src/SwitchProject.tsx     "Switch project" header link, only inside the app (user agent has "Gabiro/")
web/src/BoardList.tsx, BoardView.tsx, styles.css   render it
desktop/src/deeplink.ts       parseDeepLink: gabiro://start, gabiro://open?root=&board= (strict validation)
desktop/src/recent.ts         RecentProjects (<userData>/recent.json, max 10, atomic, serialized), describeProject
desktop/src/agent-setup.ts    claude mcp add command and mcpServers JSON
desktop/src/projects.ts       ProjectManager: one window per root; reuse healthy server or start and own one
desktop/src/main.ts           Electron wiring: windows, navigation guard, start window IPC, menus, Dock, deep links, quit
desktop/preload.cjs           start window bridge: list / open / openFolder / forget
desktop/start.{html,css,js}   start window
desktop/bin/gabiro            CLI launcher inside the bundle (ELECTRON_RUN_AS_NODE)
desktop/tsconfig.json         compiles desktop/src to desktop/dist
electron-builder.yml          universal dmg + zip, ad-hoc signed, gabiro:// protocol, bin/gabiro resource
.github/workflows/ci.yml      ubuntu: build, typecheck, tests under xvfb; macos: package the app, upload the dmg
.github/workflows/release.yml v* tags: package and attach dmg + zip to the GitHub Release
package.json                  productName, main, desktop:build / desktop:start / app:mac, electron devDependencies
tsconfig.build.json           declaration: true (desktop/src imports dist/ with types)
test/server/open-canvas.test.ts, test/desktop/{deeplink,recent,agent-setup,projects,app.smoke}.test.ts; updated test/mcp/tools.test.ts
README.md                     "Mac app" section and development notes
```

**Conventions:**
- The same as Plans 1–3.
- `desktop/src/{deeplink,recent,agent-setup,projects}.ts` must not import `electron` or anything from `dist/`: the unit tests import them directly. Only `main.ts` touches Electron and `dist/`.
- Commit trailer:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ
```

---

### Task 1: `openCanvas`: prefer the Mac app, fall back to the browser

**Files:**
- Create: `test/server/open-canvas.test.ts`
- Modify: `src/server/launcher.ts`, `src/server/index.ts`

`openCanvas(root, boardId?, options?)` decides where the canvas is shown:
- **The app.** On macOS, when Gabiro.app is installed and neither `GABIRO_NO_APP` nor `GABIRO_NO_BROWSER` is set, it hands `gabiro://open?root=…&board=…` to macOS `open`. It then polls `.gabiro/server.json` for up to 8 s until a server healthy for this root appears.
- **The browser.** Otherwise, or on timeout, it runs today's flow: `ensureCanvasServer`, then `openInBrowser`.
- **Testing.** Every side effect is injectable through `options`.

- [ ] **Step 1: Write the failing test**

Complete file `test/server/open-canvas.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { appLink, openCanvas, startCanvasServer, type CanvasServer, type OpenCanvasOptions } from "../../src/server/index.js";
import { tempRoot } from "../helpers.js";

const servers: CanvasServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** Fakes for everything openCanvas touches; `links` and `browsed` record what it opened. */
function fakes(overrides: OpenCanvasOptions = {}) {
  const links: string[] = [];
  const browsed: string[] = [];
  const options: OpenCanvasOptions = {
    platform: "darwin",
    env: {},
    appInstalled: () => true,
    openLink: (link) => (links.push(link), true),
    ensure: async () => "http://127.0.0.1:4477",
    openBrowser: (url) => (browsed.push(url), true),
    appTimeoutMs: 300,
    ...overrides,
  };
  return { options, links, browsed };
}

describe("openCanvas", () => {
  it("asks the Mac app and returns the URL of the server it serves the project from", async () => {
    const root = await tempRoot();
    const { options, links, browsed } = fakes({ appTimeoutMs: 5000 });
    // The "app" starts a canvas server for the project when it receives the link.
    options.openLink = (link) => {
      links.push(link);
      void startCanvasServer({ root, port: 0, webDir: root }).then((s) => servers.push(s));
      return true;
    };
    const result = await openCanvas(root, "checkout", options);
    expect(links).toEqual([appLink(root, "checkout")]);
    expect(result).toEqual({ url: `${servers[0]!.url}/b/checkout`, via: "app" });
    expect(browsed).toEqual([]);
  });

  it("falls back to the browser when the app doesn't serve the project in time", async () => {
    const root = await tempRoot();
    const { options, links, browsed } = fakes();
    const result = await openCanvas(root, undefined, options);
    expect(links).toHaveLength(1);
    expect(result).toEqual({ url: "http://127.0.0.1:4477", via: "browser", appTimedOut: true });
    expect(browsed).toEqual(["http://127.0.0.1:4477"]);
  });

  it("uses the browser when not on macOS, the app isn't installed, or GABIRO_NO_APP is set", async () => {
    const root = await tempRoot();
    for (const overrides of [{ platform: "linux" as const }, { appInstalled: () => false }, { env: { GABIRO_NO_APP: "1" } }]) {
      const { options, links, browsed } = fakes(overrides);
      expect(await openCanvas(root, "shop", options)).toEqual({ url: "http://127.0.0.1:4477/b/shop", via: "browser" });
      expect(links).toEqual([]);
      expect(browsed).toEqual(["http://127.0.0.1:4477/b/shop"]);
    }
  });

  it("opens nothing with GABIRO_NO_BROWSER but still returns the running canvas", async () => {
    const root = await tempRoot();
    const { options, links, browsed } = fakes({ env: { GABIRO_NO_BROWSER: "1" } });
    expect(await openCanvas(root, undefined, options)).toEqual({ url: "http://127.0.0.1:4477", via: "none" });
    expect(links).toEqual([]);
    expect(browsed).toEqual([]);
  });

  it("reports via none when the browser can't be opened", async () => {
    const root = await tempRoot();
    const { options } = fakes({ platform: "linux", openBrowser: () => false });
    expect(await openCanvas(root, undefined, options)).toEqual({ url: "http://127.0.0.1:4477", via: "none" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run test/server/open-canvas.test.ts
```

Expected: FAIL. `appLink` and `openCanvas` are not exported from `src/server/index.js`.

- [ ] **Step 3: Implement**

Complete file `src/server/launcher.ts`:

```ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
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

/** Where `gabiro_open_board` showed the canvas. */
export interface OpenCanvasResult {
  url: string;
  via: "app" | "browser" | "none";
  /** True when the Gabiro app was asked first but didn't show the project in time. */
  appTimedOut?: boolean;
}

export interface OpenCanvasOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Whether Gabiro.app is installed. */
  appInstalled?: () => boolean;
  /** Hands a gabiro:// link to the OS; false if that failed. */
  openLink?: (link: string) => boolean;
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

function openWithMacOS(link: string): boolean {
  try {
    const child = spawn("open", [link], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
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
 * Shows this project's canvas (optionally one board). On macOS with Gabiro.app installed it asks
 * the app, which opens or focuses the project's window, and waits for the project's server. Otherwise,
 * or if the app doesn't come up in time, it ensures a canvas server and opens the browser.
 * GABIRO_NO_APP skips the app; GABIRO_NO_BROWSER skips both.
 */
export async function openCanvas(root: string, boardId?: string, options: OpenCanvasOptions = {}): Promise<OpenCanvasResult> {
  const env = options.env ?? process.env;
  const withBoard = (base: string) => (boardId ? `${base}/b/${boardId}` : base);
  let appTimedOut = false;

  const useApp =
    (options.platform ?? process.platform) === "darwin" &&
    !env.GABIRO_NO_APP &&
    !env.GABIRO_NO_BROWSER &&
    (options.appInstalled ?? isGabiroAppInstalled)();
  if (useApp && (options.openLink ?? openWithMacOS)(appLink(root, boardId))) {
    const base = await waitForServer(root, options.appTimeoutMs ?? 8000);
    if (base) return { url: withBoard(base), via: "app" };
    appTimedOut = true;
  }

  const url = withBoard(await (options.ensure ?? ((r) => ensureCanvasServer(r)))(root));
  const opened = !env.GABIRO_NO_BROWSER && (options.openBrowser ?? openInBrowser)(url);
  return { url, via: opened ? "browser" : "none", ...(appTimedOut ? { appTimedOut } : {}) };
}
```

Complete file `src/server/index.ts`:

```ts
export { startCanvasServer, DEFAULT_PORT, MAX_OPS_BODY, type CanvasServer, type CanvasServerOptions } from "./canvas-server.js";
export {
  appLink,
  canvasUrl,
  ensureCanvasServer,
  isGabiroAppInstalled,
  isLocalCanvasUrl,
  openCanvas,
  openInBrowser,
  type OpenCanvasOptions,
  type OpenCanvasResult,
} from "./launcher.js";
export { isHealthy, readServerInfo, type ServerInfo } from "./info.js";
export type { ClientMessage, ServerMessage, HealthResponse } from "./protocol.js";
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/server && npx tsc --noEmit
```

Expected: PASS (the launcher, canvas-server, edits, watch and open-canvas tests), and a clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/server/launcher.ts src/server/index.ts test/server/open-canvas.test.ts
git commit -m "feat(server): openCanvas prefers the Gabiro app on macOS, falls back to the browser" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

---

### Task 2: `gabiro_open_board` opens the board in the app

**Files:**
- Modify: `src/mcp/tools.ts`, `test/mcp/tools.test.ts`

`CanvasAccess` swaps `ensure` and `open` for a single `show(root, boardId?)` backed by `openCanvas`. The tool result now says where the board opened (`via`), and whether the app timed out.

- [ ] **Step 1: Update the tests first**

In `test/mcp/tools.test.ts`, replace:

```ts
import type { CanvasAccess } from "../../src/mcp/tools.js";
```

with:

```ts
import type { CanvasAccess } from "../../src/mcp/tools.js";
import type { OpenCanvasResult } from "../../src/server/index.js";
```

In `test/mcp/tools.test.ts`, replace:

```ts
/** A canvas that is "not running" unless told otherwise, and records what it was asked to open. */
function fakeCanvas(running?: string) {
  const opened: string[] = [];
  const canvas: CanvasAccess = {
    url: async (_root, boardId) => (running ? (boardId ? `${running}/b/${boardId}` : running) : undefined),
    ensure: async () => running ?? "http://127.0.0.1:4477",
    open: (url) => (opened.push(url), true),
  };
  return { canvas, opened };
}
```

with:

```ts
/** A canvas that is "not running" unless told otherwise, and records what it was asked to show. */
function fakeCanvas(running?: string, via: OpenCanvasResult["via"] = "browser") {
  const opened: string[] = [];
  const withBoard = (base: string, boardId?: string) => (boardId ? `${base}/b/${boardId}` : base);
  const canvas: CanvasAccess = {
    url: async (_root, boardId) => (running ? withBoard(running, boardId) : undefined),
    show: async (_root, boardId) => {
      const url = withBoard(running ?? "http://127.0.0.1:4477", boardId);
      opened.push(url);
      return { url, via };
    },
  };
  return { canvas, opened };
}
```

In `test/mcp/tools.test.ts`, replace:

```ts
    expect(r.structuredContent).toEqual({ url: "http://127.0.0.1:4477/b/checkout", opened: true });
```

with:

```ts
    expect(r.structuredContent).toEqual({ url: "http://127.0.0.1:4477/b/checkout", opened: true, via: "browser" });
```

In `test/mcp/tools.test.ts`, replace:

```ts
    expect(text(missing)).toMatch(/No board "nope"/);
  });

```

with:

```ts
    expect(text(missing)).toMatch(/No board "nope"/);
  });

  it("says where the canvas opened: the app, a browser fallback, or nowhere", async () => {
    const inApp = await connect(fakeCanvas(undefined, "app").canvas);
    const r = await inApp.call("gabiro_open_board");
    expect(r.structuredContent).toEqual({ url: "http://127.0.0.1:4477", opened: true, via: "app" });
    expect(inApp.text(r)).toBe("Opened http://127.0.0.1:4477 in the Gabiro app.");

    const { canvas } = fakeCanvas();
    canvas.show = async () => ({ url: "http://127.0.0.1:4477", via: "browser", appTimedOut: true });
    const fellBack = await connect(canvas);
    const f = await fellBack.call("gabiro_open_board");
    expect(f.structuredContent).toEqual({ url: "http://127.0.0.1:4477", opened: true, via: "browser", appTimedOut: true });
    expect(fellBack.text(f)).toBe("Opened http://127.0.0.1:4477 in the browser. (The Gabiro app didn't show it within 8 seconds.)");

    const quiet = await connect(fakeCanvas(undefined, "none").canvas);
    const q = await quiet.call("gabiro_open_board");
    expect(q.structuredContent).toEqual({ url: "http://127.0.0.1:4477", opened: false, via: "none" });
    expect(quiet.text(q)).toBe("The canvas is running at http://127.0.0.1:4477 — open it in a browser.");
  });

```

- [ ] **Step 2: Run them to verify they fail**

```bash
npx vitest run test/mcp/tools.test.ts
```

Expected: FAIL. The open-board tests fail, since the tool still calls `canvas.ensure`, which the fake no longer has.

- [ ] **Step 3: Implement**

In `src/mcp/tools.ts`, replace:

```ts
import { canvasUrl, ensureCanvasServer, openInBrowser } from "../server/launcher.js";
```

with:

```ts
import { canvasUrl, openCanvas, type OpenCanvasResult } from "../server/launcher.js";
```

In `src/mcp/tools.ts`, replace:

```ts
  /** Base URL of the canvas, starting it if needed. */
  ensure(root: string): Promise<string>;
  /** Tries to open a URL in the user's browser. */
  open(url: string): boolean;
}

export const defaultCanvas: CanvasAccess = {
  url: canvasUrl,
  ensure: (root) => ensureCanvasServer(root),
  open: openInBrowser,
};
```

with:

```ts
  /** Shows the canvas (for a board) in the Gabiro app or the browser, starting a server if needed. */
  show(root: string, boardId?: string): Promise<OpenCanvasResult>;
}

export const defaultCanvas: CanvasAccess = {
  url: canvasUrl,
  show: (root, boardId) => openCanvas(root, boardId),
};

/** What gabiro_open_board tells the agent about where the canvas opened. */
function openedText({ url, via, appTimedOut }: OpenCanvasResult): string {
  const fallback = appTimedOut ? " (The Gabiro app didn't show it within 8 seconds.)" : "";
  if (via === "app") return `Opened ${url} in the Gabiro app.`;
  if (via === "browser") return `Opened ${url} in the browser.${fallback}`;
  return `The canvas is running at ${url} — open it in a browser.${fallback}`;
}
```

In `src/mcp/tools.ts`, replace:

```ts
        "Show a board (or the board list) in the live browser canvas, starting the local canvas server if needed. The canvas updates live as boards change. Starts a local server on 127.0.0.1 if none is running.",
```

with:

```ts
        "Show a board (or the board list) in the live canvas: in the Gabiro Mac app when it is installed, otherwise in the browser. The canvas updates live as boards change. Starts a local server on 127.0.0.1 if none is running.",
```

In `src/mcp/tools.ts`, replace:

```ts
        const base = await canvas.ensure(service.root);
        const url = boardId ? `${base}/b/${boardId}` : base;
        const opened = canvas.open(url);
        const text = opened ? `Opened ${url} in the browser.` : `The canvas is running at ${url} — open it in a browser.`;
        return { text, data: { url, opened } };
```

with:

```ts
        const result = await canvas.show(service.root, boardId);
        return {
          text: openedText(result),
          data: { url: result.url, opened: result.via !== "none", via: result.via, ...(result.appTimedOut ? { appTimedOut: true } : {}) },
        };
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/mcp && npx tsc --noEmit
```

Expected: PASS, and a clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts test/mcp/tools.test.ts
git commit -m "feat(mcp): gabiro_open_board shows the board in the Gabiro app when installed" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

---

### Task 3: Desktop: deep-link parsing

**Files:**
- Create: `desktop/src/deeplink.ts`, `test/desktop/deeplink.test.ts`

Any website can fire `gabiro://` links, so parsing is strict:
- the root must be an absolute path with no `..` segments, and an existing directory;
- the board id must be a slug.

The tests build links with the launcher's `appLink` (Task 1), which proves that what agents send is what the app accepts. This module must not import `electron` or `dist/`.

- [ ] **Step 1: Write the failing test**

Complete file `test/desktop/deeplink.test.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDeepLink } from "../../desktop/src/deeplink.js";
import { appLink } from "../../src/server/index.js";
import { tempRoot } from "../helpers.js";

describe("parseDeepLink", () => {
  it("parses gabiro://start", () => {
    expect(parseDeepLink("gabiro://start")).toEqual({ ok: true, link: { action: "start" } });
  });

  it("parses an open link with and without a board", async () => {
    const root = await tempRoot();
    expect(parseDeepLink(appLink(root))).toEqual({ ok: true, link: { action: "open", root } });
    expect(parseDeepLink(appLink(root, "checkout"))).toEqual({ ok: true, link: { action: "open", root, boardId: "checkout" } });
    expect(parseDeepLink(`gabiro://open?root=${encodeURIComponent(root + "/")}`)).toEqual({ ok: true, link: { action: "open", root } });
  });

  it("round-trips roots with spaces and unicode", async () => {
    const root = join(await tempRoot(), "my project é");
    await mkdir(root);
    expect(parseDeepLink(appLink(root, "a-1"))).toEqual({ ok: true, link: { action: "open", root, boardId: "a-1" } });
  });

  it("rejects relative roots, .. segments and missing directories", async () => {
    const root = await tempRoot();
    expect(parseDeepLink("gabiro://open?root=projects/app")).toMatchObject({ ok: false, reason: /absolute/ });
    expect(parseDeepLink(appLink(`${root}/../${root.split("/").pop()}`))).toMatchObject({ ok: false, reason: /\.\./ });
    expect(parseDeepLink(appLink(join(root, "nope")))).toMatchObject({ ok: false, reason: /existing directory/ });
    expect(parseDeepLink("gabiro://open")).toMatchObject({ ok: false, reason: /missing root/ });
  });

  it("rejects a root that is a file", async () => {
    const file = join(await tempRoot(), "notes.txt");
    await writeFile(file, "hi");
    expect(parseDeepLink(appLink(file))).toMatchObject({ ok: false, reason: /existing directory/ });
  });

  it("rejects bad board ids, unknown actions, paths and other schemes", async () => {
    const root = await tempRoot();
    expect(parseDeepLink(appLink(root, "Bad Id"))).toMatchObject({ ok: false, reason: /slug/ });
    expect(parseDeepLink(appLink(root, "../x"))).toMatchObject({ ok: false, reason: /slug/ });
    expect(parseDeepLink("gabiro://delete?root=/")).toMatchObject({ ok: false, reason: /unknown action/ });
    expect(parseDeepLink("gabiro://start/extra")).toMatchObject({ ok: false, reason: /unexpected path/ });
    expect(parseDeepLink("https://start")).toMatchObject({ ok: false, reason: /scheme/ });
    expect(parseDeepLink("not a url")).toMatchObject({ ok: false, reason: /not a URL/ });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run test/desktop/deeplink.test.ts
```

Expected: FAIL. `desktop/src/deeplink.js` can't be found.

- [ ] **Step 3: Implement**

Complete file `desktop/src/deeplink.ts`:

```ts
import { statSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

/** What a `gabiro://` link asks the app to do. */
export type DeepLink = { action: "start" } | { action: "open"; root: string; boardId?: string };

export type ParsedLink = { ok: true; link: DeepLink } | { ok: false; reason: string };

/** Same rule as the board id slug in src/core/schema.ts. */
const BOARD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Parses `gabiro://start` or `gabiro://open?root=<absolute dir>&board=<id>`. Any website can fire
 * these links, so everything is checked: the root must be absolute, free of `..` segments and an
 * existing directory; the board id must be a slug. `appLink` in src/server/launcher.ts builds them.
 */
export function parseDeepLink(raw: string): ParsedLink {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a URL" };
  }
  if (url.protocol !== "gabiro:") return { ok: false, reason: `unexpected scheme ${url.protocol}` };
  if (url.pathname !== "" && url.pathname !== "/") return { ok: false, reason: `unexpected path ${url.pathname}` };
  if (url.host === "start") return { ok: true, link: { action: "start" } };
  if (url.host !== "open") return { ok: false, reason: `unknown action "${url.host}"` };

  const root = url.searchParams.get("root");
  if (!root) return { ok: false, reason: "missing root" };
  if (!isAbsolute(root)) return { ok: false, reason: "root must be an absolute path" };
  if (root.split(/[\\/]/).includes("..")) return { ok: false, reason: "root must not contain .." };
  const normalized = normalize(root).replace(/(.)[\\/]+$/, "$1");
  if (!isDirectory(normalized)) return { ok: false, reason: "root is not an existing directory" };

  const board = url.searchParams.get("board");
  if (board === null || board === "") return { ok: true, link: { action: "open", root: normalized } };
  if (!BOARD_ID.test(board)) return { ok: false, reason: "board must be a board id slug" };
  return { ok: true, link: { action: "open", root: normalized, boardId: board } };
}

```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/desktop/deeplink.test.ts && npx tsc --noEmit
```

Expected: PASS (6 tests), and a clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/deeplink.ts test/desktop/deeplink.test.ts
git commit -m "feat(desktop): strict gabiro:// deep-link parsing" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

---

### Task 4: Desktop: recent projects

**Files:**
- Create: `desktop/src/recent.ts`, `test/desktop/recent.test.ts`

`RecentProjects` stores `[{ root, openedAt }]` in `<userData>/recent.json`:
- newest first, at most 10 entries, deduplicated by real path;
- writes are atomic (temp file plus rename) and serialized through a promise queue;
- a missing or corrupt file reads as an empty list.

`describeProject` gives the start window a folder's name, its board count, and whether it still exists.

- [ ] **Step 1: Write the failing test**

Complete file `test/desktop/recent.test.ts`:

```ts
import { mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeProject, MAX_RECENT, RecentProjects } from "../../desktop/src/recent.js";
import { tempRoot } from "../helpers.js";

/** Real paths, since the store records real paths (macOS temp dirs sit behind a /var symlink). */
async function setup() {
  const dir = await realpath(await tempRoot());
  const file = join(dir, "userData", "recent.json");
  return { dir, file, recent: new RecentProjects(file) };
}

async function project(dir: string, name: string) {
  const root = join(dir, name);
  await mkdir(root, { recursive: true });
  return root;
}

describe("RecentProjects", () => {
  it("starts empty and lists newest first", async () => {
    const { dir, recent } = await setup();
    expect(await recent.list()).toEqual([]);
    const a = await project(dir, "a");
    const b = await project(dir, "b");
    await recent.add(a, new Date("2026-01-01T00:00:00Z"));
    await recent.add(b, new Date("2026-01-02T00:00:00Z"));
    expect(await recent.list()).toEqual([
      { root: b, openedAt: "2026-01-02T00:00:00.000Z" },
      { root: a, openedAt: "2026-01-01T00:00:00.000Z" },
    ]);
  });

  it("moves a re-opened project to the top without duplicating it, even through a symlink", async () => {
    const { dir, recent } = await setup();
    const a = await project(dir, "a");
    const b = await project(dir, "b");
    await symlink(a, join(dir, "link-to-a"));
    await recent.add(a);
    await recent.add(b);
    await recent.add(join(dir, "link-to-a"));
    expect((await recent.list()).map((p) => p.root)).toEqual([a, b]);
    expect(await recent.has(join(dir, "link-to-a"))).toBe(true);
  });

  it(`keeps at most ${MAX_RECENT} projects`, async () => {
    const { dir, recent } = await setup();
    for (let i = 0; i < MAX_RECENT + 3; i++) await recent.add(await project(dir, `p${i}`));
    const roots = (await recent.list()).map((p) => p.root);
    expect(roots).toHaveLength(MAX_RECENT);
    expect(roots[0]).toBe(join(dir, `p${MAX_RECENT + 2}`));
  });

  it("serializes concurrent adds so none is lost", async () => {
    const { dir, recent } = await setup();
    const roots = await Promise.all(["a", "b", "c", "d"].map((n) => project(dir, n)));
    await Promise.all(roots.map((r) => recent.add(r)));
    expect((await recent.list()).map((p) => p.root).sort()).toEqual(roots.sort());
  });

  it("treats a corrupt or wrongly shaped file as empty and recovers on the next write", async () => {
    const { dir, file, recent } = await setup();
    await mkdir(join(dir, "userData"));
    await writeFile(file, "{ not json");
    expect(await recent.list()).toEqual([]);
    await writeFile(file, JSON.stringify([{ root: 1 }, { root: "/x", openedAt: "t" }]));
    expect(await recent.list()).toEqual([{ root: "/x", openedAt: "t" }]);
    const a = await project(dir, "a");
    await recent.add(a);
    expect((await recent.list()).map((p) => p.root)).toEqual([a, "/x"]);
  });

  it("forgets a project, and writes atomically (no temp files left behind)", async () => {
    const { dir, file, recent } = await setup();
    const a = await project(dir, "a");
    await recent.add(a);
    await recent.forget(a);
    expect(await recent.list()).toEqual([]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([]);
    expect(await readdir(join(dir, "userData"))).toEqual(["recent.json"]);
  });
});

describe("describeProject", () => {
  it("counts boards and flags missing folders", async () => {
    const dir = await realpath(await tempRoot());
    const root = await project(dir, "shop");
    expect(await describeProject(root)).toEqual({ root, name: "shop", boards: 0, missing: false });
    await mkdir(join(root, ".gabiro", "boards"), { recursive: true });
    await writeFile(join(root, ".gabiro", "boards", "a.json"), "{}");
    await writeFile(join(root, ".gabiro", "boards", "b.json"), "{}");
    await writeFile(join(root, ".gabiro", "boards", "notes.txt"), "");
    expect(await describeProject(root)).toMatchObject({ boards: 2, missing: false });
    await rm(root, { recursive: true });
    expect(await describeProject(root)).toEqual({ root, name: "shop", boards: 0, missing: true });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run test/desktop/recent.test.ts
```

Expected: FAIL. `desktop/src/recent.js` can't be found.

- [ ] **Step 3: Implement**

Complete file `desktop/src/recent.ts`:

```ts
import { readdir, readFile, realpath, rename, stat, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface RecentProject {
  root: string;
  /** ISO timestamp of the last time the project was opened. */
  openedAt: string;
}

/** A recent project as the start window shows it. */
export interface RecentProjectView {
  root: string;
  name: string;
  boards: number;
  missing: boolean;
}

export const MAX_RECENT = 10;

const canonical = (root: string) => realpath(root).catch(() => root);

function isEntry(value: unknown): value is RecentProject {
  const v = value as RecentProject;
  return typeof v?.root === "string" && typeof v.openedAt === "string";
}

/**
 * Recently opened projects in `<userData>/recent.json`, newest first, at most 10, deduplicated by
 * real path. A missing or corrupt file reads as an empty list. Writes are atomic and serialized.
 */
export class RecentProjects {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async list(): Promise<RecentProject[]> {
    try {
      const data: unknown = JSON.parse(await readFile(this.file, "utf8"));
      return Array.isArray(data) ? data.filter(isEntry).slice(0, MAX_RECENT) : [];
    } catch {
      return [];
    }
  }

  async has(root: string): Promise<boolean> {
    const real = await canonical(root);
    return (await this.list()).some((p) => p.root === real);
  }

  /** Moves `root` to the top of the list. */
  add(root: string, now = new Date()): Promise<RecentProject[]> {
    return this.update(async (list) => {
      const real = await canonical(root);
      return [{ root: real, openedAt: now.toISOString() }, ...list.filter((p) => p.root !== real)];
    });
  }

  forget(root: string): Promise<RecentProject[]> {
    return this.update(async (list) => list.filter((p) => p.root !== root));
  }

  private update(change: (list: RecentProject[]) => Promise<RecentProject[]>): Promise<RecentProject[]> {
    const next = this.queue.then(async () => {
      const list = (await change(await this.list())).slice(0, MAX_RECENT);
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(list, null, 2) + "\n");
      await rename(tmp, this.file);
      return list;
    });
    this.queue = next.catch(() => {});
    return next;
  }
}

/** Folder name, board count and whether the folder still exists, for the start window. */
export async function describeProject(root: string): Promise<RecentProjectView> {
  const name = basename(root) || root;
  const missing = !(await stat(root).then((s) => s.isDirectory(), () => false));
  if (missing) return { root, name, boards: 0, missing };
  const files = await readdir(join(root, ".gabiro", "boards")).catch(() => [] as string[]);
  return { root, name, boards: files.filter((f) => f.endsWith(".json")).length, missing };
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/desktop/recent.test.ts && npx tsc --noEmit
```

Expected: PASS (7 tests), and a clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/recent.ts test/desktop/recent.test.ts
git commit -m "feat(desktop): recent projects store" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

---

### Task 5: Desktop: agent setup snippets

**Files:**
- Create: `desktop/src/agent-setup.ts`, `test/desktop/agent-setup.test.ts`

These are the texts **Set Up Agent…** shows and copies:
- the `claude mcp add` command, with words quoted only when they need it;
- the `mcpServers` JSON for other clients, with a `--root` placeholder because those clients don't start the server in the project folder.

- [ ] **Step 1: Write the failing test**

Complete file `test/desktop/agent-setup.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { claudeCodeCommand, mcpServersJson, shellQuote } from "../../desktop/src/agent-setup.js";

const BIN = "/Applications/Gabiro.app/Contents/Resources/bin/gabiro";

describe("agent setup snippets", () => {
  it("quotes only the words that need it", () => {
    expect(shellQuote(BIN)).toBe(BIN);
    expect(shellQuote("/Users/me/My Apps/Gabiro.app")).toBe("'/Users/me/My Apps/Gabiro.app'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("builds the Claude Code command", () => {
    expect(claudeCodeCommand([BIN, "mcp"])).toBe(`claude mcp add gabiro -- ${BIN} mcp`);
    expect(claudeCodeCommand(["/Users/me/My Apps/Gabiro.app/Contents/Resources/bin/gabiro", "mcp"])).toBe(
      "claude mcp add gabiro -- '/Users/me/My Apps/Gabiro.app/Contents/Resources/bin/gabiro' mcp",
    );
  });

  it("builds the mcpServers JSON with a --root placeholder", () => {
    expect(JSON.parse(mcpServersJson([BIN, "mcp"]))).toEqual({
      mcpServers: { gabiro: { command: BIN, args: ["mcp", "--root", "/path/to/your/project"] } },
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run test/desktop/agent-setup.test.ts
```

Expected: FAIL. `desktop/src/agent-setup.js` can't be found.

- [ ] **Step 3: Implement**

Complete file `desktop/src/agent-setup.ts`:

```ts
/** Quotes a shell word only when it needs it (POSIX single quotes). */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_\/.:=@%+,-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The command that registers the gabiro MCP server with Claude Code. */
export function claudeCodeCommand(command: string[]): string {
  return ["claude", "mcp", "add", "gabiro", "--", ...command].map(shellQuote).join(" ");
}

/**
 * The `mcpServers` entry for Claude Desktop, Cursor and similar clients. These don't start the
 * server in the project folder, so it passes --root with a placeholder to replace.
 */
export function mcpServersJson(command: string[]): string {
  const [cmd, ...args] = command;
  const config = { mcpServers: { gabiro: { command: cmd, args: [...args, "--root", "/path/to/your/project"] } } };
  return JSON.stringify(config, null, 2);
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/desktop/agent-setup.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add desktop/src/agent-setup.ts test/desktop/agent-setup.test.ts
git commit -m "feat(desktop): agent setup snippets" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

---

### Task 6: Desktop: `ProjectManager`

**Files:**
- Create: `desktop/src/projects.ts`, `test/desktop/projects.test.ts`

One window per project root:
- **Opening:**
  - opening an open project focuses its window, and navigates it when a board is given;
  - two opens of the same root at once share one window;
  - otherwise it reuses a canvas server already healthy for that root, or starts one the app owns.
- **Closing:**
  - a window's `closed` event stops its server only if the app owns it;
  - `closeAll()` (used on quit) stops every owned server exactly once.
- **Failures:**
  - a failed server start opens nothing;
  - a window that can't be created stops the server just started;
  - a failure to save recents is only logged.

Electron and the server are injected, so the tests use fakes.

- [ ] **Step 1: Write the failing test**

Complete file `test/desktop/projects.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ProjectManager, type ProjectDeps, type ProjectWindow } from "../../desktop/src/projects.js";

class FakeWindow implements ProjectWindow {
  loaded: string[] = [];
  focused = 0;
  private closed?: () => void;
  constructor(readonly root: string, url: string) {
    this.loaded.push(url);
  }
  load(url: string) {
    this.loaded.push(url);
  }
  focus() {
    this.focused++;
  }
  onClosed(callback: () => void) {
    this.closed = callback;
  }
  close() {
    this.closed?.();
  }
}

/** Fakes: `healthy` maps roots to foreign servers; started servers get ports from 5000 up. */
function setup(healthy: Record<string, string> = {}) {
  const windows: FakeWindow[] = [];
  const started: string[] = [];
  const stopped: string[] = [];
  const recents: string[] = [];
  let port = 5000;
  const deps: ProjectDeps = {
    findServer: async (root) => healthy[root],
    startServer: async (root) => {
      const url = `http://127.0.0.1:${port++}`;
      started.push(root);
      return { url, close: async () => void stopped.push(root) };
    },
    createWindow: (root, url) => {
      const w = new FakeWindow(root, url);
      windows.push(w);
      return w;
    },
    addRecent: async (root) => void recents.push(root),
  };
  return { manager: new ProjectManager(deps), deps, windows, started, stopped, recents };
}

describe("ProjectManager", () => {
  it("starts and owns a server when none is running, and records the project", async () => {
    const { manager, windows, started, recents } = setup();
    await manager.open("/p/shop", "checkout");
    expect(started).toEqual(["/p/shop"]);
    expect(windows.map((w) => w.loaded)).toEqual([["http://127.0.0.1:5000/b/checkout"]]);
    expect(recents).toEqual(["/p/shop"]);
    expect(manager.roots).toEqual(["/p/shop"]);
    expect(manager.serverUrl("/p/shop")).toBe("http://127.0.0.1:5000");
  });

  it("reuses a healthy server it doesn't own", async () => {
    const { manager, windows, started } = setup({ "/p/shop": "http://127.0.0.1:4477" });
    await manager.open("/p/shop");
    expect(started).toEqual([]);
    expect(windows[0]!.loaded).toEqual(["http://127.0.0.1:4477/"]);
  });

  it("focuses the existing window instead of opening a second one, navigating to a given board", async () => {
    const { manager, windows, started, recents } = setup();
    await manager.open("/p/shop");
    await manager.open("/p/shop");
    await manager.open("/p/shop", "orders");
    expect(windows).toHaveLength(1);
    expect(started).toHaveLength(1);
    expect(windows[0]!.focused).toBe(2);
    expect(windows[0]!.loaded).toEqual(["http://127.0.0.1:5000/", "http://127.0.0.1:5000/b/orders"]);
    expect(recents).toEqual(["/p/shop", "/p/shop", "/p/shop"]);
  });

  it("opens one window when the same project is opened twice at once", async () => {
    const { manager, windows, started } = setup();
    await Promise.all([manager.open("/p/shop"), manager.open("/p/shop", "orders")]);
    expect(windows).toHaveLength(1);
    expect(started).toHaveLength(1);
    expect(windows[0]!.loaded).toEqual(["http://127.0.0.1:5000/", "http://127.0.0.1:5000/b/orders"]);
  });

  it("stops only owned servers when their window closes", async () => {
    const { manager, windows, stopped } = setup({ "/p/foreign": "http://127.0.0.1:4477" });
    await manager.open("/p/own");
    await manager.open("/p/foreign");
    windows[0]!.close();
    windows[1]!.close();
    await manager.closeAll();
    expect(stopped).toEqual(["/p/own"]);
    expect(manager.roots).toEqual([]);
    await manager.open("/p/own");
    expect(windows).toHaveLength(3);
  });

  it("closeAll stops every owned server once, even if windows close afterwards", async () => {
    const { manager, windows, stopped } = setup({ "/p/foreign": "http://127.0.0.1:4477" });
    await manager.open("/p/a");
    await manager.open("/p/b");
    await manager.open("/p/foreign");
    await manager.closeAll();
    windows.forEach((w) => w.close());
    expect(stopped.sort()).toEqual(["/p/a", "/p/b"]);
  });

  it("propagates a failed server start and opens nothing", async () => {
    const { manager, deps, windows } = setup();
    deps.startServer = async () => {
      throw new Error("EACCES: permission denied, mkdir '/p/locked/.gabiro'");
    };
    await expect(manager.open("/p/locked")).rejects.toThrow(/EACCES/);
    expect(windows).toEqual([]);
    expect(manager.roots).toEqual([]);
  });

  it("stops the server it started when the window can't be created", async () => {
    const { manager, deps, stopped } = setup();
    deps.createWindow = () => {
      throw new Error("no display");
    };
    await expect(manager.open("/p/shop")).rejects.toThrow(/no display/);
    expect(stopped).toEqual(["/p/shop"]);
  });

  it("still opens the window when recent projects can't be saved", async () => {
    const logs: string[] = [];
    const { manager, deps, windows } = setup();
    deps.addRecent = async () => {
      throw new Error("disk full");
    };
    deps.log = (m) => logs.push(m);
    await manager.open("/p/shop");
    expect(windows).toHaveLength(1);
    expect(logs).toEqual(["Couldn't update recent projects: Error: disk full"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run test/desktop/projects.test.ts
```

Expected: FAIL. `desktop/src/projects.js` can't be found.

- [ ] **Step 3: Implement**

Complete file `desktop/src/projects.ts`:

```ts
/** A running canvas server as the app sees it. */
export interface ProjectServer {
  url: string;
  /** Present only for servers the app started; closing the window calls it. */
  close?: () => Promise<void>;
}

/** The window showing one project. */
export interface ProjectWindow {
  load(url: string): void;
  focus(): void;
  /** Registers the callback run once the window has closed. */
  onClosed(callback: () => void): void;
}

/** Everything ProjectManager needs from Electron and the canvas server, injected so it can be tested. */
export interface ProjectDeps {
  /** URL of a canvas server already healthy for exactly this root, if any. */
  findServer(root: string): Promise<string | undefined>;
  /** Starts a canvas server for this root in this process. */
  startServer(root: string): Promise<{ url: string; close(): Promise<void> }>;
  /** Creates and shows a window for this root, loading `url`. */
  createWindow(root: string, url: string): ProjectWindow;
  /** Records the root as recently opened. */
  addRecent(root: string): Promise<unknown>;
  log?(message: string): void;
}

interface Project {
  window: ProjectWindow;
  server: ProjectServer;
}

const pageUrl = (base: string, boardId?: string) => (boardId ? `${base}/b/${encodeURIComponent(boardId)}` : `${base}/`);

/**
 * One window per project root. Opening a project that is already open focuses its window;
 * otherwise it reuses a healthy canvas server for that root or starts one the app owns. Closing
 * the window stops the server only if the app started it.
 */
export class ProjectManager {
  private readonly projects = new Map<string, Project>();
  private readonly opening = new Map<string, Promise<void>>();
  private readonly closing = new Set<Promise<void>>();

  constructor(private readonly deps: ProjectDeps) {}

  /** Roots with an open window. */
  get roots(): string[] {
    return [...this.projects.keys()];
  }

  /** The base URL of the server a project window is showing. */
  serverUrl(root: string): string | undefined {
    return this.projects.get(root)?.server.url;
  }

  open(root: string, boardId?: string): Promise<void> {
    const existing = this.projects.get(root);
    if (existing) {
      if (boardId) existing.window.load(pageUrl(existing.server.url, boardId));
      existing.window.focus();
      return this.remember(root);
    }
    const pending = this.opening.get(root);
    if (pending) return pending.then(() => this.open(root, boardId));

    const started = this.create(root, boardId).finally(() => this.opening.delete(root));
    this.opening.set(root, started);
    return started;
  }

  private async create(root: string, boardId?: string): Promise<void> {
    const found = await this.deps.findServer(root);
    const server: ProjectServer = found ? { url: found } : await this.deps.startServer(root);
    let window: ProjectWindow;
    try {
      window = this.deps.createWindow(root, pageUrl(server.url, boardId));
    } catch (err) {
      await server.close?.();
      throw err;
    }
    const project: Project = { window, server };
    this.projects.set(root, project);
    window.onClosed(() => {
      // closeAll() may already have stopped this project's server.
      if (this.projects.get(root) !== project) return;
      this.projects.delete(root);
      this.stop(root, server);
    });
    await this.remember(root);
  }

  /** Stops every server the app owns (for quitting). Windows are left to the caller. */
  async closeAll(): Promise<void> {
    for (const [root, { server }] of this.projects) this.stop(root, server);
    this.projects.clear();
    await Promise.all(this.closing);
  }

  private stop(root: string, server: ProjectServer): void {
    if (!server.close) return;
    const done = server.close().catch((err) => this.deps.log?.(`Couldn't stop the canvas for ${root}: ${String(err)}`));
    this.closing.add(done);
    void done.finally(() => this.closing.delete(done));
  }

  private remember(root: string): Promise<void> {
    return this.deps.addRecent(root).then(
      () => {},
      (err) => this.deps.log?.(`Couldn't update recent projects: ${String(err)}`),
    );
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/desktop && npx tsc --noEmit
```

Expected: PASS (25 tests across the four desktop files), and a clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/projects.ts test/desktop/projects.test.ts
git commit -m "feat(desktop): ProjectManager, one window per project" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

---

### Task 7: Web: "Switch project" link inside the app

**Files:**
- Create: `web/src/SwitchProject.tsx`
- Modify: `web/src/BoardList.tsx`, `web/src/BoardView.tsx`, `web/src/styles.css`

The app adds `Gabiro/<version>` to its windows' user agent. Only then does the header show a link to `gabiro://start`, which the app intercepts to show the start window. Browsers never see it. The Electron smoke test in Task 9 covers it.

- [ ] **Step 1: Add the component**

Complete file `web/src/SwitchProject.tsx`:

```tsx
/** True inside the Gabiro Mac app, whose windows add "Gabiro/<version>" to the user agent. */
export const inGabiroApp = () => navigator.userAgent.includes("Gabiro/");

/** Header link back to the app's start window; the app intercepts gabiro:// navigation. Hidden in browsers. */
export function SwitchProject() {
  if (!inGabiroApp()) return null;
  return (
    <a href="gabiro://start" className="gb-switch">
      Switch project
    </a>
  );
}
```

- [ ] **Step 2: Render it in both headers**

In `web/src/BoardList.tsx`, replace:

```tsx
import { useLiveBoards } from "./hooks.js";
```

with:

```tsx
import { useLiveBoards } from "./hooks.js";
import { SwitchProject } from "./SwitchProject.js";
```

In `web/src/BoardList.tsx`, replace:

```tsx
        <span className="gb-meta">boards in this project</span>
      </header>
```

with:

```tsx
        <span className="gb-meta">boards in this project</span>
        <SwitchProject />
      </header>
```

In `web/src/BoardView.tsx`, replace:

```tsx
import { SidePanel, type Selection } from "./SidePanel.js";
```

with:

```tsx
import { SidePanel, type Selection } from "./SidePanel.js";
import { SwitchProject } from "./SwitchProject.js";
```

In `web/src/BoardView.tsx`, replace:

```tsx
          {live.connected ? "● live" : "○ reconnecting"}
        </span>
      </header>
```

with:

```tsx
          {live.connected ? "● live" : "○ reconnecting"}
        </span>
        <SwitchProject />
      </header>
```

In `web/src/styles.css`, replace:

```css
.gb-status {
  margin-left: auto;
}
```

with:

```css
.gb-status {
  margin-left: auto;
}
.gb-switch {
  font-size: 12px;
}
.gb-meta + .gb-switch {
  margin-left: auto;
}
```

- [ ] **Step 3: Typecheck, build and test**

```bash
npm run typecheck && npm run build && npx vitest run test/web test/e2e
```

Expected: a clean typecheck, a warning-free build, and PASS. In a browser the link isn't rendered, so the existing browser tests are unaffected.

- [ ] **Step 4: Commit**

```bash
git add web/src/SwitchProject.tsx web/src/BoardList.tsx web/src/BoardView.tsx web/src/styles.css
git commit -m "feat(web): Switch project link inside the Gabiro app" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

---

### Task 8: Electron main process and start window

**Files:**
- Create:
  - `desktop/tsconfig.json`, `desktop/src/main.ts`, `desktop/preload.cjs`;
  - `desktop/start.html`, `desktop/start.css`, `desktop/start.js`.
- Modify: `package.json`, `package-lock.json`, `tsconfig.build.json`, `.gitignore`

**How the main process is wired:**
- **Imports.** `main.ts` imports the built server from `../../dist/server/index.js`. That path is right from both `desktop/src` and `desktop/dist`. `tsconfig.build.json` now emits `.d.ts` files, so those imports are typed.
- **ESM.** `main.ts` is an ES module, which Electron 44 supports for the main process. The preload is CommonJS, because sandboxed preloads must be.

**Behaviour** (spec §2–§3):
- **Single instance.** `open-url` is registered before `ready`, and links that arrive early are queued. Other platforms pass links through `second-instance` or `argv`.
- **Confirmation.** A native dialog asks before opening a folder that isn't a recent or open project.
- **Navigation guard.**
  - Project windows stay on their server's origin; `gabiro:` links go to the link handler and `http(s)` to the default browser.
  - The start window can't navigate at all.
  - Webviews are refused everywhere.
- **Start window IPC.** Handlers answer only the start window's `webContents` and validate roots.
- **Menus.** The app menu (Set Up Agent… on macOS), File (Open Folder…, Open Recent, Show Start Window), Edit, View and Window. The Dock menu lists recent projects and Open Folder….
- **Quit.** `will-quit` waits for `closeAll()` so owned servers stop, which removes their `server.json`.
- **Tests.** `GABIRO_USER_DATA` overrides `userData`, for tests only.

- [ ] **Step 1: Add Electron and electron-builder**

```bash
npm install -D electron@^44.4.5 electron-builder@^26.15.3
```

This downloads the Electron binary for your platform, about 100 MB.

- [ ] **Step 2: Package metadata, scripts and build config**

Complete file `package.json`:

```json
{
  "name": "gabiro",
  "productName": "Gabiro",
  "version": "0.1.0",
  "description": "Agent-first diagram canvas: MCP tools for architecture, flow, sequence, ERD, mind map, freeform and kanban boards",
  "type": "module",
  "main": "desktop/dist/main.js",
  "license": "MIT",
  "bin": {
    "gabiro": "dist/cli.js"
  },
  "files": [
    "dist"
  ],
  "engines": {
    "node": ">=20.19"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json && vite build",
    "typecheck": "tsc --noEmit && tsc --noEmit -p web",
    "test": "vitest run",
    "dev:web": "vite",
    "desktop:build": "tsc -p desktop",
    "desktop:start": "npm run build && npm run desktop:build && electron .",
    "app:mac": "npm run build && npm run desktop:build && electron-builder --mac --universal --publish never"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.1",
    "elkjs": "^0.12.0",
    "ws": "^8.21.3",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@types/node": "^22.20.4",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@types/ws": "^8.18.1",
    "@vitejs/plugin-react": "^6.1.1",
    "@xyflow/react": "^12.12.0",
    "electron": "^44.4.5",
    "electron-builder": "^26.15.3",
    "playwright-core": "^1.63.0",
    "react": "^19.3.0",
    "react-dom": "^19.3.0",
    "typescript": "~5.9.3",
    "vite": "^8.3.1",
    "vitest": "^5.0.2"
  }
}
```

Complete file `tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "rootDir": "src", "declaration": true },
  "include": ["src"]
}
```

Complete file `desktop/tsconfig.json`:

```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

Complete file `.gitignore`:

```gitignore
node_modules/
dist/
*.tmp
desktop/dist/
release/
```

- [ ] **Step 3: Main process and preload**

Complete file `desktop/src/main.ts`:

```ts
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { isHealthy, readServerInfo, startCanvasServer } from "../../dist/server/index.js";
import { claudeCodeCommand, mcpServersJson } from "./agent-setup.js";
import { parseDeepLink } from "./deeplink.js";
import { ProjectManager, type ProjectWindow } from "./projects.js";
import { describeProject, RecentProjects } from "./recent.js";

const isMac = process.platform === "darwin";

// Tests point userData at a temp dir; this must happen before the single-instance lock.
if (process.env.GABIRO_USER_DATA) app.setPath("userData", process.env.GABIRO_USER_DATA);

const appRoot = app.getAppPath();
const desktopDir = join(appRoot, "desktop");
const recent = new RecentProjects(join(app.getPath("userData"), "recent.json"));
let startWindow: BrowserWindow | undefined;

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const projects = new ProjectManager({
  findServer: async (root) => {
    const info = await readServerInfo(root);
    return info && (await isHealthy(info.url, root)) ? info.url : undefined;
  },
  startServer: (root) => startCanvasServer({ root, port: 0 }),
  createWindow: createProjectWindow,
  addRecent: (root) => recent.add(root).then(rebuildMenus),
  log: (message) => console.error(`gabiro: ${message}`),
});

/** Links the page asks for: gabiro:// goes to the link handler, http(s) to the default browser, the rest nowhere. */
function openOutside(url: string): void {
  if (url.startsWith("gabiro:")) handleLink(url);
  else if (/^https?:/i.test(url)) void shell.openExternal(url);
}

/** Keeps a window on `origin` (or on its local file when undefined); anything else opens outside the app. */
function guardNavigation(contents: WebContents, origin?: string): void {
  contents.on("will-navigate", (event, url) => {
    if (origin !== undefined && new URL(url).origin === origin) return;
    event.preventDefault();
    openOutside(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: "deny" };
  });
}

function createProjectWindow(root: string, url: string): ProjectWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    title: `${basename(root)} — Gabiro`,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setUserAgent(`${win.webContents.getUserAgent()} Gabiro/${app.getVersion()}`);
  guardNavigation(win.webContents, new URL(url).origin);
  win.on("page-title-updated", (event) => event.preventDefault());
  const load = (next: string) => void win.loadURL(next).catch((err) => console.error(`gabiro: couldn't load ${next}: ${String(err)}`));
  load(url);
  return {
    load,
    focus: () => {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    },
    onClosed: (callback) => win.on("closed", callback),
  };
}

function showStart(): void {
  if (startWindow) {
    startWindow.show();
    startWindow.focus();
    return;
  }
  startWindow = new BrowserWindow({
    width: 560,
    height: 540,
    title: "Gabiro",
    webPreferences: { preload: join(desktopDir, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  guardNavigation(startWindow.webContents);
  startWindow.on("closed", () => (startWindow = undefined));
  void startWindow.loadFile(join(desktopDir, "start.html"));
}

async function openProject(root: string, boardId?: string): Promise<boolean> {
  try {
    await projects.open(root, boardId);
    startWindow?.close();
    return true;
  } catch (err) {
    dialog.showErrorBox(`Couldn't open ${basename(root)}`, `${root}\n\n${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function openRecent(root: string): Promise<void> {
  if (isDirectory(root)) {
    await openProject(realpathSync(root));
    return;
  }
  const { response } = await dialog.showMessageBox({
    type: "warning",
    message: "This folder no longer exists",
    detail: root,
    buttons: ["Remove", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) await recent.forget(root).then(rebuildMenus);
}

async function openFolder(): Promise<void> {
  const parent = BrowserWindow.getFocusedWindow();
  const options = { properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[], buttonLabel: "Open" };
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  const folder = result.filePaths[0];
  if (!result.canceled && folder) await openProject(realpathSync(folder));
}

/** The command that runs the MCP server: the script inside the app bundle, or the repo's CLI in development. */
function agentCommand(): string[] {
  return app.isPackaged ? [join(process.resourcesPath, "bin", "gabiro"), "mcp"] : ["node", join(appRoot, "dist", "cli.js"), "mcp"];
}

async function showAgentSetup(): Promise<void> {
  const command = agentCommand();
  const claude = claudeCodeCommand(command);
  const json = mcpServersJson(command);
  const { response } = await dialog.showMessageBox({
    type: "info",
    title: "Set Up Agent",
    message: "Connect an AI agent to Gabiro",
    detail:
      `Claude Code — run this in your project folder:\n\n${claude}\n\n` +
      `Claude Desktop, Cursor and other MCP clients — add this to their MCP config and set --root to your project:\n\n${json}`,
    buttons: ["Copy Claude Code Command", "Copy JSON Config", "Close"],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 0) clipboard.writeText(claude);
  if (response === 1) clipboard.writeText(json);
}

async function rebuildMenus(): Promise<void> {
  const recentItems: MenuItemConstructorOptions[] = (await recent.list()).map((p) => ({
    label: basename(p.root) || p.root,
    sublabel: p.root,
    click: () => void openRecent(p.root),
  }));
  const openFolderItem: MenuItemConstructorOptions = { label: "Open Folder…", accelerator: "CmdOrCtrl+O", click: () => void openFolder() };
  const setupItem: MenuItemConstructorOptions = { label: "Set Up Agent…", click: () => void showAgentSetup() };
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              setupItem,
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: [
        openFolderItem,
        { label: "Open Recent", submenu: recentItems.length ? recentItems : [{ label: "No Recent Projects", enabled: false }] },
        { label: "Show Start Window", accelerator: "CmdOrCtrl+Shift+O", click: showStart },
        ...(isMac ? [] : [setupItem]),
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  if (isMac) {
    const dock: MenuItemConstructorOptions[] = [...recentItems, ...(recentItems.length ? [{ type: "separator" as const }] : []), openFolderItem];
    app.dock?.setMenu(Menu.buildFromTemplate(dock));
  }
}

/** Follows a gabiro:// link. Invalid links are only logged: any website can fire them. */
async function followLink(raw: string): Promise<void> {
  const parsed = parseDeepLink(raw);
  if (!parsed.ok) {
    console.error(`gabiro: ignored link ${raw}: ${parsed.reason}`);
    return;
  }
  const { link } = parsed;
  if (link.action === "start") {
    showStart();
    return;
  }
  let root: string;
  try {
    root = realpathSync(link.root);
  } catch {
    console.error(`gabiro: ignored link ${raw}: the folder is gone`);
    return;
  }
  if (!projects.roots.includes(root) && !(await recent.has(root))) {
    const { response } = await dialog.showMessageBox({
      type: "question",
      message: `Open the project at ${root} in Gabiro?`,
      detail: "A link asked Gabiro to open this folder.",
      buttons: ["Open", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return;
  }
  await openProject(root, link.boardId);
}

let ready = false;
const pendingLinks: string[] = [];

function handleLink(raw: string): void {
  if (ready) void followLink(raw);
  else pendingLinks.push(raw);
}

const isValidRoot = (root: unknown): root is string => typeof root === "string" && isAbsolute(root);

/** Start-window IPC: only that window may call, and every root is checked. */
function handleStartIpc(channel: string, handler: (...args: unknown[]) => Promise<unknown>): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!startWindow || event.sender !== startWindow.webContents) throw new Error("Not allowed");
    return handler(...args);
  });
}

// macOS delivers links through open-url, possibly before the app is ready.
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleLink(url);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Other platforms start a second instance with the link in argv; it hands over and quits.
  app.on("second-instance", (_event, argv) => {
    const link = argv.find((a) => a.startsWith("gabiro://"));
    if (link) handleLink(link);
    else showStart();
  });

  handleStartIpc("gabiro:list", async () => Promise.all((await recent.list()).map((p) => describeProject(p.root))));
  handleStartIpc("gabiro:open", async (root) => {
    if (!isValidRoot(root) || !isDirectory(root)) return { ok: false, missing: true };
    return { ok: await openProject(realpathSync(root)) };
  });
  handleStartIpc("gabiro:open-folder", () => openFolder());
  handleStartIpc("gabiro:forget", async (root) => {
    if (!isValidRoot(root)) return;
    await recent.forget(root);
    await rebuildMenus();
  });

  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });

  app.on("window-all-closed", () => {
    if (!isMac) app.quit();
  });

  app.on("activate", () => {
    if (ready && BrowserWindow.getAllWindows().length === 0) showStart();
  });

  // Stop the canvas servers the app started before exiting.
  let stopped = false;
  app.on("will-quit", (event) => {
    if (stopped) return;
    event.preventDefault();
    void projects.closeAll().finally(() => {
      stopped = true;
      app.quit();
    });
  });

  void app.whenReady().then(async () => {
    if (app.isPackaged) app.setAsDefaultProtocolClient("gabiro");
    await rebuildMenus();
    ready = true;
    const links = [...pendingLinks.splice(0), ...process.argv.filter((a) => a.startsWith("gabiro://"))];
    for (const link of links) await followLink(link);
    if (BrowserWindow.getAllWindows().length === 0) showStart();
  });
}
```

Complete file `desktop/preload.cjs`:

```js
// The start window's only bridge to the main process. Sandboxed preloads must be CommonJS.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gabiro", {
  list: () => ipcRenderer.invoke("gabiro:list"),
  open: (root) => ipcRenderer.invoke("gabiro:open", root),
  openFolder: () => ipcRenderer.invoke("gabiro:open-folder"),
  forget: (root) => ipcRenderer.invoke("gabiro:forget", root),
});
```

- [ ] **Step 4: Start window**

Complete file `desktop/start.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src data:" />
    <title>Gabiro</title>
    <link rel="icon" href="data:," />
    <link rel="stylesheet" href="start.css" />
  </head>
  <body>
    <header>
      <h1>Gabiro</h1>
      <p>Open a project folder to see its boards. Boards live in the folder’s <code>.gabiro/</code> directory.</p>
    </header>
    <button id="open-folder" class="primary">Open Folder…</button>
    <h2>Recent projects</h2>
    <p id="empty" hidden>No recent projects yet.</p>
    <ul id="recent"></ul>
    <script src="start.js"></script>
  </body>
</html>
```

Complete file `desktop/start.css`:

```css
:root {
  color-scheme: light dark;
  --text: #1f2328;
  --muted: #656d76;
  --surface: #ffffff;
  --hover: #f3f4f6;
  --stroke: #d0d7de;
  --accent: #2f6feb;
  --warn: #b35900;
}
@media (prefers-color-scheme: dark) {
  :root {
    --text: #e6edf3;
    --muted: #8d96a0;
    --surface: #161b22;
    --hover: #21262d;
    --stroke: #30363d;
    --accent: #4c8dff;
    --warn: #e3a04f;
  }
}
body {
  margin: 0;
  padding: 24px 28px;
  font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--text);
  background: var(--surface);
}
h1 {
  font-size: 22px;
  margin: 0 0 4px;
}
h2 {
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  margin: 24px 0 8px;
}
header p,
#empty {
  color: var(--muted);
  margin: 0 0 16px;
}
button {
  font: inherit;
  border: 1px solid var(--stroke);
  border-radius: 6px;
  padding: 6px 12px;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
}
button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
li {
  display: flex;
  align-items: center;
  gap: 8px;
  border-radius: 6px;
}
li:hover {
  background: var(--hover);
}
.project {
  flex: 1;
  min-width: 0;
  text-align: left;
  border: none;
  background: none;
  padding: 8px 10px;
}
.name {
  font-weight: 600;
}
.path,
.boards {
  display: block;
  color: var(--muted);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.missing {
  color: var(--warn);
  font-size: 12px;
  margin-left: 6px;
}
.note {
  color: var(--warn);
  font-size: 12px;
}
.remove {
  margin-right: 8px;
  font-size: 12px;
  padding: 3px 8px;
}
```

Complete file `desktop/start.js`:

```js
// Start window: recent projects and Open Folder…. Talks to the main process only through window.gabiro (preload.cjs).
const list = document.getElementById("recent");
const empty = document.getElementById("empty");

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function row(project) {
  const item = el("li");
  const open = el("button", "project");
  open.append(el("span", "name", project.name));
  if (project.missing) open.append(el("span", "missing", "missing"));
  open.append(el("span", "path", project.root));
  if (!project.missing) open.append(el("span", "boards", project.boards === 1 ? "1 board" : `${project.boards} boards`));
  const remove = el("button", "remove", "Remove");
  remove.hidden = !project.missing;
  remove.addEventListener("click", async () => {
    await window.gabiro.forget(project.root);
    await refresh();
  });
  open.addEventListener("click", async () => {
    const result = project.missing ? { ok: false, missing: true } : await window.gabiro.open(project.root);
    if (result.missing && !item.querySelector(".note")) {
      open.append(el("span", "note", "This folder no longer exists."));
      remove.hidden = false;
    }
  });
  item.append(open, remove);
  return item;
}

async function refresh() {
  const projects = await window.gabiro.list();
  list.replaceChildren(...projects.map(row));
  empty.hidden = projects.length > 0;
}

document.getElementById("open-folder").addEventListener("click", () => window.gabiro.openFolder());
window.addEventListener("focus", refresh);
refresh();
```

- [ ] **Step 5: Build**

```bash
npm run build && npm run desktop:build && ls desktop/dist
```

Expected: both builds succeed, and `desktop/dist` holds `agent-setup.js deeplink.js main.js projects.js recent.js`. If `desktop:build` reports "Could not find a declaration file for module '../../dist/server/index.js'", `npm run build` didn't emit declarations; check `tsconfig.build.json`.

- [ ] **Step 6: Run the app once (optional; needs a display)**

```bash
npx electron .            # macOS / Windows / Linux desktop
xvfb-run -a npx electron --no-sandbox .   # headless Linux: starts, then Ctrl+C
```

Expected: the start window says "No recent projects yet." and **Open Folder…** opens a folder into a canvas window titled `<folder> — Gabiro`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.build.json .gitignore desktop/tsconfig.json desktop/src/main.ts desktop/preload.cjs desktop/start.html desktop/start.css desktop/start.js
git commit -m "feat(desktop): Electron main process, start window, menus and deep links" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

---

### Task 9: Electron smoke test

**Files:**
- Create: `test/desktop/app.smoke.test.ts`

Playwright's `_electron` drives the real app from the repo, with a temp `userData`. It checks:
- the start window lists a recent project with its board count;
- opening it shows the live canvas, served by the server recorded in `server.json`;
- "Switch project" brings the start window back.

It also answers the native confirmation dialog from the main process, by stubbing `dialog.showMessageBox`:
- a link to an unknown folder asks first, and Cancel opens nothing;
- Open shows the board;
- the now-recent project opens without asking.

It is skipped until `npm run build && npm run desktop:build` have run, and when there is no display.

- [ ] **Step 1: Write the test**

Complete file `test/desktop/app.smoke.test.ts`:

```ts
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { appLink } from "../../src/server/index.js";
import { tempRoot } from "../helpers.js";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const electronPath = createRequire(import.meta.url)("electron") as unknown as string;
const built = existsSync(join(repo, "desktop/dist/main.js")) && existsSync(join(repo, "dist/web/index.html"));
const hasDisplay = process.platform === "darwin" || process.platform === "win32" || !!process.env.DISPLAY;

let app: ElectronApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function launch(userData: string, extraArgs: string[] = []) {
  app = await _electron.launch({
    executablePath: electronPath,
    // Chromium's Linux sandbox can't start as root or under Ubuntu's AppArmor rules on CI runners.
    args: [...(process.platform === "linux" ? ["--no-sandbox"] : []), repo, ...extraArgs],
    env: { ...process.env, GABIRO_USER_DATA: userData, GABIRO_NO_BROWSER: "1" },
  });
  return app;
}

/** The window whose URL matches, once it exists. */
async function windowMatching(electron: ElectronApplication, pattern: RegExp): Promise<Page> {
  await expect.poll(() => electron.windows().some((w) => pattern.test(w.url())), { timeout: 10_000 }).toBe(true);
  return electron.windows().find((w) => pattern.test(w.url()))!;
}

async function project(dir: string, name: string) {
  const root = join(dir, name);
  await mkdir(join(root, ".gabiro", "boards"), { recursive: true });
  return root;
}

describe.skipIf(!built || !hasDisplay)("Gabiro desktop app (run `npm run build && npm run desktop:build` first)", { timeout: 60_000 }, () => {
  it("lists recent projects in the start window and opens one into its live canvas", async () => {
    const dir = await realpath(await tempRoot());
    const root = await project(dir, "shop");
    const userData = join(dir, "userData");
    await mkdir(userData);
    await writeFile(join(userData, "recent.json"), JSON.stringify([{ root, openedAt: "2026-01-01T00:00:00.000Z" }]));

    const electron = await launch(userData);
    const start = await windowMatching(electron, /start\.html$/);
    await expect.poll(() => start.locator(".name").allTextContents()).toEqual(["shop"]);
    await expect.poll(() => start.locator(".boards").allTextContents()).toEqual(["0 boards"]);

    await start.locator(".project").click();
    const canvas = await windowMatching(electron, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    await expect.poll(() => canvas.locator(".gb-header h1").textContent()).toBe("gabiro");
    // Inside the app the header offers a way back to the start window.
    await expect.poll(() => canvas.locator(".gb-switch").count()).toBe(1);

    // The app records its server so agents reuse it.
    const info = JSON.parse(await readFile(join(root, ".gabiro", "server.json"), "utf8"));
    expect(canvas.url()).toBe(`${info.url}/`);
    expect(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()))).toEqual(["shop — Gabiro"]);

    // "Switch project" brings the start window back; the canvas window stays on its page. (A DOM click:
    // Playwright's click() would wait for the gabiro:// navigation the app cancels.)
    await canvas.evaluate(() => document.querySelector<HTMLElement>(".gb-switch")!.click());
    await windowMatching(electron, /start\.html$/);
    expect(canvas.url()).toBe(`${info.url}/`);
  });

  it("asks before opening a folder from a link, and opens the board once confirmed", async () => {
    const dir = await realpath(await tempRoot());
    const root = await project(dir, "stranger");
    const userData = join(dir, "userData");
    const electron = await launch(userData);
    await windowMatching(electron, /start\.html$/);

    // Answer the native confirmation from the test: first Cancel, then Open.
    const ask = (answer: number, link: string) =>
      electron.evaluate(
        async ({ app, dialog }, [answer, link]) => {
          const asked: string[] = [];
          dialog.showMessageBox = (async (...args: unknown[]) => {
            const options = args[args.length - 1] as { message: string };
            asked.push(options.message);
            return { response: answer, checkboxChecked: false };
          }) as typeof dialog.showMessageBox;
          app.emit("open-url", { preventDefault() {} }, link);
          await new Promise((r) => setTimeout(r, 500));
          return asked;
        },
        [answer, link] as const,
      );

    expect(await ask(1, appLink(root, "orders"))).toEqual([`Open the project at ${root} in Gabiro?`]);
    expect(electron.windows().some((w) => w.url().startsWith("http"))).toBe(false);

    expect(await ask(0, appLink(root, "orders"))).toEqual([`Open the project at ${root} in Gabiro?`]);
    await windowMatching(electron, /^http:\/\/127\.0\.0\.1:\d+\/b\/orders$/);

    // Now it is a recent project, so a second link opens without asking.
    expect(await ask(1, appLink(root))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it**

```bash
npm run build && npm run desktop:build
xvfb-run -a npx vitest run test/desktop/app.smoke.test.ts   # on macOS: npx vitest run test/desktop/app.smoke.test.ts
```

Expected: PASS (2 tests). Run it 3 times; it must pass every time. Without `xvfb-run` on headless Linux, the suite is reported as skipped.

- [ ] **Step 3: Full suite**

```bash
npm run typecheck && xvfb-run -a npm test
```

Expected: a clean typecheck, and 29 test files with 229 tests passing.

- [ ] **Step 4: Commit**

```bash
git add test/desktop/app.smoke.test.ts
git commit -m "test(desktop): Electron smoke test for the start window, canvas and deep links" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

---

### Task 10: Packaging: bundled CLI and electron-builder config

**Files:**
- Create: `desktop/bin/gabiro` (executable), `electron-builder.yml`

`Contents/Resources/bin/gabiro` runs `dist/cli.js` from inside `app.asar` with the app's own binary as Node (`ELECTRON_RUN_AS_NODE=1`). A detached `gabiro serve` spawned by the MCP server inherits that variable, so it runs on the same binary. Keep Electron's `RunAsNode` fuse enabled, which is the default; the bundled CLI depends on it.

- [ ] **Step 1: Add the launcher script and make it executable**

Complete file `desktop/bin/gabiro`:

```sh
#!/bin/sh
# The gabiro CLI inside Gabiro.app (Contents/Resources/bin/gabiro), run on the app's own Node.
# Usage is the same as the npm package, e.g.: claude mcp add gabiro -- "<this path>" mcp
set -e
here=$(cd "$(dirname "$0")" && pwd -P)
contents=$(dirname "$(dirname "$here")")
ELECTRON_RUN_AS_NODE=1 exec "$contents/MacOS/Gabiro" "$contents/Resources/app.asar/dist/cli.js" "$@"
```

```bash
chmod +x desktop/bin/gabiro
```

- [ ] **Step 2: Add the builder config**

Complete file `electron-builder.yml`:

```yaml
# Packages Gabiro.app: `npm run app:mac` (macOS only). Ad-hoc signed, not notarized; see README → Mac app.
appId: dev.gabiro.app
productName: Gabiro
directories:
  output: release
files:
  - package.json
  - dist/**
  - desktop/dist/**
  - desktop/start.html
  - desktop/start.css
  - desktop/start.js
  - desktop/preload.cjs
extraResources:
  - from: desktop/bin/gabiro
    to: bin/gabiro
protocols:
  - name: Gabiro
    schemes: [gabiro]
mac:
  category: public.app-category.developer-tools
  # Ad-hoc signature: without one, Apple Silicon reports a downloaded app as "damaged".
  identity: "-"
  hardenedRuntime: false
  artifactName: ${productName}-${version}-${arch}.${ext}
  target:
    - target: dmg
      arch: universal
    - target: zip
      arch: universal
publish: null
```

- [ ] **Step 3: Check the bundle layout on your platform**

`--dir` packages without an installer. On macOS it produces `release/mac-universal/Gabiro.app`, or `release/mac*/Gabiro.app`; on Linux it produces `release/linux-unpacked`.

```bash
npm run build && npm run desktop:build && npx electron-builder --dir --publish never
# macOS:
release/mac*/Gabiro.app/Contents/Resources/bin/gabiro --version
# Linux (the same CLI, run the way bin/gabiro runs it):
ELECTRON_RUN_AS_NODE=1 release/linux-unpacked/gabiro release/linux-unpacked/resources/app.asar/dist/cli.js --version
ls -l release/linux-unpacked/resources/bin/gabiro
```

Expected: `0.1.0` is printed. On Linux, `resources/bin/gabiro` is listed as executable (`-rwxr-xr-x`). Then clean up: `rm -rf release`.

- [ ] **Step 4: Commit**

```bash
git add desktop/bin/gabiro electron-builder.yml
git commit -m "build(desktop): package Gabiro.app with the bundled gabiro CLI" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

---

### Task 11: CI and release workflows

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`

**`ci.yml`**
- **Ubuntu job:** runs the whole suite with Chromium installed for the browser tests, under `xvfb-run` for the Electron smoke test.
- **macOS job:** packages the universal app and uploads the `.dmg`.

**`release.yml`**, on `v*` tags:
- checks the tag against `package.json`'s version;
- packages the app;
- creates the GitHub Release if needed and attaches the `.dmg` and `.zip`.

- [ ] **Step 1: Add the workflows**

Complete file `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - name: Install Chromium for the browser tests
        run: npx playwright-core install --with-deps chromium
      - run: npm run build
      - run: npm run desktop:build
      - run: npm run typecheck
      - name: Test (the Electron smoke test needs a display)
        run: xvfb-run -a npm test

  mac-app:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run app:mac
      - uses: actions/upload-artifact@v4
        with:
          name: Gabiro-mac
          path: release/*.dmg
          if-no-files-found: error
```

Complete file `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags: ["v*"]

permissions:
  contents: write

jobs:
  mac-app:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - name: Check the tag matches package.json
        run: |
          version="v$(node -p 'require("./package.json").version')"
          if [ "$version" != "$GITHUB_REF_NAME" ]; then
            echo "Tag $GITHUB_REF_NAME doesn't match package.json version $version" >&2
            exit 1
          fi
      - run: npm ci
      - run: npm run app:mac
      - name: Attach the app to the GitHub Release
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh release view "$GITHUB_REF_NAME" >/dev/null 2>&1 || gh release create "$GITHUB_REF_NAME" --title "Gabiro $GITHUB_REF_NAME" --generate-notes
          gh release upload "$GITHUB_REF_NAME" release/*.dmg release/*.zip --clobber
```

- [ ] **Step 2: Check the YAML parses**

```bash
python3 -c "import yaml; [yaml.safe_load(open(f)) for f in ['.github/workflows/ci.yml', '.github/workflows/release.yml', 'electron-builder.yml']]; print('ok')"
```

Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "ci: test on Ubuntu, package the Mac app on macOS, publish on v* tags" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

---

### Task 12: README

**Files:**
- Modify: `README.md`

Add a "Mac app" section covering install, the first launch past Gatekeeper, connecting an agent, projects and links, and `GABIRO_NO_APP`. Add the app's development commands and the manual pre-release checklist for macOS-only behaviour, and update the `gabiro_open_board` row.

- [ ] **Step 1: Update the README**

Complete file `README.md`:

````markdown
# gabiro

A free, self-hosted, agent-first diagram tool. AI agents (Claude Code, Claude Desktop, Cursor, …) call gabiro's MCP tools to draw your system as **architecture, flowchart, sequence, ERD, mind map, freeform and kanban** boards. Boards are JSON files in your repo (`.gabiro/boards/`), and every change is auto-exported to Mermaid Markdown (`docs/diagrams/`) so it renders on GitHub and lives in git next to the code.

A local browser canvas shows every board live while the agent works on it.

## Install (from source)

```bash
git clone <this repo> gabiro && cd gabiro
npm install
npm run build
```

Register it with Claude Code **from inside the project you want to diagram**:

```bash
claude mcp add gabiro -- node /absolute/path/to/gabiro/dist/cli.js mcp
```

The server uses the directory it is started in as the project root. Pass `--root <dir>` to override.

## Mac app

Gabiro.app runs the canvas without a terminal: launch it from the Dock, pick a project folder, and each project opens in its own window. When an agent calls `gabiro_open_board`, the app comes forward with that board (without the app, the board opens in your browser).

**Install:** download `Gabiro-<version>-universal.dmg` from the [Releases](../../releases) page and drag Gabiro into Applications. The app is ad-hoc signed but not notarized, so the first launch is blocked: open it once, then go to **System Settings → Privacy & Security** and click **Open Anyway** (or run `xattr -dr com.apple.quarantine /Applications/Gabiro.app`).

**Connect an agent:** choose **Gabiro → Set Up Agent…** and copy the command. The app bundles the MCP server, so you don't need Node or this repo:

```bash
claude mcp add gabiro -- /Applications/Gabiro.app/Contents/Resources/bin/gabiro mcp
```

**Projects:** the start window lists recent projects (also in the Dock menu and **File → Open Recent**); **Open Folder…** opens any folder. **Switch project** in a canvas header brings the start window back. If a canvas server is already running for a project (`gabiro serve`), the app uses it; otherwise it starts one, and stops it when you close the window. Links like `gabiro://open?root=/path/to/project&board=checkout` open a board; the app asks before opening a folder that isn't in your recent projects.

Set `GABIRO_NO_APP=1` to make `gabiro_open_board` use the browser even when the app is installed.

## Use

Ask your agent things like:

- "Map this repo's architecture as a gabiro board."
- "Draw the sequence of our login flow, from the browser through the auth service to the DB."
- "Make an ERD of the Prisma schema."
- "Add a Redis cache between the API and Postgres, and a sticky note about invalidation."

To watch the diagram, ask "open it in gabiro" (the agent calls `gabiro_open_board`), or run the canvas yourself:

```bash
node /absolute/path/to/gabiro/dist/cli.js serve --open   # http://127.0.0.1:4477, next free port if taken
```

A canvas started by `gabiro_open_board` stops after 30 minutes with no canvas tab open; `gabiro serve` runs until you stop it (or pass `--idle-exit <minutes>`). The server only answers on 127.0.0.1/localhost.

The canvas updates live as the agent changes a board, and highlights what just changed. The same diagrams are in `docs/diagrams/<board>.md`, which renders on GitHub and in VS Code's Markdown preview.

## Edit in the canvas

You and the agent edit the same board, and both see each other's changes live.

- **Move**: drag a node. It stays where you drop it (it's pinned), even when the agent re-runs the layout. Drag kanban cards between columns, and sequence participants to reorder them.
- **Add**: pick a type from the toolbar. The palette only offers types the board kind allows.
- **Rename and details**: double-click a node, or select it, then edit the label, type, group, tech, description, tags and ERD fields in the side panel. Fields save when they lose focus or you press Enter.
- **Connect**: drag from a node's handle (shown on hover) onto another node.
- **Delete**: select, then press Delete or Backspace.
- **Undo / redo**: ⌘Z / ⇧⌘Z (Ctrl+Z / Ctrl+Shift+Z elsewhere). This undoes only your own edits.
- **Auto-layout**: tidy everything except the nodes you pinned. Auto-layout is not undoable.

If the agent changes the board while you're editing, your edit is re-applied on top of its change. If that isn't possible (for example, the agent deleted the node you were editing), you get a message explaining why.

## Tools

| Tool | What it does |
|---|---|
| `gabiro_list_boards` | List boards |
| `gabiro_create_board` | Create a board, optionally with all of its content in one call |
| `gabiro_get_board` | Read a board as `summary`, `json` or `mermaid` |
| `gabiro_apply_changes` | Atomic batch of add/update/remove ops for nodes, edges and groups |
| `gabiro_update_board` | Rename a board or change its direction |
| `gabiro_auto_layout` | Re-run layout (pinned nodes stay unless `force`) |
| `gabiro_export` | Mermaid or Markdown, optionally written to disk |
| `gabiro_open_board` | Show a board in the live canvas (the Mac app if installed, else the browser), starting it if needed |
| `gabiro_delete_board` | Delete a board and its export |

## Config

`.gabiro/config.json` (optional):

```json
{ "autoExport": true, "exportDir": "docs/diagrams" }
```

## Develop

```bash
npm run build     # server (tsc) + canvas (vite) into dist/
npm test          # unit, MCP and server tests; e2e/browser tests run after a build
npm run typecheck # server and web
npm run dev:web   # canvas with hot reload; proxies the API to a running `gabiro serve`
```

### Mac app

```bash
npm run desktop:start  # build everything and run the app from the repo (any OS)
npm run app:mac        # macOS only: package release/Gabiro-<version>-universal.dmg and .zip
```

The Electron main process is in `desktop/src/` and reuses the built server from `dist/`. `test/desktop/app.smoke.test.ts` drives the app with Playwright; it needs `npm run build && npm run desktop:build` and a display (on Linux, run the tests under `xvfb-run -a`). CI builds the `.dmg` on every push to `main` and pull request; pushing a `v<version>` tag that matches `package.json` publishes it to a GitHub Release.

Before a release, check on a Mac: the app opens from the `.dmg` after **Open Anyway**; the Dock menu lists recent projects; `open "gabiro://open?root=$PWD"` in a project folder asks, then opens it; `gabiro_open_board` from Claude Code (set up with **Set Up Agent…**) brings the board up in the app; quitting the app stops its canvas servers (`.gabiro/server.json` is removed).

Browser tests use Chromium from `$GABIRO_CHROMIUM`, `/opt/pw-browsers/chromium`, or `npx playwright install chromium`; they are skipped when none is found. Set `GABIRO_NO_BROWSER=1` to stop gabiro from opening browser windows.
````

- [ ] **Step 2: Full verification**

```bash
npm run build && npm run desktop:build && npm run typecheck && xvfb-run -a npm test
```

Expected: warning-free builds, clean typechecks, and 29 test files with 229 tests passing.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: Mac app install, agent setup and development notes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E6gi4rWGtFNASPRARNJawQ"
```

---

### Task 13: Try it by hand

**Files:** none.

- [ ] **Step 1: Run the app on a real project** (any OS with a display)

```bash
npm run desktop:start
```

Then:
1. Choose **Open Folder…** and pick a project with boards (e.g. this repo, after asking an agent to create one). The canvas window is titled `<folder> — Gabiro`.
2. Edit a node. `docs/diagrams/<board>.md` updates.
3. Click **Switch project**. The start window lists the project with its board count.
4. With the window open, run `node dist/cli.js mcp` in the project from an agent and call `gabiro_open_board`. On Linux you get a browser tab served by the **app's** server (same port as the window), because `server.json` points at it.
5. Quit the app. `.gabiro/server.json` is gone.

- [ ] **Step 2: On a Mac** (or the CI `Gabiro-mac` artifact), run the README's pre-release checklist.
