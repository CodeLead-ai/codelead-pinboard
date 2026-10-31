import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBoardServe } from "../cli/board.js";
import { addComment, boardContext, createCard, createCards, initBoard, moveCard, readEvents, type BoardContext, type NewCardInput, type Participant } from "../core/index.js";
import {
  createBoardServer,
  vscodeHref,
  type BoardPayload,
  type BoardServer,
  type CardDetail,
  type EventsPayload,
  type NotificationsPayload,
  type RefusalPayload,
  type WritePayload
} from "../server/index.js";

const PEOPLE: Participant[] = [
  { id: "robin", kind: "person", name: "Robin" },
  { id: "claude", kind: "agent", name: "Claude Code" }
];

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Fixture {
  base: string;
  root: string;
  dir: string;
  ctx: BoardContext;
  pageDir: string;
  tick: (seconds?: number) => void;
  now: () => Date;
  read: (relative: string) => string;
  cardFile: (id: number) => string;
}

/**
 * A workspace of the test's own: a repository with a board (`<base>/codelead`), a second
 * repository beside it (`<base>/other-repo`), and a built page of three files.
 */
async function fixture(): Promise<Fixture> {
  const base = await mkdtemp(path.join(os.tmpdir(), "pinboard-server-"));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "codelead");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "plan.md"), "# The plan\n\nline 3\n");
  fs.mkdirSync(path.join(root, ".codelead", "evidence"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codelead", "evidence", "ev-20261003120000-abc123.json"), "{}\n");
  fs.mkdirSync(path.join(base, "other-repo", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(base, "other-repo", "scripts", "run.sh"), "echo\n");
  const dir = path.join(root, "docs", "codelead", "board");
  let time = Date.parse("2026-10-04T10:00:00Z");
  const now = (): Date => new Date(time);
  const ctx = boardContext({ dir, root, home: "/home/tester", now });
  initBoard(ctx, { name: "test-workspace", participants: PEOPLE });
  const pageDir = path.join(base, "page");
  fs.mkdirSync(path.join(pageDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(pageDir, "index.html"), '<!doctype html><html><head><script>document.documentElement.dataset.ready = "1";</script></head><body><div id="root"></div><script type="module" src="./assets/app.js"></script></body></html>');
  fs.writeFileSync(path.join(pageDir, "assets", "app.js"), "console.log('page');\n");
  fs.writeFileSync(path.join(base, "secret.txt"), "outside the page\n");
  return {
    base,
    root,
    dir,
    ctx,
    pageDir,
    now,
    tick: (seconds = 60) => {
      time += seconds * 1000;
    },
    read: (relative) => fs.readFileSync(path.join(dir, relative), "utf8"),
    cardFile: (id) => {
      const name = fs.readdirSync(path.join(dir, "items")).find((entry) => entry.startsWith(`${String(id).padStart(4, "0")}-`));
      if (!name) throw new Error(`no file for card ${id}`);
      return path.join(dir, "items", name);
    }
  };
}

/** Three cards: a decision in Pinned that relates to a task, the task in Backlog, and an agent's idea in Inbox. */
function seed(f: Fixture): void {
  // The person's cards as the page makes them (no by: tag); the agent's as an agent makes them.
  const byPerson = (input: NewCardInput): void => {
    createCards(f.ctx, "robin", [input], { tagCreator: false });
  };
  byPerson({
    type: "decision",
    title: "Pick the cache strategy",
    column: "pinned",
    tags: ["repo:codelead", "area:cache"],
    description: "Read `docs/plan.md:3` and `other-repo:scripts/run.sh`; the record ev-20261003120000-abc123 has the numbers. Not here: `docs/missing.md`.",
    attachments: [{ path: "docs/plan.md", lines: "3-9" }, { path: "other-repo:scripts/run.sh" }, { path: "docs/gone.md" }]
  });
  f.tick();
  byPerson({ type: "task", title: "Write the cache layer", column: "backlog", relations: [{ kind: "child-of", to: 1 }] });
  f.tick();
  createCard(f.ctx, "claude", { type: "idea", title: "Cache the board's reads", tags: ["repo:codelead"] });
  f.tick();
}

interface Running {
  server: BoardServer;
  url: string;
  port: number;
  call: <T>(method: string, route: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: T }>;
}

async function serve(f: Fixture, options: { watch?: boolean; settleMs?: number } = {}): Promise<Running> {
  const server = createBoardServer({ dir: f.dir, root: f.root, home: "/home/tester", now: f.now, pageDir: f.pageDir, watch: options.watch ?? false, debounceMs: 20, settleMs: options.settleMs ?? 60, log: () => undefined });
  const { url, port } = await server.listen(0);
  cleanups.push(() => server.close());
  const call = async <T>(method: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> => {
    const response = await fetch(new URL(route, url), {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const text = await response.text();
    return { status: response.status, body: (text.startsWith("{") ? JSON.parse(text) : text) as T };
  };
  return { server, url, port, call };
}

interface StreamMessage {
  id?: string;
  event: string;
  data?: unknown;
  retry?: number;
}

/** A reader of the event stream that keeps every message and waits for the one a test needs. */
function openStream(url: string, headers: Record<string, string> = {}): { messages: StreamMessage[]; next: (match: (message: StreamMessage) => boolean, timeoutMs?: number) => Promise<StreamMessage>; close: () => void } {
  const messages: StreamMessage[] = [];
  const listeners = new Set<() => void>();
  let buffer = "";
  const request = http.get(url, { headers }, (response) => {
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      buffer += chunk;
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const message: StreamMessage = { event: "message" };
        let isComment = true;
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue;
          isComment = false;
          const at = line.indexOf(":");
          const field = at === -1 ? line : line.slice(0, at);
          const value = at === -1 ? "" : line.slice(at + 1).replace(/^ /, "");
          if (field === "id") message.id = value;
          else if (field === "event") message.event = value;
          else if (field === "data") message.data = JSON.parse(value);
          else if (field === "retry") message.retry = Number(value);
        }
        if (!isComment) {
          messages.push(message);
          for (const listener of [...listeners]) listener();
        }
        end = buffer.indexOf("\n\n");
      }
    });
  });
  request.on("error", () => undefined);
  let seen = 0;
  const next = (match: (message: StreamMessage) => boolean, timeoutMs = 4000): Promise<StreamMessage> =>
    new Promise((resolve, reject) => {
      const look = (): boolean => {
        for (; seen < messages.length; seen += 1) {
          if (match(messages[seen]!)) {
            const found = messages[seen]!;
            seen += 1;
            resolve(found);
            return true;
          }
        }
        return false;
      };
      if (look()) return;
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error(`no matching message in ${timeoutMs} ms; got: ${JSON.stringify(messages.map((message) => message.event))}`));
      }, timeoutMs);
      const listener = (): void => {
        if (look()) {
          clearTimeout(timer);
          listeners.delete(listener);
        }
      };
      listeners.add(listener);
    });
  const close = (): void => {
    request.destroy();
  };
  cleanups.push(close);
  return { messages, next, close };
}

