import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBoardCheck, runBoardRelease, runBoardRenew, runBoardTake, runBoardValidate, type BoardCliDependencies } from "../cli/board.js";
import {
  agentsGuide,
  archiveCard,
  boardContext,
  BoardRefusal,
  createCards,
  dispatchView,
  eventLines,
  getCard,
  initBoard,
  moveCard,
  placesMeet,
  placesOf,
  readBoardConfig,
  readEvents,
  releaseCard,
  renewClaim,
  takeCard,
  updateCard,
  validateBoard,
  addComment,
  type BoardConfig,
  type BoardContext,
  type NewCardInput,
  type Participant,
  type DispatchView,
  type TakeResult
} from "../core/index.js";
import { createBoardServer, type BoardPayload, type RefusalPayload, type WritePayload } from "../server/index.js";

/**
 * The dispatcher: one place decides which agent gets which Ready card. An agent asks (take), the
 * board answers with one card held for it by a claim, or with none and why; the claim is a lease the
 * agent renews, gives back, or hands to For review; a claim not renewed is ended at the next take.
 * The clock is the board's own, injected here: no test sleeps.
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
  /** Moves the board's clock on by some minutes. */
  later: (minutes: number) => void;
  file: (id: number) => string;
  kinds: () => string[];
  deps: BoardCliDependencies;
  said: () => string;
}

