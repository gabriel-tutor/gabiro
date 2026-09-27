import { BaseEdge, Handle, Position, type EdgeProps, type NodeProps, type Node, type Edge } from "@xyflow/react";
import type { GroupData, MessageData, RoutedData, ShapeData } from "./toFlow.js";

/** Connection points: invisible on a read-only canvas, shown on hover when the user can draw edges. */
function Handles({ direction, connectable }: { direction: "LR" | "TB"; connectable: boolean }) {
  const [target, source] = direction === "LR" ? [Position.Left, Position.Right] : [Position.Top, Position.Bottom];
  const className = connectable ? "gb-handle gb-connectable" : "gb-handle";
  return (
    <>
      <Handle type="target" position={target} isConnectable={connectable} className={className} />
      <Handle type="source" position={source} isConnectable={connectable} className={className} />
    </>
  );
}

const flash = (changed: boolean) => (changed ? " gb-flash" : "");

export function ShapeNode({ data }: NodeProps<Node<ShapeData>>) {
  const { node, direction, changed, connectable } = data;
  return (
    <div className={`gb-node gb-${node.type}${flash(changed)}`} title={node.description}>
      <Handles direction={direction} connectable={connectable} />
      <div className="gb-label">{node.label}</div>
      {node.tech && <div className="gb-tech">{node.tech}</div>}
      {node.type === "sticky" && node.description && <div className="gb-desc">{node.description}</div>}
    </div>
  );
}

export function EntityNode({ data }: NodeProps<Node<ShapeData>>) {
  const { node, direction, changed, connectable } = data;
  return (
    <div className={`gb-entity${flash(changed)}`}>
      <Handles direction={direction} connectable={connectable} />
      <div className="gb-entity-title">{node.label}</div>
      {(node.fields ?? []).map((f) => (
        <div key={f.name} className="gb-field">
          <span className="gb-field-name">
            {f.name}
            {f.nullable ? "?" : ""}
          </span>
          <span className="gb-field-type">{f.type}</span>
          <span className="gb-field-keys">{[f.pk && "PK", f.fk && "FK"].filter(Boolean).join(" ")}</span>
        </div>
      ))}
    </div>
  );
}

export function ParticipantNode({ data }: NodeProps<Node<ShapeData>>) {
  const { node, changed, connectable } = data;
  return (
    <div className="gb-participant">
      {/* The first handles anchor message arrows at the lifeline's centre; the extra pair lets the user draw new messages. */}
      <Handle type="target" position={Position.Top} isConnectable={false} className="gb-handle" />
      <Handle type="source" position={Position.Top} isConnectable={false} className="gb-handle" />
      {connectable && (
        <>
          <Handle id="draw-in" type="target" position={Position.Left} className="gb-handle gb-connectable" />
          <Handle id="draw-out" type="source" position={Position.Right} className="gb-handle gb-connectable" />
        </>
      )}
      <div className={`gb-participant-head${flash(changed)}`}>{node.label}</div>
      <div className="gb-lifeline" />
    </div>
  );
}

export function GroupBox({ data }: NodeProps<Node<GroupData>>) {
  return (
    <div className={`gb-group gb-group-${data.group.type}`}>
      <div className="gb-group-label">{data.group.label}</div>
    </div>
  );
}

/** A sequence message: a horizontal arrow between two lifelines at its row's height. */
export function MessageEdge({ id, sourceX, sourceY, targetX, data }: EdgeProps<Edge<MessageData>>) {
  if (!data) return null;
  const y = sourceY + data.y;
  const self = Math.abs(sourceX - targetX) < 1;
  const dir = targetX >= sourceX ? 1 : -1;
  const path = self
    ? `M ${sourceX} ${y} h 40 v 20 h -40`
    : `M ${sourceX} ${y} L ${targetX - dir * 8} ${y}`;
  const tipX = self ? sourceX : targetX;
  const tipY = self ? y + 20 : y;
  const tipDir = self ? -1 : dir;
  const head = `${tipX},${tipY} ${tipX - tipDir * 9},${tipY - 5} ${tipX - tipDir * 9},${tipY + 5}`;
  const labelX = self ? sourceX + 48 : (sourceX + targetX) / 2;
  return (
    <g className={`gb-message${data.changed ? " gb-flash" : ""}`} data-id={id}>
      <path d={path} fill="none" strokeDasharray={data.dashed ? "6 4" : undefined} />
      <polygon points={head} />
      <text x={labelX} y={self ? y + 4 : y - 7} textAnchor={self ? "start" : "middle"}>
        {data.label}
      </text>
    </g>
  );
}

/** An edge drawn along the route the layout engine computed, so it goes around boxes instead of through them. */
export function RoutedEdge({ data, markerEnd, style, label, labelStyle, labelBgStyle }: EdgeProps<Edge<RoutedData>>) {
  const points = data?.points ?? [];
  if (points.length < 2) return null;
  const path = points.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ");
  const mid = Math.floor((points.length - 1) / 2);
  const [a, b] = [points[mid]!, points[mid + 1]!];
  return (
    <BaseEdge
      path={path}
      markerEnd={markerEnd}
      style={style}
      label={label}
      labelX={(a.x + b.x) / 2}
      labelY={(a.y + b.y) / 2}
      labelStyle={labelStyle}
      labelBgStyle={labelBgStyle}
      labelShowBg
      labelBgPadding={[4, 2]}
    />
  );
}

export const nodeTypes = { shape: ShapeNode, entity: EntityNode, participant: ParticipantNode, "group-box": GroupBox };
export const edgeTypes = { message: MessageEdge, routed: RoutedEdge };
