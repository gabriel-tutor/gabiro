import { z } from "zod";
import { GabiroError } from "./errors.js";
import { EdgeSchema, GroupSchema, NodeSchema, SlugSchema, type Board } from "./schema.js";
import { validateBoard } from "./validate.js";

/** Optional node fields that an update may clear by sending null. */
const nullable = <T extends z.ZodType>(s: T) => s.nullable().optional();

const NodePatch = z.object({
  type: NodeSchema.shape.type.optional(),
  label: NodeSchema.shape.label.optional(),
  description: nullable(z.string().max(2000)),
  tech: nullable(z.string().max(100)),
  groupId: nullable(SlugSchema),
  tags: nullable(z.array(z.string())),
  color: nullable(z.string()),
  position: nullable(NodeSchema.shape.position.unwrap()),
  pinned: z.boolean().optional(),
  order: nullable(z.number().int()),
  fields: nullable(NodeSchema.shape.fields.unwrap()),
});

const EdgePatch = z.object({
  type: EdgeSchema.shape.type.optional(),
  label: nullable(z.string().max(200)),
  order: nullable(z.number().int()),
  style: nullable(EdgeSchema.shape.style.unwrap()),
  cardinality: nullable(EdgeSchema.shape.cardinality.unwrap()),
});

const GroupPatch = z.object({
  label: GroupSchema.shape.label.optional(),
  type: GroupSchema.shape.type.optional(),
  parentId: nullable(SlugSchema),
});

export const OpSchema = z.discriminatedUnion("op", [
  NodeSchema.extend({ op: z.literal("add_node") }).strict(),
  NodePatch.extend({ op: z.literal("update_node"), id: SlugSchema }).strict(),
  z.object({ op: z.literal("remove_node"), id: SlugSchema }).strict(),
  EdgeSchema.extend({ op: z.literal("add_edge"), id: EdgeSchema.shape.id.optional() }).strict(),
  EdgePatch.extend({ op: z.literal("update_edge"), id: EdgeSchema.shape.id }).strict(),
  z.object({ op: z.literal("remove_edge"), id: EdgeSchema.shape.id }).strict(),
  GroupSchema.extend({ op: z.literal("add_group") }).strict(),
  GroupPatch.extend({ op: z.literal("update_group"), id: SlugSchema }).strict(),
  z.object({ op: z.literal("remove_group"), id: SlugSchema, cascade: z.boolean().optional() }).strict(),
]);
export type Op = z.infer<typeof OpSchema>;

/** Copies patch keys onto target; a null value deletes the key. */
function patch<T extends object>(target: T, changes: Record<string, unknown>): void {
  const t = target as Record<string, unknown>;
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    if (value === null) delete t[key];
    else t[key] = value;
  }
}

function notFound(what: string, id: string, existing: string[]): never {
  const known = existing.length ? existing.join(", ") : "(none)";
  throw new GabiroError("NOT_FOUND", `No ${what} with id "${id}". Existing ${what}s: ${known}.`);
}

function defaultEdgeId(board: Board, from: string, to: string): string {
  const base = `${from}->${to}`;
  const taken = new Set(board.edges.map((e) => e.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}#${n}`)) n++;
  return `${base}#${n}`;
}

function applyOne(board: Board, op: Op): void {
  switch (op.op) {
    case "add_node": {
      const { op: _, ...node } = op;
      board.nodes.push(node);
      return;
    }
    case "update_node": {
      const { op: _, id, ...changes } = op;
      const node = board.nodes.find((n) => n.id === id) ?? notFound("node", id, board.nodes.map((n) => n.id));
      patch(node, changes);
      return;
    }
    case "remove_node": {
      if (!board.nodes.some((n) => n.id === op.id)) notFound("node", op.id, board.nodes.map((n) => n.id));
      board.nodes = board.nodes.filter((n) => n.id !== op.id);
      board.edges = board.edges.filter((e) => e.from !== op.id && e.to !== op.id);
      return;
    }
    case "add_edge": {
      const { op: _, id, ...edge } = op;
      board.edges.push({ id: id ?? defaultEdgeId(board, edge.from, edge.to), ...edge });
      return;
    }
    case "update_edge": {
      const { op: _, id, ...changes } = op;
      const edge = board.edges.find((e) => e.id === id) ?? notFound("edge", id, board.edges.map((e) => e.id));
      patch(edge, changes);
      return;
    }
    case "remove_edge": {
      if (!board.edges.some((e) => e.id === op.id)) notFound("edge", op.id, board.edges.map((e) => e.id));
      board.edges = board.edges.filter((e) => e.id !== op.id);
      return;
    }
    case "add_group": {
      const { op: _, ...group } = op;
      board.groups.push(group);
      return;
    }
    case "update_group": {
      const { op: _, id, ...changes } = op;
      const group = board.groups.find((g) => g.id === id) ?? notFound("group", id, board.groups.map((g) => g.id));
      patch(group, changes);
      return;
    }
    case "remove_group": {
      if (!board.groups.some((g) => g.id === op.id)) notFound("group", op.id, board.groups.map((g) => g.id));
      const childNodes = board.nodes.filter((n) => n.groupId === op.id);
      const childGroups = board.groups.filter((g) => g.parentId === op.id);
      if ((childNodes.length || childGroups.length) && !op.cascade) {
        const children = [...childNodes, ...childGroups].map((c) => c.id).join(", ");
        throw new GabiroError(
          "VALIDATION",
          `Group "${op.id}" still contains: ${children}. Move them out first, or pass cascade: true to ungroup them.`,
        );
      }
      for (const n of childNodes) delete n.groupId;
      for (const g of childGroups) delete g.parentId;
      board.groups = board.groups.filter((g) => g.id !== op.id);
      return;
    }
  }
}

/**
 * Applies ops in order to a copy of the board and returns the new board.
 * All-or-nothing: the first invalid op throws, naming its index, and the input board is untouched.
 */
export function applyOps(board: Board, rawOps: unknown[]): Board {
  let draft = structuredClone(board);
  rawOps.forEach((raw, index) => {
    const label = `Op #${index}`;
    const parsed = OpSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      const at = issue.path.length ? ` at "${issue.path.join(".")}"` : "";
      throw new GabiroError("VALIDATION", `${label} is malformed${at}: ${issue.message}. Nothing was changed.`);
    }
    try {
      applyOne(draft, parsed.data);
      draft = validateBoard(draft);
    } catch (err) {
      if (err instanceof GabiroError) {
        throw new GabiroError(err.code, `${label} (${parsed.data.op}) failed: ${err.message} Nothing was changed.`);
      }
      throw err;
    }
  });
  return draft;
}
