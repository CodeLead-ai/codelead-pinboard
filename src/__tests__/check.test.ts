import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBoardCheck, type BoardCliDependencies } from "../cli/board.js";
import { addComment, appendEvents, boardContext, BoardRefusal, checkBoard, createCard, createCards, initBoard, markOpened, type BoardContext, type Participant } from "../core/index.js";

const PEOPLE: Participant[] = [
  { id: "robin", kind: "person", name: "Robin" },
  { id: "claude", kind: "agent", name: "Claude Code" }
];

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface TestBoard {
  ctx: BoardContext;
  dir: string;
  deps: BoardCliDependencies;
  /** What the commands printed, and empties the record. */
  said: () => string;
  tick: (seconds?: number) => void;
  read: (relative: string) => string;
  write: (relative: string, text: string) => void;
}

async function newBoard(): Promise<TestBoard> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pinboard-check-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".git"));
  const dir = path.join(root, "docs", "codelead", "board");
  let time = Date.parse("2026-10-04T10:00:00Z");
  const now = (): Date => new Date(time);
  const ctx = boardContext({ dir, root, home: "/home/tester", now });
  initBoard(ctx, { name: "test-workspace", participants: PEOPLE });
  const lines: string[] = [];
  return {
    ctx,
    dir,
    deps: { cwd: () => root, output: (line) => lines.push(line), now, home: "/home/tester" },
    said: () => lines.splice(0).join("\n"),
    tick: (seconds = 60) => {
      time += seconds * 1000;
    },
    read: (relative) => fs.readFileSync(path.join(dir, relative), "utf8"),
    write: (relative, text) => fs.writeFileSync(path.join(dir, relative), text, "utf8")
  };
}

/** Lets the file system's clock move past the last write: a reading that shares a tick of a coarse clock with a write takes no stamps. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

/** True when the last full reading left the files' stamps (cursors/.cards.json's `files`). */
function stamped(board: TestBoard): boolean {
  return JSON.parse(board.read("cursors/.cards.json")).files !== undefined;
}

/** The same board without the stamps: the next check reads every file. */
function forgetStamps(board: TestBoard): void {
  const { files: _files, ...rest } = JSON.parse(board.read("cursors/.cards.json")) as Record<string, unknown>;
  board.write("cursors/.cards.json", `${JSON.stringify(rest)}\n`);
}

/** What a piece of work did to the board's files: the files it read and the files it wrote, relative to the board folder. */
async function watched<T>(dir: string, work: () => T | Promise<T>): Promise<{ value: T; read: string[]; written: string[] }> {
  const target = fs as unknown as Record<string, (...args: unknown[]) => unknown>;
  const reads = vi.spyOn(target, "readFileSync");
  const writes = ["writeFileSync", "appendFileSync", "renameSync", "rmSync", "unlinkSync", "mkdirSync"].map((name) => vi.spyOn(target, name));
  const inBoard = (file: unknown): string[] => {
    const relative = path.relative(dir, String(file));
    return relative.startsWith("..") || path.isAbsolute(relative) ? [] : [relative.split(path.sep).join("/")];
  };
  try {
    const value = await work();
    return { value, read: reads.mock.calls.flatMap(([file]) => inBoard(file)), written: writes.flatMap((spy) => spy.mock.calls.flatMap(([file]) => inBoard(file))) };
  } finally {
    reads.mockRestore();
    for (const spy of writes) spy.mockRestore();
  }
}

const cardFiles = (files: string[]): string[] => files.filter((file) => file.startsWith("items/"));

