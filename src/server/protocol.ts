import type { Board } from "../core/index.js";
import type { BoardListItem } from "../store/store.js";

/** Messages the browser sends over the /ws socket. */
export type ClientMessage = { type: "subscribe"; boardId: string } | { type: "subscribe-list" };

/** Messages the canvas server pushes to the browser. Boards are always sent as full snapshots. */
export type ServerMessage =
  | { type: "board"; board: Board }
  | { type: "board-error"; boardId: string; code: string; message: string }
  | { type: "boards"; boards: BoardListItem[] };

/** Response of GET /api/health; `root` lets a client confirm the server belongs to its project. */
export interface HealthResponse {
  ok: true;
  root: string;
  version: string;
  pid: number;
}
