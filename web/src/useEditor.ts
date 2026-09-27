import { useCallback, useEffect, useRef, useState } from "react";
import { applyOps, type Board, type Op } from "../../src/core/index.js";
import { postLayout, submitOps, type EditResult } from "./api.js";
import { diffOps } from "./edits.js";
import { EditHistory, type HistoryEntry } from "./history.js";

export interface Editor {
  /** What the canvas shows: the server's board, or the optimistic result of an edit in flight. */
  board?: Board;
  /** Applies ops locally at once, then saves them; reverts and reports on failure. */
  apply(ops: Op[]): Promise<void>;
  /** Re-runs auto-layout on the server (pinned nodes stay unless `force`). */
  autoLayout(force?: boolean): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * Optimistic editing on top of the live board. Edits show immediately, are saved through the
 * canvas server (re-applied once on a revision conflict), and are recorded for undo/redo.
 */
export function useEditor(serverBoard: Board | undefined, onError: (message: string) => void): Editor {
  const history = useRef(new EditHistory());
  const [optimistic, setOptimistic] = useState<Board>();
  const [, setVersion] = useState(0);
  const latestRevision = useRef(serverBoard?.revision ?? 0);

  // A newer server snapshot replaces any optimistic board.
  useEffect(() => {
    latestRevision.current = serverBoard?.revision ?? 0;
    setOptimistic((o) => (o && serverBoard && serverBoard.revision >= o.revision ? undefined : o));
  }, [serverBoard]);

  const shown = optimistic ?? serverBoard;
  const shownRef = useRef(shown);
  shownRef.current = shown;

  /** Saves ops made against the shown board; returns the saved board, or undefined on failure. */
  const save = useCallback(
    async (ops: Op[]): Promise<{ before: Board; after: Board } | undefined> => {
      const before = shownRef.current;
      if (!before || !ops.length) return undefined;
      try {
        setOptimistic({ ...applyOps(before, ops), revision: before.revision });
      } catch (err) {
        onError((err as Error).message);
        return undefined;
      }
      const result: EditResult = await submitOps(before.id, ops, before.revision);
      if (!result.ok) {
        setOptimistic(undefined);
        onError(result.error);
        return undefined;
      }
      if (result.exportWarning) onError(`Saved, but the Markdown export failed: ${result.exportWarning}`);
      setOptimistic(result.board.revision > latestRevision.current ? result.board : undefined);
      return { before, after: result.board };
    },
    [onError],
  );

  const apply = useCallback(
    async (ops: Op[]) => {
      const saved = await save(ops);
      if (saved) history.current.push(saved);
      setVersion((v) => v + 1);
    },
    [save],
  );

  const step = useCallback(
    async (direction: "undo" | "redo") => {
      const entry: HistoryEntry | undefined = direction === "undo" ? history.current.undo() : history.current.redo();
      if (!entry) return;
      const ops = direction === "undo" ? diffOps(entry.after, entry.before) : diffOps(entry.before, entry.after);
      const saved = ops.length ? await save(ops) : { before: entry.after, after: entry.after };
      if (!saved) history.current.restore(entry, direction);
      setVersion((v) => v + 1);
    },
    [save],
  );

  const autoLayout = useCallback(
    async (force = false) => {
      const board = shownRef.current;
      if (!board) return;
      const result = await postLayout(board.id, force);
      if (!result.ok) onError(result.error);
      else if (result.board.revision > latestRevision.current) setOptimistic(result.board);
    },
    [onError],
  );

  return {
    board: shown,
    apply,
    autoLayout,
    undo: useCallback(() => step("undo"), [step]),
    redo: useCallback(() => step("redo"), [step]),
    canUndo: history.current.canUndo,
    canRedo: history.current.canRedo,
  };
}
