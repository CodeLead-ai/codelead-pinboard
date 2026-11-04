import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBoardCommand, runBoardMove, runBoardNew, runBoardReply, runBoardSet, type BoardCliDependencies } from "../cli/board.js";
import {
  addComment,
  appendEvents,
  archiveCard,
  boardConfigProblems,
  boardContext,
  BoardRefusal,
  checkBoard,
  createCard,
  createCards,
  defaultBoardConfig,
  getCard,
  initBoard,
  listCards,
  markOpened,
  moveCard,
  readBoardConfig,
  readEvents,
  relationsOf,
  updateCard,
  validateBoard,
  withBoardLock,
  workspaceOf,
  type BoardContext,
  type Participant
} from "../core/index.js";
import { cardDetail, editorInfo, vscodeHref } from "../server/index.js";

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
  /** Moves the board's clock on. */
  tick: (seconds?: number) => void;
  read: (relative: string) => string;
  write: (relative: string, text: string) => void;
  events: () => Array<Record<string, unknown>>;
}

async function newBoard(participants: Participant[] = PEOPLE): Promise<TestBoard> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pinboard-core-"));
  roots.push(root);
  const dir = path.join(root, "docs", "codelead", "board");
  let time = Date.parse("2026-10-04T10:00:00Z");
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
    write: (relative, text) => {
      fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
      fs.writeFileSync(path.join(dir, relative), text, "utf8");
    },
    events: () => readEvents(dir).events.map(({ event }) => event as Record<string, unknown>)
  };
}

interface TestWorkspace extends TestBoard {
  /** The home folder of the test's machine: it holds the workspace, as a person's does. */
  home: string;
  /** The folder of the repositories, `<home>/Projects`: the repository's parent. */
  workspace: string;
}

/**
 * A machine of the test's own: a home folder holding `Projects/`, the workspace, with the board's
 * repository `codelead` and a second repository beside it, `ledgerbook-rebuild`; `Downloads/` in
 * the home folder, outside the workspace; and `shelf/kept`, a repository in another folder of the
 * home, for a workspace set in board.json.
 */
