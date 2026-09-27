import type { Edge, Node } from "@xyflow/react";
import { KIND_RULES, type Board, type BoardEdge, type BoardGroup, type BoardNode, type Position } from "../../src/core/index.js";
import { nodeSize } from "../../src/layout/sizes.js";

/** Vertical distance between sequence messages, and the space above the first one. */
export const MESSAGE_GAP = 50;
const HEADER = 60;
const GROUP_PAD = 24;
const GROUP_LABEL = 32;
const KANBAN_COLUMN = { stride: 280, inset: 10, width: 260, minHeight: 200 };

export interface ShapeData extends Record<string, unknown> {
  node: BoardNode;
  kind: Board["kind"];
  direction: Board["layout"]["direction"];
  changed: boolean;
  /** Whether the user can draw edges from this node's handles. */
  connectable: boolean;
}
export interface GroupData extends Record<string, unknown> {
  group: BoardGroup;
}
export interface MessageData extends Record<string, unknown> {
  y: number;
  label: string;
  dashed: boolean;
  changed: boolean;
}

export interface RoutedData extends Record<string, unknown> {
  points: Position[];
}

export interface Flow {
  nodes: Node[];
  edges: Edge[];
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const rectOf = (n: BoardNode): Rect => ({ ...(n.position ?? { x: 0, y: 0 }), ...nodeSize(n) });

function union(rects: Rect[]): Rect | undefined {
  if (!rects.length) return undefined;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** Rectangles for groups: kanban columns sit in fixed lanes; other groups wrap their contents. */
function groupRects(board: Board): Map<string, Rect> {
  const rects = new Map<string, Rect>();
  if (board.kind === "kanban") {
    board.groups.forEach((col, i) => {
      const cards = board.nodes.filter((n) => n.groupId === col.id).map(rectOf);
      const bottom = Math.max(KANBAN_COLUMN.minHeight, ...cards.map((r) => r.y + r.height + GROUP_PAD));
      rects.set(col.id, { x: i * KANBAN_COLUMN.stride + KANBAN_COLUMN.inset, y: 0, width: KANBAN_COLUMN.width, height: bottom });
    });
    return rects;
  }
  const visit = (g: BoardGroup): Rect | undefined => {
    if (rects.has(g.id)) return rects.get(g.id);
    const inner = union([
      ...board.nodes.filter((n) => n.groupId === g.id).map(rectOf),
      ...board.groups.filter((c) => c.parentId === g.id).map(visit).filter((r): r is Rect => !!r),
    ]);
    if (!inner) return undefined;
    const rect = {
      x: inner.x - GROUP_PAD,
      y: inner.y - GROUP_PAD - GROUP_LABEL,
      width: inner.width + GROUP_PAD * 2,
      height: inner.height + GROUP_PAD * 2 + GROUP_LABEL,
    };
    rects.set(g.id, rect);
    return rect;
  };
  board.groups.forEach(visit);
  return rects;
}

function depth(board: Board, g: BoardGroup): number {
  let d = 0;
  for (let p = g.parentId; p; p = board.groups.find((x) => x.id === p)?.parentId) d++;
  return d;
}

const within = (p: Position, r: Rect, slack = 2) =>
  p.x >= r.x - slack && p.x <= r.x + r.width + slack && p.y >= r.y - slack && p.y <= r.y + r.height + slack;

/** The layout's route, if it still starts on the source box and ends on the target box. */
function usableRoute(e: BoardEdge, rects: Map<string, Rect>): Position[] | undefined {
  const [first, last] = [e.points?.[0], e.points?.at(-1)];
  const [from, to] = [rects.get(e.from), rects.get(e.to)];
  return first && last && from && to && within(first, from) && within(last, to) ? e.points : undefined;
}

const byOrder = (a: BoardEdge, b: BoardEdge) => (a.order ?? 0) - (b.order ?? 0) || (a.id < b.id ? -1 : 1);

function isDashed(e: BoardEdge): boolean {
  return e.style === "dashed" || (e.style === undefined && e.type === "async");
}

function edgeLabel(e: BoardEdge): string | undefined {
  if (e.cardinality) {
    const card = e.cardinality.replace("-", ":");
    return e.label ? `${e.label} (${card})` : card;
  }
  return e.label;
}

/**
 * Converts a board into React Flow nodes and edges. Pure: positions come from the board
 * (already laid out by the server), sizes from the shared nodeSize table.
 * `changed` marks ids to highlight because they changed in the latest update.
 */
export interface FlowOptions {
  /** Editable canvas: nodes can be dragged, selected, connected and deleted. Default false (read-only). */
  editable?: boolean;
}

export function toFlow(board: Board, changed: ReadonlySet<string> = new Set(), options: FlowOptions = {}): Flow {
  const editable = options.editable ?? false;
  const connectable = editable && KIND_RULES[board.kind].edgeTypes.length > 0;
  const messages = board.kind === "sequence" ? board.edges.filter((e) => e.type === "message").sort(byOrder) : [];
  const lifeline = HEADER + (messages.length + 1) * MESSAGE_GAP;

  const groups: Node[] = [];
  const rects = groupRects(board);
  for (const g of board.groups) {
    const r = rects.get(g.id);
    if (!r) continue;
    groups.push({
      id: `group:${g.id}`,
      type: "group-box",
      position: { x: r.x, y: r.y },
      width: r.width,
      height: r.height,
      data: { group: g } satisfies GroupData,
      zIndex: depth(board, g),
      draggable: false,
      selectable: false,
      deletable: false,
    });
  }

  const nodes: Node[] = board.nodes.map((n) => {
    const size = nodeSize(n);
    const type = n.type === "entity" ? "entity" : n.type === "participant" ? "participant" : "shape";
    return {
      id: n.id,
      type,
      position: n.position ?? { x: 0, y: 0 },
      width: size.width,
      height: n.type === "participant" ? lifeline : size.height,
      data: { node: n, kind: board.kind, direction: board.layout.direction, changed: changed.has(n.id), connectable } satisfies ShapeData,
      zIndex: 100,
      draggable: editable,
      selectable: editable,
      deletable: editable,
    };
  });

  const nodeRects = new Map(board.nodes.map((n) => [n.id, rectOf(n)]));
  const edges: Edge[] =
    board.kind === "sequence"
      ? messages.map((e, i) => ({
          id: e.id,
          source: e.from,
          target: e.to,
          type: "message",
          data: { y: HEADER + (i + 1) * MESSAGE_GAP, label: e.label ?? "", dashed: isDashed(e), changed: changed.has(e.id) } satisfies MessageData,
          zIndex: 200,
          selectable: editable,
          deletable: editable,
        }))
      : board.edges.map((e) => {
          const route = usableRoute(e, nodeRects);
          return {
          id: e.id,
          source: e.from,
          target: e.to,
          type: route ? "routed" : board.kind === "mindmap" ? "default" : "smoothstep",
          ...(route ? { data: { points: route } satisfies RoutedData } : {}),
          label: edgeLabel(e),
          animated: e.type === "async",
          className: changed.has(e.id) ? "gb-flash" : undefined,
          style: isDashed(e) ? { strokeDasharray: "6 4" } : undefined,
          markerEnd: board.kind === "mindmap" || board.kind === "erd" ? undefined : { type: "arrowclosed" as const },
          zIndex: 200,
          selectable: editable,
          deletable: editable,
          };
        });

  return { nodes: [...groups, ...nodes], edges };
}

/** JSON of an entity without layout-only fields, so a re-layout alone doesn't count as a change. */
function meaning(entity: object): string {
  const { position: _p, pinned: _pin, points: _pts, ...rest } = entity as Record<string, unknown>;
  return JSON.stringify(rest);
}

/** Ids of nodes and edges whose content differs between two revisions of a board (layout moves ignored). */
export function changedIds(before: Board | undefined, after: Board): Set<string> {
  const out = new Set<string>();
  if (!before) return out;
  const prevNodes = new Map(before.nodes.map((n) => [n.id, meaning(n)]));
  const prevEdges = new Map(before.edges.map((e) => [e.id, meaning(e)]));
  for (const n of after.nodes) if (prevNodes.get(n.id) !== meaning(n)) out.add(n.id);
  for (const e of after.edges) if (prevEdges.get(e.id) !== meaning(e)) out.add(e.id);
  return out;
}
