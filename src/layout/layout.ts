import { createRequire } from "node:module";
import type { ELK, ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api.js";
import type { Board, BoardNode, Position } from "../core/index.js";
import { nodeSize } from "./sizes.js";

/**
 * - "auto":  if any node lacks a position, re-place every unpinned node; otherwise change nothing.
 * - "all":   re-place every unpinned node.
 * - "force": re-place every node and clear `pinned`.
 */
export type LayoutMode = "auto" | "all" | "force";

// elkjs is CommonJS; createRequire sidesteps default-export interop differences between tsc and Node.
const ElkConstructor = createRequire(import.meta.url)("elkjs/lib/elk.bundled.js") as new () => ELK;
const elk = new ElkConstructor();
const GAP = 40;

/** Returns a copy of the board with positions filled in according to `mode`. Deterministic. */
export async function layoutBoard(board: Board, mode: LayoutMode = "auto"): Promise<Board> {
  const next = structuredClone(board);
  if (mode === "force") for (const n of next.nodes) delete n.pinned;
  if (mode === "auto" && next.nodes.every((n) => n.position)) return next;

  const movable = (n: BoardNode) => !n.pinned;
  let placed: Map<string, Position>;
  switch (next.kind) {
    case "freeform":
      placed = freeformPositions(next);
      break;
    case "sequence":
      placed = sequencePositions(next);
      break;
    case "kanban":
      placed = kanbanPositions(next);
      break;
    default:
      placed = await elkPositions(next);
  }
  for (const n of next.nodes) {
    const p = placed.get(n.id);
    if (p && (movable(n) || !n.position)) n.position = p;
  }
  return next;
}

const round = (p: Position): Position => ({ x: Math.round(p.x), y: Math.round(p.y) });
const byOrder = (a: BoardNode, b: BoardNode) =>
  (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || (a.id < b.id ? -1 : 1);

/** Freeform never rearranges: only nodes without a position get a grid slot right of existing content. */
function freeformPositions(board: Board): Map<string, Position> {
  const out = new Map<string, Position>();
  const positioned = board.nodes.filter((n) => n.position);
  let x = positioned.length ? Math.max(...positioned.map((n) => n.position!.x + nodeSize(n).width)) + GAP * 2 : 0;
  let y = 0;
  let row = 0;
  for (const n of board.nodes.filter((m) => !m.position)) {
    out.set(n.id, { x, y });
    y += nodeSize(n).height + GAP;
    if (++row === 4) {
      row = 0;
      y = 0;
      x += 200 + GAP;
    }
  }
  return out;
}

/** Participants in a row, ordered by `order`. Messages are drawn by the canvas between lifelines. */
function sequencePositions(board: Board): Map<string, Position> {
  const out = new Map<string, Position>();
  board.nodes
    .filter((n) => n.type === "participant")
    .sort(byOrder)
    .forEach((n, i) => out.set(n.id, { x: i * 220, y: 0 }));
  const stickies = board.nodes.filter((n) => n.type === "sticky");
  stickies.forEach((n, i) => out.set(n.id, { x: i * 200, y: -180 }));
  return out;
}

/** Columns left to right in group order; cards stacked by `order`. */
function kanbanPositions(board: Board): Map<string, Position> {
  const out = new Map<string, Position>();
  board.groups.forEach((col, i) => {
    let y = 60;
    for (const card of board.nodes.filter((n) => n.groupId === col.id).sort(byOrder)) {
      out.set(card.id, { x: i * 280 + 20, y });
      y += nodeSize(card).height + 16;
    }
  });
  const loose = board.nodes.filter((n) => n.groupId === undefined);
  loose.forEach((n, i) => out.set(n.id, { x: board.groups.length * 280 + 20, y: 60 + i * 140 }));
  return out;
}

async function elkPositions(board: Board): Promise<Map<string, Position>> {
  const direction = board.layout.direction === "LR" ? "RIGHT" : "DOWN";
  const sorted = [...board.nodes].sort((a, b) => (a.id < b.id ? -1 : 1));

  const toElkNode = (n: BoardNode): ElkNode => ({ id: n.id, ...nodeSize(n) });
  const buildGroup = (groupId: string | undefined): ElkNode[] => [
    ...board.groups
      .filter((g) => g.parentId === groupId)
      .map((g) => ({
        id: `group:${g.id}`,
        layoutOptions: { "elk.padding": "[top=48,left=24,bottom=24,right=24]" },
        children: buildGroup(g.id),
      })),
    ...sorted.filter((n) => n.groupId === groupId).map(toElkNode),
  ];

  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": board.kind === "mindmap" ? "mrtree" : "layered",
      "elk.direction": direction,
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.spacing.nodeNode": "50",
      "elk.layered.spacing.nodeNodeBetweenLayers": "80",
      "elk.spacing.componentComponent": "80",
    },
    children: buildGroup(undefined),
    edges: board.edges.map((e): ElkExtendedEdge => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  };

  const result = await elk.layout(graph);
  const out = new Map<string, Position>();
  const walk = (node: ElkNode, offset: Position) => {
    for (const child of node.children ?? []) {
      const abs = { x: offset.x + (child.x ?? 0), y: offset.y + (child.y ?? 0) };
      if (!child.id.startsWith("group:")) out.set(child.id, round(abs));
      walk(child, abs);
    }
  };
  walk(result, { x: 0, y: 0 });
  return out;
}