async function newWorkspace(): Promise<TestWorkspace> {
  const home = await mkdtemp(path.join(os.tmpdir(), "pinboard-home-"));
  roots.push(home);
  const workspace = path.join(home, "Projects");
  const root = path.join(workspace, "codelead");
  const files = ["Projects/codelead/docs/plan.md", "Projects/ledgerbook-rebuild/README.md", "Projects/ledgerbook-rebuild/docs/x.md", "Downloads/notes.txt", "shelf/kept/docs/y.md"];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
    fs.writeFileSync(path.join(home, file), "one\ntwo\nthree\n");
  }
  fs.mkdirSync(path.join(root, ".git"));
  const dir = path.join(root, "docs", "codelead", "board");
  let time = Date.parse("2026-10-04T10:00:00Z");
  const ctx = boardContext({ dir, root, home, now: () => new Date(time) });
  initBoard(ctx, { name: "test-workspace", participants: PEOPLE });
  return {
    ctx,
    dir,
    root,
    home,
    workspace,
    tick: (seconds = 60) => {
      time += seconds * 1000;
    },
    read: (relative) => fs.readFileSync(path.join(dir, relative), "utf8"),
    write: (relative, text) => {
      fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
      fs.writeFileSync(path.join(dir, relative), text, "utf8");
    },
    events: () => readEvents(dir).events.map(({ event }) => event as Record<string, unknown>)
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

const handCard = (id: number, extra = "", rest = "\nWritten by hand.\n\n## Thread\n"): string =>
  `---\nid: ${id}\ntype: note\ntitle: "Card ${id}"\ncolumn: backlog\ntags: []\nauthor: robin\ncreated: 2026-10-04T09:00:00Z\nupdated: 2026-10-04T09:00:00Z\n${extra}---\n${rest}`;

describe("ids", () => {
  it("takes the id from nextId and raises it in the same step, changing only that number in a board.json laid out by hand (CRLF kept)", async () => {
    const board = await newBoard();
    const config = JSON.parse(board.read("board.json")) as Record<string, unknown>;
    const byHand = `${JSON.stringify(config, null, 4)}\n`.replace(/\n/g, "\r\n");
    board.write("board.json", byHand);
    expect(createCard(board.ctx, "robin", { type: "task", title: "First" }).card.id).toBe(1);
    expect(createCard(board.ctx, "robin", { type: "task", title: "Second" }).card.id).toBe(2);
    expect(board.read("board.json")).toBe(byHand.replace('"nextId": 1', '"nextId": 3'));
    expect(fs.readdirSync(path.join(board.dir, "items")).sort()).toEqual(["0001-first.md", "0002-second.md"]);
  });

  it("never hands out an id a card already has, whatever nextId says", async () => {
    const board = await newBoard();
    board.write("items/0005-by-hand.md", handCard(5));
    expect(createCard(board.ctx, "robin", { type: "note", title: "Next" }).card.id).toBe(6);
    expect(JSON.parse(board.read("board.json")).nextId).toBe(7);
  });

  it("creates several cards in one step, and a card of the step may relate to another before either has an id", async () => {
    const board = await newBoard();
    const made = createCards(board.ctx, "robin", [
      { ref: "parent", type: "task", title: "Parent" },
      { ref: "child", type: "task", title: "Child", relations: [{ kind: "child-of", ref: "parent" }] }
    ]);
    expect(made.map((result) => result.card.id)).toEqual([1, 2]);
    expect(getCard(board.ctx, 2).card.relations).toEqual([{ kind: "child-of", to: 1 }]);
    expect(relationsOf(listCards(board.ctx).cards, 1)).toEqual([{ kind: "parent-of", to: 2, statedBy: 2 }]);
    // The lock is taken again freely inside a write: nothing waits on itself.
    expect(withBoardLock(board.dir, () => createCard(board.ctx, "robin", { type: "note", title: "Inside" }).card.id)).toBe(3);
    expect(fs.existsSync(path.join(board.dir, ".board.lock"))).toBe(false);
  });

  it("writes nothing at all when one card of a step is refused", async () => {
    const board = await newBoard();
    const said = refusal(() => createCards(board.ctx, "robin", [{ type: "task", title: "Fine" }, { type: "bug", title: "Not a type" }]));
    expect(said.message).toBe('Refused: "bug" is not a card type of the board (question, decision, task, idea, review, note). Nothing was written.');
    expect(fs.readdirSync(path.join(board.dir, "items"))).toEqual([]);
    expect(board.read("events.jsonl")).toBe("");
    expect(JSON.parse(board.read("board.json")).nextId).toBe(1);
  });
});

describe("refusals, each in its own words, and nothing written", () => {
  it("refuses a stale write: the updated the writer read is not the card's", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "A task" });
    const before = board.read("items/0001-a-task.md");
    board.tick();
    const said = refusal(() => updateCard(board.ctx, 1, { as: "robin", changes: { status: "late" }, expectUpdated: "2026-10-04T09:00:00Z" }));
    expect(said.code).toBe("stale");
    expect(said.message).toBe("Refused: card #1 changed since it was read (its updated is 2026-10-04T10:00:00Z; the write expected 2026-10-04T09:00:00Z); nothing was written. Read the card again and redo the change.");
    expect(board.read("items/0001-a-task.md")).toBe(before);
    // With the updated it read, the write goes through.
    expect(updateCard(board.ctx, 1, { as: "robin", changes: { status: "on time" }, expectUpdated: "2026-10-04T10:00:00Z" }).card.status).toBe("on time");
  });

  it("lets an agent move a card only into its columns, never into a person's", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "A task" });
    for (const column of ["pinned", "Done"]) {
      const said = refusal(() => moveCard(board.ctx, 1, { as: "claude", to: column }));
      expect(said.code).toBe("column");
      expect(said.message).toBe(
        `Refused: claude is an agent and may not move a card into ${column === "pinned" ? "Pinned" : "Done"} (a person's column); an agent may move a card into Inbox, Backlog, Ideas, In progress, For review. Nothing was written.`
      );
    }
    expect(moveCard(board.ctx, 1, { as: "claude", to: "For review" }).events).toMatchObject([{ by: "claude", kind: "item.moved", data: { from: "inbox", to: "for-review" } }]);
    expect(moveCard(board.ctx, 1, { as: "robin", to: "pinned" }).card.column).toBe("pinned");
    // A column the board's agents.mayMoveTo leaves out is refused too, for that reason.
    const config = JSON.parse(board.read("board.json")) as { agents: { mayMoveTo: string[] } };
    config.agents.mayMoveTo = config.agents.mayMoveTo.filter((column) => column !== "ideas");
    board.write("board.json", JSON.stringify(config));
    expect(refusal(() => moveCard(board.ctx, 1, { as: "claude", to: "ideas" })).message).toBe(
      "Refused: claude is an agent and may not move a card into Ideas (not in agents.mayMoveTo); an agent may move a card into Inbox, Backlog, In progress, For review. Nothing was written."
    );
  });

  it("lets an agent create cards on its own in its columns, tagged by:<agent>, and nowhere else", async () => {
    const board = await newBoard();
    const made = createCard(board.ctx, "claude", { type: "idea", title: "One board per repo?" });
    expect(made.card).toMatchObject({ column: "inbox", tags: ["by:claude"], author: "claude" });
    expect(refusal(() => createCard(board.ctx, "claude", { type: "idea", title: "Pinned", column: "pinned" })).message).toBe(
      "Refused: claude is an agent and may not create a card in Pinned (a person's column); an agent may create a card in Inbox, Backlog, Ideas, In progress, For review. Nothing was written."
    );
    const config = JSON.parse(board.read("board.json")) as { agents: { mayCreate: boolean } };
    config.agents.mayCreate = false;
    board.write("board.json", JSON.stringify(config));
    expect(refusal(() => createCard(board.ctx, "claude", { type: "idea", title: "No" })).message).toBe(
      "Refused: claude is an agent, and agents do not create cards on this board (agents.mayCreate is false). Nothing was written."
    );
    expect(createCard(board.ctx, "robin", { type: "idea", title: "A person may", column: "pinned" }).card.column).toBe("pinned");
  });

  it("refuses who is not a participant, and a column or a type the board does not have", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "A task" });
    expect(refusal(() => addComment(board.ctx, 1, { as: "codex", body: "Hello" })).message).toBe(
      'Refused: "codex" is not a participant of the board (robin, claude); add it to board.json\'s participants first. Nothing was written.'
    );
    expect(refusal(() => moveCard(board.ctx, 1, { as: "robin", to: "doing" })).message).toBe(
      'Refused: "doing" is not a column of the board (inbox, backlog, ideas, pinned, in-progress, for-review, done). Nothing was written.'
    );
    expect(refusal(() => updateCard(board.ctx, 1, { as: "robin", changes: { type: "epic" } })).message).toBe(
      'Refused: "epic" is not a card type of the board (question, decision, task, idea, review, note). Nothing was written.'
    );
    expect(refusal(() => getCard(board.ctx, 99)).message).toBe("No card #99 on the board.");
  });

  it("refuses a text holding a secret, by the audit pack's own patterns, without repeating it", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "A task" });
    const before = board.read("items/0001-a-task.md");
    const secrets = ["Server=db;Password=hunter2x;", "the key is sk-ant-api03-abcdef", "OPENROUTER=sk-or-v1-abcdef", "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123'"];
    for (const secret of secrets) {
      const said = refusal(() => addComment(board.ctx, 1, { as: "robin", body: `Note: ${secret}` }));
      expect(said.code, secret).toBe("secret");
      expect(said.message).toBe("Refused: the comment looks like it holds a secret (a key, a connection-string password or a bearer token); nothing was written. Leave the secret out and say where it is kept instead.");
    }
    expect(refusal(() => createCard(board.ctx, "robin", { type: "note", title: "Password=hunter2x" })).message).toMatch(/^Refused: the title looks like it holds a secret/);
    expect(board.read("items/0001-a-task.md")).toBe(before);
    expect(board.events()).toHaveLength(1);
  });

  it("refuses a path of this machine outside the workspace and a name the board keeps private; a path in the repository is fine", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "A task" });
    expect(refusal(() => addComment(board.ctx, 1, { as: "claude", body: "see /home/tester/notes/plan.md" })).message).toBe(
      "Refused: the comment holds a path of this machine outside the workspace (under the home folder); nothing was written. Cite the file by its path in a repository of the workspace instead, or give --rewrite-paths to write it as <home>/…."
    );
    // A path under the repository is no longer refused: it is written as its path in the repository (card #176).
    expect(addComment(board.ctx, 1, { as: "claude", body: `see ${board.root}/docs/plan.md` }).card.thread.at(-1)?.body).toBe("see docs/plan.md");
    board.write("private-names.txt", "# names that must not be recorded\nExample Corp\n");
    expect(refusal(() => addComment(board.ctx, 1, { as: "claude", body: "Met example corp today." })).message).toBe(
      "Refused: the comment names someone the board keeps private (listed in private-names.txt); nothing was written."
    );
    expect(addComment(board.ctx, 1, { as: "claude", body: "See docs/plan.md:12; Example Corporation is another name." }).events).toHaveLength(1);
    expect(board.read(".gitignore")).toContain("private-names.txt");
  });

  it("refuses a comment or a description that would split the card, unless the line is in a code block", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "A task" });
    expect(refusal(() => addComment(board.ctx, 1, { as: "claude", body: "Quoting:\n### robin · 2026-10-04T10:00:00Z\nFine." })).message).toBe(
      'Refused: the comment has a line the card would read as its own structure ("### robin · 2026-10-04T10:00:00Z"); put it in a code block or reword it. Nothing was written.'
    );
    expect(refusal(() => updateCard(board.ctx, 1, { as: "robin", changes: { description: "Intro\n## Thread\nmore" } })).message).toBe(
      'Refused: the description has a line "## Thread", which would begin the card\'s thread; put it in a code block or reword it. Nothing was written.'
    );
    addComment(board.ctx, 1, { as: "claude", body: "Quoting:\n```\n### robin · 2026-10-04T10:00:00Z\nFine.\n```" });
    expect(getCard(board.ctx, 1)).toMatchObject({ problems: [], card: { thread: [{ author: "claude" }] } });
    expect(refusal(() => addComment(board.ctx, 1, { as: "claude", body: "  \n " })).message).toBe("Refused: the comment is empty; nothing was written.");
  });

  it("refuses to write a card whose file has problems, and still shows it with them", async () => {
    const board = await newBoard();
    board.write("items/0001-broken.md", handCard(1).replace("column: backlog", "column: someday"));
    expect(getCard(board.ctx, 1).problems).toEqual([]);
    board.write("items/0002-broken.md", handCard(2).replace('title: "Card 2"\n', ""));
    expect(getCard(board.ctx, 2).problems).toEqual(['the required key "title" is missing']);
    expect(refusal(() => addComment(board.ctx, 2, { as: "robin", body: "Hi" })).message).toBe(
      'Refused: items/0002-broken.md has problems: the required key "title" is missing. Nothing was written; `codelead board validate` lists them.'
    );
    board.write("items/0003-unreadable.md", "no front matter");
    expect(refusal(() => addComment(board.ctx, 3, { as: "robin", body: "Hi" })).message).toBe(
      'Refused: items/0003-unreadable.md cannot be read as a card: the file does not begin with front matter (a first line "---"). Nothing was written.'
    );
  });
});

