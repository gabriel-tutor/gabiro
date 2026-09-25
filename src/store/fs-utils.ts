import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { GabiroError } from "../core/index.js";

/** Write via temp file + rename so readers never see a half-written file. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Cross-process mutex using an exclusive lock file. A lock older than `staleMs`
 * is assumed to belong to a crashed process and is taken over.
 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, staleMs = 5000): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + staleMs * 2;
  const token = randomBytes(8).toString("hex");
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.close();
      await writeFile(lockPath, token, "utf8");
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const age = await stat(lockPath).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > staleMs) await unlink(lockPath).catch(() => {});
      else if (Date.now() > deadline) throw new GabiroError("CONFLICT", `Timed out waiting for ${basename(lockPath)}: another gabiro process is writing this board. Retry in a moment.`);
      else await sleep(20);
    }
  }
  try {
    return await fn();
  } finally {
    const fileContent = await readFile(lockPath, "utf8").catch(() => "");
    if (fileContent === token) {
      await unlink(lockPath).catch(() => {});
    }
  }
}
