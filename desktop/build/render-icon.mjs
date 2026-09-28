// Renders desktop/build/icon.svg to the 1024x1024 icon.png that electron-builder turns into the app icon.
// Run after editing the SVG: `npm run icon`. Uses Chromium from $GABIRO_CHROMIUM, /opt/pw-browsers/chromium,
// or `npx playwright-core install chromium`.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const svg = fileURLToPath(new URL("icon.svg", import.meta.url));
const png = fileURLToPath(new URL("icon.png", import.meta.url));

const candidates = [process.env.GABIRO_CHROMIUM, "/opt/pw-browsers/chromium"];
try {
  candidates.push(chromium.executablePath());
} catch {
  // No bundled browser registered with playwright-core.
}
const executablePath = candidates.find((p) => p && existsSync(p));
if (!executablePath) {
  console.error("No Chromium found. Set GABIRO_CHROMIUM or run `npx playwright-core install chromium`.");
  process.exit(1);
}

const browser = await chromium.launch({ executablePath });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  await page.setContent(`<body style="margin:0;background:transparent">${await readFile(svg, "utf8")}</body>`);
  await page.locator("svg").screenshot({ path: png, omitBackground: true });
  console.log(`Wrote ${png}`);
} finally {
  await browser.close();
}