describe("events and cursors: a check shows exactly what came after the cursor", () => {
  it("groups the events of others by card, newest card first, and moves the cursor only with ack", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "One" });
    board.tick();
    createCard(board.ctx, "robin", { type: "question", title: "Two" });
    const first = checkBoard(board.ctx, { as: "claude" });
    expect(first.groups.map((group) => [group.item, group.title, group.events.map((event) => event.kind)])).toEqual([
      [2, "Two", ["item.created"]],
      [1, "One", ["item.created"]]
    ]);
    expect(first.intervalMinutes).toBe(30);
    // Without ack nothing moved: the same two again.
    expect(checkBoard(board.ctx, { as: "claude" }).notifications).toHaveLength(2);
    expect(checkBoard(board.ctx, { as: "claude", ack: true }).acknowledged).toEqual({ seen: "2026-10-04T10:01:00Z", lines: 2 });
    expect(JSON.parse(board.read("cursors/claude.json"))).toEqual({ seen: "2026-10-04T10:01:00Z", lines: 2 });
    expect(checkBoard(board.ctx, { as: "claude" }).notifications).toEqual([]);

    board.tick();
    addComment(board.ctx, 2, { as: "claude", body: "My own reply is no news to me." });
    moveCard(board.ctx, 1, { as: "robin", to: "backlog", comment: "After packages 4 and 5." });
    const second = checkBoard(board.ctx, { as: "claude" });
    expect(second.after).toBe(3);
    expect(second.groups).toEqual([
      {
        item: 1,
        title: "One",
        column: "backlog",
        type: "task",
        events: [
          { at: "2026-10-04T10:02:00Z", by: "robin", item: 1, kind: "comment.added", data: { excerpt: "After packages 4 and 5.", withMove: true } },
          { at: "2026-10-04T10:02:00Z", by: "robin", item: 1, kind: "item.moved", data: { from: "inbox", to: "backlog", withComment: true } }
        ]
      }
    ]);
    // Robin has no cursor yet: every event by someone else is news to him.
    expect(checkBoard(board.ctx, { as: "robin" }).notifications.map((event) => [event.by, event.kind])).toEqual([["claude", "comment.added"]]);
  });

  it("places the cursor by lines: an event written in the same second after the ack is still new", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "One" });
    checkBoard(board.ctx, { as: "claude", ack: true });
    addComment(board.ctx, 1, { as: "robin", body: "Same second as the ack." });
    expect(checkBoard(board.ctx, { as: "claude" }).notifications.map((event) => event.kind)).toEqual(["comment.added"]);
  });

  it("reads a cursor written by hand with only a time: the events after it", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "One" });
    board.tick(3600);
    createCard(board.ctx, "robin", { type: "task", title: "Two" });
    board.write("cursors/claude.json", '{ "seen": "2026-10-04T10:30:00Z" }\n');
    expect(checkBoard(board.ctx, { as: "claude" }).notifications.map((event) => event.item)).toEqual([2]);
    board.write("cursors/claude.json", "{ not json");
    expect(refusal(() => checkBoard(board.ctx, { as: "claude" })).message).toBe(
      "Refused: cursors/claude.json is not JSON. Fix it, or delete it (without a cursor everything on the board is new). Nothing was written."
    );
  });

  it("clears a card's events once the participant opened it, as the capsule does", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "One" });
    createCard(board.ctx, "robin", { type: "task", title: "Two" });
    checkBoard(board.ctx, { as: "claude", ack: true });
    board.tick();
    addComment(board.ctx, 1, { as: "robin", body: "On one." });
    addComment(board.ctx, 2, { as: "robin", body: "On two." });
    board.tick();
    markOpened(board.ctx, "claude", 1);
    expect(checkBoard(board.ctx, { as: "claude" }).groups.map((group) => group.item)).toEqual([2]);
    // The ack keeps no opened card the cursor has passed.
    checkBoard(board.ctx, { as: "claude", ack: true });
    expect(JSON.parse(board.read("cursors/claude.json"))).toEqual({ seen: "2026-10-04T10:02:00Z", lines: 4, opened: {} });
  });

  it("appends events with the log's own line ending, and ends a last line someone left open", async () => {
    const board = await newBoard();
    board.write("events.jsonl", '{"at":"2026-10-04T09:00:00Z","by":"robin","kind":"item.created","item":1}\r\n{"at":"2026-10-04T09:01:00Z","by":"codex","kind":"comment.added","item":1}');
    appendEvents(board.dir, [{ at: "2026-10-04T10:00:00Z", by: "claude", item: 1, kind: "tag.added", data: { tag: "w5" } }]);
    expect(board.read("events.jsonl")).toBe(
      '{"at":"2026-10-04T09:00:00Z","by":"robin","kind":"item.created","item":1}\r\n{"at":"2026-10-04T09:01:00Z","by":"codex","kind":"comment.added","item":1}\r\n{"at":"2026-10-04T10:00:00Z","by":"claude","item":1,"kind":"tag.added","data":{"tag":"w5"}}\r\n'
    );
    expect(readEvents(board.dir).count).toBe(3);
  });
});

