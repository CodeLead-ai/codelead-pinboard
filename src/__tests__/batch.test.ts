import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBoardCommand, runBoardNew, type BoardCliDependencies } from "../cli/board.js";
import {
  boardContext,
  BoardRefusal,
  createBatch,
  createCard,
  getCard,
  initBoard,
  listCards,
  parseBatch,
  readEvents,
  relationsOf,
  validateBoard,
  type BoardContext,
  type Participant
} from "../core/index.js";

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
  root: string;
  read: (relative: string) => string;
  /** Every file of the board with its text (folders as their sorted listing): what a write would change. */
  snapshot: () => Record<string, string>;
}

async function newBoard(): Promise<TestBoard> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pinboard-batch-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".git"));
  const dir = path.join(root, "docs", "codelead", "board");
  const ctx = boardContext({ dir, root, home: "/home/tester", now: () => new Date("2026-10-06T10:00:00Z") });
  initBoard(ctx, { name: "test-workspace", participants: PEOPLE });
  const snapshot = (): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (relative: string): void => {
      const full = path.join(dir, relative);
      if (fs.statSync(full).isDirectory()) {
        const names = fs.readdirSync(full).sort();
        out[`${relative}/`] = names.join(",");
        for (const name of names) walk(path.join(relative, name));
      } else out[relative] = fs.readFileSync(full, "utf8");
    };
    for (const name of fs.readdirSync(dir).sort()) walk(name);
    return out;
  };
  return { ctx, dir, root, read: (relative) => fs.readFileSync(path.join(dir, relative), "utf8"), snapshot };
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

/** Three cards from one conversation: two relate to each other by key, two to card #1, which is on the board already. */
const THREE = [
  "# Cards from the conversation of 2026-10-06",
  "",
  "## The batch command",
  "",
  "```yaml",
  "key: batch",
  "type: task",
  "column: backlog",
  "tags: [area:board]",
  "fields:",
  '  definitionOfDone: "new --batch creates every card of a file, or none"',
  "relations:",
  '  - { kind: related, to: "@skill" }',
  "  - { kind: related, to: 1 }",
  "```",
  "",
  "What: the cards of a conversation in one go. Why: one dry run to show, one write.",
  "Where it came from: the conversation of 2026-10-06.",
  "",
  "### Notes",
  "",
  "```markdown",
  "## Not a card: a heading in a code block",
  "```",
  "",
  "## The skill's procedure",
  "",
  "```yaml",
  "key: skill",
  "type: task",
  'relations: [{ kind: child-of, to: "@batch" }]',
  "```",
  "",
  "The skill says how a session turns a conversation into cards.",
  "",
  "## Which column does a card from a conversation take?",
  "",
  "```yaml",
  "type: question",
  'relations: [{ kind: related, to: "#1" }]',
  "```",
  "",
  "Inbox or Backlog; the person moves them on.",
  ""
].join("\n");

/** The line a text's heading is on, from 1. */
const lineOf = (text: string, heading: string): number => text.split("\n").indexOf(heading) + 1;