async function board(options: { old?: boolean; dispatch?: Record<string, number> } = {}): Promise<Board> {
  const base = await mkdtemp(path.join(os.tmpdir(), "pinboard-dispatch-"));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "app");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  // A repository beside it in the workspace, for <repository>:<path> and a bare repository name.
  fs.mkdirSync(path.join(base, "api"), { recursive: true });
  const dir = path.join(root, "docs", "codelead", "board");
  let time = Date.parse("2026-11-25T10:00:00Z");
  const now = (): Date => new Date(time);
  const ctx = boardContext({ dir, root, home: path.join(base, "home"), now });
  initBoard(ctx, { name: "test-workspace", participants: PEOPLE });
  const config = readBoardConfig(dir).config;
  const next: BoardConfig = { ...config, ...(options.old ? { columns: config.columns.filter((column) => column.id !== "ready") } : {}), ...(options.dispatch ? { dispatch: options.dispatch } : {}) };
  if (options.old || options.dispatch) {
    fs.writeFileSync(path.join(dir, "board.json"), `${JSON.stringify(next, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, "AGENTS.md"), agentsGuide(next));
  }
  const lines: string[] = [];
  return {
    root,
    dir,
    ctx,
    later: (minutes) => {
      time += minutes * 60_000;
    },
    file: (id) => {
      const name = fs.readdirSync(path.join(dir, "items")).find((entry) => entry.startsWith(`${String(id).padStart(4, "0")}-`))!;
      return fs.readFileSync(path.join(dir, "items", name), "utf8");
    },
    kinds: () => readEvents(dir).events.map(({ event }) => `${event.kind}:${String(event.item)}:${event.by}`),
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

/** A card that can be worked alone, in Ready (the person's), touching `touch`. */
function ready(title: string, touch: string | string[], more: Partial<NewCardInput> = {}): NewCardInput {
  return { type: "task", title, column: "ready", ...more, fields: { definitionOfDone: "npm test passes", mayTouch: touch, limitMinutes: 30, ...(more.fields ?? {}) } };
}

function given(result: TakeResult): number {
  if (!result.given) throw new Error(`expected a card, and the board said: ${result.message}`);
  return result.card.id as number;
}

function nothing(result: TakeResult): Extract<TakeResult, { given: false }> {
  if (result.given) throw new Error(`expected no card, and the board gave #${String(result.card.id)}`);
  return result;
}

// ---------------------------------------------------------------------------------------------

describe("a take gives one card, held for the agent by a claim", () => {
  it("moves the card to In progress with its claim in the file, writes the move and the claim, and answers with what the card says", async () => {
    const b = await board();
    createCards(b.ctx, "robin", [ready("Rate-limit the sign-in form", ["src/auth/", "test/auth.test.ts"], { fields: { definitionOfDone: "Five failed sign-ins lock the form; npm test passes." } })], { tagCreator: false });
    const result = takeCard(b.ctx, { as: "claude" });
    expect(result).toMatchObject({
      given: true,
      card: {
        id: 1,
        title: "Rate-limit the sign-in form",
        type: "task",
        definitionOfDone: "Five failed sign-ins lock the form; npm test passes.",
        mayTouch: ["src/auth/", "test/auth.test.ts"],
        limitMinutes: 30,
        file: "items/0001-rate-limit-the-sign-in-form.md",
        path: "docs/codelead/board/items/0001-rate-limit-the-sign-in-form.md"
      },
      claim: { by: "claude", since: "2026-11-25T10:00:00Z", until: "2026-11-25T10:30:00Z" },
      minutes: 30,
      swept: []
    });
    const card = getCard(b.ctx, 1).card;
    expect(card.column).toBe("in-progress");
    expect(card.claim).toEqual({ by: "claude", since: "2026-11-25T10:00:00Z", until: "2026-11-25T10:30:00Z" });
    // A first-class key of the front matter, not an unknown one.
    expect(card.extra).toEqual({});
    expect(b.file(1)).toContain("\nclaim:\n  by: claude\n  since: 2026-11-25T10:00:00Z\n  until: 2026-11-25T10:30:00Z\n---\n");
    const events = readEvents(b.dir).events.map(({ event }) => event).slice(-2);
    expect(events).toEqual([
      { at: "2026-11-25T10:00:00Z", by: "claude", item: 1, kind: "item.moved", data: { from: "ready", to: "in-progress", withClaim: true } },
      { at: "2026-11-25T10:00:00Z", by: "claude", item: 1, kind: "claim.taken", data: { until: "2026-11-25T10:30:00Z", minutes: 30 } }
    ]);
    // One line wherever events are listed.
    expect(eventLines(events, readBoardConfig(b.dir).config).map((line) => line.text)).toEqual(["was given it from Ready: holds it until 2026-11-25T10:30:00Z (30 minutes)"]);
    expect(validateBoard(b.ctx).problems).toEqual([]);
  });

  it("gives the agent's own for:<agent> cards first, then the cards for any agent, each in the column's order, top first; never another agent's", async () => {
    const b = await board({ dispatch: { perAgent: 5 } });
    createCards(
      b.ctx,
      "robin",
      [
        ready("Any one", "src/one/"),
        ready("For Codex", "src/two/", { tags: ["for:codex"] }),
        ready("Any two", "src/three/"),
        ready("For Claude", "src/four/", { tags: ["for:claude"] }),
        ready("For Claude or Codex", "src/five/", { tags: ["for:codex", "for:claude"] })
      ],
      { tagCreator: false }
    );
    // The column's order: a new card takes the top, so 5 is on top, then 4, 3, 2, 1; the person drops 1 to the very top.
    moveCard(b.ctx, 1, { as: "robin", to: "ready", after: null });
    const order = [1, 2, 3, 4].map(() => given(takeCard(b.ctx, { as: "claude" })));
    expect(order).toEqual([5, 4, 1, 3]);
    // Card 2 is Codex's: claude is told so, and Codex gets it.
    expect(nothing(takeCard(b.ctx, { as: "claude" }))).toMatchObject({ reason: "for-others", message: "Nothing for claude: every card in Ready is for another agent: #2 for codex." });
    expect(given(takeCard(b.ctx, { as: "codex" }))).toBe(2);
  });

  it("answers why there is none: an empty Ready, the cards of other agents, the agent's limit, each card that waits", async () => {
    const b = await board();
    expect(nothing(takeCard(b.ctx, { as: "claude" }))).toMatchObject({ reason: "empty", message: "Nothing for claude: Ready is empty. The person puts a card there when an agent may pick it up by itself." });
    createCards(b.ctx, "robin", [ready("Mine", "src/mine/"), ready("Theirs", "src/theirs/", { tags: ["for:codex"] })], { tagCreator: false });
    expect(given(takeCard(b.ctx, { as: "claude" }))).toBe(1);
    expect(nothing(takeCard(b.ctx, { as: "claude" }))).toMatchObject({
      reason: "at-limit",
      message:
        "Nothing for claude: it holds #1 (until 2026-11-25T10:30:00Z) already, and an agent holds at most 1 card at a time on this board (dispatch.perAgent in board.json). Hand it to For review, or give it back, then ask again.",
      holds: [{ card: 1, title: "Mine", since: "2026-11-25T10:00:00Z", until: "2026-11-25T10:30:00Z", ranOut: false }]
    });
    expect(nothing(takeCard(b.ctx, { as: "codelead" }))).toMatchObject({ reason: "for-others", message: "Nothing for codelead: every card in Ready is for another agent: #2 for codex." });
  });

  it("refuses a take by a person, by no participant, and a lease longer than the board allows; the lease is the board's, or the one asked for", async () => {
    const b = await board({ dispatch: { leaseMinutes: 20, maxLeaseMinutes: 60 } });
    createCards(b.ctx, "robin", [ready("One", "src/one/"), ready("Two", "src/two/")], { tagCreator: false });
    const person = refusal(() => takeCard(b.ctx, { as: "robin" }));
    expect([person.code, person.message]).toEqual([
      "claim",
      "Refused: robin is a person; a take is how an agent asks the board for its card from Ready. Move the card yourself: you move any card anywhere. Nothing was written."
    ]);
    expect(refusal(() => takeCard(b.ctx, { as: "ghost" })).code).toBe("participant");
    const long = refusal(() => takeCard(b.ctx, { as: "claude", leaseMinutes: 90 }));
    expect([long.code, long.message]).toEqual(["claim", "Refused: a lease on this board is at most 60 minutes (dispatch.maxLeaseMinutes in board.json); 90 is more. Ask for less, and renew it while you work. Nothing was written."]);
    expect(readEvents(b.dir).events.some(({ event }) => event.kind.startsWith("claim."))).toBe(false);
    expect(takeCard(b.ctx, { as: "claude" })).toMatchObject({ claim: { until: "2026-11-25T10:20:00Z" }, minutes: 20 });
    expect(takeCard(b.ctx, { as: "codex", leaseMinutes: 45 })).toMatchObject({ claim: { until: "2026-11-25T10:45:00Z" }, minutes: 45 });
  });

  it("holds as many cards per agent as board.json's dispatch.perAgent says, and refuses a dispatch section that makes no sense", async () => {
    const b = await board({ dispatch: { perAgent: 2 } });
    createCards(b.ctx, "robin", [ready("One", "src/one/"), ready("Two", "src/two/"), ready("Three", "src/three/")], { tagCreator: false });
    expect([given(takeCard(b.ctx, { as: "claude" })), given(takeCard(b.ctx, { as: "claude" }))]).toEqual([3, 2]);
    expect(nothing(takeCard(b.ctx, { as: "claude" })).reason).toBe("at-limit");
    const config = readBoardConfig(b.dir).config;
    fs.writeFileSync(path.join(b.dir, "board.json"), JSON.stringify({ ...config, dispatch: { perAgent: 0, leaseMinutes: 30, maxLeaseMinutes: 10 } }));
    expect(refusal(() => takeCard(b.ctx, { as: "claude" })).message).toBe(
      'Refused: board.json cannot be used: "dispatch.perAgent" must be a whole number of 1 or more: how many cards an agent holds at a time; "dispatch.maxLeaseMinutes" must be at least "dispatch.leaseMinutes". Nothing was written.'
    );
  });

  it("answers a take on a board made before Ready with the words that say how to add the column", async () => {
    const b = await board({ old: true });
    createCards(b.ctx, "robin", [{ type: "task", title: "One", column: "backlog", fields: { definitionOfDone: "It works.", mayTouch: "src/", limitMinutes: 10 } }], { tagCreator: false });
    const events = readEvents(b.dir).count;
    expect(nothing(takeCard(b.ctx, { as: "claude" }))).toMatchObject({
      reason: "no-ready-column",
      message: "This board has no Ready column, so no card is given: Ready is where the person puts a card an agent may pick up by itself. `codelead board add-ready` gives the board its Ready column."
    });
    expect(readEvents(b.dir).count).toBe(events);
    expect(getCard(b.ctx, 1).card.column).toBe("backlog");
  });
});

// ---------------------------------------------------------------------------------------------

describe("what keeps a card from being given", () => {
  it("a card it is blocked by that is not in Done, stated either way; once the blocker is done, it is given", async () => {
    const b = await board({ dispatch: { perAgent: 5 } });
    createCards(
      b.ctx,
      "robin",
      [
        { ref: "store", type: "task", title: "The store", column: "backlog" },
        { type: "task", title: "The schema", column: "in-progress" },
        ready("Sessions", "src/sessions/", { relations: [{ kind: "blocked-by", ref: "store" }] }),
        ready("Cache", "src/cache/")
      ],
      { tagCreator: false }
    );
    // Card 2 states the other way round: it blocks card 4.
    updateCard(b.ctx, 2, { as: "robin", changes: { addRelations: [{ kind: "blocks", to: 4 }] } });
    const result = nothing(takeCard(b.ctx, { as: "claude" }));
    expect(result.reason).toBe("blocked");
    expect(result.message).toBe("Nothing for claude: each card in Ready it may work waits: #4 waits on #2 (in In progress), not in Done yet; #3 waits on #1 (in Backlog), not in Done yet.");
    expect(result.waiting.map((entry) => [entry.card, entry.why, entry.line, entry.cards])).toEqual([
      [4, "blocked", "waits on #2", [2]],
      [3, "blocked", "waits on #1", [1]]
    ]);
    moveCard(b.ctx, 2, { as: "robin", to: "done" });
    expect(given(takeCard(b.ctx, { as: "claude" }))).toBe(4);
    expect(nothing(takeCard(b.ctx, { as: "claude" })).reason).toBe("blocked");
    moveCard(b.ctx, 1, { as: "robin", to: "done" });
    expect(given(takeCard(b.ctx, { as: "claude" }))).toBe(3);
  });

  it("files in use: a card whose mayTouch meets a claimed card's is not given until that claim ends; cards apart from it are", async () => {
    const b = await board({ dispatch: { perAgent: 5 } });
    createCards(b.ctx, "robin", [ready("Auth", "src/auth/"), ready("Login", ["src/auth/login.ts"]), ready("Logs", "src/log.ts")], { tagCreator: false });
    moveCard(b.ctx, 1, { as: "robin", to: "ready", after: null });
    expect(given(takeCard(b.ctx, { as: "claude" }))).toBe(1);
    // Card 2 is under card 1's folder: codex gets card 3 instead, then nothing.
    expect(given(takeCard(b.ctx, { as: "codex" }))).toBe(3);
    const result = nothing(takeCard(b.ctx, { as: "codex" }));
    expect(result.message).toBe("Nothing for codex: each card in Ready it may work waits: #2 its files are in use by #1, held by claude (src/auth/login.ts meets src/auth).");
    expect(result.waiting[0]).toMatchObject({ card: 2, why: "in-use", line: "its files are in use by #1", cards: [1], until: "2026-11-25T10:30:00Z" });
    // The same agent does not run two of them together either.
    expect(nothing(takeCard(b.ctx, { as: "claude" })).reason).toBe("blocked");
    moveCard(b.ctx, 1, { as: "claude", to: "for-review", comment: "Landed: 4f2a9c1" });
    expect(given(takeCard(b.ctx, { as: "codex" }))).toBe(2);
  });

  it("compares the places as repository paths: the same path, one inside the other, a whole repository by its name, <repository>:<path>, a sentence", () => {
    const names = { repository: "app", repositories: new Set(["api", "web"]) };
    const meet = (left: string, right: string): boolean => placesOf(left, names).some((one) => placesOf(right, names).some((other) => placesMeet(one, other)));
    expect(meet("src/auth/", "src/auth")).toBe(true);
    expect(meet("./src/auth/", "src\\auth\\login.ts")).toBe(true);
    expect(meet("src/auth/../auth/login.ts", "src/Auth/LOGIN.ts")).toBe(true);
    expect(meet("src/auth/", "src/authz/")).toBe(false);
    expect(meet("src/auth/login.ts", "src/auth/logout.ts")).toBe(false);
    expect(meet("src/**/*.ts", "src/auth/login.ts")).toBe(true);
    // A bare repository name is all of that repository; this repository's name, all of this one.
    expect(meet("app", "docs/readme.md")).toBe(true);
    expect(meet("api", "api:src/server.ts")).toBe(true);
    expect(meet("api:src/", "api:src/server.ts")).toBe(true);
    expect(meet("api:src/", "src/server.ts")).toBe(false);
    expect(meet("../api/src", "api:src/server.ts")).toBe(true);
    expect(meet("api:", "web:")).toBe(false);
    // A word that names another repository may mean a folder here too: both are kept apart.
    expect(meet("api", "api/routes.ts")).toBe(true);
    // A sentence is no path: it is taken as all of this repository.
    expect(meet("the sign-in code", "src/auth/login.ts")).toBe(true);
    expect(meet("the sign-in code", "api:src/")).toBe(false);
  });

  it("skips a card in Ready that a hand edit left without what Ready asks, and names it; the next card is given", async () => {
    const b = await board();
    createCards(b.ctx, "robin", [ready("Second", "src/two/"), ready("First", "src/one/")], { tagCreator: false });
    const name = fs.readdirSync(path.join(b.dir, "items")).find((entry) => entry.startsWith("0002-"))!;
    const file = path.join(b.dir, "items", name);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("  limitMinutes: 30\n", ""));
    const view = dispatchView(b.ctx);
    expect(view.cards.map((entry) => [entry.card, entry.wait?.line])).toEqual([
      [2, "cannot be given: it does not say its limit"],
      [1, undefined]
    ]);
    expect(given(takeCard(b.ctx, { as: "claude" }))).toBe(1);
    const result = nothing(takeCard(b.ctx, { as: "codex" }));
    expect(result.message).toBe("Nothing for codex: each card in Ready it may work waits: #2 cannot be given: it names no limit in minutes or money (limitMinutes, limitMoney).");
    expect(result.waiting[0]).toMatchObject({ card: 2, why: "not-ready", missing: [{ what: "limit" }] });
  });
});

