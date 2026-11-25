import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBoardCommand,
  runBoardInit,
  runBoardMove,
  runBoardNew,
  runBoardScheduleAdd,
  runBoardScheduleChange,
  runBoardSchedules,
  runBoardSchedulesRun,
  runBoardScheduleState,
  runBoardValidate,
  type BoardCliDependencies
} from "../cli/index.js";
import { readBoardConfig, readEvents } from "../core/index.js";

/**
 * The schedules' commands, each through its function, with the words a person reads and the exit
 * code: `schedules` (the list), `schedules add|change|pause|resume|remove`, `schedules run`.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Terminal {
  root: string;
  dir: string;
  deps: BoardCliDependencies;
  set: (iso: string) => void;
  said: () => string;
}

/** A repository with a board (Robin, Claude Code), a terminal in it, its clock at Friday 2026-11-20 10:00 in Berlin. */
async function terminal(options: { ready?: boolean } = {}): Promise<Terminal> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pinboard-schedules-cli-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".git"));
  let time = Date.parse("2026-11-20T09:00:00Z");
  const lines: string[] = [];
  const deps: BoardCliDependencies = { cwd: () => root, output: (line) => lines.push(line), now: () => new Date(time), home: "/home/tester", command: "pinboard", zone: "Europe/Berlin" };
  expect(await runBoardInit({ name: "test", person: ["robin:Robin"], agent: ["claude:Claude Code"] }, deps)).toBe(0);
  lines.splice(0);
  const dir = path.join(root, "docs", "codelead", "board");
  if (options.ready === false) {
    const config = readBoardConfig(dir).config;
    fs.writeFileSync(path.join(dir, "board.json"), `${JSON.stringify({ ...config, columns: config.columns.filter((column) => column.id !== "ready") }, null, 2)}\n`);
  }
  return {
    root,
    dir,
    deps,
    set: (iso) => {
      time = Date.parse(iso);
    },
    said: () => lines.splice(0).join("\n")
  };
}

const DONE = "definitionOfDone=npm outdated lists nothing that is safe to update; npm test passes.";
const CARD = { title: "Check the dependencies", body: "Run `npm outdated`; update what is safe.", field: [DONE, 'mayTouch=["package.json", "package-lock.json"]', "limitMinutes=30"] };

describe("schedules: the list", () => {
  it("on a board made before schedules says there is none, and how to make one; without Ready, how to add it", async () => {
    const term = await terminal();
    expect(await runBoardSchedules({}, term.deps)).toBe(0);
    expect(term.said()).toBe("This board has no schedules. `pinboard schedules add <name> --as <person> …` makes one (`pinboard schedules add --help` says how): at its times it puts a card in Ready.");
    expect(fs.existsSync(path.join(term.dir, "schedules"))).toBe(false);
    const old = await terminal({ ready: false });
    expect(await runBoardSchedules({}, old.deps)).toBe(0);
    expect(old.said()).toBe(
      "This board has no schedules. `pinboard schedules add <name> --as <person> …` makes one (`pinboard schedules add --help` says how): at its times it puts a card in Ready.\nThe board has no Ready column either: `pinboard add-ready` gives it one."
    );
    expect(await runBoardSchedules({ json: true }, term.deps)).toBe(0);
    expect(JSON.parse(term.said())).toEqual({ at: "2026-11-20T09:00:00Z", zone: "Europe/Berlin", ready: "ready", schedules: [], unreadable: [] });
  });

  it("says each schedule's rule, its next time in its zone and in UTC, whether it is paused, and its last card", async () => {
    const term = await terminal();
    await runBoardScheduleAdd("check-deps", { as: "robin", weekly: "mon", at: "09:00", ...CARD }, term.deps);
    term.said();
    expect(await runBoardSchedules({}, term.deps)).toBe(0);
    expect(term.said()).toBe(
      [
        "1 schedule, each time in its zone and in UTC:",
        "",
        "check-deps: every Monday at 09:00 (Europe/Berlin), made by robin on 2026-11-20 09:00 UTC",
        "  next: Mon 2026-11-23 09:00 Europe/Berlin (2026-11-23 08:00 UTC)",
        "  last card: none yet"
      ].join("\n")
    );
    term.set("2026-11-23T08:00:10Z");
    await runBoardSchedulesRun({}, term.deps);
    await runBoardScheduleState("pause", "check-deps", { as: "robin" }, term.deps);
    term.said();
    await runBoardSchedules({}, term.deps);
    expect(term.said()).toBe(
      [
        "1 schedule, each time in its zone and in UTC:",
        "",
        "check-deps: every Monday at 09:00 (Europe/Berlin), made by robin on 2026-11-20 09:00 UTC",
        "  paused by robin on 2026-11-23 08:00 UTC: it makes no card until it is resumed",
        "  last card: #1 Check the dependencies (in Ready), due Mon 2026-11-23 09:00"
      ].join("\n")
    );
  });
});