describe("a batch: several cards from one file, all or none", () => {
  it("creates three cards in the file's order, relates them by key and to a card already on the board, with one event per card and per relation", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "Pinboard package 3" });
    const result = createBatch(board.ctx, "claude", THREE, { source: "cards.md", defaults: { tags: ["source:conversation"] } });
    expect(result.dryRun).toBe(false);
    expect(result.cards.map((card) => [card.id, card.type, card.column, card.title, card.tags, card.relations])).toEqual([
      [2, "task", "backlog", "The batch command", ["area:board", "source:conversation", "by:claude"], [{ kind: "related", to: 3 }, { kind: "related", to: 1 }]],
      [3, "task", "inbox", "The skill's procedure", ["source:conversation", "by:claude"], [{ kind: "child-of", to: 2 }]],
      [4, "question", "inbox", "Which column does a card from a conversation take?", ["source:conversation", "by:claude"], [{ kind: "related", to: 1 }]]
    ]);
    // The description is everything under the block, a heading inside a code block included.
    expect(getCard(board.ctx, 2).card).toMatchObject({
      fields: { definitionOfDone: "new --batch creates every card of a file, or none" },
      description: [
        "What: the cards of a conversation in one go. Why: one dry run to show, one write.",
        "Where it came from: the conversation of 2026-10-06.",
        "",
        "### Notes",
        "",
        "```markdown",
        "## Not a card: a heading in a code block",
        "```"
      ].join("\n")
    });
    // Every item.created first, then the relations: a relation never names a card before it exists.
    const at = "2026-10-06T10:00:00Z";
    const written = readEvents(board.dir).events.slice(1).map(({ event }) => event);
    expect(written).toEqual([
      { at, by: "claude", item: 2, kind: "item.created", data: { title: "The batch command", type: "task", column: "backlog" } },
      { at, by: "claude", item: 3, kind: "item.created", data: { title: "The skill's procedure", type: "task", column: "inbox" } },
      { at, by: "claude", item: 4, kind: "item.created", data: { title: "Which column does a card from a conversation take?", type: "question", column: "inbox" } },
      { at, by: "claude", item: 2, kind: "relation.added", data: { kind: "related", to: 3 } },
      { at, by: "claude", item: 2, kind: "relation.added", data: { kind: "related", to: 1 } },
      { at, by: "claude", item: 3, kind: "relation.added", data: { kind: "child-of", to: 2 } },
      { at, by: "claude", item: 4, kind: "relation.added", data: { kind: "related", to: 1 } }
    ]);
    expect(result.events).toEqual(written);
    expect(JSON.parse(board.read("board.json")).nextId).toBe(5);
    expect(relationsOf(listCards(board.ctx).cards, 1)).toEqual([
      { kind: "related", to: 2, statedBy: 2 },
      { kind: "related", to: 4, statedBy: 4 }
    ]);
    expect(validateBoard(board.ctx).problems).toEqual([]);
    // A file written with CRLF line endings reads the same.
    expect(parseBatch(THREE.replace(/\n/g, "\r\n"), { source: "cards.md" })).toEqual(parseBatch(THREE, { source: "cards.md" }));
  });

  it("refuses the whole batch for one bad card, naming its heading, its line and the reason, and writes nothing", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "Pinboard package 3" });
    const before = board.snapshot();
    const third = "## Which column does a card from a conversation take?";
    const said = refusal(() => createBatch(board.ctx, "claude", THREE.replace("type: question", "type: bug"), { source: "cards.md" }));
    expect(said.code).toBe("type");
    expect(said.message).toBe(
      `Refused: the card "${third}" (line ${lineOf(THREE, third)} of cards.md): "bug" is not a card type of the board (question, decision, task, idea, review, note). Nothing was written.`
    );
    // A relation to a card that is not on the board, from the first card: the same, nothing written.
    const missing = refusal(() => createBatch(board.ctx, "claude", THREE.replace("  - { kind: related, to: 1 }", "  - { kind: related, to: 99 }"), { source: "cards.md" }));
    expect(missing.message).toBe(`Refused: the card "## The batch command" (line 3 of cards.md): a relation names card #99, which is not on the board. Nothing was written.`);
    expect(board.snapshot()).toEqual(before);
  });

  it("writes not even the good card that comes before the bad one", async () => {
    const board = await newBoard();
    const before = board.snapshot();
    const said = refusal(() => createBatch(board.ctx, "claude", "## Fine\n\n```yaml\ntype: task\n```\n\n## Not fine\n\n```yaml\ntype: task\ncolumn: someday\n```\n", { source: "cards.md" }));
    expect(board.snapshot()).toEqual(before);
    expect(said.message).toBe(
      'Refused: the card "## Not fine" (line 7 of cards.md): "someday" is not a column of the board (inbox, backlog, ideas, pinned, in-progress, for-review, done). Nothing was written.'
    );
  });

  it("refuses a file it cannot read as cards, each time with the card and the reason", async () => {
    const board = await newBoard();
    const card = (block: string, title = "A"): string => `## ${title}\n\n\`\`\`yaml\n${block}\n\`\`\`\n\nThe description.\n`;
    const cases: Array<[string, string]> = [
      ["Just a note, no card.\n", 'cards.md holds no card: each card begins with a heading "## <title>", then its block "```yaml" and its description.'],
      [`Some words first.\n\n${card("type: task")}`, 'line 1 of cards.md comes before the first card; each card begins with a heading "## <title>" (only a title "# …" may come first).'],
      ["## A\n\nNo block here.\n", 'the card "## A" (line 1 of cards.md): its block is missing: the first line under the heading opens it, "```yaml", and it gives the card\'s type (and its key, column, tags, fields, relations).'],
      ["## A\n\n```yaml\ntype: task\n\n## B\n", 'the card "## A" (line 1 of cards.md): its block, opened on line 3, is never closed (a line "```").'],
      [card("type: task\ncolumn: W5: later"), 'the card "## A" (line 1 of cards.md): its block does not read: line 5: a plain value holds ": " (write it in double quotes): W5: later.'],
      [card("type: task\ncolum: backlog"), 'the card "## A" (line 1 of cards.md): "colum" is not a key of a card\'s block (key, type, column, tags, fields, relations, session).'],
      [card("type: task\ntitle: Another"), 'the card "## A" (line 1 of cards.md): the title is the heading ("## <title>"), not a key of the block.'],
      [card("column: backlog"), 'the card "## A" (line 1 of cards.md): its block has no "type" (the card\'s type, one of the board\'s types).'],
      [card("type: task\nfields: { hypothesis: faster }"), 'the card "## A" (line 1 of cards.md): "hypothesis" is not a field of a task (definitionOfDone, size, landed).'],
      [card("type: task\ntags: area:board"), 'the card "## A" (line 1 of cards.md): its "tags" must be a list, like [area:board, source:conversation].'],
      [card("type: task\nkey: a\nrelations: [{ kind: related, to: \"@nobody\" }]"), 'the card "## A" (line 1 of cards.md): relation 1 names "@nobody", which is no card of this batch (its keys: a).'],
      [card("type: task\nrelations: [{ kind: related, to: [1] }]"), 'the card "## A" (line 1 of cards.md): relation 1 must be { kind: <kind>, to: <card id, or "@key" of a card of this batch> }, and is {"kind":"related","to":[1]}.'],
      [`${card("type: task\nkey: a")}\n${card("type: task\nkey: a", "B")}`, 'the card "## B" (line 10 of cards.md): its key "a" is also the key of the card "## A" (line 1 of cards.md).']
    ];
    for (const [text, why] of cases) {
      const said = refusal(() => createBatch(board.ctx, "claude", text, { source: "cards.md" }));
      expect(said.message, text).toBe(`Refused: ${why} Nothing was written.`);
    }
    expect(fs.readdirSync(path.join(board.dir, "items"))).toEqual([]);
    expect(board.read("events.jsonl")).toBe("");
  });

  it("reads a number as a card already on the board, never as one the batch is about to number; a card of the batch is named by its key", async () => {
    const board = await newBoard();
    // The batch would number its cards 1 and 2: "to: 2" names a card #2 on the board, and there is none.
    const byNumber = "## First\n\n```yaml\ntype: task\nrelations: [{ kind: related, to: 2 }]\n```\n\n## Second\n\n```yaml\ntype: task\n```\n";
    expect(refusal(() => createBatch(board.ctx, "claude", byNumber, { source: "cards.md" })).message).toBe(
      'Refused: the card "## First" (line 1 of cards.md): a relation names card #2, which is not on the board. Nothing was written.'
    );
    expect(fs.readdirSync(path.join(board.dir, "items"))).toEqual([]);
    const byKey = '## First\n\n```yaml\ntype: task\nrelations: [{ kind: related, to: "@second" }]\n```\n\n## Second\n\n```yaml\nkey: second\ntype: task\n```\n';
    expect(createBatch(board.ctx, "claude", byKey, { source: "cards.md" }).cards.map((card) => card.relations)).toEqual([[{ kind: "related", to: 2 }], []]);
  });

  it("with dryRun: the cards and the events as they would be, with their ids, and not a byte written", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "Pinboard package 3" });
    const before = board.snapshot();
    const result = createBatch(board.ctx, "claude", THREE, { source: "cards.md", dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.cards.map((card) => [card.id, card.file])).toEqual([
      [2, "items/0002-the-batch-command.md"],
      [3, "items/0003-the-skill-s-procedure.md"],
      [4, "items/0004-which-column-does-a-card-from-a.md"]
    ]);
    expect(result.events.map((event) => [event.item, event.kind])).toEqual([
      [2, "item.created"],
      [3, "item.created"],
      [4, "item.created"],
      [2, "relation.added"],
      [2, "relation.added"],
      [3, "relation.added"],
      [4, "relation.added"]
    ]);
    expect(board.snapshot()).toEqual(before);
    // The same batch written for real gets the ids the dry run said.
    expect(createBatch(board.ctx, "claude", THREE, { source: "cards.md" }).cards.map((card) => card.id)).toEqual([2, 3, 4]);
  });

  it("lets an agent create only in its own columns, as new does; a person anywhere", async () => {
    const board = await newBoard();
    const pinned = THREE.replace("column: backlog", "column: pinned");
    expect(refusal(() => createBatch(board.ctx, "claude", pinned.replace("to: 1 }", 'to: "@skill" }'), { source: "cards.md" })).message).toBe(
      'Refused: the card "## The batch command" (line 3 of cards.md): claude is an agent and may not create a card in Pinned (a person\'s column); an agent may create a card in Inbox, Backlog, Ideas, In progress, For review. Nothing was written.'
    );
    expect(refusal(() => createBatch(board.ctx, "claude", "## Done already\n\n```yaml\ntype: note\ncolumn: Done\n```\n", { source: "cards.md" })).message).toBe(
      'Refused: the card "## Done already" (line 1 of cards.md): claude is an agent and may not create a card in Done (a person\'s column); an agent may create a card in Inbox, Backlog, Ideas, In progress, For review. Nothing was written.'
    );
    // The decision is the person's, in a batch as anywhere.
    expect(refusal(() => createBatch(board.ctx, "claude", '## Pick\n\n```yaml\ntype: decision\nfields: { decided: { option: "a TTL" } }\n```\n', { source: "cards.md" })).message).toBe(
      'Refused: the card "## Pick" (line 1 of cards.md): claude is an agent; the decision is the person\'s: an agent writes its recommendation in fields.ask. Nothing was written.'
    );
    expect(fs.readdirSync(path.join(board.dir, "items"))).toEqual([]);
    createCard(board.ctx, "robin", { type: "task", title: "Pinboard package 3" });
    expect(createBatch(board.ctx, "robin", pinned, { source: "cards.md" }).cards.map((card) => card.column)).toEqual(["pinned", "inbox", "inbox"]);
  });

  it("gives the command's column, tags and session to every card that does not give its own", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "Pinboard package 3" });
    const result = createBatch(board.ctx, "claude", THREE.replace("type: question", "type: question\nsession: other-session"), {
      source: "cards.md",
      defaults: { column: "backlog", tags: ["source:conversation", "area:board"], session: "this-session" }
    });
    expect(result.cards.map((card) => [card.column, card.tags, card.session])).toEqual([
      ["backlog", ["area:board", "source:conversation", "by:claude"], "this-session"],
      ["backlog", ["source:conversation", "area:board", "by:claude"], "this-session"],
      ["backlog", ["source:conversation", "area:board", "by:claude"], "other-session"]
    ]);
  });
});

