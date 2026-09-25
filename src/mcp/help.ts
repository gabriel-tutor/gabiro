import { KIND_RULES, KINDS } from "../core/index.js";

const kindLines = KINDS.map((k) => {
  const r = KIND_RULES[k];
  const nodes = r.nodeTypes.filter((t) => t !== "sticky").join("|");
  const edges = r.edgeTypes.join("|") || "none";
  const groups = r.groupTypes.join("|") || "none";
  return `- ${k}: nodes ${nodes}; edges ${edges}; groups ${groups}`;
}).join("\n");

/** Shared reference text for the ops parameter. Generated from KIND_RULES so it never drifts. */
export const OPS_HELP = `Ordered list of changes, applied atomically (all or nothing). Later ops may reference ids created by earlier ones.
Each op is an object with "op" and these fields:
- add_node {id, type, label, description?, tech?, groupId?, tags?, color?, order?, fields?: [{name, type, pk?, fk?, nullable?}]}
- update_node {id, ...fields to change}  (null clears a field)
- remove_node {id}  (also removes its edges)
- add_edge {from, to, type, id?, label?, order?, style?: "solid"|"dashed", cardinality?: "1-1"|"1-n"|"n-n"}  (id defaults to "from->to")
- update_edge {id, ...fields} (from/to can't change: remove the edge and add a new one) / remove_edge {id}
- add_group {id, label, type, parentId?} / update_group {id, ...fields} / remove_group {id, cascade?}
Ids are lowercase slugs like "orders-db". Don't send positions; the layout engine places nodes.
Allowed types by board kind ("sticky" notes are allowed on every kind):
${kindLines}
Kind-specific: ERD entities take "fields" and relations take "cardinality"; sequence messages need "order" (1,2,3…), style "dashed" for replies; kanban cards need groupId (their column) and "order".`;

export const SERVER_INSTRUCTIONS = `Gabiro draws software diagrams (architecture, flowchart, sequence, erd, mindmap, freeform, kanban) as boards stored in the project under .gabiro/boards, with Mermaid exports in docs/diagrams.
Workflow: call gabiro_list_boards to reuse existing boards; build a new diagram in ONE gabiro_create_board call with all ops; refine with gabiro_apply_changes, passing the revision you last saw as expectedRevision.
Use gabiro_get_board (format "summary") to re-read a board, because the user may have edited it. Record open questions and risks as "sticky" nodes.`;
