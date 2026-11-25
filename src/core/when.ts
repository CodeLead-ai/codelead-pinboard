import { BoardRefusal } from "./errors.js";

/**
 * When a schedule is due (schedules.ts): three kinds of rule, kept small and unambiguous, each read
 * in the time zone the schedule names (an IANA name, as `Europe/Berlin`, written down when the
 * schedule is made: the machine's zone then). A rule as a schedule's file keeps it:
 *
 *     { "kind": "every", "count": 2, "unit": "hours", "from": "2026-11-23T09:00" }
 *     { "kind": "daily", "at": "09:00" }
 *     { "kind": "weekly", "days": ["mon", "thu"], "at": "09:00" }
 *
 * - `every` minutes or hours: fixed lengths of time from `from` (a local time): every 6 hours is
 *   every 21,600 seconds, so across a change of the clock its local times move by the change.
 * - `every` days: the same local time of day, every N calendar days from `from`'s day.
 * - `daily` and `weekly`: that local time, every day or on the days named.
 *
 * A local time the clock skips that day (02:30 on the night it jumps from 02:00 to 03:00) is read
 * with the offset before the jump: it is due at 03:30, once. A local time the clock passes twice
 * (02:30 on the night it goes back from 03:00 to 02:00) is due once, the first time. These are the
 * rules calendars use (RFC 5545). Times are whole minutes; no cron syntax.
 */

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const WEEKDAY_NAMES: Record<Weekday, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const WEEKDAY_SHORT: Record<Weekday, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

export const EVERY_UNITS = ["minutes", "hours", "days"] as const;
export type EveryUnit = (typeof EVERY_UNITS)[number];

export type ScheduleRule =
  | { kind: "every"; count: number; unit: EveryUnit; from: string }
  | { kind: "daily"; at: string }
  | { kind: "weekly"; days: Weekday[]; at: string };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------------------------
// A time zone, read through Intl (Node's own ICU): no library, no table of our own

/** The time zone of this machine, as an IANA name; UTC when the system says none. */
export function machineZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterOf(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** True when the zone is one this machine knows by name (`Europe/Berlin`, `UTC`). */
export function isZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone.trim() === "") return false;
  try {
    formatterOf(zone);
    return true;
  } catch {
    return false;
  }
}

/** The zone as a schedule keeps it; refused, in words, when it is no zone this machine knows. */
export function checkedZone(zone: string): string {
  const name = zone.trim();
  if (!isZone(name)) throw new BoardRefusal("usage", `Refused: "${zone}" is not a time zone this machine knows; give its name as Europe/Berlin, America/New_York or UTC. Nothing was written.`);
  return name;
}

/** A calendar day. */
export interface LocalDay {
  year: number;
  month: number;
  day: number;
}

/** A local time of a zone: the day, the clock, the weekday. */
export interface Wall extends LocalDay {
  hour: number;
  minute: number;
  second: number;
  weekday: Weekday;
}

const SHORT_TO_DAY: Record<string, Weekday> = { Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat", Sun: "sun" };

/** The local time of a zone at an instant (ms). */
export function wallOf(instant: number, zone: string): Wall {
  const parts: Record<string, string> = {};
  for (const part of formatterOf(zone).formatToParts(new Date(instant))) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: SHORT_TO_DAY[parts.weekday ?? ""] ?? "mon"
  };
}

/** A local time written as if it were UTC, in ms: what two local times are compared by. */
function asUtc(day: LocalDay, hour: number, minute: number, second = 0): number {
  return Date.UTC(day.year, day.month - 1, day.day, hour, minute, second);
}