// ---------------------------------------------------------------------------------------------

interface Terminal {
  board: TestBoard;
  deps: BoardCliDependencies;
  said: () => string;
}

async function terminal(): Promise<Terminal> {
  const board = await newBoard();
  fs.mkdirSync(path.join(board.root, "src", "deep"), { recursive: true });
  fs.writeFileSync(path.join(board.root, "cards.md"), THREE);
  const lines: string[] = [];
  return {
    board,
    deps: { cwd: () => path.join(board.root, "src", "deep"), output: (line) => lines.push(line), now: () => new Date("2026-10-06T10:00:00Z"), home: "/home/tester" },
    said: () => lines.splice(0).join("\n")
  };
}

describe("codelead board new --batch", () => {
  it("prints the cards with the ids they would get on --dry-run, then creates them; --json gives the cards and the events", async () => {
    const term = await terminal();
    expect(await runBoardNew({ as: "robin", type: "task", title: "Pinboard package 3" }, term.deps)).toBe(0);
    term.said();
    const before = term.board.snapshot();
    const listed = [
      "  #2 (task) in Backlog: The batch command  [area:board, source:conversation, by:claude]",
      "      related #3, related #1",
      "  #3 (task) in Inbox: The skill's procedure  [source:conversation, by:claude]",
      "      child-of #2",
      "  #4 (question) in Inbox: Which column does a card from a conversation take?  [source:conversation, by:claude]",
      "      related #1"
    ];
    expect(await runBoardNew({ as: "claude", batch: "../../cards.md", tag: ["source:conversation"], dryRun: true }, term.deps)).toBe(0);
    expect(term.said()).toBe(["Would create 3 cards from ../../cards.md; nothing was written:", ...listed, "Run it again without --dry-run to create them."].join("\n"));
    expect(term.board.snapshot()).toEqual(before);
    expect(await runBoardNew({ as: "claude", batch: "../../cards.md", tag: ["source:conversation"] }, term.deps)).toBe(0);
    expect(term.said()).toBe(["Created 3 cards from ../../cards.md:", ...listed].join("\n"));

    fs.writeFileSync(path.join(term.board.root, "more.md"), '## One more\n\n```yaml\ntype: idea\nrelations: [{ kind: related, to: 4 }]\n```\n\nAn idea.\n');
    expect(await runBoardNew({ as: "claude", batch: "../../more.md", json: true }, term.deps)).toBe(0);
    const json = JSON.parse(term.said()) as { cards: Array<{ id: number; file: string }>; events: Array<{ kind: string }>; dryRun: boolean };
    expect([json.dryRun, json.cards.map((card) => [card.id, card.file]), json.events.map((event) => event.kind)]).toEqual([false, [[5, "items/0005-one-more.md"]], ["item.created", "relation.added"]]);
  });

  it("refuses a bad card with exit 1, and the options of one card beside --batch with exit 2, writing nothing", async () => {
    const term = await terminal();
    const before = term.board.snapshot();
    expect(await runBoardNew({ as: "claude", batch: "../../cards.md" }, term.deps)).toBe(2);
    expect(term.said()).toBe('Refused: the card "## The batch command" (line 3 of ../../cards.md): a relation names card #1, which is not on the board. Nothing was written.');
    fs.writeFileSync(path.join(term.board.root, "pinned.md"), "## Mine\n\n```yaml\ntype: note\ncolumn: pinned\n```\n");
    expect(await runBoardNew({ as: "claude", batch: "../../pinned.md", json: true }, term.deps)).toBe(1);
    expect(JSON.parse(term.said())).toEqual({
      refused: "column",
      message: 'Refused: the card "## Mine" (line 1 of ../../pinned.md): claude is an agent and may not create a card in Pinned (a person\'s column); an agent may create a card in Inbox, Backlog, Ideas, In progress, For review. Nothing was written.'
    });
    expect(await runBoardNew({ as: "claude", batch: "../../cards.md", type: "task" }, term.deps)).toBe(2);
    expect(term.said()).toBe(
      "new --batch takes each card's type, title, description, relations and fields from the file, so --type goes with a card made alone; --column, --tag and --session apply to every card of the batch."
    );
    expect(await runBoardNew({ as: "claude", batch: "../../nowhere.md" }, term.deps)).toBe(2);
    expect(term.said()).toBe("Cannot read ../../nowhere.md.");
    expect(term.board.snapshot()).toEqual(before);
  });

  it("new --dry-run says the one card it would create, and writes nothing", async () => {
    const term = await terminal();
    const before = term.board.snapshot();
    expect(await runBoardNew({ as: "robin", type: "task", title: "One", column: "backlog", dryRun: true }, term.deps)).toBe(0);
    expect(term.said()).toBe("Would create #1 (task) in Backlog: One; nothing was written.");
    expect(term.board.snapshot()).toEqual(before);
  });

  it("reads --batch and --dry-run from the command line", async () => {
    const term = await terminal();
    await runBoardNew({ as: "robin", type: "task", title: "Pinboard package 3" }, term.deps);
    term.said();
    const before = term.board.snapshot();
    const exit = process.exitCode;
    const said = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.exitCode = 0;
      await createBoardCommand().parseAsync(["new", "--board", term.board.dir, "--as", "claude", "--batch", path.join(term.board.root, "cards.md"), "--dry-run", "--json"], { from: "user" });
      expect(process.exitCode).toBe(0);
      const json = JSON.parse(String(said.mock.calls[0]![0])) as { dryRun: boolean; cards: Array<{ id: number }> };
      expect([json.dryRun, json.cards.map((card) => card.id)]).toEqual([true, [2, 3, 4]]);
      expect(term.board.snapshot()).toEqual(before);
    } finally {
      said.mockRestore();
      process.exitCode = exit;
    }
  });
});
