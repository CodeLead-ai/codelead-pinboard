import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBoardServe } from "../cli/board.js";
import { addSchedule, boardContext, getCard, initBoard, moveCard, readEvents, type BoardContext, type ScheduleInput } from "../core/index.js";
import { createBoardServer, type BoardPayload, type CardDetail, type RefusalPayload, type ScheduleRunPayload, type SchedulesPayload, type ScheduleTimers, type ScheduleWritePayload } from "../server/index.js";

/**
 * The page's process and the schedules: at its start and on its timer it makes the cards of the
 * schedules that are due (the core's one function), and says in its log what it made; its routes list
 * the schedules and write the person's changes. The timer is the test's own, driven by the test's
 * clock: nothing here sleeps.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Fixture {
  root: string;
  dir: string;
  ctx: BoardContext;
  pageDir: string;
  now: () => Date;
  set: (iso: string) => void;
}

async function fixture(): Promise<Fixture> {
  const base = await mkdtemp(path.join(os.tmpdir(), "pinboard-schedules-server-"));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "app");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  const dir = path.join(root, "docs", "codelead", "board");
  let time = Date.parse("2026-11-20T09:00:00Z");
  const now = (): Date => new Date(time);
  const ctx = boardContext({ dir, root, home: "/home/tester", now, zone: "Europe/Berlin" });
  initBoard(ctx, { name: "test", participants: [{ id: "robin", kind: "person", name: "Robin" }, { id: "claude", kind: "agent", name: "Claude Code" }] });
  const pageDir = path.join(base, "page");
  fs.mkdirSync(pageDir, { recursive: true });
  fs.writeFileSync(path.join(pageDir, "index.html"), "<!doctype html><html><body><div id=\"root\"></div></body></html>");
  return {
    root,
    dir,
    ctx,
    pageDir,
    now,
    set: (iso) => {
      time = Date.parse(iso);
    }
  };
}

const WEEKLY: ScheduleInput = {
  name: "check-deps",
  rule: { kind: "weekly", days: ["mon"], at: "09:00" },
  card: { type: "task", title: "Check the dependencies", fields: { definitionOfDone: "npm test passes", mayTouch: ["package.json"], limitMinutes: 30 } }
};

/** A timer the test runs by hand: what was set, how often, and what was cleared. */
function handTimer(): ScheduleTimers & { tick: () => void; every?: number; cleared: unknown[] } {
  let run: (() => void) | undefined;
  const timer = {
    every: undefined as number | undefined,
    cleared: [] as unknown[],
    setInterval: (given: () => void, ms: number) => {
      run = given;
      timer.every = ms;
      return "the-timer";
    },
    clearInterval: (handle: unknown) => {
      timer.cleared.push(handle);
    },
    tick: () => run!()
  };
  return timer;
}

