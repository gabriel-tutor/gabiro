import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/**
 * Serves the built canvas from `webDir`. Paths without an extension (app routes like /b/my-board)
 * get index.html so the browser app can route them. Never serves files outside `webDir`.
 */
export async function serveStatic(webDir: string, pathname: string, res: ServerResponse): Promise<void> {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  const isAppRoute = extname(rel) === "";
  const file = join(webDir, isAppRoute ? "index.html" : rel);
  if (file !== webDir && !file.startsWith(webDir.endsWith(sep) ? webDir : webDir + sep)) {
    res.writeHead(404).end("Not found");
    return;
  }
  try {
    const body = await readFile(file);
    const cache = isAppRoute ? "no-cache" : "public, max-age=31536000, immutable";
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": cache });
    res.end(body);
  } catch {
    if (isAppRoute) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("The gabiro canvas isn't built. Run `npm run build` in the gabiro package.");
    } else {
      res.writeHead(404).end("Not found");
    }
  }
}