describe("a card changed without an event", () => {
  it("is announced as item.updated by unknown, at the file's time, with the parts that changed, once", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "One" });
    checkBoard(board.ctx, { as: "claude", ack: true });
    const file = "items/0001-one.md";
    board.write(file, board.read(file).replace("column: inbox", "column: backlog").replace("\n## Thread\n", "\n## Thread\n\n### robin · 2026-10-04T10:05:00Z\nBy hand.\n"));
    const stamp = new Date("2026-10-04T10:05:30Z");
    fs.utimesSync(path.join(board.dir, file), stamp, stamp);
    const result = checkBoard(board.ctx, { as: "claude" });
    expect(result.synthesized).toEqual([{ at: "2026-10-04T10:05:30Z", by: "unknown", item: 1, kind: "item.updated", data: { synthesized: true, fields: ["column", "thread"] } }]);
    expect(result.notifications).toEqual(result.synthesized);
    expect(checkBoard(board.ctx, { as: "robin" }).synthesized).toEqual([]);
  });

  it("is not announced when its writer wrote the event too", async () => {
    const board = await newBoard([...PEOPLE, { id: "codex", kind: "agent", name: "Codex" }]);
    createCard(board.ctx, "robin", { type: "task", title: "One" });
    checkBoard(board.ctx, { as: "robin", ack: true });
    const file = "items/0001-one.md";
    fs.appendFileSync(path.join(board.dir, file), "\n### codex · 2026-10-04T10:06:00Z\nRead it; looks right.\n");
    fs.appendFileSync(path.join(board.dir, "events.jsonl"), '{"at":"2026-10-04T10:06:00Z","by":"codex","item":1,"kind":"comment.added","data":{"excerpt":"Read it; looks right."}}\n');
    const result = checkBoard(board.ctx, { as: "robin" });
    expect(result.synthesized).toEqual([]);
    expect(result.notifications.map((event) => [event.by, event.kind])).toEqual([["codex", "comment.added"]]);
    expect(getCard(board.ctx, 1).card.thread).toEqual([{ author: "codex", at: "2026-10-04T10:06:00Z", body: "Read it; looks right." }]);
  });

  it("is announced as created by unknown when its file appeared with no event at all", async () => {
    const board = await newBoard();
    board.write("items/0007-by-hand.md", handCard(7));
    const stamp = new Date("2026-10-04T09:30:00Z");
    fs.utimesSync(path.join(board.dir, "items/0007-by-hand.md"), stamp, stamp);
    expect(checkBoard(board.ctx, { as: "robin" }).synthesized).toEqual([
      { at: "2026-10-04T09:30:00Z", by: "unknown", item: 7, kind: "item.created", data: { synthesized: true, file: "items/0007-by-hand.md", title: "Card 7" } }
    ]);
  });

  it("is announced before the next write to the card, so the hand edit is not lost under it", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "One" });
    const file = "items/0001-one.md";
    board.write(file, board.read(file).replace('title: "One"', 'title: "One, renamed by hand"'));
    board.tick();
    const result = addComment(board.ctx, 1, { as: "claude", body: "Noted." });
    expect(board.events().slice(-2).map((event) => [event.by, event.kind, event.data])).toEqual([
      ["unknown", "item.updated", { synthesized: true, fields: ["title"] }],
      ["claude", "comment.added", { excerpt: "Noted." }]
    ]);
    expect(result.card.title).toBe("One, renamed by hand");
  });
});

describe("a card an agent wrote by hand, in its own YAML style", () => {
  it("keeps every line of it but the keys a change touches, and its CRLF", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "Target" });
    const lines = [
      "---",
      "# written by an agent, by hand",
      "id: 2",
      "type: question",
      "title: 'Is \"one board\" right?'",
      "column: inbox",
      "tags:",
      "  - repo:codelead",
      "  - area:board",
      "author: claude",
      "created: 2026-10-04T09:00:00Z",
      "updated: 2026-10-04T09:00:00Z",
      "fields:",
      "  askedBy: claude",
      "  answer: |",
      "    Not yet.",
      "",
      "    # still open",
      "",
      "custom: { keep: me }",
      "---",
      "",
      "The question.",
      "",
      "## Thread",
      ""
    ];
    const written = lines.join("\r\n");
    board.write("items/0002-question.md", written);
    expect(getCard(board.ctx, 2)).toMatchObject({ problems: [], card: { title: 'Is "one board" right?', tags: ["repo:codelead", "area:board"], fields: { askedBy: "claude", answer: "Not yet.\n\n# still open\n" }, extra: { custom: { keep: "me" } } } });
    board.tick();
    updateCard(board.ctx, 2, { as: "claude", changes: { addTags: ["yes"], addRelations: [{ kind: "related", to: 1 }] } });
    const after = board.read("items/0002-question.md");
    expect(after.replace(/\r\n/g, "")).not.toMatch(/\n/);
    const expected = [...lines];
    expected.splice(6, 3, "tags: [repo:codelead, area:board, \"yes\"]");
    expected[9] = "updated: 2026-10-04T10:01:00Z";
    expected.splice(10, 0, "relations:", "  - { kind: related, to: 1 }");
    expect(after.split("\r\n")).toEqual(expected);
    // The comment the agent appends next is added in the file's own line ending, and the card still reads.
    addComment(board.ctx, 2, { as: "robin", body: "Yes: one board, the repository as a tag." });
    expect(board.read("items/0002-question.md").endsWith("## Thread\r\n\r\n### robin · 2026-10-04T10:01:00Z\r\nYes: one board, the repository as a tag.\r\n")).toBe(true);
    expect(validateBoard(board.ctx).problems).toEqual([]);
  });
});

