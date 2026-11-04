import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runBoardCheck, runBoardInit, runBoardNew, runBoardSet, runBoardShow, runBoardTidy, type BoardCliDependencies } from "../cli/board.js";
import {
  addComment,
  boardContext,
  BoardRefusal,
  cardRanks,
  checkBoard,
  createCard,
  createCards,
  describeEvent,
  eventLines,
  getCard,
  initBoard,
  listCards,
  moveCard,
  parseCardText,
  readBoardConfig,
  readEvents,
  TYPE_FIELDS,
  updateCard,
  validateBoard,
  type BoardContext,
  type Participant
} from "../core/index.js";
import { importDocuments, tidyImported, withoutTitleLead } from "../import/index.js";
import { createBoardServer, type BoardPayload, type NotificationsPayload, type RefusalPayload, type WritePayload } from "../server/index.js";

/**
 * Package 2b, the polish pass: the card's colour, a decision's ask, the order inside a column, a
 * comment and a move in one notification line, the page's check that leaves hand edits to the
 * watcher, and the tidy of the imported cards; through the core, the commands and the process.
 */
const PEOPLE: Participant[] = [
  { id: "robin", kind: "person", name: "Robin" },
  { id: "claude", kind: "agent", name: "Claude Code" }
];

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function temporary(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

interface TestBoard {
  ctx: BoardContext;
  dir: string;
  root: string;
  tick: (seconds?: number) => void;
  read: (relative: string) => string;
  write: (relative: string, text: string) => void;
  fileOf: (id: number) => string;
}

async function newBoard(): Promise<TestBoard> {
  const root = await temporary("pinboard-2b-");
  fs.mkdirSync(path.join(root, ".git"));
  const dir = path.join(root, "docs", "codelead", "board");
  let time = Date.parse("2026-10-05T10:00:00Z");
  const ctx = boardContext({ dir, root, home: "/home/tester", now: () => new Date(time) });
  initBoard(ctx, { name: "test-workspace", participants: PEOPLE });
  return {
    ctx,
    dir,
    root,
    tick: (seconds = 60) => {
      time += seconds * 1000;
    },
    read: (relative) => fs.readFileSync(path.join(dir, relative), "utf8"),
    write: (relative, text) => {
      fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
      fs.writeFileSync(path.join(dir, relative), text, "utf8");
    },
    fileOf: (id) => {
      const name = fs.readdirSync(path.join(dir, "items")).find((entry) => entry.startsWith(`${String(id).padStart(4, "0")}-`));
      if (!name) throw new Error(`no file for card ${id}`);
      return `items/${name}`;
    }
  };
}

function refusal(work: () => unknown): BoardRefusal {
  try {
    work();
  } catch (error) {
    if (error instanceof BoardRefusal) return error;
    throw error;
  }
  throw new Error("expected a refusal, and the work was done");
}

/** A column's card ids from the top, in the order the page shows them. */
function columnOrder(board: TestBoard, column: string): number[] {
  const cards = listCards(board.ctx).cards;
  const ranks = cardRanks(readEvents(board.dir).events, cards);
  return cards
    .filter((card) => card.column === column)
    .sort((left, right) => ranks.get(String(right.id))! - ranks.get(String(left.id))!)
    .map((card) => Number(card.id));
}

const PALETTE_WORDS = "#b33f40 (red), #ed944d (orange), #edd94c (yellow), #48a14d (green) and #6577b3 (blue)";

const handCard = (id: number, extra: string): string =>
  `---\nid: ${id}\ntype: decision\ntitle: "Card ${id}"\ncolumn: pinned\ntags: []\n${extra}author: robin\ncreated: 2026-10-05T09:00:00Z\nupdated: 2026-10-05T09:00:00Z\n---\n\nWritten by hand.\n\n## Thread\n`;

// ---------------------------------------------------------------------------------------------

describe("a card's colour: the person's mark, one of five", () => {
  it("is written as its hex in quotes, set by its hex or its name, removed with none; each change one item.updated naming color", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "One" });
    board.tick();
    const set = updateCard(board.ctx, 1, { as: "robin", changes: { color: "red" } });
    expect(set.events).toEqual([{ at: "2026-10-05T10:01:00Z", by: "robin", item: 1, kind: "item.updated", data: { fields: ["color"] } }]);
    expect(describeEvent(set.events[0]!)).toBe("changed its color");
    expect(board.read(board.fileOf(1))).toContain('tags: [by:robin]\ncolor: "#b33f40"\nauthor: robin\n');
    expect(getCard(board.ctx, 1).card.color).toBe("#b33f40");
    // The same colour, written another way: nothing to change, nothing written.
    expect(updateCard(board.ctx, 1, { as: "robin", changes: { color: "#B33F40" } }).events).toEqual([]);
    expect(updateCard(board.ctx, 1, { as: "robin", changes: { color: "48a14d" } }).card.color).toBe("#48a14d");
    const removed = updateCard(board.ctx, 1, { as: "robin", changes: { color: "none" } });
    expect(removed.events.map((event) => event.data)).toEqual([{ fields: ["color"] }]);
    expect(board.read(board.fileOf(1))).not.toContain("color:");
    expect(updateCard(board.ctx, 1, { as: "robin", changes: { color: null } }).events).toEqual([]);

    const before = board.read(board.fileOf(1));
    const wrong = refusal(() => updateCard(board.ctx, 1, { as: "robin", changes: { color: "#123456" } }));
    expect(wrong.code).toBe("usage");
    expect(wrong.message).toBe(`Refused: "#123456" is not a card colour; the colours are ${PALETTE_WORDS}, or none. Nothing was written.`);
    expect(board.read(board.fileOf(1))).toBe(before);
    // A new card may carry one from the start.
    expect(createCard(board.ctx, "robin", { type: "idea", title: "Two", color: "blue" }).card.color).toBe("#6577b3");
  });

  it("is read only as one of the five, in double quotes: anything else is a problem the card names", async () => {
    expect(parseCardText(handCard(1, 'color: "#123456"\n')).problems).toEqual([`"color" must be one of ${PALETTE_WORDS}, in double quotes, and is "#123456"`]);
    expect(parseCardText(handCard(1, "color: red\n")).problems).toEqual([`"color" must be one of ${PALETTE_WORDS}, in double quotes, and is "red"`]);
    expect(parseCardText(handCard(1, "color: #b33f40\n")).problems).toEqual(['"color" is written without quotes, and YAML reads a # after a space as a comment: write it as color: "#b33f40"']);
    expect(parseCardText(handCard(1, 'color: "#B33F40"\n'))).toMatchObject({ problems: [], card: { color: "#b33f40" } });

    const board = await newBoard();
    board.write("items/0001-card-1.md", handCard(1, 'color: "#ED944D"\n'));
    board.write("items/0002-card-2.md", handCard(2, "color: #48a14d\n"));
    expect(validateBoard(board.ctx).problems).toEqual([
      { file: "items/0002-card-2.md", message: '"color" is written without quotes, and YAML reads a # after a space as a comment: write it as color: "#b33f40"' }
    ]);
    // A write elsewhere on the card keeps the colour's line as it was written.
    addComment(board.ctx, 1, { as: "claude", body: "Read it." });
    expect(board.read("items/0001-card-1.md")).toContain('color: "#ED944D"\n');
    // Changed by hand without an event: announced by unknown, naming the colour.
    checkBoard(board.ctx, { as: "claude", ack: true });
    board.write("items/0001-card-1.md", board.read("items/0001-card-1.md").replace('color: "#ED944D"', 'color: "#6577b3"'));
    expect(checkBoard(board.ctx, { as: "claude" }).synthesized.map((event) => event.data)).toEqual([{ synthesized: true, fields: ["color"] }]);
  });
});

