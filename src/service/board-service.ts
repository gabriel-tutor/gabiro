import { rm } from "node:fs/promises";
import { join } from "node:path";
import { applyOps, createBoard, GabiroError, type Board, type Direction, type Kind } from "../core/index.js";
import { toMarkdown, toMermaid } from "../export/index.js";
import { layoutBoard } from "../layout/index.js";
import { FileStore, loadConfig, writeFileAtomic, type BoardListItem, type BoardStore } from "../store/index.js";

export interface CreateBoardInput {
  title: string;
  kind: Kind;
  id?: string;
  direction?: Direction;
  ops?: unknown[];
}

export type ExportFormat = "mermaid" | "markdown";

/**
 * The one place that combines ops, layout, storage and export.
 * MCP tools (and later the canvas server) call this; they never touch the store directly.
 */
export class BoardService {
  constructor(
    readonly root: string,
    readonly store: BoardStore = new FileStore(root),
  ) {}

  list(): Promise<BoardListItem[]> {
    return this.store.list();
  }

  get(id: string): Promise<Board> {
    return this.store.get(id);
  }

  async create(input: CreateBoardInput): Promise<Board> {
    let board = createBoard(input);
    if (input.ops?.length) board = applyOps(board, input.ops);
    const saved = await this.store.create(await layoutBoard(board));
    await this.autoExport(saved);
    return saved;
  }

  async applyChanges(id: string, ops: unknown[], expectedRevision?: number): Promise<Board> {
    const saved = await this.store.update(id, (b) => layoutBoard(applyOps(b, ops)), expectedRevision);
    await this.autoExport(saved);
    return saved;
  }

  async updateBoard(id: string, changes: { title?: string; direction?: Direction }): Promise<Board> {
    const saved = await this.store.update(id, (b) => {
      const next: Board = { ...b, title: changes.title ?? b.title, layout: { direction: changes.direction ?? b.layout.direction } };
      return next.layout.direction !== b.layout.direction ? layoutBoard(next, "all") : next;
    });
    await this.autoExport(saved);
    return saved;
  }

  async autoLayout(id: string, force = false): Promise<Board> {
    const saved = await this.store.update(id, (b) => layoutBoard(b, force ? "force" : "all"));
    await this.autoExport(saved);
    return saved;
  }

  async delete(id: string): Promise<void> {
    await this.store.delete(id);
    const config = await loadConfig(this.root);
    await rm(join(this.root, config.exportDir, `${id}.md`), { force: true });
  }

  /** Returns the exported text; with `write`, also saves it under the configured export dir. */
  async export(id: string, format: ExportFormat, write = false): Promise<{ content: string; path?: string }> {
    const board = await this.store.get(id);
    let content: string;
    if (format === "mermaid") {
      const mermaid = toMermaid(board);
      if (mermaid === null) {
        throw new GabiroError("VALIDATION", `Freeform boards have no Mermaid form. Use format "markdown" instead.`);
      }
      content = mermaid + "\n";
    } else {
      content = toMarkdown(board);
    }
    if (!write) return { content };
    const config = await loadConfig(this.root);
    const path = join(config.exportDir, `${id}.${format === "mermaid" ? "mmd" : "md"}`);
    await writeFileAtomic(join(this.root, path), content);
    return { content, path };
  }

  private async autoExport(board: Board): Promise<void> {
    const config = await loadConfig(this.root);
    if (config.autoExport) await writeFileAtomic(join(this.root, config.exportDir, `${board.id}.md`), toMarkdown(board));
  }
}