describe("schedules add", () => {
  it("makes the schedule from flags, says when its first card is due, and where its file is", async () => {
    const term = await terminal();
    expect(await runBoardScheduleAdd("check-deps", { as: "robin", weekly: "mon", at: "09:00", ...CARD }, term.deps)).toBe(0);
    expect(term.said()).toBe(
      ["Made the schedule check-deps: every Monday at 09:00 (Europe/Berlin).", "Its first card is due Mon 2026-11-23 09:00 Europe/Berlin (2026-11-23 08:00 UTC), in Ready.", "docs/codelead/board/schedules/check-deps.json"].join("\n")
    );
    // Every N, from now: the first card comes at once (the next whole minute), then every N.
    term.set("2026-11-20T09:00:30Z");
    expect(await runBoardScheduleAdd("tidy", { as: "robin", every: "6h", ...CARD, title: "Tidy the logs" }, term.deps)).toBe(0);
    expect(term.said().split("\n").slice(0, 2)).toEqual(["Made the schedule tidy: every 6 hours from Fri 2026-11-20 10:01 (Europe/Berlin).", "Its first card is due Fri 2026-11-20 10:01 Europe/Berlin (2026-11-20 09:01 UTC), in Ready."]);
    expect(await runBoardScheduleAdd("daily", { as: "robin", daily: true, at: "7:30", zone: "America/New_York", ...CARD, for: "claude" }, term.deps)).toBe(0);
    expect(term.said().split("\n")[0]).toBe("Made the schedule daily: every day at 07:30 (America/New_York).");
    expect(JSON.parse(fs.readFileSync(path.join(term.dir, "schedules", "daily.json"), "utf8")).card.tags).toEqual(["for:claude"]);
    // --dry-run checks everything and writes nothing.
    expect(await runBoardScheduleAdd("dry", { as: "robin", daily: true, at: "08:00", ...CARD, dryRun: true }, term.deps)).toBe(0);
    expect(term.said()).toBe("Would make the schedule dry: every day at 08:00 (Europe/Berlin); nothing was written.\nIts first card is due Sat 2026-11-21 08:00 Europe/Berlin (2026-11-21 07:00 UTC), in Ready.");
    expect(fs.existsSync(path.join(term.dir, "schedules", "dry.json"))).toBe(false);
    // validate counts the schedules, when the board has any.
    expect(await runBoardValidate({}, term.deps)).toBe(0);
    expect(term.said()).toBe("The board is valid: 0 cards, 3 events, 0 cursors, 3 schedules.");
  });

  it("takes the card from a card of the board with --from-card, which the other options change", async () => {
    const term = await terminal();
    await runBoardNew({ as: "claude", type: "task", title: "Rotate the logs", column: "backlog", tag: ["area:ops"], body: "Keep a week.", field: ["definitionOfDone=Older logs are gone", "mayTouch=logs/", "limitMinutes=10"] }, term.deps);
    term.said();
    expect(await runBoardScheduleAdd("logs", { as: "robin", daily: true, at: "06:00", fromCard: "1", title: "Rotate the logs (daily)" }, term.deps)).toBe(0);
    const file = JSON.parse(fs.readFileSync(path.join(term.dir, "schedules", "logs.json"), "utf8")) as { card: unknown };
    expect(file.card).toEqual({ type: "task", title: "Rotate the logs (daily)", description: "Keep a week.", tags: ["area:ops"], fields: { definitionOfDone: "Older logs are gone", mayTouch: "logs/", limitMinutes: 10 } });
  });

  it("refuses in the board's style: no --as or no rule (exit 2), an agent, a card Ready would refuse, a name taken, a board without Ready (exit 1)", async () => {
    const term = await terminal();
    expect(await runBoardScheduleAdd("x", { weekly: "mon", at: "09:00", ...CARD }, term.deps)).toBe(2);
    expect(term.said()).toBe("schedules add needs --as <person>: a schedule is a person's standing ask.");
    expect(await runBoardScheduleAdd("x", { as: "robin", ...CARD }, term.deps)).toBe(2);
    expect(term.said()).toBe('schedules add needs when it is due: --every 30m|2h|1d [--from "YYYY-MM-DD HH:MM"], --daily --at HH:MM, or --weekly mon,thu --at HH:MM.');
    expect(await runBoardScheduleAdd("x", { as: "robin", daily: true, weekly: "mon", at: "09:00", ...CARD }, term.deps)).toBe(2);
    expect(term.said()).toBe("A schedule is due by one rule: give one of --every, --daily and --weekly, not --daily and --weekly.");
    expect(await runBoardScheduleAdd("x", { as: "robin", daily: true, ...CARD }, term.deps)).toBe(2);
    expect(term.said()).toBe("--daily needs --at <HH:MM>: the local time of day, as 09:00.");
    expect(await runBoardScheduleAdd("x", { as: "robin", every: "weekly", ...CARD }, term.deps)).toBe(2);
    expect(term.said()).toBe('"weekly" is not how often: give a number and minutes, hours or days, as 30m, 2h or 1d.');
    expect(await runBoardScheduleAdd("x", { as: "robin", weekly: "mon", at: "09:00", ...CARD, json: true }, { ...term.deps, zone: "Mars/Olympus" })).toBe(2);
    expect(JSON.parse(term.said())).toMatchObject({ refused: "usage" });

    expect(await runBoardScheduleAdd("x", { as: "claude", weekly: "mon", at: "09:00", ...CARD }, term.deps)).toBe(1);
    expect(term.said()).toBe(
      "Refused: claude is an agent and may not make a schedule: a schedule is the person's standing ask, which puts a card in Ready at its times. Ask the person in a card's thread. Nothing was written."
    );
    expect(await runBoardScheduleAdd("x", { as: "robin", weekly: "mon", at: "09:00", title: "Check the dependencies", field: [DONE] }, term.deps)).toBe(1);
    expect(term.said()).toBe(
      "The schedule's card cannot go to Ready yet: it does not name the repository, folder or files it may touch (mayTouch), and it names no limit in minutes or money (limitMinutes, limitMoney). Nothing was written: set what is missing, then make the schedule again."
    );
    expect(await runBoardScheduleAdd("x", { as: "robin", weekly: "mon", at: "09:00", title: "Check the dependencies", field: [DONE], json: true }, term.deps)).toBe(1);
    expect(JSON.parse(term.said())).toMatchObject({ refused: "ready", missing: [{ what: "may-touch" }, { what: "limit" }] });
    expect(fs.existsSync(path.join(term.dir, "schedules"))).toBe(false);
    await runBoardScheduleAdd("check-deps", { as: "robin", weekly: "mon", at: "09:00", ...CARD }, term.deps);
    term.said();
    expect(await runBoardScheduleAdd("check-deps", { as: "robin", daily: true, at: "09:00", ...CARD }, term.deps)).toBe(1);
    expect(term.said()).toBe(
      "Refused: the board has a schedule check-deps already (schedules/check-deps.json): change it with `codelead board schedules change check-deps`, or give the new one another name. Nothing was written."
    );
    const old = await terminal({ ready: false });
    expect(await runBoardScheduleAdd("check-deps", { as: "robin", weekly: "mon", at: "09:00", ...CARD }, old.deps)).toBe(1);
    expect(old.said()).toBe("Refused: this board has no Ready column, and a schedule puts its card there. `codelead board add-ready` gives the board its Ready column. Nothing was written.");
  });
});

