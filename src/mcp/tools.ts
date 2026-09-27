import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GabiroError, KINDS, SlugSchema, summarizeBoard, type Board } from "../core/index.js";
import { canvasUrl, openCanvas, type OpenCanvasResult } from "../server/launcher.js";
import type { BoardService } from "../service/index.js";
import { OPS_HELP } from "./help.js";

/** How the tools reach the canvas. Injected so tests don't spawn servers or browsers. */
export interface CanvasAccess {
  /** URL of the running canvas (for a board), or undefined if none is running. */
  url(root: string, boardId?: string): Promise<string | undefined>;
  /** Shows the canvas (for a board) in the Gabiro app or the browser, starting a server if needed. */
  show(root: string, boardId?: string): Promise<OpenCanvasResult>;
}

export const defaultCanvas: CanvasAccess = {
  url: canvasUrl,
  show: (root, boardId) => openCanvas(root, boardId),
};

/** What gabiro_open_board tells the agent about where the canvas opened. */
function openedText({ url, via, appTimedOut }: OpenCanvasResult): string {
  const fallback = appTimedOut ? " (The Gabiro app didn't show it within 8 seconds.)" : "";
  if (via === "app") return `Opened ${url} in the Gabiro app.`;
  if (via === "browser") return `Opened ${url} in the browser.${fallback}`;
  return `The canvas is running at ${url} — open it in a browser.${fallback}`;
}

type Payload = { text: string; data: Record<string, unknown> };

