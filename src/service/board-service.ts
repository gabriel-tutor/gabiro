import { rm } from "node:fs/promises";
import { join } from "node:path";
import { applyOps, createBoard, GabiroError, type Board, type Direction, type Kind } from "../core/index.js";
import { toMarkdown, toMermaid } from "../export/index.js";
import { layoutBoard, type LayoutMode } from "../layout/index.js";
import { FileStore, loadConfig, writeFileAtomic, type BoardListItem, type BoardStore, type GabiroConfig } from "../store/index.js";

export interface CreateBoardInput {
  title: string;
  kind: Kind;
  id?: string;
  direction?: Direction;
  ops?: unknown[];
}

export type ExportFormat = "mermaid" | "markdown";

/** A save that committed, with an optional non-fatal warning if the follow-up auto-export write failed. */
export interface SaveResult {
  board: Board;
  exportWarning?: string;
}

const STRUCTURAL_OPS = new Set(["add_edge", "remove_edge", "add_group", "update_group", "remove_group", "remove_node"]);
const STRUCTURAL_PATCH_KEYS = new Set(["groupId", "order"]);

/** True when any op in the batch changes board structure enough to warrant a full re-layout ("all" mode). */
export function changesStructure(ops: unknown[]): boolean {
  return ops.some((raw) => {
    if (typeof raw !== "object" || raw === null) return false;
    const op = (raw as Record<string, unknown>).op;
    if (typeof op !== "string") return false;
    if (STRUCTURAL_OPS.has(op)) return true;
    if (op === "update_node" || op === "update_edge") {
      return Object.keys(raw as Record<string, unknown>).some((key) => STRUCTURAL_PATCH_KEYS.has(key));
    }
    return false;
  });
}

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

  async create(input: CreateBoardInput): Promise<SaveResult> {
    const config = await loadConfig(this.root);
    let board = createBoard(input);
    if (input.ops?.length) board = applyOps(board, input.ops);
    const saved = await this.store.create(await layoutBoard(board));
    return { board: saved, exportWarning: await this.autoExport(saved, config) };
  }

  async applyChanges(id: string, ops: unknown[], expectedRevision?: number): Promise<SaveResult> {
    const config = await loadConfig(this.root);
    const mode: LayoutMode = changesStructure(ops) ? "all" : "auto";
    const saved = await this.store.update(id, (b) => layoutBoard(applyOps(b, ops), mode), expectedRevision);
    return { board: saved, exportWarning: await this.autoExport(saved, config) };
  }

  async updateBoard(id: string, changes: { title?: string; direction?: Direction }): Promise<SaveResult> {
    const config = await loadConfig(this.root);
    const saved = await this.store.update(id, (b) => {
      const next: Board = { ...b, title: changes.title ?? b.title, layout: { direction: changes.direction ?? b.layout.direction } };
      return next.layout.direction !== b.layout.direction ? layoutBoard(next, "all") : next;
    });
    return { board: saved, exportWarning: await this.autoExport(saved, config) };
  }

  async autoLayout(id: string, force = false): Promise<SaveResult> {
    const config = await loadConfig(this.root);
    const saved = await this.store.update(id, (b) => layoutBoard(b, force ? "force" : "all"));
    return { board: saved, exportWarning: await this.autoExport(saved, config) };
  }

  async delete(id: string): Promise<void> {
    const config = await loadConfig(this.root);
    await this.store.delete(id);
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

  /** Writes the Markdown auto-export. Never throws: a failure here is reported as a warning, not a failed save. */
  private async autoExport(board: Board, config: GabiroConfig): Promise<string | undefined> {
    if (!config.autoExport) return undefined;
    try {
      await writeFileAtomic(join(this.root, config.exportDir, `${board.id}.md`), toMarkdown(board));
      return undefined;
    } catch (err) {
      return (err as Error).message;
    }
  }
}
