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
