import fs from "node:fs";
import path from "node:path";
import { BoardRefusal } from "./errors.js";
import { writeFileAtomic } from "./files.js";
import { formatJson } from "./json.js";
import { READY_FIELDS } from "./ready.js";
import { isIsoTime, splitText } from "./text.js";
import type { CardId } from "./types.js";
import { checkedRule, isZone, type ScheduleRule } from "./when.js";
import type { YamlMap } from "./yaml.js";

/**
 * A schedule's file: `schedules/<name>.json` in the board folder, one file per schedule beside
 * `items/`, so that two people who each add a schedule on their branch never touch the same file,
 * and a schedule is read, changed or removed on its own. JSON, as `board.json` is, in the board's
 * layout:
 *
 *     {
 *       "schema": "pinboard.schedule/1",
 *       "name": "check-deps",
 *       "rule": { "kind": "weekly", "days": ["mon"], "at": "09:00" },
 *       "zone": "Europe/Berlin",
 *       "card": { "type": "task", "title": "Check the dependencies", "description": "…", "tags": [],
 *                 "fields": { "definitionOfDone": "…", "mayTouch": ["package.json"], "limitMinutes": 30 } },
 *       "made": { "by": "robin", "at": "2026-11-20T09:00:00Z" },
 *       "since": "2026-11-20T09:00:00Z",
 *       "last": { "due": "2026-11-23T08:00:00Z", "at": "2026-11-23T08:00:20Z", "card": 1 },
 *       "lastCard": { "id": 1, "due": "2026-11-23T08:00:00Z", "at": "2026-11-23T08:00:20Z" }
 *     }
 *
 * `rule` is when it is due (when.ts), read in `zone`, the machine's time zone when it was made.
 * `card` is the card it makes. `since`: its times count from then (when it was made, resumed, or its
 * rule changed; a time before is never made up). `paused` and `changed`, when they apply, say who
 * and when. `last` is the last time it was due that a run dealt with: the card it made, or why it
 * made none (`skipped`); `lastCard`, the last card it made. Unknown keys are kept as read.
 */
export const SCHEDULES_FOLDER = "schedules";
export const SCHEDULE_SCHEMA = "pinboard.schedule/1";
/** The tag every card a schedule makes carries: `scheduled:<name>`. */
export const SCHEDULED_TAG_PREFIX = "scheduled:";

/** A schedule's name: a short word of lower-case letters, digits and "-", as its file and its tag name it. */
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

/** The card a schedule makes: its type, title, description, tags, and the fields Ready asks for. */
export interface ScheduleTemplate {
  type: string;
  title: string;
  description: string;
  tags: string[];
  fields: YamlMap;
}

/** Who did it, and when (UTC). */
export interface Stamp {
  by: string;
  at: string;
}

/** The last time a schedule was due that a run dealt with: the card it made, or why it made none. */
export interface ScheduleLast {
  due: string;
  at: string;
  card?: CardId;
  skipped?: string;
  /** The card of this schedule that was still open, when that is why it made none. */
  open?: CardId;
}

export interface Schedule {
  schema: string;
  name: string;
  rule: ScheduleRule;
  zone: string;
  card: ScheduleTemplate;
  made: Stamp;
  since: string;
  changed?: Stamp;
  paused?: Stamp;
  last?: ScheduleLast;
  lastCard?: { id: CardId; due: string; at: string };
  [key: string]: unknown;
}

export function schedulesPath(dir: string): string {
  return path.join(dir, SCHEDULES_FOLDER);
}

/** The schedule's file, relative to the board folder (`schedules/check-deps.json`). */
export function scheduleFileOf(name: string): string {
  return `${SCHEDULES_FOLDER}/${name}.json`;
}

/** True for a schedule's name: a short word of lower-case letters, digits and "-". */
export function isScheduleName(name: unknown): name is string {
  return typeof name === "string" && NAME.test(name);
}

/** A schedule's name as given; refused, in words, when it is not one. */
export function checkedScheduleName(name: string): string {
  const trimmed = name.trim();
  if (!isScheduleName(trimmed)) {
    throw new BoardRefusal("schedule", `Refused: "${name}" is not a schedule's name: a short word of lower-case letters, digits and "-" (check-deps), up to 48 of them. Nothing was written.`);
  }
  return trimmed;
}

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stampProblems(value: unknown, key: string): string[] {
  if (!isMap(value) || typeof value.by !== "string" || value.by === "" || !isIsoTime(value.at)) return [`"${key}" must be { "by": <participant>, "at": <UTC time> }`];
  return [];
}

