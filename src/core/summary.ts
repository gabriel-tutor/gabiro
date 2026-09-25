import type { Board, BoardEdge, BoardNode } from "./schema.js";

const q = (s: string) => JSON.stringify(s);

function nodeLine(n: BoardNode): string {
  let line = `node ${n.id} [${n.type}] ${q(n.label)}`;
  if (n.tech) line += ` (${n.tech})`;
  if (n.groupId) line += ` in ${n.groupId}`;
  if (n.order !== undefined) line += ` order=${n.order}`;
  if (n.pinned) line += " pinned";
  if (n.tags?.length) line += ` tags=${n.tags.join(",")}`;
  if (n.fields?.length) {
    const fields = n.fields.map((f) => `${f.name}:${f.type}${f.pk ? " PK" : ""}${f.fk ? " FK" : ""}${f.nullable ? "?" : ""}`);
    line += ` fields=[${fields.join(", ")}]`;
  }
  if (n.description) line += ` — ${n.description}`;
  return line;
}

function edgeLine(e: BoardEdge): string {
  let line = `edge ${e.id} [${e.type}] ${e.from} -> ${e.to}`;
  if (e.label) line += ` ${q(e.label)}`;
  if (e.order !== undefined) line += ` order=${e.order}`;
  if (e.cardinality) line += ` ${e.cardinality}`;
  if (e.style) line += ` ${e.style}`;
  return line;
}

/** Compact, line-per-entity text view of a board — cheap for an agent's context. */
export function summarizeBoard(board: Board): string {
  const lines = [
    `board ${board.id} ${q(board.title)} kind=${board.kind} direction=${board.layout.direction} revision=${board.revision}`,
    ...board.groups.map((g) => `group ${g.id} [${g.type}] ${q(g.label)}${g.parentId ? ` in ${g.parentId}` : ""}`),
    ...board.nodes.map(nodeLine),
    ...board.edges.map(edgeLine),
  ];
  if (!board.nodes.length) lines.push("(empty board — add nodes with gabiro_apply_changes)");
  return lines.join("\n");
}
