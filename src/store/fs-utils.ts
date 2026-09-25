import { randomBytes } from "node:crypto";
import { mkdir, open, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const age = await stat(lockPath).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > staleMs) await unlink(lockPath).catch(() => {});
      else if (Date.now() > deadline) throw new Error(`Timed out waiting for lock ${lockPath}`);
      else await sleep(20);
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}
