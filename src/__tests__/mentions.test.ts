import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBoardCheck, runBoardInit, runBoardNew, runBoardReply, runBoardValidate, type BoardCliDependencies } from "../cli/board.js";
import {
  addComment,
  addressedTo,
  boardContext,
  checkBoard,
  createCard,
  createCards,
  initBoard,
  markOpened,
  mentionAt,
  mentionCandidate,
  mentionsIn,
  mentionTokens,
  moveCard,
  readEvents,
  updateCard,
  validateBoard,
  withoutCode,
  type BoardContext,
  type Participant
} from "../core/index.js";
import { createBoardServer, pageBuildReason, type CardDetail, type NotificationsPayload, type WritePayload } from "../server/index.js";

/**
 * Pinboard package 3a: an @mention in a comment (or a description) addresses a participant. The
 * rule (`mentionsIn`), the event's `data.addressed` written by every writer through the core (`to`
 * stays the column of a move and the card of a relation), the check that lists what is addressed to
 * you first, the validation of `addressed`, and the process's routes and notifications. The page's
 * list and chips are in page.browser.test.ts.
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
  fileOf: (id: number) => string;
  events: () => Array<Record<string, unknown>>;
}

async function newBoard(participants: Participant[] = PEOPLE): Promise<TestBoard> {
  const root = await temporary("pinboard-mentions-");
  fs.mkdirSync(path.join(root, ".git"));
  const dir = path.join(root, "docs", "codelead", "board");
  let time = Date.parse("2026-10-05T10:00:00Z");
  const ctx = boardContext({ dir, root, home: "/home/tester", now: () => new Date(time) });
  initBoard(ctx, { name: "test-workspace", participants });
  return {
    ctx,
    dir,
    root,
    tick: (seconds = 60) => {
      time += seconds * 1000;
    },
    read: (relative) => fs.readFileSync(path.join(dir, relative), "utf8"),
    fileOf: (id) => {
      const name = fs.readdirSync(path.join(dir, "items")).find((entry) => entry.startsWith(`${String(id).padStart(4, "0")}-`));
      if (!name) throw new Error(`no file for card ${id}`);
      return `items/${name}`;
    },
    events: () => readEvents(dir).events.map(({ event }) => event as Record<string, unknown>)
  };
}

// ---------------------------------------------------------------------------------------------

describe("mentionsIn: who a text addresses", () => {
  it("finds a participant by id or by name, in any case, a name's words joined with nothing or a hyphen; each once, in order", () => {
    for (const text of ["@Claude please create the two cards", "@claude", "@ClaudeCode", "@claude-code", "@CLAUDE-CODE", "Thanks, @claude."]) expect(mentionsIn(text, PEOPLE), text).toEqual(["claude"]);
    expect(mentionsIn("@Robin", PEOPLE)).toEqual(["robin"]);
    expect(mentionsIn("@robin, then @Claude, and @ROBIN again", PEOPLE)).toEqual(["robin", "claude"]);
    // Inside punctuation and emphasis, before a possessive or a colon: still a mention.
    for (const text of ["(@robin)", "**@robin**", "_@robin_", "@robin's call", "@robin: the TTL?", "[@robin](https://example.com)", "Ask @robin!"]) expect(mentionsIn(text, PEOPLE), text).toEqual(["robin"]);
    // A name that is not the id: only the whole name, joined, names it.
    const named: Participant[] = [{ id: "cc", kind: "agent", name: "Claude Code" }];
    expect(mentionsIn("@ClaudeCode and @claude-code", named)).toEqual(["cc"]);
    expect(mentionsIn("@Claude and @Code", named)).toEqual([]);
    expect(mentionsIn("@cc", named)).toEqual(["cc"]);
  });

  it("leaves as plain text a name of no participant, an e-mail address, a scoped package, a path, a domain and an escaped @", () => {
    for (const text of [
      "@codex, can you look?",
      "write to robin@example.com",
      "write to ops@claude, the host",
      "npm i @types/node",
      "@robin/tools is a package",
      "see docs/@robin/notes.md",
      "@robin.example.com",
      "@claude-codex",
      "\\@robin is how to write it without addressing",
      "@@robin",
      "no one at all"
    ]) {
      expect(mentionsIn(text, PEOPLE), text).toEqual([]);
    }
  });

  it("never reads code: a code span, a fenced block (backticks or tildes, indented in a list, in a quote, never closed), a decorator there", () => {
    for (const text of [
      "`@claude`",
      "Run ``@claude ` x`` here",
      "A span over two lines: `a\n@claude` in one paragraph",
      "```ts\n@Component({ selector: 'x' })\nclass A {}\n```",
      "~~~\n@claude\n~~~",
      "- an item\n\n    ```\n    @claude\n    ```",
      "> ```\n> @claude\n> ```",
      "```\n@claude, the fence is never closed"
    ]) {
      expect(mentionsIn(text, PEOPLE), text).toEqual([]);
    }
    // Text around the code still counts; a lone backtick is a backtick; a span does not run over a blank line.
    expect(mentionsIn("```\n@Component\n```\n@robin, after the fence", PEOPLE)).toEqual(["robin"]);
    expect(mentionsIn("`code` @claude", PEOPLE)).toEqual(["claude"]);
    expect(mentionsIn("one ` then @claude", PEOPLE)).toEqual(["claude"]);
    expect(mentionsIn("`a\n\n@claude`", PEOPLE)).toEqual(["claude"]);
    expect(mentionsIn("\\`@claude\\`", PEOPLE)).toEqual(["claude"]);
    expect(mentionsIn("```js @claude```", PEOPLE)).toEqual([]);
    // The blanking keeps every other character where it was.
    expect(withoutCode("a `b` c\n```\nd\n```\ne")).toBe("a     c\n   \n \n   \ne");
  });

  it("says where each mention is and how it was written, for the page's chips", () => {
    expect(mentionTokens("Hi @Robin and @claude-code.", PEOPLE).map((token) => [token.index, token.text, token.participant.id])).toEqual([
      [3, "@Robin", "robin"],
      [14, "@claude-code", "claude"]
    ]);
    expect(mentionTokens("Hi @nobody", PEOPLE)).toEqual([]);
  });

  it("knows the mention being typed, for the page's list: not in an address, not in code; the list keeps who begins with it", () => {
    expect(mentionAt("Hi @ro", 6)).toEqual({ start: 3, end: 6, query: "ro" });
    expect(mentionAt("Hi @", 4)).toEqual({ start: 3, end: 4, query: "" });
    // The caret inside the word: the word is replaced up to its end.
    expect(mentionAt("Hi @robin now", 6)).toEqual({ start: 3, end: 9, query: "ro" });
    expect(mentionAt("mail a@b", 8)).toBeUndefined();
    expect(mentionAt("Hi @ro bin", 10)).toBeUndefined();
    expect(mentionAt("Write `@cl", 10)).toBeUndefined();
    expect(mentionAt("```\n@cl", 7)).toBeUndefined();
    const claude = PEOPLE[1]!;
    expect(["", "cl", "CLA", "code", "claude-c", "claudeco"].map((query) => mentionCandidate(query, claude))).toEqual([true, true, true, true, true, true]);
    expect(mentionCandidate("ro", claude)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------

describe("the event says who it addresses: data.addressed, derived in the core, so every writer agrees", () => {
  it("a comment that mentions someone carries addressed; one that mentions no one does not; the text is kept as written", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "One" });
    board.tick();
    const written = addComment(board.ctx, 1, { as: "robin", body: "@Claude please create the two cards; `@robin` is code." });
    expect(written.events).toEqual([{ at: "2026-10-05T10:01:00Z", by: "robin", item: 1, kind: "comment.added", data: { excerpt: "@Claude please create the two cards; `@robin` is code.", addressed: ["claude"] } }]);
    expect(board.read(board.fileOf(1))).toContain("### robin · 2026-10-05T10:01:00Z\n@Claude please create the two cards; `@robin` is code.\n");
    expect(addComment(board.ctx, 1, { as: "claude", body: "Done: both cards are in Inbox." }).events[0]!.data).toEqual({ excerpt: "Done: both cards are in Inbox." });
    // A comment and a move in one step: the comment says who it addresses; the move's `to` stays its column.
    const moved = moveCard(board.ctx, 1, { as: "claude", to: "for-review", comment: "@robin, for your review." });
    expect(moved.events.map((event) => [event.kind, event.data])).toEqual([
      ["comment.added", { excerpt: "@robin, for your review.", addressed: ["robin"] }],
      ["item.moved", { from: "inbox", to: "for-review" }]
    ]);
    expect(moved.events.map(addressedTo)).toEqual([["robin"], []]);
  });

  it("a new card's description and a changed description carry addressed; a change that is not the description does not", async () => {
    const board = await newBoard();
    const created = createCard(board.ctx, "claude", { type: "decision", title: "The cache", description: "@robin: a TTL or a version key?" });
    expect(created.events[0]!.data).toEqual({ title: "The cache", type: "decision", column: "inbox", addressed: ["robin"] });
    expect(createCards(board.ctx, "robin", [{ type: "note", title: "Plain", description: "Nobody named." }])[0]!.events[0]!.data).toEqual({ title: "Plain", type: "note", column: "inbox" });
    board.tick();
    const changed = updateCard(board.ctx, 1, { as: "robin", changes: { title: "The cache, again", description: "@claude, write the ask; @Robin decides." } });
    expect(changed.events[0]!.data).toEqual({ fields: ["title", "description"], addressed: ["claude", "robin"] });
    expect(updateCard(board.ctx, 1, { as: "robin", changes: { status: "@claude is on it" } }).events[0]!.data).toEqual({ fields: ["status"] });
    expect(updateCard(board.ctx, 2, { as: "robin", changes: { description: "Still nobody." } }).events[0]!.data).toEqual({ fields: ["description"] });
    // A relation keeps its own `to`, the card it names.
    expect(updateCard(board.ctx, 1, { as: "robin", changes: { addRelations: [{ kind: "related", to: 2 }] } }).events[0]!.data).toEqual({ kind: "related", to: 2 });
  });

  it("reply and new on the command line write it the same way (--json shows the events)", async () => {
    const term = await terminal();
    expect(await runBoardNew({ as: "claude", type: "question", title: "Which TTL?", body: "@Robin: one minute or five?", json: true }, term.deps)).toBe(0);
    expect(JSON.parse(term.said()).events[0].data).toEqual({ title: "Which TTL?", type: "question", column: "inbox", addressed: ["robin"] });
    expect(await runBoardReply("1", { as: "robin", text: "One. @claude-code, write it down.", json: true }, term.deps)).toBe(0);
    expect(JSON.parse(term.said()).events[0].data).toEqual({ excerpt: "One. @claude-code, write it down.", addressed: ["claude"] });
    expect(fs.readFileSync(path.join(term.dir, "items", "0001-which-ttl.md"), "utf8")).toContain("\n@Robin: one minute or five?\n");
  });

  it("reads only data.addressed, the same on every kind of event: no addressed, a to, or an addressed that is no list address no one", () => {
    const at = "2026-10-05T10:00:00Z";
    expect(addressedTo({ at, by: "robin", item: 1, kind: "comment.added", data: { excerpt: "@claude, from before the rule." } })).toEqual([]);
    expect(addressedTo({ at, by: "robin", item: 1, kind: "comment.added", data: { excerpt: "@claude", to: ["claude"] } })).toEqual([]);
    expect(addressedTo({ at, by: "robin", item: 1, kind: "item.moved", data: { from: "inbox", to: "done" } })).toEqual([]);
    expect(addressedTo({ at, by: "robin", item: 1, kind: "relation.added", data: { kind: "related", to: 2 } })).toEqual([]);
    expect(addressedTo({ at, by: "robin", item: 1, kind: "comment.added", data: { excerpt: "x", addressed: "claude" } })).toEqual([]);
    expect(addressedTo({ at, by: "robin", item: 1, kind: "item.updated", data: { fields: ["description"], addressed: ["claude", 7] } })).toEqual(["claude"]);
    expect(addressedTo({ at, by: "claude", item: 1, kind: "item.moved", data: { from: "inbox", to: "for-review", addressed: ["robin"] } })).toEqual(["robin"]);
  });
});

// ---------------------------------------------------------------------------------------------

interface Terminal {
  root: string;
  dir: string;
  deps: BoardCliDependencies;
  ctx: BoardContext;
  tick: (seconds?: number) => void;
  said: () => string;
}

async function terminal(): Promise<Terminal> {
  const root = await temporary("pinboard-mentions-cli-");
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
    said: () => lines.splice(0).join("\n")
  };
  expect(await runBoardInit({ name: "test-workspace", person: ["robin:Robin"], agent: ["claude:Claude Code"] }, term.deps)).toBe(0);
  term.said();
  return term;
}

describe("codelead board check: what is addressed to you comes first", () => {
  it("prints the cards that mention you first, each with its mention first, counts them apart, and --json carries addressed", async () => {
    const term = await terminal();
    createCards(term.ctx, "robin", [
      { type: "task", title: "One" },
      { type: "task", title: "Two" }
    ]);
    expect(await runBoardCheck({ as: "claude", ack: true }, term.deps)).toBe(0);
    term.said();
    term.tick();
    updateCard(term.ctx, 1, { as: "robin", changes: { addTags: ["w5"] } });
    term.tick();
    addComment(term.ctx, 2, { as: "robin", body: "Which TTL?" });
    term.tick();
    addComment(term.ctx, 1, { as: "robin", body: "@Claude please create the two cards." });
    expect(await runBoardCheck({ as: "claude" }, term.deps)).toBe(0);
    expect(term.said().split("\n")).toEqual([
      "claude: 3 new on 2 cards since 2026-10-05T10:00:00Z, 1 addressed to you.",
      "",
      "Addressed to you (1)",
      "",
      "#1 One  (task · Inbox)",
      "  robin · 2026-10-05T10:03:00Z  commented: @Claude please create the two cards.",
      "  robin · 2026-10-05T10:01:00Z  tagged it w5",
      "",
      "Also new",
      "",
      "#2 Two  (task · Inbox)",
      "  robin · 2026-10-05T10:02:00Z  commented: Which TTL?",
      "",
      "Run again with --ack once these are dealt with. Next check in 30 minutes."
    ]);
    expect(await runBoardCheck({ as: "claude", json: true }, term.deps)).toBe(0);
    const json = JSON.parse(term.said()) as { notifications: unknown[]; addressed: unknown[]; groups: unknown[] };
    expect(json.notifications).toHaveLength(3);
    expect(json.addressed).toEqual([{ at: "2026-10-05T10:03:00Z", by: "robin", item: 1, kind: "comment.added", data: { excerpt: "@Claude please create the two cards.", addressed: ["claude"] } }]);
    // The JSON keeps its shape: the groups are as they were, newest card first.
    expect(json.groups.map((group) => (group as { item: number }).item)).toEqual([1, 2]);
    // Robin is not told about his own mention; once Claude acknowledged, nothing is new.
    expect(checkBoard(term.ctx, { as: "robin" }).addressed).toEqual([]);
    expect(await runBoardCheck({ as: "claude", ack: true }, term.deps)).toBe(0);
    term.said();
    expect(await runBoardCheck({ as: "claude" }, term.deps)).toBe(0);
    expect(term.said()).toBe("claude: nothing new since 2026-10-05T10:03:00Z. Next check in 30 minutes.");
  });

  it("keeps a comment and a move of one step on one line when it addresses you; a card you opened since is not listed; no mention, the check reads as before", async () => {
    const term = await terminal();
    createCards(term.ctx, "claude", [
      { type: "task", title: "One" },
      { type: "task", title: "Two" }
    ]);
    checkBoard(term.ctx, { as: "robin", ack: true });
    term.tick();
    moveCard(term.ctx, 1, { as: "claude", to: "for-review", comment: "Landed; @robin, your look." });
    addComment(term.ctx, 2, { as: "claude", body: "@robin, one more question here." });
    expect(await runBoardCheck({ as: "robin" }, term.deps)).toBe(0);
    expect(term.said().split("\n")).toEqual([
      "robin: 3 new on 2 cards since 2026-10-05T10:00:00Z, 2 addressed to you.",
      "",
      "Addressed to you (2)",
      "",
      "#2 Two  (task · Inbox)",
      "  claude · 2026-10-05T10:01:00Z  commented: @robin, one more question here.",
      "",
      "#1 One  (task · For review)",
      "  claude · 2026-10-05T10:01:00Z  commented and moved it to For review: Landed; @robin, your look.",
      "",
      "Run again with --ack once these are dealt with. Next check in 30 minutes."
    ]);
    // Opening a card sees its events: what is left is one card, still addressed.
    term.tick();
    markOpened(term.ctx, "robin", 2);
    expect(checkBoard(term.ctx, { as: "robin" }).addressed.map((event) => event.item)).toEqual([1]);
    // Nobody mentioned: the same lines as before the rule.
    checkBoard(term.ctx, { as: "robin", ack: true });
    term.tick();
    addComment(term.ctx, 1, { as: "claude", body: "And the evidence record." });
    expect(await runBoardCheck({ as: "robin" }, term.deps)).toBe(0);
    expect(term.said().split("\n")).toEqual([
      "robin: 1 new on 1 card since 2026-10-05T10:02:00Z.",
      "",
      "#1 One  (task · For review)",
      "  claude · 2026-10-05T10:03:00Z  commented: And the evidence record.",
      "",
      "Run again with --ack once these are dealt with. Next check in 30 minutes."
    ]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("validation: a log with and without addressed", () => {
  it("accepts the events written before the rule and after it, and names an addressed that is no list of participants", async () => {
    const term = await terminal();
    const log = path.join(term.dir, "events.jsonl");
    createCard(term.ctx, "robin", { type: "task", title: "One" });
    // An event written before the rule (no addressed), as an agent wrote it by hand.
    fs.appendFileSync(log, `${JSON.stringify({ at: "2026-10-05T10:00:30Z", by: "claude", item: 1, kind: "comment.added", data: { excerpt: "@robin, before the rule." } })}\n`);
    fs.appendFileSync(path.join(term.dir, "items", "0001-one.md"), "\n### claude · 2026-10-05T10:00:30Z\n@robin, before the rule.\n");
    term.tick();
    addComment(term.ctx, 1, { as: "robin", body: "@claude, after it." });
    moveCard(term.ctx, 1, { as: "claude", to: "for-review" });
    const data = readEvents(term.dir).events.map(({ event }) => (event.data ?? {}) as { addressed?: unknown; to?: unknown });
    expect(data.map((entry) => entry.addressed)).toEqual([undefined, undefined, ["claude"], undefined]);
    // `to` is the move's column, as it was.
    expect(data.map((entry) => entry.to)).toEqual([undefined, undefined, undefined, "for-review"]);
    expect(validateBoard(term.ctx).problems).toEqual([]);
    expect(await runBoardValidate({}, term.deps)).toBe(0);
    expect(term.said()).toBe("The board is valid: 1 card, 4 events, 0 cursors.");

    fs.appendFileSync(log, `${JSON.stringify({ at: "2026-10-05T10:05:00Z", by: "claude", item: 1, kind: "comment.added", data: { excerpt: "x", addressed: "robin" } })}\n`);
    fs.appendFileSync(log, `${JSON.stringify({ at: "2026-10-05T10:05:00Z", by: "claude", item: 1, kind: "item.updated", data: { fields: ["description"], addressed: ["robin", "ghost"] } })}\n`);
    expect(await runBoardValidate({}, term.deps)).toBe(1);
    expect(term.said().split("\n")).toEqual([
      "The board has 2 problems (1 card, 6 events, 0 cursors):",
      '  events.jsonl: line 5: "data.addressed" must list the ids of the participants the text addresses, and is "robin"',
      '  events.jsonl: line 6: "data.addressed" names "ghost", who is not a participant of the board'
    ]);
  });
});

// ---------------------------------------------------------------------------------------------

interface Running {
  call: <T>(method: string, route: string, body?: unknown) => Promise<{ status: number; body: T }>;
}

async function serve(board: TestBoard): Promise<Running> {
  const pageDir = path.join(board.root, "page");
  fs.mkdirSync(pageDir, { recursive: true });
  fs.writeFileSync(path.join(pageDir, "index.html"), '<!doctype html><html><body><div id="root"></div></body></html>');
  const server = createBoardServer({ dir: board.dir, root: board.root, home: "/home/tester", now: () => new Date("2026-10-05T11:00:00Z"), pageDir, watch: false, debounceMs: 20, settleMs: 60, log: () => undefined });
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

describe("the page's process: its writes say who they address, its notifications say what is addressed to the person", () => {
  it("POST a comment, PUT a description, POST a card: each event carries who its text addresses", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "One" });
    const { call } = await serve(board);
    const commented = await call<WritePayload>("POST", "/api/items/1/comments", { body: "@claude can you take this? `@robin` stays code." });
    expect(commented.status).toBe(200);
    expect(commented.body.events).toMatchObject([{ kind: "comment.added", data: { addressed: ["claude"] }, text: "commented: @claude can you take this? `@robin` stays code." }]);
    const described = await call<WritePayload>("PUT", "/api/items/1", { changes: { description: "Ask @Claude-Code first." } });
    expect(described.body.events).toMatchObject([{ kind: "item.updated", data: { fields: ["description"], addressed: ["claude"] } }]);
    const created = await call<WritePayload>("POST", "/api/items", { type: "question", title: "Which TTL?", description: "@claude: one minute?" });
    expect(created.body.events).toMatchObject([{ kind: "item.created", data: { addressed: ["claude"] } }]);
    const moved = await call<WritePayload>("POST", "/api/items/1/move", { to: "backlog", comment: "Moved; @claude, it waits for you there." });
    expect(moved.body.events.map((event) => [event.kind, event.data])).toEqual([
      ["comment.added", { excerpt: "Moved; @claude, it waits for you there.", addressed: ["claude"] }],
      ["item.moved", { from: "inbox", to: "backlog" }]
    ]);
  });

  it("GET /api/notifications counts what is addressed to the person, per card; opening the card clears it", async () => {
    const board = await newBoard();
    createCards(board.ctx, "robin", [
      { type: "task", title: "One" },
      { type: "task", title: "Two" }
    ]);
    checkBoard(board.ctx, { as: "robin", ack: true });
    board.tick();
    addComment(board.ctx, 1, { as: "claude", body: "@robin, which TTL?" });
    addComment(board.ctx, 1, { as: "claude", body: "And @Robin: the key's name?" });
    addComment(board.ctx, 2, { as: "claude", body: "Started." });
    const { call } = await serve(board);
    const first = await call<NotificationsPayload>("GET", "/api/notifications");
    expect(first.body).toMatchObject({ count: 3, addressed: 2, unseenByCard: { "1": 2, "2": 1 }, addressedByCard: { "1": 2 } });
    await call<CardDetail>("GET", "/api/items/1?open=1");
    const opened = await call<NotificationsPayload>("GET", "/api/notifications");
    expect(opened.body).toMatchObject({ count: 1, addressed: 0, addressedByCard: {} });
  });
});

describe("the page's build follows the rule it shares with the core", () => {
  it("is built again when the core's mentions module is newer than the build", async () => {
    const base = await temporary("pinboard-mentions-page-");
    const source = path.join(base, "page");
    const dist = path.join(source, "dist");
    fs.mkdirSync(path.join(source, "src"), { recursive: true });
    fs.mkdirSync(dist, { recursive: true });
    fs.mkdirSync(path.join(base, "core"), { recursive: true });
    fs.writeFileSync(path.join(source, "src", "main.tsx"), "export {};\n");
    fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html>\n");
    fs.writeFileSync(path.join(base, "core", "mentions.ts"), "export {};\n");
    const at = (file: string, seconds: number): void => fs.utimesSync(file, new Date(seconds * 1000), new Date(seconds * 1000));
    at(path.join(source, "src", "main.tsx"), 1_000);
    at(path.join(base, "core", "mentions.ts"), 1_000);
    at(path.join(dist, "index.html"), 2_000);
    expect(pageBuildReason({ source, dist })).toBeUndefined();
    at(path.join(base, "core", "mentions.ts"), 3_000);
    expect(pageBuildReason({ source, dist })).toBe("the page's sources changed since it was built");
  });
});
