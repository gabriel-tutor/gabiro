import { readdir, readFile, realpath, rename, stat, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface RecentProject {
  root: string;
  /** ISO timestamp of the last time the project was opened. */
  openedAt: string;
}

/** A recent project as the start window shows it. */
export interface RecentProjectView {
  root: string;
  name: string;
  boards: number;
  missing: boolean;
}

export const MAX_RECENT = 10;

const canonical = (root: string) => realpath(root).catch(() => root);

function isEntry(value: unknown): value is RecentProject {
  const v = value as RecentProject;
  return typeof v?.root === "string" && typeof v.openedAt === "string";
}

/**
 * Recently opened projects in `<userData>/recent.json`, newest first, at most 10, deduplicated by
 * real path. A missing or corrupt file reads as an empty list. Writes are atomic and serialized.
 */
export class RecentProjects {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async list(): Promise<RecentProject[]> {
    try {
      const data: unknown = JSON.parse(await readFile(this.file, "utf8"));
      return Array.isArray(data) ? data.filter(isEntry).slice(0, MAX_RECENT) : [];
    } catch {
      return [];
    }
  }

  async has(root: string): Promise<boolean> {
    const real = await canonical(root);
    return (await this.list()).some((p) => p.root === real);
  }

  /** Moves `root` to the top of the list. */
  add(root: string, now = new Date()): Promise<RecentProject[]> {
    return this.update(async (list) => {
      const real = await canonical(root);
      return [{ root: real, openedAt: now.toISOString() }, ...list.filter((p) => p.root !== real)];
    });
  }

  forget(root: string): Promise<RecentProject[]> {
    return this.update(async (list) => list.filter((p) => p.root !== root));
  }

  private update(change: (list: RecentProject[]) => Promise<RecentProject[]>): Promise<RecentProject[]> {
    const next = this.queue.then(async () => {
      const list = (await change(await this.list())).slice(0, MAX_RECENT);
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(list, null, 2) + "\n");
      await rename(tmp, this.file);
      return list;
    });
    this.queue = next.catch(() => {});
    return next;
  }
}

/** Folder name, board count and whether the folder still exists, for the start window. */
export async function describeProject(root: string): Promise<RecentProjectView> {
  const name = basename(root) || root;
  const missing = !(await stat(root).then((s) => s.isDirectory(), () => false));
  if (missing) return { root, name, boards: 0, missing };
  const files = await readdir(join(root, ".gabiro", "boards")).catch(() => [] as string[]);
  return { root, name, boards: files.filter((f) => f.endsWith(".json")).length, missing };
}
