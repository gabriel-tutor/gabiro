# Gabiro Mac App — Design Spec

**Date:** 2026-09-27
**Status:** Approved (implementation plan: `docs/superpowers/plans/2026-09-27-gabiro-plan-4-mac-app.md`)
**Builds on:** `docs/superpowers/specs/2026-09-25-gabiro-design.md` (live canvas: `gabiro serve`, the React Flow web app, and `.gabiro/server.json` discovery)

## 1. Summary

`Gabiro.app` is a macOS app you launch from the Dock with no terminal:
- **Windows:** each project opens in its own window, which shows that project's live, editable canvas.
- **Agents:** when an agent calls `gabiro_open_board`, the app comes forward showing that board.
- **Setup:** the app bundles the gabiro CLI, so connecting an agent is one command copied from the app's menu. There's no repo to clone and no Node to install.
- **Distribution:** GitHub Actions builds a universal `.dmg` for every release tag.

### Goals
- **Dock launch:** a start screen with recent projects and Open Folder…; each project in its own window; recent projects in the Dock menu.
- **Agent integration:** `gabiro_open_board` opens the board in the app when it is installed, and falls back to the browser otherwise.
- **One server per project:** the app reuses a healthy canvas server already running for a project, and agents reuse the app's server.
- **Zero-install agent setup:** the MCP server runs from the app bundle.
- **Automatic builds:** CI builds and publishes the `.dmg`, and runs the test suite on every push and pull request.

### Non-goals
- Developer ID signing and notarization. The app ships **ad-hoc signed** (`identity: "-"`), because a fully unsigned universal build is reported as "damaged" on Apple Silicon. The first launch needs **System Settings → Privacy & Security → Open Anyway** (or `xattr -dr com.apple.quarantine`). Real signing can be added later with CI secrets.
- Windows and Linux desktop packages (Electron could build them later).
- Auto-update.
- A single window holding several projects (tabs or a sidebar).

## 2. Architecture

```
Gabiro.app (Electron)
├── main process (Node)                      ← reuses dist/server, dist/service, dist/core …
│   ├── ProjectManager: open(root, board?) → focus or create { window, server }
│   ├── RecentProjects: <userData>/recent.json (max 10, most recent first)
│   ├── StartWindow: desktop/start.{html,css,js} (recent list + "Open Folder…")
│   ├── App menu + Dock menu: recent projects, Open Folder…, Set Up Agent…
│   └── Deep links: gabiro://open?root=<abs path>&board=<id>
└── BrowserWindows (Chromium) load http://127.0.0.1:<port>/ or /b/<id> from the project's server
```

### 2.1 Project windows
- `ProjectManager.open(root, boardId?)`:
  1. If a window for `root` exists, focus it (navigating to the board if one is given).
  2. Otherwise read `root/.gabiro/server.json`. If it names a server that is healthy for this root (`isHealthy`), load that server's URL; the app does not own it.
  3. Otherwise call `startCanvasServer({ root, port: 0 })` in-process. The app owns this server, which records `server.json`.
  4. Create a `BrowserWindow` titled `<folder name> — Gabiro`, load `<url>/` or `<url>/b/<boardId>`, and add `root` to recent projects.
- **Closing a window** closes the canvas server if the app owns it. That also removes `server.json`, through the existing pid check. Servers the app didn't start are left running. Quitting closes every window and so every owned server.
- **Window security:**
  - `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no preload with Node access.
  - A window may only navigate to its own server's origin. Other `http(s)` links open in the default browser (`shell.openExternal`), and anything else is blocked.
- **Web app change:** one "Switch project" link in the header, shown only when the page runs inside the app (detected by the user agent containing `Gabiro/`). It navigates to `gabiro://start`, which the main process intercepts to show the start window.

### 2.2 Start window
- Lists recent projects: folder name, full path, board count (from `.gabiro/boards/*.json`), and a "missing" badge when the folder no longer exists. Missing entries can be removed.
- **Open Folder…** uses the native dialog (`showOpenDialog`, `openDirectory` + `createDirectory`). A folder without `.gabiro/` is fine: it opens with an empty board list.
- It is a local page (`desktop/start.html` with `start.css` and `start.js`, under a CSP allowing only its own files) with a minimal CommonJS preload (`desktop/preload.cjs`; sandboxed preloads must be CommonJS) exposing exactly `list()`, `open(root)`, `openFolder()` and `forget(root)` through `contextBridge`. Its IPC handlers answer only the start window and validate their inputs: `root` must be an absolute path to an existing directory (`forget` accepts any absolute path, since the folder may be gone).

### 2.3 Recent projects
- `<userData>/recent.json` is `[{ root, openedAt }]`, deduplicated by real path, newest first, with at most 10 entries. It is written atomically. A missing or corrupt file means an empty list; it is never a crash.

## 3. Agent integration

### 3.1 `gabiro://` deep links
- Registered through electron-builder `protocols` (`Info.plist`) and `app.setAsDefaultProtocolClient("gabiro")`. The app runs as a single instance; links arrive through `open-url` (macOS) or `second-instance` (other platforms).
- `gabiro://open?root=<abs path>&board=<id>`:
  - `root` must be absolute, contain no `..` segments after normalising, and point to an existing directory;
  - `board` is optional and must match the board id slug;
  - an unknown host or invalid parameters are ignored, with a log line.
