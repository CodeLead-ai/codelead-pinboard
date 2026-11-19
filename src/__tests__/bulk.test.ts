import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBoardArchive, runBoardMove, runBoardSet } from "../cli/board.js";
import {
  archiveCard,
  boardContext,
  bulkWrite,
  createCards,
  getCard,
  initBoard,
  readBoard,
  readEvents,
  refusalReason,
  unarchiveCard,
  updateCard,
  validateBoard,
  type BoardContext,
  type Participant
} from "../core/index.js";
import { cardRanks } from "../core/order.js";

const PEOPLE: Participant[] = [
  { id: "robin", kind: "person", name: "Robin" },
  { id: "claude", kind: "agent", name: "Claude Code" }
];

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A board of seven cards: #1–#3 in Backlog (top to bottom 3, 2, 1), #4 in Inbox, #5 in Done, #6 and #7 with projects. */
async function board(): Promise<{ root: string; dir: string; ctx: BoardContext; tick: () => void }> {
  const base = await mkdtemp(path.join(os.tmpdir(), "pinboard-bulk-"));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "repo");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  const dir = path.join(root, "docs", "codelead", "board");
  let time = Date.parse("2026-11-19T09:00:00Z");
  const ctx = boardContext({ dir, root, home: "/home/tester", now: () => new Date(time) });
  initBoard(ctx, { name: "bulk", participants: PEOPLE });
  createCards(
    ctx,
    "robin",
    [
      { type: "task", title: "First", column: "backlog" },
      { type: "task", title: "Second", column: "backlog" },
      { type: "task", title: "Third", column: "backlog" },
      { type: "idea", title: "Fourth", column: "inbox" },
      { type: "note", title: "Fifth", column: "done" },
      { type: "task", title: "Sixth", column: "backlog", tags: ["repo:api", "area:auth"] },
      { type: "task", title: "Seventh", column: "inbox", tags: ["repo:web"] }
    ],
    { tagCreator: false }
  );
  return { root, dir, ctx, tick: () => (time += 60_000) };
}

/** A column's cards, top first, as the page orders them (the log's ranks). */
function column(ctx: BoardContext, id: string): number[] {
  const view = readBoard(ctx);
  const ranks = cardRanks(readEvents(ctx.dir).events, view.cards);
  return view.cards
    .filter((card) => card.column === id && card.archived === undefined)
    .sort((left, right) => (ranks.get(String(right.id)) ?? 0) - (ranks.get(String(left.id)) ?? 0))
    .map((card) => Number(card.id));
}