describe("schedules run, pause, resume, change, remove", () => {
  it("run: what it made, with the card's file; that nothing is due and when the next is; why it made none", async () => {
    const term = await terminal();
    await runBoardScheduleAdd("check-deps", { as: "robin", weekly: "mon", at: "09:00", ...CARD }, term.deps);
    term.said();
    expect(await runBoardSchedulesRun({}, term.deps)).toBe(0);
    expect(term.said()).toBe("Nothing is due. The next is check-deps, Mon 2026-11-23 09:00 Europe/Berlin (2026-11-23 08:00 UTC).");
    term.set("2026-11-23T08:00:10Z");
    expect(await runBoardSchedulesRun({}, term.deps)).toBe(0);
    expect(term.said()).toBe("The schedule check-deps put #1 in Ready: Check the dependencies (due Mon 2026-11-23 09:00 Europe/Berlin, 2026-11-23 08:00 UTC).\ndocs/codelead/board/items/0001-check-the-dependencies.md");
    term.set("2026-11-30T08:00:10Z");
    expect(await runBoardSchedulesRun({ json: true }, term.deps)).toBe(0);
    expect(JSON.parse(term.said())).toMatchObject({ entries: [{ schedule: "check-deps", outcome: "skipped", open: { id: 1, column: "ready" } }] });
    // A board with no schedules, and one without Ready.
    const empty = await terminal();
    expect(await runBoardSchedulesRun({}, empty.deps)).toBe(0);
    expect(empty.said()).toBe("This board has no schedules: nothing to run.");
  });

  it("pause and resume say what they did, and nothing when there is nothing to do", async () => {
    const term = await terminal();
    await runBoardScheduleAdd("check-deps", { as: "robin", weekly: "mon", at: "09:00", ...CARD }, term.deps);
    term.said();
    expect(await runBoardScheduleState("pause", "check-deps", { as: "robin" }, term.deps)).toBe(0);
    expect(term.said()).toBe("Paused the schedule check-deps: it makes no card until it is resumed, and the times it misses meanwhile are not made up.");
    expect(await runBoardScheduleState("pause", "check-deps", { as: "robin" }, term.deps)).toBe(0);
    expect(term.said()).toBe("The schedule check-deps is paused already (by robin, 2026-11-20 09:00 UTC); nothing was written.");
    term.set("2026-12-01T09:00:00Z");
    expect(await runBoardScheduleState("resume", "check-deps", { as: "robin" }, term.deps)).toBe(0);
    expect(term.said()).toBe("Resumed the schedule check-deps: the times it missed while paused are not made up. Its next card is due Mon 2026-12-07 09:00 Europe/Berlin (2026-12-07 08:00 UTC).");
    expect(await runBoardScheduleState("resume", "check-deps", { as: "robin" }, term.deps)).toBe(0);
    expect(term.said()).toBe("The schedule check-deps is not paused; nothing was written. Its next card is due Mon 2026-12-07 09:00 Europe/Berlin (2026-12-07 08:00 UTC).");
    expect(await runBoardScheduleState("pause", "check-deps", { as: "claude" }, term.deps)).toBe(1);
    expect(term.said()).toMatch(/^Refused: claude is an agent and may not pause the schedule check-deps: /);
    expect(await runBoardScheduleState("pause", "nope", { as: "robin" }, term.deps)).toBe(2);
    expect(term.said()).toBe("No schedule nope on the board (its schedules: check-deps).");
    expect(await runBoardScheduleState("pause", "check-deps", {}, term.deps)).toBe(2);
    expect(term.said()).toBe("schedules pause needs --as <person>: a schedule is a person's standing ask.");
  });

  it("change says what changed and when the next card is due; remove leaves the cards it made", async () => {
    const term = await terminal();
    await runBoardScheduleAdd("check-deps", { as: "robin", weekly: "mon", at: "09:00", ...CARD }, term.deps);
    term.said();
    expect(await runBoardScheduleChange("check-deps", { as: "robin", weekly: "mon,thu", at: "09:00" }, term.deps)).toBe(0);
    expect(term.said()).toBe(
      "Changed the schedule check-deps (its rule): every Monday and Thursday at 09:00 (Europe/Berlin).\nIts times count from now: a time the old rule had is not made up.\nIts next card is due Mon 2026-11-23 09:00 Europe/Berlin (2026-11-23 08:00 UTC)."
    );
    expect(await runBoardScheduleChange("check-deps", { as: "robin", title: "Check the dependencies" }, term.deps)).toBe(0);
    expect(term.said()).toBe("Nothing to change on the schedule check-deps; nothing was written.");
    expect(await runBoardScheduleChange("check-deps", { as: "robin", unsetField: ["limitMinutes"] }, term.deps)).toBe(1);
    expect(term.said()).toBe("The schedule's card cannot go to Ready yet: it names no limit in minutes or money (limitMinutes, limitMoney). Nothing was written: set what is missing, then make the schedule again.");
    expect(await runBoardScheduleChange("check-deps", { as: "robin" }, term.deps)).toBe(2);
    expect(term.said()).toMatch(/^schedules change needs something to change: /);
    term.set("2026-11-23T08:00:00Z");
    await runBoardSchedulesRun({}, term.deps);
    term.said();
    expect(await runBoardScheduleState("remove", "check-deps", { as: "robin" }, term.deps)).toBe(0);
    expect(term.said()).toBe("Removed the schedule check-deps (schedules/check-deps.json): it makes no more cards; the cards it made stay on the board.");
    expect(await runBoardMove("1", { as: "robin", to: "done" }, term.deps)).toBe(0);
    expect(readEvents(term.dir).events.map(({ event }) => event.kind).filter((kind) => kind.startsWith("schedule."))).toEqual(["schedule.added", "schedule.changed", "schedule.ran", "schedule.removed"]);
  });
});