/** What is wrong with a schedule's content, in plain words; empty when nothing is. `name` is the one its file's name gives. */
export function scheduleProblems(value: unknown, name: string): string[] {
  if (!isMap(value)) return ["a schedule's file must hold one JSON object"];
  const problems: string[] = [];
  if (value.schema !== SCHEDULE_SCHEMA) problems.push(`"schema" is ${JSON.stringify(value.schema)}; this board reads "${SCHEDULE_SCHEMA}"`);
  if (value.name !== name) problems.push(`"name" is ${JSON.stringify(value.name)}, and the file's name says "${name}"`);
  try {
    checkedRule(value.rule);
  } catch (error) {
    problems.push(`"rule" cannot be read: ${error instanceof Error ? error.message.replace(/^Refused: /, "").replace(/ Nothing was written\.$/, "") : String(error)}`);
  }
  if (!isZone(value.zone)) problems.push(`"zone" is ${JSON.stringify(value.zone)}, which is no time zone this machine knows (Europe/Berlin, UTC)`);
  const card = value.card;
  if (!isMap(card) || typeof card.type !== "string" || typeof card.title !== "string" || card.title.trim() === "") {
    problems.push('"card" must be { "type": <type>, "title": <text>, "description": <markdown>, "tags": [<tags>], "fields": { … } }');
  } else {
    if (card.description !== undefined && typeof card.description !== "string") problems.push('"card.description" must be a text');
    if (card.tags !== undefined && (!Array.isArray(card.tags) || !card.tags.every((tag) => typeof tag === "string"))) problems.push('"card.tags" must be a list of texts');
    if (!isMap(card.fields)) problems.push('"card.fields" must be a mapping of the fields Ready asks for');
    else for (const key of Object.keys(card.fields)) if (!READY_FIELDS.includes(key)) problems.push(`"card.fields" holds "${key}", which is not a field a schedule's card carries (${READY_FIELDS.join(", ")})`);
  }
  problems.push(...stampProblems(value.made, "made"));
  if (!isIsoTime(value.since)) problems.push('"since" must be a UTC time');
  for (const key of ["changed", "paused"]) if (value[key] !== undefined) problems.push(...stampProblems(value[key], key));
  if (value.last !== undefined && (!isMap(value.last) || !isIsoTime(value.last.due) || !isIsoTime(value.last.at))) problems.push('"last" must be { "due": <UTC time>, "at": <UTC time>, … }');
  if (value.lastCard !== undefined && (!isMap(value.lastCard) || (typeof value.lastCard.id !== "number" && typeof value.lastCard.id !== "string"))) problems.push('"lastCard" must be { "id": <card id>, "due": <UTC time>, "at": <UTC time> }');
  return problems;
}

/** One file of `schedules/`, read: the schedule when it can be used, and its problems. */
export interface LoadedSchedule {
  file: string;
  name: string;
  raw: string;
  schedule?: Schedule;
  problems: string[];
}

/** Every file of `schedules/`, sorted by name; none (and no problem) when the board has no such folder: a board made before schedules. */
export function readSchedules(dir: string): LoadedSchedule[] {
  let names: string[];
  try {
    names = fs
      .readdirSync(schedulesPath(dir), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  return names.map((fileName) => {
    const file = `${SCHEDULES_FOLDER}/${fileName}`;
    const name = fileName.slice(0, -".json".length);
    const raw = fs.readFileSync(path.join(schedulesPath(dir), fileName), "utf8");
    let value: unknown;
    try {
      value = JSON.parse(splitText(raw).text);
    } catch {
      return { file, name, raw, problems: ["is not JSON"] };
    }
    const problems = [...(isScheduleName(name) ? [] : [`the file's name "${name}" is no schedule's name (lower-case letters, digits and "-")`]), ...scheduleProblems(value, name)];
    if (problems.length > 0) return { file, name, raw, problems };
    const schedule = value as Schedule;
    return { file, name, raw, problems, schedule: { ...schedule, rule: checkedRule(schedule.rule), card: { ...schedule.card, description: schedule.card.description ?? "", tags: schedule.card.tags ?? [] } } };
  });
}

/**
 * Writes a schedule's file in the board's JSON layout (through a temporary file and a rename). With
 * `loaded`, the file must still be what was read: a change made meanwhile is refused, not lost.
 */
export function writeSchedule(dir: string, schedule: Schedule, loaded?: LoadedSchedule): void {
  const file = path.join(schedulesPath(dir), `${schedule.name}.json`);
  if (loaded !== undefined) {
    let current: string | undefined;
    try {
      current = fs.readFileSync(file, "utf8");
    } catch {
      current = undefined;
    }
    if (current !== loaded.raw) throw new BoardRefusal("stale", `Refused: ${loaded.file} changed while it was being written; nothing was written. Run it again.`);
  }
  const { schema, name, rule, zone, card, made, since, changed, paused, last, lastCard, ...rest } = schedule;
  const ordered = { schema, name, rule, zone, card, made, since, changed, paused, last, lastCard, ...rest };
  writeFileAtomic(file, `${formatJson(ordered)}\n`);
}

/** Removes a schedule's file. */
export function removeScheduleFile(dir: string, name: string): void {
  fs.rmSync(path.join(schedulesPath(dir), `${name}.json`), { force: true });
}
