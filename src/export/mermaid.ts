import type { Board, BoardEdge, BoardGroup, BoardNode } from "../core/index.js";

/** Words Mermaid treats as keywords; used as ids they break the diagram. */
const RESERVED = new Set([
  "end", "graph", "flowchart", "subgraph", "direction", "style", "class", "classdef", "click", "linkstyle",
  "default", "call", "href", "participant", "actor", "loop", "alt", "opt", "else", "par", "and", "rect",
  "note", "critical", "break", "box", "autonumber", "activate", "deactivate", "title", "root",
]);

/** Mermaid-safe identifier: '-' becomes '_' (Mermaid reads '-' as arrows) and keywords get a '_' suffix. */
const mid = (id: string) => {
  const safe = id.replace(/-/g, "_");
  return RESERVED.has(safe) ? `${safe}_` : safe;
};

/** Text for a quoted Mermaid label. */
const text = (s: string) => s.replace(/"/g, "#quot;").replace(/\r?\n/g, "<br/>");

/** Text for unquoted contexts (sequence messages, kanban, ERD). */
const plain = (s: string) => s.replace(/[\r\n;#]+/g, " ").replace(/[[\]{}]/g, "").trim();

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byOrder = <T extends { id: string; order?: number }>(a: T, b: T) =>
  (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || byId(a, b);

const SHAPES: Record<string, [string, string]> = {
  client: ['(["', '"])'],
  gateway: ['[/"', '"\\]'],
  service: ['["', '"]'],
  function: ['>"', '"]'],
  database: ['[("', '")]'],
  cache: ['[("', '")]'],
  queue: ['[["', '"]]'],
  storage: ['[("', '")]'],
  external: ['{{"', '"}}'],
  start: ['(["', '"])'],
  end: ['(["', '"])'],
  step: ['["', '"]'],
  decision: ['{"', '"}'],
  io: ['[/"', '"/]'],
  subprocess: ['[["', '"]]'],
  sticky: ['>"', '"]'],
};

function flowNode(n: BoardNode): string {
  const [open, close] = SHAPES[n.type] ?? ['["', '"]'];
  const label = n.tech ? `${text(n.label)}<br/><i>${text(n.tech)}</i>` : text(n.label);
  return `${mid(n.id)}${open}${label}${close}`;
}

function flowEdge(e: BoardEdge): string {
  const dashed = e.style === "dashed" || (e.style === undefined && e.type === "async");
  const arrow = dashed ? "-.->" : "-->";
  const label = e.label ? `|"${text(e.label)}"|` : "";
  return `${mid(e.from)} ${arrow}${label} ${mid(e.to)}`;
}

function flowchart(board: Board): string {
  const lines = [`flowchart ${board.layout.direction}`];
  const nodes = [...board.nodes].sort(byId);
  const groups = [...board.groups].sort(byId);

  const emitGroup = (g: BoardGroup, depth: number) => {
    const pad = "  ".repeat(depth);
    lines.push(`${pad}subgraph ${mid(g.id)}["${text(g.label)}"]`);
    for (const child of groups.filter((c) => c.parentId === g.id)) emitGroup(child, depth + 1);
    for (const n of nodes.filter((x) => x.groupId === g.id)) lines.push(`${pad}  ${flowNode(n)}`);
    lines.push(`${pad}end`);
  };

  for (const g of groups.filter((x) => x.parentId === undefined)) emitGroup(g, 1);
  for (const n of nodes.filter((x) => x.groupId === undefined)) lines.push(`  ${flowNode(n)}`);
  for (const e of [...board.edges].sort(byId)) lines.push(`  ${flowEdge(e)}`);
  return lines.join("\n");
}

function sequence(board: Board): string {
  const lines = ["sequenceDiagram"];
  const participants = board.nodes.filter((n) => n.type === "participant").sort(byOrder);
  for (const p of participants) lines.push(`  participant ${mid(p.id)} as ${plain(p.label)}`);
  for (const m of [...board.edges].sort(byOrder)) {
    const arrow = m.style === "dashed" ? "-->>" : "->>";
    lines.push(`  ${mid(m.from)}${arrow}${mid(m.to)}: ${plain(m.label ?? "")}`);
  }
  const first = participants[0];
  if (first) {
    for (const s of board.nodes.filter((n) => n.type === "sticky").sort(byId)) {
      lines.push(`  Note over ${mid(first.id)}: ${plain(s.label)}`);
    }
  }
  return lines.join("\n");
}

const CARDINALITY: Record<string, string> = { "1-1": "||--||", "1-n": "||--o{", "n-n": "}o--o{" };
const word = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_");

function erd(board: Board): string {
  const lines = ["erDiagram"];
  for (const n of board.nodes.filter((x) => x.type === "entity").sort(byId)) {
    lines.push(`  ${mid(n.id)} {`);
    for (const f of n.fields ?? []) {
      const keys = [f.pk ? "PK" : "", f.fk ? "FK" : ""].filter(Boolean).join(", ");
      lines.push(`    ${word(f.type)} ${word(f.name)}${keys ? ` ${keys}` : ""}`);
    }
    lines.push("  }");
  }
  for (const e of [...board.edges].sort(byId)) {
    const rel = CARDINALITY[e.cardinality ?? "1-n"];
    lines.push(`  ${mid(e.from)} ${rel} ${mid(e.to)} : "${text(e.label ?? "")}"`);
  }
  return lines.join("\n");
}

function mindmap(board: Board): string {
  const topics = board.nodes.filter((n) => n.type === "topic").sort(byId);
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const e of [...board.edges].sort(byId)) {
    children.set(e.from, [...(children.get(e.from) ?? []), e.to]);
    hasParent.add(e.to);
  }
  const byNodeId = new Map(topics.map((t) => [t.id, t]));
  const roots = topics.filter((t) => !hasParent.has(t.id));
  const lines = ["mindmap"];
  const visited = new Set<string>();

  const emit = (id: string, depth: number) => {
    const t = byNodeId.get(id);
    if (!t || visited.has(id)) return;
    visited.add(id);
    const shape = depth === 1 ? [`((`, `))`] : [`[`, `]`];
    lines.push(`${"  ".repeat(depth)}${mid(id)}${shape[0]}"${text(t.label)}"${shape[1]}`);
    for (const c of children.get(id) ?? []) emit(c, depth + 1);
  };

  if (roots.length === 1) {
    emit(roots[0]!.id, 1);
  } else {
    lines.push(`  root(("${text(board.title)}"))`);
    for (const r of roots.length ? roots : topics) emit(r.id, 2);
  }
  return lines.join("\n");
}

function kanban(board: Board): string {
  const lines = ["kanban"];
  for (const col of board.groups) {
    lines.push(`  ${mid(col.id)}[${plain(col.label)}]`);
    for (const card of board.nodes.filter((n) => n.groupId === col.id).sort(byOrder)) {
      lines.push(`    ${mid(card.id)}[${plain(card.label)}]`);
    }
  }
  return lines.join("\n");
}

/** Mermaid source for a board, or null for kinds Mermaid can't draw (freeform). Output is deterministic. */
export function toMermaid(board: Board): string | null {
  switch (board.kind) {
    case "architecture":
    case "flowchart":
      return flowchart(board);
    case "sequence":
      return sequence(board);
    case "erd":
      return erd(board);
    case "mindmap":
      return mindmap(board);
    case "kanban":
      return kanban(board);
    case "freeform":
      return null;
  }
}
