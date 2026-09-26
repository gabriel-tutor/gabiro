import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { useMemo } from "react";
import { useLiveBoard } from "./hooks.js";
import { edgeTypes, nodeTypes } from "./nodes.js";
import { toFlow } from "./toFlow.js";

/** Small boards fit on screen; a minimap would only cover part of them. */
const MINIMAP_MIN_NODES = 12;

export function BoardView({ boardId }: { boardId: string }) {
  const { board, error, changed, connected } = useLiveBoard(boardId);
  const flow = useMemo(() => (board ? toFlow(board, changed) : undefined), [board, changed]);

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
        <span className={`gb-status ${connected ? "on" : "off"}`} title={connected ? "Live" : "Reconnecting…"}>
          {connected ? "● live" : "○ reconnecting"}
        </span>
      </header>
      {error && (
        <div className="gb-banner" role="alert">
          <strong>{error.code === "NOT_FOUND" ? "This board no longer exists." : "This board can't be loaded."}</strong>{" "}
          {error.message}
          {board && " Showing the last good version."}
        </div>
      )}
      <main className="gb-canvas">
        {flow ? (
          <ReactFlowProvider>
            <ReactFlow
              nodes={flow.nodes}
              edges={flow.edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              nodesDraggable={false}
              nodesConnectable={false}
              edgesFocusable={false}
              colorMode="system"
              fitView
              minZoom={0.1}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={24} />
              <Controls showInteractive={false} />
              {flow.nodes.length > MINIMAP_MIN_NODES && <MiniMap pannable zoomable />}
            </ReactFlow>
          </ReactFlowProvider>
        ) : (
          !error && <p className="gb-empty">Loading…</p>
        )}
      </main>
    </div>
  );
}
