import { describe, expect, it } from "vitest";
import { checkedRule, checkedZone, clockOf, dueBetween, everyOf, instantOf, localTimeOf, localWords, nextDue, ruleWords, utcWords, weekdaysOf, type ScheduleRule } from "../core/index.js";

/**
 * When a schedule is due (core/when.ts): the three kinds of rule, read in the zone the schedule names,
 * and what happens on the nights the clock changes. Berlin's clock jumps from 02:00 to 03:00 on
 * 2026-03-29 and goes back from 03:00 to 02:00 on 2026-10-25; New York's on 2026-03-08 and 2026-11-01.
 */
const BERLIN = "Europe/Berlin";
const NEW_YORK = "America/New_York";
const at = (iso: string): number => Date.parse(iso);
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.000Z$/, "Z");

/** The first `count` due times after `after`, as UTC times. */
function times(rule: ScheduleRule, zone: string, after: string, count: number): string[] {
  const out: string[] = [];
  let from = at(after);
  for (let index = 0; index < count; index += 1) {
    from = nextDue(rule, zone, from);
    out.push(iso(from));
  }
  return out;
}

describe("a local time on the nights the clock changes", () => {
  it("a time the clock skips is read with the offset before the jump: due an hour later, once", () => {
    // 02:30 does not exist in Berlin on 2026-03-29: read as 02:30 CET, it is 01:30 UTC, which the clock shows as 03:30 CEST.
    expect(iso(instantOf({ year: 2026, month: 3, day: 29 }, 2, 30, BERLIN))).toBe("2026-03-29T01:30:00Z");
    expect(localWords(at("2026-03-29T01:30:00Z"), BERLIN)).toBe("Sun 2026-03-29 03:30");
    expect(iso(instantOf({ year: 2026, month: 3, day: 8 }, 2, 30, NEW_YORK))).toBe("2026-03-08T07:30:00Z");
  });

  it("a time the clock passes twice is the first of the two", () => {
    // 02:30 comes twice in Berlin on 2026-10-25: at 00:30 UTC (CEST) and at 01:30 UTC (CET). The first is the one.
    expect(iso(instantOf({ year: 2026, month: 10, day: 25 }, 2, 30, BERLIN))).toBe("2026-10-25T00:30:00Z");
    expect(iso(instantOf({ year: 2026, month: 11, day: 1 }, 1, 30, NEW_YORK))).toBe("2026-11-01T05:30:00Z");
    // An ordinary day has one, at the day's own offset.
    expect(iso(instantOf({ year: 2026, month: 11, day: 23 }, 9, 0, BERLIN))).toBe("2026-11-23T08:00:00Z");
    expect(iso(instantOf({ year: 2026, month: 7, day: 6 }, 9, 0, BERLIN))).toBe("2026-07-06T07:00:00Z");
  });
});

