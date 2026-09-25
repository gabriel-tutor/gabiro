import { readdir, readFile, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { GabiroError, SlugSchema, validateBoard, type Board } from "../core/index.js";
import { withFileLock, writeFileAtomic } from "./fs-utils.js";
import type { BoardListItem, BoardStore } from "./store.js";

/** Stores each board as `<root>/.gabiro/boards/<id>.json`. */
export class FileStore implements BoardStore {
  readonly dir: string;

  constructor(
    private readonly root: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.dir = join(root, ".gabiro", "boards");
  }

  pathFor(id: string): string {
    if (!SlugSchema.safeParse(id).success) {
      throw new GabiroError("VALIDATION", `"${id}" isn't a valid board id. Board ids are slugs like "checkout-architecture".`);
    }
    return join(this.dir, `${id}.json`);
  }

  async list(): Promise<BoardListItem[]> {
    const files = await readdir(this.dir).catch(() => [] as string[]);
    const items: BoardListItem[] = [];
    for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
      const id = file.slice(0, -".json".length);
      try {
        const b = await this.get(id);
        items.push({ id, title: b.title, kind: b.kind, nodeCount: b.nodes.length, updatedAt: b.updatedAt });
      } catch (err) {
        items.push({ id, title: id, kind: "unknown", nodeCount: 0, updatedAt: "", error: (err as Error).message });
      }
    }
    return items;
  }

  async get(id: string): Promise<Board> {
    const path = this.pathFor(id);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        const known = (await readdir(this.dir).catch(() => [] as string[]))
          .filter((f) => f.endsWith(".json"))
          .map((f) => f.slice(0, -5));
        throw new GabiroError(
          "NOT_FOUND",
          `No board "${id}". Existing boards: ${known.length ? known.join(", ") : "(none — create one with gabiro_create_board)"}.`,
        );
      }
      throw err;
    }
    try {
      return validateBoard(JSON.parse(raw));
    } catch (err) {
      const where = relative(this.root, path);
      throw new GabiroError(
        "CORRUPT",
        `Board file ${where} is invalid (${(err as Error).message}). Fix it by hand or delete it; gabiro won't overwrite it.`,
      );
    }
  }

  async create(board: Board): Promise<Board> {
    const path = this.pathFor(board.id);
    return withFileLock(`${path}.lock`, async () => {
      let exists = false;
      try {
        await readFile(path);
        exists = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      if (exists) {
        throw new GabiroError("EXISTS", `Board "${board.id}" already exists. Pick another id, or edit it with gabiro_apply_changes.`);
      }
      const now = this.now();
      const saved = validateBoard({ ...board, revision: 1, createdAt: now, updatedAt: now });
      await writeFileAtomic(path, JSON.stringify(saved, null, 2) + "\n");
      return saved;
    });
  }

  async update(id: string, change: (board: Board) => Board | Promise<Board>, expectedRevision?: number): Promise<Board> {
    const path = this.pathFor(id);
    return withFileLock(`${path}.lock`, async () => {
      const current = await this.get(id);
      if (expectedRevision !== undefined && expectedRevision !== current.revision) {
        throw new GabiroError(
          "CONFLICT",
          `Board "${id}" is at revision ${current.revision}, you sent ${expectedRevision}. It changed since you read it — call gabiro_get_board and retry.`,
        );
      }
      const changed = await change(structuredClone(current));
      const saved = validateBoard({
        ...changed,
        id: current.id,
        createdAt: current.createdAt,
        revision: current.revision + 1,
        updatedAt: this.now(),
      });
      await writeFileAtomic(path, JSON.stringify(saved, null, 2) + "\n");
      return saved;
    });
  }

  async delete(id: string): Promise<void> {
    const path = this.pathFor(id);
    await withFileLock(`${path}.lock`, async () => {
      try {
        await unlink(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new GabiroError("NOT_FOUND", `No board "${id}".`);
        throw err;
      }
    });
  }
}
