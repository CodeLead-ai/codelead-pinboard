import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBoardCommand,
  runBoardAddReady,
  runBoardArchive,
  runBoardCheck,
  runBoardInit,
  runBoardMove,
  runBoardNew,
  runBoardRelease,
  runBoardRenew,
  runBoardReply,
  runBoardScheduleAdd,
  runBoardSchedules,
  runBoardSchedulesRun,
  runBoardSet,
  runBoardShow,
  runBoardTake,
  runBoardValidate,
  type BoardCliDependencies
} from "../cli/board.js";
import {
  agentsGuide,
  BoardRefusal,
  boardContext,
  createCard,
  defaultBoardConfig,
  exitCodeOfRefusal,
  findUnsafe,
  getCard,
  readEvents,
  REFUSAL_CODES,
  type BoardContext,
  type SanitizerFactory
} from "../core/index.js";
import { projectEntries } from "../page/src/projects.mjs";
import { createBoardServer, type WritePayload } from "../server/index.js";

/**
 * The differences a writer of the documentation found between the package and its own text, each
 * closed: the guide's rules the commands now enforce, a home-relative path, one JSON document from
 * `init --json`, one meaning per exit code, the help of `init` and `import`, the words a person
 * reads, `set` as the page's edit of a card, and the README's cursor and open cards.
 */