/** How far the zone's clock is ahead of UTC at an instant, in ms. */
function offsetAt(instant: number, zone: string): number {
  const wall = wallOf(instant, zone);
  return asUtc(wall, wall.hour, wall.minute, wall.second) - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a local time of a zone names. A local time the clock skips is read with the offset
 * before the jump (later by the jump); one it passes twice is the first of the two.
 */
export function instantOf(day: LocalDay, hour: number, minute: number, zone: string): number {
  const local = asUtc(day, hour, minute);
  const before = offsetAt(local - DAY, zone);
  const after = offsetAt(local + DAY, zone);
  const found = [...new Set([local - before, local - after])].filter((instant) => {
    const wall = wallOf(instant, zone);
    return asUtc(wall, wall.hour, wall.minute) === local;
  });
  if (found.length > 0) return Math.min(...found);
  return local - before;
}

/** A day `count` days after another, on the calendar. */
function addDays(day: LocalDay, count: number): LocalDay {
  const date = new Date(Date.UTC(day.year, day.month - 1, day.day + count));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function weekdayOf(day: LocalDay): Weekday {
  return WEEKDAYS[(new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay() + 6) % 7]!;
}

// ---------------------------------------------------------------------------------------------
// The words a person writes, and the rule's own checks

const CLOCK = /^\s*(\d{1,2}):(\d{2})\s*$/;
const LOCAL_TIME = /^\s*(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})\s*$/;

/** `HH:MM`, 00:00 to 23:59, as a rule keeps it; undefined for anything else. */
export function clockOf(text: string): string | undefined {
  const match = CLOCK.exec(text);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** `YYYY-MM-DDTHH:MM` (a space for the T too), a day that is on the calendar, as a rule keeps it; undefined for anything else. */
export function localTimeOf(text: string): string | undefined {
  const match = LOCAL_TIME.exec(text);
  if (!match) return undefined;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59) return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** The local time of an instant, as a rule's `from` keeps it (`2026-11-23T09:00`). */
export function localTimeAt(instant: number, zone: string): string {
  const wall = wallOf(instant, zone);
  return `${String(wall.year).padStart(4, "0")}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function splitLocal(text: string): { day: LocalDay; hour: number; minute: number } {
  const [date, clock] = text.split("T") as [string, string];
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const [hour, minute] = clock.split(":").map(Number) as [number, number];
  return { day: { year, month, day }, hour, minute };
}

function splitClock(text: string): { hour: number; minute: number } {
  const [hour, minute] = text.split(":").map(Number) as [number, number];
  return { hour, minute };
}

const UNIT_WORDS: Record<string, EveryUnit> = {
  m: "minutes",
  min: "minutes",
  mins: "minutes",
  minute: "minutes",
  minutes: "minutes",
  h: "hours",
  hr: "hours",
  hrs: "hours",
  hour: "hours",
  hours: "hours",
  d: "days",
  day: "days",
  days: "days"
};

/** `30m`, `2h`, `3d`, `30 minutes`, `1 day`: how often an `every` rule is due; undefined for anything else. */
export function everyOf(text: string): { count: number; unit: EveryUnit } | undefined {
  const match = /^\s*(\d+)\s*([a-z]+)\s*$/i.exec(text);
  if (!match) return undefined;
  const count = Number(match[1]);
  const unit = UNIT_WORDS[match[2]!.toLowerCase()];
  if (unit === undefined || !Number.isSafeInteger(count) || count < 1) return undefined;
  return { count, unit };
}

/** `mon,thu`, `Monday Thursday`, `mon, wed, fri`: the days of a weekly rule, in the week's order; undefined when any word is no day. */
export function weekdaysOf(text: string): Weekday[] | undefined {
  const words = text
    .split(/[\s,]+/)
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word !== "");
  if (words.length === 0) return undefined;
  const days = new Set<Weekday>();
  for (const word of words) {
    const day = WEEKDAYS.find((candidate) => word.length >= 3 && WEEKDAY_NAMES[candidate].toLowerCase().startsWith(word));
    if (day === undefined) return undefined;
    days.add(day);
  }
  return WEEKDAYS.filter((day) => days.has(day));
}

function refuseRule(why: string): never {
  throw new BoardRefusal("usage", `Refused: ${why}. Nothing was written.`);
}

/**
 * A rule as a schedule keeps it, from the JSON a file, the page or a host gives; refused, in words
 * that say the three kinds, when it is none of them.
 */
export function checkedRule(value: unknown): ScheduleRule {
  const shapes = 'a schedule\'s rule is { "kind": "every", "count": <n>, "unit": "minutes", "hours" or "days", "from": "YYYY-MM-DDTHH:MM" }, { "kind": "daily", "at": "HH:MM" } or { "kind": "weekly", "days": ["mon", …], "at": "HH:MM" }';
  if (typeof value !== "object" || value === null || Array.isArray(value)) refuseRule(shapes);
  const rule = value as Record<string, unknown>;
  switch (rule.kind) {
    case "every": {
      const count = rule.count;
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) refuseRule(`an "every" rule counts whole ${String(rule.unit ?? "units")} from 1 up; ${JSON.stringify(count)} is not such a count`);
      if (!(EVERY_UNITS as readonly unknown[]).includes(rule.unit)) refuseRule(`an "every" rule's unit is minutes, hours or days; ${JSON.stringify(rule.unit)} is none of them`);
      const from = typeof rule.from === "string" ? localTimeOf(rule.from) : undefined;
      if (from === undefined) refuseRule(`an "every" rule starts from a local time, YYYY-MM-DDTHH:MM (2026-11-23T09:00); ${JSON.stringify(rule.from)} is not one`);
      return { kind: "every", count, unit: rule.unit as EveryUnit, from };
    }
    case "daily": {
      const at = typeof rule.at === "string" ? clockOf(rule.at) : undefined;
      if (at === undefined) refuseRule(`a daily rule says the local time of day, HH:MM (09:00); ${JSON.stringify(rule.at)} is not one`);
      return { kind: "daily", at };
    }
    case "weekly": {
      const at = typeof rule.at === "string" ? clockOf(rule.at) : undefined;
      if (at === undefined) refuseRule(`a weekly rule says the local time of day, HH:MM (09:00); ${JSON.stringify(rule.at)} is not one`);
      const given: unknown[] = Array.isArray(rule.days) ? rule.days : [];
      const days = WEEKDAYS.filter((day) => given.includes(day));
      if (days.length === 0 || given.length !== new Set(given).size || given.some((day) => !(WEEKDAYS as readonly unknown[]).includes(day))) {
        refuseRule(`a weekly rule names its days, from ${WEEKDAYS.join(", ")}, each once; ${JSON.stringify(rule.days)} does not`);
      }
      return { kind: "weekly", days, at };
    }
    default:
      return refuseRule(shapes);
  }
}

