import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The board's page, built into the package's dist/page by `npm run build` (or `npm run build:page`,
 * and by `pinboard serve` when the build is missing or older than these sources). Asset paths are
 * relative, so that the same build can be loaded by another host later (the VS Code extension's
 * webview).
 *
 * For work on the page itself, `npx vite src/page` serves these sources with the API proxied to a
 * `pinboard serve` running on its default port (7414).
 */
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../dist/page",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:7414",
        // The process answers only to its own Host and Origin: the proxy speaks as the page served by it.
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (request) => request.removeHeader("origin"));
        }
      }
    }
  }
});