describe("changing a card", () => {
  it("writes one event per tag, relation and attachment, and one item.updated for the rest", async () => {
    const board = await newBoard();
    createCards(board.ctx, "robin", [
      { type: "task", title: "One" },
      { type: "task", title: "Two" }
    ]);
    board.tick();
    const result = updateCard(board.ctx, 1, {
      as: "claude",
      changes: { addTags: ["w5", "repo:codelead"], addRelations: [{ kind: "blocked-by", to: 2 }], status: "waiting on #2", addAttachments: [{ path: "docs/plan.md", lines: "12-20" }] }
    });
    expect(result.events.map((event) => [event.kind, event.data])).toEqual([
      ["item.updated", { fields: ["status"] }],
      ["tag.added", { tag: "w5" }],
      ["tag.added", { tag: "repo:codelead" }],
      ["relation.added", { kind: "blocked-by", to: 2 }],
      ["attachment.added", { path: "docs/plan.md", lines: "12-20" }]
    ]);
    const text = board.read("items/0001-one.md");
    expect(text).toContain('tags: [by:robin, w5, repo:codelead]\nauthor: robin\ncreated: 2026-10-04T10:00:00Z\nupdated: 2026-10-04T10:01:00Z\nrelations:\n  - { kind: blocked-by, to: 2 }\nattachments:\n  - { path: "docs/plan.md", lines: "12-20" }\nstatus: "waiting on #2"\n');
    expect(relationsOf(listCards(board.ctx).cards, 2)).toEqual([{ kind: "blocks", to: 1, statedBy: 1 }]);
    // The same changes again change nothing, and write nothing.
    expect(updateCard(board.ctx, 1, { as: "claude", changes: { addTags: ["w5"], addRelations: [{ kind: "blocked-by", to: 2 }] } }).events).toEqual([]);
    expect(refusal(() => updateCard(board.ctx, 1, { as: "claude", changes: { addRelations: [{ kind: "blocked-by", to: 9 }] } })).message).toBe("Refused: there is no card #9 on the board to relate to. Nothing was written.");
    expect(refusal(() => updateCard(board.ctx, 1, { as: "claude", changes: { addRelations: [{ kind: "related", to: 1 }] } })).message).toBe("Refused: a card cannot relate to itself. Nothing was written.");
    expect(refusal(() => updateCard(board.ctx, 1, { as: "claude", changes: { addRelations: [{ kind: "cousin-of", to: 2 }] } })).message).toBe(
      'Refused: "cousin-of" is not a kind of relation (parent-of, child-of, related, blocks, blocked-by, duplicate-of, follows). Nothing was written.'
    );
    const removed = updateCard(board.ctx, 1, { as: "robin", changes: { removeTags: ["w5"], removeRelations: [{ kind: "blocked-by", to: 2 }], status: null } });
    expect(removed.events.map((event) => event.kind)).toEqual(["item.updated", "tag.removed", "relation.removed"]);
    expect(board.read("items/0001-one.md")).toContain("relations: []\n");
    expect(board.read("items/0001-one.md")).not.toContain("status:");
  });

  it("archives a card for a person only; an archived card leaves the list and stays readable", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "note", title: "Old", column: "done" });
    expect(refusal(() => archiveCard(board.ctx, 1, { as: "claude" })).message).toBe("Refused: claude is an agent; only a person archives a card. Nothing was written.");
    expect(archiveCard(board.ctx, 1, { as: "robin" }).events).toMatchObject([{ kind: "item.archived", data: { column: "done" } }]);
    expect(listCards(board.ctx).cards).toEqual([]);
    expect(listCards(board.ctx, { archived: true }).cards.map((card) => card.archived)).toEqual(["2026-10-04T10:00:00Z"]);
    expect(getCard(board.ctx, 1).card.title).toBe("Old");
  });

  it("filters by tag, type, column and repository without moving a card out of its column", async () => {
    const board = await newBoard();
    createCards(board.ctx, "robin", [
      { type: "task", title: "A", tags: ["repo:codelead", "w5"], column: "backlog" },
      { type: "decision", title: "B", tags: ["repo:codelead"], column: "pinned" },
      { type: "task", title: "C", tags: ["repo:other"], column: "backlog" }
    ]);
    const titles = (filter: Parameters<typeof listCards>[1]): string[] => listCards(board.ctx, filter).cards.map((card) => `${card.title}@${card.column}`);
    expect(titles({ repo: "codelead" })).toEqual(["A@backlog", "B@pinned"]);
    expect(titles({ type: "task", tags: ["w5"] })).toEqual(["A@backlog"]);
    expect(titles({ column: "Backlog" })).toEqual(["A@backlog", "C@backlog"]);
    expect(refusal(() => listCards(board.ctx, { column: "later" })).code).toBe("column");
  });
});