describe("a decision's ask: what the person is asked to decide, on the card", () => {
  it("is the decision's first field; set or removed, one item.updated naming ask", async () => {
    expect(TYPE_FIELDS.decision).toEqual(["ask", "options", "recommendation", "decided", "consequences"]);
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "decision", title: "The cache", column: "pinned", fields: { options: ["a TTL", "a version key"] } });
    board.tick();
    const asked = updateCard(board.ctx, 1, { as: "claude", changes: { fields: { ask: "  Pick the cache: a TTL or a version key.\r\nI recommend the TTL.  " } } });
    expect(asked.events).toEqual([{ at: "2026-10-05T10:01:00Z", by: "claude", item: 1, kind: "item.updated", data: { fields: ["ask"] } }]);
    expect(describeEvent(asked.events[0]!)).toBe("changed its ask");
    expect(asked.card.fields).toEqual({ ask: "Pick the cache: a TTL or a version key.\nI recommend the TTL.", options: ["a TTL", "a version key"] });
    expect(board.read(board.fileOf(1))).toContain('fields:\n  ask: |-\n    Pick the cache: a TTL or a version key.\n    I recommend the TTL.\n  options: ["a TTL", "a version key"]\n');
    // The ask and another field in one change: both named.
    expect(updateCard(board.ctx, 1, { as: "claude", changes: { fields: { ask: "Pick the cache: a TTL or a version key; I recommend the TTL.", recommendation: "a TTL" } } }).events[0]!.data).toEqual({ fields: ["ask", "fields"] });
    // An empty ask is no ask.
    const removed = updateCard(board.ctx, 1, { as: "robin", changes: { fields: { ask: "   " } } });
    expect(removed.events[0]!.data).toEqual({ fields: ["ask"] });
    expect(removed.card.fields).toEqual({ options: ["a TTL", "a version key"], recommendation: "a TTL" });
    // A hand edit of the ask is announced by unknown, naming the ask.
    checkBoard(board.ctx, { as: "claude", ack: true });
    board.write(board.fileOf(1), board.read(board.fileOf(1)).replace("fields:\n", 'fields:\n  ask: "Written by hand."\n'));
    expect(checkBoard(board.ctx, { as: "claude" }).synthesized.map((event) => event.data)).toEqual([{ synthesized: true, fields: ["ask"] }]);
  });

  it("refuses an ask that is not a text or longer than one to three sentences can be, in words, and writes nothing", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "decision", title: "The cache", column: "pinned" });
    const before = board.read(board.fileOf(1));
    expect(refusal(() => updateCard(board.ctx, 1, { as: "claude", changes: { fields: { ask: ["a", "b"] } } })).message).toBe(
      'Refused: the ask must be a text (what is decided, the options, the recommendation), and is ["a","b"]. Nothing was written.'
    );
    expect(refusal(() => updateCard(board.ctx, 1, { as: "claude", changes: { fields: { ask: "word ".repeat(130) } } })).message).toBe(
      "Refused: the ask is 649 characters; it says in one to three sentences what is decided, the options and the recommendation (at most 600 characters), and the details go in the description. Nothing was written."
    );
    expect(board.read(board.fileOf(1))).toBe(before);
    expect(refusal(() => createCard(board.ctx, "robin", { type: "decision", title: "Too long", fields: { ask: "x".repeat(601) } })).code).toBe("usage");
    expect(createCard(board.ctx, "robin", { type: "decision", title: "Blank", fields: { ask: " ", options: ["A"] } }).card.fields).toEqual({ options: ["A"] });
    // A hand-written ask that is no text is a problem of the card.
    expect(parseCardText(handCard(9, "fields:\n  ask: [one, two]\n")).problems).toEqual(['"fields.ask" must be a text (what is decided, the options, the recommendation), and is ["one","two"]']);
  });
});

