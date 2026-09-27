import { statSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

/** What a `gabiro://` link asks the app to do. */
export type DeepLink = { action: "start" } | { action: "open"; root: string; boardId?: string };

export type ParsedLink = { ok: true; link: DeepLink } | { ok: false; reason: string };

/** Same rule as the board id slug in src/core/schema.ts. */
const BOARD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Parses `gabiro://start` or `gabiro://open?root=<absolute dir>&board=<id>`. Any website can fire
 * these links, so everything is checked: the root must be absolute, free of `..` segments and an
 * existing directory; the board id must be a slug. `appLink` in src/server/launcher.ts builds them.
 */
export function parseDeepLink(raw: string): ParsedLink {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a URL" };
  }
  if (url.protocol !== "gabiro:") return { ok: false, reason: `unexpected scheme ${url.protocol}` };
  if (url.pathname !== "" && url.pathname !== "/") return { ok: false, reason: `unexpected path ${url.pathname}` };
  if (url.host === "start") return { ok: true, link: { action: "start" } };
  if (url.host !== "open") return { ok: false, reason: `unknown action "${url.host}"` };

  const root = url.searchParams.get("root");
  if (!root) return { ok: false, reason: "missing root" };
  if (!isAbsolute(root)) return { ok: false, reason: "root must be an absolute path" };
  if (root.split(/[\\/]/).includes("..")) return { ok: false, reason: "root must not contain .." };
  const normalized = normalize(root).replace(/(.)[\\/]+$/, "$1");
  if (!isDirectory(normalized)) return { ok: false, reason: "root is not an existing directory" };

  const board = url.searchParams.get("board");
  if (board === null || board === "") return { ok: true, link: { action: "open", root: normalized } };
  if (!BOARD_ID.test(board)) return { ok: false, reason: "board must be a board id slug" };
  return { ok: true, link: { action: "open", root: normalized, boardId: board } };
}
