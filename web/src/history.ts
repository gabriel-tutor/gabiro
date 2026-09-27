import type { Board } from "../../src/core/index.js";

/** One edit made in this canvas: the board just before it, and the board the server saved. */
export interface HistoryEntry {
  before: Board;
  after: Board;
}

/**
 * The history entry for a saved edit. After a conflict re-apply the edit landed on the server's
 * newer board (`base`), not on the board the user saw, so undo must return to `base`: returning to
 * the older board would also undo the other editor's changes.
 */
export function entryFor(shown: Board, saved: { board: Board; base?: Board }): HistoryEntry {
  return { before: saved.base ?? shown, after: saved.board };
}

/**
 * What to do with an undo/redo entry whose request failed: a network hiccup or a lost race may
 * work next time ("restore"); anything else (the board changed so the step no longer applies)
 * never will ("discard").
 */
export function afterFailedStep(code: string): "restore" | "discard" {
  return code === "NETWORK" || code === "CONFLICT" ? "restore" : "discard";
}

/** Undo/redo stacks for the user's own canvas edits (agent edits are not undone). */
export class EditHistory {
  private done: HistoryEntry[] = [];
  private undone: HistoryEntry[] = [];

  constructor(private readonly limit = 100) {}

  /** Records a new edit; it clears the redo stack. */
  push(entry: HistoryEntry): void {
    this.done.push(entry);
    if (this.done.length > this.limit) this.done.shift();
    this.undone = [];
  }

  /** The edit to undo next, moved to the redo stack. */
  undo(): HistoryEntry | undefined {
    const entry = this.done.pop();
    if (entry) this.undone.push(entry);
    return entry;
  }

  /** The edit to redo next, moved back to the undo stack. */
  redo(): HistoryEntry | undefined {
    const entry = this.undone.pop();
    if (entry) this.done.push(entry);
    return entry;
  }

  /** Puts an entry back where it came from after its undo/redo request failed. */
  restore(entry: HistoryEntry, from: "undo" | "redo"): void {
    this.discard(entry, from);
    (from === "undo" ? this.done : this.undone).push(entry);
  }

  /** Drops an entry that undo/redo just moved, for good (its step can no longer be applied). */
  discard(entry: HistoryEntry, from: "undo" | "redo"): void {
    const stack = from === "undo" ? this.undone : this.done;
    const i = stack.lastIndexOf(entry);
    if (i >= 0) stack.splice(i, 1);
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }
}
