import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  boardContext,
  choicesFor,
  createCards,
  defaultPreferences,
  effectiveTheme,
  getCard,
  initBoard,
  NO_PROJECT,
  preferencesPath,
  preferencesProblems,
  readPreferences,
  THEMES,
  themesFor,
  updateCard,
  writePreferences,
  type BoardContext,
  type Participant,
  type Preferences
} from "../core/index.js";
import { createBoardServer, type BatchPayload, type PreferencesPayload, type RefusalPayload } from "../server/index.js";

const PEOPLE: Participant[] = [
  { id: "robin", kind: "person", name: "Robin" },
  { id: "claude", kind: "agent", name: "Claude Code" }
];

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function board(options: { atRoot?: boolean } = {}): Promise<{ base: string; root: string; dir: string; ctx: BoardContext; tick: () => void }> {
  const base = await mkdtemp(path.join(os.tmpdir(), "pinboard-preferences-"));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "repo");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
  const dir = options.atRoot ? root : path.join(root, "docs", "codelead", "board");
  let time = Date.parse("2026-11-19T09:00:00Z");
  const ctx = boardContext({ dir, root, home: "/home/tester", now: () => new Date(time) });
  initBoard(ctx, { name: "prefs", participants: PEOPLE });
  return { base, root, dir, ctx, tick: () => (time += 60_000) };
}

const preferences = (part: Partial<Preferences> = {}): Preferences => ({ ...defaultPreferences(), ...part });

