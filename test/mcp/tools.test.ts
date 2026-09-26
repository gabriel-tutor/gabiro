import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../../src/mcp/server.js";
import type { CanvasAccess } from "../../src/mcp/tools.js";
import { tempRoot } from "../helpers.js";

/** A canvas that is "not running" unless told otherwise, and records what it was asked to open. */
function fakeCanvas(running?: string) {
  const opened: string[] = [];
  const canvas: CanvasAccess = {
    url: async (_root, boardId) => (running ? (boardId ? `${running}/b/${boardId}` : running) : undefined),
    ensure: async () => running ?? "http://127.0.0.1:4477",
    open: (url) => (opened.push(url), true),
  };
  return { canvas, opened };
}

async function connect(canvas: CanvasAccess = fakeCanvas().canvas) {
  const root = await tempRoot();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(root, canvas).connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;
  return { client, call, text, root };
}

const CHECKOUT_OPS = [
  { op: "add_group", id: "backend", label: "Backend", type: "zone" },
  { op: "add_node", id: "web", type: "client", label: "Web App" },
  { op: "add_node", id: "api", type: "service", label: "Checkout API", groupId: "backend" },
  { op: "add_node", id: "db", type: "database", label: "Orders DB", tech: "Postgres", groupId: "backend" },
  { op: "add_edge", from: "web", to: "api", type: "sync", label: "HTTPS" },
  { op: "add_edge", from: "api", to: "db", type: "sync" },
];