describe("a column's order, read from the event log", () => {
  it("puts an arrival on top, keeps a card in place while it changes, and puts a dropped card below the card it was dropped under", async () => {
    const board = await newBoard();
    createCards(board.ctx, "robin", [
      { type: "task", title: "A", column: "backlog" },
      { type: "task", title: "B", column: "backlog" },
      { type: "task", title: "C", column: "backlog" },
      { type: "task", title: "D", column: "inbox" }
    ]);
    expect(columnOrder(board, "backlog")).toEqual([3, 2, 1]);
    board.tick();
    // A comment, an edit: nothing moves.
    addComment(board.ctx, 1, { as: "claude", body: "On A." });
    updateCard(board.ctx, 2, { as: "robin", changes: { title: "B, renamed" } });
    expect(columnOrder(board, "backlog")).toEqual([3, 2, 1]);
    // Dropped under B.
    const dropped = moveCard(board.ctx, 4, { as: "robin", to: "backlog", after: 2 });
    expect(dropped.events.map((event) => event.data)).toEqual([{ from: "inbox", to: "backlog", after: 2 }]);
    expect(columnOrder(board, "backlog")).toEqual([3, 2, 4, 1]);
    // Inside its own column: to the top, then under D.
    const top = moveCard(board.ctx, 1, { as: "robin", to: "backlog", after: null });
    expect(top.events.map((event) => [event.kind, event.data])).toEqual([["item.moved", { from: "backlog", to: "backlog" }]]);
    expect(describeEvent(top.events[0]!, readBoardConfig(board.dir).config)).toBe("moved it to the top of Backlog");
    expect(columnOrder(board, "backlog")).toEqual([1, 3, 2, 4]);
    const under = moveCard(board.ctx, 3, { as: "robin", to: "backlog", after: 4 });
    expect(describeEvent(under.events[0]!, readBoardConfig(board.dir).config)).toBe("moved it below #4 in Backlog");
    expect(columnOrder(board, "backlog")).toEqual([1, 2, 4, 3]);
    // Without a place, a move inside its column writes nothing, as before.
    expect(moveCard(board.ctx, 2, { as: "robin", to: "backlog" }).events).toEqual([]);
    // A place that names no card of the column: across columns the card goes to the top; inside its column nothing is written.
    expect(moveCard(board.ctx, 2, { as: "robin", to: "backlog", after: 99 }).events).toEqual([]);
    createCard(board.ctx, "robin", { type: "task", title: "E", column: "ideas" });
    expect(moveCard(board.ctx, 5, { as: "robin", to: "backlog", after: 99 }).events.map((event) => event.data)).toEqual([{ from: "ideas", to: "backlog" }]);
    expect(columnOrder(board, "backlog")).toEqual([5, 1, 2, 4, 3]);
    // An agent places a card only in a column it may move cards into.
    createCard(board.ctx, "robin", { type: "task", title: "F", column: "pinned" });
    expect(refusal(() => moveCard(board.ctx, 6, { as: "claude", to: "pinned", after: null })).code).toBe("column");
  });

  it("places a card moved by hand, with no move event, as of its last event", async () => {
    const board = await newBoard();
    createCards(board.ctx, "robin", [
      { type: "task", title: "A", column: "backlog" },
      { type: "task", title: "B", column: "backlog" },
      { type: "task", title: "C", column: "inbox" }
    ]);
    board.tick();
    board.write(board.fileOf(3), board.read(board.fileOf(3)).replace("column: inbox", "column: backlog"));
    checkBoard(board.ctx, { as: "claude" });
    expect(columnOrder(board, "backlog")).toEqual([3, 2, 1]);
  });
});

