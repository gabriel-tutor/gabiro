import { SlugSchema } from "../core/index.js";
import type { ClientMessage } from "./protocol.js";

/**
 * Parses one frame from a canvas WebSocket client. Returns undefined for anything that is not a
 * well-formed ClientMessage: invalid JSON, non-objects, unknown types, or board ids that aren't slugs.
 * Server-only (protocol.ts is shared with the web bundle and must stay free of Zod).
 */
export function parseClientMessage(raw: string): ClientMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const msg = value as Record<string, unknown>;
  if (msg.type === "subscribe-list") return { type: "subscribe-list" };
  if (msg.type === "subscribe" && SlugSchema.safeParse(msg.boardId).success) {
    return { type: "subscribe", boardId: msg.boardId as string };
  }
  return undefined;
}