// ---------------------------------------------------------------------------------------------

describe("the claim is a lease", () => {
  it("a claim not renewed frees its card at the next take, by anyone: back to Ready, with whose claim ran out and when", async () => {
    const b = await board();
    createCards(b.ctx, "robin", [ready("One", "src/one/")], { tagCreator: false });
    expect(given(takeCard(b.ctx, { as: "claude" }))).toBe(1);
    b.later(29);
    expect(nothing(takeCard(b.ctx, { as: "codex" })).reason).toBe("empty");
    expect(getCard(b.ctx, 1).card.claim?.by).toBe("claude");
    // Past its time: validate notes it (no problem), and the read for hosts says what the next take will do.
    b.later(2);
    expect(validateBoard(b.ctx)).toMatchObject({ problems: [], notes: [{ file: "items/0001-one.md", message: "the claim of claude ran out at 2026-11-25T10:30:00Z; the next take returns the card to Ready" }] });
    expect(await runBoardValidate({}, b.deps)).toBe(0);
    expect(b.said()).toBe(
      "The board is valid: 1 card, 3 events, 0 cursors.\n  Note: items/0001-one.md: the claim of claude ran out at 2026-11-25T10:30:00Z; the next take returns the card to Ready"
    );
    expect(dispatchView(b.ctx).agents.find((agent) => agent.id === "codex")).toMatchObject({ next: { card: 1, title: "One" } });
    expect(dispatchView(b.ctx).agents.find((agent) => agent.id === "claude")).toMatchObject({ holds: [{ card: 1, ranOut: true }], next: { card: 1 } });
    // The next take (codex's) ends the claim, returns the card to Ready, and gives it to codex.
    const taken = takeCard(b.ctx, { as: "codex" });
    expect(taken).toMatchObject({ given: true, card: { id: 1 }, claim: { by: "codex", until: "2026-11-25T11:01:00Z" }, swept: [{ card: 1, title: "One", holder: "claude", until: "2026-11-25T10:30:00Z" }] });
    expect(readEvents(b.dir).events.map(({ event }) => event).filter((event) => event.kind !== "item.created")).toEqual([
      { at: "2026-11-25T10:00:00Z", by: "claude", item: 1, kind: "item.moved", data: { from: "ready", to: "in-progress", withClaim: true } },
      { at: "2026-11-25T10:00:00Z", by: "claude", item: 1, kind: "claim.taken", data: { until: "2026-11-25T10:30:00Z", minutes: 30 } },
      { at: "2026-11-25T10:31:00Z", by: "codex", item: 1, kind: "item.moved", data: { from: "in-progress", to: "ready", withClaim: true } },
      { at: "2026-11-25T10:31:00Z", by: "codex", item: 1, kind: "claim.expired", data: { holder: "claude", since: "2026-11-25T10:00:00Z", until: "2026-11-25T10:30:00Z" } },
      { at: "2026-11-25T10:31:00Z", by: "codex", item: 1, kind: "item.moved", data: { from: "ready", to: "in-progress", withClaim: true } },
      { at: "2026-11-25T10:31:00Z", by: "codex", item: 1, kind: "claim.taken", data: { until: "2026-11-25T11:01:00Z", minutes: 30 } }
    ]);
    // The agent that stopped answering is told at its next check, in one line.
    await runBoardCheck({ as: "claude" }, b.deps);
    expect(b.said()).toContain("codex · 2026-11-25T10:31:00Z  ended the claim of claude, which ran out at 2026-11-25T10:30:00Z: back to Ready");
    // Its renewal comes too late: the card is another's now.
    expect(refusal(() => renewClaim(b.ctx, 1, { as: "claude" })).message).toBe(
      "Refused: card #1 is held by codex, not by claude; only the agent that holds a card renews it or gives it back. Nothing was written."
    );
  });

  it("renew: the holder extends it from now while it works, even past its time until a take ends it; nobody else does", async () => {
    const b = await board();
    createCards(b.ctx, "robin", [ready("One", "src/one/"), ready("Two", "src/two/")], { tagCreator: false });
    expect(given(takeCard(b.ctx, { as: "claude" }))).toBe(2);
    b.later(20);
    expect(renewClaim(b.ctx, 2, { as: "claude" })).toMatchObject({ claim: { by: "claude", since: "2026-11-25T10:00:00Z", until: "2026-11-25T10:50:00Z" }, minutes: 30 });
    b.later(35);
    // Past its time, and no take came: it may still be renewed.
    expect(renewClaim(b.ctx, 2, { as: "claude", leaseMinutes: 10 }).claim.until).toBe("2026-11-25T11:05:00Z");
    expect(readEvents(b.dir).events.map(({ event }) => event).filter((event) => event.kind === "claim.renewed")).toEqual([
      { at: "2026-11-25T10:20:00Z", by: "claude", item: 2, kind: "claim.renewed", data: { until: "2026-11-25T10:50:00Z", minutes: 30 } },
      { at: "2026-11-25T10:55:00Z", by: "claude", item: 2, kind: "claim.renewed", data: { until: "2026-11-25T11:05:00Z", minutes: 10 } }
    ]);
    expect(refusal(() => renewClaim(b.ctx, 2, { as: "codex" })).message).toBe("Refused: card #2 is held by claude, not by codex; only the agent that holds a card renews it or gives it back. Nothing was written.");
    expect(refusal(() => renewClaim(b.ctx, 2, { as: "robin" })).message).toBe(
      "Refused: robin is a person; only the agent that holds a card renews its claim. Move the card yourself: a move of yours ends its claim. Nothing was written."
    );
    expect(refusal(() => renewClaim(b.ctx, 1, { as: "claude" })).message).toBe(
      "Refused: card #1 is held by no one (it is in Ready). A claim that is not renewed runs out, and the next take returns its card to Ready: ask the board for a card again with `codelead board take --as claude`. Nothing was written."
    );
    expect(refusal(() => renewClaim(b.ctx, 2, { as: "claude", leaseMinutes: 500 })).code).toBe("claim");
  });

  it("release: the holder gives the card back to Ready with its reason in the thread; only the holder", async () => {
    const b = await board();
    createCards(b.ctx, "robin", [ready("One", "src/one/")], { tagCreator: false });
    expect(given(takeCard(b.ctx, { as: "claude" }))).toBe(1);
    expect(refusal(() => releaseCard(b.ctx, 1, { as: "codex", reason: "Mine now." })).code).toBe("claim");
    expect(refusal(() => releaseCard(b.ctx, 1, { as: "robin", reason: "Back." })).code).toBe("claim");
    expect(refusal(() => releaseCard(b.ctx, 1, { as: "claude", reason: "  " })).message).toBe("Refused: a card is given back with the reason why (the person reads it in the card's thread); nothing was written.");
    b.later(5);
    const result = releaseCard(b.ctx, 1, { as: "claude", reason: "The tests need a database this machine does not have." });
    const card = getCard(b.ctx, 1).card;
    expect([card.column, card.claim]).toEqual(["ready", undefined]);
    expect(b.file(1)).not.toContain("claim:");
    expect(card.thread.map((comment) => [comment.author, comment.body])).toEqual([["claude", "The tests need a database this machine does not have."]]);
    expect(result.events.map((event) => [event.kind, event.data])).toEqual([
      ["comment.added", { excerpt: "The tests need a database this machine does not have.", withMove: true }],
      ["item.moved", { from: "in-progress", to: "ready", withComment: true, withClaim: true }],
      ["claim.released", { since: "2026-11-25T10:00:00Z", until: "2026-11-25T10:30:00Z" }]
    ]);
    expect(eventLines(result.events, readBoardConfig(b.dir).config).map((line) => line.text)).toEqual(["gave it back to Ready: The tests need a database this machine does not have."]);
    // It is in Ready again, at the top, for the next take.
    expect(given(takeCard(b.ctx, { as: "codex" }))).toBe(1);
  });

  it("finishing: the holder's move to For review ends the claim there, with no other command", async () => {
    const b = await board();
    createCards(b.ctx, "robin", [ready("One", "src/one/")], { tagCreator: false });
    expect(given(takeCard(b.ctx, { as: "claude" }))).toBe(1);
    b.later(12);
    const result = moveCard(b.ctx, 1, { as: "claude", to: "for-review", comment: "Landed: 4f2a9c1 on main." });
    expect(result.events.map((event) => event.kind)).toEqual(["comment.added", "item.moved", "item.updated", "claim.ended"]);
    expect(result.events.at(-1)).toEqual({ at: "2026-11-25T10:12:00Z", by: "claude", item: 1, kind: "claim.ended", data: { holder: "claude", until: "2026-11-25T10:30:00Z", to: "for-review" } });
    expect(eventLines(result.events, readBoardConfig(b.dir).config).map((line) => line.text)).toEqual(["commented and moved it to For review: Landed: 4f2a9c1 on main.", "recorded what landed: 4f2a9c1 on main.", "ended its claim (it moved to For review)"]);
    expect(getCard(b.ctx, 1).card.claim).toBeUndefined();
    expect(nothing(takeCard(b.ctx, { as: "claude" })).reason).toBe("empty");
  });
});