describe("the three kinds of rule", () => {
  it("daily at a time the clock skips: due once that day, an hour later, and at its own time the days around it", () => {
    const rule: ScheduleRule = { kind: "daily", at: "02:30" };
    expect(times(rule, BERLIN, "2026-03-27T12:00:00Z", 3)).toEqual(["2026-03-28T01:30:00Z", "2026-03-29T01:30:00Z", "2026-03-30T00:30:00Z"]);
    expect([at("2026-03-28T01:30:00Z"), at("2026-03-29T01:30:00Z"), at("2026-03-30T00:30:00Z")].map((time) => localWords(time, BERLIN))).toEqual(["Sat 2026-03-28 02:30", "Sun 2026-03-29 03:30", "Mon 2026-03-30 02:30"]);
  });

  it("daily at a time the clock passes twice: due once that night, the first time, never the second", () => {
    const rule: ScheduleRule = { kind: "daily", at: "02:30" };
    expect(times(rule, BERLIN, "2026-10-24T12:00:00Z", 2)).toEqual(["2026-10-25T00:30:00Z", "2026-10-26T01:30:00Z"]);
    // From just after the first 02:30, the second (01:30 UTC) is not due.
    expect(iso(nextDue(rule, BERLIN, at("2026-10-25T00:30:00Z")))).toBe("2026-10-26T01:30:00Z");
    expect(dueBetween(rule, BERLIN, at("2026-10-24T12:00:00Z"), at("2026-10-25T23:00:00Z")).count).toBe(1);
  });

  it("weekly, on the days named, at the local time, across both changes of the clock", () => {
    const rule: ScheduleRule = { kind: "weekly", days: ["mon", "thu"], at: "09:00" };
    expect(times(rule, BERLIN, "2026-11-20T09:00:00Z", 3)).toEqual(["2026-11-23T08:00:00Z", "2026-11-26T08:00:00Z", "2026-11-30T08:00:00Z"]);
    // The Monday before the clock jumps in March is at UTC+1, the Thursday after at UTC+2: 09:00 on the clock both times.
    expect(times(rule, BERLIN, "2026-03-24T12:00:00Z", 2)).toEqual(["2026-03-26T08:00:00Z", "2026-03-30T07:00:00Z"]);
    // On a Sunday at 01:30 New York's clock passes twice (2026-11-01): the first.
    expect(times({ kind: "weekly", days: ["sun"], at: "01:30" }, NEW_YORK, "2026-10-30T00:00:00Z", 2)).toEqual(["2026-11-01T05:30:00Z", "2026-11-08T06:30:00Z"]);
  });

  it("every N hours: fixed lengths of time, so across a change of the clock the local times move by the change", () => {
    const rule: ScheduleRule = { kind: "every", count: 6, unit: "hours", from: "2026-03-28T21:00" };
    const due = times(rule, BERLIN, "2026-03-28T00:00:00Z", 3);
    expect(due).toEqual(["2026-03-28T20:00:00Z", "2026-03-29T02:00:00Z", "2026-03-29T08:00:00Z"]);
    expect(due.map((time) => localWords(at(time), BERLIN))).toEqual(["Sat 2026-03-28 21:00", "Sun 2026-03-29 04:00", "Sun 2026-03-29 10:00"]);
    expect(at(due[1]!) - at(due[0]!)).toBe(6 * 3_600_000);
  });

  it("every N days: the same local time of day, every N calendar days", () => {
    const rule: ScheduleRule = { kind: "every", count: 1, unit: "days", from: "2026-03-27T09:00" };
    const due = times(rule, BERLIN, "2026-03-27T00:00:00Z", 4);
    expect(due).toEqual(["2026-03-27T08:00:00Z", "2026-03-28T08:00:00Z", "2026-03-29T07:00:00Z", "2026-03-30T07:00:00Z"]);
    expect(due.map((time) => localWords(at(time), BERLIN).slice(-5))).toEqual(["09:00", "09:00", "09:00", "09:00"]);
    expect(times({ kind: "every", count: 3, unit: "days", from: "2026-11-20T07:15" }, "UTC", "2026-11-21T00:00:00Z", 2)).toEqual(["2026-11-23T07:15:00Z", "2026-11-26T07:15:00Z"]);
  });

  it("every N minutes, from its start: the start itself is the first time", () => {
    const rule: ScheduleRule = { kind: "every", count: 30, unit: "minutes", from: "2026-11-20T10:00" };
    expect(times(rule, "UTC", "2026-11-20T09:00:00Z", 3)).toEqual(["2026-11-20T10:00:00Z", "2026-11-20T10:30:00Z", "2026-11-20T11:00:00Z"]);
    expect(times(rule, "UTC", "2026-11-20T10:00:00Z", 1)).toEqual(["2026-11-20T10:30:00Z"]);
  });

  it("counts the times between two moments without walking a fixed length, and keeps the first ten", () => {
    const rule: ScheduleRule = { kind: "every", count: 1, unit: "minutes", from: "2026-11-20T00:00" };
    const three = dueBetween(rule, "UTC", at("2026-11-20T00:00:00Z") - 1, at("2026-11-23T00:00:00Z"));
    expect(three.count).toBe(3 * 24 * 60 + 1);
    expect(three.first).toHaveLength(10);
    expect(iso(three.last!)).toBe("2026-11-23T00:00:00Z");
    expect(dueBetween({ kind: "weekly", days: ["mon"], at: "09:00" }, BERLIN, at("2026-11-02T00:00:00Z"), at("2026-11-23T08:00:00Z")).count).toBe(4);
  });
});