- `gabiro://start` shows the start window.
- **Confirmation:** if `root` is not already a recent project, the app asks first, with a native dialog ("Open the project at <path> in Gabiro?", with Open / Cancel), because any website can fire `gabiro://` links. Recent projects open without asking.

### 3.2 `gabiro_open_board` prefers the app
- `src/server/launcher.ts` gains `openCanvas(root, boardId?)`, which returns `{ url?, via: "app" | "browser" | "none", appPending? }`:
  - **Uses the app** when `process.platform === "darwin"`, `GABIRO_NO_APP` and `GABIRO_NO_BROWSER` are unset, and `Gabiro.app` exists in `/Applications` or `~/Applications`. It runs `open "gabiro://open?root=…&board=…"`, with arguments passed as a list and no shell.
  - **Otherwise** it behaves as today: `ensureCanvasServer`, then `openInBrowser`.
  - If macOS accepts the link (`open` exits 0), the app owns showing the board: `openCanvas` waits up to 8 s for the project's server to report its URL, and otherwise tells the agent the app may be waiting for the user to confirm. It falls back to the browser only if the link can't be handed to the app.
- The detection and the opener are injectable for tests.
- `gabiro_open_board` uses `openCanvas`. Its result text says where the board opened.

### 3.3 MCP from the app bundle
- The bundle includes `Contents/Resources/bin/gabiro`, a POSIX shell script that runs `ELECTRON_RUN_AS_NODE=1 "<bundle>/Contents/MacOS/Gabiro" "<bundle>/Contents/Resources/app.asar/dist/cli.js" "$@"`, resolving `<bundle>` from the script's own path.
- The MCP server and `gabiro serve` then run on Electron's built-in Node, with no system Node needed. When the MCP server spawns a detached `gabiro serve`, the child inherits `ELECTRON_RUN_AS_NODE`.
- **Menu → Set Up Agent…** opens a native dialog showing both snippets, with copy buttons for:
  - Claude Code: `claude mcp add gabiro -- /Applications/Gabiro.app/Contents/Resources/bin/gabiro mcp`, using the bundle's actual path (shell-quoted only when it needs it, e.g. for spaces);
  - the JSON `mcpServers` snippet for Claude Desktop and Cursor. These clients don't start the server in the project folder, so the snippet passes `--root /path/to/your/project` for the user to fill in.

## 4. Build and release

- **Packaging:** electron-builder packages a macOS **universal** (arm64 + x64) `.dmg` and `.zip` named `Gabiro-<version>-universal.*`, ad-hoc signed (`mac.identity: "-"`, `hardenedRuntime: false`). The app id is `dev.gabiro.app`, and the version is `package.json`'s `version`. The app keeps its code in `app.asar`; the bundled CLI runs from there (verified: MCP over stdio, `gabiro serve` serving the web app from the asar, and ELK layout).
- **Build scripts:**
  - `npm run build` builds the CLI, server and web app, as today.
  - `npm run desktop:build` compiles `desktop/src` into `desktop/dist`.
  - `npm run app:mac` (macOS only) runs both and packages the app.
  - `npm run desktop:start` builds everything and runs the app from the repo, on any OS.
- **`.github/workflows/ci.yml`, on pushes to `main` and on pull requests:**
  - An **Ubuntu** job runs `npm ci`, typecheck, build and `npm test`, with Chromium for the browser tests and `xvfb-run` for the Electron smoke test.
  - A **macOS** job runs `npm ci`, `npm run app:mac` with `--publish never`, and uploads the `.dmg` as a workflow artifact.
- **`.github/workflows/release.yml`, on `v*` tags:** checks that the tag matches `package.json`'s version, builds on macOS, then creates or updates the GitHub Release for the tag with the `.dmg` and `.zip` attached.

## 5. Error handling

- **Canvas server fails to start** (e.g. EACCES on `.gabiro/`): a native error dialog names the folder and the reason. The start window stays open.
- **Recent project folder is missing:** it is shown with a badge, and opening it shows "This folder no longer exists" with a Remove button.
- **Deep link for a folder that doesn't exist, or with invalid parameters:** ignored with a log line. No dialog, because websites can fire these links.
- **`openCanvas` hands the link to the app but doesn't get a healthy server within 8 s:** it reports the app as pending instead of falling back to the browser. The tool result tells the agent to call `gabiro_open_board` again once the app is open.

## 6. Testing

- **Unit tests (Vitest):**
  - deep-link parsing: valid, relative, `..`, a missing dir, a bad board id, an unknown host, `gabiro://start`;
  - the recent-projects store: dedupe, cap, a corrupt file, atomic write;
  - `ProjectManager` with fake window and server factories: focus an existing window, reuse a healthy foreign server, start and own a server, close only owned servers, add to recents;
  - `openCanvas`: the app present or absent, the env switches, the app pending when it doesn't serve in time, the browser fallback when handing the link to the app fails.
- **Electron smoke test** (Playwright `_electron`): it launches the built app with a temp `userData` and project, and checks that the start window lists the project, that opening it renders the canvas, and that a deep link to a new folder asks for confirmation. It is skipped when no display is available; CI runs it under `xvfb-run`.
- **macOS-only behaviour** (Dock menu, `open-url` delivery, Gatekeeper, the `bin/gabiro` script inside a real bundle) is covered by the macOS CI packaging job plus a manual first-launch checklist in the README.

## 7. Out of scope (later)
- Developer ID signing and notarization, and auto-update.
- Windows and Linux installers.
- Opening boards from Finder (a `.gabiro` document type).
