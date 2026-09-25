import type { Board, Kind } from "../core/index.js";

export interface BoardListItem {
  id: string;
  title: string;
  kind: Kind | "unknown";
  nodeCount: number;
  updatedAt: string;
  /** Set when the file can't be read; the board is listed so the user can see and fix it. */
  error?: string;
}

/** Persistence boundary. FileStore is the local implementation; a database store can replace it later. */
export interface BoardStore {
  list(): Promise<BoardListItem[]>;
  /** Throws NOT_FOUND or CORRUPT. */
  get(id: string): Promise<Board>;
  /** Writes a new board. Throws EXISTS. */
  create(board: Board): Promise<Board>;
  /**
   * Reads the latest board under a lock, applies `change`, validates, bumps `revision`,
   * sets `updatedAt` and writes atomically. Throws CONFLICT if `expectedRevision` is stale.
   */
  update(id: string, change: (board: Board) => Board | Promise<Board>, expectedRevision?: number): Promise<Board>;
  /** Throws NOT_FOUND. */
  delete(id: string): Promise<void>;
}
