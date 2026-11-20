import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBoardCommand,
  runBoardArchive,
  runBoardCheck,
  runBoardInit,
  runBoardMove,
  runBoardNew,
  runBoardReply,
  runBoardSet,
  runBoardShow,
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
const outOf = (who: string, column: string): string =>
  `Refused: ${who} is an agent and may not move a card out of ${column} (a person's column): the person moves it from there; ask in the thread. Nothing was written.`;

// ---------------------------------------------------------------------------------------------

describe("the guide's rules, enforced by the commands: each refusal exits 1, with its reason and the way out", () => {
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

  it("an agent moves no card out of Pinned or Done, as none into them; CodeLead itself takes the card the person handed it out of Pinned", async () => {
    const term = await terminal();
    await runBoardNew({ as: "robin", type: "task", title: "Pinned one", column: "pinned" }, term.deps);
    await runBoardNew({ as: "robin", type: "task", title: "Done one", column: "done" }, term.deps);
    await runBoardNew({ as: "robin", type: "task", title: "Pinned two", column: "pinned" }, term.deps);
    await runBoardNew({ as: "robin", type: "task", title: "In the inbox" }, term.deps);
    term.said();

    expect(await runBoardMove("1", { as: "claude", to: "in-progress" }, term.deps)).toBe(1);
    expect(term.said()).toBe(outOf("claude", "Pinned"));
    expect(await runBoardMove("2", { as: "claude", to: "backlog", json: true }, term.deps)).toBe(1);
    expect(JSON.parse(term.said())).toEqual({ refused: "column", message: outOf("claude", "Done") });
    expect(await runBoardMove(["1", "3"], { as: "claude", to: "backlog" }, term.deps)).toBe(1);
    expect(term.said()).toBe(["Moved to Backlog (0 changed, 2 refused):", `  #1 refused: ${outOf("claude", "Pinned")}`, `  #3 refused: ${outOf("claude", "Pinned")}`].join("\n"));
    expect(getCard(term.ctx, 1).card.column).toBe("pinned");

    // CodeLead works only a card the person handed it (the tag, or the card named in `implement --card`): it takes the card out
    // of Pinned, as its queue does, tagged or not.
    expect(await runBoardSet("1", { as: "robin", tag: ["for:codelead"] }, term.deps)).toBe(0);
    expect(await runBoardMove("1", { as: "codelead", to: "in-progress", comment: "Started: the card is the request." }, term.deps)).toBe(0);
    expect(term.said()).toBe("#1: tagged it for:codelead.\nMoved #1 from Pinned to In progress, with the comment.");
    expect(await runBoardMove("3", { as: "codelead", to: "in-progress" }, term.deps)).toBe(0);
    expect(await runBoardMove("3", { as: "robin", to: "pinned" }, term.deps)).toBe(0);
    term.said();
    // The person moves out of their columns as before; an agent into In progress is a convention, not checked.
    expect(await runBoardMove("3", { as: "robin", to: "backlog" }, term.deps)).toBe(0);
    expect(await runBoardMove("4", { as: "claude", to: "in-progress" }, term.deps)).toBe(0);
    expect(term.said()).toBe("Moved #3 from Pinned to Backlog.\nMoved #4 from Inbox to In progress.");
  });

  it("the guide says, for each of these rules, whether the commands refuse it", () => {
    const config = defaultBoardConfig({ name: "w", participants: [{ id: "robin", kind: "person", name: "Robin" }, { id: "claude", kind: "agent", name: "Claude Code" }, { id: "codelead", kind: "agent", name: "CodeLead" }] });
    const guide = agentsGuide(config).replace(/\n {2}/g, " ");
    expect(guide).toContain("`color` is the person's colour mark: leave it (the commands refuse it from an agent).");
    expect(guide).toContain("write your recommendation in `fields.ask`. The commands refuse it.");
    expect(guide).toContain("- Move a card into Pinned or Done: those columns are the person's. Nor move one out of them: the commands refuse both.");
    expect(guide).toContain("In progress (only when the person asked for the work in the session) and For review; add tags and relations; create cards. No command can tell whether the person asked for the work, so that rule is yours to keep.");
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
