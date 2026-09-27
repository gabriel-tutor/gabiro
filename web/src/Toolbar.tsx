import { KIND_RULES, type Kind } from "../../src/core/index.js";

interface ToolbarProps {
  kind: Kind;
  onAdd(type: string): void;
  onUndo(): void;
  onRedo(): void;
  onLayout(): void;
  canUndo: boolean;
  canRedo: boolean;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? "⌘" : "Ctrl+";

/** Palette of the node types this board kind allows, plus undo/redo and auto-layout. */
export function Toolbar({ kind, onAdd, onUndo, onRedo, onLayout, canUndo, canRedo }: ToolbarProps) {
  return (
    <div className="gb-toolbar" role="toolbar" aria-label="Board tools">
      <span className="gb-toolbar-label">Add</span>
      {KIND_RULES[kind].nodeTypes.map((type) => (
        <button key={type} type="button" className="gb-tool" onClick={() => onAdd(type)} title={`Add a ${type}`}>
          {type}
        </button>
      ))}
      <span className="gb-toolbar-gap" />
      <button type="button" className="gb-tool" onClick={onUndo} disabled={!canUndo} title={`Undo (${mod}Z)`}>
        Undo
      </button>
      <button type="button" className="gb-tool" onClick={onRedo} disabled={!canRedo} title={`Redo (${mod}Shift+Z)`}>
        Redo
      </button>
      <button type="button" className="gb-tool" onClick={onLayout} title="Re-run auto-layout (nodes you moved stay put)">
        Auto-layout
      </button>
    </div>
  );
}