const README = fs.readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function temporary(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

interface Terminal {
  home: string;
  root: string;
  dir: string;
  ctx: BoardContext;
  deps: BoardCliDependencies;
  /** What the last commands printed, and empties the record. */
  said: () => string;
  tick: () => void;
  /** Sets the clock to a time (a schedule's Monday). */
  at: (iso: string) => void;
  files: () => string[];
}

/**
 * A home folder of the test's own, holding `notes/` and the workspace `work/` with two
 * repositories, `app` (the board's) and `other`; a terminal in `app`, its board made by `init` with
 * a person, an agent and CodeLead.
 */
async function terminal(): Promise<Terminal> {
  const home = await temporary("pinboard-documented-");
  const root = path.join(home, "work", "app");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.mkdirSync(path.join(home, "work", "other"), { recursive: true });
  fs.mkdirSync(path.join(home, "notes"), { recursive: true });
  let time = Date.parse("2026-11-20T09:00:00Z");
  const now = (): Date => new Date(time);
  const lines: string[] = [];
  const deps: BoardCliDependencies = { cwd: () => root, output: (line) => lines.push(line), now, home };
  expect(await runBoardInit({ name: "test-workspace", person: ["robin:Robin"], agent: ["claude:Claude Code", "codelead:CodeLead"] }, deps)).toBe(0);
  lines.splice(0);
  const dir = path.join(root, "docs", "codelead", "board");
  return {
    home,
    root,
    dir,
    ctx: boardContext({ dir, root, home, now }),
    deps,
    said: () => lines.splice(0).join("\n"),
    tick: () => {
      time += 60_000;
    },
    at: (iso) => {
      time = Date.parse(iso);
    },
    files: () => fs.readdirSync(path.join(dir, "items")).sort()
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

/** The page's process on the board, answering on a free port of 127.0.0.1; closed after the test. */
async function page(term: Terminal): Promise<<T>(method: string, route: string, body?: unknown) => Promise<{ status: number; body: T }>> {
  const pageDir = path.join(term.home, "page");
  fs.mkdirSync(pageDir, { recursive: true });
  fs.writeFileSync(path.join(pageDir, "index.html"), '<!doctype html><html><body><div id="root"></div></body></html>');
  const server = createBoardServer({ dir: term.dir, root: term.root, home: term.home, now: () => new Date("2026-11-20T10:00:00Z"), pageDir, watch: false, log: () => undefined });
  const { url } = await server.listen(0);
  cleanups.push(() => server.close());
  return async <T>(method: string, route: string, body?: unknown) => {
    const response = await fetch(new URL(route, url), { method, headers: { "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text) as T };
  };
}

const QUEUE_REFUSED = "Refused: claude is an agent and may not tag a card for:codelead: the person queues a card for CodeLead; ask in the thread. Nothing was written.";
const COLOUR_REFUSED = "Refused: claude is an agent and may not set a card's colour: the colour is the person's own mark. Nothing was written.";
const INTO = (column: string): string =>
  `Refused: claude is an agent and may not move a card into ${column} (a person's column); an agent may move a card into Inbox, Backlog, Ideas, In progress, For review. Nothing was written.`;

// ---------------------------------------------------------------------------------------------

describe("the guide's rules: the tag and the colour refused by the commands (exit 1, the reason and the way out); the move out of Pinned a convention", () => {
  it("an agent does not tag a card for:codelead; CodeLead itself and the person do, the page's Send to CodeLead included", async () => {
    const term = await terminal();
    await runBoardNew({ as: "robin", type: "task", title: "One" }, term.deps);
    await runBoardNew({ as: "robin", type: "task", title: "Two" }, term.deps);
    term.said();
    const before = fs.readFileSync(path.join(term.dir, "items", "0001-one.md"), "utf8");
    const log = readEvents(term.dir).count;

    expect(await runBoardSet("1", { as: "claude", tag: ["for:codelead"] }, term.deps)).toBe(1);
    expect(term.said()).toBe(QUEUE_REFUSED);
    expect(await runBoardSet("1", { as: "claude", tag: ["area:auth", "For:CodeLead"], json: true }, term.deps)).toBe(1);
    expect(JSON.parse(term.said())).toEqual({ refused: "not-allowed", message: QUEUE_REFUSED });
    expect(await runBoardSet(["1", "2"], { as: "claude", tag: ["for:codelead"] }, term.deps)).toBe(1);
    expect(term.said()).toBe(["Changed (0 changed, 2 refused):", `  #1 refused: ${QUEUE_REFUSED}`, `  #2 refused: ${QUEUE_REFUSED}`].join("\n"));
    expect(await runBoardNew({ as: "claude", type: "task", title: "Queued by me", tag: ["for:codelead"] }, term.deps)).toBe(1);
    expect(term.said()).toBe(QUEUE_REFUSED);
    // A batch: a card's own tags, and the command's --tag for every card.
    fs.writeFileSync(path.join(term.root, "cards.md"), "## Queued\n\n```yaml\ntype: task\ntags: [for:codelead]\n```\n\nFrom a file.\n");
    expect(await runBoardNew({ as: "claude", batch: "cards.md" }, term.deps)).toBe(1);
    expect(term.said()).toBe(`Refused: the card "## Queued" (line 1 of cards.md): ${QUEUE_REFUSED.replace(/^Refused: /, "")}`);
    fs.writeFileSync(path.join(term.root, "plain.md"), "## Plain\n\n```yaml\ntype: task\n```\n\nFrom a file.\n");
    expect(await runBoardNew({ as: "claude", batch: "plain.md", tag: ["for:codelead"] }, term.deps)).toBe(1);
    term.said();
    expect(term.files()).toEqual(["0001-one.md", "0002-two.md"]);
    expect(fs.readFileSync(path.join(term.dir, "items", "0001-one.md"), "utf8")).toBe(before);
    expect(readEvents(term.dir).count).toBe(log);

    // CodeLead itself, and the person: as before.
    expect(await runBoardSet("1", { as: "codelead", tag: ["for:codelead"] }, term.deps)).toBe(0);
    expect(term.said()).toBe("#1: tagged it for:codelead.");
    expect(await runBoardNew({ as: "robin", batch: "plain.md", tag: ["for:codelead"] }, term.deps)).toBe(0);
    expect(term.said()).toContain("#3 (task) in Inbox: Plain  [for:codelead, by:robin]");
    // The page writes as the board's person: its Send to CodeLead is the tag, added.
    const call = await page(term);
    const sent = await call<WritePayload>("PUT", "/api/items/2", { changes: { addTags: ["for:codelead"] } });
    expect(sent.status).toBe(200);
    expect(sent.body.card.card.tags).toContain("for:codelead");
  });

  it("an agent does not set a card's colour, the person's own mark", async () => {
    const term = await terminal();
    await runBoardNew({ as: "robin", type: "task", title: "One" }, term.deps);
    term.said();
    expect(await runBoardSet("1", { as: "claude", color: "red" }, term.deps)).toBe(1);
    expect(term.said()).toBe(COLOUR_REFUSED);
    expect(await runBoardSet("1", { as: "claude", color: "none", json: true }, term.deps)).toBe(1);
    expect(JSON.parse(term.said())).toEqual({ refused: "not-allowed", message: COLOUR_REFUSED });
    expect(refusal(() => createCard(term.ctx, "claude", { type: "task", title: "Marked", color: "blue" })).message).toBe(COLOUR_REFUSED);
    expect(await runBoardSet("1", { as: "robin", color: "red" }, term.deps)).toBe(0);
    expect(getCard(term.ctx, 1).card.color).toBe("#b33f40");
  });

  it("on purpose, an agent's move out of Pinned or Done is not refused (a convention, as the move into In progress): only a move into them is", async () => {
    // The work flow needs it: the person pins a card, asks for it in the session, and the agent's first step moves it to In progress.
    const term = await terminal();
    await runBoardNew({ as: "robin", type: "task", title: "Pinned one", column: "pinned" }, term.deps);
    await runBoardNew({ as: "robin", type: "task", title: "Done one", column: "done" }, term.deps);
    term.said();
    term.tick();
    expect(await runBoardMove("1", { as: "claude", to: "in-progress" }, term.deps)).toBe(0);
    expect(await runBoardMove("2", { as: "claude", to: "for-review", comment: "Reopened: the person named it in the session." }, term.deps)).toBe(0);
    expect(term.said()).toBe("Moved #1 from Pinned to In progress.\nMoved #2 from Done to For review, with the comment.");
    const moves = readEvents(term.dir).events.map(({ event }) => event).filter((event) => event.kind === "item.moved");
    expect(moves.map((event) => [event.by, event.item, event.data?.from, event.data?.to])).toEqual([
      ["claude", 1, "pinned", "in-progress"],
      ["claude", 2, "done", "for-review"]
    ]);

    // A move into a person's column by an agent: refused, as on main.
    expect(await runBoardMove("1", { as: "claude", to: "pinned" }, term.deps)).toBe(1);
    expect(term.said()).toBe(INTO("Pinned"));
    expect(await runBoardMove("2", { as: "claude", to: "done", json: true }, term.deps)).toBe(1);
    expect(JSON.parse(term.said())).toEqual({ refused: "column", message: INTO("Done") });
    expect(getCard(term.ctx, 1).card.column).toBe("in-progress");
  });

  it("the guide says, for each of these rules, whether the commands refuse it", () => {
    const config = defaultBoardConfig({ name: "w", participants: [{ id: "robin", kind: "person", name: "Robin" }, { id: "claude", kind: "agent", name: "Claude Code" }, { id: "codelead", kind: "agent", name: "CodeLead" }] });
    const guide = agentsGuide(config).replace(/\n {2}/g, " ");
    expect(guide).toContain("`color` is the person's colour mark: leave it (the commands refuse it from an agent).");
    expect(guide).toContain("write your recommendation in `fields.ask`. The commands refuse it.");
    // The moves out of a person's column and into In progress: conventions, said as such.
    expect(guide).toContain(
      "In progress (only when the person asked for the work in the session) and For review; add tags and relations; create cards. Move a card out of Pinned or Done only when the person asked for it in the session (to start the work the person asked for, or to reopen a card the person named): no command can tell, so that rule, like the one for In progress, is yours to keep."
    );
    expect(guide).not.toContain("Move a card out of Pinned or Done: the commands refuse it");
    expect(guide).toContain("CodeLead moves each card to In progress (out of Pinned too) and keeps the tag.");
    expect(guide).toContain("Agents do not add or remove the tag (the commands refuse an agent's adding it: ask the person in the thread)");
    expect(guide).toContain("The commands refuse such a text, a path that starts with `~/` included.");
  });
});

// ---------------------------------------------------------------------------------------------

describe("a home-relative path is the path of this machine it names", () => {
  it("is refused as the full path is; --rewrite-paths writes it as <home>/…; under the workspace it is cited; an application's ~/ path is kept", async () => {
    const term = await terminal();
    await runBoardNew({ as: "robin", type: "task", title: "One" }, term.deps);
    term.said();
    expect(await runBoardReply("1", { as: "claude", text: `The log is in ${term.home}/notes/log.txt` }, term.deps)).toBe(1);
    const full = term.said();
    expect(full).toMatch(/^Refused: the comment holds a path of this machine outside the workspace \(under the home folder\)/);
    expect(await runBoardReply("1", { as: "claude", text: "The log is in ~/notes/log.txt" }, term.deps)).toBe(1);
    expect(term.said()).toBe(full);
    expect(await runBoardNew({ as: "claude", type: "task", title: "Read ~/notes/log.txt" }, term.deps)).toBe(1);
    expect(term.said()).toMatch(/^Refused: the title holds a path of this machine/);

    expect(await runBoardReply("1", { as: "claude", text: "The log is in ~/notes/log.txt.", rewritePaths: true }, term.deps)).toBe(0);
    expect(term.said()).toBe("Commented on #1 as claude (2026-11-20T09:00:00Z).\na path of this machine is written as <home>/notes/log.txt");
    // Under the workspace: the repository's path, or <repository>:<path>, as for a full path.
    expect(await runBoardReply("1", { as: "claude", text: "See ~/work/app/src/app.ts and `~/work/other/README.md`." }, term.deps)).toBe(0);
    term.said();
    // Not a path of this machine: an application-relative path (the home folder has no Views), a ~ inside a word or an address.
    const kept = 'Response.Redirect("~/Views/Home/Index.cshtml"), a~/b and https://example.com/~/x';
    expect(await runBoardReply("1", { as: "claude", text: kept }, term.deps)).toBe(0);
    expect(getCard(term.ctx, 1).card.thread.map((comment) => comment.body)).toEqual(["The log is in <home>/notes/log.txt.", "See src/app.ts and `other:README.md`.", kept]);

    // A card written by hand with one is a problem validate names.
    const file = path.join(term.dir, "items", "0001-one.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("\n## Thread", "See ~/notes/plan.md.\n\n## Thread"));
    expect(await runBoardValidate({}, term.deps)).toBe(1);
    expect(term.said()).toContain("items/0001-one.md: the description holds a path of this machine");
  });

  it("is read before the host's sanitizer, so a host that knows only the full home path finds it too", async () => {
    const term = await terminal();
    // A host's sanitizer as CodeLead's audit pack writes one: the full home path becomes <home>; it knows nothing of ~.
    const host: SanitizerFactory = (paths) => ({ text: (text) => text.replaceAll(paths.home, "<home>") });
    const scope = { dir: term.dir, root: term.root, home: term.home, sanitizer: host };
    expect(host({ root: term.root, home: term.home }).text("see ~/notes/a.md")).toBe("see ~/notes/a.md");
    expect(findUnsafe(scope, "see ~/notes/a.md", [])).toBe("machine-path");
    expect(findUnsafe(scope, "see ~/Views/a.cshtml", [])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------

describe("init --json prints exactly one JSON document", () => {
  it("through its function and through the command tree, a refusal included", async () => {
    const root = await temporary("pinboard-init-json-");
    fs.mkdirSync(path.join(root, ".git"));
    const lines: string[] = [];
    const deps: BoardCliDependencies = { cwd: () => root, output: (line) => lines.push(line), home: root };
    expect(await runBoardInit({ json: true, person: ["robin:Robin"] }, deps)).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ written: ["board.json", "AGENTS.md", "events.jsonl", ".gitignore", "items/", "cursors/"], tellTheAgent: { paragraph: expect.any(String), firstSentence: expect.any(String) } });

    const other = path.join(root, "second");
    const printed = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exit = process.exitCode;
    try {
      await createBoardCommand().parseAsync(["init", "--json", "--board", other, "--person", "robin:Robin"], { from: "user" });
      expect(process.exitCode).toBe(0);
      expect(printed).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(printed.mock.calls[0]![0]))).toMatchObject({ dir: other });
      await createBoardCommand().parseAsync(["init", "--json", "--board", other], { from: "user" });
      expect(process.exitCode).toBe(1);
      expect(printed).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(printed.mock.calls[1]![0]))).toEqual({ refused: "board-exists", message: `A board is already at ${other} (board.json is there); nothing was written.` });
    } finally {
      process.exitCode = exit;
    }
  });
});

// ---------------------------------------------------------------------------------------------

/** The README's table of refusals: each code it lists, with the exit it gives it. */
function readmeExits(): Map<string, number> {
  const section = README.slice(README.indexOf("### Exit codes"), README.indexOf("\n## ", README.indexOf("### Exit codes")));
  const exits = new Map<string, number>();
  for (const match of section.matchAll(/^\| `([a-z-]+)` \| (\d) \|/gm)) exits.set(match[1]!, Number(match[2]));
  return exits;
}

describe("exit codes: 1 when a rule of the board refused the write, 2 when the command cannot run as written", () => {
  it("the README lists every refusal code with the exit the commands give it", () => {
    const exits = readmeExits();
    expect([...exits.keys()].sort()).toEqual([...REFUSAL_CODES].sort());
    for (const code of REFUSAL_CODES) expect(exits.get(code), code).toBe(exitCodeOfRefusal(code));
  });

  it("each class, through the commands, with its code in --json", async () => {
    const term = await terminal();
    await runBoardNew({ as: "robin", type: "task", title: "One" }, term.deps);
    await runBoardNew({ as: "robin", type: "decision", title: "Two" }, term.deps);
    term.said();
    const cases: Array<[string, () => Promise<number>, number, string]> = [
      ["an agent setting a decision", () => runBoardSet("2", { as: "claude", field: ["decided=Yes"], json: true }, term.deps), 1, "decision"],
      ["a colour that is none of the five", () => runBoardSet("1", { as: "robin", color: "purple", json: true }, term.deps), 1, "color"],
      ["a card related to itself", () => runBoardSet("1", { as: "robin", relate: ["related:1"], json: true }, term.deps), 1, "relation"],
      ["an empty comment", () => runBoardReply("1", { as: "robin", text: "   ", json: true }, term.deps), 1, "text"],
      ["no such column", () => runBoardMove("1", { as: "robin", to: "later", json: true }, term.deps), 1, "column"],
      ["no such type", () => runBoardSet("1", { as: "robin", type: "epic", json: true }, term.deps), 1, "type"],
      ["an agent archiving", () => runBoardArchive("1", { as: "claude", json: true }, term.deps), 1, "not-allowed"],
      ["no such participant", () => runBoardReply("1", { as: "ghost", text: "Hi", json: true }, term.deps), 1, "participant"],
      ["a secret", () => runBoardReply("1", { as: "robin", text: "Password=s3cretpassw0rd;", json: true }, term.deps), 1, "secret"],
      ["a missing --as", () => runBoardReply("1", { text: "Hi", json: true }, term.deps), 2, "usage"],
      ["a relation that is not <kind>:<id>", () => runBoardSet("1", { as: "robin", relate: ["blocks"], json: true }, term.deps), 2, "usage"],
      ["a title for several cards", () => runBoardSet(["1", "2"], { as: "robin", title: "Same", json: true }, term.deps), 2, "usage"],
      ["no such card", () => runBoardShow("99", { json: true }, term.deps), 2, "not-found"],
      ["a relation to no card", () => runBoardSet("1", { as: "robin", relate: ["related:99"], json: true }, term.deps), 2, "not-found"]
    ];
    for (const [what, command, exit, code] of cases) {
      expect(await command(), what).toBe(exit);
      expect(JSON.parse(term.said()).refused, what).toBe(code);
    }
    const empty = await temporary("pinboard-no-board-");
    const lines: string[] = [];
    expect(await runBoardCheck({ json: true }, { cwd: () => empty, output: (line) => lines.push(line) })).toBe(2);
    expect(JSON.parse(lines[0]!).refused).toBe("no-board");
  });

  it("the parser's own refusals exit 2, after its words; help exits 0", async () => {
    class Exited extends Error {
      public constructor(public readonly code: number) {
        super(`exit ${code}`);
      }
    }
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Exited(code ?? 0);
    }) as never);
    const errors = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exitOf = async (args: string[]): Promise<number> => {
      try {
        await createBoardCommand({ name: "pinboard" }).parseAsync(args, { from: "user" });
      } catch (error) {
        if (error instanceof Exited) return error.code;
        throw error;
      }
      return -1;
    };
    expect(await exitOf(["set", "1", "--no-such-option"])).toBe(2);
    expect(String(errors.mock.calls.at(-1)?.[0])).toContain("unknown option '--no-such-option'");
    expect(await exitOf(["show"])).toBe(2);
    expect(String(errors.mock.calls.at(-1)?.[0])).toContain("missing required argument 'id'");
    expect(await exitOf(["no-such-command"])).toBe(2);
    expect(await exitOf(["show", "--help"])).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe("the help of init and import", () => {
  it("init --help lists every file init writes, .gitignore included, in the order init says them", async () => {
    const term = await terminal();
    const written = fs.readdirSync(term.dir);
    const init = createBoardCommand().commands.find((command) => command.name() === "init")!;
    const listed = init.description().split(": ")[1]!.split(", ");
    expect(listed).toEqual(["board.json", "AGENTS.md", "events.jsonl", ".gitignore", "items/", "cursors/"]);
    expect(listed.map((name) => name.replace(/\/$/, "")).sort()).toEqual(written.sort());
    expect(README).toContain("| `init` | Creates the board folder: `board.json`, `AGENTS.md`, `events.jsonl`, `.gitignore`, `items/`, `cursors/`. |");
  });
});

// ---------------------------------------------------------------------------------------------

describe("the words a person reads", () => {
  it("say each type with its own article, and colour in one spelling (the file's key stays color)", async () => {
    const term = await terminal();
    await runBoardNew({ as: "robin", type: "idea", title: "An idea" }, term.deps);
    await runBoardNew({ as: "robin", type: "task", title: "A task" }, term.deps);
    term.said();
    expect(await runBoardSet("1", { as: "robin", field: ["size=M"] }, term.deps)).toBe(2);
    expect(term.said()).toBe('"size" is not a field of an idea (hypothesis, worthItIf); change the card\'s type first if it should have it.');
    expect(await runBoardSet("2", { as: "robin", field: ["hypothesis=faster"] }, term.deps)).toBe(2);
    expect(term.said()).toBe('"hypothesis" is not a field of a task (definitionOfDone, size, landed); change the card\'s type first if it should have it.');
    fs.writeFileSync(path.join(term.root, "ideas.md"), "## Another idea\n\n```yaml\ntype: idea\nfields: { size: M }\n```\n\nIts words.\n");
    expect(await runBoardNew({ as: "robin", batch: "ideas.md" }, term.deps)).toBe(1);
    expect(term.said()).toBe('Refused: the card "## Another idea" (line 1 of ideas.md): "size" is not a field of an idea (hypothesis, worthItIf). Nothing was written.');

    await runBoardCheck({ as: "claude", ack: true }, term.deps);
    term.said();
    term.tick();
    expect(await runBoardSet("1", { as: "robin", color: "red" }, term.deps)).toBe(0);
    expect(term.said()).toBe("#1: changed its colour.");
    expect(await runBoardCheck({ as: "claude" }, term.deps)).toBe(0);
    expect(term.said()).toContain("robin · 2026-11-20T09:01:00Z  changed its colour");
    expect(readEvents(term.dir).events.at(-1)!.event.data).toEqual({ fields: ["color"] });
    expect(fs.readFileSync(path.join(term.dir, "items", "0001-an-idea.md"), "utf8")).toContain('color: "#b33f40"');
  });
});

// ---------------------------------------------------------------------------------------------

describe("set does what the page's edit of a card does", () => {
  it("--title, --body, --body-file, --type and --attach, each through the page's checks, with the page's events", async () => {
    const term = await terminal();
    await runBoardNew({ as: "robin", type: "task", title: "One" }, term.deps);
    await runBoardNew({ as: "robin", type: "task", title: "Two" }, term.deps);
    term.said();

    expect(await runBoardSet("1", { as: "claude", title: "One, renamed" }, term.deps)).toBe(0);
    expect(term.said()).toBe("#1: changed its title.");
    expect(await runBoardSet("1", { as: "claude", body: "Now for @robin to read." }, term.deps)).toBe(0);
    expect(term.said()).toBe("#1: changed its description.");
    fs.writeFileSync(path.join(term.root, "body.md"), "From a file.\n");
    expect(await runBoardSet("1", { as: "claude", bodyFile: "body.md" }, term.deps)).toBe(0);
    expect(term.said()).toBe("#1: changed its description.");
    expect(await runBoardSet("1", { as: "claude", type: "idea", field: ["hypothesis=It reads faster"] }, term.deps)).toBe(0);
    expect(term.said()).toBe("#1: changed its type, fields.");
    expect(await runBoardSet("1", { as: "claude", attach: ["docs/plan.md:40-60", "other:README.md"] }, term.deps)).toBe(0);
    expect(term.said()).toBe("#1: attached docs/plan.md:40-60; attached other:README.md.");
    const card = getCard(term.ctx, 1).card;
    expect(card).toMatchObject({ title: "One, renamed", type: "idea", description: "From a file.", fields: { hypothesis: "It reads faster" }, attachments: [{ path: "docs/plan.md", lines: "40-60" }, { path: "other:README.md" }] });
    const events = readEvents(term.dir).events.map(({ event }) => event).filter((event) => event.item === 1 && event.by === "claude");
    expect(events.map((event) => [event.kind, event.data])).toEqual([
      ["item.updated", { fields: ["title"] }],
      ["item.updated", { fields: ["description"], addressed: ["robin"] }],
      ["item.updated", { fields: ["description"] }],
      ["item.updated", { fields: ["type", "fields"] }],
      ["attachment.added", { path: "docs/plan.md", lines: "40-60" }],
      ["attachment.added", { path: "other:README.md" }]
    ]);

    // The page's own edit writes the same event.
    const call = await page(term);
    const renamed = await call<WritePayload>("PUT", "/api/items/2", { changes: { title: "Two, renamed" } });
    expect(renamed.body.events.map((event) => [event.kind, event.data])).toEqual([["item.updated", { fields: ["title"] }]]);

    // The checks: one card's text goes with one id; a secret, a type the board has not, a description and a file, refused.
    expect(await runBoardSet(["1", "2"], { as: "robin", body: "Same" }, term.deps)).toBe(2);
    expect(term.said()).toBe("--body gives one card its description; give it with one id, not several.");
    expect(await runBoardSet("1", { as: "robin", body: "x", bodyFile: "body.md" }, term.deps)).toBe(2);
    expect(term.said()).toBe("set takes --body or --body-file, not both.");
    expect(await runBoardSet("1", { as: "robin", title: "Key sk-ant-api03-abcdef" }, term.deps)).toBe(1);
    expect(term.said()).toMatch(/^Refused: the title looks like it holds a secret/);
    expect(await runBoardSet("1", { as: "robin", type: "epic" }, term.deps)).toBe(1);
    expect(term.said()).toBe('Refused: "epic" is not a card type of the board (question, decision, task, idea, review, note). Nothing was written.');

    // The help and the README say it.
    const help = createBoardCommand().commands.find((command) => command.name() === "set")!.helpInformation();
    for (const option of ["--title <text>", "--body <markdown>", "--body-file <path>", "--type <type>", "--attach <path[:lines]>"]) expect(help).toContain(option);
    expect(README).toContain("Every change the page makes to the board is a command too");
    expect(README).toContain("Two things\nare the page's alone: a card's place inside its column (a drag), and the page's view choices");
    expect(README).not.toContain("Every action of the page is a command");
  });
});

// ---------------------------------------------------------------------------------------------

describe("the README and the guide say what the code does", () => {
  it("a cursor holds seen, lines and opened; a project's open cards are those not archived and not in the last column", async () => {
    const term = await terminal();
    await runBoardNew({ as: "robin", type: "task", title: "One" }, term.deps);
    await runBoardCheck({ as: "claude", ack: true }, term.deps);
    term.tick();
    await runBoardShow("1", { as: "claude" }, term.deps);
    const cursor = JSON.parse(fs.readFileSync(path.join(term.dir, "cursors", "claude.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(cursor).sort()).toEqual(["lines", "opened", "seen"]);
    const example = /### `cursors\/<participant>.json`\n\n```json\n(.*)\n```/.exec(README)![1]!;
    expect(Object.keys(JSON.parse(example) as Record<string, unknown>).sort()).toEqual(["lines", "opened", "seen"]);
    const guide = fs.readFileSync(path.join(term.dir, "AGENTS.md"), "utf8");
    expect(guide).toContain('`{ "seen": "<time>", "lines": 17, "opened": { "42": "<time>" } }`');

    // The selector counts a card as open unless it is archived or in the board's last column.
    expect(projectEntries([{ tags: ["repo:api"], column: "done" }, { tags: ["repo:api"], column: "pinned" }, { tags: ["repo:api"], column: "inbox", archived: "2026-11-20T09:00:00Z" }], "done")).toEqual([
      { name: "", open: 1 },
      { name: "api", open: 1 }
    ]);
    expect(README.replace(/\s+/g, " ")).toContain("how many of its cards are still open: not archived, and not in the board's last column (Done, on a board `init` made)");
  });
});

// ---------------------------------------------------------------------------------------------

describe("the README's section on Ready, run as written", () => {
  /** The README's block of a command's output, from its `$ <command>` line to the next blank line. */
  const printed = (command: string): string => {
    const at = README.indexOf(`$ ${command}\n`);
    expect(at, command).toBeGreaterThan(-1);
    const start = at + command.length + 3;
    return README.slice(start, README.indexOf("\n\n", start) === -1 ? undefined : README.indexOf("\n\n", start)).replace(/\n```$/, "");
  };

  it("is where a person looks for how to hand a card to an agent, with the three fields and one real card", async () => {
    expect(README).toContain("### Handing a card to an agent: Ready");
    expect(README.indexOf("### Handing a card to an agent: Ready")).toBeLessThan(README.indexOf("### What happens behind the scenes"));
    for (const row of ["| `definitionOfDone` |", "| `mayTouch` |", "| `limitMinutes`, `limitMoney` |"]) expect(README).toContain(row);

    const term = await terminal();
    await runBoardNew({ as: "robin", type: "task", title: "Add a sign-in page" }, term.deps);
    await runBoardNew({ as: "robin", type: "decision", title: "Pick the session store" }, term.deps);
    await runBoardNew({ as: "claude", type: "task", title: "Rate-limit the sign-in form", column: "backlog", tag: ["area:auth"] }, term.deps);
    term.said();
    expect(await runBoardMove("3", { as: "robin", to: "ready" }, term.deps)).toBe(1);
    expect(term.said()).toBe(printed("pinboard move 3 --to ready --as robin"));
    const done = "Five failed sign-ins in a minute lock the form for ten minutes; npm test passes.";
    expect(await runBoardSet("3", { as: "robin", field: [`definitionOfDone=${done}`, 'mayTouch=["src/auth/", "test/auth.test.ts"]', "limitMinutes=30"] }, term.deps)).toBe(0);
    expect(term.said()).toBe(printed(`pinboard set 3 --as robin --field definitionOfDone="${done}" --field mayTouch='["src/auth/", "test/auth.test.ts"]' --field limitMinutes=30`));
    expect(await runBoardMove("3", { as: "robin", to: "ready" }, term.deps)).toBe(0);
    // The README shows the same command twice: the second time, the move.
    const second = README.indexOf("$ pinboard move 3 --to ready --as robin\n", README.indexOf("$ pinboard move 3 --to ready --as robin\n") + 1);
    expect(README.slice(second).split("\n")[1]).toBe(term.said());
    const file = fs.readFileSync(path.join(term.dir, "items", term.files().find((name) => name.startsWith("0003-"))!), "utf8");
    const fields = /\nfields:\n(?: {2}.*\n)+/.exec(file)![0].trimStart();
    expect(README).toContain(`\`\`\`yaml\n${fields}\`\`\``);

    expect(await runBoardMove("3", { as: "claude", to: "ready" }, term.deps)).toBe(1);
    expect(term.said()).toBe(printed("pinboard move 3 --to ready --as claude"));
    expect(await runBoardMove("3", { as: "claude", to: "in-progress" }, term.deps)).toBe(1);
    expect(term.said()).toBe(printed("pinboard move 3 --to in-progress --as claude").replace(/\n```[\s\S]*$/, ""));
  });

  it("shows how an agent gets its card, works it, renews it and hands it back, as the commands say it", async () => {
    const term = await terminal();
    const deps = { ...term.deps, command: "pinboard" };
    const done = "Five failed sign-ins in a minute lock the form for ten minutes; npm test passes.";
    // The card of the README's run: #3, made by the agent, set and put in Ready by the person.
    await runBoardNew({ as: "robin", type: "task", title: "Add a sign-in page" }, deps);
    await runBoardNew({ as: "robin", type: "decision", title: "Pick the session store" }, deps);
    await runBoardNew({ as: "claude", type: "task", title: "Rate-limit the sign-in form", column: "backlog", tag: ["area:auth"] }, deps);
    await runBoardSet("3", { as: "robin", field: [`definitionOfDone=${done}`, 'mayTouch=["src/auth/", "test/auth.test.ts"]', "limitMinutes=30"] }, deps);
    await runBoardMove("3", { as: "robin", to: "ready" }, deps);
    term.said();
    expect(README).toContain("#### How an agent gets its card: take");

    expect(await runBoardTake({ as: "claude" }, deps)).toBe(0);
    expect(term.said()).toBe(printed("pinboard take --as claude").replace(/\n```[\s\S]*$/, ""));
    const file = fs.readFileSync(path.join(term.dir, "items", term.files().find((name) => name.startsWith("0003-"))!), "utf8");
    const claim = /\nclaim:\n(?: {2}.*\n)+/.exec(file)![0].trimStart();
    expect(README).toContain(`\`\`\`yaml\n${claim}\`\`\``);

    for (let minute = 0; minute < 10; minute += 1) term.tick();
    expect(await runBoardRenew("3", { as: "claude" }, deps)).toBe(0);
    expect(term.said()).toBe(printed("pinboard renew 3 --as claude"));
    expect(await runBoardTake({ as: "claude" }, deps)).toBe(0);
    // The README shows the take twice: the second time, the answer of an agent that holds its card.
    const second = README.indexOf("$ pinboard take --as claude\n", README.indexOf("$ pinboard take --as claude\n") + 1);
    expect(README.slice(second).split("\n")[1]).toBe(term.said());
    const landed = "Landed: 9b1e7d2 on main; src/auth/limit.ts, test/auth.test.ts (4 tests).";
    expect(await runBoardMove("3", { as: "claude", to: "for-review", comment: landed }, deps)).toBe(0);
    expect(term.said()).toBe(printed(`pinboard move 3 --to for-review --as claude --comment "${landed}"`).replace(/\n```[\s\S]*$/, ""));
    expect(getCard(term.ctx, 3).card.claim).toBeUndefined();

    // Instead of the move: the card given back, with the reason.
    await runBoardMove("3", { as: "robin", to: "ready" }, deps);
    await runBoardTake({ as: "claude" }, deps);
    term.said();
    const reason = "The tests need a database this machine does not have.";
    expect(await runBoardRelease("3", { as: "claude", reason }, deps)).toBe(0);
    expect(term.said()).toBe(printed(`pinboard release 3 --as claude --reason "${reason}"`).replace(/\n```[\s\S]*$/, ""));
    expect(getCard(term.ctx, 3).card.thread.at(-1)?.body).toBe(reason);
    // The table of the commands lists the three.
    for (const row of ["| `take --as <agent>` |", "| `renew <id> --as <agent>` |", "| `release <id> --as <agent> --reason <text>` |"]) expect(README).toContain(row);
  });

  it("gives the one command for a board made before Ready, with its words", async () => {
    const term = await terminal();
    // The board as it was made before Ready: board.json without the column, its guide as the package wrote it then.
    const config = JSON.parse(fs.readFileSync(path.join(term.dir, "board.json"), "utf8")) as Parameters<typeof agentsGuide>[0];
    const before = { ...config, columns: config.columns.filter((column) => column.id !== "ready") };
    fs.writeFileSync(path.join(term.dir, "board.json"), `${JSON.stringify(before, null, 2)}\n`);
    fs.writeFileSync(path.join(term.dir, "AGENTS.md"), agentsGuide(before));
    expect(await runBoardAddReady({}, term.deps)).toBe(0);
    expect(term.said()).toBe(printed("pinboard add-ready").replace(/\n```[\s\S]*$/, ""));
    expect(README).toContain("| `add-ready` |");
  });
});

// ---------------------------------------------------------------------------------------------

describe("the README's section on scheduled cards, run as written", () => {
  const section = README.slice(README.indexOf("### Scheduled cards"), README.indexOf("### What happens behind the scenes"));
  /**
   * The section's block of a command's output, the `from`-th time it shows the command (from 0): from
   * its `$ <command>` line to the end of its code block, without the indent of a block in a list.
   */
  const block = (command: string, from = 0): string => {
    let at = -1;
    for (let index = 0; index <= from; index += 1) at = section.indexOf(`$ ${command}\n`, at + 1);
    expect(at, command).toBeGreaterThan(-1);
    const indent = section.slice(section.lastIndexOf("\n", at) + 1, at);
    const start = at + command.length + 3;
    return section
      .slice(start, section.indexOf(`${indent}\`\`\``, start))
      .replace(/\n$/, "")
      .split("\n")
      .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
      .join("\n");
  };

  it("goes from the command that makes the schedule to the card that appears in Ready and is taken, in the commands' own words", async () => {
    expect(README.indexOf("### Scheduled cards")).toBeGreaterThan(README.indexOf("#### How an agent gets its card: take"));
    const term = await terminal();
    const deps = { ...term.deps, command: "pinboard", zone: "Europe/Berlin" };
    // Friday 2026-11-20, 10:00 in Berlin: the schedule is made.
    const done = "npm outdated lists nothing that is safe to update; npm test passes.";
    expect(
      await runBoardScheduleAdd(
        "check-deps",
        { as: "robin", weekly: "mon", at: "09:00", title: "Check the dependencies", body: "Run `npm outdated`; update what is safe.", field: [`definitionOfDone=${done}`, 'mayTouch=["package.json", "package-lock.json"]', "limitMinutes=30"] },
        deps
      )
    ).toBe(0);
    expect(term.said()).toBe(
      block(
        `pinboard schedules add check-deps --as robin --weekly mon --at 09:00 --title "Check the dependencies" --body 'Run \`npm outdated\`; update what is safe.' --field definitionOfDone="${done}" --field mayTouch='["package.json", "package-lock.json"]' --field limitMinutes=30`
      )
    );
    expect(await runBoardSchedules({}, deps)).toBe(0);
    expect(term.said()).toBe(block("pinboard schedules"));
    // Monday 09:00 in Berlin.
    term.at("2026-11-23T08:00:20Z");
    expect(await runBoardSchedulesRun({}, deps)).toBe(0);
    expect(term.said()).toBe(block("pinboard schedules run"));
    const file = fs.readFileSync(path.join(term.dir, "items", term.files()[0]!), "utf8");
    const scheduled = /\nschedule:\n(?: {2}.*\n)+/.exec(file)![0].trimStart();
    expect(section).toContain(`\`\`\`yaml\n${scheduled}\`\`\``);
    expect(file).toContain("\ntags: [scheduled:check-deps]\nauthor: robin\n");
    term.at("2026-11-23T08:05:00Z");
    expect(await runBoardTake({ as: "claude" }, deps)).toBe(0);
    expect(term.said()).toBe(block("pinboard take --as claude"));
    // The next Monday, the card is still in In progress: no new one, and why.
    term.at("2026-11-30T08:00:20Z");
    expect(await runBoardSchedulesRun({}, deps)).toBe(0);
    expect(term.said()).toBe(block("pinboard schedules run", 1));
    expect(getCard(term.ctx, 1).card.column).toBe("in-progress");
    expect(term.files()).toHaveLength(1);
    // The table of the commands lists them.
    for (const row of ["| `schedules` |", "| `schedules add <name> --as <person>` |", "| `schedules change <name> --as <person>` |", "| `schedules pause\\|resume\\|remove <name> --as <person>` |", "| `schedules run` |", "| `schedules/<name>.json` |"]) {
      expect(README).toContain(row);
    }
    // Its one sentence on who runs the schedules, and what becomes of a time missed meanwhile.
    expect(section.replace(/\s+/g, " ")).toContain(
      "**Schedules run only while something calls them:** the page's process (`pinboard serve`, at its start and every minute), a desktop app, or `pinboard schedules run` from your system's own scheduler (cron, launchd, Task Scheduler); a time missed while nothing calls them makes one card at the next call."
    );
  });

  it("says what a board made before schedules, or without Ready, answers", async () => {
    const term = await terminal();
    const deps = { ...term.deps, command: "pinboard", zone: "Europe/Berlin" };
    expect(await runBoardSchedules({}, deps)).toBe(0);
    expect(term.said()).toMatch(/^This board has no schedules\./);
    const config = JSON.parse(fs.readFileSync(path.join(term.dir, "board.json"), "utf8")) as Parameters<typeof agentsGuide>[0];
    fs.writeFileSync(path.join(term.dir, "board.json"), `${JSON.stringify({ ...config, columns: config.columns.filter((column) => column.id !== "ready") }, null, 2)}\n`);
    expect(await runBoardScheduleAdd("check-deps", { as: "robin", daily: true, at: "09:00", title: "x" }, deps)).toBe(1);
    expect(term.said()).toContain("`codelead board add-ready` gives the board its Ready column.");
    expect(section.replace(/\s+/g, " ")).toContain("On a board without Ready, `schedules add` and `schedules run` say that `codelead board add-ready` gives it the column.");
  });
});
