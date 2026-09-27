import { describe, expect, it } from "vitest";
import type { Board, Op } from "../../src/core/index.js";
import { submitOps, type EditResult, type PostOps } from "../../web/src/api.js";
import { EditHistory } from "../../web/src/history.js";
import { FIXTURES } from "../fixtures/boards.js";

const rev = (revision: number): Board => ({ ...FIXTURES.architecture, revision });

describe("EditHistory", () => {
  it("undoes and redoes in order, and a new edit clears redo", () => {
    const h = new EditHistory();
    const a = { before: rev(1), after: rev(2) };
    const b = { before: rev(2), after: rev(3) };
    h.push(a);
    h.push(b);
    expect(h.undo()).toBe(b);
    expect(h.canRedo).toBe(true);
    expect(h.redo()).toBe(b);
    expect(h.undo()).toBe(b);
    h.push({ before: rev(2), after: rev(4) });
    expect(h.canRedo).toBe(false);
  });

  it("keeps at most `limit` edits and can put back a failed undo", () => {
    const h = new EditHistory(2);
    for (let i = 1; i <= 3; i++) h.push({ before: rev(i), after: rev(i + 1) });
    expect(h.undo()?.after.revision).toBe(4);
    expect(h.undo()?.after.revision).toBe(3);
    expect(h.undo()).toBeUndefined();
    const h2 = new EditHistory();
    const e = { before: rev(1), after: rev(2) };
    h2.push(e);
    h2.undo();
    h2.restore(e, "undo");
    expect(h2.canUndo).toBe(true);
    expect(h2.canRedo).toBe(false);
  });
});

describe("submitOps", () => {
  const ops: Op[] = [{ op: "update_node", id: "api", label: "API v2" }];

  function fakePost(results: EditResult[]) {
    const calls: (number | undefined)[] = [];
    const post: PostOps = async (_id, _ops, expected) => {
      calls.push(expected);
      return results.shift()!;
    };
    return { post, calls };
  }

  it("sends once when the revision is current", async () => {
    const { post, calls } = fakePost([{ ok: true, board: rev(2) }]);
    expect(await submitOps("x", ops, 1, post)).toMatchObject({ ok: true });
    expect(calls).toEqual([1]);
  });

  it("re-applies once on a conflict, against the latest revision", async () => {
    const { post, calls } = fakePost([
      { ok: false, status: 409, code: "CONFLICT", error: "stale", board: rev(5) },
      { ok: true, board: rev(6) },
    ]);
    expect(await submitOps("x", ops, 1, post)).toMatchObject({ ok: true, board: { revision: 6 } });
    expect(calls).toEqual([1, 5]);
  });

  it("gives up after the second attempt, and never retries other errors", async () => {
    const conflict = { ok: false as const, status: 409, code: "CONFLICT", error: "stale", board: rev(5) };
    const twice = fakePost([conflict, { ...conflict, board: rev(6) }]);
    expect(await submitOps("x", ops, 1, twice.post)).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(twice.calls).toEqual([1, 5]);
    const invalid = fakePost([{ ok: false, status: 400, code: "VALIDATION", error: "Op #0 failed" }]);
    expect(await submitOps("x", ops, 1, invalid.post)).toMatchObject({ ok: false, code: "VALIDATION" });
    expect(invalid.calls).toEqual([1]);
  });
});