describe("the notification's words and the check", () => {
  it("say a comment and a move written in one step in one line, and every other event in its own", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "One" });
    board.tick();
    const moved = moveCard(board.ctx, 1, { as: "claude", to: "for-review", comment: "Landed: abc1234." });
    board.tick();
    const commented = addComment(board.ctx, 1, { as: "claude", body: "And the evidence record." });
    const { config } = readBoardConfig(board.dir);
    expect(eventLines([...moved.events, ...commented.events], config).map((line) => line.text)).toEqual([
      "commented and moved it to For review: Landed: abc1234.",
      "commented: And the evidence record."
    ]);
    // Newest first, as the list shows them: still one line.
    expect(eventLines([...moved.events].reverse(), config).map((line) => [line.events.length, line.text])).toEqual([[2, "commented and moved it to For review: Landed: abc1234."]]);
  });

  it("pairs the comment with the move of its own step, not with a plain move of the same second", async () => {
    // An agent moves a card to In progress and, within the same second, lands it with a comment:
    // the comment belongs to the second move, in both orders of the list.
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "One" });
    board.tick();
    const started = moveCard(board.ctx, 1, { as: "claude", to: "in-progress" });
    const landed = moveCard(board.ctx, 1, { as: "claude", to: "for-review", comment: "Landed: abc1234." });
    expect(started.events[0]!.at).toBe(landed.events[0]!.at);
    expect(landed.events.map((event) => [event.kind, event.data?.withMove, event.data?.withComment])).toEqual([
      ["comment.added", true, undefined],
      ["item.moved", undefined, true]
    ]);
    const { config } = readBoardConfig(board.dir);
    const oldestFirst = [...started.events, ...landed.events];
    expect(eventLines(oldestFirst, config).map((line) => line.text)).toEqual([
      "moved it from Inbox to In progress",
      "commented and moved it to For review: Landed: abc1234."
    ]);
    expect(eventLines([...oldestFirst].reverse(), config).map((line) => line.text)).toEqual([
      "commented and moved it to For review: Landed: abc1234.",
      "moved it from Inbox to In progress"
    ]);
    // Events from before the marks existed pair by time alone, as they always did.
    const unmarked = oldestFirst.map((event) => ({ ...event, data: Object.fromEntries(Object.entries(event.data ?? {}).filter(([key]) => key !== "withMove" && key !== "withComment")) }));
    expect(eventLines(unmarked.slice(1), config).map((line) => line.events.length)).toEqual([2]);
  });

  it("leaves a change made without an event to the watcher when asked (synthesize: false); by default it announces it", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "One" });
    board.write(board.fileOf(1), board.read(board.fileOf(1)).replace('title: "One"', 'title: "One, by hand"'));
    expect(checkBoard(board.ctx, { as: "claude", synthesize: false }).synthesized).toEqual([]);
    expect(readEvents(board.dir).events.filter(({ event }) => event.by === "unknown")).toEqual([]);
    expect(checkBoard(board.ctx, { as: "claude" }).synthesized.map((event) => event.data)).toEqual([{ synthesized: true, fields: ["title"] }]);
  });
});

// ---------------------------------------------------------------------------------------------
// The commands

interface Terminal {
  root: string;
  dir: string;
  deps: BoardCliDependencies;
  tick: (seconds?: number) => void;
  said: () => string;
}

async function terminal(): Promise<Terminal> {
  const root = await temporary("pinboard-2b-cli-");
  fs.mkdirSync(path.join(root, ".git"));
  let time = Date.parse("2026-10-05T10:00:00Z");
  const lines: string[] = [];
  const term: Terminal = {
    root,
    dir: path.join(root, "docs", "codelead", "board"),
    deps: { cwd: () => root, output: (line) => lines.push(line), now: () => new Date(time), home: "/home/tester" },
    tick: (seconds = 60) => {
      time += seconds * 1000;
    },
    said: () => lines.splice(0).join("\n")
  };
  expect(await runBoardInit({ name: "test-workspace", person: ["robin:Robin"], agent: ["claude:Claude Code"] }, term.deps)).toBe(0);
  term.said();
  return term;
}

