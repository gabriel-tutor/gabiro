import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { appLink } from "../../src/server/index.js";
import { tempRoot } from "../helpers.js";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const electronPath = createRequire(import.meta.url)("electron") as unknown as string;
const built = existsSync(join(repo, "desktop/dist/main.js")) && existsSync(join(repo, "dist/web/index.html"));
const hasDisplay = process.platform === "darwin" || process.platform === "win32" || !!process.env.DISPLAY;

let app: ElectronApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function launch(userData: string, extraArgs: string[] = []) {
  app = await _electron.launch({
    executablePath: electronPath,
    // Chromium's Linux sandbox can't start as root or under Ubuntu's AppArmor rules on CI runners.
    args: [...(process.platform === "linux" ? ["--no-sandbox"] : []), repo, ...extraArgs],
    env: { ...process.env, GABIRO_USER_DATA: userData, GABIRO_NO_BROWSER: "1" },
  });
  return app;
}

/** The window whose URL matches, once it exists. */
async function windowMatching(electron: ElectronApplication, pattern: RegExp): Promise<Page> {
  await expect.poll(() => electron.windows().some((w) => pattern.test(w.url())), { timeout: 10_000 }).toBe(true);
  return electron.windows().find((w) => pattern.test(w.url()))!;
}

async function project(dir: string, name: string) {
  const root = join(dir, name);
  await mkdir(join(root, ".gabiro", "boards"), { recursive: true });
  return root;
}

describe.skipIf(!built || !hasDisplay)("Gabiro desktop app (run `npm run build && npm run desktop:build` first)", { timeout: 60_000 }, () => {
  it("lists recent projects in the start window and opens one into its live canvas", async () => {
    const dir = await realpath(await tempRoot());
    const root = await project(dir, "shop");
    const userData = join(dir, "userData");
    await mkdir(userData);
    await writeFile(join(userData, "recent.json"), JSON.stringify([{ root, openedAt: "2026-01-01T00:00:00.000Z" }]));

    const electron = await launch(userData);
    const start = await windowMatching(electron, /start\.html$/);
    await expect.poll(() => start.locator(".name").allTextContents()).toEqual(["shop"]);
    await expect.poll(() => start.locator(".boards").allTextContents()).toEqual(["0 boards"]);
    // The logo loads under the start window's CSP.
    await expect.poll(() => start.locator(".logo").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

    await start.locator(".project").click();
    const canvas = await windowMatching(electron, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    await expect.poll(() => canvas.locator(".gb-header h1").textContent()).toBe("gabiro");
    // Inside the app the header offers a way back to the start window.
    await expect.poll(() => canvas.locator(".gb-switch").count()).toBe(1);

    // The app records its server so agents reuse it.
    const info = JSON.parse(await readFile(join(root, ".gabiro", "server.json"), "utf8"));
    expect(canvas.url()).toBe(`${info.url}/`);
    expect(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()))).toEqual(["shop — Gabiro"]);

    // "Switch project" brings the start window back; the canvas window stays on its page. (A DOM click:
    // Playwright's click() would wait for the gabiro:// navigation the app cancels.)
    await canvas.evaluate(() => document.querySelector<HTMLElement>(".gb-switch")!.click());
    await windowMatching(electron, /start\.html$/);
    expect(canvas.url()).toBe(`${info.url}/`);
  });

  it("asks before opening a folder from a link, and opens the board once confirmed", async () => {
    const dir = await realpath(await tempRoot());
    const root = await project(dir, "stranger");
    const userData = join(dir, "userData");
    const electron = await launch(userData);
    await windowMatching(electron, /start\.html$/);

    // Answer the native confirmation from the test: first Cancel, then Open.
    const ask = (answer: number, link: string) =>
      electron.evaluate(
        async ({ app, dialog }, [answer, link]) => {
          const asked: string[] = [];
          dialog.showMessageBox = (async (...args: unknown[]) => {
            const options = args[args.length - 1] as { message: string };
            asked.push(options.message);
            return { response: answer, checkboxChecked: false };
          }) as typeof dialog.showMessageBox;
          app.emit("open-url", { preventDefault() {} }, link);
          await new Promise((r) => setTimeout(r, 500));
          return asked;
        },
        [answer, link] as const,
      );

    expect(await ask(1, appLink(root, "orders"))).toEqual([`Open the project at ${root} in Gabiro?`]);
    expect(electron.windows().some((w) => w.url().startsWith("http"))).toBe(false);

    expect(await ask(0, appLink(root, "orders"))).toEqual([`Open the project at ${root} in Gabiro?`]);
    await windowMatching(electron, /^http:\/\/127\.0\.0\.1:\d+\/b\/orders$/);

    // Now it is a recent project, so a second link opens without asking.
    expect(await ask(1, appLink(root))).toEqual([]);
  });
});
