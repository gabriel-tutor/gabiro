import { GabiroError } from "./errors.js";
import { KIND_RULES, kindsAllowingNodeType } from "./kinds.js";
import { BoardSchema, type Board } from "./schema.js";

const list = (xs: readonly string[]) => (xs.length ? xs.join(", ") : "(none)");

function fail(message: string): never {
  throw new GabiroError("VALIDATION", message);
}

function assertUnique(kind: string, ids: string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) fail(`Duplicate ${kind} id "${id}". Ids must be unique within a board; pick another id.`);
    seen.add(id);
  }
}

/** Parses the board shape and enforces every cross-reference and kind rule. Returns the parsed board. */
export function validateBoard(input: unknown): Board {
  const parsed = BoardSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    fail(`Invalid board at "${issue.path.join(".")}": ${issue.message}`);
  }
  const board = parsed.data;
  const rules = KIND_RULES[board.kind];

  assertUnique("node", board.nodes.map((n) => n.id));
  assertUnique("edge", board.edges.map((e) => e.id));
  assertUnique("group", board.groups.map((g) => g.id));

  const groupIds = new Set(board.groups.map((g) => g.id));
  const nodeIds = new Set(board.nodes.map((n) => n.id));

  for (const id of nodeIds) {
    if (groupIds.has(id)) {
      fail(`Id "${id}" is used by both a node and a group. Node and group ids share one namespace; rename one of them.`);
    }
  }

  for (const g of board.groups) {
    if (!rules.groupTypes.includes(g.type)) {
      fail(`Group type "${g.type}" isn't valid on a ${board.kind} board. Valid group types: ${list(rules.groupTypes)}.`);
    }
    if (g.parentId !== undefined && !groupIds.has(g.parentId)) {
      fail(`Group "${g.id}" has parentId "${g.parentId}", which doesn't exist. Add that group first or drop parentId.`);
    }
  }
  for (const g of board.groups) {
    const seen = new Set<string>([g.id]);
    let parent = g.parentId;
    while (parent !== undefined) {
      if (seen.has(parent)) fail(`Group "${g.id}" is part of a parentId cycle. A group can't contain itself.`);
      seen.add(parent);
      parent = board.groups.find((x) => x.id === parent)?.parentId;
    }
  }

  for (const n of board.nodes) {
    if (!rules.nodeTypes.includes(n.type)) {
      const other = kindsAllowingNodeType(n.type);
      const article = (w: string) => (/^[aeiou]/i.test(w) ? "an" : "a");
      const hint = other.length ? ` Did you mean ${other.map((k) => `${article(k)} ${k}`).join(" or ")} board?` : "";
      fail(`Node type "${n.type}" isn't valid on a ${board.kind} board. Valid node types: ${list(rules.nodeTypes)}.${hint}`);
    }
    if (n.groupId !== undefined && !groupIds.has(n.groupId)) {
      fail(`Node "${n.id}" has groupId "${n.groupId}", which doesn't exist. Add the group first or drop groupId.`);
    }
    if (n.fields !== undefined && n.type !== "entity") {
      fail(`Node "${n.id}" has fields, but only ERD "entity" nodes can have fields.`);
    }
    if (board.kind === "kanban" && n.type === "card" && n.groupId === undefined) {
      fail(`Kanban card "${n.id}" must be in a column. Set groupId to a column id (${list(board.groups.map((g) => g.id))}).`);
    }
  }

  for (const e of board.edges) {
    if (!rules.edgeTypes.includes(e.type)) {
      fail(`Edge type "${e.type}" isn't valid on a ${board.kind} board. Valid edge types: ${list(rules.edgeTypes)}.`);
    }
    for (const end of [e.from, e.to]) {
      if (!nodeIds.has(end)) {
        fail(`Edge "${e.id}" points at node "${end}", which doesn't exist. Existing nodes: ${list([...nodeIds])}.`);
      }
    }
    if (e.cardinality !== undefined && e.type !== "relation") {
      fail(`Edge "${e.id}" has a cardinality, but only ERD "relation" edges can have one.`);
    }
    if (e.type === "message" && e.order === undefined) {
      fail(`Sequence message "${e.id}" needs an "order" (1, 2, 3, ...) so messages are drawn top to bottom.`);
    }
  }

  return board;
}