describe("validation names every problem of every file", () => {
  it("finds what is wrong with cards, the log and the cursors", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "Good" });
    board.write("items/0002-wrong.md", handCard(2, "relations:\n  - { kind: child-of, to: 99 }\n").replace("column: backlog", "column: someday").replace("type: note", "type: epic").replace("author: robin", "author: nobody"));
    board.write("items/0001-twin.md", handCard(1));
    board.write("items/0004-secret.md", handCard(4, "", "\nThe password: Password=hunter2x;\n\n## Thread\n"));
    board.write("items/0009-misnamed.md", handCard(5));
    fs.appendFileSync(path.join(board.dir, "events.jsonl"), 'not json\n{"at":"2026-10-04T10:00:00Z","by":"ghost","item":1,"kind":"item.renamed"}\n');
    board.write("cursors/someone.json", '{ "seen": "later" }\n');
    const result = validateBoard(board.ctx);
    expect(result.problems).toEqual([
      { file: "items/0002-wrong.md", message: 'the type "epic" is not a card type of the board (question, decision, task, idea, review, note)' },
      { file: "items/0002-wrong.md", message: 'the column "someday" is not a column of the board (inbox, backlog, ideas, pinned, in-progress, for-review, done)' },
      { file: "items/0002-wrong.md", message: 'the author "nobody" is not a participant of the board (robin, claude)' },
      { file: "items/0002-wrong.md", message: "relation 1: there is no card #99 on the board" },
      { file: "items/0004-secret.md", message: "the description looks like it holds a secret" },
      { file: "items/0009-misnamed.md", message: "the file's name does not begin with the card's id (0005-….md)" },
      { file: "items/0001-good.md", message: "the id 1 is also the id of items/0001-twin.md" },
      { file: "items/0001-twin.md", message: "the id 1 is also the id of items/0001-good.md" },
      { file: "events.jsonl", message: "line 2 is not JSON" },
      { file: "events.jsonl", message: 'line 3: "item.renamed" is not an event kind (item.created, item.updated, item.moved, item.archived, comment.added, relation.added, relation.removed, tag.added, tag.removed, attachment.added)' },
      { file: "events.jsonl", message: 'line 3: "ghost" is not a participant of the board' },
      { file: "cursors/someone.json", message: '"someone" is not a participant of the board' },
      { file: "cursors/someone.json", message: '"seen" must be a UTC time, and is "later"' }
    ]);
    expect([result.cards, result.events]).toEqual([5, 3]);
  });

  it("finds nothing wrong with a board the core wrote", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "Good", description: "With a body." });
    addComment(board.ctx, 1, { as: "claude", body: "And a comment." });
    checkBoard(board.ctx, { as: "claude", ack: true });
    expect(validateBoard(board.ctx)).toEqual({ problems: [], cards: 1, events: 2, cursors: 1 });
  });
});