/** Runs a tool body; expected errors become isError results the agent can act on. */
async function run(body: () => Promise<Payload>): Promise<CallToolResult> {
  try {
    const { text, data } = await body();
    return { content: [{ type: "text", text }], structuredContent: data };
  } catch (err) {
    const message = err instanceof GabiroError ? err.message : `Unexpected error: ${(err as Error).message ?? String(err)}`;
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

const counts = (b: Board) => ({ nodes: b.nodes.length, edges: b.edges.length, groups: b.groups.length });

function changeReport(board: Board, before?: Board): Payload {
  const after = counts(board);
  let text = `Board "${board.id}" is at revision ${board.revision}: ${after.nodes} nodes, ${after.edges} edges, ${after.groups} groups.`;
  if (before) {
    const prev = counts(before);
    const delta = (["nodes", "edges", "groups"] as const)
      .map((k) => ({ k, d: after[k] - prev[k] }))
      .filter(({ d }) => d !== 0)
      .map(({ k, d }) => `${d > 0 ? "+" : ""}${d} ${k}`);
    if (delta.length) text += ` Change: ${delta.join(", ")}.`;
  }
  return { text, data: { boardId: board.id, revision: board.revision, ...after } };
}

/** Appends a non-fatal auto-export warning to a payload, when there is one. */
function withExportWarning(payload: Payload, exportWarning?: string): Payload {
  if (!exportWarning) return payload;
  return {
    text: `${payload.text} Saved, but auto-export failed: ${exportWarning}`,
    data: { ...payload.data, exportWarning },
  };
}

/** Adds the live canvas link for a board when the canvas server is running. */
async function withCanvasUrl(payload: Payload, url: string | undefined): Promise<Payload> {
  if (!url) return payload;
  return { text: `${payload.text}\nCanvas: ${url}`, data: { ...payload.data, canvasUrl: url } };
}

const opsParam = z.array(z.object({ op: z.string() }).passthrough()).describe(OPS_HELP);
const boardIdParam = SlugSchema.describe('Board id, e.g. "checkout-architecture" (see gabiro_list_boards)');

export function registerTools(server: McpServer, service: BoardService, canvas: CanvasAccess = defaultCanvas): void {
  server.registerTool(
    "gabiro_list_boards",
    {
      title: "List boards",
      description: "List all diagram boards in this project with id, title, kind, node count and last update.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      run(async () => {
        const boards = await service.list();
        const text = boards.length
          ? boards
              .map((b) => `${b.id} "${b.title}" kind=${b.kind} nodes=${b.nodeCount} updated=${b.updatedAt}${b.error ? ` ERROR: ${b.error}` : ""}`)
              .join("\n")
          : "No boards yet. Create one with gabiro_create_board.";
        return { text, data: { boards } };
      }),
  );

  server.registerTool(
    "gabiro_create_board",
    {
      title: "Create board",
      description:
        "Create a diagram board, optionally with its full content in one call via ops. Nodes are auto-laid out. " +
        "Kinds: architecture (services, databases, queues…), flowchart (steps/decisions), sequence (ordered messages), " +
        "erd (entities with fields), mindmap (topics), freeform (sticky notes), kanban (columns and cards).",
      inputSchema: {
        title: z.string().min(1).max(200).describe('Human title, e.g. "Checkout – Architecture"'),
        kind: z.enum(KINDS).describe("Diagram kind; decides which node/edge/group types are allowed"),
        id: SlugSchema.optional().describe("Board id; defaults to a slug of the title"),
        direction: z.enum(["LR", "TB"]).optional().describe("Layout direction: LR (left→right, default) or TB (top→bottom, default for flowchart)"),
        ops: opsParam.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ title, kind, id, direction, ops }) =>
      run(async () => {
        const result = await service.create({ title, kind, id, direction, ops });
        const report = await withCanvasUrl(changeReport(result.board), await canvas.url(service.root, result.board.id));
        return withExportWarning({ text: `${report.text}\n\n${summarizeBoard(result.board)}`, data: report.data }, result.exportWarning);
      }),
  );

  server.registerTool(
    "gabiro_get_board",
    {
      title: "Get board",
      description:
        'Read a board. format "summary" (default) is a compact one-line-per-item view; "json" is the full board including positions; "mermaid" is the diagram source.',
      inputSchema: {
        boardId: boardIdParam,
        format: z.enum(["summary", "json", "mermaid"]).default("summary"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ boardId, format }) =>
      run(async () => {
        if (format === "mermaid") {
          const { content } = await service.export(boardId, "mermaid");
          const board = await service.get(boardId);
          return { text: content, data: { boardId, revision: board.revision, format } };
        }
        const board = await service.get(boardId);
        if (format === "json") return { text: JSON.stringify(board, null, 2), data: { board } };
        return { text: summarizeBoard(board), data: { boardId, revision: board.revision, format } };
      }),
  );

  server.registerTool(
    "gabiro_apply_changes",
    {
      title: "Apply changes",
      description:
        "Add, update or remove nodes, edges and groups on a board in one atomic batch. On error nothing changes and the message names the failing op. New nodes are auto-laid out; nodes the user moved (pinned) stay put.",
      inputSchema: {
        boardId: boardIdParam,
        ops: opsParam,
        expectedRevision: z
          .number()
          .int()
          .optional()
          .describe("Revision you last saw. If the board changed since (e.g. the user edited it), the call fails instead of overwriting."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    ({ boardId, ops, expectedRevision }) =>
      run(async () => {
        const before = await service.get(boardId);
        const result = await service.applyChanges(boardId, ops, expectedRevision);
        const report = await withCanvasUrl(changeReport(result.board, before), await canvas.url(service.root, boardId));
        return withExportWarning(report, result.exportWarning);
      }),
  );

  server.registerTool(
    "gabiro_update_board",
    {
      title: "Update board",
      description: "Rename a board or change its layout direction (changing direction re-lays out unpinned nodes).",
      inputSchema: {
        boardId: boardIdParam,
        title: z.string().min(1).max(200).optional(),
        direction: z.enum(["LR", "TB"]).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ boardId, title, direction }) =>
      run(async () => {
        const result = await service.updateBoard(boardId, { title, direction });
        return withExportWarning(changeReport(result.board), result.exportWarning);
      }),
  );

  server.registerTool(
    "gabiro_auto_layout",
    {
      title: "Auto-layout",
      description: "Re-run automatic layout. Pinned nodes (moved by the user) keep their place unless force is true.",
      inputSchema: {
        boardId: boardIdParam,
        force: z.boolean().default(false).describe("Also move pinned nodes and unpin them"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ boardId, force }) =>
      run(async () => {
        const result = await service.autoLayout(boardId, force);
        return withExportWarning(changeReport(result.board), result.exportWarning);
      }),
  );

  server.registerTool(
    "gabiro_export",
    {
      title: "Export board",
      description:
        'Export a board as Mermaid or Markdown. With write=true the file is saved under the export dir (default docs/diagrams). Boards are also auto-exported to <exportDir>/<id>.md on every change unless disabled in .gabiro/config.json.',
      inputSchema: {
        boardId: boardIdParam,
        format: z.enum(["mermaid", "markdown"]),
        write: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ boardId, format, write }) =>
      run(async () => {
        const { content, path } = await service.export(boardId, format, write);
        return { text: path ? `Wrote ${path}\n\n${content}` : content, data: { boardId, format, ...(path ? { path } : {}) } };
      }),
  );

  server.registerTool(
    "gabiro_open_board",
    {
      title: "Open canvas",
      description:
        "Show a board (or the board list) in the live canvas: in the Gabiro Mac app when it is installed, otherwise in the browser. The canvas updates live as boards change. Starts a local server on 127.0.0.1 if none is running.",
      inputSchema: { boardId: boardIdParam.optional().describe("Board to show; omit for the list of boards") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ boardId }) =>
      run(async () => {
        if (boardId) await service.get(boardId);
        const result = await canvas.show(service.root, boardId);
        return {
          text: openedText(result),
          data: { url: result.url, opened: result.via !== "none", via: result.via, ...(result.appTimedOut ? { appTimedOut: true } : {}) },
        };
      }),
  );

  server.registerTool(
    "gabiro_delete_board",
    {
      title: "Delete board",
      description: "Delete a board and its auto-exported Markdown file. It remains recoverable from git history if committed.",
      inputSchema: { boardId: boardIdParam },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ boardId }) =>
      run(async () => {
        await service.delete(boardId);
        return { text: `Deleted board "${boardId}".`, data: { boardId, deleted: true } };
      }),
  );
}
