import type { Board, Op } from "../../src/core/index.js";

export type EditResult =
  | {
      ok: true;
      board: Board;
      exportWarning?: string;
      /** Set only when the edit was re-applied after a conflict: the board it was finally applied to. */
      base?: Board;
    }
  | { ok: false; status: number; code: string; error: string; board?: Board };

export type PostOps = (boardId: string, ops: Op[], expectedRevision?: number) => Promise<EditResult>;

const NETWORK_ERROR = "Can't reach the gabiro canvas server. Is `gabiro serve` still running?";

/** POSTs JSON to one of a board's edit routes (same origin). Network failures come back as a result, not a throw. */
async function postEdit(boardId: string, action: "ops" | "layout", payload: unknown): Promise<EditResult> {
  try {
    const res = await fetch(`/api/boards/${encodeURIComponent(boardId)}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) {
      const exportWarning = body.exportWarning as string | undefined;
      return { ok: true, board: body.board as Board, ...(exportWarning ? { exportWarning } : {}) };
    }
    return {
      ok: false,
      status: res.status,
      code: String(body.code ?? "ERROR"),
      error: String(body.error ?? `Request failed (${res.status})`),
      board: body.board as Board | undefined,
    };
  } catch {
    return { ok: false, status: 0, code: "NETWORK", error: NETWORK_ERROR };
  }
}

/** POSTs ops to the canvas server. */
export const postOps: PostOps = (boardId, ops, expectedRevision) => postEdit(boardId, "ops", { ops, expectedRevision });

/** Asks the canvas server to re-run auto-layout for a board. */
export function postLayout(boardId: string, force: boolean): Promise<EditResult> {
  return postEdit(boardId, "layout", { force });
}

/**
 * Sends an edit made against `revision`. If someone else changed the board meanwhile (409), the
 * same ops are re-applied once on top of the latest board; if that fails too, the error is returned.
 * A success after a re-apply carries that latest board as `base`.
 */
export async function submitOps(boardId: string, ops: Op[], revision: number, post: PostOps = postOps): Promise<EditResult> {
  const first = await post(boardId, ops, revision);
  if (first.ok || first.code !== "CONFLICT" || !first.board) return first;
  const second = await post(boardId, ops, first.board.revision);
  return second.ok ? { ...second, base: first.board } : second;
}

/** What to tell the user when an edit couldn't be saved. */
export function editErrorMessage(failure: { code: string; error: string }): string {
  if (failure.code === "CONFLICT") {
    return "Someone else changed the board at the same time and your edit couldn't be re-applied. Try again.";
  }
  return failure.error;
}
