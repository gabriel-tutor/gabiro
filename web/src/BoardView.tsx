import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  type Node,
  type NodeChange,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Board } from "../../src/core/index.js";
import { addNodeOps, connectOps, deleteOps, moveOps } from "./edits.js";
import { useLiveBoard } from "./hooks.js";
import { edgeTypes, nodeTypes } from "./nodes.js";
import { SidePanel, type Selection } from "./SidePanel.js";
import { toFlow } from "./toFlow.js";
import { Toolbar } from "./Toolbar.js";
import { useEditor, type Editor } from "./useEditor.js";

/** Small boards fit on screen; a minimap would only cover part of them. */
const MINIMAP_MIN_NODES = 12;
const TOAST_MS = 6000;

export function BoardView({ boardId }: { boardId: string }) {
  const live = useLiveBoard(boardId);
  const [toast, setToast] = useState<string>();
  const editor = useEditor(live.board, useCallback((message: string) => setToast(message), []));
  // A corrupt or deleted board stays visible read-only.
  const editable = !!editor.board && !live.error;

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(undefined), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const board = editor.board;
  return (
    <div className="gb-page">
      <header className="gb-header">
        <a href="/" className="gb-back">
          ← Boards
        </a>
        <h1>{board?.title ?? boardId}</h1>
        {board && (
          <span className="gb-meta">
            {board.kind} · revision {board.revision}
          </span>
        )}
        <span className={`gb-status ${live.connected ? "on" : "off"}`} title={live.connected ? "Live" : "Reconnecting…"}>
          {live.connected ? "● live" : "○ reconnecting"}
        </span>
      </header>
      {live.error && (
        <div className="gb-banner" role="alert">
          <strong>{live.error.code === "NOT_FOUND" ? "This board no longer exists." : "This board can't be loaded."}</strong>{" "}
          {live.error.message}
          {board && " Showing the last good version (read-only)."}
        </div>
      )}
      {toast && (
        <div className="gb-toast" role="status">
          {toast}
          <button type="button" aria-label="Dismiss" onClick={() => setToast(undefined)}>
            ×
          </button>
        </div>
      )}
      <main className="gb-canvas">
        {board ? (
          <ReactFlowProvider>
            <Canvas board={board} changed={live.changed} editor={editor} editable={editable} />
          </ReactFlowProvider>
        ) : (
          !live.error && <p className="gb-empty">Loading…</p>
        )}
      </main>
    </div>
  );
}

const directionOf = (n: Node) => (n.data as { direction?: string }).direction;

/**
 * `next` nodes, keeping what the user has selected in `prev` and React Flow's measured size. A node
 * without `measured` makes React Flow drop its handle positions and re-measure it; until then its
 * edges aren't drawn and its handles don't connect. So `measured` is kept, but only while the
 * handles can't have moved: a new node type or board direction puts them elsewhere at the same
 * size, which nothing else would re-measure.
 */
function carryOver(prev: Node[], next: Node[]): Node[] {
  const old = new Map(prev.map((n) => [n.id, n]));
  return next.map((n) => {
    const p = old.get(n.id);
    if (!p) return n;
    const sameHandles = p.type === n.type && directionOf(p) === directionOf(n);
    return { ...n, ...(p.selected ? { selected: true } : {}), ...(p.measured && sameHandles ? { measured: p.measured } : {}) };
  });
}

/** Kanban cards and sequence participants take a slot among their siblings; only the dragged one moves. */
const ONE_AT_A_TIME = new Set<Board["kind"]>(["kanban", "sequence"]);

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

