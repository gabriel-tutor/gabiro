import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The canvas web app lives in web/ and is built into dist/web, which `gabiro serve` serves.
// `npm run dev:web` serves it with hot reload and proxies the API to a running `gabiro serve`.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    proxy: {
      // The canvas server only accepts its own Host and Origin, so rewrite both.
      "/api": { target: "http://127.0.0.1:4477", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:4477", ws: true, changeOrigin: true, headers: { origin: "http://127.0.0.1:4477" } },
    },
  },
});