describe("codelead board set --color, --field and --unset-field; new --field; show; check", () => {
  it("set --color takes a hex with or without #, a name or none; another colour is refused with exit 2; show says it", async () => {
    const term = await terminal();
    await runBoardNew({ as: "robin", type: "task", title: "One" }, term.deps);
    term.said();
    expect(await runBoardSet("1", { as: "robin", color: "b33f40" }, term.deps)).toBe(0);
    expect(term.said()).toBe("#1: changed its color.");
    expect(fs.readFileSync(path.join(term.dir, "items", "0001-one.md"), "utf8")).toContain('color: "#b33f40"');
    expect(await runBoardShow("1", {}, term.deps)).toBe(0);
    expect(term.said()).toContain("color: #b33f40 (red)");
    expect(await runBoardSet("1", { as: "robin", color: "#6577B3" }, term.deps)).toBe(0);
    expect(await runBoardSet("1", { as: "robin", color: "none" }, term.deps)).toBe(0);
    term.said();
    expect(fs.readFileSync(path.join(term.dir, "items", "0001-one.md"), "utf8")).not.toContain("color:");
    expect(await runBoardSet("1", { as: "robin", color: "purple" }, term.deps)).toBe(2);
    expect(term.said()).toBe(`Refused: "purple" is not a card colour; the colours are ${PALETTE_WORDS}, or none. Nothing was written.`);
  });

  it("set --field ask=… writes a decision's ask, a JSON list is a list, --unset-field removes; a field the type does not have is refused", async () => {
    const term = await terminal();
    await runBoardNew({ as: "robin", type: "decision", title: "The cache", column: "pinned" }, term.deps);
    term.said();
    const file = path.join(term.dir, "items", "0001-the-cache.md");
    expect(await runBoardSet("1", { as: "claude", field: ['ask=Pick the cache: a TTL or a version key. I recommend the TTL, "one minute".', 'options=["a TTL", "a version key"]'] }, term.deps)).toBe(0);
    expect(term.said()).toBe("#1: changed its ask, fields.");
    expect(fs.readFileSync(file, "utf8")).toContain('fields:\n  ask: "Pick the cache: a TTL or a version key. I recommend the TTL, \\"one minute\\"."\n  options: ["a TTL", "a version key"]\n');
    expect(await runBoardSet("1", { as: "claude", field: ["aks=typo"] }, term.deps)).toBe(2);
    expect(term.said()).toBe('"aks" is not a field of a decision (ask, options, recommendation, decided, consequences); change the card\'s type first if it should have it.');
    expect(await runBoardSet("1", { as: "claude", field: ["no equals sign"] }, term.deps)).toBe(2);
    expect(term.said()).toMatch(/^"no equals sign" is not a field; write <name>=<value>/);
    expect(await runBoardSet("1", { as: "claude", field: ["ask=x"], unsetField: ["ask"] }, term.deps)).toBe(2);
    expect(term.said()).toBe("set cannot both set and remove the field ask.");
    expect(await runBoardSet("1", { as: "robin", unsetField: ["ask"] }, term.deps)).toBe(0);
    expect(term.said()).toBe("#1: changed its ask.");
    expect(fs.readFileSync(file, "utf8")).not.toContain("ask:");
    await runBoardNew({ as: "robin", type: "note", title: "A note" }, term.deps);
    term.said();
    expect(await runBoardSet("2", { as: "robin", field: ["ask=Why?"] }, term.deps)).toBe(2);
    expect(term.said()).toBe('A note has no fields; "ask" is not one.');
  });

  it("new --field ask=… writes the ask with the card", async () => {
    const term = await terminal();
    expect(await runBoardNew({ as: "claude", type: "decision", title: "Which TTL?", field: ["ask=One minute or five? I recommend one."] }, term.deps)).toBe(0);
    term.said();
    expect(getCard(boardContext({ dir: term.dir, root: term.root, home: "/home/tester" }), 1).card.fields).toEqual({ ask: "One minute or five? I recommend one." });
    expect(await runBoardNew({ as: "claude", type: "decision", title: "Too long", field: [`ask=${"x".repeat(601)}`] }, term.deps)).toBe(2);
    expect(term.said()).toMatch(/^Refused: the ask is 601 characters;/);
  });

  it("check prints a comment and a move written in one step as one line", async () => {
    const term = await terminal();
    await runBoardNew({ as: "robin", type: "task", title: "One" }, term.deps);
    await runBoardCheck({ as: "robin", ack: true }, term.deps);
    term.said();
    term.tick();
    await runBoardSetupMove(term);
    expect(await runBoardCheck({ as: "robin" }, term.deps)).toBe(0);
    expect(term.said().split("\n")).toEqual([
      "robin: 2 new on 1 card since 2026-10-05T10:00:00Z.",
      "",
      "#1 One  (task · For review)",
      "  claude · 2026-10-05T10:01:00Z  commented and moved it to For review: Landed: abc1234.",
      "",
      "Run again with --ack once these are dealt with. Next check in 30 minutes."
    ]);
  });
});

async function runBoardSetupMove(term: Terminal): Promise<void> {
  const ctx = boardContext({ dir: term.dir, root: term.root, home: "/home/tester", now: term.deps.now! });
  moveCard(ctx, 1, { as: "claude", to: "for-review", comment: "Landed: abc1234." });
}

// ---------------------------------------------------------------------------------------------
// The tidy of the imported cards

const FIXTURES = fileURLToPath(new URL("./fixtures/import/", import.meta.url));

function filesOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (folder: string): void => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

