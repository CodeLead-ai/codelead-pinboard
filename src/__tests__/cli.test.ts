import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBoardCommand,
  runBoardCheck,
  runBoardInit,
  tellTheAgent,
  runBoardList,
  runBoardMove,
  runBoardNew,
  runBoardReply,
  runBoardSet,
  runBoardShow,
  runBoardValidate,
  type BoardCliDependencies
} from "../cli/board.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Terminal {
  root: string;
  dir: string;
  lines: string[];
  deps: BoardCliDependencies;
  tick: (seconds?: number) => void;
  /** What the last command printed, and empties the record. */
  said: () => string;
}

/** A repository of the test's own (a .git folder is what makes it one) and a terminal in it. */
async function terminal(): Promise<Terminal> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pinboard-cli-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, "src", "deep"), { recursive: true });
  let time = Date.parse("2026-10-04T10:00:00Z");
  const lines: string[] = [];
  return {
    root,
    dir: path.join(root, "docs", "codelead", "board"),
    lines,
    deps: { cwd: () => path.join(root, "src", "deep"), output: (line) => lines.push(line), now: () => new Date(time), home: "/home/tester" },
    tick: (seconds = 60) => {
      time += seconds * 1000;
    },
    said: () => lines.splice(0).join("\n")
  };
}

async function initialized(): Promise<Terminal> {
  const term = await terminal();
  expect(await runBoardInit({ name: "test-workspace", person: ["robin:Robin"], agent: ["claude:Claude Code"] }, term.deps)).toBe(0);
  term.said();
  return term;
}

