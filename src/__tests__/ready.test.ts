import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBoardAddReady, runBoardList, runBoardMove, runBoardNew, runBoardSet, type BoardCliDependencies } from "../cli/board.js";
import {
  addReadyColumn,
  agentsGuide,
  boardContext,
  BoardRefusal,
  bulkWrite,
  createBatch,
  createCard,
  createCards,
  defaultBoardConfig,
  getCard,
  initBoard,
  moveCard,
  readBoardConfig,
  readEvents,
  readyGaps,
  readySection,
  refusalReason,
  updateCard,
  validateBoard,
  type BoardConfig,
  type BoardContext,
  type Participant,
  type YamlMap
} from "../core/index.js";
import { createBoardServer, type BatchPayload, type BoardPayload, type RefusalPayload, type WritePayload } from "../server/index.js";

/**
 * Ready: the person's column of the cards an agent may pick up by itself. Moving a card there is
 * the ask; a card goes there only when it says how to tell it is done, what it may touch and a limit;
 * an agent never moves a card into it, takes one out of it into In progress only, and does not change
 * what a card there says it may do. A board made before Ready keeps working, and `add-ready` gives it
 * the column.
 */

const PEOPLE: Participant[] = [
  { id: "robin", kind: "person", name: "Robin" },
  { id: "claude", kind: "agent", name: "Claude Code" },
  { id: "codex", kind: "agent", name: "Codex" },
  { id: "codelead", kind: "agent", name: "CodeLead" }
];

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Board {
  root: string;
  dir: string;
  ctx: BoardContext;
  tick: () => void;
  file: (id: number) => string;
  events: () => number;
  deps: BoardCliDependencies;
  said: () => string;
}

