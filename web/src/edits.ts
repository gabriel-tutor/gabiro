import { KIND_RULES, slugify, type Board, type BoardEdge, type BoardGroup, type BoardNode, type Op, type Position } from "../../src/core/index.js";
import { nodeSize } from "../../src/layout/sizes.js";

/**
 * Pure helpers that turn canvas gestures into board ops. The server applies them through the same
 * core `applyOps` the agent uses, so the same validation rules apply whoever edits.
 */

/** Kanban lane geometry; matches the layout (src/layout/layout.ts) and toFlow's column boxes. */
const KANBAN_STRIDE = 280;

/** `base` if unused on the board, else `base-2`, `base-3`, … (ids are shared by nodes and groups). */
export function uniqueId(board: Board, base: string): string {
  const taken = new Set([...board.nodes.map((n) => n.id), ...board.groups.map((g) => g.id)]);
  const root = base.slice(0, 60);
  if (!taken.has(root)) return root;
  let n = 2;
  while (taken.has(`${root}-${n}`)) n++;
  return `${root}-${n}`;
}

const DEFAULT_LABELS: Record<string, string> = {
  database: "Database",
  queue: "Queue",
  external: "External system",
  decision: "Decision?",
  io: "Input / output",
  subprocess: "Subprocess",
  entity: "Entity",
  sticky: "Note",
  text: "Text",
};
const labelFor = (type: string) => DEFAULT_LABELS[type] ?? `New ${type}`;
const maxOrder = (items: { order?: number }[]) => Math.max(0, ...items.map((i) => i.order ?? 0));

const CASCADE = 40;

/** `position`, or the first spot down and to the right of it where a node of `size` overlaps nothing. */
export function freeSpot(board: Board, position: Position, size: { width: number; height: number }): Position {
  const overlaps = (p: Position) =>
    board.nodes.some((n) => {
      if (!n.position) return false;
      const s = nodeSize(n);
      return p.x < n.position.x + s.width && n.position.x < p.x + size.width && p.y < n.position.y + s.height && n.position.y < p.y + size.height;
    });
  let spot = { x: Math.round(position.x), y: Math.round(position.y) };
  for (let i = 0; i < 50 && overlaps(spot); i++) spot = { x: spot.x + CASCADE, y: spot.y + CASCADE };
  return spot;
}

/** Ops to add a node of `type` from the palette, centred on `position` (or the nearest free spot). */
export function addNodeOps(board: Board, type: string, position: Position): Op[] {
  const label = labelFor(type);
  const node: Op & { op: "add_node" } = { op: "add_node", id: uniqueId(board, slugify(label)), type: type as BoardNode["type"], label };
  if (board.kind === "kanban" && type === "card") {
    const column = board.groups[0];
    if (!column) return [];
    node.groupId = column.id;
    node.order = maxOrder(board.nodes.filter((n) => n.groupId === column.id)) + 1;
  } else if (board.kind === "sequence" && type === "participant") {
    node.order = maxOrder(board.nodes.filter((n) => n.type === "participant")) + 1;
  }
  if (type === "entity") node.fields = [{ name: "id", type: "uuid", pk: true }];
  if (node.order === undefined) {
    const size = nodeSize(node as BoardNode);
    node.position = freeSpot(board, { x: position.x - size.width / 2, y: position.y - size.height / 2 }, size);
  }
  return [node];
}

/** Ops to connect two nodes with the board kind's default edge type; [] when the kind has no edges. */
export function connectOps(board: Board, from: string, to: string): Op[] {
  const type = KIND_RULES[board.kind].edgeTypes[0];
  if (!type) return [];
  const edge: Op & { op: "add_edge" } = { op: "add_edge", from, to, type: type as BoardEdge["type"] };
  if (board.kind === "sequence") edge.order = maxOrder(board.edges) + 1;
  if (board.kind === "erd") edge.cardinality = "1-n";
  return [edge];
}

/** Renumbers `ids` as 1, 2, 3… and returns update ops for the ones whose order changed. */
function reorder(board: Board, ids: string[]): Op[] {
  return ids.flatMap((id, i) => {
    const node = board.nodes.find((n) => n.id === id);
    return node && node.order !== i + 1 ? [{ op: "update_node" as const, id, order: i + 1 }] : [];
  });
}

/**
 * Ops for a node the user dropped at `position`:
 * - kanban cards move to the column under them and take their slot by height;
 * - sequence participants take their slot by horizontal position;
 * - everything else stays exactly where it was dropped (position + pinned).
 */