describe("codelead board tidy --imported", () => {
  it("strips the leading bold repetition of the title, and nothing else", () => {
    expect(withoutTitleLead("**Ask the partner two lists** (spec §5 O2): their last ten.", "Ask the partner two lists")).toEqual({ text: "(spec §5 O2): their last ten." });
    expect(withoutTitleLead("**QUESTION FOR ROBIN (16:07Z):** the replay found a blank page.", "QUESTION FOR ROBIN (16:07Z)")).toEqual({ text: "The replay found a blank page." });
    expect(withoutTitleLead("**0r — The W5 design (2026-10-02).** `docs/w5.md`: the rulings.", "0r: The W5 design (2026-10-02)")).toEqual({ text: "`docs/w5.md`: the rulings." });
    expect(withoutTitleLead("**Work:** the truth set.", "0. Truth set")).toEqual({ reason: "its bold opening is not its title" });
    expect(withoutTitleLead("SQL Server for the pilot: a container.", "SQL Server for the pilot")).toEqual({ reason: "its description does not begin in bold" });
    expect(withoutTitleLead(`**${"a ".repeat(70)}tail**`, `${"a ".repeat(59).trim()}…`)).toMatchObject({ reason: expect.any(String) });
  });

  it("leaves a card whose whole text is one long bold paragraph, and one whose description is only the bold title", () => {
    // The first run on the real board would have emptied a card whose description was one bold
    // paragraph of 418 characters beginning with its title.
    const paragraph = `Case study v3 (15:40Z): the artifact note, the questions for Robin, and the paths of the prompts. ${"More of the item's own words. ".repeat(12)}`.trim();
    expect(paragraph.length).toBeGreaterThan(400);
    expect(withoutTitleLead(`**${paragraph}**`, "Case study v3 (15:40Z)")).toEqual({ reason: "its bold opening is longer than a title lead, so it is the item's own text" });
    expect(withoutTitleLead("**Phase 1 build location**", "Phase 1 build location")).toEqual({ reason: "its description is only the bold opening, so nothing would be left" });
    expect(withoutTitleLead("**Phase 1 build location:**   ", "Phase 1 build location")).toEqual({ reason: "its description is only the bold opening, so nothing would be left" });
  });

  it("needs --imported, and on the import's own cards strips the repetition once, from imported cards only; the dry run writes nothing", async () => {
    const term = await terminal();
    for (const name of ["PINNED.md", "DECISIONS-PENDING.md", "behaviour-extraction-plan-2026-10-01.md"]) {
      fs.mkdirSync(path.join(term.root, "docs"), { recursive: true });
      fs.writeFileSync(path.join(term.root, "docs", name), fs.readFileSync(path.join(FIXTURES, name), "utf8").replaceAll("{{WORKSPACE}}", path.dirname(term.root)));
    }
    const ctx = boardContext({ dir: term.dir, root: term.root, home: "/home/tester", now: term.deps.now! });
    importDocuments(ctx, { from: path.join(term.root, "docs") });
    // A card the import did not make, with the same habit: left alone.
    createCard(ctx, "robin", { type: "task", title: "Mine", description: "**Mine** — written that way on purpose." });
    expect(await runBoardTidy({}, term.deps)).toBe(2);
    expect(term.said()).toMatch(/^tidy needs --imported:/);

    const before = filesOf(term.dir);
    expect(await runBoardTidy({ imported: true, dryRun: true }, term.deps)).toBe(0);
    const printed = term.said().split("\n");
    expect(printed[0]).toBe("Tidy of the imported cards as robin: 9 of 15 began with their title in bold; dry run: nothing was written.");
    expect(printed).toContain("  #1    Ask the partner two lists");
    expect(printed).toContain("        after:  (spec §5 O2, your answer to Q2.1): their last ten application requests (to choose the first building blocks)…");
    expect(printed).toContain("Left as they are (6):");
    expect(printed).toContain("  #2    its title was cut at 120 characters, so the bold says more than the title · 0j: KettleBook Desk (side project): BUILT 2026-09-29 (0.1.0, fifteen commits, kettlebook-desk); left: the name, and…");
    expect(printed).toContain("  #8    its description does not begin in bold · SQL Server for the pilot");
    expect(printed).toContain("  #13   its bold opening is not its title · 0. Truth set");
    expect(filesOf(term.dir)).toEqual(before);

    const result = tidyImported(ctx, {});
    expect(result.cards.filter((card) => card.outcome === "tidied").map((card) => card.id)).toEqual([1, 3, 4, 5, 6, 7, 9, 10, 11]);
    expect(getCard(ctx, 4).card.description).toBe("`docs/w5-design-2026-10-02.md`: the seven rulings are section 2 (lines 29–66); the decisions are section 9 (lines 446–491).");
    expect(getCard(ctx, 5).card.description).toBe("Reviewed 2026-09-18; your answers are folded into a decisions\nblock at the top of `docs/partner-feedback-2026-09-17-spec.md`.");
    expect(getCard(ctx, 11).card.description).toBe("The regression replay found the listing detail page rendering 0 characters after the calendar increment. Your call; nothing changed yet.");
    expect(getCard(ctx, 16).card.description).toBe("**Mine** — written that way on purpose.");
    expect(getCard(ctx, 2).card.description.startsWith("**0j — KettleBook Desk")).toBe(true);
    const tidyEvents = readEvents(term.dir).events.slice(-9).map(({ event }) => [event.item, event.kind, event.by, event.data]);
    expect(tidyEvents).toEqual([1, 3, 4, 5, 6, 7, 9, 10, 11].map((id) => [id, "item.updated", "robin", { fields: ["description"] }]));
    expect(validateBoard(ctx).problems).toEqual([]);
    // Once is enough.
    expect(await runBoardTidy({ imported: true }, term.deps)).toBe(0);
    expect(term.said().split("\n")[0]).toBe("Tidy of the imported cards as robin: 0 of 15 began with their title in bold; nothing to do.");
  });
});

