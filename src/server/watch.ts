import { watch, type FSWatcher } from "node:fs";
import { mkdirSync } from "node:fs";

const BOARD_FILE = /^([a-z0-9][a-z0-9-]*)\.json$/;

/**
 * Calls `onChange(boardId)` when `<dir>/<id>.json` is created, changed or removed.
 * Events are debounced per board, so an atomic write (temp file + rename) fires once.
 */
export function watchBoards(dir: string, onChange: (boardId: string) => void, debounceMs = 40): () => void {
  mkdirSync(dir, { recursive: true });
  const timers = new Map<string, NodeJS.Timeout>();
  const watcher: FSWatcher = watch(dir, (_event, filename) => {
    const id = filename ? BOARD_FILE.exec(filename.toString())?.[1] : undefined;
    if (!id) return;
    clearTimeout(timers.get(id));
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        onChange(id);
      }, debounceMs),
    );
  });
  return () => {
    watcher.close();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };
}