describe("the check's economy: nothing new is told without reading a card file", () => {
  it("on a board of 200 cards, the check with nothing new reads no card file and no line of the log, writes nothing, says one line and exits 0", async () => {
    const board = await newBoard();
    createCards(
      board.ctx,
      "robin",
      Array.from({ length: 200 }, (_, index) => ({ type: "task", title: `Card ${index + 1}`, description: `What card ${index + 1} is about.` }))
    );
    await settle();
    // The first check reads the whole board, each file once, and takes the files' stamps.
    const first = await watched(board.dir, () => runBoardCheck({ as: "claude", ack: true }, board.deps));
    expect(first.value).toBe(0);
    expect(cardFiles(first.read)).toHaveLength(200);
    expect(new Set(cardFiles(first.read)).size).toBe(200);
    expect(first.read.filter((file) => file === "events.jsonl")).toHaveLength(1);
    expect(board.said().split("\n")[0]).toBe("claude: 200 new on 200 cards since the board began (no cursor yet).");
    expect(stamped(board)).toBe(true);

    board.tick(1800);
    const start = performance.now();
    const quiet = await watched(board.dir, () => runBoardCheck({ as: "claude" }, board.deps));
    const ms = performance.now() - start;
    expect(quiet.value).toBe(0);
    expect(board.said()).toBe("claude: nothing new since 2026-10-04T10:00:00Z. Next check in 30 minutes.");
    // board.json (the command's, then the check's), the cursor and this machine's state: no card file, not the log.
    expect(quiet.read).toEqual(["board.json", "board.json", "cursors/claude.json", "cursors/.cards.json"]);
    expect(quiet.written).toEqual([]);
    expect(ms).toBeLessThan(1000);

    // With --ack and nothing new: still no card file read; the cursor is the one file written (through its temporary file), and the lock.
    const acked = await watched(board.dir, () => runBoardCheck({ as: "claude", ack: true }, board.deps));
    expect(cardFiles(acked.read)).toEqual([]);
    expect(acked.read).not.toContain("events.jsonl");
    const files = acked.written.filter((file) => file !== "cursors").map((file) => (file.startsWith("cursors/.claude.json.") ? "cursors/.claude.json.<tmp>" : file));
    expect(new Set(files)).toEqual(new Set([".board.lock", "cursors/.claude.json.<tmp>"]));
    expect(JSON.parse(board.read("cursors/claude.json"))).toEqual({ seen: "2026-10-04T10:30:00Z", lines: 200 });
  });

  it("keeps check --json's shape: told from the stamps, the answer is the very JSON the full reading gives, with --ack too", async () => {
    const board = await newBoard();
    createCards(board.ctx, "robin", [
      { type: "task", title: "One" },
      { type: "idea", title: "Two" }
    ]);
    await settle();
    checkBoard(board.ctx, { as: "claude", ack: true });
    board.tick();

    const quiet = await watched(board.dir, () => runBoardCheck({ as: "claude", json: true }, board.deps));
    const told = board.said();
    expect(cardFiles(quiet.read)).toEqual([]);
    expect(JSON.parse(told)).toEqual({ participant: "claude", cursor: { seen: "2026-10-04T10:00:00Z", lines: 2 }, notifications: [], addressed: [], decided: [], groups: [], synthesized: [], after: 0, intervalMinutes: 30 });
    forgetStamps(board);
    const full = await watched(board.dir, () => runBoardCheck({ as: "claude", json: true }, board.deps));
    expect(cardFiles(full.read)).toHaveLength(2);
    expect(board.said()).toBe(told);

    // --ack: the same answer and the same cursor, either way.
    const cursor = board.read("cursors/claude.json");
    expect(await runBoardCheck({ as: "claude", ack: true, json: true }, board.deps)).toBe(0);
    const quietAck = board.said();
    const quietCursor = board.read("cursors/claude.json");
    board.write("cursors/claude.json", cursor);
    forgetStamps(board);
    const fullAck = await watched(board.dir, () => runBoardCheck({ as: "claude", ack: true, json: true }, board.deps));
    expect(cardFiles(fullAck.read)).toHaveLength(2);
    expect(board.said()).toBe(quietAck);
    expect(board.read("cursors/claude.json")).toBe(quietCursor);
    expect(JSON.parse(quietAck).acknowledged).toEqual({ seen: "2026-10-04T10:01:00Z", lines: 2 });
  });

  it("sees every change made after the stamps: a same-size edit with its time put back, a card that appears, one that goes, a line written by hand, the board's own write", async () => {
    const board = await newBoard();
    createCards(board.ctx, "robin", [
      { type: "task", title: "One" },
      { type: "task", title: "Two" },
      { type: "task", title: "Three" }
    ]);
    const restamp = async (): Promise<void> => {
      await settle();
      checkBoard(board.ctx, { as: "claude", ack: true });
      expect(stamped(board)).toBe(true);
    };

    // The same number of bytes, and the modification time set back (a whole second, so that it is set back exactly): the change time still moved.
    const file = path.join(board.dir, "items", "0001-one.md");
    const fixed = new Date("2026-10-04T09:00:00Z");
    fs.utimesSync(file, fixed, fixed);
    await restamp();
    const before = fs.statSync(file);
    board.write("items/0001-one.md", board.read("items/0001-one.md").replace("column: inbox", "column: ideas"));
    fs.utimesSync(file, fixed, fixed);
    const after = fs.statSync(file);
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
    expect(after.ctimeMs).not.toBe(before.ctimeMs);
    const edited = checkBoard(board.ctx, { as: "claude" });
    expect(edited.synthesized.map((event) => [event.by, event.item, event.kind, event.data])).toEqual([["unknown", 1, "item.updated", { synthesized: true, fields: ["column"] }]]);
    // A reading that wrote an event leaves no stamps: they would not be the files as they are.
    expect(stamped(board)).toBe(false);

    // A card file that appears.
    await restamp();
    board.write("items/0009-by-hand.md", '---\nid: 9\ntype: note\ntitle: "By hand"\ncolumn: backlog\ntags: []\nauthor: robin\ncreated: 2026-10-04T09:00:00Z\nupdated: 2026-10-04T09:00:00Z\n---\n\nWritten by hand.\n\n## Thread\n');
    expect(checkBoard(board.ctx, { as: "claude" }).synthesized.map((event) => [event.item, event.kind])).toEqual([[9, "item.created"]]);

    // A card file that goes: the full reading runs and forgets it.
    await restamp();
    fs.rmSync(path.join(board.dir, "items", "0003-three.md"));
    expect(checkBoard(board.ctx, { as: "claude" }).notifications).toEqual([]);
    expect(Object.keys(JSON.parse(board.read("cursors/.cards.json")).cards)).not.toContain("3");

    // A line another agent appended by hand.
    await restamp();
    appendEvents(board.dir, [{ at: "2026-10-04T10:05:00Z", by: "robin", item: 2, kind: "tag.added", data: { tag: "w5" } }]);
    expect(checkBoard(board.ctx, { as: "claude" }).notifications.map((event) => [event.item, event.kind])).toEqual([[2, "tag.added"]]);

    // The board's own write drops the stamps at once.
    await restamp();
    addComment(board.ctx, 2, { as: "robin", body: "On two." });
    expect(stamped(board)).toBe(false);
    expect(checkBoard(board.ctx, { as: "claude" }).notifications.map((event) => [event.item, event.kind])).toEqual([[2, "comment.added"]]);
  });

  it("takes no stamps from a reading that a file's time does not precede (a coarse clock's same tick): the next check reads the files again", async () => {
    const board = await newBoard();
    createCards(board.ctx, "robin", [
      { type: "task", title: "One" },
      { type: "task", title: "Two" },
      { type: "task", title: "Three" }
    ]);
    await settle();
    const file = path.join(board.dir, "items", "0002-two.md");
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file, later, later);
    checkBoard(board.ctx, { as: "claude", ack: true });
    expect(stamped(board)).toBe(false);
    expect(cardFiles((await watched(board.dir, () => checkBoard(board.ctx, { as: "claude" }))).read)).toHaveLength(3);
    // Once every file's time is behind the reading's, it takes them, and the check after reads none.
    const earlier = new Date(Date.now() - 60_000);
    fs.utimesSync(file, earlier, earlier);
    await settle();
    checkBoard(board.ctx, { as: "claude" });
    expect(stamped(board)).toBe(true);
    expect(cardFiles((await watched(board.dir, () => checkBoard(board.ctx, { as: "claude" }))).read)).toEqual([]);
  });

  it("answers a participant whose cursor is behind from the log, as before", async () => {
    const board = await newBoard();
    createCard(board.ctx, "claude", { type: "idea", title: "Cache the reads" });
    await settle();
    checkBoard(board.ctx, { as: "claude", ack: true });
    expect(stamped(board)).toBe(true);
    // Robin has no cursor: claude's card is news to him, though nothing changed since the stamps.
    expect(checkBoard(board.ctx, { as: "robin" }).notifications.map((event) => [event.by, event.kind])).toEqual([["claude", "item.created"]]);
  });
});