describe("bulk writes: one operation on several cards, each card's write its own", () => {
  it("moves several cards into a column in the order given, the first at the top, one event per card, and says where each stood", async () => {
    const { ctx, tick } = await board();
    tick();
    const before = readEvents(ctx.dir).count;
    const results = bulkWrite(ctx, { as: "robin", operation: { kind: "move", to: "for-review" }, ids: [2, 4, 1] });
    expect(results.map((result) => [result.id, result.outcome])).toEqual([
      [2, "changed"],
      [4, "changed"],
      [1, "changed"]
    ]);
    expect(column(ctx, "for-review")).toEqual([2, 4, 1]);
    const events = readEvents(ctx.dir).events.slice(before).map(({ event }) => [event.item, event.kind]);
    expect(events).toEqual([
      [2, "item.moved"],
      [4, "item.moved"],
      [1, "item.moved"]
    ]);
    // Where each stood: #2 was under #3 in Backlog, #4 at the top of Inbox (#7 came after it), #1 at the bottom.
    expect(results[0]!.before).toMatchObject({ column: "backlog", above: 3 });
    expect(results[1]!.before).toMatchObject({ column: "inbox", above: 7 });
    expect(results[2]!.before).toMatchObject({ column: "backlog", above: 2 });
  });

  it("leaves a card already in the column where it is, unless a place is given; a place puts the block there", async () => {
    const { ctx } = await board();
    const results = bulkWrite(ctx, { as: "robin", operation: { kind: "move", to: "backlog" }, ids: [4, 3] });
    expect(results.map((result) => result.outcome)).toEqual(["changed", "unchanged"]);
    expect(column(ctx, "backlog")).toEqual([4, 6, 3, 2, 1]);
    // Dropped below #2: #7 and #4 go there, in that order.
    bulkWrite(ctx, { as: "robin", operation: { kind: "move", to: "backlog", after: 2 }, ids: [7, 4] });
    expect(column(ctx, "backlog")).toEqual([6, 3, 2, 7, 4, 1]);
  });

  it("refuses one stale card and writes the others, naming it in the core's words", async () => {
    const { ctx, tick } = await board();
    const read = Object.fromEntries([1, 2, 3].map((id) => [String(id), getCard(ctx, id).card.updated]));
    tick();
    updateCard(ctx, 2, { as: "claude", changes: { status: "being looked at" } });
    tick();
    const results = bulkWrite(ctx, { as: "robin", operation: { kind: "archive" }, ids: [1, 2, 3], expectUpdated: read });
    expect(results.map((result) => result.outcome)).toEqual(["changed", "refused", "changed"]);
    expect(results[1]!.refusal!.code).toBe("stale");
    expect(results[1]!.refusal!.message).toMatch(/card #2 changed since it was read/);
    expect(refusalReason(results[1]!.refusal!)).toBe("changed since you read it");
    expect(getCard(ctx, 1).card.archived).toBeDefined();
    expect(getCard(ctx, 2).card.archived).toBeUndefined();
    expect(getCard(ctx, 3).card.archived).toBeDefined();
  });

  it("keeps the person's columns the person's: an agent's move into Pinned is refused on each card, the person's goes through", async () => {
    const { ctx } = await board();
    const agent = bulkWrite(ctx, { as: "claude", operation: { kind: "move", to: "pinned" }, ids: [1, 4] });
    expect(agent.map((result) => result.outcome)).toEqual(["refused", "refused"]);
    expect(agent[0]!.refusal!.code).toBe("column");
    expect(agent[0]!.refusal!.message).toMatch(/claude is an agent and may not move a card into Pinned \(a person's column\)/);
    expect(column(ctx, "pinned")).toEqual([]);
    const person = bulkWrite(ctx, { as: "robin", operation: { kind: "move", to: "pinned" }, ids: [1, 4] });
    expect(person.map((result) => result.outcome)).toEqual(["changed", "changed"]);
    expect(column(ctx, "pinned")).toEqual([1, 4]);
  });

  it("adds and removes tags on each card, once (a card that has the tag already is left alone)", async () => {
    const { ctx } = await board();
    const added = bulkWrite(ctx, { as: "robin", operation: { kind: "tags", add: ["area:auth"] }, ids: [1, 6] });
    expect(added.map((result) => result.outcome)).toEqual(["changed", "unchanged"]);
    expect(added[0]!.write!.events.map((event) => [event.kind, event.data?.tag])).toEqual([["tag.added", "area:auth"]]);
    const removed = bulkWrite(ctx, { as: "robin", operation: { kind: "tags", remove: ["area:auth"] }, ids: [1, 6] });
    expect(removed.map((result) => result.outcome)).toEqual(["changed", "changed"]);
    expect(getCard(ctx, 6).card.tags).toEqual(["repo:api"]);
  });

  it("sets a project: adds its repo: tag, replaces the card's other project only when asked, and creates a new project by its name", async () => {
    const { ctx } = await board();
    bulkWrite(ctx, { as: "robin", operation: { kind: "project", name: "web" }, ids: [6, 1] });
    expect(getCard(ctx, 6).card.tags).toEqual(["repo:api", "area:auth", "repo:web"]);
    expect(getCard(ctx, 1).card.tags).toEqual(["repo:web"]);
    const replaced = bulkWrite(ctx, { as: "robin", operation: { kind: "project", name: "mobile", replace: true }, ids: [6, 7] });
    expect(getCard(ctx, 6).card.tags).toEqual(["area:auth", "repo:mobile"]);
    expect(getCard(ctx, 7).card.tags).toEqual(["repo:mobile"]);
    expect(replaced[0]!.write!.events.map((event) => [event.kind, event.data?.tag])).toEqual([
      ["tag.added", "repo:mobile"],
      ["tag.removed", "repo:api"],
      ["tag.removed", "repo:web"]
    ]);
    expect(() => bulkWrite(ctx, { as: "robin", operation: { kind: "project", name: "two words" }, ids: [1] })).toThrow(/cannot be a project's name/);
  });

  it("refuses the whole call, writing nothing, when no card's write could mean anything", async () => {
    const { ctx } = await board();
    const lines = readEvents(ctx.dir).count;
    expect(() => bulkWrite(ctx, { as: "robin", operation: { kind: "move", to: "nowhere" }, ids: [1] })).toThrow(/"nowhere" is not a column/);
    expect(() => bulkWrite(ctx, { as: "stranger", operation: { kind: "archive" }, ids: [1] })).toThrow(/"stranger" is not a participant/);
    expect(() => bulkWrite(ctx, { as: "robin", operation: { kind: "tags", add: [" "] }, ids: [1] })).toThrow(/no tag to add or remove/);
    expect(() => bulkWrite(ctx, { as: "robin", operation: { kind: "archive" }, ids: [] })).toThrow(/no card was named/);
    expect(readEvents(ctx.dir).count).toBe(lines);
    // A card that is not there is that card's refusal alone.
    const results = bulkWrite(ctx, { as: "robin", operation: { kind: "archive" }, ids: [99, 1] });
    expect(results.map((result) => [result.id, result.outcome, result.refusal?.code])).toEqual([
      [99, "refused", "not-found"],
      [1, "changed", undefined]
    ]);
  });
});

describe("unarchive: the person brings an archived card back", () => {
  it("brings it back into the column it left, with its item.unarchived event; an agent may not; the board stays valid", async () => {
    const { ctx, tick } = await board();
    archiveCard(ctx, 5, { as: "robin" });
    tick();
    expect(() => unarchiveCard(ctx, 5, { as: "claude" })).toThrow(/only a person brings an archived card back/);
    const result = unarchiveCard(ctx, 5, { as: "robin" });
    expect(result.card.archived).toBeUndefined();
    expect(result.card.column).toBe("done");
    expect(result.events.map((event) => [event.kind, event.data])).toEqual([["item.unarchived", { column: "done" }]]);
    expect(unarchiveCard(ctx, 5, { as: "robin" }).events).toEqual([]);
    expect(validateBoard(ctx).problems).toEqual([]);
    const archive = bulkWrite(ctx, { as: "robin", operation: { kind: "archive" }, ids: [1, 2] });
    expect(archive.map((entry) => entry.outcome)).toEqual(["changed", "changed"]);
    const back = bulkWrite(ctx, { as: "robin", operation: { kind: "unarchive" }, ids: [1, 2, 3] });
    expect(back.map((entry) => entry.outcome)).toEqual(["changed", "changed", "unchanged"]);
  });
});

describe("the commands with several ids", () => {
  const terminal = (root: string): { deps: { cwd: () => string; output: (line: string) => void; home: string }; out: string[] } => {
    const out: string[] = [];
    return { out, deps: { cwd: () => root, output: (line) => out.push(line), home: "/home/tester" } };
  };

  it("move takes several ids, says what happened to each, and exits 1 when a rule refused one of them", async () => {
    const { root, ctx } = await board();
    const term = terminal(root);
    expect(await runBoardMove(["2", "#4"], { as: "claude", to: "for-review" }, term.deps)).toBe(0);
    expect(term.out.pop()).toBe("Moved to For review (2 changed):\n  #2 from Backlog\n  #4 from Inbox");
    expect(column(ctx, "for-review")).toEqual([2, 4]);
    expect(await runBoardMove(["1", "2"], { as: "claude", to: "done" }, term.deps)).toBe(1);
    expect(term.out.pop()).toMatch(/^Moved to Done \(0 changed, 2 refused\):\n {2}#1 refused: Refused: claude is an agent/);
    expect(await runBoardMove(["1", "2"], { as: "robin", to: "backlog", ifUpdated: "2026-11-19T09:00:00Z" }, term.deps)).toBe(2);
    expect(term.out.pop()).toMatch(/--if-updated names one card's updated time/);
  });

  it("archive and unarchive take several ids (a person only); set changes each card the same way", async () => {
    const { root, ctx } = await board();
    const term = terminal(root);
    expect(await runBoardArchive(["1", "2"], { as: "robin" }, term.deps)).toBe(0);
    expect(term.out.pop()).toBe("Archived (2 changed):\n  #1 archived from Backlog\n  #2 archived from Backlog");
    expect(await runBoardArchive(["3"], { as: "claude" }, term.deps)).toBe(1);
    expect(term.out.pop()).toMatch(/only a person archives a card/);
    expect(await runBoardArchive(["1", "2", "3"], { as: "robin" }, term.deps, true)).toBe(0);
    expect(term.out.pop()).toBe("Brought back to the board (2 changed, 1 unchanged):\n  #1 back in Backlog\n  #2 back in Backlog\n  #3 is not archived; nothing was written");
    expect(await runBoardArchive("5", { as: "robin" }, term.deps)).toBe(0);
    expect(term.out.pop()).toMatch(/^Archived #5: it left the board and stays in its file/);
    expect(await runBoardSet(["1", "4"], { as: "robin", tag: ["w5"] }, term.deps)).toBe(0);
    expect(term.out.pop()).toBe("Changed (2 changed):\n  #1 tagged it w5\n  #4 tagged it w5");
    expect(getCard(ctx, 4).card.tags).toEqual(["w5"]);
  });
});
