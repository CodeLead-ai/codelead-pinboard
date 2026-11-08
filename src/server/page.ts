import { createHash } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BoardRefusal } from "../core/index.js";

/**
 * The board's page: a React + Vite app whose sources are in src/page and whose build is in
 * dist/page (not in git; the package's `npm run build` makes it, and the package ships it). `serve`
 * builds it when the build is missing or older than its sources (a checkout of the package has the
 * build tools; `npm run build:page` does the same by hand), and serves the build's files, the
 * index with a Content-Security-Policy that allows the page's own scripts and nothing else.
 */
export interface PageLocation {
  /** The page's sources: index.html, vite.config.mts, src/. */
  source: string;
  /** The built page. */
  dist: string;
}

/** The package's name, as its package.json gives it. */
export const PACKAGE_NAME = "@codelead/pinboard";

/** The package this module belongs to (the folder of its package.json). */
function packageRoot(start: string): string | undefined {
  let current = start;
  for (;;) {
    const manifest = path.join(current, "package.json");
    if (fs.existsSync(manifest)) {
      try {
        if ((JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: unknown }).name === PACKAGE_NAME) return current;
      } catch {
        // Not a manifest this can read: keep looking above.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Where the page is, from this module (src/server, or dist/server once compiled): its sources in src/page, its build in dist/page. */
export function pageLocation(): PageLocation {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = packageRoot(here) ?? path.resolve(here, "..", "..");
  return { source: path.join(root, "src", "page"), dist: path.join(root, "dist", "page") };
}

function newestSource(dir: string): number {
  let newest = 0;
  const walk = (folder: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "dist" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

/** The files outside the page's folder that its build bundles: the core's rule of mentions, which the page shares. */
const SHARED_SOURCES = [["..", "core", "mentions.ts"]];

function sharedSourceTime(location: PageLocation): number {
  let newest = 0;
  for (const parts of SHARED_SOURCES) {
    try {
      newest = Math.max(newest, fs.statSync(path.join(location.source, ...parts)).mtimeMs);
    } catch {
      // Not there (an installed copy without the sources): nothing to compare.
    }
  }
  return newest;
}

/**
 * Whether the page can be built where it is: only a checkout of the package has the build tools
 * (its own node_modules/vite). An installed copy (under a host's node_modules) has the sources
 * and the build it ships, and a host's Vite, if any, lacks the page's plugins: it serves the
 * build it ships and never rebuilds.
 */
export function canBuildPage(location: PageLocation): boolean {
  return fs.existsSync(path.join(location.source, "..", "..", "node_modules", "vite"));
}

/** Why the page must be built before it is served, or undefined when its build is current (or cannot be rebuilt here). */
export function pageBuildReason(location: PageLocation): string | undefined {
  const index = path.join(location.dist, "index.html");
  if (!fs.existsSync(index)) return "the page is not built yet";
  if (!canBuildPage(location) || !fs.existsSync(path.join(location.source, "src"))) return undefined;
  return Math.max(newestSource(location.source), sharedSourceTime(location)) > fs.statSync(index).mtimeMs ? "the page's sources changed since it was built" : undefined;
}

/**
 * Builds the page with Vite into `outDir` (the location's dist by default). Always a production
 * build: Vite takes React's build from NODE_ENV, which a caller may have set otherwise (a test
 * runner sets "test"), so it is "production" for the length of the build.
 */
export async function buildPage(location: PageLocation, outDir: string = location.dist): Promise<void> {
  const cannot = new BoardRefusal(
    "usage",
    "The board's page is not built, and the tools to build it are not here (an installed copy serves the build it ships). In the Pinboard package's folder (@codelead/pinboard), run `npm install` and then `npm run build`."
  );
  if (!canBuildPage(location)) throw cannot;
  let vite: typeof import("vite");
  try {
    vite = await import("vite");
  } catch {
    throw cannot;
  }
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await vite.build({
      root: location.source,
      configFile: path.join(location.source, "vite.config.mts"),
      mode: "production",
      logLevel: "warn",
      build: { outDir, emptyOutDir: true }
    });
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }
}

/** Builds the page when its build is missing or older than its sources; says so through `say`. */
export async function ensurePageBuilt(location: PageLocation, say: (line: string) => void): Promise<void> {
  const reason = pageBuildReason(location);
  if (!reason) return;
  say(`Building the board's page (${reason})…`);
  await buildPage(location);
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8"
};

/** The page's own scripts by hash, the fonts from Google Fonts, the API on the same origin, images of the page only; no other source. */
export function contentSecurityPolicy(html: string): string {
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => `'sha256-${createHash("sha256").update(match[1]!, "utf8").digest("base64")}'`);
  return [
    "default-src 'self'",
    `script-src 'self'${inline.length > 0 ? ` ${inline.join(" ")}` : ""}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    // No remote image: an image in a card's text must not tell another server that the card was opened.
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    // The page may be framed by a VS Code webview (the CodeLead extension hosts the board as a tab, card #268/#286) and by
    // nothing else: the server listens on the loopback only, and a stranger's page framing it would still be refused.
    "frame-ancestors 'self' vscode-webview:"
  ].join("; ");
}

export class PageFiles {
  private index: { html: string; csp: string; mtime: number } | undefined;

  public constructor(public readonly dir: string) {}

  public get available(): boolean {
    return fs.existsSync(path.join(this.dir, "index.html"));
  }

  private readIndex(): { html: string; csp: string } | undefined {
    const file = path.join(this.dir, "index.html");
    let mtime: number;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      return undefined;
    }
    if (!this.index || this.index.mtime !== mtime) {
      const html = fs.readFileSync(file, "utf8");
      this.index = { html, csp: contentSecurityPolicy(html), mtime };
    }
    return this.index;
  }

  /** Serves a GET or HEAD for a path of the page; false when the path is no file of it. */
  public serve(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
    const head = req.method === "HEAD";
    if (pathname === "/" || pathname === "/index.html") {
      const index = this.readIndex();
      if (!index) {
        res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        res.end("The board's page is not built. In the Pinboard package's folder (@codelead/pinboard), run `npm run build`, then reload.\n");
        return true;
      }
      res.writeHead(200, {
        "Content-Type": TYPES[".html"]!,
        "Cache-Control": "no-cache",
        "Content-Security-Policy": index.csp,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer"
      });
      res.end(head ? undefined : index.html);
      return true;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    if (decoded.includes("\0")) return false;
    const file = path.resolve(this.dir, `.${decoded}`);
    const relative = path.relative(this.dir, file);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;
    const hashed = relative.split(path.sep)[0] === "assets";
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff"
    });
    if (head) res.end();
    else fs.createReadStream(file).pipe(res);
    return true;
  }
}