export function moveOps(board: Board, nodeId: string, position: Position): Op[] {
  const node = board.nodes.find((n) => n.id === nodeId);
  if (!node) return [];
  if (board.kind === "kanban" && node.type === "card" && board.groups.length) {
    const index = Math.min(board.groups.length - 1, Math.max(0, Math.floor((position.x + 120) / KANBAN_STRIDE)));
    const column = board.groups[index]!;
    const ops: Op[] = column.id !== node.groupId ? [{ op: "update_node", id: nodeId, groupId: column.id }] : [];
    const cards = board.nodes
      .filter((n) => n.groupId === column.id && n.id !== nodeId)
      .sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0));
    const slot = cards.filter((c) => (c.position?.y ?? 0) < position.y).length;
    const ids = cards.map((c) => c.id);
    ids.splice(slot, 0, nodeId);
    const moved = { ...board, nodes: board.nodes.map((n) => (n.id === nodeId ? { ...n, groupId: column.id } : n)) };
    // Close the gap in the column the card left.
    const left = node.groupId !== column.id
      ? board.nodes
          .filter((n) => n.groupId === node.groupId && n.id !== nodeId)
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.position?.y ?? 0) - (b.position?.y ?? 0))
          .map((n) => n.id)
      : [];
    return [...ops, ...reorder(moved, ids), ...reorder(moved, left)];
  }
  if (board.kind === "sequence" && node.type === "participant") {
    const others = board.nodes
      .filter((n) => n.type === "participant" && n.id !== nodeId)
      .sort((a, b) => (a.position?.x ?? 0) - (b.position?.x ?? 0));
    const ids = others.map((n) => n.id);
    ids.splice(others.filter((n) => (n.position?.x ?? 0) < position.x).length, 0, nodeId);
    return reorder(board, ids);
  }
  return [{ op: "update_node", id: nodeId, position: { x: Math.round(position.x), y: Math.round(position.y) }, pinned: true }];
}

/** Ops to delete nodes (their edges go with them) and edges. */
export function deleteOps(board: Board, nodeIds: string[], edgeIds: string[]): Op[] {
  const nodes = new Set(nodeIds.filter((id) => board.nodes.some((n) => n.id === id)));
  const edges = edgeIds.filter((id) => {
    const e = board.edges.find((x) => x.id === id);
    return e && !nodes.has(e.from) && !nodes.has(e.to);
  });
  return [...edges.map((id) => ({ op: "remove_edge" as const, id })), ...[...nodes].map((id) => ({ op: "remove_node" as const, id }))];
}

const NODE_PATCH_KEYS = ["type", "label", "description", "tech", "groupId", "tags", "color", "position", "pinned", "order", "fields"] as const;
const EDGE_PATCH_KEYS = ["type", "label", "order", "style", "cardinality"] as const;
const GROUP_PATCH_KEYS = ["label", "type", "parentId"] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Patch that turns `from` into `to` for the given keys; keys absent in `to` become null (cleared). */
function patch(from: object, to: object, keys: readonly string[]): Record<string, unknown> {
  const f = from as Record<string, unknown>;
  const t = to as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (same(f[key], t[key])) continue;
    out[key] = t[key] === undefined ? null : t[key];
  }
  return out;
}

const withoutPoints = ({ points: _p, ...edge }: BoardEdge) => edge;

/**
 * Ops that turn board `from` into board `to` (nodes, edges and groups; layout routes ignored).
 * Undo is `diffOps(after, before)`, redo is `diffOps(before, after)`.
 */
export function diffOps(from: Board, to: Board): Op[] {
  const byId = <T extends { id: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, x]));
  const [fromNodes, toNodes] = [byId(from.nodes), byId(to.nodes)];
  const [fromEdges, toEdges] = [byId(from.edges), byId(to.edges)];
  const [fromGroups, toGroups] = [byId(from.groups), byId(to.groups)];
  const ops: Op[] = [];

  const removedNodes = from.nodes.filter((n) => !toNodes.has(n.id)).map((n) => n.id);
  const gone = new Set(removedNodes);
  for (const e of from.edges) if (!toEdges.has(e.id) && !gone.has(e.from) && !gone.has(e.to)) ops.push({ op: "remove_edge", id: e.id });
  for (const id of removedNodes) ops.push({ op: "remove_node", id });

  const addedGroups: BoardGroup[] = to.groups.filter((g) => !fromGroups.has(g.id));
  for (const g of addedGroups) ops.push({ op: "add_group", ...g, parentId: undefined });
  for (const g of addedGroups) if (g.parentId) ops.push({ op: "update_group", id: g.id, parentId: g.parentId });
  for (const n of to.nodes) if (!fromNodes.has(n.id)) ops.push({ op: "add_node", ...n });
  for (const e of to.edges) if (!fromEdges.has(e.id)) ops.push({ op: "add_edge", ...withoutPoints(e) });

  for (const n of to.nodes) {
    const prev = fromNodes.get(n.id);
    const changes = prev ? patch(prev, n, NODE_PATCH_KEYS) : {};
    if (Object.keys(changes).length) ops.push({ op: "update_node", id: n.id, ...changes } as Op);
  }
  for (const e of to.edges) {
    const prev = fromEdges.get(e.id);
    const changes = prev ? patch(prev, e, EDGE_PATCH_KEYS) : {};
    if (Object.keys(changes).length) ops.push({ op: "update_edge", id: e.id, ...changes } as Op);
  }
  for (const g of to.groups) {
    const prev = fromGroups.get(g.id);
    const changes = prev ? patch(prev, g, GROUP_PATCH_KEYS) : {};
    if (Object.keys(changes).length) ops.push({ op: "update_group", id: g.id, ...changes } as Op);
  }
  for (const g of from.groups) if (!toGroups.has(g.id)) ops.push({ op: "remove_group", id: g.id, cascade: true });
  return ops;
}