function Canvas({ board, changed, editor, editable }: { board: Board; changed: Set<string>; editor: Editor; editable: boolean }) {
  const flow = useMemo(() => toFlow(board, changed, { editable }), [board, changed, editable]);
  const [nodes, setNodes] = useState<Node[]>(flow.nodes);
  const [edges, setEdges] = useState<Edge[]>(flow.edges);
  const [selection, setSelection] = useState<Selection>();
  const { screenToFlowPosition } = useReactFlow();
  const container = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const flowRef = useRef(flow);
  flowRef.current = flow;

  // Take every new board, keeping what the user has selected (and React Flow's measurements).
  useEffect(() => {
    setNodes((prev) => carryOver(prev, flow.nodes));
    setEdges((prev) => {
      const selected = new Set(prev.filter((e) => e.selected).map((e) => e.id));
      return flow.edges.map((e) => (selected.has(e.id) ? { ...e, selected: true } : e));
    });
  }, [flow]);

  // Forget a selection whose node or edge is gone (deleted here, by undo, or by the agent).
  useEffect(() => {
    if (!selection) return;
    const exists = selection.kind === "node" ? board.nodes.some((n) => n.id === selection.id) : board.edges.some((e) => e.id === selection.id);
    if (!exists) setSelection(undefined);
  }, [board, selection]);

  /**
   * Saves a drag. A drop that changes nothing (or can't be saved) puts the nodes back where the
   * board has them; otherwise the saved board re-lays them out.
   */
  const onNodeDragStop = async (primary: Node, dragged: Node[]) => {
    const moved = (ONE_AT_A_TIME.has(board.kind) ? [primary] : dragged).filter((n) => !n.id.startsWith("group:"));
    const ops = moved.flatMap((n) => moveOps(board, n.id, n.position));
    if (!ops.length || !(await editor.apply(ops))) setNodes((prev) => carryOver(prev, flowRef.current.nodes));
  };

  // Deletions go through the board (onDelete), never straight into local state.
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((ns) => applyNodeChanges(changes.filter((c) => c.type !== "remove"), ns));
  }, []);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((es) => applyEdgeChanges(changes.filter((c) => c.type !== "remove"), es));
  }, []);

  const onSelectionChange = useCallback(({ nodes: ns, edges: es }: OnSelectionChangeParams) => {
    const node = ns.find((n) => !n.id.startsWith("group:"));
    setSelection(node ? { kind: "node", id: node.id } : es[0] ? { kind: "edge", id: es[0].id } : undefined);
  }, []);

  /**
   * React Flow only connects when the pointer is released on a handle. Releasing anywhere on
   * another node's body should connect too, so finish those drags here.
   */
  const onConnectEnd = (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (state.isValid || !state.fromNode) return;
    const point = "changedTouches" in event ? event.changedTouches[0] : event;
    if (!point) return;
    const target = document.elementFromPoint(point.clientX, point.clientY)?.closest<HTMLElement>(".react-flow__node");
    const to = target?.dataset.id;
    if (to && to !== state.fromNode.id && !to.startsWith("group:")) void editor.apply(connectOps(board, state.fromNode.id, to));
  };

  const addNode = (type: string) => {
    const rect = container.current?.getBoundingClientRect();
    const center = rect ? screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) : { x: 0, y: 0 };
    void editor.apply(addNodeOps(board, type, center));
  };

  // Keyboard undo/redo, except while typing in a field.
  const { undo, redo } = editor;
  useEffect(() => {
    if (!editable) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || isTyping(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) void undo();
      else if ((key === "z" && e.shiftKey) || key === "y") void redo();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editable, undo, redo]);

  return (
    <div className="gb-editor">
      {editable && (
        <Toolbar
          kind={board.kind}
          onAdd={addNode}
          onUndo={() => void undo()}
          onRedo={() => void redo()}
          onLayout={() => void editor.autoLayout()}
          canUndo={editor.canUndo}
          canRedo={editor.canRedo}
        />
      )}
      <div className="gb-workspace">
        <div className="gb-flow" ref={container}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onSelectionChange={onSelectionChange}
            onNodeDragStop={(_e, node, dragged) => void onNodeDragStop(node, dragged)}
            onConnect={(c) => c.source && c.target && void editor.apply(connectOps(board, c.source, c.target))}
            onConnectEnd={onConnectEnd}
            onDelete={({ nodes: ns, edges: es }) =>
              void editor.apply(deleteOps(board, ns.map((n) => n.id).filter((id) => !id.startsWith("group:")), es.map((e) => e.id)))
            }
            onNodeDoubleClick={(_e, node) => {
              if (!editable || node.id.startsWith("group:")) return;
              setSelection({ kind: "node", id: node.id });
              setTimeout(() => labelRef.current?.select(), 0);
            }}
            nodesDraggable={editable}
            nodesConnectable={editable}
            elementsSelectable={editable}
            deleteKeyCode={editable ? ["Delete", "Backspace"] : null}
            connectionMode={ConnectionMode.Loose}
            colorMode="system"
            fitView
            minZoom={0.1}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} />
            <Controls showInteractive={false} />
            {flow.nodes.length > MINIMAP_MIN_NODES && <MiniMap pannable zoomable />}
          </ReactFlow>
        </div>
        {editable && selection && <SidePanel board={board} selection={selection} onApply={(ops) => void editor.apply(ops)} labelRef={labelRef} />}
      </div>
    </div>
  );
}