describe("the command tree", () => {
  it("parses schedules and its commands, with --json on each; the parser's own refusals exit 2", async () => {
    const term = await terminal();
    const exit = process.exitCode;
    const said = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.exitCode = 0;
      const tree = (): ReturnType<typeof createBoardCommand> => createBoardCommand({ name: "pinboard" });
      expect(tree().commands.find((command) => command.name() === "schedules")!.commands.map((command) => command.name())).toEqual(["list", "add", "change", "pause", "resume", "remove", "run"]);
      await tree().parseAsync(
        ["schedules", "add", "check-deps", "--board", term.dir, "--as", "robin", "--weekly", "mon", "--at", "09:00", "--zone", "Europe/Berlin", "--title", "Check the dependencies", "--field", DONE, "--field", "mayTouch=package.json", "--field", "limitMinutes=30", "--json"],
        { from: "user" }
      );
      expect(process.exitCode).toBe(0);
      expect(JSON.parse(String(said.mock.calls.at(-1)![0]))).toMatchObject({ file: "schedules/check-deps.json", schedule: { name: "check-deps", rule: { kind: "weekly", days: ["mon"], at: "09:00" } } });
      await tree().parseAsync(["schedules", "--board", term.dir, "--json"], { from: "user" });
      expect(process.exitCode).toBe(0);
      expect(JSON.parse(String(said.mock.calls.at(-1)![0])).schedules.map((schedule: { name: string }) => schedule.name)).toEqual(["check-deps"]);
      for (const verb of ["pause", "resume"]) {
        await tree().parseAsync(["schedules", verb, "check-deps", "--board", term.dir, "--as", "robin", "--json"], { from: "user" });
        expect(process.exitCode).toBe(0);
      }
      await tree().parseAsync(["schedules", "run", "--board", term.dir, "--json"], { from: "user" });
      expect(JSON.parse(String(said.mock.calls.at(-1)![0]))).toMatchObject({ entries: [], reason: "nothing-due" });
      await tree().parseAsync(["schedules", "pause", "check-deps", "--board", term.dir, "--as", "claude"], { from: "user" });
      expect(process.exitCode).toBe(1);
      const quit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`exit ${String(code)}`);
      }) as never);
      const errors = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await expect(tree().parseAsync(["schedules", "add", "x", "--board", term.dir, "--hourly"], { from: "user" })).rejects.toThrow("exit 2");
      } finally {
        quit.mockRestore();
        errors.mockRestore();
      }
    } finally {
      said.mockRestore();
      process.exitCode = exit;
    }
  });
});
