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
/** The app icon as a PNG: the window icon on Windows and Linux, and the Dock icon when run from the repo. */
const iconPath = join(desktopDir, "build", "icon.png");
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
  contents.on("will-redirect", (event, url) => {
    if (origin !== undefined && new URL(url).origin === origin) return;
    event.preventDefault();
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
    icon: iconPath,
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
    icon: iconPath,
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

const confirming = new Set<string>();

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
    if (confirming.has(root)) {
      console.error(`gabiro: ignored link ${raw}: already asking about this folder`);
      return;
    }
    confirming.add(root);
    try {
      const { response } = await dialog.showMessageBox({
        type: "question",
        message: `Open the project at ${root} in Gabiro?`,
        detail: "A link asked Gabiro to open this folder.",
        buttons: ["Open", "Cancel"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response !== 0) return;
    } finally {
      confirming.delete(root);
    }
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
    // The packaged app gets its icon from the bundle; `electron .` would otherwise show Electron's.
    else if (isMac) app.dock?.setIcon(iconPath);
    await rebuildMenus();
    ready = true;
    const links = [...pendingLinks.splice(0), ...process.argv.filter((a) => a.startsWith("gabiro://"))];
    for (const link of links) await followLink(link);
    if (BrowserWindow.getAllWindows().length === 0) showStart();
  });
}
