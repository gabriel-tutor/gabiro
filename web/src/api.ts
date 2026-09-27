import type { Board, Op } from "../../src/core/index.js";

export type EditResult =
  | { ok: true; board: Board; exportWarning?: string }
  | { ok: false; status: number; code: string; error: string; board?: Board };

export type PostOps = (boardId: string, ops: Op[], expectedRevision?: number) => Promise<EditResult>;

/** POSTs ops to the canvas server (same origin). Network failures come back as a result, not a throw. */
export const postOps: PostOps = async (boardId, ops, expectedRevision) => {
  try {
    const res = await fetch(`/api/boards/${encodeURIComponent(boardId)}/ops`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ops, expectedRevision }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return { ok: true, board: body.board as Board, exportWarning: body.exportWarning as string | undefined };
    return {
      ok: false,
      status: res.status,
      code: String(body.code ?? "ERROR"),
      error: String(body.error ?? `Request failed (${res.status})`),
      board: body.board as Board | undefined,
    };
  } catch {
    return { ok: false, status: 0, code: "NETWORK", error: "Can't reach the gabiro canvas server. Is `gabiro serve` still running?" };
  }
};

/** Asks the canvas server to re-run auto-layout for a board. */
export async function postLayout(boardId: string, force: boolean): Promise<EditResult> {
  try {
    const res = await fetch(`/api/boards/${encodeURIComponent(boardId)}/layout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return { ok: true, board: body.board as Board };
    return { ok: false, status: res.status, code: String(body.code ?? "ERROR"), error: String(body.error ?? `Request failed (${res.status})`) };
  } catch {
    return { ok: false, status: 0, code: "NETWORK", error: "Can't reach the gabiro canvas server. Is `gabiro serve` still running?" };
  }
}

/**
 * Sends an edit made against `revision`. If someone else changed the board meanwhile (409), the
 * same ops are re-applied once on top of the latest board; if that fails too, the error is returned.
 */
export async function submitOps(boardId: string, ops: Op[], revision: number, post: PostOps = postOps): Promise<EditResult> {
  const first = await post(boardId, ops, revision);
  if (first.ok || first.code !== "CONFLICT" || !first.board) return first;
  return post(boardId, ops, first.board.revision);
}