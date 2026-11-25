import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addSchedule,
  archiveCard,
  BoardRefusal,
  boardContext,
  changeSchedule,
  createCard,
  describeEvent,
  eventLines,
  getCard,
  initBoard,
  listSchedules,
  moveCard,
  pauseSchedule,
  readBoardConfig,
  readEvents,
  readyGaps,
  removeSchedule,
  resumeSchedule,
  runSchedules,
  scheduleCardOf,
  takeCard,
  validateBoard,
  type BoardContext,
  type BoardEvent,
  type ScheduleInput
} from "../core/index.js";

/**
 * Scheduled cards in the core (core/schedules.ts): a schedule is the person's standing ask, made,
 * changed, paused and removed by a person only; at its time it puts one card in Ready, the schedule
 * person's ask; never several for one schedule (one card for the times missed while nothing ran; none
 * while its last one is still open); nothing while it is paused, and nothing made up when it resumes.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface Board {
  dir: string;
  ctx: BoardContext;
  /** Sets the board's clock. */
  set: (iso: string) => void;
  events: () => BoardEvent[];
  file: (name: string) => Record<string, unknown>;
}

/** A board of the test's own (Robin, a person; Claude, an agent), its clock at 2026-11-20 09:00 UTC (a Friday), its zone Berlin. */
async function board(options: { ready?: boolean } = {}): Promise<Board> {
  const base = await mkdtemp(path.join(os.tmpdir(), "pinboard-schedules-"));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "app");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  const dir = path.join(root, "docs", "codelead", "board");
  let time = Date.parse("2026-11-20T09:00:00Z");
  const ctx = boardContext({ dir, root, home: path.join(base, "home"), now: () => new Date(time), zone: "Europe/Berlin" });
  initBoard(ctx, { name: "test", participants: [{ id: "robin", kind: "person", name: "Robin" }, { id: "claude", kind: "agent", name: "Claude Code" }] });
  if (options.ready === false) {
    const config = readBoardConfig(dir).config;
    fs.writeFileSync(path.join(dir, "board.json"), `${JSON.stringify({ ...config, columns: config.columns.filter((column) => column.id !== "ready") }, null, 2)}\n`);
  }
  return {
    dir,
    ctx,
    set: (iso) => {
      time = Date.parse(iso);
    },
    events: () => readEvents(dir).events.map(({ event }) => event),
    file: (name) => JSON.parse(fs.readFileSync(path.join(dir, "schedules", `${name}.json`), "utf8")) as Record<string, unknown>
  };
}

const DONE = "npm outdated lists nothing that is safe to update; npm test passes.";