// ---------------------------------------------------------------------------------------------
// When a rule is due

/** The first time the rule is due after `after` (ms, not included), in the zone. */
export function nextDue(rule: ScheduleRule, zone: string, after: number): number {
  switch (rule.kind) {
    case "every": {
      const from = splitLocal(rule.from);
      if (rule.unit !== "days") {
        const start = instantOf(from.day, from.hour, from.minute, zone);
        const step = rule.count * (rule.unit === "hours" ? HOUR : MINUTE);
        if (after < start) return start;
        return start + (Math.floor((after - start) / step) + 1) * step;
      }
      const start = instantOf(from.day, from.hour, from.minute, zone);
      // From a step or two before `after`: a day of 23 or 25 hours moves a step's instant by an hour, never by a step.
      let k = after < start ? 0 : Math.max(0, Math.floor((after - start) / (rule.count * DAY)) - 1);
      for (let tries = 0; tries < 8; tries += 1, k += 1) {
        const due = instantOf(addDays(from.day, k * rule.count), from.hour, from.minute, zone);
        if (due > after) return due;
      }
      throw new Error(`no due time found for ${ruleWords(rule)} after ${new Date(after).toISOString()}`);
    }
    case "daily":
    case "weekly": {
      const { hour, minute } = splitClock(rule.at);
      let day = addDays(wallOf(after, zone), -1);
      // A week and two days cover every weekday once, and the day before and after `after`'s own.
      for (let tries = 0; tries < 10; tries += 1, day = addDays(day, 1)) {
        if (rule.kind === "daily" || rule.days.includes(weekdayOf(day))) {
          const due = instantOf(day, hour, minute, zone);
          if (due > after) return due;
        }
      }
      throw new Error(`no due time found for ${ruleWords(rule)} after ${new Date(after).toISOString()}`);
    }
  }
}

/** The times a rule was due after `after` (not included) up to `until` (included): how many, the first few, and the last. */
export interface DueTimes {
  count: number;
  /** The first ones, at most the number asked for. */
  first: number[];
  last?: number;
}

export function dueBetween(rule: ScheduleRule, zone: string, after: number, until: number, keep = 10): DueTimes {
  const first: number[] = [];
  const next = nextDue(rule, zone, after);
  if (next > until) return { count: 0, first };
  if (rule.kind === "every" && rule.unit !== "days") {
    // Fixed lengths of time: counted, not walked.
    const step = rule.count * (rule.unit === "hours" ? HOUR : MINUTE);
    const count = Math.floor((until - next) / step) + 1;
    for (let index = 0; index < Math.min(count, keep); index += 1) first.push(next + index * step);
    return { count, first, last: next + (count - 1) * step };
  }
  let count = 0;
  let last = next;
  for (let due = next; due <= until; due = nextDue(rule, zone, due)) {
    count += 1;
    last = due;
    if (first.length < keep) first.push(due);
  }
  return { count, first, last };
}

// ---------------------------------------------------------------------------------------------
// Words

function listed(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function dayWords(day: LocalDay): string {
  return `${WEEKDAY_SHORT[weekdayOf(day)]} ${String(day.year).padStart(4, "0")}-${pad(day.month)}-${pad(day.day)}`;
}

/** A rule as a person reads it: "every Monday at 09:00", "every day at 07:30", "every 2 hours from Mon 2026-11-23 09:00". */
export function ruleWords(rule: ScheduleRule): string {
  switch (rule.kind) {
    case "every": {
      const from = splitLocal(rule.from);
      const clock = `${pad(from.hour)}:${pad(from.minute)}`;
      if (rule.unit === "days") return `every ${rule.count === 1 ? "day" : `${rule.count} days`} at ${clock}, from ${dayWords(from.day)}`;
      const unit = rule.unit === "hours" ? "hour" : "minute";
      return `every ${rule.count === 1 ? unit : `${rule.count} ${unit}s`} from ${dayWords(from.day)} ${clock}`;
    }
    case "daily":
      return `every day at ${rule.at}`;
    case "weekly":
      return `every ${listed(rule.days.map((day) => WEEKDAY_NAMES[day]))} at ${rule.at}`;
  }
}

/** An instant in a zone's local time, as a person reads it: "Mon 2026-11-23 09:00". */
export function localWords(instant: number, zone: string): string {
  const wall = wallOf(instant, zone);
  return `${dayWords(wall)} ${pad(wall.hour)}:${pad(wall.minute)}`;
}

/** An instant in UTC, as a person reads it: "2026-11-23 08:00 UTC". */
export function utcWords(instant: number): string {
  const date = new Date(instant);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/** An instant in both: "Mon 2026-11-23 09:00 Europe/Berlin (2026-11-23 08:00 UTC)". */
export function bothWords(instant: number, zone: string): string {
  return `${localWords(instant, zone)} ${zone} (${utcWords(instant)})`;
}
