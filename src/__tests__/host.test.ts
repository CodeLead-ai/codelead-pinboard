import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBoardCommand, type BoardLog } from "../cli/index.js";
import { BoardSanitizer, boardContext, initBoard, type SanitizerFactory } from "../core/index.js";

const COMMANDS = ["init", "check", "list", "show", "new", "reply", "move", "set", "validate", "import", "tidy", "serve"];

const roots: string[] = [];
let exitCode: typeof process.exitCode;
afterEach(async () => {
  process.exitCode = exitCode;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A board of the test's own, in a repository of its own. */
async function board(): Promise<string> {
  exitCode = process.exitCode;
  const root = await mkdtemp(path.join(os.tmpdir(), "pinboard-host-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".git"));
  const dir = path.join(root, "docs", "codelead", "board");
  initBoard(boardContext({ dir, root, home: "/home/tester" }), { name: "test", participants: [{ id: "robin", kind: "person", name: "Robin" }, { id: "claude", kind: "agent", name: "Claude Code" }] });
  return dir;
}

/** A log that keeps what it is told. */
function recorder(): BoardLog & { said: string[]; warned: string[] } {
  const said: string[] = [];
  const warned: string[] = [];
  return { said, warned, say: (line) => said.push(line), warn: (line) => warned.push(line) };
}

/** Each command of a tree with its options and description, as its help gives them. */
function shapeOf(tree: ReturnType<typeof createBoardCommand>): Array<{ name: string; description: string; options: string[] }> {
  return tree.commands.map((command) => ({ name: command.name(), description: command.description(), options: command.options.map((option) => `${option.flags}: ${option.description}`) }));
}

describe("the command tree for a host and for the bin", () => {
  it("is the same commands, options and words under the host's name (board) and the bin's (pinboard)", () => {
    const hosted = createBoardCommand();
    const bin = createBoardCommand({ name: "pinboard" });
    expect([hosted.name(), bin.name()]).toEqual(["board", "pinboard"]);
    expect(hosted.commands.map((command) => command.name())).toEqual(COMMANDS);
    expect(shapeOf(bin)).toEqual(shapeOf(hosted));
    expect(bin.description()).toBe(hosted.description());
    expect(bin.helpInformation()).toContain("Usage: pinboard [options] [command]");
  });

  it("says a command's words through the host's log", async () => {
    const dir = await board();
    const log = recorder();
    await createBoardCommand({ log }).parseAsync(["list", "--board", dir], { from: "user" });
    expect(process.exitCode).toBe(0);
    expect(log.said.join("\n")).toBe(["Inbox (0)", "Backlog (0)", "Ideas (0)", "Pinned (0)", "In progress (0)", "For review (0)", "Done (0)"].join("\n"));
    expect(log.warned).toEqual([]);
  });

  it("guards every write with the host's sanitizer when it gives one: what it finds is refused (exit 1), in the guard's words", async () => {
    const dir = await board();
    const stricter: SanitizerFactory = (paths) => {
      const own = new BoardSanitizer(paths);
      return { text: (text) => own.text(text).replaceAll("hunter2", "<redacted>") };
    };
    const write = ["new", "--as", "robin", "--type", "note", "--title", "The login", "--body", "the password is hunter2", "--board", dir];
    const hosted = recorder();
    await createBoardCommand({ log: hosted, sanitizer: stricter }).parseAsync(write, { from: "user" });
    expect(process.exitCode).toBe(1);
    expect(hosted.said.join("\n")).toMatch(/^Refused: the description looks like it holds a secret/);
    expect(fs.readdirSync(path.join(dir, "items"))).toEqual([]);
    // The board's own sanitizer does not know the word: the same command writes the card.
    const plain = recorder();
    await createBoardCommand({ log: plain }).parseAsync(write, { from: "user" });
    expect(process.exitCode).toBe(0);
    expect(plain.said[0]).toMatch(/^Created #1 \(note\) in Inbox: The login/);
  });
});