/** Every Monday at 09:00: check the dependencies. */
function weekly(more: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    name: "check-deps",
    rule: { kind: "weekly", days: ["mon"], at: "09:00" },
    card: { type: "task", title: "Check the dependencies", description: "Run `npm outdated`; update what is safe.", fields: { definitionOfDone: DONE, mayTouch: ["package.json", "package-lock.json"], limitMinutes: 30 } },
    ...more
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

describe("a schedule is the person's standing ask", () => {
  it("only a person makes, changes, pauses, resumes or removes one; an agent is refused in words, and nothing is written", async () => {
    const b = await board();
    const said = (verb: string): string =>
      `Refused: claude is an agent and may not ${verb}: a schedule is the person's standing ask, which puts a card in Ready at its times. Ask the person in a card's thread. Nothing was written.`;
    expect(refusal(() => addSchedule(b.ctx, "claude", weekly())).message).toBe(said("make a schedule"));
    expect(fs.existsSync(path.join(b.dir, "schedules"))).toBe(false);
    addSchedule(b.ctx, "robin", weekly());
    const before = fs.readFileSync(path.join(b.dir, "schedules", "check-deps.json"), "utf8");
    const lines = readEvents(b.dir).count;
    expect(refusal(() => changeSchedule(b.ctx, "claude", "check-deps", { title: "Mine now" })).message).toBe(said("change the schedule check-deps"));
    expect(refusal(() => pauseSchedule(b.ctx, "claude", "check-deps")).message).toBe(said("pause the schedule check-deps"));
    expect(refusal(() => resumeSchedule(b.ctx, "claude", "check-deps")).message).toBe(said("resume the schedule check-deps"));
    expect(refusal(() => removeSchedule(b.ctx, "claude", "check-deps")).message).toBe(said("remove the schedule check-deps"));
    expect(refusal(() => removeSchedule(b.ctx, "claude", "check-deps")).code).toBe("not-allowed");
    expect(fs.readFileSync(path.join(b.dir, "schedules", "check-deps.json"), "utf8")).toBe(before);
    expect(readEvents(b.dir).count).toBe(lines);
  });

  it("holds its name, rule, zone (written down when it is made), card, who made it and when; the log says it was made", async () => {
    const b = await board();
    const made = addSchedule(b.ctx, "robin", weekly());
    expect(made.file).toBe("schedules/check-deps.json");
    expect(made.next).toBe("2026-11-23T08:00:00Z");
    expect(b.file("check-deps")).toEqual({
      schema: "pinboard.schedule/1",
      name: "check-deps",
      rule: { kind: "weekly", days: ["mon"], at: "09:00" },
      zone: "Europe/Berlin",
      card: { type: "task", title: "Check the dependencies", description: "Run `npm outdated`; update what is safe.", tags: [], fields: { definitionOfDone: DONE, mayTouch: ["package.json", "package-lock.json"], limitMinutes: 30 } },
      made: { by: "robin", at: "2026-11-20T09:00:00Z" },
      since: "2026-11-20T09:00:00Z"
    });
    expect(b.events()).toEqual([{ at: "2026-11-20T09:00:00Z", by: "robin", kind: "schedule.added", data: { schedule: "check-deps", rule: { kind: "weekly", days: ["mon"], at: "09:00" }, zone: "Europe/Berlin" } }]);
    expect(describeEvent(b.events()[0]!)).toBe("made the schedule check-deps: every Monday at 09:00 (Europe/Berlin)");
    // Another zone may be named; one this machine does not know is refused.
    expect(addSchedule(b.ctx, "robin", weekly({ name: "nightly", rule: { kind: "daily", at: "02:30" }, zone: "America/New_York" })).schedule.zone).toBe("America/New_York");
    expect(refusal(() => addSchedule(b.ctx, "robin", weekly({ name: "x", zone: "Nowhere/Here" }))).code).toBe("usage");
  });

  it("is refused when its card would not pass the Ready check, with the words the check uses for a card", async () => {
    const b = await board();
    const bare = weekly({ card: { type: "task", title: "Check the dependencies" } });
    const refused = refusal(() => addSchedule(b.ctx, "robin", bare));
    expect(refused.code).toBe("ready");
    expect(refused.message).toBe(
      "The schedule's card cannot go to Ready yet: it does not say how to tell it is done (definitionOfDone), it does not name the repository, folder or files it may touch (mayTouch), and it names no limit in minutes or money (limitMinutes, limitMoney). Nothing was written: set what is missing, then make the schedule again."
    );
    // The same words a card gets for the same gaps.
    const card = refusal(() => createCard(b.ctx, "robin", { type: "task", title: "Check the dependencies", column: "ready" }));
    expect(card.message.split(" yet: ")[1]!.split(". Nothing was written")[0]).toBe(refused.message.split(" yet: ")[1]!.split(". Nothing was written")[0]);
    expect(refused.details).toEqual({ missing: readyGaps({}).map((gap) => ({ what: gap.what, fields: gap.fields, words: gap.words })) });
    // One thing missing: only that one is named.
    const noLimit = refusal(() => addSchedule(b.ctx, "robin", weekly({ card: { type: "task", title: "x", fields: { definitionOfDone: DONE, mayTouch: "src/" } } })));
    expect(noLimit.message).toBe("The schedule's card cannot go to Ready yet: it names no limit in minutes or money (limitMinutes, limitMoney). Nothing was written: set what is missing, then make the schedule again.");
    // A limit that is no number, a type the board has not, a secret, a field no schedule's card carries: refused as a card's would be.
    expect(refusal(() => addSchedule(b.ctx, "robin", weekly({ card: { ...weekly().card, fields: { ...weekly().card.fields, limitMinutes: "soon" } } }))).code).toBe("ready");
    expect(refusal(() => addSchedule(b.ctx, "robin", weekly({ card: { ...weekly().card, type: "epic" } }))).message).toBe('Refused: "epic" is not a card type of the board (question, decision, task, idea, review, note). Nothing was written.');
    expect(refusal(() => addSchedule(b.ctx, "robin", weekly({ card: { ...weekly().card, description: "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" } }))).code).toBe("secret");
    expect(refusal(() => addSchedule(b.ctx, "robin", weekly({ card: { ...weekly().card, fields: { ...weekly().card.fields, size: "M" } } }))).message).toBe(
      'Refused: "size" is not a field a schedule\'s card carries (definitionOfDone, mayTouch, limitMinutes, limitMoney). Nothing was written.'
    );
    expect(fs.existsSync(path.join(b.dir, "schedules"))).toBe(false);
    expect(b.events()).toEqual([]);
  });

  it("is refused under a name the board has already, or a name that is no short word", async () => {
    const b = await board();
    addSchedule(b.ctx, "robin", weekly());
    const twice = refusal(() => addSchedule(b.ctx, "robin", weekly()));
    expect([twice.code, twice.message]).toEqual([
      "schedule",
      "Refused: the board has a schedule check-deps already (schedules/check-deps.json): change it with `codelead board schedules change check-deps`, or give the new one another name. Nothing was written."
    ]);
    expect(refusal(() => addSchedule(b.ctx, "robin", weekly({ name: "Check Deps" }))).message).toBe(
      'Refused: "Check Deps" is not a schedule\'s name: a short word of lower-case letters, digits and "-" (check-deps), up to 48 of them. Nothing was written.'
    );
  });

  it("on a board without Ready, is refused in words that name the command that adds the column", async () => {
    const b = await board({ ready: false });
    const refused = refusal(() => addSchedule(b.ctx, "robin", weekly()));
    expect([refused.code, refused.message]).toEqual([
      "column",
      "Refused: this board has no Ready column, and a schedule puts its card there. `codelead board add-ready` gives the board its Ready column. Nothing was written."
    ]);
    expect(runSchedules(b.ctx)).toMatchObject({ entries: [], reason: "no-schedules" });
  });
});

describe("running what is due", () => {
  it("at its time puts one card in Ready: the schedule person's ask, by the schedule, tagged scheduled:<name>, related to nothing", async () => {
    const b = await board();
    addSchedule(b.ctx, "robin", weekly());
    // Before its time: nothing, and not even the lock is taken.
    b.set("2026-11-23T07:59:00Z");
    expect(runSchedules(b.ctx)).toEqual({ at: "2026-11-23T07:59:00Z", entries: [], events: [], reason: "nothing-due", words: "Nothing is due. The next is check-deps, Mon 2026-11-23 09:00 Europe/Berlin (2026-11-23 08:00 UTC).", next: { schedule: "check-deps", due: "2026-11-23T08:00:00Z", words: "Mon 2026-11-23 09:00 Europe/Berlin (2026-11-23 08:00 UTC)" } });
    expect(fs.existsSync(path.join(b.dir, ".board.lock"))).toBe(false);
    b.set("2026-11-23T08:00:20Z");
    const run = runSchedules(b.ctx);
    expect(run.entries).toHaveLength(1);
    expect(run.entries[0]).toMatchObject({ schedule: "check-deps", outcome: "created", due: "2026-11-23T08:00:00Z", missedCount: 0, missed: [], card: { id: 1, column: "ready", title: "Check the dependencies" } });
    expect(run.entries[0]!.words).toBe("The schedule check-deps put #1 in Ready: Check the dependencies (due Mon 2026-11-23 09:00 Europe/Berlin, 2026-11-23 08:00 UTC).");
    const card = getCard(b.ctx, 1).card;
    expect(card).toMatchObject({
      type: "task",
      title: "Check the dependencies",
      column: "ready",
      author: "robin",
      tags: ["scheduled:check-deps"],
      relations: [],
      schedule: { name: "check-deps", by: "robin", due: "2026-11-23T08:00:00Z" },
      fields: { definitionOfDone: DONE, mayTouch: ["package.json", "package-lock.json"], limitMinutes: 30 }
    });
    expect(card.description).toBe("Run `npm outdated`; update what is safe.\n\nMade by the schedule `check-deps` (Robin's): every Monday at 09:00, Europe/Berlin. Due Mon 2026-11-23 09:00 Europe/Berlin (2026-11-23 08:00 UTC).");
    // The card's file says whose schedule made it.
    expect(fs.readFileSync(path.join(b.dir, card.file), "utf8")).toContain("\nschedule:\n  name: check-deps\n  by: robin\n  due: 2026-11-23T08:00:00Z\n");
    // The log: the card created by the schedule (its person's ask), then the schedule's run; one line where they are read.
    const events = b.events().slice(1);
    expect(events.map((event) => [event.by, event.item, event.kind, event.data])).toEqual([
      ["robin", 1, "item.created", { title: "Check the dependencies", type: "task", column: "ready", schedule: "check-deps", due: "2026-11-23T08:00:00Z" }],
      ["robin", 1, "schedule.ran", { schedule: "check-deps", due: "2026-11-23T08:00:00Z" }]
    ]);
    expect(eventLines(events, readBoardConfig(b.dir).config).map((line) => line.text)).toEqual(["created it by the schedule check-deps (task in Ready), due 2026-11-23T08:00:00Z"]);
    expect(run.events).toEqual(events);
    // The schedule's file keeps the last run.
    expect(b.file("check-deps")).toMatchObject({ last: { due: "2026-11-23T08:00:00Z", at: "2026-11-23T08:00:20Z", card: 1 }, lastCard: { id: 1, due: "2026-11-23T08:00:00Z", at: "2026-11-23T08:00:20Z" } });
    expect(validateBoard(b.ctx).problems).toEqual([]);
    // The dispatcher gives it out like any other Ready card.
    expect(takeCard(b.ctx, { as: "claude" })).toMatchObject({ given: true, card: { id: 1 } });
  });

  it("never makes several for one schedule: the times missed while nothing ran make one card, whose description says which", async () => {
    const b = await board();
    addSchedule(b.ctx, "robin", weekly());
    // Nothing ran for three Mondays: the next run makes one card, for the last of them.
    b.set("2026-12-08T10:00:00Z");
    const run = runSchedules(b.ctx);
    expect(run.entries.map((entry) => [entry.outcome, entry.due, entry.missedCount, entry.missed])).toEqual([["created", "2026-12-07T08:00:00Z", 2, ["2026-11-23T08:00:00Z", "2026-11-30T08:00:00Z"]]]);
    expect(run.entries[0]!.words).toBe(
      "The schedule check-deps put #1 in Ready: Check the dependencies (due Mon 2026-12-07 09:00 Europe/Berlin, 2026-12-07 08:00 UTC). It was due 2 times before while nothing ran; this one card stands for them (its description lists them)."
    );
    expect(getCard(b.ctx, 1).card.description).toContain(
      "It was due before too, while nothing ran, and those times are not made up: this card stands for them. Missed: Mon 2026-11-23 09:00, Mon 2026-11-30 09:00 (Europe/Berlin)."
    );
    expect(b.events().filter((event) => event.kind === "item.created")).toHaveLength(1);
    expect(b.events().find((event) => event.kind === "schedule.ran")?.data).toEqual({ schedule: "check-deps", due: "2026-12-07T08:00:00Z", missed: 2 });
    // Run again at the same moment: nothing more.
    expect(runSchedules(b.ctx).entries).toEqual([]);
    expect(b.events().filter((event) => event.kind === "item.created")).toHaveLength(1);
  });

  it("says how many times were missed when there were many, and lists none of them one by one", async () => {
    const b = await board();
    addSchedule(b.ctx, "robin", weekly({ name: "tick", rule: { kind: "every", count: 1, unit: "hours", from: "2026-11-20T11:00" } }));
    b.set("2026-11-23T09:30:00Z");
    const [entry] = runSchedules(b.ctx).entries;
    // Every hour from 11:00 on the Friday (10:00 UTC) to 10:00 on the Monday (09:00 UTC): 72 times, the last one the card's.
    expect([entry!.missedCount, entry!.missed.length, entry!.due]).toEqual([71, 10, "2026-11-23T09:00:00Z"]);
    expect(getCard(b.ctx, 1).card.description).toContain("Missed: 71 times, from Fri 2026-11-20 11:00 (Europe/Berlin) on.");
  });

  it("makes no new card while the last one is still open (in Ready or In progress), says why once per time it was due, and makes the next once it is closed", async () => {
    const b = await board();
    addSchedule(b.ctx, "robin", weekly());
    b.set("2026-11-23T08:01:00Z");
    runSchedules(b.ctx);
    // The next Monday, #1 is still in Ready: no card; why is in the answer, the schedule's file and the log (on #1).
    b.set("2026-11-30T08:01:00Z");
    const skipped = runSchedules(b.ctx);
    expect(skipped.entries.map((entry) => [entry.outcome, entry.words])).toEqual([
      ["skipped", "The schedule check-deps was due Mon 2026-11-30 09:00 Europe/Berlin (2026-11-30 08:00 UTC) and made no card: the last one, #1, is still open (in Ready)."]
    ]);
    expect(b.file("check-deps")).toMatchObject({ last: { due: "2026-11-30T08:00:00Z", skipped: "the last one, #1, is still open (in Ready)", open: 1 }, lastCard: { id: 1 } });
    const skip = b.events().at(-1)!;
    expect([skip.kind, skip.item, skip.by, skip.data]).toEqual(["schedule.skipped", 1, "robin", { schedule: "check-deps", due: "2026-11-30T08:00:00Z", why: "open", open: 1 }]);
    expect(describeEvent(skip)).toBe("had the schedule check-deps due at 2026-11-30T08:00:00Z: no new card, as #1 is still open");
    // Said once for that time: a run a minute later writes nothing.
    b.set("2026-11-30T08:02:00Z");
    const lines = readEvents(b.dir).count;
    expect(runSchedules(b.ctx).entries).toEqual([]);
    expect(readEvents(b.dir).count).toBe(lines);
    // Taken by an agent (In progress): still open.
    expect(takeCard(b.ctx, { as: "claude" })).toMatchObject({ given: true, card: { id: 1 } });
    b.set("2026-12-07T08:01:00Z");
    expect(runSchedules(b.ctx).entries.map((entry) => entry.words)).toEqual([
      "The schedule check-deps was due Mon 2026-12-07 09:00 Europe/Berlin (2026-12-07 08:00 UTC) and made no card: the last one, #1, is still open (in In progress)."
    ]);
    // Handed to For review: the next time it is due makes the next card (not at once: the time it skipped is not made up).
    moveCard(b.ctx, 1, { as: "claude", to: "for-review", comment: "Landed: updated 3 packages." });
    expect(runSchedules(b.ctx).entries).toEqual([]);
    b.set("2026-12-14T08:00:00Z");
    expect(runSchedules(b.ctx).entries.map((entry) => [entry.outcome, entry.card?.id])).toEqual([["created", 2]]);
    expect(b.file("check-deps")).toMatchObject({ lastCard: { id: 2 } });
  });

  it("counts a card in Done, or archived, as closed", async () => {
    const b = await board();
    addSchedule(b.ctx, "robin", weekly());
    b.set("2026-11-23T08:00:00Z");
    runSchedules(b.ctx);
    moveCard(b.ctx, 1, { as: "robin", to: "done" });
    b.set("2026-11-30T08:00:00Z");
    expect(runSchedules(b.ctx).entries.map((entry) => entry.card?.id)).toEqual([2]);
    archiveCard(b.ctx, 2, { as: "robin" });
    b.set("2026-12-07T08:00:00Z");
    expect(runSchedules(b.ctx).entries.map((entry) => entry.card?.id)).toEqual([3]);
  });

  it("makes nothing while paused, and does not make up the times it missed when it resumes", async () => {
    const b = await board();
    addSchedule(b.ctx, "robin", weekly());
    b.set("2026-11-21T10:00:00Z");
    const paused = pauseSchedule(b.ctx, "robin", "check-deps");
    expect(paused.events.map((event) => event.kind)).toEqual(["schedule.paused"]);
    expect(b.file("check-deps")).toMatchObject({ paused: { by: "robin", at: "2026-11-21T10:00:00Z" } });
    // Paused again: nothing written.
    expect(pauseSchedule(b.ctx, "robin", "check-deps").events).toEqual([]);
    b.set("2026-12-02T10:00:00Z");
    expect(runSchedules(b.ctx)).toMatchObject({ entries: [], reason: "nothing-due", words: "Nothing is due: every schedule is paused." });
    const resumed = resumeSchedule(b.ctx, "robin", "check-deps");
    expect(resumed.next).toBe("2026-12-07T08:00:00Z");
    expect(b.file("check-deps")).toMatchObject({ since: "2026-12-02T10:00:00Z" });
    expect(b.file("check-deps").paused).toBeUndefined();
    // The two Mondays while it was paused are not made up.
    expect(runSchedules(b.ctx).entries).toEqual([]);
    b.set("2026-12-07T08:00:00Z");
    expect(runSchedules(b.ctx).entries.map((entry) => [entry.due, entry.missedCount])).toEqual([["2026-12-07T08:00:00Z", 0]]);
    expect(b.events().map((event) => event.kind)).toEqual(["schedule.added", "schedule.paused", "schedule.resumed", "item.created", "schedule.ran"]);
  });

  it("at a time the clock skips makes its card an hour later; at a time the clock passes twice, once", async () => {
    const b = await board();
    b.set("2026-03-27T12:00:00Z");
    addSchedule(b.ctx, "robin", weekly({ name: "nightly", rule: { kind: "daily", at: "02:30" } }));
    // The night before, 02:30 is 01:30 UTC (UTC+1).
    b.set("2026-03-28T01:30:00Z");
    expect(runSchedules(b.ctx).entries.map((entry) => entry.due)).toEqual(["2026-03-28T01:30:00Z"]);
    moveCard(b.ctx, 1, { as: "robin", to: "done" });
    // 2026-03-29: Berlin's clock jumps from 02:00 to 03:00, so 02:30 is due at 03:30 (01:30 UTC): not at 02:30 by the old clock, nor by the new one.
    for (const early of ["2026-03-29T00:30:00Z", "2026-03-29T01:00:00Z", "2026-03-29T01:29:00Z"]) {
      b.set(early);
      expect(runSchedules(b.ctx).entries).toEqual([]);
    }
    b.set("2026-03-29T01:30:00Z");
    expect(runSchedules(b.ctx).entries.map((entry) => [entry.due, entry.missedCount])).toEqual([["2026-03-29T01:30:00Z", 0]]);
    expect(getCard(b.ctx, 2).card.description).toContain("Due Sun 2026-03-29 03:30 Europe/Berlin (2026-03-29 01:30 UTC).");
    moveCard(b.ctx, 2, { as: "robin", to: "done" });
    // The night after, 02:30 is 00:30 UTC (UTC+2).
    b.set("2026-03-30T00:30:00Z");
    expect(runSchedules(b.ctx).entries.map((entry) => entry.due)).toEqual(["2026-03-30T00:30:00Z"]);
    // 2026-10-25: the clock goes back from 03:00 to 02:00, so 02:30 comes twice; the card comes once.
    const fall = await board();
    fall.set("2026-10-24T12:00:00Z");
    addSchedule(fall.ctx, "robin", weekly({ name: "nightly", rule: { kind: "daily", at: "02:30" } }));
    fall.set("2026-10-25T00:30:00Z");
    expect(runSchedules(fall.ctx).entries.map((entry) => entry.due)).toEqual(["2026-10-25T00:30:00Z"]);
    moveCard(fall.ctx, 1, { as: "robin", to: "done" });
    fall.set("2026-10-25T01:30:00Z");
    expect(runSchedules(fall.ctx)).toMatchObject({ entries: [], reason: "nothing-due", next: { due: "2026-10-26T01:30:00Z" } });
  });

  it("two runs at the same moment make one card: the second finds the time dealt with", async () => {
    const b = await board();
    addSchedule(b.ctx, "robin", weekly());
    b.set("2026-11-23T08:00:00Z");
    const first = runSchedules(b.ctx);
    const second = runSchedules(b.ctx);
    expect([first.entries.length, second.entries.length]).toEqual([1, 0]);
    expect(b.events().filter((event) => event.kind === "item.created")).toHaveLength(1);
  });

  it("says, and writes nothing, when the schedule's person is no person of the board now; records it when the board refuses its card", async () => {
    const b = await board();
    addSchedule(b.ctx, "robin", weekly());
    const config = readBoardConfig(b.dir).config;
    fs.writeFileSync(path.join(b.dir, "board.json"), `${JSON.stringify({ ...config, participants: config.participants.filter((entry) => entry.id !== "robin").concat({ id: "sam", kind: "person", name: "Sam" }) }, null, 2)}\n`);
    b.set("2026-11-23T08:00:00Z");
    const lines = readEvents(b.dir).count;
    const held = runSchedules(b.ctx);
    expect(held.entries.map((entry) => [entry.outcome, entry.words])).toEqual([
      ["held", "The schedule check-deps was due Mon 2026-11-23 09:00 Europe/Berlin (2026-11-23 08:00 UTC) and made no card: it was made by robin, who is not a participant of the board now. A person of the board makes it again (remove it, then add it)."]
    ]);
    expect(readEvents(b.dir).count).toBe(lines);
    expect(validateBoard(b.ctx).problems.map((problem) => `${problem.file}: ${problem.message}`)).toContain(
      'schedules/check-deps.json: it was made by "robin", who is not a participant of the board; it makes no card until a person makes it again'
    );
    // Robin is back, and the board no longer has the type of the schedule's card: the run says the board's words, once.
    fs.writeFileSync(path.join(b.dir, "board.json"), `${JSON.stringify({ ...config, types: config.types.filter((type) => type !== "task") }, null, 2)}\n`);
    const refused = runSchedules(b.ctx);
    expect(refused.entries.map((entry) => [entry.outcome, entry.words])).toEqual([
      [
        "skipped",
        'The schedule check-deps was due Mon 2026-11-23 09:00 Europe/Berlin (2026-11-23 08:00 UTC) and made no card: the board refused its card: Refused: "task" is not a card type of the board (question, decision, idea, review, note). Nothing was written.'
      ]
    ]);
    expect(b.events().at(-1)).toMatchObject({ kind: "schedule.skipped", by: "robin", data: { schedule: "check-deps", due: "2026-11-23T08:00:00Z", why: "refused", refused: "type" } });
    expect(runSchedules(b.ctx).entries).toEqual([]);
  });

  it("does nothing on a board without Ready, and says which command adds it", async () => {
    const b = await board();
    addSchedule(b.ctx, "robin", weekly());
    const config = readBoardConfig(b.dir).config;
    fs.writeFileSync(path.join(b.dir, "board.json"), `${JSON.stringify({ ...config, columns: config.columns.filter((column) => column.id !== "ready") }, null, 2)}\n`);
    b.set("2026-11-23T08:00:00Z");
    const lines = readEvents(b.dir).count;
    expect(runSchedules(b.ctx)).toMatchObject({
      entries: [],
      reason: "no-ready-column",
      words: "This board has no Ready column, so no schedule makes a card: a schedule puts its card in Ready. `codelead board add-ready` gives the board its Ready column."
    });
    expect(readEvents(b.dir).count).toBe(lines);
  });
});

describe("changing, removing, listing, and a schedule from a card", () => {
  it("a new rule counts its times from now; a new card is checked; nothing to change writes nothing", async () => {
    const b = await board();
    addSchedule(b.ctx, "robin", weekly());
    b.set("2026-11-23T09:00:00Z");
    // Nothing ran at 09:00 on the Monday; the rule changes at 10:00 (local) to Mondays and Thursdays: that Monday is not made up.
    const changed = changeSchedule(b.ctx, "robin", "check-deps", { rule: { kind: "weekly", days: ["mon", "thu"], at: "09:00" } });
    expect(changed.events.map((event) => [event.kind, event.data])).toEqual([["schedule.changed", { schedule: "check-deps", changed: ["rule"], rule: { kind: "weekly", days: ["mon", "thu"], at: "09:00" }, zone: "Europe/Berlin" }]]);
    expect(describeEvent(changed.events[0]!)).toBe("changed the schedule check-deps (its rule): every Monday and Thursday at 09:00 (Europe/Berlin)");
    expect(changed.next).toBe("2026-11-26T08:00:00Z");
    expect(runSchedules(b.ctx).entries).toEqual([]);
    expect(changeSchedule(b.ctx, "robin", "check-deps", { title: "Check the dependencies" }).events).toEqual([]);
    expect(refusal(() => changeSchedule(b.ctx, "robin", "check-deps", { fields: { limitMinutes: null } })).code).toBe("ready");
    const card = changeSchedule(b.ctx, "robin", "check-deps", { title: "Check and update the dependencies", addTags: ["for:claude"] });
    expect(card.events[0]!.data).toEqual({ schedule: "check-deps", changed: ["card"] });
    expect(b.file("check-deps")).toMatchObject({ since: "2026-11-23T09:00:00Z", changed: { by: "robin", at: "2026-11-23T09:00:00Z" }, card: { title: "Check and update the dependencies", tags: ["for:claude"] } });
    expect(refusal(() => changeSchedule(b.ctx, "robin", "nope", { title: "x" })).message).toBe("No schedule nope on the board (its schedules: check-deps).");
  });

  it("removing one leaves the cards it made on the board", async () => {
    const b = await board();
    addSchedule(b.ctx, "robin", weekly());
    b.set("2026-11-23T08:00:00Z");
    runSchedules(b.ctx);
    const removed = removeSchedule(b.ctx, "robin", "check-deps");
    expect(removed).toMatchObject({ name: "check-deps", file: "schedules/check-deps.json", events: [{ kind: "schedule.removed", by: "robin", data: { schedule: "check-deps" } }] });
    expect(fs.existsSync(path.join(b.dir, "schedules", "check-deps.json"))).toBe(false);
    expect(getCard(b.ctx, 1).card.column).toBe("ready");
    expect(validateBoard(b.ctx).problems).toEqual([]);
    expect(refusal(() => removeSchedule(b.ctx, "robin", "check-deps")).message).toBe("No schedule check-deps on the board (it has none).");
  });

  it("lists each with its rule in words, the next time in its zone and in UTC, and the last card it made", async () => {
    const b = await board();
    addSchedule(b.ctx, "robin", weekly());
    expect(listSchedules(b.ctx).schedules[0]).toMatchObject({ name: "check-deps", words: "every Monday at 09:00", zone: "Europe/Berlin", next: { at: "2026-11-23T08:00:00Z", local: "Mon 2026-11-23 09:00", utc: "2026-11-23 08:00 UTC" }, dueNow: false });
    b.set("2026-11-23T08:30:00Z");
    expect(listSchedules(b.ctx).schedules[0]).toMatchObject({ dueNow: true, next: { at: "2026-11-23T08:00:00Z" } });
    runSchedules(b.ctx);
    expect(listSchedules(b.ctx).schedules[0]).toMatchObject({ dueNow: false, next: { at: "2026-11-30T08:00:00Z" }, lastCard: { id: 1, title: "Check the dependencies", column: "ready", open: true }, open: { id: 1, column: "ready" } });
  });

  it("takes a schedule's card from a card: type, title, description without the schedule's note, tags but by: ones, the Ready fields", async () => {
    const b = await board();
    createCard(b.ctx, "claude", { type: "task", title: "Rotate the logs", column: "backlog", tags: ["area:ops"], description: "Keep a week.", fields: { definitionOfDone: "Older logs are gone", mayTouch: "logs/", limitMinutes: 10, size: "S" } });
    expect(scheduleCardOf(b.ctx, 1)).toEqual({ type: "task", title: "Rotate the logs", description: "Keep a week.", tags: ["area:ops"], fields: { definitionOfDone: "Older logs are gone", mayTouch: "logs/", limitMinutes: 10 } });
    addSchedule(b.ctx, "robin", { name: "logs", rule: { kind: "daily", at: "06:00" }, card: scheduleCardOf(b.ctx, 1) });
    b.set("2026-11-21T05:00:00Z");
    runSchedules(b.ctx);
    expect(scheduleCardOf(b.ctx, 2)).toEqual({ type: "task", title: "Rotate the logs", description: "Keep a week.", tags: ["area:ops"], fields: { definitionOfDone: "Older logs are gone", mayTouch: "logs/", limitMinutes: 10 } });
  });
});

describe("a board made before schedules", () => {
  it("works as it is: no schedules folder, nothing to run, the list empty, valid", async () => {
    const b = await board();
    expect(runSchedules(b.ctx)).toEqual({ at: "2026-11-20T09:00:00Z", entries: [], events: [], reason: "no-schedules", words: "This board has no schedules: nothing to run." });
    expect(listSchedules(b.ctx)).toEqual({ at: "2026-11-20T09:00:00Z", zone: "Europe/Berlin", ready: "ready", schedules: [], unreadable: [] });
    expect(validateBoard(b.ctx)).toEqual({ problems: [], cards: 0, events: 0, cursors: 0 });
    expect(fs.existsSync(path.join(b.dir, "schedules"))).toBe(false);
  });

  it("validate names a schedule's file it cannot read, and the run leaves it", async () => {
    const b = await board();
    fs.mkdirSync(path.join(b.dir, "schedules"));
    fs.writeFileSync(path.join(b.dir, "schedules", "broken.json"), "{ not json");
    fs.writeFileSync(path.join(b.dir, "schedules", "cron.json"), JSON.stringify({ schema: "pinboard.schedule/1", name: "cron", rule: "0 9 * * 1" }));
    const problems = validateBoard(b.ctx).problems.map((problem) => `${problem.file}: ${problem.message}`);
    expect(problems[0]).toBe("schedules/broken.json: is not JSON");
    expect(problems.some((problem) => problem.startsWith('schedules/cron.json: "rule" cannot be read: a schedule\'s rule is'))).toBe(true);
    expect(runSchedules(b.ctx)).toMatchObject({ entries: [], reason: "nothing-due" });
    expect(listSchedules(b.ctx).unreadable.map((entry) => entry.file)).toEqual(["schedules/broken.json", "schedules/cron.json"]);
  });
});
