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