async function serve(f: Fixture, timers: ScheduleTimers, logs: string[], more: { schedulesEveryMs?: number } = {}) {
  const server = createBoardServer({ dir: f.dir, root: f.root, home: "/home/tester", now: f.now, zone: "Europe/Berlin", pageDir: f.pageDir, watch: false, log: (line) => logs.push(line), timers, ...more });
  const { url } = await server.listen(0);
  cleanups.push(() => server.close());
  const call = async <T>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const response = await fetch(new URL(route, url), { method, headers: { "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: (await response.json()) as T };
  };
  return { server, call };
}

describe("the page's process runs the schedules", () => {
  it("once at its start and then on its timer, by the test's clock; says in its log what it made; stops with the process", async () => {
    const f = await fixture();
    addSchedule(f.ctx, "robin", WEEKLY);
    const timer = handTimer();
    const logs: string[] = [];
    const { server } = await serve(f, timer, logs);
    // At its start (Friday) nothing is due: nothing made, nothing said.
    expect(timer.every).toBe(60_000);
    expect(logs).toEqual([]);
    f.set("2026-11-23T07:59:00Z");
    timer.tick();
    expect(fs.readdirSync(path.join(f.dir, "items"))).toEqual([]);
    // Monday 09:00 in Berlin: the next tick makes the card, and the log says so.
    f.set("2026-11-23T08:00:30Z");
    timer.tick();
    expect(logs).toEqual(["Pinboard: The schedule check-deps put #1 in Ready: Check the dependencies (due Mon 2026-11-23 09:00 Europe/Berlin, 2026-11-23 08:00 UTC)."]);
    expect(getCard(f.ctx, 1).card).toMatchObject({ column: "ready", author: "robin", schedule: { name: "check-deps", by: "robin" } });
    // The ticks after it make nothing more.
    f.set("2026-11-23T08:01:30Z");
    timer.tick();
    expect(logs).toHaveLength(1);
    await server.close();
    expect(timer.cleared).toEqual(["the-timer"]);
  });

  it("at its start makes one card for the times missed while it was not running, and says which it stands for", async () => {
    const f = await fixture();
    addSchedule(f.ctx, "robin", WEEKLY);
    const logs: string[] = [];
    // Closed over three Mondays.
    f.set("2026-12-08T07:00:00Z");
    await serve(f, handTimer(), logs);
    expect(logs).toEqual([
      "Pinboard: The schedule check-deps put #1 in Ready: Check the dependencies (due Mon 2026-12-07 09:00 Europe/Berlin, 2026-12-07 08:00 UTC). It was due 2 times before while nothing ran; this one card stands for them (its description lists them)."
    ]);
    expect(readEvents(f.dir).events.filter(({ event }) => event.kind === "item.created")).toHaveLength(1);
  });

  it("says once, until it changes, a run that failed; and does nothing on its timer when it is told 0", async () => {
    const f = await fixture();
    addSchedule(f.ctx, "robin", WEEKLY);
    const timer = handTimer();
    const logs: string[] = [];
    await serve(f, timer, logs);
    fs.writeFileSync(path.join(f.dir, "board.json"), "{ not json");
    f.set("2026-11-23T08:00:30Z");
    timer.tick();
    timer.tick();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^Pinboard: the schedules could not run: Refused: board\.json cannot be used: board\.json does not parse as JSON/);
    const quiet = await fixture();
    const none = handTimer();
    await serve(quiet, none, [], { schedulesEveryMs: 0 });
    expect(none.every).toBeUndefined();
  });

  it("serve says in its own log what the schedules made at its start", async () => {
    const f = await fixture();
    addSchedule(f.ctx, "robin", WEEKLY);
    f.set("2026-11-23T08:05:00Z");
    const lines: string[] = [];
    const controller = new AbortController();
    let started: (url: string) => void = () => undefined;
    const served = new Promise<string>((resolve) => (started = resolve));
    const running = runBoardServe(
      { port: "0", board: f.dir },
      { cwd: () => f.root, output: (line) => lines.push(line), now: f.now, zone: "Europe/Berlin", home: "/home/tester", pageDir: f.pageDir, signal: controller.signal, started: (url) => started(url), timers: handTimer(), stdinIsPipe: () => false }
    );
    cleanups.push(() => controller.abort());
    expect(await served).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(lines).toContain("Pinboard: The schedule check-deps put #1 in Ready: Check the dependencies (due Mon 2026-11-23 09:00 Europe/Berlin, 2026-11-23 08:00 UTC).");
    controller.abort();
    expect(await running).toBe(0);
  });
});

describe("the schedules' routes", () => {
  it("list the schedules; make, change, pause, resume and remove one as the board's person; run them; refuse a card Ready would refuse", async () => {
    const f = await fixture();
    const { call } = await serve(f, handTimer(), []);
    const empty = await call<SchedulesPayload>("GET", "/api/schedules");
    expect(empty).toEqual({ status: 200, body: { at: "2026-11-20T09:00:00Z", zone: "Europe/Berlin", ready: "ready", schedules: [], unreadable: [], command: "pinboard add-ready" } });

    // The page checks the card before it saves (a dry run): the Ready check's words, and what is missing.
    const draft = { name: "check-deps", rule: { kind: "weekly", days: ["mon"], at: "09:00" }, card: { type: "task", title: "Check the dependencies", fields: { definitionOfDone: "npm test passes" } } };
    const refused = await call<RefusalPayload>("POST", "/api/schedules", { ...draft, dryRun: true });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({
      refused: "ready",
      message:
        "The schedule's card cannot go to Ready yet: it does not name the repository, folder or files it may touch (mayTouch), and it names no limit in minutes or money (limitMinutes, limitMoney). Nothing was written: set what is missing, then make the schedule again.",
      missing: [{ what: "may-touch" }, { what: "limit" }]
    });
    const full = { ...draft, card: { ...draft.card, fields: { definitionOfDone: "npm test passes", mayTouch: ["package.json"], limitMinutes: 30 } } };
    expect(await call<ScheduleWritePayload>("POST", "/api/schedules", { ...full, dryRun: true })).toEqual({ status: 200, body: { name: "check-deps", file: "schedules/check-deps.json", next: "2026-11-23T08:00:00Z", nextWords: "Mon 2026-11-23 09:00 Europe/Berlin (2026-11-23 08:00 UTC)", events: [], dryRun: true } });
    expect(fs.existsSync(path.join(f.dir, "schedules"))).toBe(false);
    const made = await call<ScheduleWritePayload>("POST", "/api/schedules", full);
    expect(made.status).toBe(201);
    expect(made.body.events.map((event) => [event.by, event.kind, event.text])).toEqual([["robin", "schedule.added", "made the schedule check-deps: every Monday at 09:00 (Europe/Berlin)"]]);
    const listed = await call<SchedulesPayload>("GET", "/api/schedules");
    expect(listed.body.schedules[0]).toMatchObject({ name: "check-deps", words: "every Monday at 09:00", zone: "Europe/Berlin", next: { at: "2026-11-23T08:00:00Z", local: "Mon 2026-11-23 09:00", utc: "2026-11-23 08:00 UTC" }, maker: { id: "robin", name: "Robin", person: true } });

    expect((await call<ScheduleWritePayload>("PUT", "/api/schedules/check-deps", { rule: { kind: "daily", at: "08:00" } })).body.events.map((event) => event.text)).toEqual([
      "changed the schedule check-deps (its rule): every day at 08:00 (Europe/Berlin)"
    ]);
    expect((await call<ScheduleWritePayload>("POST", "/api/schedules/check-deps/pause")).body.events.map((event) => event.kind)).toEqual(["schedule.paused"]);
    expect((await call<SchedulesPayload>("GET", "/api/schedules")).body.schedules[0]).toMatchObject({ paused: { by: "robin" }, dueNow: false });
    expect((await call<ScheduleWritePayload>("POST", "/api/schedules/check-deps/resume")).body).toMatchObject({ next: "2026-11-21T07:00:00Z", events: [{ kind: "schedule.resumed" }] });

    f.set("2026-11-21T07:00:00Z");
    const ran = await call<ScheduleRunPayload>("POST", "/api/schedules/run", {});
    expect(ran.body.entries.map((entry) => [entry.outcome, entry.card?.id])).toEqual([["created", 1]]);
    // The card the schedule made says so on its tile and in its detail.
    const board = await call<BoardPayload>("GET", "/api/board");
    expect(board.body.cards[0]!.schedule).toEqual({ name: "check-deps", by: "robin", due: "2026-11-21T07:00:00Z" });
    const detail = await call<CardDetail>("GET", "/api/items/1");
    expect(detail.body.card.schedule).toEqual({ name: "check-deps", by: "robin", due: "2026-11-21T07:00:00Z" });
    expect(detail.body.activity.map((event) => event.text)).toEqual(["had the schedule check-deps put it in Ready (due 2026-11-21T07:00:00Z)", "created it by the schedule check-deps (task in Ready)"]);

    expect((await call<ScheduleWritePayload>("POST", "/api/schedules/check-deps/remove")).body.events.map((event) => event.kind)).toEqual(["schedule.removed"]);
    expect(await call<RefusalPayload>("POST", "/api/schedules/check-deps/pause")).toEqual({ status: 404, body: { refused: "not-found", message: "No schedule check-deps on the board (it has none)." } });
    moveCard(f.ctx, 1, { as: "robin", to: "done" });
  });
});
