#!/usr/bin/env node
/**
 * `pinboard`: the package's own bin. The same commands, words, exit codes and --json as a host's
 * `board` command (`codelead board …`), run from any repository that has a board folder
 * (`docs/codelead/board`), or with `--board <dir>`.
 */
import fs from "node:fs";
import { createBoardCommand } from "./cli/board.js";
import { consoleLog } from "./cli/log.js";

/** The package's version, from its package.json (one folder above dist/ and src/). */
function packageVersion(): string {
  try {
    const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const program = createBoardCommand({ name: "pinboard", log: consoleLog }).version(packageVersion());

program.parseAsync(process.argv).catch((error: unknown) => {
  consoleLog.warn(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