describe("the board's process: the API", () => {
  it("GET /api/board: the columns in the board's order, a tile per card, the person, the log's position", async () => {
    const f = await fixture();
    seed(f);
    addComment(f.ctx, 1, { as: "claude", body: "Option B reads best: a TTL of one minute, `docs/plan.md:3` has the reason." });
    const { call } = await serve(f);
    const { status, body } = await call<BoardPayload>("GET", "/api/board");
    expect(status).toBe(200);
    expect(body.name).toBe("test-workspace");
    expect(body.person).toEqual({ id: "robin", kind: "person", name: "Robin" });
    expect(body.columns.map((column) => column.name)).toEqual(["Inbox", "Backlog", "Ideas", "Pinned", "In progress", "For review", "Done"]);
    expect(body.columns.find((column) => column.id === "pinned")).toMatchObject({ owner: "person", agentsMay: false });
    expect(body.columns.find((column) => column.id === "for-review")).toMatchObject({ agentsMay: true });
    expect(body.lines).toBe(4);
    expect(body.editor).toEqual({ root: f.root, workspace: f.base, repository: "codelead" });
    expect(body.typeFields.decision).toEqual(["ask", "options", "recommendation", "decided", "consequences"]);
    const [decision, task, idea] = body.cards;
    expect(decision).toMatchObject({ id: 1, type: "decision", column: "pinned", comments: 1, waitsOnYou: true, proposal: false, attachments: 3 });
    expect(decision!.last).toMatchObject({ author: "claude", excerpt: expect.stringContaining("Option B reads best") });
    expect(task).toMatchObject({ id: 2, waitsOnYou: false, relations: 1 });
    // The agent's idea keeps its dashed border until the person touches it.
    expect(idea).toMatchObject({ id: 3, author: "claude", proposal: true, tags: ["repo:codelead", "by:claude"] });
  });

  it("GET /api/items/:id: relations both ways with their cards, attachments and the text's paths as editor links, ?open=1 records the opening", async () => {
    const f = await fixture();
    seed(f);
    const { call } = await serve(f);
    const { status, body } = await call<CardDetail>("GET", "/api/items/1");
    expect(status).toBe(200);
    expect(body.card).toMatchObject({ id: 1, title: "Pick the cache strategy", column: "pinned", tags: ["repo:codelead", "area:cache"] });
    expect(body.problems).toEqual([]);
    expect(body.relations).toEqual([{ kind: "parent-of", to: 2, statedBy: 2, own: false, title: "Write the cache layer", type: "task", column: "backlog" }]);
    expect(body.attachments).toEqual([
      { path: "docs/plan.md", lines: "3-9", label: "docs/plan.md:3-9", exists: true, href: vscodeHref(path.join(f.root, "docs", "plan.md"), 3) },
      { path: "other-repo:scripts/run.sh", label: "other-repo:scripts/run.sh", exists: true, href: vscodeHref(path.join(f.base, "other-repo", "scripts", "run.sh")) },
      { path: "docs/gone.md", label: "docs/gone.md", exists: false }
    ]);
    expect(body.mentions["docs/plan.md:3"]).toEqual({ path: path.join(f.root, "docs", "plan.md"), line: 3, kind: "path", href: vscodeHref(path.join(f.root, "docs", "plan.md"), 3) });
    expect(body.mentions["other-repo:scripts/run.sh"]?.path).toBe(path.join(f.base, "other-repo", "scripts", "run.sh"));
    expect(body.mentions["ev-20261003120000-abc123"]).toMatchObject({ kind: "evidence", path: path.join(f.root, ".codelead", "evidence", "ev-20261003120000-abc123.json") });
    expect(body.mentions["docs/missing.md"]).toBeUndefined();
    expect(body.activity.map((event) => event.kind)).toEqual(["item.created"]);
    expect(fs.existsSync(path.join(f.dir, "cursors", "robin.json"))).toBe(false);

    const child = await call<CardDetail>("GET", "/api/items/2?open=1");
    expect(child.body.relations).toEqual([{ kind: "child-of", to: 1, statedBy: 2, own: true, title: "Pick the cache strategy", type: "decision", column: "pinned" }]);
    expect(JSON.parse(f.read("cursors/robin.json")).opened).toEqual({ "2": f.now().toISOString().replace(/\.\d{3}Z$/, "Z") });
    expect(vscodeHref("C:\\work\\my repo\\a#b.md", 7)).toBe("vscode://file/C:/work/my%20repo/a%23b.md:7");
  });

  it("PUT /api/items/:id changes a card field by field, each change with its event; a stale write is 409 in the core's words", async () => {
    const f = await fixture();
    seed(f);
    const { call } = await serve(f);
    const before = (await call<CardDetail>("GET", "/api/items/1")).body.card.updated;
    f.tick();
    const changed = await call<WritePayload>("PUT", "/api/items/1", {
      expectUpdated: before,
      changes: { title: "Pick the cache strategy (by Friday)", addTags: ["w5"], removeTags: ["area:cache"], fields: { options: ["a TTL", "a version key"], recommendation: "a TTL" } }
    });
    expect(changed.status).toBe(200);
    expect(changed.body.card.card).toMatchObject({ title: "Pick the cache strategy (by Friday)", tags: ["repo:codelead", "w5"], fields: { options: ["a TTL", "a version key"], recommendation: "a TTL" } });
    expect(changed.body.summary).toMatchObject({ id: 1, title: "Pick the cache strategy (by Friday)" });
    expect(changed.body.events.map((event) => event.kind)).toEqual(["item.updated", "tag.added", "tag.removed"]);
    expect(changed.body.events[0]).toMatchObject({ by: "robin", byName: "Robin", text: "changed its title, fields" });
    expect(f.read(path.relative(f.dir, f.cardFile(1)))).toContain('title: "Pick the cache strategy (by Friday)"');

    // The page read the card before this change: its write is refused, and nothing is written.
    const fileBefore = fs.readFileSync(f.cardFile(1), "utf8");
    const stale = await call<RefusalPayload>("PUT", "/api/items/1", { expectUpdated: before, changes: { title: "Another title" } });
    expect(stale.status).toBe(409);
    expect(stale.body.refused).toBe("stale");
    expect(stale.body.message).toBe(
      "Refused: card #1 changed since it was read (its updated is 2026-10-04T10:04:00Z; the write expected 2026-10-04T10:00:00Z); nothing was written. Read the card again and redo the change."
    );
    expect(fs.readFileSync(f.cardFile(1), "utf8")).toBe(fileBefore);

    const badType = await call<RefusalPayload>("PUT", "/api/items/1", { changes: { type: "epic" } });
    expect(badType.status).toBe(422);
    expect(badType.body).toEqual({ refused: "type", message: 'Refused: "epic" is not a card type of the board (question, decision, task, idea, review, note). Nothing was written.' });
    const noChanges = await call<RefusalPayload>("PUT", "/api/items/1", { expectUpdated: before });
    expect(noChanges.status).toBe(422);
    expect(noChanges.body.message).toContain("the request has no changes");
  });

  it("POST /api/items creates a card in Inbox or the column named, as the person, without a by: tag", async () => {
    const f = await fixture();
    seed(f);
    const { call } = await serve(f);
    const created = await call<WritePayload>("POST", "/api/items", { type: "question", title: "Which TTL?", description: "One minute, or five?" });
    expect(created.status).toBe(201);
    expect(created.body.card.card).toMatchObject({ id: 4, type: "question", column: "inbox", author: "robin", tags: [], description: "One minute, or five?" });
    expect(created.body.events.map((event) => event.kind)).toEqual(["item.created"]);
    const inColumn = await call<WritePayload>("POST", "/api/items", { type: "task", title: "Measure the reads", column: "backlog", tags: ["repo:codelead"], relations: [{ kind: "related", to: 1 }] });
    expect(inColumn.body.card.card).toMatchObject({ id: 5, column: "backlog", tags: ["repo:codelead"], relations: [{ kind: "related", to: 1 }] });
    expect(fs.existsSync(f.cardFile(5))).toBe(true);
    const untitled = await call<RefusalPayload>("POST", "/api/items", { type: "task", title: "  " });
    expect(untitled.status).toBe(422);
    expect(untitled.body.message).toBe("Refused: the title is empty; nothing was written.");
  });

  it("POST /api/items/:id/comments appends the person's comment; a secret or a thread heading is 422 in the core's words", async () => {
    const f = await fixture();
    seed(f);
    const { call } = await serve(f);
    const commented = await call<WritePayload>("POST", "/api/items/1/comments", { body: "Option B, with a TTL of one minute." });
    expect(commented.status).toBe(200);
    expect(commented.body.card.card.thread).toEqual([{ author: "robin", at: "2026-10-04T10:03:00Z", body: "Option B, with a TTL of one minute." }]);
    expect(commented.body.events).toMatchObject([{ kind: "comment.added", by: "robin", text: "commented: Option B, with a TTL of one minute." }]);
    expect(fs.readFileSync(f.cardFile(1), "utf8")).toContain("### robin · 2026-10-04T10:03:00Z\nOption B, with a TTL of one minute.\n");

    const secret = await call<RefusalPayload>("POST", "/api/items/1/comments", { body: "The key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ" });
    expect(secret.status).toBe(422);
    expect(secret.body).toEqual({
      refused: "secret",
      message: "Refused: the comment looks like it holds a secret (a key, a connection-string password or a bearer token); nothing was written. Leave the secret out and say where it is kept instead."
    });
    const heading = await call<RefusalPayload>("POST", "/api/items/1/comments", { body: "A list:\n## Thread\nthat would split the card" });
    expect(heading.status).toBe(422);
    expect(heading.body.refused).toBe("structure");
    expect(heading.body.message).toContain('the comment has a line the card would read as its own structure ("## Thread")');
    const empty = await call<RefusalPayload>("POST", "/api/items/1/comments", {});
    expect(empty.status).toBe(422);
    expect(empty.body.message).toBe("Refused: the request has no comment (body); nothing was written.");
    expect(readEvents(f.dir).events.filter(({ event }) => event.kind === "comment.added")).toHaveLength(1);
  });

  it("a comment naming files of this machine is written as the card cites them, which link to the editor, in board.json's workspace too (card #176)", async () => {
    const f = await fixture();
    seed(f);
    fs.writeFileSync(path.join(f.base, "other-repo", "README.md"), "# other\n");
    const { call } = await serve(f);
    const commented = await call<WritePayload>("POST", "/api/items/1/comments", { body: `See ${f.base}/other-repo/scripts/run.sh:1 and ${f.base}/other-repo/README.md, with ${f.root}/docs/plan.md:3.` });
    expect(commented.status).toBe(200);
    expect(commented.body.card.card.thread.at(-1)?.body).toBe("See other-repo:scripts/run.sh:1 and other-repo:README.md, with docs/plan.md:3.");
    expect(commented.body.card.mentions["other-repo:scripts/run.sh:1"]).toMatchObject({ path: path.join(f.base, "other-repo", "scripts", "run.sh"), line: 1 });
    expect(commented.body.card.mentions["other-repo:README.md"]?.path).toBe(path.join(f.base, "other-repo", "README.md"));

    // board.json's workspace is read with each request: a repository on the shelf is cited and linked, and the repository's own files still are.
    fs.mkdirSync(path.join(f.base, "shelf", "kept", "docs"), { recursive: true });
    fs.writeFileSync(path.join(f.base, "shelf", "kept", "docs", "y.md"), "y\n");
    const config = JSON.parse(f.read("board.json")) as Record<string, unknown>;
    fs.writeFileSync(path.join(f.dir, "board.json"), `${JSON.stringify({ ...config, workspace: "../shelf" }, null, 2)}\n`);
    const shelved = await call<WritePayload>("POST", "/api/items/1/comments", { body: `Kept in ${f.base}/shelf/kept/docs/y.md` });
    expect(shelved.body.card.card.thread.at(-1)?.body).toBe("Kept in kept:docs/y.md");
    const detail = await call<CardDetail>("GET", "/api/items/1");
    expect(detail.body.mentions["kept:docs/y.md"]?.href).toBe(vscodeHref(path.join(f.base, "shelf", "kept", "docs", "y.md")));
    expect(detail.body.mentions["docs/plan.md:3"]?.path).toBe(path.join(f.root, "docs", "plan.md"));
    expect((await call<BoardPayload>("GET", "/api/board")).body.editor.workspace).toBe(path.join(f.base, "shelf"));
  });

  it("POST /api/items/:id/move moves a card, with a comment in the same step when one is given; an unknown column is 422", async () => {
    const f = await fixture();
    seed(f);
    const { call } = await serve(f);
    const moved = await call<WritePayload>("POST", "/api/items/2/move", { to: "in-progress" });
    expect(moved.status).toBe(200);
    expect(moved.body.summary.column).toBe("in-progress");
    expect(moved.body.events).toMatchObject([{ kind: "item.moved", text: "moved it from Backlog to In progress" }]);

    const done = await call<WritePayload>("POST", "/api/items/1/move", { to: "Done", comment: "Answered: a TTL." });
    expect(done.body.events.map((event) => [event.kind, event.at])).toEqual([
      ["comment.added", "2026-10-04T10:03:00Z"],
      ["item.moved", "2026-10-04T10:03:00Z"]
    ]);
    expect(done.body.card.card.column).toBe("done");

    const nowhere = await call<RefusalPayload>("POST", "/api/items/2/move", { to: "nowhere" });
    expect(nowhere.status).toBe(422);
    expect(nowhere.body).toEqual({ refused: "column", message: 'Refused: "nowhere" is not a column of the board (inbox, backlog, ideas, pinned, in-progress, for-review, done). Nothing was written.' });
  });

  it("POST /api/items/:id/archive takes a card off the board; it stays readable and flagged", async () => {
    const f = await fixture();
    seed(f);
    const { call } = await serve(f);
    const updated = (await call<CardDetail>("GET", "/api/items/2")).body.card.updated;
    const archived = await call<WritePayload>("POST", "/api/items/2/archive", { expectUpdated: updated });
    expect(archived.status).toBe(200);
    expect(archived.body.summary.archived).toBe("2026-10-04T10:03:00Z");
    expect(archived.body.events).toMatchObject([{ kind: "item.archived", text: "archived it" }]);
    const board = await call<BoardPayload>("GET", "/api/board");
    expect(board.body.cards.find((card) => card.id === 2)?.archived).toBe("2026-10-04T10:03:00Z");
  });

  it("GET /api/events?since= gives the log's lines after a position or after a time", async () => {
    const f = await fixture();
    seed(f);
    const { call } = await serve(f);
    const after = await call<EventsPayload>("GET", "/api/events?since=1");
    expect(after.body.lines).toBe(3);
    expect(after.body.events.map((event) => [event.position, event.item, event.byName])).toEqual([
      [2, 2, "Robin"],
      [3, 3, "Claude Code"]
    ]);
    const byTime = await call<EventsPayload>("GET", "/api/events?since=2026-10-04T10:00:30Z");
    expect(byTime.body.events.map((event) => event.position)).toEqual([2, 3]);
    const wrong = await call<RefusalPayload>("GET", "/api/events?since=yesterday");
    expect(wrong.status).toBe(422);
    expect(wrong.body.message).toContain('not "yesterday"');
  });

  it("GET /api/notifications: what others did that the person has not opened, by card; opening a card clears it; POST /api/check/ack clears all", async () => {
    const f = await fixture();
    seed(f);
    addComment(f.ctx, 1, { as: "claude", body: "Option B reads best." });
    f.tick();
    moveCard(f.ctx, 2, { as: "claude", to: "in-progress", comment: "Started, as you asked in the session." });
    f.tick();
    const { call } = await serve(f);
    const first = await call<NotificationsPayload>("GET", "/api/notifications");
    expect(first.status).toBe(200);
    // The idea's creation, the comment on #1, the comment and the move on #2: all by Claude.
    expect(first.body.count).toBe(4);
    expect(first.body.cards).toBe(3);
    expect(first.body.unseenByCard).toEqual({ "1": 1, "2": 2, "3": 1 });
    expect(first.body.groups.map((group) => group.item)).toEqual([2, 1, 3]);
    // A comment and a move written in one step are one line of the list (they stay two events in the count).
    expect(first.body.groups[0]!.events.map((event) => event.text)).toEqual(["commented and moved it to In progress: Started, as you asked in the session."]);
    expect(first.body.groups[0]).toMatchObject({ title: "Write the cache layer", type: "task", column: "in-progress" });

    // The gear: Claude reported working on #2 since it entered In progress.
    const board = await call<BoardPayload>("GET", "/api/board");
    expect(board.body.cards.find((card) => card.id === 2)?.working).toEqual({ by: "claude", at: "2026-10-04T10:04:00Z" });

    await call<CardDetail>("GET", "/api/items/2?open=1");
    const opened = await call<NotificationsPayload>("GET", "/api/notifications");
    expect(opened.body.count).toBe(2);
    expect(opened.body.groups.map((group) => group.item)).toEqual([1, 3]);

    const cleared = await call<NotificationsPayload>("POST", "/api/check/ack", {});
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ count: 0, groups: [], since: "2026-10-04T10:05:00Z" });
    expect(JSON.parse(f.read("cursors/robin.json"))).toMatchObject({ seen: "2026-10-04T10:05:00Z", lines: 6 });
  });

  it("refuses what is not the page's: another Host, a write from another site, a write that is not JSON; 404 and 405 with words", async () => {
    const f = await fixture();
    seed(f);
    const { call, port } = await serve(f);
    const foreignHost = await new Promise<number>((resolve) => {
      http.get({ host: "127.0.0.1", port, path: "/api/board", headers: { Host: `attacker.example:${port}` } }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
    });
    expect(foreignHost).toBe(403);
    const crossSite = await call<RefusalPayload>("POST", "/api/items/1/comments", { body: "hello" }, { Origin: "https://attacker.example" });
    expect(crossSite.status).toBe(403);
    expect(crossSite.body.message).toBe("Refused: a write from another site; nothing was written.");
    const sameSite = await call<WritePayload>("POST", "/api/items/1/comments", { body: "hello" }, { Origin: `http://localhost:${port}` });
    expect(sameSite.status).toBe(200);
    const form = await fetch(new URL("/api/check/ack", `http://127.0.0.1:${port}`), { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
    expect(form.status).toBe(415);
    expect(fs.existsSync(path.join(f.dir, "cursors", "robin.json"))).toBe(false);
    const missing = await call<RefusalPayload>("GET", "/api/items/99");
    expect(missing).toEqual({ status: 404, body: { refused: "not-found", message: "No card #99 on the board." } });
    const noRoute = await call<RefusalPayload>("GET", "/api/nothing");
    expect(noRoute.status).toBe(404);
    const wrongMethod = await call<RefusalPayload>("DELETE", "/api/items/1");
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.body.message).toBe("/api/items/1 answers GET, PUT.");
  });

  it("serves the page: the index with a policy that allows its own scripts only, its assets, nothing outside its folder", async () => {
    const f = await fixture();
    const { url } = await serve(f);
    const index = await fetch(url);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const policy = index.headers.get("content-security-policy") ?? "";
    expect(policy).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
    expect(policy).toContain("connect-src 'self'");
    expect(await index.text()).toContain('<div id="root">');
    const asset = await fetch(new URL("/assets/app.js", url));
    expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    const escape = await new Promise<number>((resolve) => {
      http.get(`${url}..%2Fsecret.txt`, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
    });
    expect(escape).toBe(404);
  });
});

describe("the board's process: the event stream and the watcher", () => {
  it("GET /api/stream: retry, the lines after since, then ready; then every new line as an event whose id is its place in the log", async () => {
    const f = await fixture();
    seed(f);
    const { url, call } = await serve(f);
    const stream = openStream(new URL("/api/stream?since=1", url).toString());
    const first = await stream.next(() => true);
    expect(first).toMatchObject({ event: "message", retry: 2000 });
    const replayed = [await stream.next(() => true), await stream.next(() => true)];
    expect(replayed.map((message) => [message.event, message.id, (message.data as { item: number }).item])).toEqual([
      ["event", "2", 2],
      ["event", "3", 3]
    ]);
    expect(await stream.next(() => true)).toEqual({ event: "ready", data: { lines: 3, person: "robin" } });

    await call("POST", "/api/items/3/comments", { body: "Taken: it is worth a try." });
    const added = await stream.next((message) => message.event === "event");
    expect(added.id).toBe("4");
    expect(added.data).toMatchObject({ position: 4, by: "robin", byName: "Robin", item: 3, kind: "comment.added", text: "commented: Taken: it is worth a try." });
    const card = await stream.next((message) => message.event === "card");
    // The person commented: the agent's idea is no longer an untouched proposal.
    expect(card.data).toMatchObject({ id: 3, card: { id: 3, comments: 1, proposal: false, waitsOnYou: false } });
    await stream.next((message) => message.event === "notifications");

    // A page that reconnects with Last-Event-ID gets only what it missed.
    const again = openStream(new URL("/api/stream", url).toString(), { "Last-Event-ID": "3" });
    await again.next((message) => message.retry === 2000);
    expect((await again.next(() => true)).id).toBe("4");
    expect((await again.next(() => true)).event).toBe("ready");
  });

  it("the watcher: a card file edited on disk is announced at once; after the settle time, the core's synthesized event by unknown follows", async () => {
    const f = await fixture();
    seed(f);
    const { url } = await serve(f, { watch: true, settleMs: 300 });
    const stream = openStream(new URL("/api/stream", url).toString());
    await stream.next((message) => message.event === "ready");

    // An agent appends a comment by hand and forgets the event line.
    const file = f.cardFile(2);
    fs.writeFileSync(file, `${fs.readFileSync(file, "utf8")}\n### claude · 2026-10-04T10:10:00Z\nI wrote this without an event.\n`);
    const card = await stream.next((message) => message.event === "card");
    expect(card.data).toMatchObject({ id: 2, card: { comments: 1, waitsOnYou: true, last: { author: "claude", excerpt: "I wrote this without an event." } } });
    const synthesized = await stream.next((message) => message.event === "event", 5000);
    expect(synthesized.data).toMatchObject({ by: "unknown", byName: "unknown", item: 2, kind: "item.updated", data: { synthesized: true, fields: ["thread"] }, text: "changed its file with no event (thread)" });
    expect(readEvents(f.dir).events.filter(({ event }) => event.by === "unknown")).toHaveLength(1);

    // An agent that writes its event line within the settle time is not announced twice.
    const other = f.cardFile(1);
    fs.writeFileSync(other, `${fs.readFileSync(other, "utf8")}\n### claude · 2026-10-04T10:11:00Z\nThis one has its event.\n`);
    await stream.next((message) => message.event === "card" && (message.data as { id: number }).id === 1);
    fs.appendFileSync(path.join(f.dir, "events.jsonl"), `${JSON.stringify({ at: "2026-10-04T10:11:00Z", by: "claude", item: 1, kind: "comment.added", data: { excerpt: "This one has its event." } })}\n`);
    const own = await stream.next((message) => message.event === "event");
    expect(own.data).toMatchObject({ by: "claude", item: 1, kind: "comment.added" });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(readEvents(f.dir).events.filter(({ event }) => event.by === "unknown")).toHaveLength(1);

    // A card file that goes away is announced as removed.
    fs.rmSync(f.cardFile(3));
    expect((await stream.next((message) => message.event === "card")).data).toEqual({ id: 3, removed: true });
  });
});

describe("codelead board serve", () => {
  it("serves the board on the port asked for, answers, and stops when told", async () => {
    const f = await fixture();
    seed(f);
    const lines: string[] = [];
    const controller = new AbortController();
    let served = "";
    const opened: string[] = [];
    const running = runBoardServe(
      { port: "0", open: true, board: f.dir },
      { cwd: () => f.root, output: (line) => lines.push(line), home: "/home/tester", pageDir: f.pageDir, signal: controller.signal, started: (url) => (served = url), openUrl: (url) => opened.push(url) }
    );
    cleanups.push(() => controller.abort());
    for (let waited = 0; served === "" && waited < 3000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(served).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(opened).toEqual([served]);
    expect(lines.join("\n")).toContain(`Pinboard: ${served}\nThe board in docs/codelead/board, as Robin.`);
    const board = (await (await fetch(new URL("/api/board", served))).json()) as BoardPayload;
    expect(board.cards).toHaveLength(3);
    controller.abort();
    expect(await running).toBe(0);
    expect(lines[lines.length - 1]).toBe("Pinboard stopped.");
    await expect(fetch(new URL("/api/board", served))).rejects.toThrow();
  });

  it("refuses a folder with no board, and a port that is no port, with words", async () => {
    const f = await fixture();
    const lines: string[] = [];
    const empty = path.join(f.base, "empty");
    fs.mkdirSync(empty);
    expect(await runBoardServe({ board: empty, port: "0" }, { cwd: () => f.base, output: (line) => lines.push(line), pageDir: f.pageDir })).toBe(2);
    expect(lines.pop()).toBe(`No board at ${empty} (no board.json there). Run \`codelead board init\` in the repository first.`);
    expect(await runBoardServe({ board: f.dir, port: "eighty" }, { cwd: () => f.base, output: (line) => lines.push(line), pageDir: f.pageDir })).toBe(2);
    expect(lines.pop()).toBe('"eighty" is not a port: give a whole number from 1 to 65535, or 0 for a free one the system picks.');
  });
});
