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

  // Take every new board, keeping what the user has selected.
  useEffect(() => {
    setNodes((prev) => {
      const selected = new Set(prev.filter((n) => n.selected).map((n) => n.id));
      return flow.nodes.map((n) => (selected.has(n.id) ? { ...n, selected: true } : n));
    });
    setEdges((prev) => {
      const selected = new Set(prev.filter((e) => e.selected).map((e) => e.id));
      return flow.edges.map((e) => (selected.has(e.id) ? { ...e, selected: true } : e));
    });
  }, [flow]);

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
  useEffect(() => {
    if (!editable) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || isTyping(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) void editor.undo();
      else if ((key === "z" && e.shiftKey) || key === "y") void editor.redo();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editable, editor]);

  return (
    <div className="gb-editor">
      {editable && (
        <Toolbar
          kind={board.kind}
          onAdd={addNode}
          onUndo={() => void editor.undo()}
          onRedo={() => void editor.redo()}
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
            onNodeDragStop={(_e, _node, dragged) =>
              void editor.apply(dragged.filter((n) => !n.id.startsWith("group:")).flatMap((n) => moveOps(board, n.id, n.position)))
            }
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