async function board(options: { old?: boolean } = {}): Promise<Board> {
  const base = await mkdtemp(path.join(os.tmpdir(), "pinboard-ready-"));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "app");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  const dir = path.join(root, "docs", "codelead", "board");
  let time = Date.parse("2026-11-25T09:00:00Z");
  const now = (): Date => new Date(time);
  const ctx = boardContext({ dir, root, home: path.join(base, "home"), now });
  initBoard(ctx, { name: "test-workspace", participants: PEOPLE });
  // A board made before Ready: its board.json and AGENTS.md as the package wrote them then (the guide of a board without
  // Ready is the same text as before, byte for byte).
  if (options.old) {
    const config = readBoardConfig(dir).config;
    const before: BoardConfig = { ...config, columns: config.columns.filter((column) => column.id !== "ready") };
    fs.writeFileSync(path.join(dir, "board.json"), `${JSON.stringify(before, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, "AGENTS.md"), agentsGuide(before));
  }
  const lines: string[] = [];
  return {
    root,
    dir,
    ctx,
    tick: () => {
      time += 60_000;
    },
    file: (id) => {
      const name = fs.readdirSync(path.join(dir, "items")).find((entry) => entry.startsWith(`${String(id).padStart(4, "0")}-`))!;
      return fs.readFileSync(path.join(dir, "items", name), "utf8");
    },
    events: () => readEvents(dir).count,
    deps: { cwd: () => root, output: (line) => lines.push(line), now, home: path.join(base, "home"), command: "pinboard" },
    said: () => lines.splice(0).join("\n")
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

const DONE = "it does not say how to tell it is done (definitionOfDone)";
const TOUCH = "it does not name the repository, folder or files it may touch (mayTouch)";
const LIMIT = "it names no limit in minutes or money (limitMinutes, limitMoney)";
const ALL = { definitionOfDone: "npm test passes", mayTouch: ["src/auth/"], limitMinutes: 30 };
const AGENT_INTO = "Refused: claude is an agent and may not move a card into Ready (a person's column); an agent may move a card into Inbox, Backlog, Ideas, In progress, For review. Nothing was written.";

/** "a", "a, and b", "a, b, and c", as the refusal joins its parts. */
const joined = (parts: string[]): string => (parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`);

// ---------------------------------------------------------------------------------------------

describe("the Ready check: a card goes to Ready only when it can be worked alone", () => {
  // Every combination of the three things: given (true) or not.
  const combinations = [false, true].flatMap((done) => [false, true].flatMap((touch) => [false, true].map((limit) => ({ done, touch, limit }))));

  it.each(combinations)("done when %#: %o", async ({ done, touch, limit }) => {
    const b = await board();
    const fields: YamlMap = { ...(done ? { definitionOfDone: ALL.definitionOfDone } : {}), ...(touch ? { mayTouch: ALL.mayTouch } : {}), ...(limit ? { limitMinutes: 30 } : {}) };
    createCard(b.ctx, "robin", { type: "task", title: "Rate-limit the sign-in form", column: "backlog", fields });
    const missing = [...(done ? [] : [DONE]), ...(touch ? [] : [TOUCH]), ...(limit ? [] : [LIMIT])];
    const before = b.file(1);
    const events = b.events();
    if (missing.length === 0) {
      expect(moveCard(b.ctx, 1, { as: "robin", to: "ready" }).card.column).toBe("ready");
      return;
    }
    const refused = refusal(() => moveCard(b.ctx, 1, { as: "robin", to: "ready" }));
    expect(refused.code).toBe("ready");
    expect(refused.message).toBe(`Card #1 cannot go to Ready yet: ${joined(missing)}. Nothing was written: set what is missing, then move it again.`);
    expect(refused.details).toEqual({ card: 1, missing: readyGaps(fields).map((gap) => ({ what: gap.what, fields: gap.fields, words: gap.words })) });
    expect((refused.details!.missing as Array<{ words: string }>).map((gap) => gap.words)).toEqual(missing);
    // Nothing was written.
    expect(b.file(1)).toBe(before);
    expect(b.events()).toBe(events);
  });

  it("reads each of the three things the ways a card says them: a list or a text, a limit in minutes, in money, or both", () => {
    expect(readyGaps({ ...ALL, mayTouch: "the api repository" })).toEqual([]);
    expect(readyGaps({ ...ALL, mayTouch: ["", "  "] }).map((gap) => gap.what)).toEqual(["may-touch"]);
    expect(readyGaps({ ...ALL, definitionOfDone: "   " }).map((gap) => gap.what)).toEqual(["done-when"]);
    const { limitMinutes: _minutes, ...noLimit } = ALL;
    expect(readyGaps({ ...noLimit, limitMoney: 2.5 })).toEqual([]);
    expect(readyGaps({ ...noLimit, limitMoney: 0 })).toEqual([]);
    expect(readyGaps({ ...noLimit, limitMinutes: 30, limitMoney: 5 })).toEqual([]);
    expect(readyGaps({ ...noLimit, limitMinutes: 0 }).map((gap) => gap.what)).toEqual(["limit"]);
    // A limit written by hand that is no number is said as such.
    expect(readyGaps({ ...noLimit, limitMinutes: "soon" }).map((gap) => gap.words)).toEqual([
      'its limit cannot be read (limitMinutes is "soon"; limitMinutes takes a number above 0, limitMoney a number of 0 or more)'
    ]);
  });

  it("applies to any type of card, and a type's own field names are not needed: a note goes to Ready with the three", async () => {
    const b = await board();
    createCard(b.ctx, "robin", { type: "note", title: "Tidy the logs", column: "inbox", fields: { ...ALL, limitMinutes: "15" } });
    // A limit given as a text that reads as a number is kept as the number.
    expect(getCard(b.ctx, 1).card.fields.limitMinutes).toBe(15);
    expect(b.file(1)).toContain("  limitMinutes: 15\n");
    expect(moveCard(b.ctx, 1, { as: "robin", to: "ready" }).card.column).toBe("ready");
  });

  it("refuses a limit that is not a number when it is written, and an emptied one removes the field", async () => {
    const b = await board();
    createCard(b.ctx, "robin", { type: "task", title: "One", fields: { ...ALL } });
    const minutes = refusal(() => updateCard(b.ctx, 1, { as: "robin", changes: { fields: { limitMinutes: "soon" } } }));
    expect([minutes.code, minutes.message]).toEqual(["ready", 'Refused: limitMinutes is a limit in minutes, a number above 0 (30, or 1.5); "soon" is not one. Nothing was written.']);
    const money = refusal(() => updateCard(b.ctx, 1, { as: "robin", changes: { fields: { limitMoney: "$5" } } }));
    expect(money.message).toBe('Refused: limitMoney is a limit in money, a number of 0 or more (5, or 2.50); "$5" is not one. Nothing was written.');
    expect(refusal(() => createCard(b.ctx, "robin", { type: "task", title: "Two", fields: { limitMinutes: -5 } })).code).toBe("ready");
    updateCard(b.ctx, 1, { as: "robin", changes: { fields: { limitMoney: "2.50" } } });
    expect(getCard(b.ctx, 1).card.fields.limitMoney).toBe(2.5);
    updateCard(b.ctx, 1, { as: "robin", changes: { fields: { limitMoney: "" } } });
    expect(getCard(b.ctx, 1).card.fields).not.toHaveProperty("limitMoney");
  });

  it("checks a card made in Ready as one moved there: the new card", async () => {
    const b = await board();
    const made = refusal(() => createCard(b.ctx, "robin", { type: "task", title: "Straight to Ready", column: "ready", fields: { definitionOfDone: "It works." } }));
    expect([made.code, made.message]).toEqual(["ready", `The new card cannot go to Ready yet: ${TOUCH}, and ${LIMIT}. Nothing was written: set what is missing, then create it again.`]);
    expect(fs.readdirSync(path.join(b.dir, "items"))).toEqual([]);
    // In a batch, the card's label comes first and the words go on after it.
    const batch = refusal(() => createBatch(b.ctx, "robin", "## Straight to Ready\n\n```yaml\ntype: task\ncolumn: ready\n```\n\nNo fields.\n", { source: "cards.md" }));
    expect(batch.message).toBe(`Refused: the card "## Straight to Ready" (line 1 of cards.md): the new card cannot go to Ready yet: ${DONE}, ${TOUCH}, and ${LIMIT}. Nothing was written: set what is missing, then create it again.`);
    expect(createCard(b.ctx, "robin", { type: "task", title: "Ready at once", column: "ready", fields: ALL }).card.column).toBe("ready");
    // An agent is refused before the check, as for any person's column.
    expect(refusal(() => createCard(b.ctx, "claude", { type: "task", title: "Mine", column: "ready", fields: ALL })).message).toBe(
      "Refused: claude is an agent and may not create a card in Ready (a person's column); an agent may create a card in Inbox, Backlog, Ideas, In progress, For review. Nothing was written."
    );
  });

  it("needs no check to leave Ready, or to move inside it", async () => {
    const b = await board();
    createCards(b.ctx, "robin", [
      { type: "task", title: "One", column: "ready", fields: ALL },
      { type: "task", title: "Two", column: "ready", fields: ALL }
    ]);
    // A card in Ready that a hand edit took a field from: still moved inside Ready, and out of it, by the person.
    const file = path.join(b.dir, "items", fs.readdirSync(path.join(b.dir, "items")).find((name) => name.startsWith("0001-"))!);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("  limitMinutes: 30\n", ""));
    b.tick();
    expect(moveCard(b.ctx, 1, { as: "robin", to: "ready", after: 2 }).events.map((event) => event.kind)).toEqual(["item.moved"]);
    expect(moveCard(b.ctx, 1, { as: "robin", to: "backlog" }).card.column).toBe("backlog");
    expect(moveCard(b.ctx, 2, { as: "robin", to: "done" }).card.column).toBe("done");
  });
});

