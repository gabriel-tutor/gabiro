import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Board } from "../../src/core/index.js";
import { startCanvasServer, type CanvasServer } from "../../src/server/index.js";
import { BoardService } from "../../src/service/index.js";
import { findChromium } from "./browser.js";

const webDir = fileURLToPath(new URL("../../dist/web", import.meta.url));
const chromiumPath = findChromium();

/** The revision the page shows in its header. */
async function shownRevision(page: Page): Promise<number> {
  return Number(/revision (\d+)/.exec((await page.locator(".gb-meta").textContent()) ?? "")?.[1] ?? 0);
}

/**
 * Polls the saved board until `check` passes (edits are saved asynchronously), then waits for the
 * page to show that revision: the server may have re-laid out nodes the next step will grab.
 */
async function until(page: Page, svc: BoardService, boardId: string, check: (b: Board) => boolean, timeoutMs = 5000): Promise<Board> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const board = await svc.get(boardId);
    if (check(board)) {
      await expect.poll(() => shownRevision(page), { timeout: timeoutMs }).toBeGreaterThanOrEqual(board.revision);
      return board;
    }
    if (Date.now() > deadline) throw new Error(`Board never reached the expected state: ${JSON.stringify(board.nodes.map((n) => n.id))}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);

/** The side panel, once it shows the node titled `title` (it re-renders a moment after a click). */
async function panelFor(page: Page, title: string) {
  const panel = page.getByRole("complementary", { name: "Selected node" });
  await panel.getByRole("heading", { name: title, exact: true }).waitFor();
  return panel;
}

/**
 * Drags a node by (dx, dy) screen pixels, grabbing it `grabY` px below its top (default: its centre).
 * React Flow starts a drag on the first move and doesn't count it, so that move is only a few pixels.
 */
async function dragBy(page: Page, id: string, dx: number, dy: number, grabY?: number) {
  const box = (await node(page, id).boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + (grabY ?? box.height / 2)];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 4, y);
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
}

describe.skipIf(!existsSync(join(webDir, "index.html")) || !chromiumPath)("canvas editing in a real browser (run `npm run build` first)", () => {
  // Boards shared by the steps below, so this suite manages its own temp dir
  // (test/helpers' tempRoot() is cleaned after every test).
  let root: string;
  let server: CanvasServer;
  let svc: BoardService;
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  const errors: string[] = [];

  async function openBoard(boardId: string, waitFor: string): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${server.url}/b/${boardId}`);
    await page.getByText("● live").waitFor();
    await node(page, waitFor).waitFor();
    return page;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "gabiro-edit-"));
    svc = new BoardService(root);
    server = await startCanvasServer({ root, port: 0, webDir, recordInfo: false });
    browser = await chromium.launch({ executablePath: chromiumPath });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    await rm(root, { recursive: true, force: true });
  });

  describe("an architecture board", () => {
    let page: Page;

    beforeAll(async () => {
      await svc.create({
        title: "Shop",
        kind: "architecture",
        ops: [
          { op: "add_node", id: "web", type: "client", label: "Web App" },
          { op: "add_node", id: "api", type: "service", label: "Checkout API" },
          { op: "add_node", id: "db", type: "database", label: "Orders DB" },
          { op: "add_edge", from: "web", to: "api", type: "sync" },
          { op: "add_edge", from: "api", to: "db", type: "sync" },
        ],
      });
      page = await openBoard("shop", "api");
    }, 30_000);

    it("drags a node and pins it where it was dropped", async () => {
      const before = (await svc.get("shop")).nodes.find((n) => n.id === "api")!.position!;
      await dragBy(page, "api", 120, 140);
      const saved = await until(page, svc, "shop", (b) => b.nodes.find((n) => n.id === "api")!.pinned === true);
      const after = saved.nodes.find((n) => n.id === "api")!.position!;
      expect(after.y).toBeGreaterThan(before.y + 50);
    }, 15_000);

    it("adds a node from the palette and renames it by double-clicking", async () => {
      await page.getByRole("toolbar").getByRole("button", { name: "cache", exact: true }).click();
      await until(page, svc, "shop", (b) => b.nodes.some((n) => n.id === "new-cache"));
      await node(page, "new-cache").dblclick();
      const label = (await panelFor(page, "New cache")).getByLabel("Label");
      await expect.poll(() => label.evaluate((el) => el === document.activeElement)).toBe(true);
      await label.fill("Redis");
      await label.press("Enter");
      await until(page, svc, "shop", (b) => b.nodes.find((n) => n.id === "new-cache")?.label === "Redis");
    }, 15_000);

    it("edits details in the side panel", async () => {
      await node(page, "db").click();
      const panel = await panelFor(page, "Orders DB");
      await panel.getByLabel("Tech").fill("PostgreSQL 16");
      await panel.getByLabel("Tech").press("Enter");
      await until(page, svc, "shop", (b) => b.nodes.find((n) => n.id === "db")?.tech === "PostgreSQL 16");
    }, 15_000);

    it("connects two nodes by dragging from a handle onto the other node", async () => {
      // Close the side panel (click empty canvas) and fit everything into view first.
      await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
      await page.getByRole("button", { name: "Fit View" }).click();
      await node(page, "db").hover();
      const handle = node(page, "db").locator(".react-flow__handle.source");
      const from = (await handle.boundingBox())!;
      const to = (await node(page, "new-cache").boundingBox())!;
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
      await page.mouse.up();
      await until(page, svc, "shop", (b) => b.edges.some((e) => e.from === "db" && e.to === "new-cache"));
    }, 15_000);

    it("deletes with the Delete key, then undoes and redoes", async () => {
      await node(page, "new-cache").click();
      await page.keyboard.press("Delete");
      await until(page, svc, "shop", (b) => !b.nodes.some((n) => n.id === "new-cache") && !b.edges.some((e) => e.to === "new-cache"));
      await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
      await page.keyboard.press("Control+z");
      const restored = await until(page, svc, "shop", (b) => b.nodes.some((n) => n.id === "new-cache"));
      expect(restored.nodes.find((n) => n.id === "new-cache")?.label).toBe("Redis");
      expect(restored.edges.some((e) => e.from === "db" && e.to === "new-cache")).toBe(true);
      await page.keyboard.press("Control+Shift+z");
      await until(page, svc, "shop", (b) => !b.nodes.some((n) => n.id === "new-cache"));
    }, 20_000);

    it("keeps editing after an agent changes the board (conflict re-applied)", async () => {
      await svc.applyChanges("shop", [{ op: "add_node", id: "agent-note", type: "sticky", label: "Agent was here" }]);
      await page.getByText("Agent was here").waitFor();
      await svc.applyChanges("shop", [{ op: "update_node", id: "agent-note", label: "Agent was here again" }]);
      // The page may not have the newest revision yet; the edit must still land.
      await node(page, "web").click();
      const panel = await panelFor(page, "Web App");
      await panel.getByLabel("Description").fill("SPA served by CDN");
      await panel.getByLabel("Label").click();
      await until(page, svc, "shop", (b) => b.nodes.find((n) => n.id === "web")?.description === "SPA served by CDN");
    }, 15_000);

    it("re-runs auto-layout without moving pinned nodes, and reported no page errors", async () => {
      const pinned = (await svc.get("shop")).nodes.find((n) => n.id === "api")!.position;
      const revision = (await svc.get("shop")).revision;
      await page.getByRole("button", { name: "Auto-layout" }).click();
      const after = await until(page, svc, "shop", (b) => b.revision > revision);
      expect(after.nodes.find((n) => n.id === "api")!.position).toEqual(pinned);
      expect(errors).toEqual([]);
    }, 15_000);
  });

  describe("kanban and sequence boards", () => {
    let page: Page;

    beforeAll(async () => {
      await svc.create({
        title: "Tasks",
        kind: "kanban",
        ops: [
          { op: "add_group", id: "todo", label: "To Do", type: "column" },
          { op: "add_group", id: "doing", label: "Doing", type: "column" },
          { op: "add_group", id: "done", label: "Done", type: "column" },
          { op: "add_node", id: "spec", type: "card", label: "Write spec", groupId: "todo", order: 1 },
          { op: "add_node", id: "core", type: "card", label: "Build core", groupId: "todo", order: 2 },
          { op: "add_node", id: "ship", type: "card", label: "Ship it", groupId: "todo", order: 3 },
          { op: "add_node", id: "idea", type: "card", label: "Pick a name", groupId: "done", order: 1 },
        ],
      });
      await svc.create({
        title: "Checkout",
        kind: "sequence",
        ops: [
          { op: "add_node", id: "client", type: "participant", label: "Client", order: 1 },
          { op: "add_node", id: "api", type: "participant", label: "API", order: 2 },
          { op: "add_node", id: "db", type: "participant", label: "DB", order: 3 },
          { op: "add_edge", from: "client", to: "api", type: "message", label: "POST /orders", order: 1 },
          { op: "add_edge", from: "api", to: "db", type: "message", label: "INSERT", order: 2 },
        ],
      });
      page = await openBoard("tasks", "ship");
    }, 30_000);

    it("drags a card into another column", async () => {
      const card = (await node(page, "ship").boundingBox())!;
      const column = (await node(page, "group:doing").boundingBox())!;
      await dragBy(page, "ship", column.x + column.width / 2 - (card.x + card.width / 2), 0);
      const saved = await until(page, svc, "tasks", (b) => b.nodes.find((n) => n.id === "ship")!.groupId === "doing");
      expect(saved.nodes.find((n) => n.id === "ship")!.order).toBe(1);
      expect(saved.nodes.filter((n) => n.groupId === "todo").map((n) => [n.id, n.order])).toEqual([
        ["spec", 1],
        ["core", 2],
      ]);
    }, 15_000);

    it("snaps a card dropped back into its own slot to its place, saving nothing", async () => {
      const { revision } = await until(page, svc, "tasks", (b) => b.nodes.find((n) => n.id === "ship")!.groupId === "doing");
      const home = (await node(page, "spec").boundingBox())!;
      await dragBy(page, "spec", 14, 10);
      await expect
        .poll(async () => {
          const now = (await node(page, "spec").boundingBox())!;
          return Math.abs(now.x - home.x) + Math.abs(now.y - home.y);
        }, { timeout: 1000 })
        .toBeLessThan(1);
      await new Promise((r) => setTimeout(r, 300));
      expect((await svc.get("tasks")).revision).toBe(revision);
    }, 15_000);

    it("drags the last sequence participant before the first to reorder them", async () => {
      await page.goto(`${server.url}/b/checkout`);
      await page.getByText("● live").waitFor();
      await node(page, "db").waitFor();
      const first = (await node(page, "client").boundingBox())!;
      const last = (await node(page, "db").boundingBox())!;
      await dragBy(page, "db", first.x - last.x - 60, 0, 20);
      const saved = await until(page, svc, "checkout", (b) => b.nodes.find((n) => n.id === "db")!.order === 1);
      const order = Object.fromEntries(saved.nodes.map((n) => [n.id, n.order]));
      expect(order).toEqual({ db: 1, client: 2, api: 3 });
      expect(errors).toEqual([]);
    }, 15_000);
  });
});