describe("gabiro MCP server", () => {
  it("exposes the tools with annotations and server instructions", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "gabiro_apply_changes",
      "gabiro_auto_layout",
      "gabiro_create_board",
      "gabiro_delete_board",
      "gabiro_export",
      "gabiro_get_board",
      "gabiro_list_boards",
      "gabiro_open_board",
      "gabiro_update_board",
    ]);
    expect(tools.find((t) => t.name === "gabiro_get_board")!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "gabiro_delete_board")!.annotations?.destructiveHint).toBe(true);
    const open = tools.find((t) => t.name === "gabiro_open_board")!;
    expect(open.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(open.description).toMatch(/Starts a local server on 127\.0\.0\.1 if none is running\.$/);
    expect(tools.find((t) => t.name === "gabiro_create_board")!.inputSchema.properties).toHaveProperty("ops");
    expect(client.getInstructions()).toContain("gabiro_create_board");
  });

  it("builds a whole diagram in one call and reads it back", async () => {
    const { call, text } = await connect();
    const created = await call("gabiro_create_board", { title: "Checkout", kind: "architecture", ops: CHECKOUT_OPS });
    expect(created.isError).toBeFalsy();
    expect(created.structuredContent).toEqual({ boardId: "checkout", revision: 1, nodes: 3, edges: 2, groups: 1 });
    expect(text(created)).toContain('node db [database] "Orders DB" (Postgres) in backend');

    const summary = await call("gabiro_get_board", { boardId: "checkout" });
    expect(text(summary)).toMatch(/^board checkout "Checkout" kind=architecture/);

    const json = await call("gabiro_get_board", { boardId: "checkout", format: "json" });
    const board = (json.structuredContent as { board: { nodes: { position?: unknown }[] } }).board;
    expect(board.nodes.every((n) => n.position)).toBe(true);

    const mermaid = await call("gabiro_get_board", { boardId: "checkout", format: "mermaid" });
    expect(text(mermaid)).toContain("web -->|\"HTTPS\"| api");

    const list = await call("gabiro_list_boards");
    expect(text(list)).toMatch(/^checkout "Checkout" kind=architecture nodes=3/);
  });

  it("applies changes with a delta report and rejects stale revisions", async () => {
    const { call, text } = await connect();
    await call("gabiro_create_board", { title: "Checkout", kind: "architecture", ops: CHECKOUT_OPS });
    const changed = await call("gabiro_apply_changes", {
      boardId: "checkout",
      expectedRevision: 1,
      ops: [
        { op: "add_node", id: "cache", type: "cache", label: "Redis" },
        { op: "add_edge", from: "api", to: "cache", type: "sync" },
      ],
    });
    expect(text(changed)).toBe('Board "checkout" is at revision 2: 4 nodes, 3 edges, 1 groups. Change: +1 nodes, +1 edges.');

    const stale = await call("gabiro_apply_changes", { boardId: "checkout", expectedRevision: 1, ops: [] });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toMatch(/revision 2, you sent 1/);
  });

  it("returns actionable errors instead of throwing", async () => {
    const { call, text } = await connect();
    await call("gabiro_create_board", { title: "Flow", kind: "flowchart" });
    const bad = await call("gabiro_apply_changes", {
      boardId: "flow",
      ops: [{ op: "add_node", id: "db", type: "database", label: "DB" }],
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/Op #0 \(add_node\) failed: Node type "database" isn't valid on a flowchart board/);

    const missing = await call("gabiro_get_board", { boardId: "nope" });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/No board "nope". Existing boards: flow\./);
  });

  it("updates, re-lays out, exports and deletes", async () => {
    const { call, text } = await connect();
    await call("gabiro_create_board", { title: "Checkout", kind: "architecture", ops: CHECKOUT_OPS });
    expect((await call("gabiro_update_board", { boardId: "checkout", direction: "TB" })).structuredContent).toMatchObject({ revision: 2 });
    expect((await call("gabiro_auto_layout", { boardId: "checkout", force: true })).structuredContent).toMatchObject({ revision: 3 });

    const exported = await call("gabiro_export", { boardId: "checkout", format: "markdown", write: true });
    expect(text(exported)).toMatch(/^Wrote docs[/\\]diagrams[/\\]checkout\.md/);

    const deleted = await call("gabiro_delete_board", { boardId: "checkout" });
    expect(deleted.structuredContent).toEqual({ boardId: "checkout", deleted: true });
    expect(text(await call("gabiro_list_boards"))).toMatch(/No boards yet/);
  });

  it("opens the canvas for a board, starting it through the canvas access", async () => {
    const { canvas, opened } = fakeCanvas();
    const { call, text } = await connect(canvas);
    await call("gabiro_create_board", { title: "Checkout", kind: "architecture", ops: CHECKOUT_OPS });
    const r = await call("gabiro_open_board", { boardId: "checkout" });
    expect(r.structuredContent).toEqual({ url: "http://127.0.0.1:4477/b/checkout", opened: true });
    expect(text(r)).toBe("Opened http://127.0.0.1:4477/b/checkout in the browser.");
    expect(opened).toEqual(["http://127.0.0.1:4477/b/checkout"]);

    const missing = await call("gabiro_open_board", { boardId: "nope" });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/No board "nope"/);
  });

  it("links the live canvas in create/apply results only when it is running", async () => {
    const off = await connect();
    const quiet = await off.call("gabiro_create_board", { title: "Checkout", kind: "architecture", ops: CHECKOUT_OPS });
    expect(quiet.structuredContent).not.toHaveProperty("canvasUrl");

    const on = await connect(fakeCanvas("http://127.0.0.1:4480").canvas);
    const created = await on.call("gabiro_create_board", { title: "Checkout", kind: "architecture", ops: CHECKOUT_OPS });
    expect(created.structuredContent).toMatchObject({ canvasUrl: "http://127.0.0.1:4480/b/checkout" });
    expect(on.text(created)).toContain("Canvas: http://127.0.0.1:4480/b/checkout");
    const changed = await on.call("gabiro_apply_changes", {
      boardId: "checkout",
      ops: [{ op: "add_node", id: "cache", type: "cache", label: "Redis" }],
    });
    expect(changed.structuredContent).toMatchObject({ canvasUrl: "http://127.0.0.1:4480/b/checkout" });
  });
});