describe("check --since: a look from a time instead of the cursor", () => {
  async function history(): Promise<TestBoard> {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "One" });
    board.tick(3600);
    createCard(board.ctx, "robin", { type: "task", title: "Two" });
    board.tick();
    addComment(board.ctx, 1, { as: "claude", body: "On one." });
    board.tick();
    addComment(board.ctx, 2, { as: "robin", body: "On two." });
    checkBoard(board.ctx, { as: "claude", ack: true });
    markOpened(board.ctx, "claude", 2);
    return board;
  }

  it("lists the events by others after the time, the cards opened since included, and leaves the cursor where it is", async () => {
    const board = await history();
    const cursor = board.read("cursors/claude.json");
    expect(checkBoard(board.ctx, { as: "claude" }).notifications).toEqual([]);
    const look = checkBoard(board.ctx, { as: "claude", since: "2026-10-04T10:30:00Z" });
    expect(look.since).toBe("2026-10-04T10:30:00Z");
    expect(look.after).toBe(3);
    expect(look.notifications.map((event) => [event.at, event.by, event.item, event.kind])).toEqual([
      ["2026-10-04T11:00:00Z", "robin", 2, "item.created"],
      ["2026-10-04T11:02:00Z", "robin", 2, "comment.added"]
    ]);
    expect(board.read("cursors/claude.json")).toBe(cursor);
    expect(Object.keys(look).slice(0, 4)).toEqual(["participant", "cursor", "since", "notifications"]);
  });

  it("takes a day or a UTC time on the command line, and refuses anything else, or --since with --ack", async () => {
    const board = await history();
    expect(await runBoardCheck({ as: "claude", since: "2026-10-04" }, board.deps)).toBe(0);
    expect(board.said().split("\n")[0]).toBe("claude: 3 new on 2 cards since 2026-10-04T00:00:00Z.");
    expect(await runBoardCheck({ as: "claude", since: "2026-10-04T11:01:30+00:00", json: true }, board.deps)).toBe(0);
    expect(JSON.parse(board.said())).toMatchObject({ since: "2026-10-04T11:01:30Z", after: 1, notifications: [{ item: 2, kind: "comment.added" }] });
    expect(await runBoardCheck({ as: "claude", since: "yesterday" }, board.deps)).toBe(2);
    expect(board.said()).toBe('"yesterday" is not a time: give a UTC time like 2026-10-06T09:00:00Z, or a day like 2026-10-06.');
    expect(await runBoardCheck({ as: "claude", since: "2026-10-04", ack: true }, board.deps)).toBe(2);
    expect(board.said()).toBe("check takes --since or --ack, not both: --since looks from a time and leaves the cursor where it is.");
    const refused = (work: () => unknown): string => {
      try {
        work();
      } catch (error) {
        if (error instanceof BoardRefusal) return error.message;
        throw error;
      }
      throw new Error("expected a refusal");
    };
    expect(refused(() => checkBoard(board.ctx, { as: "claude", since: "soon" }))).toBe('Refused: "soon" is not a UTC time like 2026-10-06T09:00:00Z. Nothing was written.');
    expect(refused(() => checkBoard(board.ctx, { as: "claude", since: "2026-10-04T10:00:00Z", ack: true }))).toBe(
      "Refused: a check reads from a time (since) or moves the cursor to the end (ack), not both. Nothing was written."
    );
  });
});
