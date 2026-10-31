import { defineConfig } from "vitest/config";

// The tests run the package from its sources (src/). The browser tests (*.browser.test.ts) build the
// page into a folder of their own and drive it with Playwright's Chromium; they are skipped when
// Chromium cannot be launched (`npx playwright install chromium` installs it).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: process.platform === "win32" ? 30_000 : 5_000,
    hookTimeout: process.platform === "win32" ? 30_000 : 10_000
  }
});