describe("citing a file of this machine: rewritten as a card cites it, not refused (card #176)", () => {
  it("a comment: a path under the repository becomes its path there, one under the workspace <repository>:<path>; the event lists each", async () => {
    const ws = await newWorkspace();
    createCard(ws.ctx, "robin", { type: "task", title: "A task" });
    const body = `Read ${ws.root}/docs/plan.md:3, then ${ws.workspace}/ledgerbook-rebuild/docs/x.md and ${ws.workspace}/ledgerbook-rebuild/README.md.\nThe rebuild lives in ${ws.workspace}/ledgerbook-rebuild.`;
    const result = addComment(ws.ctx, 1, { as: "claude", body });
    expect(result.card.thread.at(-1)?.body).toBe("Read docs/plan.md:3, then ledgerbook-rebuild:docs/x.md and ledgerbook-rebuild:README.md.\nThe rebuild lives in ledgerbook-rebuild.");
    const rewritten = ["docs/plan.md:3", "ledgerbook-rebuild:docs/x.md", "ledgerbook-rebuild:README.md", "ledgerbook-rebuild"];
    expect(result.events.map((event) => [event.kind, event.data?.rewritten])).toEqual([["comment.added", rewritten]]);
    expect(ws.events().at(-1)).toMatchObject({ kind: "comment.added", data: { excerpt: expect.stringMatching(/^Read docs\/plan\.md:3, then/), rewritten } });
    // Nothing the board holds names the machine, and the board stays valid.
    for (const file of ["items/0001-a-task.md", "events.jsonl"]) expect(ws.read(file)).not.toContain(ws.home);
    expect(validateBoard(ws.ctx).problems).toEqual([]);
    // A comment that names no path of this machine carries no list.
    expect(addComment(ws.ctx, 1, { as: "claude", body: "Plain words." }).events[0]!.data).toEqual({ excerpt: "Plain words." });
    // A comment written with a move is cited the same way.
    const moved = moveCard(ws.ctx, 1, { as: "claude", to: "for-review", comment: `Done: ${ws.root}/docs/plan.md` });
    expect(moved.events.map((event) => [event.kind, event.data?.rewritten])).toEqual([
      ["comment.added", ["docs/plan.md"]],
      ["item.moved", undefined]
    ]);
    expect(moved.card.thread.at(-1)?.body).toBe("Done: docs/plan.md");
  });

  it("a card's title, description, status, tags and attachments, made and changed: each cited, and listed on the event that writes it", async () => {
    const ws = await newWorkspace();
    const made = createCard(ws.ctx, "claude", {
      type: "task",
      title: `Port ${ws.workspace}/ledgerbook-rebuild/docs/x.md`,
      description: `The plan is ${ws.root}/docs/plan.md.`,
      status: `waiting on ${ws.workspace}/ledgerbook-rebuild/README.md`,
      tags: [`source:${ws.workspace}/ledgerbook-rebuild`],
      attachments: [{ path: `${ws.workspace}/ledgerbook-rebuild/docs/x.md`, lines: "3" }, { path: `${ws.root}/docs/plan.md` }]
    });
    expect(made.card).toMatchObject({
      title: "Port ledgerbook-rebuild:docs/x.md",
      description: "The plan is docs/plan.md.",
      status: "waiting on ledgerbook-rebuild:README.md",
      tags: ["source:ledgerbook-rebuild", "by:claude"],
      attachments: [{ path: "ledgerbook-rebuild:docs/x.md", lines: "3" }, { path: "docs/plan.md" }]
    });
    expect(made.events[0]!.data).toMatchObject({ title: "Port ledgerbook-rebuild:docs/x.md", rewritten: ["ledgerbook-rebuild:docs/x.md", "docs/plan.md", "ledgerbook-rebuild", "ledgerbook-rebuild:README.md"] });

    ws.tick();
    const changed = updateCard(ws.ctx, 1, {
      as: "claude",
      changes: {
        description: `Now ${ws.workspace}/ledgerbook-rebuild/docs/x.md:12`,
        status: `see ${ws.root}/docs/plan.md`,
        addTags: [`from:${ws.root}/docs`],
        addAttachments: [{ path: `${ws.workspace}/ledgerbook-rebuild/README.md` }]
      }
    });
    expect(changed.events.map((event) => [event.kind, event.data])).toEqual([
      ["item.updated", { fields: ["description", "status"], rewritten: ["ledgerbook-rebuild:docs/x.md:12", "docs/plan.md"] }],
      ["tag.added", { tag: "from:docs", rewritten: ["docs"] }],
      ["attachment.added", { path: "ledgerbook-rebuild:README.md", rewritten: ["ledgerbook-rebuild:README.md"] }]
    ]);
    expect(ws.read(changed.card.file)).not.toContain(ws.home);
    // A text that, once cited, is what the card already says changes nothing, and writes nothing.
    expect(updateCard(ws.ctx, 1, { as: "claude", changes: { title: `Port ${ws.workspace}/ledgerbook-rebuild/docs/x.md`, addTags: [`from:${ws.root}/docs`] } }).events).toEqual([]);
    // A tag is removed by the path it was added with.
    expect(updateCard(ws.ctx, 1, { as: "claude", changes: { removeTags: [`from:${ws.root}/docs`] } }).events.map((event) => [event.kind, event.data])).toEqual([["tag.removed", { tag: "from:docs" }]]);
  });

  it("a path under the home folder outside the workspace: refused, and written as <home>/… when the writer asks (counted as a rewrite)", async () => {
    const board = await newBoard();
    createCard(board.ctx, "robin", { type: "task", title: "A task" });
    const said = refusal(() => addComment(board.ctx, 1, { as: "claude", body: "Notes in /home/tester/notes/plan.md." }));
    expect(said.code).toBe("machine-path");
    expect(board.events()).toHaveLength(1);
    const result = addComment(board.ctx, 1, { as: "claude", body: "Notes in /home/tester/notes/plan.md.", rewriteHomePaths: true });
    expect(result.card.thread.at(-1)?.body).toBe("Notes in <home>/notes/plan.md.");
    expect(result.events[0]!.data).toEqual({ excerpt: "Notes in <home>/notes/plan.md.", rewritten: ["<home>/notes/plan.md"] });
    // On a new card and on a change, the same.
    expect(refusal(() => createCard(board.ctx, "robin", { type: "note", title: "From the downloads", description: "From /home/tester/Downloads/a.txt" })).code).toBe("machine-path");
    const made = createCards(board.ctx, "robin", [{ type: "note", title: "From the downloads", description: "From /home/tester/Downloads/a.txt" }], { rewriteHomePaths: true })[0]!;
    expect([made.card.description, made.events[0]!.data?.rewritten]).toEqual(["From <home>/Downloads/a.txt", ["<home>/Downloads/a.txt"]]);
    expect(refusal(() => updateCard(board.ctx, 1, { as: "claude", changes: { status: "in /home/tester/x" } })).message).toMatch(/^Refused: the status holds a path of this machine outside the workspace/);
    expect(updateCard(board.ctx, 1, { as: "claude", changes: { status: "in /home/tester/x" }, rewriteHomePaths: true }).events[0]!.data).toEqual({ fields: ["status"], rewritten: ["<home>/x"] });
  });

  it("on a machine whose home folder holds the workspace: the workspace's paths are cited, the rest of the home is refused or written as <home>/…", async () => {
    const ws = await newWorkspace();
    createCard(ws.ctx, "robin", { type: "task", title: "A task" });
    const body = `Compare ${ws.workspace}/ledgerbook-rebuild/docs/x.md with ${ws.home}/Downloads/notes.txt`;
    expect(refusal(() => addComment(ws.ctx, 1, { as: "claude", body })).code).toBe("machine-path");
    const result = addComment(ws.ctx, 1, { as: "claude", body, rewriteHomePaths: true });
    expect(result.card.thread.at(-1)?.body).toBe("Compare ledgerbook-rebuild:docs/x.md with <home>/Downloads/notes.txt");
    expect(result.events[0]!.data?.rewritten).toEqual(["ledgerbook-rebuild:docs/x.md", "<home>/Downloads/notes.txt"]);
  });

  it("a secret or a private name is refused even after a rewrite, with or without --rewrite-paths", async () => {
    const ws = await newWorkspace();
    createCard(ws.ctx, "robin", { type: "task", title: "A task" });
    for (const rewriteHomePaths of [false, true]) {
      const said = refusal(() => addComment(ws.ctx, 1, { as: "claude", body: `Config in ${ws.root}/docs/plan.md and ${ws.home}/Downloads/notes.txt: Password=hunter2x;`, rewriteHomePaths }));
      expect([said.code, said.message]).toEqual([
        "secret",
        "Refused: the comment looks like it holds a secret (a key, a connection-string password or a bearer token); nothing was written. Leave the secret out and say where it is kept instead."
      ]);
    }
    expect(refusal(() => createCard(ws.ctx, "robin", { type: "note", title: "Keys", description: `In ${ws.workspace}/ledgerbook-rebuild/docs/x.md: sk-ant-api03-abcdef` })).code).toBe("secret");
    ws.write("private-names.txt", "Example Corp\n");
    expect(refusal(() => addComment(ws.ctx, 1, { as: "claude", body: `Example Corp's notes: ${ws.root}/docs/plan.md`, rewriteHomePaths: true })).code).toBe("private-name");
    expect(ws.events()).toHaveLength(1);
  });

  it("the workspace: the repository's parent by default, or board.json's workspace, relative to the repository", async () => {
    const ws = await newWorkspace();
    createCard(ws.ctx, "robin", { type: "task", title: "A task" });
    const kept = `${ws.home}/shelf/kept/docs/y.md`;
    // By default the workspace is the parent (Projects): shelf/kept is in the home folder, outside it.
    expect(refusal(() => addComment(ws.ctx, 1, { as: "claude", body: `See ${kept}` })).code).toBe("machine-path");
    // board.json's workspace, ../../shelf: kept is cited as kept:docs/y.md, and the parent's repositories are outside it now.
    const config = JSON.parse(ws.read("board.json")) as Record<string, unknown>;
    ws.write("board.json", `${JSON.stringify({ ...config, workspace: "../../shelf" }, null, 2)}\n`);
    expect(addComment(ws.ctx, 1, { as: "claude", body: `See ${kept}` }).events[0]!.data?.rewritten).toEqual(["kept:docs/y.md"]);
    expect(refusal(() => addComment(ws.ctx, 1, { as: "claude", body: `See ${ws.workspace}/ledgerbook-rebuild/docs/x.md` })).code).toBe("machine-path");
    // The repository's own paths are cited whatever the workspace.
    expect(addComment(ws.ctx, 1, { as: "claude", body: `See ${ws.root}/docs/plan.md` }).card.thread.at(-1)?.body).toBe("See docs/plan.md");
  });

  it("board.json's workspace: optional, a path relative to the repository; resolved against the repository, its parent when not given", () => {
    const config = defaultBoardConfig({ name: "test-workspace", participants: PEOPLE });
    expect(config.workspace).toBeUndefined();
    expect(boardConfigProblems(config)).toEqual([]);
    expect(boardConfigProblems({ ...config, workspace: "../.." })).toEqual([]);
    expect(boardConfigProblems({ ...config, workspace: "" })).toEqual(['"workspace" must be a text: the folder of the repositories a card may cite, relative to the repository (".." for its parent)']);
    expect(boardConfigProblems({ ...config, workspace: 7 })).toEqual(['"workspace" must be a text: the folder of the repositories a card may cite, relative to the repository (".." for its parent)']);
    expect(boardConfigProblems({ ...config, workspace: "/home/tester/Projects" })).toEqual([
      '"workspace" is "/home/tester/Projects"; it must be relative to the repository (".." for its parent), so that board.json names no folder of this machine'
    ]);
    const root = path.join(path.sep, "work", "Projects", "codelead");
    expect(workspaceOf(root)).toBe(path.join(path.sep, "work", "Projects"));
    expect(workspaceOf(root, config)).toBe(path.join(path.sep, "work", "Projects"));
    expect(workspaceOf(root, { workspace: "../../shelf" })).toBe(path.join(path.sep, "work", "shelf"));
  });

  it("a <repository>:<path> a write cited links to the editor when the file is on this machine (the page's mentions)", async () => {
    const ws = await newWorkspace();
    createCard(ws.ctx, "robin", { type: "task", title: "A task" });
    addComment(ws.ctx, 1, { as: "claude", body: `Read ${ws.workspace}/ledgerbook-rebuild/docs/x.md:2 and ${ws.workspace}/ledgerbook-rebuild/README.md; not ${ws.workspace}/ledgerbook-rebuild/docs/gone.md.` });
    const mentions = cardDetail(ws.ctx, editorInfo(ws.root, workspaceOf(ws.root, readBoardConfig(ws.dir).config)), 1).mentions;
    const x = path.join(ws.workspace, "ledgerbook-rebuild", "docs", "x.md");
    expect(mentions["ledgerbook-rebuild:docs/x.md:2"]).toEqual({ path: x, line: 2, kind: "path", href: vscodeHref(x, 2) });
    // A file at the top of the repository, written bare in the text, is a mention too.
    expect(mentions["ledgerbook-rebuild:README.md"]).toEqual({ path: path.join(ws.workspace, "ledgerbook-rebuild", "README.md"), kind: "path", href: vscodeHref(path.join(ws.workspace, "ledgerbook-rebuild", "README.md")) });
    expect(mentions["ledgerbook-rebuild:docs/gone.md"]).toBeUndefined();
  });

  it("the commands say each rewrite, a line each; --rewrite-paths writes a home path as <home>/…", async () => {
    const ws = await newWorkspace();
    const lines: string[] = [];
    const said = (): string => lines.splice(0).join("\n");
    const deps: BoardCliDependencies = { cwd: () => ws.root, output: (line) => lines.push(line), now: () => new Date("2026-10-04T10:00:00Z"), home: ws.home };
    expect(await runBoardNew({ as: "claude", type: "task", title: "A task", body: `See ${ws.workspace}/ledgerbook-rebuild/docs/x.md` }, deps)).toBe(0);
    expect(said()).toBe("Created #1 (task) in Inbox: A task\ndocs/codelead/board/items/0001-a-task.md\na path of this machine is written as ledgerbook-rebuild:docs/x.md");
    expect(await runBoardReply("1", { as: "claude", text: `Also ${ws.root}/docs/plan.md and ${ws.workspace}/ledgerbook-rebuild/README.md` }, deps)).toBe(0);
    expect(said()).toBe(
      "Commented on #1 as claude (2026-10-04T10:00:00Z).\na path of this machine is written as docs/plan.md\na path of this machine is written as ledgerbook-rebuild:README.md"
    );
    expect(await runBoardReply("1", { as: "claude", text: "Plain words." }, deps)).toBe(0);
    expect(said()).toBe("Commented on #1 as claude (2026-10-04T10:00:00Z).");
    expect(await runBoardReply("1", { as: "claude", text: `And ${ws.home}/Downloads/notes.txt` }, deps)).toBe(1);
    expect(said()).toBe(
      "Refused: the comment holds a path of this machine outside the workspace (under the home folder); nothing was written. Cite the file by its path in a repository of the workspace instead, or give --rewrite-paths to write it as <home>/…."
    );
    expect(await runBoardReply("1", { as: "claude", text: `And ${ws.home}/Downloads/notes.txt`, rewritePaths: true }, deps)).toBe(0);
    expect(said()).toBe("Commented on #1 as claude (2026-10-04T10:00:00Z).\na path of this machine is written as <home>/Downloads/notes.txt");
    expect(await runBoardSet("1", { as: "claude", status: `on ${ws.root}/docs/plan.md` }, deps)).toBe(0);
    expect(said().split("\n").at(-1)).toBe("a path of this machine is written as docs/plan.md");
    expect(await runBoardMove("1", { as: "claude", to: "for-review", comment: `See ${ws.workspace}/ledgerbook-rebuild/docs/x.md` }, deps)).toBe(0);
    expect(said()).toBe("Moved #1 from Inbox to For review, with the comment.\na path of this machine is written as ledgerbook-rebuild:docs/x.md");
    // With --json, the rewrites are listed beside the card and the events.
    expect(await runBoardReply("1", { as: "claude", text: `Once more ${ws.root}/docs/plan.md`, json: true }, deps)).toBe(0);
    const answer = JSON.parse(said()) as { rewritten: string[]; events: Array<{ data: { rewritten: string[] } }> };
    expect([answer.rewritten, answer.events[0]!.data.rewritten]).toEqual([["docs/plan.md"], ["docs/plan.md"]]);
    // The option is on every command that writes a card's text.
    const commands = createBoardCommand().commands;
    for (const name of ["new", "reply", "set", "move"]) {
      expect(commands.find((command) => command.name() === name)?.options.find((option) => option.long === "--rewrite-paths")?.attributeName(), name).toBe("rewritePaths");
    }
  });
});
