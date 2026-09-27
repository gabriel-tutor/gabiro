import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

/**
 * A Chromium binary for browser tests: $GABIRO_CHROMIUM, the preinstalled /opt/pw-browsers/chromium,
 * or one installed by `npx playwright install chromium`. Undefined means browser tests are skipped.
 */
export function findChromium(): string | undefined {
  const candidates = [process.env.GABIRO_CHROMIUM, "/opt/pw-browsers/chromium"];
  try {
    candidates.push(chromium.executablePath());
  } catch {
    // playwright-core has no bundled browser registry entry; fine.
  }
  return candidates.find((p): p is string => !!p && existsSync(p));
}