// ---------------------------------------------------------------------------------------------
// The process

interface Running {
  call: <T>(method: string, route: string, body?: unknown) => Promise<{ status: number; body: T }>;
}

async function serve(board: TestBoard, options: { watch?: boolean; settleMs?: number } = {}): Promise<Running> {
  const pageDir = path.join(board.root, "page");
  fs.mkdirSync(pageDir, { recursive: true });
  fs.writeFileSync(path.join(pageDir, "index.html"), '<!doctype html><html><body><div id="root"></div></body></html>');
  const server = createBoardServer({ dir: board.dir, root: board.root, home: "/home/tester", now: () => new Date("2026-10-05T11:00:00Z"), pageDir, watch: options.watch ?? false, debounceMs: 20, settleMs: options.settleMs ?? 60, log: () => undefined });
  const { url } = await server.listen(0);
  cleanups.push(() => server.close());
  return {
    call: async <T>(method: string, route: string, body?: unknown) => {
      const response = await fetch(new URL(route, url), { method, headers: body !== undefined ? { "Content-Type": "application/json" } : {}, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const text = await response.text();
      return { status: response.status, body: (text.startsWith("{") ? JSON.parse(text) : text) as T };
    }
  };
}

const unknownEvents = (board: TestBoard): number => readEvents(board.dir).events.filter(({ event }) => event.by === "unknown").length;
const until = async (check: () => boolean, timeoutMs = 4000): Promise<void> => {
  for (let waited = 0; !check(); waited += 25) {
    if (waited > timeoutMs) throw new Error("waited too long");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe("the process: the colour, the ask, the place of a card, one line for a comment and a move, the watcher's announcements", () => {
  it("PUT a colour and an ask: the tile carries them; a colour that is none of the five, or an ask that is no text, is 422 in the core's words", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "decision", title: "The cache", column: "pinned" });
    const { call } = await serve(board);
    const colored = await call<WritePayload>("PUT", "/api/items/1", { changes: { color: "#ed944d" } });
    expect(colored.status).toBe(200);
    expect(colored.body.summary).toMatchObject({ color: "#ed944d" });
    expect(colored.body.card.card.color).toBe("#ed944d");
    expect(colored.body.events).toMatchObject([{ kind: "item.updated", text: "changed its color", data: { fields: ["color"] } }]);
    const asked = await call<WritePayload>("PUT", "/api/items/1", { expectUpdated: colored.body.card.card.updated, changes: { fields: { ask: "Pick the cache: a TTL or a version key; I recommend the TTL." } } });
    expect(asked.body.summary).toMatchObject({ ask: "Pick the cache: a TTL or a version key; I recommend the TTL." });
    expect(asked.body.events).toMatchObject([{ text: "changed its ask" }]);
    const cleared = await call<WritePayload>("PUT", "/api/items/1", { changes: { color: null } });
    expect(cleared.body.summary.color).toBeUndefined();
    const wrong = await call<RefusalPayload>("PUT", "/api/items/1", { changes: { color: "teal" } });
    expect(wrong).toEqual({ status: 422, body: { refused: "usage", message: `Refused: "teal" is not a card colour; the colours are ${PALETTE_WORDS}, or none. Nothing was written.` } });
    const listed = await call<RefusalPayload>("PUT", "/api/items/1", { changes: { fields: { ask: ["a"] } } });
    expect(listed.status).toBe(422);
    expect(listed.body.message).toBe('Refused: the ask must be a text (what is decided, the options, the recommendation), and is ["a"]. Nothing was written.');
  });

  it("GET /api/board: the palette, a decision's fields with its ask first, each card's place and a decision decided", async () => {
    const board = await newBoard();
    createCards(board.ctx, "robin", [
      { type: "decision", title: "Open", column: "pinned", fields: { ask: "Pick A or B." } },
      { type: "decision", title: "Answered", column: "pinned", fields: { decided: { option: "A", by: "robin", on: "2026-10-05" } } }
    ]);
    const { call } = await serve(board);
    const { body } = await call<BoardPayload>("GET", "/api/board");
    expect(body.colors).toEqual([
      { hex: "#b33f40", name: "red" },
      { hex: "#ed944d", name: "orange" },
      { hex: "#edd94c", name: "yellow" },
      { hex: "#48a14d", name: "green" },
      { hex: "#6577b3", name: "blue" }
    ]);
    expect(body.typeFields.decision![0]).toBe("ask");
    expect(body.cards.map((card) => [card.id, card.ask, card.decided, card.rank])).toEqual([
      [1, "Pick A or B.", undefined, 1],
      [2, undefined, true, 2]
    ]);
  });

  it("POST move with after: the card goes right below that card, in another column or its own; an after that is no card id is 422", async () => {
    const board = await newBoard();
    createCards(board.ctx, "robin", [
      { type: "task", title: "A", column: "backlog" },
      { type: "task", title: "B", column: "backlog" },
      { type: "task", title: "C", column: "inbox" }
    ]);
    const { call } = await serve(board);
    const moved = await call<WritePayload>("POST", "/api/items/3/move", { to: "backlog", after: 2 });
    expect(moved.status).toBe(200);
    expect(moved.body.events).toMatchObject([{ kind: "item.moved", data: { from: "inbox", to: "backlog", after: 2 }, text: "moved it from Inbox to Backlog" }]);
    const ranks = async (): Promise<number[]> =>
      (await call<BoardPayload>("GET", "/api/board")).body.cards
        .filter((card) => card.column === "backlog")
        .sort((left, right) => right.rank - left.rank)
        .map((card) => Number(card.id));
    expect(await ranks()).toEqual([2, 3, 1]);
    expect(moved.body.summary.rank).toBeLessThan(2);
    expect(moved.body.summary.rank).toBeGreaterThan(1);
    const top = await call<WritePayload>("POST", "/api/items/1/move", { to: "backlog", after: null });
    expect(top.body.events).toMatchObject([{ text: "moved it to the top of Backlog" }]);
    expect(await ranks()).toEqual([1, 2, 3]);
    const wrong = await call<RefusalPayload>("POST", "/api/items/1/move", { to: "backlog", after: "two!" });
    expect(wrong.status).toBe(422);
    expect(wrong.body.message).toBe('Refused: "after" names the card the moved card goes below (its id), or null for the top; "two!" is neither. Nothing was written.');
  });

  it("GET /api/notifications: a comment and a move written in one step are one line, and still two events in the count", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "One" });
    checkBoard(board.ctx, { as: "robin", ack: true });
    board.tick();
    moveCard(board.ctx, 1, { as: "claude", to: "for-review", comment: "Landed: abc1234." });
    const { call } = await serve(board);
    const { body } = await call<NotificationsPayload>("GET", "/api/notifications");
    expect(body.count).toBe(2);
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]!.events).toEqual([
      expect.objectContaining({ by: "claude", byName: "Claude Code", kind: "comment.added", text: "commented and moved it to For review: Landed: abc1234.", merged: ["item.moved", "comment.added"] })
    ]);
  });

  it("while the folder is watched, the page's check never announces a change made without an event: the watcher does, after the quiet time", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "One" });
    createCard(board.ctx, "robin", { type: "task", title: "Two" });
    checkBoard(board.ctx, { as: "robin", ack: true });
    const { call } = await serve(board, { watch: true, settleMs: 1200 });

    // An agent writes its comment into the card, and its event line a moment later.
    const file = path.join(board.dir, board.fileOf(1));
    fs.writeFileSync(file, `${fs.readFileSync(file, "utf8")}\n### claude · 2026-10-05T10:30:00Z\nHalf written.\n`);
    const between = await call<NotificationsPayload>("GET", "/api/notifications");
    expect(between.body.count).toBe(0);
    expect(unknownEvents(board)).toBe(0);
    await call<NotificationsPayload>("POST", "/api/check/ack", {});
    expect(unknownEvents(board)).toBe(0);
    fs.appendFileSync(path.join(board.dir, "events.jsonl"), `${JSON.stringify({ at: "2026-10-05T10:30:00Z", by: "claude", item: 1, kind: "comment.added", data: { excerpt: "Half written." } })}\n`);
    expect((await call<NotificationsPayload>("GET", "/api/notifications")).body.groups.map((group) => group.events.map((event) => event.text))).toEqual([["commented: Half written."]]);
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(unknownEvents(board)).toBe(0);

    // A hand edit with no event at all: the watcher announces it once the files have been quiet.
    const other = path.join(board.dir, board.fileOf(2));
    fs.writeFileSync(other, fs.readFileSync(other, "utf8").replace('title: "Two"', 'title: "Two, by hand"'));
    expect((await call<NotificationsPayload>("GET", "/api/notifications")).body.count).toBe(1);
    await until(() => unknownEvents(board) === 1);
    expect((await call<NotificationsPayload>("GET", "/api/notifications")).body.groups.map((group) => group.events.map((event) => event.text))).toEqual([["changed its file with no event (title)"], ["commented: Half written."]]);
  });

  it("announces what changed while it was down once the files have been quiet; with no watcher, the page's check announces it at once", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "One" });
    board.write(board.fileOf(1), board.read(board.fileOf(1)).replace('title: "One"', 'title: "One, while the process was down"'));
    const watched = await serve(board, { watch: true, settleMs: 400 });
    await watched.call<NotificationsPayload>("GET", "/api/notifications");
    expect(unknownEvents(board)).toBe(0);
    await until(() => unknownEvents(board) === 1);

    const other = await newBoard();
    createCard(other.ctx, "robin", { type: "task", title: "One" });
    other.write(other.fileOf(1), other.read(other.fileOf(1)).replace('title: "One"', 'title: "One, by hand"'));
    const unwatched = await serve(other, { watch: false });
    expect((await unwatched.call<NotificationsPayload>("GET", "/api/notifications")).body.groups[0]!.events.map((event) => event.text)).toEqual(["changed its file with no event (title)"]);
  });
});
