import { defineConfig } from "vitest/config";

// Separate from vite.config.ts (whose root is web/) so tests run from the repo root.
export default defineConfig({
  root: ".",
  test: { include: ["test/**/*.test.ts"] },
});
