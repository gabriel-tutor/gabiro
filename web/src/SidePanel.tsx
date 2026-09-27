import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { KIND_RULES, type Board, type BoardEdge, type BoardNode, type Field, type Op } from "../../src/core/index.js";
import { deleteOps } from "./edits.js";

export type Selection = { kind: "node"; id: string } | { kind: "edge"; id: string };

interface SidePanelProps {
  board: Board;
  selection: Selection;
  onApply(ops: Op[]): void;
  labelRef: RefObject<HTMLInputElement | null>;
}

/** Commits a text field on Enter (textareas commit on blur only). */
const enterBlurs = (e: KeyboardEvent<HTMLInputElement>) => {
  if (e.key === "Enter") e.currentTarget.blur();
};
const orNull = (text: string) => (text.trim() === "" ? null : text.trim());

/**
 * A text field's draft: follows the board's value (e.g. when an agent edits it) except while the
 * user is typing in it, and saves through `commit` when it loses focus.
 */
function useDraft(value: string, commit: (draft: string) => void) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  return {
    value: draft,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
      if (draft !== value) commit(draft);
    },
  };
}

/** Details of the selected node or edge. Every field saves when it loses focus or changes. */
export function SidePanel({ board, selection, onApply, labelRef }: SidePanelProps) {
  if (selection.kind === "node") {
    const node = board.nodes.find((n) => n.id === selection.id);
    return node ? <NodeForm key={node.id} board={board} node={node} onApply={onApply} labelRef={labelRef} /> : null;
  }
  const edge = board.edges.find((e) => e.id === selection.id);
  return edge ? <EdgeForm key={edge.id} board={board} edge={edge} onApply={onApply} labelRef={labelRef} /> : null;
}

function NodeForm({ board, node, onApply, labelRef }: { board: Board; node: BoardNode } & Omit<SidePanelProps, "board" | "selection">) {
  const update = (changes: Record<string, unknown>) => onApply([{ op: "update_node", id: node.id, ...changes } as Op]);
  const label = useDraft(node.label, (v) => v.trim() && update({ label: v.trim() }));
  const tech = useDraft(node.tech ?? "", (v) => update({ tech: orNull(v) }));
  const description = useDraft(node.description ?? "", (v) => update({ description: orNull(v) }));
  const tags = useDraft((node.tags ?? []).join(", "), (v) => {
    const list = v.split(",").map((t) => t.trim()).filter(Boolean);
    if (list.join(",") !== (node.tags ?? []).join(",")) update({ tags: list.length ? list : null });
  });
  const rules = KIND_RULES[board.kind];

  return (
    <aside className="gb-panel" aria-label="Selected node">
      <h2>{node.label}</h2>
      <label>
        Label
        <input ref={labelRef} {...label} onKeyDown={enterBlurs} />
      </label>
      <label>
        Type
        <select value={node.type} onChange={(e) => update({ type: e.target.value })}>
          {rules.nodeTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      {rules.groupTypes.length > 0 && board.groups.length > 0 && (
        <label>
          {board.kind === "kanban" ? "Column" : "Group"}
          <select value={node.groupId ?? ""} onChange={(e) => update({ groupId: e.target.value || null })}>
            {board.kind !== "kanban" && <option value="">(none)</option>}
            {board.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Tech
        <input {...tech} placeholder="e.g. PostgreSQL 16" onKeyDown={enterBlurs} />
      </label>
      <label>
        Description
        <textarea {...description} rows={3} />
      </label>
      <label>
        Tags
        <input {...tags} placeholder="comma, separated" onKeyDown={enterBlurs} />
      </label>
      {node.type === "entity" && (
        <FieldsEditor key={JSON.stringify(node.fields ?? [])} fields={node.fields ?? []} onChange={(fields) => update({ fields })} />
      )}
      <button type="button" className="gb-danger" onClick={() => onApply(deleteOps(board, [node.id], []))}>
        Delete node
      </button>
    </aside>
  );
}

function FieldsEditor({ fields, onChange }: { fields: Field[]; onChange(fields: Field[]): void }) {
  const [rows, setRows] = useState(fields);
  const commit = (next: Field[]) => {
    setRows(next);
    const valid = next.filter((f) => f.name.trim() && f.type.trim());
    if (JSON.stringify(valid) !== JSON.stringify(fields)) onChange(valid);
  };
  const setRow = (i: number, patch: Partial<Field>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="gb-fields">
      <legend>Fields</legend>
      {rows.map((f, i) => (
        <div key={i} className="gb-field-row">
          <input aria-label="Field name" value={f.name} onChange={(e) => setRow(i, { name: e.target.value })} onBlur={() => commit(rows)} />
          <input aria-label="Field type" value={f.type} onChange={(e) => setRow(i, { type: e.target.value })} onBlur={() => commit(rows)} />
          {(["pk", "fk", "nullable"] as const).map((flag) => (
            <label key={flag} className="gb-check">
              <input
                type="checkbox"
                checked={!!f[flag]}
                onChange={(e) => commit(rows.map((r, j) => (j === i ? { ...r, [flag]: e.target.checked || undefined } : r)))}
              />
              {flag === "nullable" ? "null" : flag.toUpperCase()}
            </label>
          ))}
          <button type="button" aria-label="Remove field" onClick={() => commit(rows.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
      <button type="button" onClick={() => setRows([...rows, { name: "", type: "text" }])}>
        Add field
      </button>
    </fieldset>
  );
}

function EdgeForm({ board, edge, onApply, labelRef }: { board: Board; edge: BoardEdge } & Omit<SidePanelProps, "board" | "selection">) {
  const update = (changes: Record<string, unknown>) => onApply([{ op: "update_edge", id: edge.id, ...changes } as Op]);
  const label = useDraft(edge.label ?? "", (v) => update({ label: orNull(v) }));
  const order = useDraft(String(edge.order ?? ""), (v) => Number.isInteger(Number(v)) && Number(v) >= 1 && update({ order: Number(v) }));
  const name = (id: string) => board.nodes.find((n) => n.id === id)?.label ?? id;

  return (
    <aside className="gb-panel" aria-label="Selected edge">
      <h2>
        {name(edge.from)} → {name(edge.to)}
      </h2>
      <label>
        Label
        <input ref={labelRef} {...label} onKeyDown={enterBlurs} />
      </label>
      <label>
        Type
        <select value={edge.type} onChange={(e) => update({ type: e.target.value })}>
          {KIND_RULES[board.kind].edgeTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label>
        Line
        <select value={edge.style ?? ""} onChange={(e) => update({ style: e.target.value || null })}>
          <option value="">default</option>
          <option value="solid">solid</option>
          <option value="dashed">dashed</option>
        </select>
      </label>
      {board.kind === "erd" && (
        <label>
          Cardinality
          <select value={edge.cardinality ?? "1-n"} onChange={(e) => update({ cardinality: e.target.value })}>
            {["1-1", "1-n", "n-n"].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      )}
      {board.kind === "sequence" && (
        <label>
          Order
          <input type="number" min={1} {...order} onKeyDown={enterBlurs} />
        </label>
      )}
      <button type="button" className="gb-danger" onClick={() => onApply(deleteOps(board, [], [edge.id]))}>
        Delete edge
      </button>
    </aside>
  );
}
