import { mkdirSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const BOARD_FILE = /^([a-z0-9][a-z0-9-]*)\.json$/;

/** Identifies one incarnation of the directory, so a removed-and-recreated dir is noticed. */
const identityOf = (s: { dev: number; ino: number; birthtimeMs: number }) => `${s.dev}:${s.ino}:${s.birthtimeMs}`;

/**
 * Calls `onChange(boardId)` when `<dir>/<id>.json` is created, changed or removed.
 * Events are debounced per board, so an atomic write (temp file + rename) fires once.
 *
 * fs.watch gives fast notifications; a poll every `pollMs` catches anything it misses and
 * re-creates the watcher when it errored, failed to start, or the directory was replaced.
 * If fs.watch can't start at all (e.g. ENOSPC/EMFILE), polling alone keeps boards live.
 */
export function watchBoards(
  dir: string,
  onChange: (boardId: string) => void,
  debounceMs = 40,
  pollMs = 2000,
): () => void {
  const timers = new Map<string, NodeJS.Timeout>();
  /** Last seen mtimeMs per board id. */
  let known = new Map<string, number>();
  let watcher: FSWatcher | undefined;
  let dirIdentity: string | undefined;
  let closed = false;
  let polling = false;
  let lastError: string | undefined;

  const mtimeOf = (id: string) => {
    try {
      return statSync(join(dir, `${id}.json`)).mtimeMs;
    } catch {
      return undefined;
    }
  };

  const fire = (id: string) => {
    clearTimeout(timers.get(id));
    const timer = setTimeout(() => {
      timers.delete(id);
      if (closed) return;
      // Record what we are reporting so the next poll doesn't report it again.
      const mtime = mtimeOf(id);
      if (mtime === undefined) known.delete(id);
      else known.set(id, mtime);
      onChange(id);
    }, debounceMs);
    timer.unref();
    timers.set(id, timer);
  };

  const stopWatcher = () => {
    watcher?.close();
    watcher = undefined;
  };

  const startWatcher = () => {
    stopWatcher();
    try {
      const w = watch(dir, (_event, filename) => {
        const id = filename ? BOARD_FILE.exec(filename.toString())?.[1] : undefined;
        if (id) fire(id);
      });
      w.on("error", () => {
        // Re-armed by the next poll.
        if (watcher === w) stopWatcher();
      });
      watcher = w;
    } catch {
      // Polling only until a later poll manages to start it.
    }
  };

  const logOnce = (err: unknown) => {
    const message = (err as Error).message;
    if (message !== lastError) console.error(`gabiro canvas: can't watch ${dir}:`, message);
    lastError = message;
  };

  async function poll(): Promise<void> {
    if (closed || polling) return;
    polling = true;
    try {
      await mkdir(dir, { recursive: true });
      const identity = identityOf(await stat(dir));
      if (closed) return;
      if (identity !== dirIdentity || !watcher) {
        dirIdentity = identity;
        startWatcher();
      }
      const current = new Map<string, number>();
      for (const name of await readdir(dir)) {
        const id = BOARD_FILE.exec(name)?.[1];
        if (!id) continue;
        const mtime = await stat(join(dir, name)).then((s) => s.mtimeMs, () => undefined);
        if (mtime !== undefined) current.set(id, mtime);
      }
      if (closed) return;
      for (const [id, mtime] of current) if (known.get(id) !== mtime && !timers.has(id)) fire(id);
      for (const id of known.keys()) if (!current.has(id) && !timers.has(id)) fire(id);
      known = current;
      lastError = undefined;
    } catch (err) {
      logOnce(err);
    } finally {
      polling = false;
    }
  }

  // Start synchronously so changes right after this call are seen, with a baseline of existing
  // boards so the first poll only reports real changes.
  try {
    mkdirSync(dir, { recursive: true });
    dirIdentity = identityOf(statSync(dir));
    startWatcher();
    for (const name of readdirSync(dir)) {
      const id = BOARD_FILE.exec(name)?.[1];
      const mtime = id ? mtimeOf(id) : undefined;
      if (id && mtime !== undefined) known.set(id, mtime);
    }
  } catch (err) {
    logOnce(err);
  }
  const interval = setInterval(() => void poll(), pollMs);
  interval.unref();

  return () => {
    closed = true;
    clearInterval(interval);
    stopWatcher();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };
}
