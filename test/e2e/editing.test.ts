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

/** Polls the saved board until `check` passes (edits are saved asynchronously). */
async function until(svc: BoardService, check: (b: Board) => boolean, timeoutMs = 5000): Promise<Board> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const board = await svc.get("shop");
    if (check(board)) return board;
    if (Date.now() > deadline) throw new Error(`Board never reached the expected state: ${JSON.stringify(board.nodes.map((n) => n.id))}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);

async function dragBy(page: Page, id: string, dx: number, dy: number) {
  const box = (await node(page, id).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 12 });
  await page.mouse.up();
}

describe.skipIf(!existsSync(join(webDir, "index.html")) || !chromiumPath)("canvas editing in a real browser (run `npm run build` first)", () => {
  // One board shared by the steps below, so this suite manages its own temp dir
  // (test/helpers' tempRoot() is cleaned after every test).
  let root: string;
  let server: CanvasServer;
  let svc: BoardService;
  let page: Page;
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  const errors: string[] = [];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "gabiro-edit-"));
    svc = new BoardService(root);
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
    server = await startCanvasServer({ root, port: 0, webDir, recordInfo: false });
    browser = await chromium.launch({ executablePath: chromiumPath });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${server.url}/b/shop`);
    await page.getByText("● live").waitFor();
    await node(page, "api").waitFor();
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    await rm(root, { recursive: true, force: true });
  });

  it("drags a node and pins it where it was dropped", async () => {
    const before = (await svc.get("shop")).nodes.find((n) => n.id === "api")!.position!;
    await dragBy(page, "api", 120, 140);
    const saved = await until(svc, (b) => b.nodes.find((n) => n.id === "api")!.pinned === true);
    const after = saved.nodes.find((n) => n.id === "api")!.position!;
    expect(after.y).toBeGreaterThan(before.y + 50);
  }, 15_000);

  it("adds a node from the palette and renames it by double-clicking", async () => {
    await page.getByRole("toolbar").getByRole("button", { name: "cache", exact: true }).click();
    await until(svc, (b) => b.nodes.some((n) => n.id === "new-cache"));
    await node(page, "new-cache").dblclick();
    const label = page.getByRole("complementary", { name: "Selected node" }).getByLabel("Label");
    await expect.poll(() => label.evaluate((el) => el === document.activeElement)).toBe(true);
    await label.fill("Redis");
    await label.press("Enter");
    await until(svc, (b) => b.nodes.find((n) => n.id === "new-cache")?.label === "Redis");
  }, 15_000);

  it("edits details in the side panel", async () => {
    await node(page, "db").click();
    const panel = page.getByRole("complementary", { name: "Selected node" });
    await panel.getByLabel("Tech").fill("PostgreSQL 16");
    await panel.getByLabel("Tech").press("Enter");
    await until(svc, (b) => b.nodes.find((n) => n.id === "db")?.tech === "PostgreSQL 16");
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
    await until(svc, (b) => b.edges.some((e) => e.from === "db" && e.to === "new-cache"));
  }, 15_000);

  it("deletes with the Delete key, then undoes and redoes", async () => {
    await node(page, "new-cache").click();
    await page.keyboard.press("Delete");
    await until(svc, (b) => !b.nodes.some((n) => n.id === "new-cache") && !b.edges.some((e) => e.to === "new-cache"));
    await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
    await page.keyboard.press("Control+z");
    const restored = await until(svc, (b) => b.nodes.some((n) => n.id === "new-cache"));
    expect(restored.nodes.find((n) => n.id === "new-cache")?.label).toBe("Redis");
    expect(restored.edges.some((e) => e.from === "db" && e.to === "new-cache")).toBe(true);
    await page.keyboard.press("Control+Shift+z");
    await until(svc, (b) => !b.nodes.some((n) => n.id === "new-cache"));
  }, 20_000);

  it("keeps editing after an agent changes the board (conflict re-applied)", async () => {
    await svc.applyChanges("shop", [{ op: "add_node", id: "agent-note", type: "sticky", label: "Agent was here" }]);
    await page.getByText("Agent was here").waitFor();
    await svc.applyChanges("shop", [{ op: "update_node", id: "agent-note", label: "Agent was here again" }]);
    // The page may not have the newest revision yet; the edit must still land.
    await node(page, "web").click();
    const panel = page.getByRole("complementary", { name: "Selected node" });
    await panel.getByLabel("Description").fill("SPA served by CDN");
    await panel.getByLabel("Label").click();
    await until(svc, (b) => b.nodes.find((n) => n.id === "web")?.description === "SPA served by CDN");
  }, 15_000);

  it("re-runs auto-layout without moving pinned nodes, and reported no page errors", async () => {
    const pinned = (await svc.get("shop")).nodes.find((n) => n.id === "api")!.position;
    const revision = (await svc.get("shop")).revision;
    await page.getByRole("button", { name: "Auto-layout" }).click();
    const after = await until(svc, (b) => b.revision > revision);
    expect(after.nodes.find((n) => n.id === "api")!.position).toEqual(pinned);
    expect(errors).toEqual([]);
  }, 15_000);
});