// ---------------------------------------------------------------------------------------------

describe("Ready is the person's: only the person moves a card into it; an agent takes one out into In progress", () => {
  it("refuses an agent's move into Ready with the rule of the person's columns, a card with the three things included", async () => {
    const b = await board();
    createCard(b.ctx, "robin", { type: "task", title: "One", column: "backlog", fields: ALL });
    const before = b.file(1);
    const refused = refusal(() => moveCard(b.ctx, 1, { as: "claude", to: "ready" }));
    expect([refused.code, refused.message]).toEqual(["column", AGENT_INTO]);
    expect(b.file(1)).toBe(before);
    // CodeLead is an agent like any other here.
    expect(refusal(() => moveCard(b.ctx, 1, { as: "codelead", to: "ready" })).code).toBe("column");
    // board.json cannot give agents the column: it is the person's.
    const config = readBoardConfig(b.dir).config;
    fs.writeFileSync(path.join(b.dir, "board.json"), JSON.stringify({ ...config, agents: { ...config.agents, mayMoveTo: [...config.agents.mayMoveTo, "ready"] } }));
    expect(refusal(() => readBoardConfig(b.dir)).message).toContain('"agents.mayMoveTo" names "ready", a column only a person moves cards into');
  });

  it("lets an agent take a card from Ready into In progress, and nowhere else", async () => {
    const b = await board();
    createCards(b.ctx, "robin", [
      { type: "task", title: "One", column: "ready", fields: ALL },
      { type: "task", title: "Two", column: "ready", fields: ALL }
    ]);
    for (const to of ["backlog", "inbox", "for-review", "ideas"]) {
      const refused = refusal(() => moveCard(b.ctx, 1, { as: "claude", to }));
      expect(refused.code).toBe("column");
      expect(refused.message).toMatch(/^Refused: claude is an agent and may move a card out of Ready only into In progress, to take it; not into (Backlog|Inbox|For review|Ideas)\. Nothing was written\.$/);
    }
    expect(moveCard(b.ctx, 1, { as: "claude", to: "in-progress", comment: "Started: taken from Ready." }).card.column).toBe("in-progress");
    // Out of In progress, the agent's columns again.
    expect(moveCard(b.ctx, 1, { as: "claude", to: "for-review" }).card.column).toBe("for-review");
  });

  it("gives a card tagged for:<agent> to that agent only; a card with no such tag to any agent", async () => {
    const b = await board();
    createCards(b.ctx, "robin", [
      { type: "task", title: "For Codex", column: "ready", fields: ALL, tags: ["for:codex"] },
      { type: "task", title: "For CodeLead", column: "ready", fields: ALL, tags: ["for:codelead"] },
      { type: "task", title: "For anyone", column: "ready", fields: ALL }
    ]);
    const refused = refusal(() => moveCard(b.ctx, 1, { as: "claude", to: "in-progress" }));
    expect([refused.code, refused.message]).toEqual(["not-allowed", "Refused: card #1 in Ready is for codex (for:codex); claude may not take it. Nothing was written."]);
    expect(refusal(() => moveCard(b.ctx, 2, { as: "claude", to: "in-progress" })).message).toBe("Refused: card #2 in Ready is for codelead (for:codelead); claude may not take it. Nothing was written.");
    expect(moveCard(b.ctx, 1, { as: "codex", to: "in-progress" }).card.column).toBe("in-progress");
    expect(moveCard(b.ctx, 2, { as: "codelead", to: "in-progress" }).card.column).toBe("in-progress");
    expect(moveCard(b.ctx, 3, { as: "claude", to: "in-progress" }).card.column).toBe("in-progress");
  });

  it("keeps what a card in Ready says it may do: an agent does not change it, and no change takes it away", async () => {
    const b = await board();
    createCard(b.ctx, "robin", { type: "task", title: "One", column: "ready", fields: ALL });
    const agent = refusal(() => updateCard(b.ctx, 1, { as: "claude", changes: { fields: { limitMinutes: 90 } } }));
    expect([agent.code, agent.message]).toEqual([
      "not-allowed",
      "Refused: claude is an agent and may not change what a card in Ready says it may do (limitMinutes): that is the person's ask; ask in the thread. Nothing was written."
    ]);
    // The rest of the card is the agent's to write as before: its description, a comment, a tag.
    expect(updateCard(b.ctx, 1, { as: "claude", changes: { description: "Read src/auth/limits.ts first." } }).events).toHaveLength(1);
    const removed = refusal(() => updateCard(b.ctx, 1, { as: "robin", changes: { fields: { limitMinutes: null, mayTouch: null } } }));
    expect([removed.code, removed.message]).toEqual([
      "ready",
      `Card #1 is in Ready, so it must keep what lets an agent work it alone; after this change ${TOUCH}, and ${LIMIT}. Nothing was written: keep it, or move the card out of Ready first.`
    ]);
    // The person changes them, as long as the card can still be worked alone.
    expect(updateCard(b.ctx, 1, { as: "robin", changes: { fields: { limitMinutes: 45, limitMoney: 3 } } }).card.fields).toMatchObject({ limitMinutes: 45, limitMoney: 3 });
    expect(updateCard(b.ctx, 1, { as: "robin", changes: { fields: { limitMinutes: null } } }).card.fields).not.toHaveProperty("limitMinutes");
    // Out of Ready, an agent may propose them, as any field of its card.
    createCard(b.ctx, "claude", { type: "task", title: "My proposal" });
    expect(updateCard(b.ctx, 2, { as: "claude", changes: { fields: ALL } }).card.fields).toMatchObject(ALL);
  });

  it("names a card in Ready that cannot be worked alone (a hand edit) as a problem of the board", async () => {
    const b = await board();
    createCard(b.ctx, "robin", { type: "task", title: "One", column: "ready", fields: ALL });
    expect(validateBoard(b.ctx).problems).toEqual([]);
    const file = path.join(b.dir, "items", fs.readdirSync(path.join(b.dir, "items"))[0]!);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("  limitMinutes: 30\n", ""));
    expect(validateBoard(b.ctx).problems).toEqual([{ file: "items/0001-one.md", message: `the card is in Ready, and ${LIMIT}` }]);
  });

  it("answers each card of a bulk move on its own, the refusal's parts included; a line that names the card goes on from its verb", async () => {
    const b = await board();
    createCards(b.ctx, "robin", [
      { type: "task", title: "Ready", fields: ALL },
      { type: "task", title: "Not ready", fields: { definitionOfDone: "It works." } }
    ]);
    const results = bulkWrite(b.ctx, { as: "robin", operation: { kind: "move", to: "ready" }, ids: [1, 2] });
    expect(results.map((result) => result.outcome)).toEqual(["changed", "refused"]);
    expect(results[1]!.refusal).toMatchObject({ code: "ready", details: { card: 2, missing: [{ what: "may-touch" }, { what: "limit" }] } });
    expect(refusalReason(results[1]!.refusal!)).toBe(`cannot go to Ready yet: ${TOUCH}, and ${LIMIT}`);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AGENTS.md says it in one place, and a board without Ready reads as before", () => {
  const people = PEOPLE.slice(0, 2);
  const withReady = defaultBoardConfig({ name: "w", participants: people });
  const without: BoardConfig = { ...withReady, columns: withReady.columns.filter((column) => column.id !== "ready") };

  it("adds the Ready section and the second half of the first rule of Never; every other rule stays as it was", () => {
    const guide = agentsGuide(withReady);
    expect(guide).toContain("- Start code work because of a card. Work starts when the person asks for it in the session, or\n  when the person moved the card to Ready.\n");
    expect(guide).toContain("\n## Ready\nReady is the person's column of the cards an agent may pick up by itself: moving a card there is\nthe person's ask for the work.");
    expect(guide.replace(/\n {2}/g, " ").replace(/\n(?!\n|#|- )/g, " ")).toContain("Never move a card into Ready, out of it anywhere but In progress, or change those fields while it is there: the commands refuse it.");
    // The guide with Ready, its three differences taken back, is the guide without it.
    const back = guide
      .replace(`\n${readySection(withReady)}`, "")
      .replace(", or\n  when the person moved the card to Ready.", ".")
      .replace("Move a card into Pinned, Ready or Done", "Move a card into Pinned or Done");
    expect(back).toBe(agentsGuide(without));
    expect(agentsGuide(without)).not.toMatch(/Ready/);
    expect(readySection(without)).toBe("");
  });

  it("keeps the CodeLead section's queue as it is on a board with Ready: the old column, its untagged cards, and the person's columns CodeLead takes from", () => {
    // The columns written out, Ready among them: the person's column a card is taken from into In progress by any agent.
    const columns = [
      { id: "inbox", name: "Inbox" },
      { id: "backlog", name: "Backlog" },
      { id: "ideas", name: "Ideas" },
      { id: "pinned", name: "Pinned", owner: "person" as const },
      { id: "ready", name: "Ready", owner: "person" as const },
      { id: "in-progress", name: "In progress" },
      { id: "for-review", name: "For review" },
      { id: "done", name: "Done", owner: "person" as const }
    ];
    const joined = { ...withReady, columns, participants: [...people, { id: "codelead", kind: "agent" as const, name: "CodeLead" }] };
    const legacy = { ...joined, columns: [...joined.columns.slice(0, 5), { id: "queued", name: "Queued for CodeLead" }, ...joined.columns.slice(5)] };
    for (const config of [joined, legacy]) {
      const words = agentsGuide(config).replace(/\n {2}/g, " ");
      expect(words).toContain("CodeLead moves each card to In progress (out of Pinned too) and keeps the tag.");
      expect(words).toContain("never moves a card into Pinned, Ready or Done");
      expect(words).toContain("takes tagged cards that are not archived and not in In progress, For review or Done, top of Backlog first");
      expect(words.includes('The old column "Queued for CodeLead" is kept for a while: it supplies its untagged cards after the tagged cards.')).toBe(config === legacy);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("a board made before Ready", () => {
  it("opens, lists, moves and validates as before; a move to Ready says how to get the column", async () => {
    const b = await board({ old: true });
    createCard(b.ctx, "robin", { type: "task", title: "One", fields: ALL });
    expect(moveCard(b.ctx, 1, { as: "claude", to: "in-progress" }).card.column).toBe("in-progress");
    expect(moveCard(b.ctx, 1, { as: "robin", to: "backlog" }).card.column).toBe("backlog");
    expect(validateBoard(b.ctx).problems).toEqual([]);
    expect(await runBoardList({}, b.deps)).toBe(0);
    expect(b.said().split("\n").filter((line) => !line.startsWith(" "))).toEqual(["Inbox (0)", "Backlog (1)", "Ideas (0)", "Pinned (0)", "In progress (0)", "For review (0)", "Done (0)"]);
    expect(refusal(() => moveCard(b.ctx, 1, { as: "robin", to: "ready" })).message).toBe(
      'Refused: "ready" is not a column of the board (inbox, backlog, ideas, pinned, in-progress, for-review, done). Nothing was written. `codelead board add-ready` gives the board its Ready column.'
    );
  });

  it("gains the column from add-ready: before In progress, every key kept, AGENTS.md written again, no card moved, no event; once", async () => {
    const b = await board({ old: true });
    const config = readBoardConfig(b.dir).config;
    fs.writeFileSync(path.join(b.dir, "board.json"), `${JSON.stringify({ ...config, house: { rule: "kept" } }, null, 2)}\n`);
    createCards(b.ctx, "robin", [{ type: "task", title: "One", column: "pinned" }, { type: "task", title: "Two" }]);
    const cards = fs.readdirSync(path.join(b.dir, "items")).map((name) => fs.readFileSync(path.join(b.dir, "items", name), "utf8"));
    const events = b.events();
    const result = addReadyColumn(b.ctx);
    expect(result).toEqual({ added: true, column: { id: "ready", name: "Ready", owner: "person" }, after: "pinned", before: "in-progress", guide: "written" });
    const now = readBoardConfig(b.dir).config;
    expect(now.columns.map((column) => column.id)).toEqual(["inbox", "backlog", "ideas", "pinned", "ready", "in-progress", "for-review", "done"]);
    expect(now.house).toEqual({ rule: "kept" });
    expect(now.nextId).toBe(3);
    expect(fs.readFileSync(path.join(b.dir, "AGENTS.md"), "utf8")).toBe(agentsGuide(now));
    expect(fs.readdirSync(path.join(b.dir, "items")).map((name) => fs.readFileSync(path.join(b.dir, "items", name), "utf8"))).toEqual(cards);
    expect(b.events()).toBe(events);
    expect(validateBoard(b.ctx).problems).toEqual([]);
    // Once: a board that has Ready is left as it is.
    const raw = fs.readFileSync(path.join(b.dir, "board.json"), "utf8");
    expect(addReadyColumn(b.ctx)).toEqual({ added: false, column: { id: "ready", name: "Ready", owner: "person" }, after: "pinned", before: "in-progress", guide: "unchanged" });
    expect(fs.readFileSync(path.join(b.dir, "board.json"), "utf8")).toBe(raw);
  });

  it("leaves a guide someone changed as it is and gives its lines; writes one that is missing; keeps a guide's line endings", async () => {
    const edited = await board({ old: true });
    fs.appendFileSync(path.join(edited.dir, "AGENTS.md"), "\n## House rules\nOne card per ask.\n");
    const text = fs.readFileSync(path.join(edited.dir, "AGENTS.md"), "utf8");
    const result = addReadyColumn(edited.ctx);
    expect(result.guide).toBe("kept");
    expect(result.section).toBe(readySection(readBoardConfig(edited.dir).config));
    expect(fs.readFileSync(path.join(edited.dir, "AGENTS.md"), "utf8")).toBe(text);

    const missing = await board({ old: true });
    fs.rmSync(path.join(missing.dir, "AGENTS.md"));
    expect(addReadyColumn(missing.ctx).guide).toBe("created");
    expect(fs.readFileSync(path.join(missing.dir, "AGENTS.md"), "utf8")).toBe(agentsGuide(readBoardConfig(missing.dir).config));

    const crlf = await board({ old: true });
    const guide = path.join(crlf.dir, "AGENTS.md");
    fs.writeFileSync(guide, fs.readFileSync(guide, "utf8").replace(/\n/g, "\r\n"));
    expect(addReadyColumn(crlf.ctx).guide).toBe("written");
    expect(fs.readFileSync(guide, "utf8")).toBe(agentsGuide(readBoardConfig(crlf.dir).config).replace(/\n/g, "\r\n"));
  });

  it("puts the column at the end of a board without In progress, and refuses a column ready that is not the person's", async () => {
    const b = await board({ old: true });
    const config = readBoardConfig(b.dir).config;
    const own = { ...config, columns: [{ id: "todo", name: "To do" }, { id: "check", name: "Check" }], agents: { ...config.agents, mayMoveTo: ["todo", "check"] } };
    fs.writeFileSync(path.join(b.dir, "board.json"), JSON.stringify(own));
    expect(addReadyColumn(b.ctx)).toMatchObject({ added: true, after: "check" });
    expect(readBoardConfig(b.dir).config.columns.map((column) => column.id)).toEqual(["todo", "check", "ready"]);
    // With no In progress, an agent cannot take a card out of Ready at all.
    createCard(b.ctx, "robin", { type: "task", title: "One", column: "ready", fields: ALL });
    expect(refusal(() => moveCard(b.ctx, 1, { as: "claude", to: "check" })).message).toBe(
      "Refused: claude is an agent and may not move a card out of Ready: the board has no column an agent takes it into. Nothing was written."
    );

    const theirs = await board({ old: true });
    const before = readBoardConfig(theirs.dir).config;
    fs.writeFileSync(path.join(theirs.dir, "board.json"), JSON.stringify({ ...before, columns: [...before.columns, { id: "ready", name: "Ready to ship" }] }));
    const raw = fs.readFileSync(path.join(theirs.dir, "board.json"), "utf8");
    const refused = refusal(() => addReadyColumn(theirs.ctx));
    expect([refused.code, refused.message]).toEqual([
      "column",
      'Refused: board.json has a column "ready" that is not the person\'s, so it cannot be Ready: make it the person\'s ("owner": "person", and out of agents.mayMoveTo), or give it another id, then run this again. Nothing was written.'
    ]);
    expect(fs.readFileSync(path.join(theirs.dir, "board.json"), "utf8")).toBe(raw);
    // Such a column is the board's own, as before: no Ready check.
    createCard(theirs.ctx, "robin", { type: "task", title: "Shipping" });
    expect(moveCard(theirs.ctx, 1, { as: "robin", to: "ready" }).card.column).toBe("ready");
  });
});

// ---------------------------------------------------------------------------------------------

describe("the commands: the same check in the same words; --json carries its parts", () => {
  it("move --to ready refuses with the words and exit 1, and moves once set sets the three", async () => {
    const b = await board();
    await runBoardNew({ as: "claude", type: "task", title: "Rate-limit the sign-in form", column: "backlog" }, b.deps);
    b.said();
    expect(await runBoardMove("1", { as: "robin", to: "ready" }, b.deps)).toBe(1);
    expect(b.said()).toBe(`Card #1 cannot go to Ready yet: ${DONE}, ${TOUCH}, and ${LIMIT}. Nothing was written: set what is missing, then move it again.`);
    expect(await runBoardMove("1", { as: "robin", to: "ready", json: true }, b.deps)).toBe(1);
    expect(JSON.parse(b.said())).toEqual({
      refused: "ready",
      message: `Card #1 cannot go to Ready yet: ${DONE}, ${TOUCH}, and ${LIMIT}. Nothing was written: set what is missing, then move it again.`,
      card: 1,
      missing: [
        { what: "done-when", fields: ["definitionOfDone"], words: DONE },
        { what: "may-touch", fields: ["mayTouch"], words: TOUCH },
        { what: "limit", fields: ["limitMinutes", "limitMoney"], words: LIMIT }
      ]
    });
    expect(await runBoardSet("1", { as: "robin", field: ["definitionOfDone=npm test passes", 'mayTouch=["src/auth/", "test/auth.test.ts"]', "limitMinutes=30"] }, b.deps)).toBe(0);
    expect(b.said()).toBe("#1: changed its fields.");
    expect(await runBoardMove("1", { as: "robin", to: "ready" }, b.deps)).toBe(0);
    expect(b.said()).toBe("Moved #1 from Backlog to Ready.");
    expect(getCard(b.ctx, 1).card.fields).toEqual({ definitionOfDone: "npm test passes", mayTouch: ["src/auth/", "test/auth.test.ts"], limitMinutes: 30 });
  });

  it("refuses an agent in the same words as the core, takes a card into In progress, and sets the fields on any type", async () => {
    const b = await board();
    await runBoardNew({ as: "robin", type: "question", title: "Which store?", field: ["definitionOfDone=The thread has the answer.", "mayTouch=docs/", "limitMoney=0"] }, b.deps);
    b.said();
    expect(await runBoardMove("1", { as: "claude", to: "ready" }, b.deps)).toBe(1);
    expect(b.said()).toBe(AGENT_INTO);
    expect(await runBoardMove("1", { as: "robin", to: "ready" }, b.deps)).toBe(0);
    b.said();
    expect(await runBoardSet("1", { as: "claude", field: ["limitMoney=10"], json: true }, b.deps)).toBe(1);
    expect(JSON.parse(b.said()).refused).toBe("not-allowed");
    expect(await runBoardMove("1", { as: "claude", to: "backlog" }, b.deps)).toBe(1);
    expect(b.said()).toBe("Refused: claude is an agent and may move a card out of Ready only into In progress, to take it; not into Backlog. Nothing was written.");
    expect(await runBoardMove("1", { as: "claude", to: "in-progress" }, b.deps)).toBe(0);
    expect(b.said()).toBe("Moved #1 from Ready to In progress.");
    // A limit that is no number: refused by the rule (exit 1), not as a malformed command.
    expect(await runBoardSet("1", { as: "robin", field: ["limitMinutes=soon"], json: true }, b.deps)).toBe(1);
    expect(JSON.parse(b.said()).refused).toBe("ready");
  });

  it("answers a move of several cards card by card, with the parts in --json", async () => {
    const b = await board();
    await runBoardNew({ as: "robin", type: "task", title: "One", field: ["definitionOfDone=It works.", "mayTouch=src/", "limitMinutes=20"] }, b.deps);
    await runBoardNew({ as: "robin", type: "task", title: "Two" }, b.deps);
    b.said();
    expect(await runBoardMove(["1", "2"], { as: "robin", to: "ready" }, b.deps)).toBe(1);
    expect(b.said()).toBe(
      ["Moved to Ready (1 changed, 1 refused):", "  #1 from Inbox", `  #2 refused: Card #2 cannot go to Ready yet: ${DONE}, ${TOUCH}, and ${LIMIT}. Nothing was written: set what is missing, then move it again.`].join("\n")
    );
    expect(await runBoardMove(["2"], { as: "robin", to: "ready", json: true }, b.deps)).toBe(1);
    expect(JSON.parse(b.said())).toMatchObject({ refused: "ready", card: 2, missing: [{ what: "done-when" }, { what: "may-touch" }, { what: "limit" }] });
  });

  it("add-ready says what it did, once, and prints the lines for a guide it leaves as it is", async () => {
    const b = await board({ old: true });
    expect(await runBoardAddReady({}, b.deps)).toBe(0);
    expect(b.said()).toBe(
      [
        "Added the column Ready to board.json, between Pinned and In progress. It is yours: put a card there that an agent may pick up by itself, once the card says how to tell it is done, what it may touch and its limit.",
        "AGENTS.md is written again, with the Ready rules.",
        "No card was moved."
      ].join("\n")
    );
    expect(await runBoardAddReady({}, b.deps)).toBe(0);
    expect(b.said()).toBe('The board has Ready already (the column "ready", between Pinned and In progress); nothing was written.');
    expect(await runBoardAddReady({ json: true }, b.deps)).toBe(0);
    expect(JSON.parse(b.said())).toEqual({ added: false, column: { id: "ready", name: "Ready", owner: "person" }, after: "pinned", before: "in-progress", guide: "unchanged" });

    const edited = await board({ old: true });
    fs.appendFileSync(path.join(edited.dir, "AGENTS.md"), "\n## House rules\nOne card per ask.\n");
    expect(await runBoardAddReady({}, edited.deps)).toBe(0);
    const said = edited.said();
    expect(said).toContain('AGENTS.md is left as it is: it is not the text this package wrote for the board (someone changed it). Add these lines to it, before "## Work the person asked for":\n\n## Ready\nReady is the person\'s column');
    expect(said.endsWith("\n\nNo card was moved.")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------

describe("the page's process refuses the same way: one function in the core decides", () => {
  async function serve(b: Board, command?: string): Promise<<T>(method: string, route: string, body?: unknown) => Promise<{ status: number; body: T }>> {
    const pageDir = path.join(b.root, "..", "page");
    fs.mkdirSync(pageDir, { recursive: true });
    fs.writeFileSync(path.join(pageDir, "index.html"), '<!doctype html><html><body><div id="root"></div></body></html>');
    const server = createBoardServer({ dir: b.dir, root: b.root, home: path.join(b.root, "..", "home"), now: () => new Date("2026-11-25T10:00:00Z"), pageDir, watch: false, log: () => undefined, ...(command ? { command } : {}) });
    const { url } = await server.listen(0);
    cleanups.push(() => server.close());
    return async <T>(method: string, route: string, body?: unknown) => {
      const response = await fetch(new URL(route, url), { method, headers: { "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: (await response.json()) as T };
    };
  }

  it("a move to Ready: 422 with the words and the parts until the card says the three things; then it moves", async () => {
    const b = await board();
    createCard(b.ctx, "robin", { type: "task", title: "One", column: "backlog", fields: { definitionOfDone: "It works." } });
    const call = await serve(b);
    const refused = await call<RefusalPayload>("POST", "/api/items/1/move", { to: "ready" });
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({
      refused: "ready",
      message: `Card #1 cannot go to Ready yet: ${TOUCH}, and ${LIMIT}. Nothing was written: set what is missing, then move it again.`,
      card: 1,
      missing: [
        { what: "may-touch", fields: ["mayTouch"], words: TOUCH },
        { what: "limit", fields: ["limitMinutes", "limitMoney"], words: LIMIT }
      ]
    });
    expect(getCard(b.ctx, 1).card.column).toBe("backlog");
    const set = await call<WritePayload>("PUT", "/api/items/1", { changes: { fields: { mayTouch: ["src/"], limitMinutes: "25" } } });
    expect(set.status).toBe(200);
    expect(set.body.card.card.fields).toMatchObject({ mayTouch: ["src/"], limitMinutes: 25 });
    const moved = await call<WritePayload>("POST", "/api/items/1/move", { to: "ready", expectUpdated: set.body.card.card.updated });
    expect(moved.status).toBe(200);
    expect(moved.body.summary.column).toBe("ready");
    // Taking a field away from a card in Ready: refused, in the core's words.
    const removed = await call<RefusalPayload>("PUT", "/api/items/1", { changes: { fields: { mayTouch: null } } });
    expect([removed.status, removed.body.refused]).toEqual([422, "ready"]);
  });

  it("a bulk move: each card on its own, the refused one with its reason and what it misses", async () => {
    const b = await board();
    createCards(b.ctx, "robin", [{ type: "task", title: "One", fields: ALL }, { type: "task", title: "Two" }]);
    const call = await serve(b);
    const { status, body } = await call<BatchPayload>("POST", "/api/cards/batch", { operation: "move", ids: [1, 2], to: "ready" });
    expect(status).toBe(200);
    expect([body.changed, body.refused]).toEqual([1, 1]);
    expect(body.results[1]!.refused).toMatchObject({ code: "ready", reason: `cannot go to Ready yet: ${DONE}, ${TOUCH}, and ${LIMIT}`, missing: [{ what: "done-when" }, { what: "may-touch" }, { what: "limit" }] });
  });

  it("a new card made in Ready gives the three things with it, or is refused", async () => {
    const b = await board();
    const call = await serve(b);
    const refused = await call<RefusalPayload>("POST", "/api/items", { type: "task", title: "Straight to Ready", column: "ready" });
    expect([refused.status, refused.body.refused, refused.body.message]).toEqual([422, "ready", `The new card cannot go to Ready yet: ${DONE}, ${TOUCH}, and ${LIMIT}. Nothing was written: set what is missing, then create it again.`]);
    const made = await call<WritePayload>("POST", "/api/items", { type: "task", title: "Straight to Ready", column: "ready", fields: { definitionOfDone: "It works.", mayTouch: ["src/"], limitMinutes: "10", limitMoney: null } });
    expect(made.status).toBe(201);
    expect(made.body.card.card.fields).toEqual({ definitionOfDone: "It works.", mayTouch: ["src/"], limitMinutes: 10 });
  });

  it("tells the page where Ready is, and on a board without it what to run, in the host's words", async () => {
    const b = await board();
    const ready = (await (await serve(b))<BoardPayload>("GET", "/api/board")).body.ready;
    expect(ready).toEqual({ column: "ready", fields: { doneWhen: "definitionOfDone", mayTouch: "mayTouch", limitMinutes: "limitMinutes", limitMoney: "limitMoney" }, command: "pinboard add-ready" });
    const old = await board({ old: true });
    createCard(old.ctx, "robin", { type: "task", title: "One" });
    const call = await serve(old, "codelead board");
    const payload = (await call<BoardPayload>("GET", "/api/board")).body;
    expect(payload.ready).toEqual({ fields: { doneWhen: "definitionOfDone", mayTouch: "mayTouch", limitMinutes: "limitMinutes", limitMoney: "limitMoney" }, command: "codelead board add-ready" });
    expect(payload.columns.map((column) => column.id)).toEqual(["inbox", "backlog", "ideas", "pinned", "in-progress", "for-review", "done"]);
    // The old board's moves, as before.
    expect((await call<WritePayload>("POST", "/api/items/1/move", { to: "done" })).status).toBe(200);
    expect((await call<RefusalPayload>("POST", "/api/items/1/move", { to: "ready" })).body.refused).toBe("column");
  });
});