// ---------------------------------------------------------------------------------------------

describe("the rules every write keeps for Ready and for a claimed card", () => {
  it("an agent's plain move out of Ready is refused, into In progress too, in words that name the take", async () => {
    const b = await board();
    createCards(b.ctx, "robin", [ready("One", "src/one/")], { tagCreator: false });
    for (const to of ["in-progress", "backlog"]) {
      const refused = refusal(() => moveCard(b.ctx, 1, { as: "claude", to }));
      expect(refused.code).toBe("column");
      expect(refused.message).toMatch(/^Refused: claude is an agent and does not move a card out of Ready \(#1 into (In progress|Backlog)\): an agent asks the board for its card with `codelead board take --as claude`, which gives it the next card it may work, held for it in In progress\. Nothing was written\.$/);
    }
    expect(getCard(b.ctx, 1).card.column).toBe("ready");
    // The person moves it anywhere, with no claim.
    expect(moveCard(b.ctx, 1, { as: "robin", to: "in-progress" }).card.claim).toBeUndefined();
  });

  it("while a card is claimed: another agent may comment, not move it or change its three fields; the holder changes them neither; the holder moves it only to For review", async () => {
    const b = await board();
    createCards(b.ctx, "robin", [ready("One", "src/one/")], { tagCreator: false });
    expect(given(takeCard(b.ctx, { as: "claude" }))).toBe(1);
    const moved = refusal(() => moveCard(b.ctx, 1, { as: "codex", to: "for-review" }));
    expect([moved.code, moved.message]).toEqual(["claim", "Refused: card #1 is held by claude (its claim runs until 2026-11-25T10:30:00Z); codex may comment on it, not move it. Nothing was written."]);
    expect(refusal(() => moveCard(b.ctx, 1, { as: "claude", to: "backlog" })).message).toBe(
      'Refused: card #1 is held by claude (its claim runs until 2026-11-25T10:30:00Z): hand it to For review when the work is done, or give it back to Ready with `codelead board release 1 --as claude --reason "…"`; not into Backlog. Nothing was written.'
    );
    for (const as of ["codex", "claude"]) {
      const fields = refusal(() => updateCard(b.ctx, 1, { as, changes: { fields: { limitMinutes: 90 } } }));
      expect([fields.code, fields.message]).toEqual([
        "not-allowed",
        `Refused: ${as} is an agent and may not change what card #1 says it may do (limitMinutes) while claude holds it: that is the person's ask; ask in the thread. Nothing was written.`
      ]);
    }
    expect(addComment(b.ctx, 1, { as: "codex", body: "I can review it when it lands." }).events).toHaveLength(1);
    expect(updateCard(b.ctx, 1, { as: "claude", changes: { status: "halfway" } }).events).toHaveLength(1);
    // The person changes them.
    expect(updateCard(b.ctx, 1, { as: "robin", changes: { fields: { limitMinutes: 45 } } }).card.fields.limitMinutes).toBe(45);
  });

  it("the person's moves always win: a claimed card moved out of In progress, or archived, loses its claim at that move", async () => {
    const b = await board({ dispatch: { perAgent: 3 } });
    createCards(b.ctx, "robin", [ready("One", "src/one/"), ready("Two", "src/two/"), ready("Three", "src/three/")], { tagCreator: false });
    expect([1, 2, 3].map(() => given(takeCard(b.ctx, { as: "claude" })))).toEqual([3, 2, 1]);
    // Inside In progress the claim stays.
    expect(moveCard(b.ctx, 3, { as: "robin", to: "in-progress", after: null }).card.claim?.by).toBe("claude");
    const back = moveCard(b.ctx, 3, { as: "robin", to: "backlog" });
    expect(back.card.claim).toBeUndefined();
    expect(back.events.at(-1)).toMatchObject({ by: "robin", kind: "claim.ended", data: { holder: "claude", until: "2026-11-25T10:30:00Z", to: "backlog" } });
    moveCard(b.ctx, 2, { as: "robin", to: "done" });
    const archived = archiveCard(b.ctx, 1, { as: "robin" });
    expect(archived.events.map((event) => [event.kind, event.data])).toEqual([
      ["item.archived", { column: "in-progress" }],
      ["claim.ended", { holder: "claude", until: "2026-11-25T10:30:00Z", archived: true }]
    ]);
    expect(eventLines(archived.events, readBoardConfig(b.dir).config).map((line) => line.text)).toEqual(["archived it", "ended the claim of claude (archived)"]);
    expect(dispatchView(b.ctx).agents.find((agent) => agent.id === "claude")!.holds).toEqual([]);
  });

  it("an agent adds or removes no for: tag on a card in Ready or claimed; the person does; elsewhere as before", async () => {
    const b = await board();
    createCards(b.ctx, "robin", [ready("One", "src/one/", { tags: ["for:claude"] }), ready("Two", "src/two/"), { type: "task", title: "Later", column: "backlog" }], { tagCreator: false });
    const add = refusal(() => updateCard(b.ctx, 2, { as: "claude", changes: { addTags: ["for:claude"] } }));
    expect([add.code, add.message]).toEqual([
      "not-allowed",
      "Refused: claude is an agent and may not add or remove a for: tag (for:claude) on card #2 while it is in Ready: the person says which agent a card is for; ask in the thread. Nothing was written."
    ]);
    expect(refusal(() => updateCard(b.ctx, 1, { as: "codex", changes: { removeTags: ["for:claude"] } })).code).toBe("not-allowed");
    expect(given(takeCard(b.ctx, { as: "claude" }))).toBe(1);
    expect(refusal(() => updateCard(b.ctx, 1, { as: "claude", changes: { removeTags: ["For:Claude"] } })).message).toBe(
      "Refused: claude is an agent and may not add or remove a for: tag (For:Claude) on card #1 while claude holds it: the person says which agent a card is for; ask in the thread. Nothing was written."
    );
    // Other tags are the agent's as before; the person's for: tags are the person's.
    expect(updateCard(b.ctx, 2, { as: "claude", changes: { addTags: ["area:auth"] } }).events).toHaveLength(1);
    expect(updateCard(b.ctx, 2, { as: "robin", changes: { addTags: ["for:codex"] } }).card.tags).toContain("for:codex");
    // Out of Ready and unclaimed: as before (only for:codelead is the person's everywhere).
    expect(updateCard(b.ctx, 3, { as: "claude", changes: { addTags: ["for:codex"] } }).card.tags).toContain("for:codex");
    expect(refusal(() => updateCard(b.ctx, 3, { as: "claude", changes: { addTags: ["for:codelead"] } })).code).toBe("not-allowed");
  });

  it("validate: a claim on a card not in In progress, or by no agent of the board, is a problem; one that ran out, a note", async () => {
    const b = await board();
    createCards(b.ctx, "robin", [{ type: "task", title: "One", column: "backlog" }, { type: "task", title: "Two", column: "in-progress" }, { type: "task", title: "Three", column: "in-progress" }], { tagCreator: false });
    const claim = (id: number, by: string): void => {
      const name = fs.readdirSync(path.join(b.dir, "items")).find((entry) => entry.startsWith(`${String(id).padStart(4, "0")}-`))!;
      const file = path.join(b.dir, "items", name);
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("\n---\n", `\nclaim:\n  by: ${by}\n  since: 2026-11-25T09:00:00Z\n  until: 2026-11-25T09:30:00Z\n---\n`));
    };
    claim(1, "claude");
    claim(2, "ghost");
    claim(3, "robin");
    expect(validateBoard(b.ctx).problems).toEqual([
      { file: "items/0001-one.md", message: 'the card has a claim (by claude) and is not in In progress: a claim lives only there; remove the key "claim"' },
      { file: "items/0002-two.md", message: 'the claim is by "ghost", who is not a participant of the board (robin, claude, codex and codelead)' },
      { file: "items/0003-three.md", message: "the claim is by robin, a person: a claim is an agent's" }
    ]);
    expect(await runBoardValidate({}, b.deps)).toBe(1);
    b.said();
    // A claim written wrong is a problem of the file's own.
    const name = fs.readdirSync(path.join(b.dir, "items")).find((entry) => entry.startsWith("0001-"))!;
    fs.writeFileSync(path.join(b.dir, "items", name), fs.readFileSync(path.join(b.dir, "items", name), "utf8").replace("  until: 2026-11-25T09:30:00Z\n", ""));
    expect(validateBoard(b.ctx).problems[0]).toEqual({ file: "items/0001-one.md", message: '"claim" must be { by: <agent>, since: <UTC time>, until: <UTC time> }, and is {"by":"claude","since":"2026-11-25T09:00:00Z"}' });
  });
});

// ---------------------------------------------------------------------------------------------

describe("the read for hosts: what each agent holds and would be given next", () => {
  it("answers for the whole board, as the next take would decide, and writes nothing", async () => {
    const b = await board();
    createCards(
      b.ctx,
      "robin",
      [
        { ref: "store", type: "task", title: "The store", column: "backlog" },
        ready("Sessions", "src/sessions/", { relations: [{ kind: "blocked-by", ref: "store" }] }),
        ready("Auth", "src/auth/"),
        ready("Login", "src/auth/login.ts"),
        ready("For Codex", "src/codex/", { tags: ["for:codex"] })
      ],
      { tagCreator: false }
    );
    expect(given(takeCard(b.ctx, { as: "claude" }))).toBe(4);
    const before = readEvents(b.dir).count;
    const view = dispatchView(b.ctx);
    expect(readEvents(b.dir).count).toBe(before);
    expect(view.at).toBe("2026-11-25T10:00:00Z");
    expect(view.settings).toEqual({ perAgent: 1, leaseMinutes: 30, maxLeaseMinutes: 240 });
    expect(view.agents.map((agent) => [agent.id, agent.holds.map((held) => held.card), agent.next?.card ?? agent.nothing?.reason])).toEqual([
      ["claude", [4], "at-limit"],
      ["codex", [], 5],
      ["codelead", [], "blocked"]
    ]);
    expect(view.cards.map((entry) => [entry.card, entry.for, entry.wait?.line])).toEqual([
      [5, ["codex"], "for Codex"],
      [3, [], "its files are in use by #4"],
      [2, [], "waits on #1"]
    ]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("the commands: take, renew, release", () => {
  it("say what was given, why nothing was, and what the holder did, in words and in --json", async () => {
    const b = await board();
    createCards(b.ctx, "robin", [ready("Rate-limit the sign-in form", ["src/auth/", "test/auth.test.ts"], { fields: { limitMoney: 2.5 } })], { tagCreator: false });
    expect(await runBoardTake({ as: "claude" }, b.deps)).toBe(0);
    expect(b.said()).toBe(
      [
        "Took #1 (task): Rate-limit the sign-in form",
        "claude holds it until 2026-11-25T10:30:00Z (30 minutes): renew it while you work (`pinboard renew 1 --as claude`), and hand it to For review when it is done.",
        "Done when: npm test passes",
        "May touch: src/auth/, test/auth.test.ts",
        "Limit: 30 minutes, 2.5 in money",
        "docs/codelead/board/items/0001-rate-limit-the-sign-in-form.md"
      ].join("\n")
    );
    expect(await runBoardTake({ as: "codex", json: true }, b.deps)).toBe(0);
    expect(JSON.parse(b.said())).toEqual({ given: false, reason: "empty", message: "Nothing for codex: Ready is empty. The person puts a card there when an agent may pick it up by itself.", holds: [], waiting: [], swept: [] });
    expect(await runBoardTake({ as: "robin" }, b.deps)).toBe(1);
    expect(b.said()).toMatch(/^Refused: robin is a person; a take is how an agent asks the board/);
    expect(await runBoardTake({ as: "claude", lease: "soon" }, b.deps)).toBe(2);
    expect(b.said()).toBe('"soon" is not a lease: give a number of minutes above 0 (30, or 1.5).');
    b.later(10);
    expect(await runBoardRenew("1", { as: "claude" }, b.deps)).toBe(0);
    expect(b.said()).toBe("#1: claude holds it until 2026-11-25T10:40:00Z (30 minutes).");
    expect(await runBoardRelease("1", { as: "claude" }, b.deps)).toBe(2);
    expect(b.said()).toMatch(/^release needs --reason <text>/);
    expect(await runBoardRelease("1", { as: "codex", reason: "No." }, b.deps)).toBe(1);
    expect(b.said()).toBe("Refused: card #1 is held by claude, not by codex; only the agent that holds a card renews it or gives it back. Nothing was written.");
    expect(await runBoardRelease("1", { as: "claude", reason: "The form needs a design first." }, b.deps)).toBe(0);
    expect(b.said()).toBe("Gave #1 back to Ready, with the reason in its thread.");
  });
});

// ---------------------------------------------------------------------------------------------

describe("the page's process: the read for hosts, the take, the renewal and the release, and the tiles", () => {
  async function serve(b: Board): Promise<<T>(method: string, route: string, body?: unknown) => Promise<{ status: number; body: T }>> {
    const pageDir = path.join(b.root, "..", "page");
    fs.mkdirSync(pageDir, { recursive: true });
    fs.writeFileSync(path.join(pageDir, "index.html"), '<!doctype html><html><body><div id="root"></div></body></html>');
    const server = createBoardServer({ dir: b.dir, root: b.root, home: path.join(b.root, "..", "home"), now: b.ctx.now, pageDir, watch: false, log: () => undefined });
    const { url } = await server.listen(0);
    cleanups.push(() => server.close());
    return async <T>(method: string, route: string, body?: unknown) => {
      const response = await fetch(new URL(route, url), { method, headers: { "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: (await response.json()) as T };
    };
  }

  it("answers through the same core, and shows the claim and the reason a Ready card waits on each tile", async () => {
    const b = await board();
    createCards(
      b.ctx,
      "robin",
      [{ ref: "store", type: "task", title: "The store", column: "backlog" }, ready("Auth", "src/auth/"), ready("Login", "src/auth/login.ts"), ready("Sessions", "src/sessions/", { relations: [{ kind: "blocked-by", ref: "store" }] }), ready("For Codex", "src/codex/", { tags: ["for:codex"] })],
      { tagCreator: false }
    );
    moveCard(b.ctx, 2, { as: "robin", to: "ready", after: null });
    const call = await serve(b);
    const view = await call<DispatchView>("GET", "/api/dispatch");
    expect(view.status).toBe(200);
    expect(view.body.agents.map((agent) => [agent.id, agent.next?.card])).toEqual([
      ["claude", 2],
      ["codex", 5],
      ["codelead", 2]
    ]);
    const taken = await call<TakeResult>("POST", "/api/take", { as: "claude" });
    expect(taken.status).toBe(200);
    expect(taken.body).toMatchObject({ given: true, card: { id: 2 }, claim: { by: "claude", until: "2026-11-25T10:30:00Z" } });
    expect((await call<RefusalPayload>("POST", "/api/take", { as: "robin" })).body).toMatchObject({ refused: "claim" });
    expect((await call<RefusalPayload>("POST", "/api/take", {})).status).toBe(422);
    expect((await call<RefusalPayload>("POST", "/api/take", { as: "claude", lease: -1 })).body.refused).toBe("usage");

    // The tiles: the held card says who holds it and until when; each Ready card that would not be given says why.
    const tiles = new Map((await call<BoardPayload>("GET", "/api/board")).body.cards.map((card) => [card.id, card]));
    expect(tiles.get(2)).toMatchObject({ column: "in-progress", claim: { by: "claude", since: "2026-11-25T10:00:00Z", until: "2026-11-25T10:30:00Z" } });
    expect(tiles.get(2)!.wait).toBeUndefined();
    expect([3, 4, 5].map((id) => tiles.get(id)!.wait?.line)).toEqual(["its files are in use by #2", "waits on #1", "for Codex"]);
    expect(tiles.get(3)!.wait).toMatchObject({ why: "in-use", cards: [2], until: "2026-11-25T10:30:00Z" });

    b.later(10);
    const renewed = await call<WritePayload>("POST", "/api/items/2/renew", { as: "claude" });
    expect(renewed.status).toBe(200);
    expect(renewed.body.summary.claim?.until).toBe("2026-11-25T10:40:00Z");
    expect(renewed.body.card.card.claim).toEqual({ by: "claude", since: "2026-11-25T10:00:00Z", until: "2026-11-25T10:40:00Z" });
    expect((await call<RefusalPayload>("POST", "/api/items/2/renew", { as: "codex" })).body.refused).toBe("claim");
    const released = await call<WritePayload>("POST", "/api/items/2/release", { as: "claude", reason: "The form needs a design first." });
    expect(released.status).toBe(200);
    expect(released.body.summary).toMatchObject({ column: "ready" });
    expect(released.body.summary.claim).toBeUndefined();
    expect(released.body.events.map((event) => event.kind)).toEqual(["comment.added", "item.moved", "claim.released"]);
    // Its activity says each step of the claim in words.
    expect(released.body.card.activity.filter((event) => event.kind.startsWith("claim.")).map((event) => [event.byName, event.text])).toEqual([
      ["Claude Code", "gave it back to Ready"],
      ["Claude Code", "renewed its claim: holds it until 2026-11-25T10:40:00Z"],
      ["Claude Code", "was given it from Ready: holds it until 2026-11-25T10:30:00Z (30 minutes)"]
    ]);
    expect((await call<RefusalPayload>("POST", "/api/items/2/release", { as: "claude", reason: "Again." })).body.refused).toBe("claim");
  });
});
