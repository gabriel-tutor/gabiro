import { useCallback, useEffect, useRef, useState } from "react";
import { applyOps, type Board, type Op } from "../../src/core/index.js";
import { editErrorMessage, postLayout, submitOps } from "./api.js";
import { diffOps } from "./edits.js";
import { afterFailedStep, EditHistory, entryFor, type HistoryEntry } from "./history.js";
import { createQueue } from "./queue.js";

export interface Editor {
  /** What the canvas shows: the server's board, or the optimistic result of an edit in flight. */
  board?: Board;
  /** Applies ops locally at once, then saves them; reverts and reports on failure. Resolves to whether it saved. */
  apply(ops: Op[]): Promise<boolean>;
  /** Re-runs auto-layout on the server (pinned nodes stay unless `force`). Not undoable. */
  autoLayout(force?: boolean): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
}

type Saved = { ok: true; entry: HistoryEntry } | { ok: false; code: string; error: string };

/**
 * Optimistic editing on top of the live board. Edits show immediately, are saved through the
 * canvas server (re-applied once on a revision conflict), and are recorded for undo/redo.
 *
 * Edits, undo/redo and auto-layout run strictly one at a time (a queue), and each starts from the
 * board as it is when its turn comes, so none is sent against a revision an earlier one replaced.
 */
export function useEditor(serverBoard: Board | undefined, onError: (message: string) => void): Editor {
  const history = useRef(new EditHistory());
  const queue = useRef(createQueue());
  const [optimistic, setOptimistic] = useState<Board>();
  const [, setVersion] = useState(0);
  // Refs mirror the state so a queued job sees the board as of its start, not of an old render.
  const optimisticRef = useRef<Board>(undefined);
  const serverRef = useRef(serverBoard);
  serverRef.current = serverBoard;
  const latestRevision = useRef(serverBoard?.revision ?? 0);
  /** True while a job is being saved: its optimistic board must survive snapshots until it's settled. */
  const inFlight = useRef(false);

  const showOptimistic = useCallback((board: Board | undefined) => {
    optimisticRef.current = board;
    setOptimistic(board);
  }, []);

  /** Keeps `board` on screen only while it is newer than what the server last sent. */
  const settle = useCallback(
    (board: Board | undefined) => showOptimistic(board && board.revision > latestRevision.current ? board : undefined),
    [showOptimistic],
  );

  // A server snapshot at least as new as the optimistic board replaces it, unless a save is in flight.
  useEffect(() => {
    latestRevision.current = serverBoard?.revision ?? 0;
    const o = optimisticRef.current;
    if (o && serverBoard && !inFlight.current && serverBoard.revision >= o.revision) showOptimistic(undefined);
  }, [serverBoard, showOptimistic]);

  const current = () => optimisticRef.current ?? serverRef.current;

  /** Saves ops against the board shown when called (call it from a queued job). */
  const save = useCallback(
    async (ops: Op[]): Promise<Saved> => {
      const before = current();
      if (!before) return { ok: false, code: "NOT_FOUND", error: "The board isn't loaded." };
      try {
        showOptimistic({ ...applyOps(before, ops), revision: before.revision });
      } catch (err) {
        return { ok: false, code: "VALIDATION", error: (err as Error).message };
      }
      inFlight.current = true;
      try {
        const result = await submitOps(before.id, ops, before.revision);
        if (!result.ok) {
          settle(before);
          return { ok: false, code: result.code, error: editErrorMessage(result) };
        }
        if (result.exportWarning) onError(`Saved, but the Markdown export failed: ${result.exportWarning}`);
        settle(result.board);
        return { ok: true, entry: entryFor(before, result) };
      } finally {
        inFlight.current = false;
      }
    },
    [onError, settle, showOptimistic],
  );

  const apply = useCallback(
    (ops: Op[]) =>
      queue.current.run(async () => {
        if (!ops.length) return false;
        const saved = await save(ops);
        if (saved.ok) history.current.push(saved.entry);
        else onError(saved.error);
        setVersion((v) => v + 1);
        return saved.ok;
      }),
    [save, onError],
  );

  const step = useCallback(
    (direction: "undo" | "redo") =>
      queue.current.run(async () => {
        const entry = direction === "undo" ? history.current.undo() : history.current.redo();
        if (!entry) return;
        const ops = direction === "undo" ? diffOps(entry.after, entry.before) : diffOps(entry.before, entry.after);
        const saved = ops.length ? await save(ops) : undefined;
        if (saved && !saved.ok) {
          if (afterFailedStep(saved.code) === "restore") {
            history.current.restore(entry, direction);
            onError(saved.error);
          } else {
            history.current.discard(entry, direction);
            onError(
              saved.code === "VALIDATION" || saved.code === "NOT_FOUND"
                ? `Can't ${direction} that: the board changed since (${saved.error})`
                : saved.error,
            );
          }
        }
        setVersion((v) => v + 1);
      }),
    [save, onError],
  );

  const autoLayout = useCallback(
    (force = false) =>
      queue.current.run(async () => {
        const board = current();
        if (!board) return;
        inFlight.current = true;
        try {
          const result = await postLayout(board.id, force);
          if (!result.ok) return onError(editErrorMessage(result));
          if (result.exportWarning) onError(`Saved, but the Markdown export failed: ${result.exportWarning}`);
          settle(result.board);
        } finally {
          inFlight.current = false;
        }
      }),
    [onError, settle],
  );

  return {
    board: optimistic ?? serverBoard,
    apply,
    autoLayout,
    undo: useCallback(() => step("undo"), [step]),
    redo: useCallback(() => step("redo"), [step]),
    canUndo: history.current.canUndo,
    canRedo: history.current.canRedo,
  };
}
