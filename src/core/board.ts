import { GabiroError } from "./errors.js";
import type { Kind } from "./kinds.js";
import type { Board, Direction } from "./schema.js";

/** "Checkout – Architecture!" -> "checkout-architecture" */
export function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  if (!slug) {
    throw new GabiroError("VALIDATION", `Cannot derive an id from "${text}". Pass an explicit id like "my-board".`);
  }
  return slug;
}

export interface NewBoardInput {
  title: string;
  kind: Kind;
  id?: string;
  direction?: Direction;
  now?: string;
}

export function createBoard(input: NewBoardInput): Board {
  const now = input.now ?? new Date().toISOString();
  return {
    id: input.id ?? slugify(input.title),
    title: input.title,
    kind: input.kind,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    layout: { direction: input.direction ?? (input.kind === "flowchart" ? "TB" : "LR") },
    groups: [],
    nodes: [],
    edges: [],
  };
}