describe("the board's view preferences (.local/preferences.json)", () => {
  it("are the defaults while there is no file, and the file once written, with .local/ added to the board folder's .gitignore once", async () => {
    const { root, dir, ctx } = await board();
    expect(readPreferences(dir)).toEqual({ preferences: defaultPreferences(), stored: false, problems: [] });
    expect(defaultPreferences().default).toEqual({ theme: "system", lightTheme: "paper", darkTheme: "navy" });
    // A board made before the line existed: its .gitignore has no .local/.
    fs.writeFileSync(path.join(dir, ".gitignore"), "cursors/\n.board.lock");
    const written = writePreferences(ctx, preferences({ default: { theme: "linen", lightTheme: "linen", darkTheme: "ember" }, projects: { api: { theme: "contrast-dark", background: "#203040" } }, lastProject: "api" }));
    expect(written.projects.api).toEqual({ theme: "contrast-dark", background: "#203040" });
    expect(fs.existsSync(preferencesPath(dir))).toBe(true);
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe("cursors/\n.board.lock\n.local/\n");
    expect(readPreferences(dir)).toMatchObject({ stored: true, preferences: { lastProject: "api", default: { theme: "linen" } } });
    writePreferences(ctx, preferences());
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe("cursors/\n.board.lock\n.local/\n");
    // The repository's own .gitignore is never touched.
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toBe("node_modules/\n");
    // A board folder with no .gitignore at all gets one.
    fs.rmSync(path.join(dir, ".gitignore"));
    writePreferences(ctx, preferences());
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe(".local/\n");
  });

  it("never write the repository's root .gitignore: a board at the root gets .local/.gitignore instead", async () => {
    const { root, ctx } = await board({ atRoot: true });
    const before = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
    writePreferences(ctx, preferences());
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toBe(before);
    expect(fs.readFileSync(path.join(root, ".local", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("are checked before they are written: the shape, the themes for each place, the colours, and no path, secret or private name", async () => {
    const { dir, ctx } = await board();
    expect(preferencesProblems(preferences())).toEqual([]);
    expect(preferencesProblems({ ...preferences(), schema: "x" })).toEqual(['"schema" must be "pinboard.preferences/1", and is "x"']);
    expect(preferencesProblems(preferences({ default: { theme: "neon", lightTheme: "navy", darkTheme: "navy" } }))).toEqual([
      'default.theme must be one of paper, linen, frost, sage, navy, pitch, dusk, ember, contrast-light, contrast-dark, system, and is "neon"',
      'default.lightTheme must be a light theme (paper, linen, frost, sage, contrast-light), and is "navy"'
    ]);
    expect(preferencesProblems(preferences({ projects: { api: { background: "red" } } }))[0]).toMatch(/background must be "theme" or a colour like #2a3b4c/);
    expect(preferencesProblems({ ...preferences(), extra: 1 })[0]).toMatch(/a key "extra" they do not have/);
    expect(() => writePreferences(ctx, { ...preferences(), schema: 2 })).toThrow(/Refused: the preferences cannot be kept/);
    expect(() => writePreferences(ctx, preferences({ projects: { "/home/tester/secret-work": { theme: "paper" } } }))).toThrow(/a project's name in the preferences holds a path of this machine/);
    expect(() => writePreferences(ctx, preferences({ lastProject: "Password=hunter22secret;" }))).toThrow(/the last project in the preferences looks like it holds a secret/);
    fs.writeFileSync(path.join(dir, "private-names.txt"), "Quentin\n");
    expect(() => writePreferences(ctx, preferences({ projects: { "quentin-notes": { theme: "paper" } } }))).toThrow(/names someone the board keeps private/);
    const many = Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`project-${index}`, { theme: "paper" }]));
    expect(() => writePreferences(ctx, preferences({ projects: many }))).toThrow(/at most 500 keep choices of their own/);
    expect(fs.existsSync(preferencesPath(dir))).toBe(false);
    // A file that cannot be used reads as the defaults, with why.
    fs.mkdirSync(path.dirname(preferencesPath(dir)), { recursive: true });
    fs.writeFileSync(preferencesPath(dir), "{ not json");
    expect(readPreferences(dir)).toMatchObject({ stored: false, problems: [".local/preferences.json is not JSON"] });
  });

  it("give each project its own choices key by key, falling back to the default; all projects and no project take the default", () => {
    const doc = preferences({ default: { theme: "system", lightTheme: "frost", darkTheme: "dusk", background: "#112233" }, projects: { api: { theme: "ember" }, web: { lightTheme: "sage", background: "theme" } } });
    expect(choicesFor(doc, "api")).toEqual({ theme: "ember", lightTheme: "frost", darkTheme: "dusk", background: "#112233" });
    expect(choicesFor(doc, "web")).toEqual({ theme: "system", lightTheme: "sage", darkTheme: "dusk", background: "theme" });
    expect(choicesFor(doc, "")).toEqual(choicesFor(doc, NO_PROJECT));
    expect(choicesFor(doc, "unknown")).toEqual({ theme: "system", lightTheme: "frost", darkTheme: "dusk", background: "#112233" });
    expect(effectiveTheme(choicesFor(doc, "web"), false).id).toBe("sage");
    expect(effectiveTheme(choicesFor(doc, "web"), true).id).toBe("dusk");
    expect(effectiveTheme(choicesFor(doc, "api"), false).id).toBe("ember");
    expect(THEMES.map((theme) => theme.id)).toHaveLength(10);
    expect(themesFor("light").map((theme) => theme.id)).toEqual(["paper", "linen", "frost", "sage", "contrast-light"]);
    expect(themesFor("dark").map((theme) => theme.id)).toEqual(["navy", "pitch", "dusk", "ember", "contrast-dark"]);
  });
});

describe("the page's process: /api/preferences and /api/cards/batch", () => {
  async function serve(ctx: BoardContext, dir: string, root: string, base: string) {
    const pageDir = path.join(base, "page");
    fs.mkdirSync(pageDir, { recursive: true });
    fs.writeFileSync(path.join(pageDir, "index.html"), "<!doctype html><html><body></body></html>");
    const server = createBoardServer({ dir, root, home: "/home/tester", now: ctx.now, pageDir, watch: false, log: () => undefined });
    const { url } = await server.listen(0);
    cleanups.push(() => server.close());
    const call = async <T>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }> => {
      const response = await fetch(new URL(route, url), { method, headers: body !== undefined ? { "Content-Type": "application/json" } : {}, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: (await response.json()) as T };
    };
    return { server, call };
  }

  it("reads the defaults, writes a document the core accepts, and refuses one it does not in its words", async () => {
    const { base, root, dir, ctx } = await board();
    const { call } = await serve(ctx, dir, root, base);
    const first = await call<PreferencesPayload>("GET", "api/preferences");
    expect(first).toEqual({ status: 200, body: { preferences: defaultPreferences(), stored: false } });
    const doc = preferences({ projects: { api: { theme: "pitch" } }, lastProject: "api" });
    const put = await call<PreferencesPayload>("PUT", "api/preferences", doc);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ preferences: doc, stored: true });
    expect((await call<PreferencesPayload>("GET", "api/preferences")).body).toEqual({ preferences: doc, stored: true });
    const refused = await call<RefusalPayload>("PUT", "api/preferences", { ...doc, default: { theme: "loud" } });
    expect(refused.status).toBe(422);
    expect(refused.body.message).toMatch(/^Refused: the preferences cannot be kept: default.theme must be one of/);
  });

  it("applies one operation to several cards, each its own write, and names a refusal without undoing the others", async () => {
    const { base, root, dir, ctx, tick } = await board();
    createCards(
      ctx,
      "robin",
      [
        { type: "task", title: "One", column: "backlog" },
        { type: "task", title: "Two", column: "backlog", tags: ["repo:api"] },
        { type: "task", title: "Three", column: "inbox" }
      ],
      { tagCreator: false }
    );
    const { call } = await serve(ctx, dir, root, base);
    const read = Object.fromEntries([1, 2, 3].map((id) => [String(id), getCard(ctx, id).card.updated]));
    tick();
    updateCard(ctx, 2, { as: "claude", changes: { status: "looked at" } });
    tick();

    const move = await call<BatchPayload>("POST", "api/cards/batch", { operation: "move", ids: [1, 2, 3], to: "pinned", expectUpdated: read });
    expect(move.status).toBe(200);
    expect(move.body.results.map((result) => [result.id, result.outcome, result.refused?.reason])).toEqual([
      [1, "changed", undefined],
      [2, "refused", "changed since you read it"],
      [3, "changed", undefined]
    ]);
    expect([move.body.changed, move.body.unchanged, move.body.refused]).toEqual([2, 0, 1]);
    expect(move.body.results[0]!.summary).toMatchObject({ id: 1, column: "pinned" });
    expect(move.body.results[0]!.events!.map((event) => event.text)).toEqual(["moved it from Backlog to Pinned"]);
    expect(move.body.results[0]!.before).toMatchObject({ column: "backlog", above: 2 });

    // The page writes as the person; written as an agent, Pinned and Done are refused card by card.
    const agent = await call<BatchPayload>("POST", "api/cards/batch", { as: "claude", operation: "move", ids: [2], to: "done" });
    expect(agent.body.results[0]!.refused).toMatchObject({ code: "column" });
    expect(agent.body.results[0]!.refused!.reason).toMatch(/^claude is an agent and may not move a card into Done/);

    const tags = await call<BatchPayload>("POST", "api/cards/batch", { operation: "tags", ids: [1, 2], add: ["area:cache"] });
    expect(tags.body.changed).toBe(2);
    const untag = await call<BatchPayload>("POST", "api/cards/batch", { operation: "tags", ids: [1, 2], remove: ["area:cache"] });
    expect(untag.body.changed).toBe(2);
    const project = await call<BatchPayload>("POST", "api/cards/batch", { operation: "project", ids: [1, 2], project: "web", replace: true });
    expect(project.body.results.map((result) => result.summary?.tags)).toEqual([["repo:web"], ["repo:web"]]);
    const archive = await call<BatchPayload>("POST", "api/cards/batch", { operation: "archive", ids: [1, 3] });
    expect(archive.body.results.map((result) => result.summary?.archived !== undefined)).toEqual([true, true]);
    const back = await call<BatchPayload>("POST", "api/cards/batch", { operation: "unarchive", ids: [1, 3] });
    expect(back.body.results.map((result) => result.summary?.archived)).toEqual([undefined, undefined]);

    const wrong = await call<RefusalPayload>("POST", "api/cards/batch", { operation: "paint", ids: [1] });
    expect(wrong.status).toBe(422);
    expect(wrong.body.message).toMatch(/"paint" is not an operation of the batch \(move, archive, unarchive, tags, project\)/);
    const nowhere = await call<RefusalPayload>("POST", "api/cards/batch", { operation: "move", ids: [1], to: "attic" });
    expect(nowhere.status).toBe(422);
    expect(nowhere.body.message).toMatch(/"attic" is not a column of the board/);
  });
});
