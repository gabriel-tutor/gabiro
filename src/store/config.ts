import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { GabiroError } from "../core/index.js";

const ConfigSchema = z.object({
  autoExport: z.boolean().default(true),
  exportDir: z.string().min(1).default("docs/diagrams"),
});
export type GabiroConfig = z.infer<typeof ConfigSchema>;

/** Reads `<root>/.gabiro/config.json`; missing file or keys fall back to defaults. */
export async function loadConfig(root: string): Promise<GabiroConfig> {
  const path = join(root, ".gabiro", "config.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    raw = "{}";
  }
  let config: GabiroConfig;
  try {
    config = ConfigSchema.parse(JSON.parse(raw));
  } catch (err) {
    throw new GabiroError("CORRUPT", `.gabiro/config.json is invalid (${(err as Error).message}). Fix or delete it.`);
  }
  const rel = relative(resolve(root), resolve(root, config.exportDir));
  if (isAbsolute(config.exportDir) || rel === "" || rel.startsWith("..")) {
    throw new GabiroError(
      "CORRUPT",
      `.gabiro/config.json: exportDir must be a relative path inside the project (got "${config.exportDir}").`,
    );
  }
  return config;
}
