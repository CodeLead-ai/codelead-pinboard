import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addSchedule, boardContext, createCards, getCard, initBoard, localTimeAt, pauseSchedule, readBoard, readEvents, readSchedules, validateBoard, type Participant, type ScheduleInput } from "../core/index.js";
import { atOnce, buildCode, type Built, type Ran } from "./built.js";

/**
 * Two hosts that run the schedules at the same moment make one card per schedule: separate
 * processes of the built bin (`pinboard schedules run --json`), started at one moment against one
 * board, many rounds. Each board has schedules due now by the real clock: one due four times while
 * nothing ran, one due six times, one due daily for four days, one whose last card is still open,
 * one paused. What the processes say, the card files, the schedules' files and the log must tell one
 * story: one card for each of the first three, one record of why for the fourth, nothing for the
 * fifth; and a second wave makes nothing.
 */

const ROUNDS = 10;
const PROCESSES = 8;
const MINUTE = 60_000;

let base: string;
let built: Built;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "pinboard-schedules-parallel-"));
  built = buildCode(base);
}, 60_000);

afterAll(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

const PEOPLE: Participant[] = [
  { id: "robin", kind: "person", name: "Robin" },
  { id: "claude", kind: "agent", name: "Claude Code" }
];

const CARD = (title: string): ScheduleInput["card"] => ({ type: "task", title, fields: { definitionOfDone: "npm test passes", mayTouch: [`src/${title.toLowerCase()}/`], limitMinutes: 30 } });

/** A board whose schedules are due by the real clock now (in UTC). */
function makeBoard(round: number): { dir: string } {
  const root = path.join(base, `round-${round}`, "app");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  const dir = path.join(root, "docs", "codelead", "board");
  const now = Math.floor(Date.now() / MINUTE) * MINUTE;
  const at = (offset: number) => boardContext({ dir, root, home: path.join(base, "home"), now: () => new Date(now + offset), zone: "UTC" });
  const fourHours = at(-4 * 60 * MINUTE);
  initBoard(fourHours, { name: "parallel", participants: PEOPLE });
  const from = (offset: number): string => localTimeAt(now + offset, "UTC");
  // Every hour from 3 h 30 ago: due 4 times; the next in 30 minutes.
  addSchedule(fourHours, "robin", { name: "hourly", rule: { kind: "every", count: 60, unit: "minutes", from: from(-210 * MINUTE) }, card: CARD("Hourly") });
  // Every 45 minutes from 3 h 45 ago: due 6 times; the next in 30 minutes.
  addSchedule(fourHours, "robin", { name: "often", rule: { kind: "every", count: 45, unit: "minutes", from: from(-225 * MINUTE) }, card: CARD("Often") });
  // Every day at the time of day of two hours ago, made three days and three hours ago: due 4 times; the next tomorrow.
  const clock = from(-120 * MINUTE).slice(11);
  addSchedule(at(-3 * 24 * 60 * MINUTE - 3 * 60 * MINUTE), "robin", { name: "daily", rule: { kind: "daily", at: clock }, card: CARD("Daily") });
  // Like the hourly one, with its last card still in Ready: due, and it makes none.
  addSchedule(fourHours, "robin", { name: "blocked", rule: { kind: "every", count: 60, unit: "minutes", from: from(-210 * MINUTE) }, card: CARD("Blocked") });
  createCards(fourHours, "robin", [{ type: "task", title: "Blocked, the last one", column: "ready", tags: ["scheduled:blocked"], fields: CARD("Blocked").fields!, schedule: { name: "blocked", by: "robin", due: new Date(now - 4 * 60 * MINUTE).toISOString().replace(/\.000Z$/, "Z") } }], { tagCreator: false });
  // Paused: due, and it makes nothing.
  addSchedule(fourHours, "robin", { name: "paused", rule: { kind: "every", count: 30, unit: "minutes", from: from(-230 * MINUTE) }, card: CARD("Paused") });
  pauseSchedule(fourHours, "robin", "paused");
  return { dir };
}

interface Entry {
  schedule: string;
  outcome: "created" | "skipped" | "held";
  missedCount: number;
  card?: { id: number };
  open?: { id: number };
}

/** Each process run, asked again as its words say when the board was busy. */
async function runAll(round: number, wave: string, dir: string): Promise<{ answers: Array<{ entries: Entry[]; reason?: string }>; busy: number }> {
  const warm = path.join(built.dist, "cli", "board.js");
  const args = [built.cli, "schedules", "run", "--json", "--board", dir];
  const ran = await atOnce(path.join(base, `round-${round}`, `${wave}-gate`), warm, Array.from({ length: PROCESSES }, () => ({ args })));
  const answers: Array<{ entries: Entry[]; reason?: string }> = [];
  let busy = 0;
  for (const [index, first] of ran.entries()) {
    let result: Ran = first;
    while (result.code === 1 && /"refused": ?"busy"/.test(result.stdout)) {
      busy += 1;
      [result] = await atOnce(path.join(base, `round-${round}`, `${wave}-again-${index}`), warm, [{ args }]);
    }
    expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
    answers.push(JSON.parse(result.stdout) as { entries: Entry[]; reason?: string });
  }
  return { answers, busy };
}

describe("the schedules across processes", () => {
  it(
    `make one card per schedule that is due, in ${ROUNDS} rounds of ${PROCESSES} processes at once, and the files and the log say the same`,
    async () => {
      let busy = 0;
      for (let round = 0; round < ROUNDS; round += 1) {
        const { dir } = makeBoard(round);
        const first = await runAll(round, "first", dir);
        busy += first.busy;
        const entries = first.answers.flatMap((answer) => answer.entries);
        // What the processes say: each schedule that was due dealt with once, by one process; the paused one by none.
        const created = entries.filter((entry) => entry.outcome === "created");
        expect(created.map((entry) => entry.schedule).sort(), `round ${round}: ${JSON.stringify(entries)}`).toEqual(["daily", "hourly", "often"]);
        expect(Object.fromEntries(created.map((entry) => [entry.schedule, entry.missedCount]))).toEqual({ daily: 3, hourly: 3, often: 5 });
        const skipped = entries.filter((entry) => entry.outcome === "skipped");
        expect(skipped.map((entry) => [entry.schedule, entry.open?.id])).toEqual([["blocked", 1]]);
        expect(entries).toHaveLength(4);
        const ids = created.map((entry) => entry.card!.id);
        expect(new Set(ids).size).toBe(3);
        expect([...ids].sort()).toEqual([2, 3, 4]);

        // What the files say: three new cards in Ready, each by its schedule; the schedules' files keep what was done.
        const ctx = boardContext({ dir });
        expect(readBoard(ctx).cards).toHaveLength(4);
        for (const entry of created) expect(getCard(ctx, entry.card!.id).card).toMatchObject({ column: "ready", author: "robin", schedule: { name: entry.schedule, by: "robin" }, tags: [`scheduled:${entry.schedule}`] });
        const files = Object.fromEntries(readSchedules(dir).map((loaded) => [loaded.name, loaded.schedule!]));
        for (const entry of created) expect(files[entry.schedule]!.last?.card).toBe(entry.card!.id);
        expect(files.blocked!.last).toMatchObject({ skipped: "#1, a card it made, is still open (in Ready)", open: 1 });
        expect(files.paused!.last).toBeUndefined();

        // What the log says: one creation and one run per card, one record of why for the blocked one; nothing else after the setup.
        const events = readEvents(dir).events.map(({ event }) => event);
        const made = events.filter((event) => event.kind === "item.created" && event.data?.due !== undefined);
        expect(made.map((event) => [event.item, event.data?.schedule]).sort()).toEqual(created.map((entry) => [entry.card!.id, entry.schedule]).sort());
        expect(events.filter((event) => event.kind === "schedule.ran").map((event) => [event.item, event.data?.schedule]).sort()).toEqual(created.map((entry) => [entry.card!.id, entry.schedule]).sort());
        expect(events.filter((event) => event.kind === "schedule.skipped").map((event) => [event.item, event.data?.schedule])).toEqual([[1, "blocked"]]);
        // Setup: five schedules made, one card, one pause; then 3 cards with their runs, and one skip.
        expect(events).toHaveLength(5 + 1 + 1 + 3 * 2 + 1);
        expect(validateBoard(ctx).problems).toEqual([]);

        // A second wave, at once again: nothing is due any more, and nothing is written.
        const lines = readEvents(dir).count;
        const second = await runAll(round, "second", dir);
        busy += second.busy;
        expect(second.answers.flatMap((answer) => answer.entries)).toEqual([]);
        expect(second.answers.every((answer) => answer.reason === "nothing-due")).toBe(true);
        expect(readEvents(dir).count).toBe(lines);
      }
      // How often a process had to ask again is said, not hidden.
      if (busy > 0) console.log(`the board was busy for ${busy} run(s); each ran again`);
    },
    240_000
  );
});
