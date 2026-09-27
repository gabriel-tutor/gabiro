import { describe, expect, it } from "vitest";
import { applyOps, type Board, type Op } from "../../src/core/index.js";
import { editErrorMessage, submitOps, type EditResult, type PostOps } from "../../web/src/api.js";
import { diffOps } from "../../web/src/edits.js";
import { afterFailedStep, EditHistory, entryFor } from "../../web/src/history.js";
import { createQueue } from "../../web/src/queue.js";
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

  it("discards a failed undo or redo for good", () => {
    const h = new EditHistory();
    const a = { before: rev(1), after: rev(2) };
    const b = { before: rev(2), after: rev(3) };
    h.push(a);
    h.push(b);
    h.discard(h.undo()!, "undo");
    expect(h.canRedo).toBe(false);
    expect(h.undo()).toBe(a);
    h.discard(h.redo()!, "redo");
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
  });

  it("restores the failed entry itself, even after an interleaved push", () => {
    const h = new EditHistory();
    const a = { before: rev(1), after: rev(2) };
    const b = { before: rev(2), after: rev(3) };
    h.push(a);
    h.undo();
    expect(h.redo()).toBe(a);
    h.push(b);
    h.restore(a, "redo");
    // b stays done; a is back on the redo stack instead of b being popped.
    expect(h.undo()).toBe(b);
    expect(h.undo()).toBeUndefined();
    expect(h.redo()).toBe(b);
    expect(h.redo()).toBe(a);
    const h2 = new EditHistory();
    h2.push(a);
    h2.undo();
    h2.push(b);
    h2.restore(a, "undo");
    expect(h2.undo()).toBe(a);
    expect(h2.undo()).toBe(b);
  });

  it("only restores failed steps that may work next time", () => {
    expect(afterFailedStep("NETWORK")).toBe("restore");
    expect(afterFailedStep("CONFLICT")).toBe("restore");
    expect(afterFailedStep("VALIDATION")).toBe("discard");
    expect(afterFailedStep("NOT_FOUND")).toBe("discard");
  });
});

describe("undo after a conflict re-apply", () => {
  it("undoes only the user's edit, not the agent's concurrent change", async () => {
    const r = rev(4);
    const agent = { ...applyOps(r, [{ op: "add_node", id: "x", type: "service", label: "X" }]), revision: 5 };
    const rename: Op[] = [{ op: "update_node", id: "api", label: "API v2" }];
    const post: PostOps = async (_id, ops, expected) =>
      expected === 4
        ? { ok: false, status: 409, code: "CONFLICT", error: "stale", board: agent }
        : { ok: true, board: { ...applyOps(agent, ops), revision: 6 } };
    const result = await submitOps("x", rename, r.revision, post);
    if (!result.ok) throw new Error("expected success");
    const entry = entryFor(r, result);
    expect(entry.before.revision).toBe(5);
    const undo = diffOps(entry.after, entry.before);
    expect(undo).toEqual([{ op: "update_node", id: "api", label: FIXTURES.architecture.nodes.find((n) => n.id === "api")!.label }]);
    expect(undo).not.toContainEqual({ op: "remove_node", id: "x" });
    // Without a re-apply, the board the user saw is the base.
    expect(entryFor(r, { board: rev(5) }).before).toBe(r);
  });
});

describe("createQueue", () => {
  it("runs jobs one at a time in order, and a failing job doesn't stop the next", async () => {
    const q = createQueue();
    const log: string[] = [];
    const job = (name: string, ms: number, fail = false) => async () => {
      log.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`end ${name}`);
      if (fail) throw new Error(name);
      return name;
    };
    const a = q.run(job("a", 20));
    const b = q.run(job("b", 1, true));
    const c = q.run(job("c", 1));
    await expect(a).resolves.toBe("a");
    await expect(b).rejects.toThrow("b");
    await expect(c).resolves.toBe("c");
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
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
    const result = await submitOps("x", ops, 1, post);
    expect(result).toMatchObject({ ok: true });
    expect(result).not.toHaveProperty("base");
    expect(calls).toEqual([1]);
  });

  it("re-applies once on a conflict, against the latest revision", async () => {
    const { post, calls } = fakePost([
      { ok: false, status: 409, code: "CONFLICT", error: "stale", board: rev(5) },
      { ok: true, board: rev(6) },
    ]);
    expect(await submitOps("x", ops, 1, post)).toMatchObject({ ok: true, board: { revision: 6 }, base: { revision: 5 } });
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

describe("editErrorMessage", () => {
  it("explains a lost conflict in the user's terms, and passes other errors through", () => {
    expect(editErrorMessage({ code: "CONFLICT", error: "Board changed (revision 5, expected 4)." })).toBe(
      "Someone else changed the board at the same time and your edit couldn't be re-applied. Try again.",
    );
    expect(editErrorMessage({ code: "VALIDATION", error: "Op #0 failed" })).toBe("Op #0 failed");
  });
});
