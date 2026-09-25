import type { BoardNode } from "../core/index.js";

export interface Size {
  width: number;
  height: number;
}

const SIZES: Record<string, Size> = {
  decision: { width: 150, height: 100 },
  database: { width: 160, height: 90 },
  cache: { width: 160, height: 90 },
  storage: { width: 160, height: 90 },
  start: { width: 140, height: 50 },
  end: { width: 140, height: 50 },
  sticky: { width: 160, height: 120 },
  text: { width: 200, height: 40 },
  topic: { width: 160, height: 50 },
  card: { width: 240, height: 80 },
  participant: { width: 160, height: 60 },
};

/** Rendered size of a node. The canvas uses the same numbers so layout and drawing agree. */
export function nodeSize(node: BoardNode): Size {
  if (node.type === "entity") return { width: 220, height: 44 + 26 * (node.fields?.length ?? 0) };
  return SIZES[node.type] ?? { width: 180, height: 70 };
}
