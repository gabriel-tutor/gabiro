import type { Board } from "../../src/core/index.js";

/** One edit made in this canvas: the board just before it, and the board the server saved. */
export interface HistoryEntry {
  before: Board;
  after: Board;
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
    if (from === "undo") {
      this.undone.pop();
      this.done.push(entry);
    } else {
      this.done.pop();
      this.undone.push(entry);
    }
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }
}