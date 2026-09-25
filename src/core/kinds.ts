export const KINDS = ["architecture", "flowchart", "sequence", "erd", "mindmap", "freeform", "kanban"] as const;
export type Kind = (typeof KINDS)[number];

export interface KindRules {
  nodeTypes: readonly string[];
  edgeTypes: readonly string[];
  groupTypes: readonly string[];
}

/** Which node/edge/group types each board kind allows. `sticky` is allowed on every kind. */
export const KIND_RULES: Record<Kind, KindRules> = {
  architecture: {
    nodeTypes: ["client", "gateway", "service", "function", "database", "cache", "queue", "storage", "external", "sticky"],
    edgeTypes: ["sync", "async", "data", "dependency"],
    groupTypes: ["zone", "boundary"],
  },
  flowchart: {
    nodeTypes: ["start", "end", "step", "decision", "io", "subprocess", "sticky"],
    edgeTypes: ["flow"],
    groupTypes: ["lane"],
  },
  sequence: { nodeTypes: ["participant", "sticky"], edgeTypes: ["message"], groupTypes: [] },
  erd: { nodeTypes: ["entity", "sticky"], edgeTypes: ["relation"], groupTypes: [] },
  mindmap: { nodeTypes: ["topic", "sticky"], edgeTypes: ["branch"], groupTypes: [] },
  freeform: { nodeTypes: ["sticky", "text", "shape"], edgeTypes: ["link"], groupTypes: ["frame"] },
  kanban: { nodeTypes: ["card", "sticky"], edgeTypes: [], groupTypes: ["column"] },
};

const unique = (xs: string[]) => [...new Set(xs)];
export const ALL_NODE_TYPES = unique(KINDS.flatMap((k) => KIND_RULES[k].nodeTypes)) as [string, ...string[]];
export const ALL_EDGE_TYPES = unique(KINDS.flatMap((k) => KIND_RULES[k].edgeTypes)) as [string, ...string[]];
export const ALL_GROUP_TYPES = unique(KINDS.flatMap((k) => KIND_RULES[k].groupTypes)) as [string, ...string[]];

/** Kinds whose rules allow the given node type, for "did you mean" hints. */
export function kindsAllowingNodeType(type: string): Kind[] {
  return KINDS.filter((k) => KIND_RULES[k].nodeTypes.includes(type) && type !== "sticky");
}