describe("the words of a rule, and what a person writes", () => {
  it("says each rule in words, and each time in local time and in UTC", () => {
    expect(ruleWords({ kind: "weekly", days: ["mon"], at: "09:00" })).toBe("every Monday at 09:00");
    expect(ruleWords({ kind: "weekly", days: ["mon", "wed", "fri"], at: "09:00" })).toBe("every Monday, Wednesday and Friday at 09:00");
    expect(ruleWords({ kind: "daily", at: "07:30" })).toBe("every day at 07:30");
    expect(ruleWords({ kind: "every", count: 2, unit: "hours", from: "2026-11-23T09:00" })).toBe("every 2 hours from Mon 2026-11-23 09:00");
    expect(ruleWords({ kind: "every", count: 1, unit: "minutes", from: "2026-11-23T09:00" })).toBe("every minute from Mon 2026-11-23 09:00");
    expect(ruleWords({ kind: "every", count: 3, unit: "days", from: "2026-11-23T09:00" })).toBe("every 3 days at 09:00, from Mon 2026-11-23");
    expect(localWords(at("2026-11-23T08:00:00Z"), BERLIN)).toBe("Mon 2026-11-23 09:00");
    expect(utcWords(at("2026-11-23T08:00:00Z"))).toBe("2026-11-23 08:00 UTC");
  });

  it("reads 30m, 2h, 1d, the days of a week, a time of day and a local time; refuses anything else", () => {
    expect(everyOf("30m")).toEqual({ count: 30, unit: "minutes" });
    expect(everyOf("2 hours")).toEqual({ count: 2, unit: "hours" });
    expect(everyOf("1d")).toEqual({ count: 1, unit: "days" });
    expect(everyOf("0m")).toBeUndefined();
    expect(everyOf("weekly")).toBeUndefined();
    expect(weekdaysOf("thu,mon")).toEqual(["mon", "thu"]);
    expect(weekdaysOf("Monday Friday")).toEqual(["mon", "fri"]);
    expect(weekdaysOf("mo")).toBeUndefined();
    expect(clockOf("9:05")).toBe("09:05");
    expect(clockOf("24:00")).toBeUndefined();
    expect(localTimeOf("2026-11-23 09:00")).toBe("2026-11-23T09:00");
    expect(localTimeOf("2026-02-30 09:00")).toBeUndefined();
  });

  it("refuses a rule that is none of the three, and a zone this machine does not know, in words", () => {
    expect(() => checkedRule({ kind: "cron", at: "0 9 * * 1" })).toThrow(/^Refused: a schedule's rule is \{ "kind": "every"/);
    expect(() => checkedRule({ kind: "weekly", days: ["mon", "mon"], at: "09:00" })).toThrow('Refused: a weekly rule names its days, from mon, tue, wed, thu, fri, sat, sun, each once; ["mon","mon"] does not. Nothing was written.');
    expect(() => checkedRule({ kind: "every", count: 0, unit: "hours", from: "2026-11-23T09:00" })).toThrow('Refused: an "every" rule counts whole hours from 1 up; 0 is not such a count. Nothing was written.');
    expect(checkedRule({ kind: "weekly", days: ["thu", "mon"], at: "9:00" })).toEqual({ kind: "weekly", days: ["mon", "thu"], at: "09:00" });
    expect(() => checkedZone("Mars/Olympus")).toThrow('Refused: "Mars/Olympus" is not a time zone this machine knows; give its name as Europe/Berlin, America/New_York or UTC. Nothing was written.');
    expect(checkedZone("Europe/Berlin")).toBe("Europe/Berlin");
  });
});
