import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../", import.meta.url));
const CORE = path.join(SRC, "core");
const PAGE = path.join(SRC, "page");
const MANIFEST = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

/** Every module a file asks for: static imports, exports from, dynamic imports and requires. */
function importsOf(file: string): string[] {
  return ts.preProcessFile(fs.readFileSync(file, "utf8"), true, true).importedFiles.map((entry) => entry.fileName);
}

/** The source files under a folder, with the given extensions, leaving out tests and the folders named. */
function sourcesUnder(dir: string, extensions: string[], skip: string[] = []): string[] {
  const out: string[] = [];
  const walk = (folder: string): void => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules" || entry.name === "dist" || skip.includes(full)) continue;
        walk(full);
      } else if (extensions.some((extension) => entry.name.endsWith(extension))) out.push(full);
    }
  };
  walk(dir);
  return out;
}

const isNode = (specifier: string): boolean => specifier.startsWith("node:") || builtinModules.includes(specifier);
/** A package's name from a specifier: `@scope/name/sub` → `@scope/name`, `name/sub` → `name`. */
const packageOf = (specifier: string): string => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");

describe("the package's boundary", () => {
  it("the core imports nothing but itself and Node's own modules: the sanitizer is its own (sanitize.ts), a host's comes in through the options", () => {
    const files = sourcesUnder(CORE, [".ts"]);
    expect(files.length).toBeGreaterThan(5);
    expect(files.map((file) => path.basename(file))).toContain("sanitize.ts");
    const outside: string[] = [];
    for (const file of files) {
      for (const specifier of importsOf(file)) {
        if (isNode(specifier)) continue;
        if (!specifier.startsWith(".") || path.dirname(path.resolve(path.dirname(file), specifier)) !== CORE) outside.push(`${path.relative(SRC, file)}: ${specifier}`);
      }
    }
    expect(outside).toEqual([]);
  });

  it("the package's Node side (core, server, import, cli, the bin) imports nothing but itself, Node's modules and what its package.json declares; vite only to build the page", () => {
    const files = sourcesUnder(SRC, [".ts"], [PAGE]);
    expect(files.map((file) => path.relative(SRC, file))).toEqual(expect.arrayContaining(["cli.ts", "index.ts", path.join("cli", "board.ts"), path.join("server", "page.ts"), path.join("import", "importDocs.ts")]));
    const outside: string[] = [];
    const used = new Set<string>();
    for (const file of files) {
      for (const specifier of importsOf(file)) {
        if (isNode(specifier)) continue;
        if (specifier.startsWith(".")) {
          const target = path.resolve(path.dirname(file), specifier);
          if (path.relative(SRC, target).startsWith("..") || target.startsWith(PAGE)) outside.push(`${path.relative(SRC, file)}: ${specifier}`);
          continue;
        }
        const name = packageOf(specifier);
        used.add(name);
        // vite is a development dependency: page.ts imports it only to build a missing or stale page, and says so when it is not there.
        const declared = MANIFEST.dependencies?.[name] !== undefined || (name === "vite" && file === path.join(SRC, "server", "page.ts"));
        if (!declared) outside.push(`${path.relative(SRC, file)}: ${specifier}`);
      }
    }
    expect(outside).toEqual([]);
    expect([...used].sort()).toEqual(["commander", "vite"]);
  });

  it("depends on nothing of CodeLead's: no dependency of any kind names it", () => {
    const names = [...Object.keys(MANIFEST.dependencies ?? {}), ...Object.keys(MANIFEST.devDependencies ?? {}), ...Object.keys(MANIFEST.peerDependencies ?? {})];
    expect(names.filter((name) => /codelead/i.test(name))).toEqual([]);
    expect(Object.keys(MANIFEST.dependencies ?? {})).toEqual(["commander"]);
  });

  it("the page imports its own modules, its libraries, and of the rest only the core's rule of mentions and the process's contract", () => {
    const files = sourcesUnder(path.join(PAGE, "src"), [".tsx", ".ts"]);
    expect(files.length).toBeGreaterThan(5);
    const seen = new Set<string>();
    for (const file of files) {
      for (const specifier of importsOf(file)) {
        if (specifier.startsWith("./")) continue;
        seen.add(specifier.startsWith(".") ? path.relative(SRC, path.resolve(path.dirname(file), specifier)) : packageOf(specifier));
      }
    }
    expect([...seen].sort()).toEqual([path.join("core", "mentions.js"), "dompurify", "marked", "react", "react-dom", path.join("server", "contract.js")].sort());
  });

  it("would see an import from outside (the check itself is checked)", () => {
    const seen = ts.preProcessFile('import { x } from "../../patch/y.js";\nexport * from "./z.js";\nconst w = await import("chalk");', true, true).importedFiles.map((entry) => entry.fileName);
    expect(seen).toEqual(["../../patch/y.js", "./z.js", "chalk"]);
  });
});