describe("codelead board, command by command, through each command's function", () => {
  it("init creates the board of the repository it runs in, wherever in it, and refuses a second one", async () => {
    const term = await terminal();
    expect(await runBoardInit({ name: "test-workspace", person: ["robin:Robin"], agent: ["claude:Claude Code"] }, term.deps)).toBe(0);
    expect(term.said()).toBe(
      [
        "Board created in ../../docs/codelead/board: board.json, AGENTS.md, events.jsonl, .gitignore, items/, cursors/.",
        "Participants: robin (person), claude (agent). Agents read ../../docs/codelead/board/AGENTS.md.",
        "",
        "Tell the agent, once, in the file it reads at the start of every session (CLAUDE.md, a root AGENTS.md or the like):",
        "  This repository has a Pinboard in docs/codelead/board. Read docs/codelead/board/AGENTS.md once per session, take part as `claude`, and run `codelead board check --as claude` at the start of the session and whenever asked; check again every 30 minutes while the session runs where you have a timer (Claude Code: `/loop 30m codelead board check --as claude`).",
        'Before that file says it, the first session starts with one sentence to the agent: "Read docs/codelead/board/AGENTS.md and check the board as claude."'
      ].join("\n")
    );
    // The words name the command the person typed (the host's), and with two agents each is named.
    expect(tellTheAgent("docs/codelead/board", [{ id: "claude", name: "Claude Code" }, { id: "codex", name: "Codex" }], 20, "pinboard")).toEqual({
      paragraph: "This repository has a Pinboard in docs/codelead/board. Read docs/codelead/board/AGENTS.md once per session, take part under your own id (`claude` for Claude Code, `codex` for Codex), and run `pinboard check --as <you>` at the start of the session and whenever asked; check again every 20 minutes while the session runs where you have a timer (Claude Code: `/loop 20m pinboard check --as <you>`).",
      firstSentence: "Read docs/codelead/board/AGENTS.md and check the board under your own id."
    });
    expect(fs.readdirSync(term.dir).sort()).toEqual([".gitignore", "AGENTS.md", "board.json", "cursors", "events.jsonl", "items"]);
    expect(JSON.parse(fs.readFileSync(path.join(term.dir, "board.json"), "utf8"))).toMatchObject({ name: "test-workspace", check: { intervalMinutes: 30 }, nextId: 1 });
    const guide = fs.readFileSync(path.join(term.dir, "AGENTS.md"), "utf8");
    expect(guide).toContain("- You may move a card into Inbox, Backlog, Ideas, In progress (only when the person asked for\n  the work in the session) and For review; add tags and relations; create cards.");
    expect(guide).toContain("- Move a card into Pinned or Done: those columns are the person's.");
    // About forty lines (the design); the mention rule (card #48) added its two sentences, the decision in the fields its two,
    // the conversation into cards (card #66) its four.
    // ... and the timer sentence of the check (the kick-off, 2026-11-03) its three.
    expect(guide).toContain("The check every 30 minutes needs a timer you do not have by yourself");
    expect(guide.split("\n").length).toBeLessThanOrEqual(65);
    expect(fs.readFileSync(path.join(term.dir, ".gitignore"), "utf8")).toBe("cursors/\n.board.lock\nprivate-names.txt\n.*.tmp\n");
    expect(await runBoardInit({}, term.deps)).toBe(1);
    expect(term.said()).toBe(`A board is already at ${term.dir} (board.json is there); nothing was written.`);
  });

  it("every command but init says so when there is no board, and exits 2", async () => {
    const term = await terminal();
    expect(await runBoardCheck({}, term.deps)).toBe(2);
    expect(term.said()).toBe(`No board at ${term.dir} (no board.json there). Run \`codelead board init\` in the repository first.`);
    expect(await runBoardValidate({}, term.deps)).toBe(2);
    expect(fs.existsSync(term.dir)).toBe(false);
  });

  it("new, check, list and show: a card made, seen once, listed in its column, shown whole", async () => {
    const term = await initialized();
    expect(await runBoardCheck({ as: "claude" }, term.deps)).toBe(0);
    expect(term.said()).toBe("claude: nothing new since the board began (no cursor yet). Next check in 30 minutes.");

    fs.writeFileSync(path.join(term.root, "body.md"), "Quote AGENTS.md rather than restating it.\n");
    expect(await runBoardNew({ as: "robin", type: "task", title: "Write the skill", tag: ["repo:codelead"], bodyFile: "../../body.md" }, term.deps)).toBe(0);
    expect(term.said()).toBe("Created #1 (task) in Inbox: Write the skill\n../../docs/codelead/board/items/0001-write-the-skill.md");

    expect(await runBoardCheck({ as: "claude" }, term.deps)).toBe(0);
    expect(term.said()).toBe(
      [
        "claude: 1 new on 1 card since the board began (no cursor yet).",
        "",
        "#1 Write the skill  (task · Inbox)",
        "  robin · 2026-10-04T10:00:00Z  created it (task in Inbox)",
        "",
        "Run again with --ack once these are dealt with. Next check in 30 minutes."
      ].join("\n")
    );
    expect(await runBoardCheck({ as: "claude", ack: true }, term.deps)).toBe(0);
    expect(term.said().split("\n").at(-1)).toBe("Cursor moved to the end of the log (1 line). Next check in 30 minutes.");
    expect(await runBoardCheck({ as: "claude" }, term.deps)).toBe(0);
    expect(term.said()).toBe("claude: nothing new since 2026-10-04T10:00:00Z. Next check in 30 minutes.");

    expect(await runBoardList({}, term.deps)).toBe(0);
    expect(term.said()).toBe(["Inbox (1)", "  #1    task     Write the skill  [repo:codelead, by:robin]", "Backlog (0)", "Ideas (0)", "Pinned (0)", "In progress (0)", "For review (0)", "Done (0)"].join("\n"));
    expect(await runBoardList({ tag: ["w5"] }, term.deps)).toBe(0);
    expect(term.said().split("\n")[0]).toBe("Inbox (0 of 1)");
    expect(await runBoardList({ repo: "codelead", json: true }, term.deps)).toBe(0);
    expect(JSON.parse(term.said()).columns[0]).toEqual({ id: "inbox", name: "Inbox", total: 1, cards: [{ id: 1, type: "task", title: "Write the skill", column: "inbox", tags: ["repo:codelead", "by:robin"], updated: "2026-10-04T10:00:00Z", file: "items/0001-write-the-skill.md" }] });

    expect(await runBoardShow("#1", {}, term.deps)).toBe(0);
    expect(term.said()).toBe(
      [
        "#1 · task · Inbox",
        "Write the skill",
        "tags: repo:codelead, by:robin",
        "by robin · created 2026-10-04T10:00:00Z · updated 2026-10-04T10:00:00Z",
        "file: items/0001-write-the-skill.md",
        "",
        "Quote AGENTS.md rather than restating it.",
        "",
        "Thread (0)"
      ].join("\n")
    );
    expect(await runBoardShow("7", {}, term.deps)).toBe(2);
    expect(term.said()).toBe("No card #7 on the board.");
    expect(await runBoardShow("seven!", {}, term.deps)).toBe(2);
    expect(term.said()).toBe('"seven!" is not a card id (42 or #42).');
  });

  it("reply, move and set: each change written with its event, in plain words; --json gives the card and the events", async () => {
    const term = await initialized();
    await runBoardNew({ as: "robin", type: "task", title: "One" }, term.deps);
    await runBoardNew({ as: "claude", type: "idea", title: "Two", relate: ["related:1"] }, term.deps);
    term.said();
    term.tick();

    expect(await runBoardReply("1", { as: "claude", text: "Done: abc1234, evidence record ev-12." }, term.deps)).toBe(0);
    expect(term.said()).toBe("Commented on #1 as claude (2026-10-04T10:01:00Z).");
    fs.writeFileSync(path.join(term.root, "reply.md"), "From a file.\n");
    expect(await runBoardReply("1", { as: "robin", file: "../../reply.md", json: true }, term.deps)).toBe(0);
    expect(JSON.parse(term.said()).events).toEqual([{ at: "2026-10-04T10:01:00Z", by: "robin", item: 1, kind: "comment.added", data: { excerpt: "From a file." } }]);
    expect(await runBoardReply("1", { as: "robin" }, term.deps)).toBe(2);
    expect(term.said()).toBe("reply needs the comment: --text <markdown> or --file <path> (one of them).");

    expect(await runBoardMove("1", { as: "claude", to: "for-review", comment: "Landed; for your review." }, term.deps)).toBe(0);
    expect(term.said()).toBe("Moved #1 from Inbox to For review, with the comment.");
    expect(await runBoardMove("1", { as: "claude", to: "For review" }, term.deps)).toBe(0);
    expect(term.said()).toBe("#1 is already in For review; nothing was written.");
    expect(await runBoardMove("1", { as: "claude", to: "done" }, term.deps)).toBe(1);
    expect(term.said()).toBe(
      "Refused: claude is an agent and may not move a card into Done (a person's column); an agent may move a card into Inbox, Backlog, Ideas, In progress, For review. Nothing was written."
    );
    expect(await runBoardMove("1", { as: "claude" }, term.deps)).toBe(2);
    expect(term.said()).toBe("move needs --to <column>.");

    expect(await runBoardSet("1", { as: "claude", tag: ["w5"], relate: ["blocks:2"], status: "waiting on Robin's review" }, term.deps)).toBe(0);
    expect(term.said()).toBe("#1: changed its status; tagged it w5; related it: blocks #2.");
    expect(await runBoardSet("1", { as: "claude", untag: ["w5"], unrelate: ["blocks:2"], status: "" }, term.deps)).toBe(0);
    expect(term.said()).toBe("#1: changed its status; removed the tag w5; removed the relation blocks #2.");
    expect(await runBoardSet("1", { as: "claude", tag: ["by:robin"] }, term.deps)).toBe(0);
    expect(term.said()).toBe("Nothing to change on #1; nothing was written.");
    expect(await runBoardSet("1", { as: "claude" }, term.deps)).toBe(2);
    expect(term.said()).toBe("set needs something to change: --tag, --untag, --relate, --unrelate, --status, --color, --field or --unset-field.");
    expect(await runBoardSet("1", { as: "claude", relate: ["blocks"] }, term.deps)).toBe(2);
    expect(term.said()).toBe('"blocks" is not a relation; write <kind>:<card id>, for example child-of:7.');

    expect(await runBoardShow("1", { as: "robin" }, term.deps)).toBe(0);
    const shown = term.said();
    expect(shown).toContain("relations:\n  related #2 (Inbox) Two  (stated by #2)");
    expect(shown).toContain("Thread (3)\n\n### claude · 2026-10-04T10:01:00Z\nDone: abc1234, evidence record ev-12.");
    // Robin opened card 1 with --as: its events are seen; card 2's creation by claude is still news to him.
    expect(await runBoardCheck({ as: "robin" }, term.deps)).toBe(0);
    expect(term.said().split("\n")[0]).toBe("robin: 1 new on 1 card since the board began (no cursor yet).");
  });

  it("refuses in the rules' own words, with exit 1, and a stale write is caught with --if-updated", async () => {
    const term = await initialized();
    await runBoardNew({ as: "robin", type: "task", title: "One" }, term.deps);
    term.said();
    expect(await runBoardNew({ as: "claude", type: "task", title: "Pin me", column: "pinned" }, term.deps)).toBe(1);
    expect(term.said()).toBe(
      "Refused: claude is an agent and may not create a card in Pinned (a person's column); an agent may create a card in Inbox, Backlog, Ideas, In progress, For review. Nothing was written."
    );
    expect(await runBoardNew({ type: "task", title: "Who?" }, term.deps)).toBe(2);
    expect(term.said()).toBe("new needs --as <participant>: who creates the card.");
    expect(await runBoardReply("1", { as: "claude", text: "token: Bearer abcdefghijklmnopqrstuvwxyz0123" }, term.deps)).toBe(1);
    expect(term.said()).toBe(
      "Refused: the comment looks like it holds a secret (a key, a connection-string password or a bearer token); nothing was written. Leave the secret out and say where it is kept instead."
    );
    expect(await runBoardReply("1", { as: "claude", text: "Late.", ifUpdated: "2026-10-04T09:00:00Z", json: true }, term.deps)).toBe(1);
    expect(JSON.parse(term.said())).toEqual({
      refused: "stale",
      message: "Refused: card #1 changed since it was read (its updated is 2026-10-04T10:00:00Z; the write expected 2026-10-04T09:00:00Z); nothing was written. Read the card again and redo the change."
    });
  });

  it("validate: exit 0 on a sound board, exit 1 with every problem named", async () => {
    const term = await initialized();
    await runBoardNew({ as: "robin", type: "task", title: "One" }, term.deps);
    await runBoardCheck({ as: "claude", ack: true }, term.deps);
    term.said();
    expect(await runBoardValidate({}, term.deps)).toBe(0);
    expect(term.said()).toBe("The board is valid: 1 card, 1 event, 1 cursor.");
    const file = path.join(term.dir, "items", "0001-one.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("column: inbox", "column: later"));
    expect(await runBoardValidate({}, term.deps)).toBe(1);
    expect(term.said()).toBe(
      "The board has 1 problem (1 card, 1 event, 1 cursor):\n  items/0001-one.md: the column \"later\" is not a column of the board (inbox, backlog, ideas, pinned, in-progress, for-review, done)"
    );
  });

  it("parses the command line into each command's options (repeatable flags collected) and sets the exit code", async () => {
    const term = await initialized();
    await runBoardNew({ as: "robin", type: "task", title: "One", tag: ["a", "b"] }, term.deps);
    term.said();
    const exit = process.exitCode;
    const said = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.exitCode = 0;
      await createBoardCommand().parseAsync(["list", "--board", term.dir, "--tag", "a", "--tag", "b", "--json"], { from: "user" });
      expect(process.exitCode).toBe(0);
      expect(JSON.parse(String(said.mock.calls[0]![0])).columns[0].cards.map((card: { id: number }) => card.id)).toEqual([1]);
      await createBoardCommand().parseAsync(["move", "1", "--board", term.dir, "--to", "done", "--as", "claude"], { from: "user" });
      expect(process.exitCode).toBe(1);
      expect(createBoardCommand().commands.map((command) => command.name())).toEqual(["init", "check", "list", "show", "new", "reply", "move", "set", "validate", "import", "tidy", "serve"]);
    } finally {
      said.mockRestore();
      process.exitCode = exit;
    }
  });
});
