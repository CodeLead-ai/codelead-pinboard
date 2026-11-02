import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canBuildPage, pageBuildReason, type PageLocation } from "../server/page.js";

/** A package folder with the page's sources, its build (or not), and the build tools (or not). */
function packageFolder(options: { built: boolean; tools: boolean; sourcesNewer: boolean }): PageLocation {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pinboard-page-"));
  const source = path.join(root, "src", "page");
  const dist = path.join(root, "dist", "page");
  fs.mkdirSync(path.join(source, "src"), { recursive: true });
  fs.writeFileSync(path.join(source, "src", "main.tsx"), "export {};\n");
  if (options.built) {
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html>\n");
    const built = options.sourcesNewer ? Date.now() - 60_000 : Date.now() + 60_000;
    fs.utimesSync(path.join(dist, "index.html"), built / 1000, built / 1000);
  }
  if (options.tools) fs.mkdirSync(path.join(root, "node_modules", "vite"), { recursive: true });
  return { source, dist };
}

const made: string[] = [];
afterEach(() => {
  for (const location of made.splice(0)) fs.rmSync(path.resolve(location, "..", ".."), { recursive: true, force: true });
});

describe("the page's build decision", () => {
  it("an installed copy serves the build it ships, however the timestamps fell", () => {
    const location = packageFolder({ built: true, tools: false, sourcesNewer: true });
    made.push(location.source);
    expect(canBuildPage(location)).toBe(false);
    expect(pageBuildReason(location)).toBeUndefined();
  });

  it("a checkout rebuilds when its sources changed, and not otherwise", () => {
    const stale = packageFolder({ built: true, tools: true, sourcesNewer: true });
    const current = packageFolder({ built: true, tools: true, sourcesNewer: false });
    made.push(stale.source, current.source);
    expect(canBuildPage(stale)).toBe(true);
    expect(pageBuildReason(stale)).toBe("the page's sources changed since it was built");
    expect(pageBuildReason(current)).toBeUndefined();
  });

  it("a missing build is always a reason", () => {
    const location = packageFolder({ built: false, tools: false, sourcesNewer: false });
    made.push(location.source);
    expect(pageBuildReason(location)).toBe("the page is not built yet");
  });
});
