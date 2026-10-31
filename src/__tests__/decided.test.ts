import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBoardCheck, runBoardInit, runBoardNew, runBoardSet, runBoardValidate, type BoardCliDependencies } from "../cli/board.js";
import {
  addComment,
  boardContext,
  BoardRefusal,
  checkBoard,
  createCard,
  createCards,
  decisionOf,
  describeEvent,
  getCard,
  updateCard,
  validateBoard,
  type BoardContext,
  type BoardEvent,
  type CardChanges
} from "../core/index.js";
import { createBoardServer, statusOfRefusal, type BoardPayload, type RefusalPayload, type WritePayload } from "../server/index.js";

/**
 * Pinboard package 3b: a decision recorded in a card's fields is an answer the check says. The
 * `item.updated` that sets, changes or removes `fields.decided` carries it as `data.decided`
 * (`{ option, by, on }`, or null), and so does the `item.created` of a card made with one, through
 * every writer of the core; only a person gives a decision or takes one away; the check lists those
 * cards apart, under "Decided", right after what is addressed to the participant; `validate` names
 * a decision that is no `{ option, by, on }`; the page's process gives the tile what was decided.
 * The page's own flow is in page.browser.test.ts. The board's participants are robin (a person)
 * and claude (an agent).
 */
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function temporary(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

interface Terminal {
  root: string;
  dir: string;
  deps: BoardCliDependencies;
  ctx: BoardContext;
  tick: (seconds?: number) => void;
  said: () => string;
  read: (relative: string) => string;
  write: (relative: string, text: string) => void;
  fileOf: (id: number) => string;
}

/** A board of the test's own, made by `codelead board init`, with a clock that moves only when told. */
async function terminal(): Promise<Terminal> {
  const root = await temporary("pinboard-decided-");
  fs.mkdirSync(path.join(root, ".git"));
  let time = Date.parse("2026-10-05T10:00:00Z");
  const lines: string[] = [];
  const now = (): Date => new Date(time);
  const dir = path.join(root, "docs", "codelead", "board");
  const term: Terminal = {
    root,
    dir,
    deps: { cwd: () => root, output: (line) => lines.push(line), now, home: "/home/tester" },
    ctx: boardContext({ dir, root, home: "/home/tester", now }),
    tick: (seconds = 60) => {
      time += seconds * 1000;
    },
    said: () => lines.splice(0).join("\n"),
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
  expect(await runBoardInit({ name: "test-workspace", person: ["robin:Robin"], agent: ["claude:Claude Code"] }, term.deps)).toBe(0);
  term.said();
  return term;
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

const DECIDED = { option: "Go with Claude's proposal", by: "robin", on: "2026-10-05" };

/** A decision Claude asks of Robin, as card #33 was: the ask, the options. */
function askedDecision(term: Terminal, title = "Blank page as a hard regression"): void {
  createCard(term.ctx, "claude", {
    type: "decision",
    title,
    column: "backlog",
    fields: { ask: "Treat a verified page going blank as a hard regression? I recommend it.", options: ["Go with Claude's proposal", "Other"] }
  });
}

// ---------------------------------------------------------------------------------------------

describe("the event records the decision: data.decided beside data.fields, from every writer", () => {
  it("setting, changing and removing fields.decided carries it on the item.updated, null once removed; other changes do not", async () => {
    const term = await terminal();
    askedDecision(term);
    term.tick();
    const set = updateCard(term.ctx, 1, { as: "robin", changes: { fields: { decided: DECIDED } } });
    expect(set.events).toEqual([{ at: "2026-10-05T10:01:00Z", by: "robin", item: 1, kind: "item.updated", data: { fields: ["fields"], decided: DECIDED } }]);
    expect(getCard(term.ctx, 1).card.fields.decided).toEqual(DECIDED);
    expect(term.read(term.fileOf(1))).toContain('  decided:\n    option: "Go with Claude\'s proposal"\n    by: robin\n    "on": 2026-10-05\n');
    // The line as the log keeps it: the decision right beside the fields it changed.
    expect(term.read("events.jsonl").trimEnd().split("\n").at(-1)).toBe(
      '{"at":"2026-10-05T10:01:00Z","by":"robin","item":1,"kind":"item.updated","data":{"fields":["fields"],"decided":{"option":"Go with Claude\'s proposal","by":"robin","on":"2026-10-05"}}}'
    );
    // The same decision again: nothing to change, nothing written.
    expect(updateCard(term.ctx, 1, { as: "robin", changes: { fields: { decided: { ...DECIDED } } } }).events).toEqual([]);
    term.tick();
    const changed = updateCard(term.ctx, 1, { as: "robin", changes: { fields: { decided: { option: "Other", by: "robin", on: "2026-10-05" } } } });
    expect(changed.events.map((event) => event.data)).toEqual([{ fields: ["fields"], decided: { option: "Other", by: "robin", on: "2026-10-05" } }]);
    // Another field, the status, a tag: no decision on those events.
    expect(updateCard(term.ctx, 1, { as: "robin", changes: { fields: { options: ["Go with Claude's proposal", "Other", "Neither"] } } }).events.map((event) => event.data)).toEqual([{ fields: ["fields"] }]);
    expect(updateCard(term.ctx, 1, { as: "robin", changes: { status: "decided", addTags: ["decision-made"] } }).events.map((event) => event.data)).toEqual([{ fields: ["status"] }, { tag: "decision-made" }]);
    term.tick();
    const removed = updateCard(term.ctx, 1, { as: "robin", changes: { fields: { decided: null } } });
    expect(removed.events).toEqual([{ at: "2026-10-05T10:03:00Z", by: "robin", item: 1, kind: "item.updated", data: { fields: ["fields"], decided: null } }]);
    expect(getCard(term.ctx, 1).card.fields.decided).toBeUndefined();
    expect(term.read(term.fileOf(1))).not.toContain("decided:");
    // Removing a decision there is not: nothing written.
    expect(updateCard(term.ctx, 1, { as: "robin", changes: { fields: { decided: null } } }).events).toEqual([]);
    // In the same write as another change: the event names both, the decision beside them.
    const both = updateCard(term.ctx, 1, { as: "robin", changes: { status: "settled", fields: { decided: DECIDED } } });
    expect(both.events.map((event) => event.data)).toEqual([{ fields: ["status", "fields"], decided: DECIDED }]);
    expect(describeEvent(both.events[0]!)).toBe("changed its status; decided: Go with Claude's proposal (by robin, 2026-10-05)");
  });

  it("a text is the option chosen, by the writer, today; a mapping without by or on is completed the same way, its other keys kept", async () => {
    const term = await terminal();
    askedDecision(term);
    term.tick(3600 * 14);
    const text = updateCard(term.ctx, 1, { as: "robin", changes: { fields: { decided: "  Go with Claude's proposal " } } });
    expect(text.events[0]!.data).toEqual({ fields: ["fields"], decided: { option: "Go with Claude's proposal", by: "robin", on: "2026-10-06" } });
    expect(getCard(term.ctx, 1).card.fields.decided).toEqual({ option: "Go with Claude's proposal", by: "robin", on: "2026-10-06" });
    const partial = updateCard(term.ctx, 1, { as: "robin", changes: { fields: { decided: { option: "Other", why: "the third option" } } } });
    expect(getCard(term.ctx, 1).card.fields.decided).toEqual({ option: "Other", by: "robin", on: "2026-10-06", why: "the third option" });
    // The event carries the decision: its option, who and when.
    expect(partial.events[0]!.data).toEqual({ fields: ["fields"], decided: { option: "Other", by: "robin", on: "2026-10-06" } });
    // A key beside the decision changing is no new decision: the fields changed, the decision did not.
    expect(updateCard(term.ctx, 1, { as: "robin", changes: { fields: { decided: { option: "Other", by: "robin", on: "2026-10-06", why: "a better reason" } } } }).events[0]!.data).toEqual({ fields: ["fields"] });
    // A UTC time is a day too; an empty text is no decision.
    expect(updateCard(term.ctx, 1, { as: "robin", changes: { fields: { decided: { option: "Other", by: "robin", on: "2026-10-06T00:30:00Z" } } } }).events[0]!.data).toMatchObject({ decided: { on: "2026-10-06T00:30:00Z" } });
    expect(updateCard(term.ctx, 1, { as: "robin", changes: { fields: { decided: " " } } }).events[0]!.data).toEqual({ fields: ["fields"], decided: null });
  });

  it("refuses, in words and writing nothing, a decision with no option, by someone who is no participant, on no day, or that is a list", async () => {
    const term = await terminal();
    askedDecision(term);
    const file = term.read(term.fileOf(1));
    const log = term.read("events.jsonl");
    const refused = (decided: unknown): string => refusal(() => updateCard(term.ctx, 1, { as: "robin", changes: { fields: { decided: decided as never } } })).message;
    expect(refused({ option: "Other", by: "ghost", on: "2026-10-05" })).toBe('Refused: the decision names "ghost" as who decided (by), who is not a participant of the board. Nothing was written.');
    expect(refused({ option: "", by: "robin", on: "yesterday" })).toBe(
      'Refused: the decision has no option chosen (option: a text); has "yesterday" as its day (on), which is no date like 2026-10-05. Nothing was written.'
    );
    expect(refused({ option: "Other", by: "robin", on: "2026-02-30" })).toBe('Refused: the decision has "2026-02-30" as its day (on), which is no date like 2026-10-05. Nothing was written.');
    expect(refused(["Other"])).toBe('Refused: the decision must be the option chosen (a text) or { option, by, on }, and is ["Other"]. Nothing was written.');
    expect(refusal(() => updateCard(term.ctx, 1, { as: "robin", changes: { fields: { decided: 2 } } })).code).toBe("usage");
    expect(term.read(term.fileOf(1))).toBe(file);
    expect(term.read("events.jsonl")).toBe(log);
    // A new card is checked the same way: a text becomes the decision, and its creation carries it.
    const created = createCard(term.ctx, "robin", { type: "decision", title: "Recorded", fields: { decided: "Keep it" } });
    expect(created.card.fields.decided).toEqual({ option: "Keep it", by: "robin", on: "2026-10-05" });
    expect(created.events[0]!.data).toEqual({ title: "Recorded", type: "decision", column: "inbox", decided: { option: "Keep it", by: "robin", on: "2026-10-05" } });
    expect(refusal(() => createCards(term.ctx, "robin", [{ type: "decision", title: "Wrong", fields: { decided: { option: "A", by: "nobody" } } }])).message).toBe(
      'Refused: the decision names "nobody" as who decided (by), who is not a participant of the board. Nothing was written.'
    );
  });

  it("set --field decided=… and --unset-field decided write it on the command line, and say it in words", async () => {
    const term = await terminal();
    askedDecision(term);
    term.tick();
    expect(await runBoardSet("1", { as: "robin", field: ["decided=Go with Claude's proposal"] }, term.deps)).toBe(0);
    expect(term.said()).toBe("#1: decided: Go with Claude's proposal (by robin, 2026-10-05).");
    expect(await runBoardSet("1", { as: "robin", field: ['decided={"option":"Other","by":"robin","on":"2026-10-04"}'], json: true }, term.deps)).toBe(0);
    expect(JSON.parse(term.said()).events[0].data).toEqual({ fields: ["fields"], decided: { option: "Other", by: "robin", on: "2026-10-04" } });
    expect(await runBoardSet("1", { as: "robin", unsetField: ["decided"] }, term.deps)).toBe(0);
    expect(term.said()).toBe("#1: removed its decision.");
    expect(await runBoardSet("1", { as: "robin", field: ['decided={"option":"Other","by":"codex"}'] }, term.deps)).toBe(2);
    expect(term.said()).toBe('Refused: the decision names "codex" as who decided (by), who is not a participant of the board. Nothing was written.');
    expect(await runBoardNew({ as: "robin", type: "decision", title: "Already decided", field: ["decided=Yes"], json: true }, term.deps)).toBe(0);
    expect(JSON.parse(term.said()).card.fields.decided).toEqual({ option: "Yes", by: "robin", on: "2026-10-05" });
  });

  it("reads data.decided on an event; an event without it, as every event before the rule, says nothing of a decision", () => {
    const at = "2026-10-05T10:00:00Z";
    const updated = (data: Record<string, unknown>): BoardEvent => ({ at, by: "robin", item: 1, kind: "item.updated", data });
    expect(decisionOf(updated({ fields: ["fields"], decided: DECIDED }))).toEqual(DECIDED);
    expect(decisionOf(updated({ fields: ["fields"], decided: null }))).toBeNull();
    expect(decisionOf(updated({ fields: ["fields"] }))).toBeUndefined();
    expect(decisionOf({ at, by: "robin", item: 1, kind: "comment.added" })).toBeUndefined();
    expect(decisionOf(updated({ fields: ["fields"], decided: { by: "robin" } }))).toBeUndefined();
    expect(describeEvent(updated({ fields: ["fields"], decided: DECIDED }))).toBe("decided: Go with Claude's proposal (by robin, 2026-10-05)");
    expect(describeEvent(updated({ fields: ["fields"], decided: null }))).toBe("removed its decision");
    // Before the rule: as it always read.
    expect(describeEvent(updated({ fields: ["fields"] }))).toBe("changed its fields");
  });
});

// ---------------------------------------------------------------------------------------------

const AGENT_REFUSED = "Refused: claude is an agent; the decision is the person's: an agent writes its recommendation in fields.ask. Nothing was written.";

describe("the decision is the person's: an agent's write of it is refused, a person's is as it was", () => {
  it("refuses an agent setting, changing or removing a card's decision, or creating a card with one, in words and writing nothing", async () => {
    const term = await terminal();
    askedDecision(term);
    const byClaude = (decided: unknown, more: CardChanges = {}): BoardRefusal => refusal(() => updateCard(term.ctx, 1, { as: "claude", changes: { ...more, fields: { decided: decided as never } } }));
    const files = (): { card: string; log: string } => ({ card: term.read(term.fileOf(1)), log: term.read("events.jsonl") });
    let before = files();
    // Setting it, as a text or a mapping, alone or with another change: refused before its shape is read.
    const set = byClaude("Go with Claude's proposal");
    expect(set.message).toBe(AGENT_REFUSED);
    expect(set.code).toBe("usage");
    // The page's process answers this code with 422 (the page itself writes as the board's person).
    expect(statusOfRefusal(set.code)).toBe(422);
    expect(byClaude(DECIDED).message).toBe(AGENT_REFUSED);
    expect(byClaude(DECIDED, { status: "decided by claude" }).message).toBe(AGENT_REFUSED);
    expect(byClaude({ option: "A", by: "ghost" }).message).toBe(AGENT_REFUSED);
    expect(files()).toEqual(before);
    // Removing a decision the card does not have writes nothing, whoever asks.
    expect(updateCard(term.ctx, 1, { as: "claude", changes: { fields: { decided: null } } }).events).toEqual([]);
    // The person decides, as before.
    term.tick();
    expect(updateCard(term.ctx, 1, { as: "robin", changes: { fields: { decided: DECIDED } } }).events[0]!.data).toEqual({ fields: ["fields"], decided: DECIDED });
    before = files();
    // Changing it, giving it again as it was, removing it (null or an empty text): refused.
    expect(byClaude({ option: "Other", by: "robin", on: "2026-10-05" }).message).toBe(AGENT_REFUSED);
    expect(byClaude(DECIDED).message).toBe(AGENT_REFUSED);
    expect(byClaude(null).message).toBe(AGENT_REFUSED);
    expect(byClaude("").message).toBe(AGENT_REFUSED);
    expect(files()).toEqual(before);
    // The agent's other writes go on: its recommendation is the ask.
    expect(updateCard(term.ctx, 1, { as: "claude", changes: { fields: { ask: "Make it a hard regression? I recommend it." } } }).events[0]!.data).toEqual({ fields: ["ask"] });
    // A new card with a decision, by an agent: refused; with none, made as before.
    expect(refusal(() => createCard(term.ctx, "claude", { type: "decision", title: "Decided for you", fields: { decided: "Keep it" } })).message).toBe(AGENT_REFUSED);
    expect(createCard(term.ctx, "claude", { type: "decision", title: "Asked of you", fields: { ask: "Keep it? I recommend it.", decided: null } }).card.fields).toEqual({ ask: "Keep it? I recommend it." });
    // The person takes the decision away, as before.
    term.tick();
    expect(updateCard(term.ctx, 1, { as: "robin", changes: { fields: { decided: null } } }).events[0]!.data).toEqual({ fields: ["fields"], decided: null });
  });

  it("on the command line: set --field decided=…, --unset-field decided and new --field decided=… as an agent exit 2 with the words", async () => {
    const term = await terminal();
    askedDecision(term);
    expect(await runBoardSet("1", { as: "claude", field: ["decided=Go with Claude's proposal"] }, term.deps)).toBe(2);
    expect(term.said()).toBe(AGENT_REFUSED);
    expect(await runBoardSet("1", { as: "robin", field: ["decided=Go with Claude's proposal"] }, term.deps)).toBe(0);
    expect(term.said()).toBe("#1: decided: Go with Claude's proposal (by robin, 2026-10-05).");
    expect(await runBoardSet("1", { as: "claude", unsetField: ["decided"] }, term.deps)).toBe(2);
    expect(term.said()).toBe(AGENT_REFUSED);
    expect(await runBoardSet("1", { as: "claude", field: ["decided=Other"], json: true }, term.deps)).toBe(2);
    expect(JSON.parse(term.said())).toEqual({ refused: "usage", message: AGENT_REFUSED });
    expect(await runBoardNew({ as: "claude", type: "decision", title: "Decided for you", field: ["decided=Yes"] }, term.deps)).toBe(2);
    expect(term.said()).toBe(AGENT_REFUSED);
    expect(getCard(term.ctx, 1).card.fields.decided).toEqual({ option: "Go with Claude's proposal", by: "robin", on: "2026-10-05" });
  });
});

// ---------------------------------------------------------------------------------------------

describe("codelead board check: a decision recorded in the fields is listed apart, as an answer", () => {
  it("card #33 as it happened: the decision under Decided, counted apart, the card's other news under Also new; --json carries decided", async () => {
    const term = await terminal();
    askedDecision(term);
    expect(await runBoardCheck({ as: "claude", ack: true }, term.deps)).toBe(0);
    term.said();
    term.tick();
    updateCard(term.ctx, 1, { as: "robin", changes: { fields: { options: ["Go with Claude's proposal", "Other", "Neither"] } } });
    term.tick();
    updateCard(term.ctx, 1, { as: "robin", changes: { fields: { decided: DECIDED } } });
    term.tick();
    updateCard(term.ctx, 1, { as: "robin", changes: { addTags: ["decision-made"] } });
    term.tick();
    updateCard(term.ctx, 1, { as: "robin", changes: { color: "blue" } });
    expect(await runBoardCheck({ as: "claude" }, term.deps)).toBe(0);
    expect(term.said().split("\n")).toEqual([
      "claude: 4 new on 1 card since 2026-10-05T10:00:00Z, 1 decided.",
      "",
      "Decided (1)",
      "",
      "#1 Blank page as a hard regression: decided: Go with Claude's proposal (by robin, 2026-10-05)",
      "",
      "Also new",
      "",
      "#1 Blank page as a hard regression  (decision · Backlog)",
      "  robin · 2026-10-05T10:01:00Z  changed its fields",
      "  robin · 2026-10-05T10:03:00Z  tagged it decision-made",
      "  robin · 2026-10-05T10:04:00Z  changed its color",
      "",
      "Run again with --ack once these are dealt with. Next check in 30 minutes."
    ]);
    expect(await runBoardCheck({ as: "claude", json: true }, term.deps)).toBe(0);
    const json = JSON.parse(term.said()) as { notifications: unknown[]; addressed: unknown[]; decided: unknown[]; groups: Array<{ events: unknown[] }> };
    expect(json.decided).toEqual([{ at: "2026-10-05T10:02:00Z", by: "robin", item: 1, kind: "item.updated", data: { fields: ["fields"], decided: DECIDED } }]);
    expect(json.addressed).toEqual([]);
    // The JSON's notifications and groups keep every event, as before.
    expect(json.notifications).toHaveLength(4);
    expect(json.groups[0]!.events).toHaveLength(4);
    // Robin is not told of his own decision.
    expect(checkBoard(term.ctx, { as: "robin" }).decided).toEqual([]);
  });

  it("comes right after what is addressed to you; a card whose only news is its decision is not listed again, and no Also new is left", async () => {
    const term = await terminal();
    createCards(term.ctx, "claude", [
      { type: "decision", title: "Pick the cache", column: "backlog", fields: { options: ["A TTL", "A version key"] } },
      { type: "task", title: "Write the layer", column: "backlog" }
    ]);
    checkBoard(term.ctx, { as: "claude", ack: true });
    term.tick();
    addComment(term.ctx, 2, { as: "robin", body: "@claude, the layer waits on #1." });
    term.tick();
    updateCard(term.ctx, 1, { as: "robin", changes: { fields: { decided: "A TTL" } } });
    expect(await runBoardCheck({ as: "claude" }, term.deps)).toBe(0);
    expect(term.said().split("\n")).toEqual([
      "claude: 2 new on 2 cards since 2026-10-05T10:00:00Z, 1 addressed to you, 1 decided.",
      "",
      "Addressed to you (1)",
      "",
      "#2 Write the layer  (task · Backlog)",
      "  robin · 2026-10-05T10:01:00Z  commented: @claude, the layer waits on #1.",
      "",
      "Decided (1)",
      "",
      "#1 Pick the cache: decided: A TTL (by robin, 2026-10-05)",
      "",
      "Run again with --ack once these are dealt with. Next check in 30 minutes."
    ]);
  });

  it("says the decision as it stands: one changed is its last option; one removed is none, and its events read as such under Also new", async () => {
    const term = await terminal();
    createCards(term.ctx, "claude", [
      { type: "decision", title: "Pick the cache" },
      { type: "decision", title: "Name the key" }
    ]);
    checkBoard(term.ctx, { as: "claude", ack: true });
    term.tick();
    updateCard(term.ctx, 1, { as: "robin", changes: { fields: { decided: "A TTL" } } });
    term.tick();
    updateCard(term.ctx, 1, { as: "robin", changes: { fields: { decided: { option: "A version key", by: "robin", on: "2026-10-05" } } } });
    term.tick();
    updateCard(term.ctx, 2, { as: "robin", changes: { fields: { decided: "cache:v1" } } });
    term.tick();
    updateCard(term.ctx, 2, { as: "robin", changes: { fields: { decided: null } } });
    expect(await runBoardCheck({ as: "claude" }, term.deps)).toBe(0);
    expect(term.said().split("\n")).toEqual([
      "claude: 4 new on 2 cards since 2026-10-05T10:00:00Z, 1 decided.",
      "",
      "Decided (1)",
      "",
      "#1 Pick the cache: decided: A version key (by robin, 2026-10-05)",
      "",
      "Also new",
      "",
      "#2 Name the key  (decision · Inbox)",
      "  robin · 2026-10-05T10:03:00Z  decided: cache:v1 (by robin, 2026-10-05)",
      "  robin · 2026-10-05T10:04:00Z  removed its decision",
      "",
      "Run again with --ack once these are dealt with. Next check in 30 minutes."
    ]);
    expect(checkBoard(term.ctx, { as: "claude" }).decided.map((event) => [event.item, event.at])).toEqual([[1, "2026-10-05T10:02:00Z"]]);
  });

  it("keeps among the card's events a write that changed more than the decision, so that its other change is said too", async () => {
    const term = await terminal();
    askedDecision(term);
    checkBoard(term.ctx, { as: "claude", ack: true });
    term.tick();
    updateCard(term.ctx, 1, { as: "robin", changes: { status: "settled in the session", fields: { decided: "Other" } } });
    expect(await runBoardCheck({ as: "claude" }, term.deps)).toBe(0);
    expect(term.said().split("\n")).toEqual([
      "claude: 1 new on 1 card since 2026-10-05T10:00:00Z, 1 decided.",
      "",
      "Decided (1)",
      "",
      "#1 Blank page as a hard regression: decided: Other (by robin, 2026-10-05)",
      "",
      "Also new",
      "",
      "#1 Blank page as a hard regression  (decision · Backlog)",
      "  robin · 2026-10-05T10:01:00Z  changed its status; decided: Other (by robin, 2026-10-05)",
      "",
      "Run again with --ack once these are dealt with. Next check in 30 minutes."
    ]);
  });

  it("lists a card created with its decision (the person's new --field decided=…) under Decided; its creation keeps its line; validate reads it", async () => {
    const term = await terminal();
    checkBoard(term.ctx, { as: "claude", ack: true });
    term.tick();
    expect(await runBoardNew({ as: "robin", type: "decision", title: "Keep the TTL", field: ["decided=Keep it"], json: true }, term.deps)).toBe(0);
    const created = (JSON.parse(term.said()) as { events: BoardEvent[] }).events[0]!;
    expect(created.data).toEqual({ title: "Keep the TTL", type: "decision", column: "inbox", decided: { option: "Keep it", by: "robin", on: "2026-10-05" } });
    expect(decisionOf(created)).toEqual({ option: "Keep it", by: "robin", on: "2026-10-05" });
    expect(await runBoardCheck({ as: "claude" }, term.deps)).toBe(0);
    expect(term.said().split("\n")).toEqual([
      "claude: 1 new on 1 card since 2026-10-05T10:00:00Z, 1 decided.",
      "",
      "Decided (1)",
      "",
      "#1 Keep the TTL: decided: Keep it (by robin, 2026-10-05)",
      "",
      "Also new",
      "",
      "#1 Keep the TTL  (decision · Inbox)",
      "  robin · 2026-10-05T10:01:00Z  created it (decision in Inbox); decided: Keep it (by robin, 2026-10-05)",
      "",
      "Run again with --ack once these are dealt with. Next check in 30 minutes."
    ]);
    expect(checkBoard(term.ctx, { as: "claude" }).decided).toEqual([created]);
    expect(await runBoardValidate({}, term.deps)).toBe(0);
    expect(term.said()).toBe("The board is valid: 1 card, 1 event, 1 cursor.");
    // A creation whose decision is none is named, as an update's is.
    fs.appendFileSync(path.join(term.dir, "events.jsonl"), `${JSON.stringify({ at: "2026-10-05T10:02:00Z", by: "robin", item: 1, kind: "item.created", data: { title: "Keep the TTL", type: "decision", column: "inbox", decided: "Keep it" } })}\n`);
    expect(validateBoard(term.ctx).problems).toEqual([
      { file: "events.jsonl", message: `line 2: "data.decided" is "Keep it", not the decision recorded: { option, by, on }, the option chosen, who decided (a participant's id) and the day (2026-10-05)` }
    ]);
  });

  it("reads the log written before the rule as before: an item.updated of fields with no data.decided is no decision", async () => {
    const term = await terminal();
    askedDecision(term);
    checkBoard(term.ctx, { as: "claude", ack: true });
    // What the page wrote on 2026-10-05 for card #33, by hand here: no data.decided.
    fs.appendFileSync(path.join(term.dir, "events.jsonl"), `${JSON.stringify({ at: "2026-10-05T10:01:00Z", by: "robin", item: 1, kind: "item.updated", data: { fields: ["fields"] } })}\n`);
    expect(await runBoardCheck({ as: "claude" }, term.deps)).toBe(0);
    expect(term.said().split("\n")).toEqual([
      "claude: 1 new on 1 card since 2026-10-05T10:00:00Z.",
      "",
      "#1 Blank page as a hard regression  (decision · Backlog)",
      "  robin · 2026-10-05T10:01:00Z  changed its fields",
      "",
      "Run again with --ack once these are dealt with. Next check in 30 minutes."
    ]);
  });
});

// ---------------------------------------------------------------------------------------------

/** A decision card written by hand, its `fields` block as given. */
const handCard = (id: number, fields: string): string =>
  `---\nid: ${id}\ntype: decision\ntitle: "Card ${id}"\ncolumn: pinned\ntags: []\nauthor: robin\ncreated: 2026-10-05T09:00:00Z\nupdated: 2026-10-05T09:00:00Z\nfields:\n${fields}\n---\n\nWritten by hand.\n\n## Thread\n`;

describe("validate: a decision is { option, by, on }, in a card's fields and on an event", () => {
  it("accepts the decisions the board writes, a removal and the events before the rule; names a decision that is none, in the card and in the log", async () => {
    const term = await terminal();
    askedDecision(term);
    term.tick();
    updateCard(term.ctx, 1, { as: "robin", changes: { fields: { decided: DECIDED } } });
    updateCard(term.ctx, 1, { as: "robin", changes: { fields: { decided: null } } });
    updateCard(term.ctx, 1, { as: "robin", changes: { fields: { decided: "Other" } } });
    fs.appendFileSync(path.join(term.dir, "events.jsonl"), `${JSON.stringify({ at: "2026-10-05T10:02:00Z", by: "robin", item: 1, kind: "item.updated", data: { fields: ["fields"] } })}\n`);
    // Card #33 as its file is: the key `on` quoted, the day plain.
    term.write("items/0002-card-2.md", handCard(2, '  decided:\n    option: "Go with Claude\'s proposal"\n    by: robin\n    "on": 2026-10-05'));
    expect(validateBoard(term.ctx).problems).toEqual([]);
    expect(await runBoardValidate({}, term.deps)).toBe(0);
    expect(term.said()).toBe("The board is valid: 2 cards, 5 events, 0 cursors.");

    term.write("items/0003-card-3.md", handCard(3, "  decided: Go with Claude's proposal"));
    term.write("items/0004-card-4.md", handCard(4, "  decided: { option: A, by: ghost, on: 2026-10-05 }"));
    const log = path.join(term.dir, "events.jsonl");
    fs.appendFileSync(log, `${JSON.stringify({ at: "2026-10-05T10:05:00Z", by: "robin", item: 1, kind: "item.updated", data: { fields: ["fields"], decided: "Other" } })}\n`);
    fs.appendFileSync(log, `${JSON.stringify({ at: "2026-10-05T10:05:00Z", by: "robin", item: 1, kind: "item.updated", data: { fields: ["fields"], decided: { option: "Other", by: "robin" } } })}\n`);
    expect(await runBoardValidate({}, term.deps)).toBe(1);
    expect(term.said().split("\n")).toEqual([
      "The board has 4 problems (4 cards, 7 events, 0 cursors):",
      `  items/0003-card-3.md: "fields.decided" is "Go with Claude's proposal", not the decision recorded: { option, by, on }, the option chosen, who decided (a participant's id) and the day (2026-10-05)`,
      '  items/0004-card-4.md: "fields.decided" names "ghost" as who decided (by), who is not a participant of the board',
      `  events.jsonl: line 6: "data.decided" is "Other", not the decision recorded: { option, by, on }, the option chosen, who decided (a participant's id) and the day (2026-10-05)`,
      '  events.jsonl: line 7: "data.decided" does not say on which day (on: a date like 2026-10-05)'
    ]);
  });
});

// ---------------------------------------------------------------------------------------------

type Call = <T>(method: string, route: string, body?: unknown) => Promise<{ status: number; body: T }>;

async function serve(term: Terminal): Promise<Call> {
  const pageDir = path.join(term.root, "page");
  fs.mkdirSync(pageDir, { recursive: true });
  fs.writeFileSync(path.join(pageDir, "index.html"), '<!doctype html><html><body><div id="root"></div></body></html>');
  const server = createBoardServer({ dir: term.dir, root: term.root, home: "/home/tester", now: () => new Date("2026-10-05T11:00:00Z"), pageDir, watch: false, debounceMs: 20, settleMs: 60, log: () => undefined });
  const { url } = await server.listen(0);
  cleanups.push(() => server.close());
  return async <T>(method: string, route: string, body?: unknown) => {
    const response = await fetch(new URL(route, url), { method, headers: body !== undefined ? { "Content-Type": "application/json" } : {}, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    return { status: response.status, body: (text.startsWith("{") ? JSON.parse(text) : text) as T };
  };
}

describe("the page's process: the panel's decision is the event's, and the tile is told what was decided", () => {
  it("PUT fields.decided: the event carries it and says it; the tile's summary has the option chosen; a decision that is none is 422", async () => {
    const term = await terminal();
    askedDecision(term);
    const call = await serve(term);
    // What the panel's decision editor sends.
    const decided = await call<WritePayload>("PUT", "/api/items/1", { changes: { fields: { decided: { option: "Other", by: "robin", on: "2026-10-05" } } } });
    expect(decided.status).toBe(200);
    expect(decided.body.events).toMatchObject([{ kind: "item.updated", data: { fields: ["fields"], decided: { option: "Other", by: "robin", on: "2026-10-05" } }, text: "decided: Other (by robin, 2026-10-05)" }]);
    expect(decided.body.summary).toMatchObject({ decided: true, outcome: { option: "Other", by: "robin", on: "2026-10-05" } });
    const board = await call<BoardPayload>("GET", "/api/board");
    expect(board.body.cards[0]).toMatchObject({ id: 1, outcome: { option: "Other", by: "robin", on: "2026-10-05" } });
    const wrong = await call<RefusalPayload>("PUT", "/api/items/1", { changes: { fields: { decided: { option: "", by: "robin", on: "2026-10-05" } } } });
    expect(wrong).toEqual({ status: 422, body: { refused: "usage", message: "Refused: the decision has no option chosen (option: a text). Nothing was written." } });
    // "Remove the decision": null, and the tile is told no more.
    const removed = await call<WritePayload>("PUT", "/api/items/1", { changes: { fields: { decided: null } } });
    expect(removed.body.events).toMatchObject([{ data: { fields: ["fields"], decided: null }, text: "removed its decision" }]);
    expect(removed.body.summary.outcome).toBeUndefined();
    expect(removed.body.summary.decided).toBeUndefined();
  });
});
