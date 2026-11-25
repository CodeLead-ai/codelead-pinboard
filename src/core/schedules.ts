import path from "node:path";
import { createCards, getCard, readItems, requireParticipant, type BoardContext, type NewCardInput } from "./board.js";
import { columnOf, readBoardConfig } from "./boardConfig.js";
import { BoardRefusal } from "./errors.js";
import { appendEvents } from "./events.js";
import { withBoardLock } from "./files.js";
import { READY_FIELDS, READY_TAKEN_INTO, readyColumnOf, requireReady } from "./ready.js";
import {
  checkedScheduleName,
  readSchedules,
  removeScheduleFile,
  scheduleFileOf,
  SCHEDULE_SCHEMA,
  SCHEDULED_TAG_PREFIX,
  writeSchedule,
  type LoadedSchedule,
  type Schedule,
  type ScheduleLast,
  type ScheduleTemplate,
  type Stamp
} from "./scheduleFiles.js";
import { isoSeconds } from "./text.js";
import type { BoardColumn, BoardConfig, BoardEvent, Card, CardId, Participant } from "./types.js";
import { bothWords, checkedRule, checkedZone, dueBetween, localWords, machineZone, nextDue, ruleWords, utcWords, type DueTimes, type ScheduleRule } from "./when.js";
import { sameValue, type YamlMap, type YamlValue } from "./yaml.js";

/**
 * Scheduled cards. A schedule is the person's standing ask: at its times it makes a card from its
 * template, in Ready, and the board's dispatcher gives that card out like any other Ready card
 * (dispatch.ts). So a schedule belongs to the board, not to an agent: whichever agent asks the board
 * for its card gets the scheduled ones too, and every scheduled run leaves a card with its record.
 * Nothing here starts an agent or calls a model.
 *
 * - Only a person makes, changes, pauses, resumes or removes a schedule; an agent is refused in words.
 *   A schedule whose card would not pass the Ready check is refused when it is made, in the check's
 *   words, so that no schedule makes a card the board would not accept.
 * - Its card is the schedule's person's ask: written by them (its author, the events' `by`), with the
 *   front-matter key `schedule` (its name, whose it is, the time it was due) and the tag
 *   `scheduled:<name>`, related to nothing, straight into Ready. This is the one way a card enters
 *   Ready without the person's move at that moment: the person made the schedule.
 * - `runSchedules` is the one function that makes what is due, under the board's lock: one card per
 *   schedule, whatever number of its times passed while nothing ran (the card's description lists
 *   the others); none while a card it made is still open (in Ready or In progress), which is recorded
 *   once per due time; none while it is paused, and the times it misses then are not made up. Each
 *   schedule's file keeps the last time it dealt with (`last`), so that two processes that run it at
 *   once make one card.
 *
 * Who calls it: `pinboard schedules run`, the page's process on a timer while it runs, a host. Nothing
 * runs while nothing calls it; a time missed meanwhile is made once, at the next call.
 */

/** A card of a schedule that is open: the dispatcher may still give it, or an agent holds it. */
function isOpen(card: Pick<Card, "column" | "archived">, ready: BoardColumn): boolean {
  return card.archived === undefined && (card.column === ready.id || card.column === READY_TAKEN_INTO);
}

function zoneOf(ctx: BoardContext): string {
  return ctx.zone ?? machineZone();
}

function nameOfParticipant(config: BoardConfig, id: string): string {
  return config.participants.find((participant) => participant.id === id)?.name ?? id;
}

/** A schedule is the person's: an agent's write is refused, in words that say what it may do instead. */
function requirePerson(config: BoardConfig, as: string, verb: string): Participant {
  const participant = requireParticipant(config, as);
  if (participant.kind !== "person") {
    throw new BoardRefusal(
      "not-allowed",
      `Refused: ${participant.id} is an agent and may not ${verb}: a schedule is the person's standing ask, which puts a card in Ready at its times. Ask the person in a card's thread. Nothing was written.`
    );
  }
  return participant;
}

/** The board's Ready column; refused, in words that name the command that adds it, on a board without it. */
function requireReadyColumn(config: BoardConfig): BoardColumn {
  const ready = readyColumnOf(config);
  if (ready === undefined) {
    throw new BoardRefusal(
      "column",
      "Refused: this board has no Ready column, and a schedule puts its card there. `codelead board add-ready` gives the board its Ready column. Nothing was written."
    );
  }
  return ready;
}

/** The schedule of a name, as read; refused, in words that list the board's schedules, when there is none. */
function findSchedule(dir: string, name: string): LoadedSchedule {
  const all = readSchedules(dir);
  const found = all.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new BoardRefusal("not-found", `No schedule ${name} on the board (${all.length === 0 ? "it has none" : `its schedules: ${all.map((entry) => entry.name).join(", ")}`}).`);
  }
  if (found.schedule === undefined) throw new BoardRefusal("invalid", `Refused: ${found.file} cannot be read as a schedule: ${found.problems.join("; ")}. Nothing was written.`);
  return found;
}

// ---------------------------------------------------------------------------------------------
// The card a schedule makes

/** The card of a schedule as a person gives it: its type, title, description, tags and the fields Ready asks for. */
export interface ScheduleCardInput {
  type: string;
  title: string;
  description?: string;
  tags?: string[];
  fields?: YamlMap;
}

/**
 * The card a schedule makes, as the board will write it: refused, in the Ready check's words, when it
 * does not say how to tell it is done, what it may touch and its limit; then checked as a card made in
 * Ready by the schedule's person is (its type, its texts: no secret, no path of this machine, no
 * private name; a path under the repository cited as the card cites it), with nothing written. The
 * tag `scheduled:<name>` is the board's to add.
 */
function checkedTemplate(ctx: BoardContext, config: BoardConfig, as: string, input: ScheduleCardInput): ScheduleTemplate {
  const ready = requireReadyColumn(config);
  const fields = input.fields ?? {};
  for (const name of Object.keys(fields)) {
    if (!READY_FIELDS.includes(name)) throw new BoardRefusal("usage", `Refused: "${name}" is not a field a schedule's card carries (${READY_FIELDS.join(", ")}). Nothing was written.`);
  }
  requireReady({ id: 0, fields }, ready, { scheduled: true });
  const tags = (input.tags ?? []).filter((tag) => !tag.trim().toLowerCase().startsWith(SCHEDULED_TAG_PREFIX));
  const [dry] = createCards(ctx, as, [{ type: input.type, title: input.title, column: ready.id, tags, description: input.description ?? "", fields }], { dryRun: true, tagCreator: false });
  const card = dry!.card;
  return { type: card.type, title: card.title, description: card.description, tags: card.tags, fields: card.fields };
}

const NOTE_START = "Made by the schedule `";

/** A description without the note a schedule's card carries at its end (for a schedule made from such a card). */
function withoutNote(description: string): string {
  const at = description.lastIndexOf(`\n\n${NOTE_START}`);
  if (at !== -1) return description.slice(0, at).trimEnd();
  return description.startsWith(NOTE_START) ? "" : description;
}

/**
 * What a schedule's card says at the end of its description: whose schedule made it, by which rule,
 * the time it was due, and the times it was due before while nothing ran, which it stands for.
 */
function noteOf(schedule: Schedule, config: BoardConfig, times: DueTimes): string {
  const due = times.last!;
  const lines = [`${NOTE_START}${schedule.name}\` (${nameOfParticipant(config, schedule.made.by)}'s): ${ruleWords(schedule.rule)}, ${schedule.zone}. Due ${bothWords(due, schedule.zone)}.`];
  const missed = times.count - 1;
  if (missed > 0) {
    const shown = times.first.filter((time) => time !== due);
    const words =
      missed <= shown.length
        ? `${shown.map((time) => localWords(time, schedule.zone)).join(", ")} (${schedule.zone})`
        : `${missed} times, from ${localWords(times.first[0]!, schedule.zone)} (${schedule.zone}) on`;
    lines.push(`It was due before too, while nothing ran, and those times are not made up: this card stands for them. Missed: ${words}.`);
  }
  return lines.join("\n\n");
}

// ---------------------------------------------------------------------------------------------
// Making, changing, pausing, resuming, removing: the person's

export interface ScheduleInput {
  name: string;
  /** When it is due (when.ts): `{ kind: "every" | "daily" | "weekly", … }`. */
  rule: unknown;
  /** The time zone its rule is read in; this machine's when not given (written down in the schedule). */
  zone?: string;
  card: ScheduleCardInput;
}

/** What a write of a schedule did: the schedule as its file now says it (as it would, on a dry run), and its events. */
export interface ScheduleWrite {
  schedule: Schedule;
  /** The schedule's file, relative to the board folder. */
  file: string;
  events: BoardEvent[];
  /** The next time it is due (UTC), unless it is paused. */
  next?: string;
}

function nextOf(schedule: Schedule, now: number): string | undefined {
  if (schedule.paused !== undefined) return undefined;
  return isoSeconds(new Date(nextDue(schedule.rule, schedule.zone, Math.max(afterOf(schedule), now - 1))));
}

/**
 * The person makes a schedule: its name (a short word, its file's and its tag's), its rule, its zone
 * (this machine's when not given), its card. Refused for an agent, on a board without Ready, for a
 * name the board has a schedule of already, and for a card the Ready check would refuse. With
 * `dryRun`, every check and nothing written.
 */
export function addSchedule(ctx: BoardContext, as: string, input: ScheduleInput, options: { dryRun?: boolean } = {}): ScheduleWrite {
  return withBoardLock(ctx.dir, () => {
    const { config } = readBoardConfig(ctx.dir);
    requirePerson(config, as, "make a schedule");
    requireReadyColumn(config);
    const name = checkedScheduleName(input.name);
    const rule = checkedRule(input.rule);
    const zone = checkedZone(input.zone ?? zoneOf(ctx));
    const existing = readSchedules(ctx.dir).find((entry) => entry.name === name);
    if (existing !== undefined) {
      throw new BoardRefusal(
        "schedule",
        `Refused: the board has a schedule ${name} already (${existing.file}): change it with \`codelead board schedules change ${name}\`, or give the new one another name. Nothing was written.`
      );
    }
    const card = checkedTemplate(ctx, config, as, input.card);
    const at = isoSeconds(ctx.now());
    const schedule: Schedule = { schema: SCHEDULE_SCHEMA, name, rule, zone, card, made: { by: as, at }, since: at };
    const events: BoardEvent[] = [{ at, by: as, kind: "schedule.added", data: { schedule: name, rule, zone } }];
    const next = nextOf(schedule, Date.parse(at));
    if (!options.dryRun) {
      writeSchedule(ctx.dir, schedule);
      appendEvents(ctx.dir, events);
    }
    return { schedule, file: scheduleFileOf(name), events, ...(next ? { next } : {}) };
  });
}

/** What the person changes of a schedule: its rule or zone (its times then count from now), or its card. */
export interface ScheduleChanges {
  rule?: unknown;
  zone?: string;
  type?: string;
  title?: string;
  description?: string;
  addTags?: string[];
  removeTags?: string[];
  /** The fields Ready asks for; null removes one. */
  fields?: Record<string, YamlValue | null>;
}

/**
 * The person changes a schedule. A new rule or zone counts its times from now (a time the old rule
 * had and nothing ran for is not made up); a new card is checked as a new schedule's is. Nothing to
 * change: nothing written, no event.
 */
export function changeSchedule(ctx: BoardContext, as: string, name: string, changes: ScheduleChanges): ScheduleWrite {
  return withBoardLock(ctx.dir, () => {
    const { config } = readBoardConfig(ctx.dir);
    requirePerson(config, as, `change the schedule ${name}`);
    const loaded = findSchedule(ctx.dir, name);
    const before = loaded.schedule!;
    const rule = changes.rule !== undefined ? checkedRule(changes.rule) : before.rule;
    const zone = changes.zone !== undefined ? checkedZone(changes.zone) : before.zone;
    const fields: YamlMap = { ...before.card.fields };
    for (const [key, value] of Object.entries(changes.fields ?? {})) {
      if (value === null) delete fields[key];
      else fields[key] = value;
    }
    const removed = new Set((changes.removeTags ?? []).map((tag) => tag.trim()));
    const tags = [...before.card.tags.filter((tag) => !removed.has(tag)), ...(changes.addTags ?? []).filter((tag) => !before.card.tags.includes(tag.trim()) && !removed.has(tag.trim()))];
    const wanted: ScheduleCardInput = {
      type: changes.type ?? before.card.type,
      title: changes.title ?? before.card.title,
      description: changes.description ?? before.card.description,
      tags,
      fields
    };
    const card = checkedTemplate(ctx, config, as, wanted);
    const changed = [
      ...(!sameValue(rule as unknown as YamlValue, before.rule as unknown as YamlValue) ? ["rule"] : []),
      ...(zone !== before.zone ? ["zone"] : []),
      ...(!sameValue(card as unknown as YamlValue, before.card as unknown as YamlValue) ? ["card"] : [])
    ];
    const at = isoSeconds(ctx.now());
    if (changed.length === 0) return { schedule: before, file: loaded.file, events: [], ...(nextOf(before, Date.parse(at)) ? { next: nextOf(before, Date.parse(at))! } : {}) };
    const retimed = changed.includes("rule") || changed.includes("zone");
    const schedule: Schedule = { ...before, rule, zone, card, changed: { by: as, at }, ...(retimed ? { since: at } : {}) };
    const events: BoardEvent[] = [{ at, by: as, kind: "schedule.changed", data: { schedule: name, changed, ...(retimed ? { rule, zone } : {}) } }];
    writeSchedule(ctx.dir, schedule, loaded);
    appendEvents(ctx.dir, events);
    const next = nextOf(schedule, Date.parse(at));
    return { schedule, file: loaded.file, events, ...(next ? { next } : {}) };
  });
}

/** The person pauses a schedule: it makes no card until it is resumed, and the times it misses meanwhile are not made up. */
export function pauseSchedule(ctx: BoardContext, as: string, name: string): ScheduleWrite {
  return withBoardLock(ctx.dir, () => {
    const { config } = readBoardConfig(ctx.dir);
    requirePerson(config, as, `pause the schedule ${name}`);
    const loaded = findSchedule(ctx.dir, name);
    const before = loaded.schedule!;
    if (before.paused !== undefined) return { schedule: before, file: loaded.file, events: [] };
    const at = isoSeconds(ctx.now());
    const schedule: Schedule = { ...before, paused: { by: as, at } };
    const events: BoardEvent[] = [{ at, by: as, kind: "schedule.paused", data: { schedule: name } }];
    writeSchedule(ctx.dir, schedule, loaded);
    appendEvents(ctx.dir, events);
    return { schedule, file: loaded.file, events };
  });
}

/** The person resumes a paused schedule: its times count from now; the ones it missed while paused are not made up. */
export function resumeSchedule(ctx: BoardContext, as: string, name: string): ScheduleWrite {
  return withBoardLock(ctx.dir, () => {
    const { config } = readBoardConfig(ctx.dir);
    requirePerson(config, as, `resume the schedule ${name}`);
    const loaded = findSchedule(ctx.dir, name);
    const before = loaded.schedule!;
    const at = isoSeconds(ctx.now());
    if (before.paused === undefined) return { schedule: before, file: loaded.file, events: [], ...(nextOf(before, Date.parse(at)) ? { next: nextOf(before, Date.parse(at))! } : {}) };
    const { paused: _paused, ...rest } = before;
    const schedule: Schedule = { ...rest, since: at };
    const events: BoardEvent[] = [{ at, by: as, kind: "schedule.resumed", data: { schedule: name } }];
    writeSchedule(ctx.dir, schedule, loaded);
    appendEvents(ctx.dir, events);
    const next = nextOf(schedule, Date.parse(at));
    return { schedule, file: loaded.file, events, ...(next ? { next } : {}) };
  });
}

/** The person removes a schedule: its file goes; the cards it made stay on the board as they are. */
export function removeSchedule(ctx: BoardContext, as: string, name: string): { name: string; file: string; events: BoardEvent[] } {
  return withBoardLock(ctx.dir, () => {
    const { config } = readBoardConfig(ctx.dir);
    requirePerson(config, as, `remove the schedule ${name}`);
    const all = readSchedules(ctx.dir);
    const found = all.find((entry) => entry.name === name);
    if (found === undefined) throw new BoardRefusal("not-found", `No schedule ${name} on the board (${all.length === 0 ? "it has none" : `its schedules: ${all.map((entry) => entry.name).join(", ")}`}).`);
    const at = isoSeconds(ctx.now());
    const events: BoardEvent[] = [{ at, by: as, kind: "schedule.removed", data: { schedule: name } }];
    removeScheduleFile(ctx.dir, name);
    appendEvents(ctx.dir, events);
    return { name, file: found.file, events };
  });
}

/**
 * A schedule's card taken from a card of the board (`schedules add --from-card`): its type, title,
 * description (without the note a schedule's card carries), tags (without `by:` and `scheduled:`:
 * the schedule's cards are the person's) and the fields Ready asks for.
 */
export function scheduleCardOf(ctx: BoardContext, id: CardId): ScheduleCardInput {
  const { card } = getCard(ctx, id);
  const fields: YamlMap = {};
  for (const name of READY_FIELDS) if (card.fields[name] !== undefined && card.fields[name] !== null) fields[name] = card.fields[name]!;
  return {
    type: card.type,
    title: card.title,
    description: withoutNote(card.description),
    tags: card.tags.filter((tag) => !/^by:/i.test(tag) && !tag.toLowerCase().startsWith(SCHEDULED_TAG_PREFIX)),
    fields
  };
}

// ---------------------------------------------------------------------------------------------
// Reading them

/** The instant after which a schedule's times count: those from `since` on, after the last one a run dealt with. */
function afterOf(schedule: Schedule): number {
  const since = Date.parse(schedule.since) - 1;
  const last = schedule.last ? Date.parse(schedule.last.due) : Number.NEGATIVE_INFINITY;
  return Math.max(since, last);
}

/** A time as a person reads it on a list: the local time with its zone, and UTC. */
export interface TimeInfo {
  /** UTC. */
  at: string;
  /** "Mon 2026-11-23 09:00" in the schedule's zone. */
  local: string;
  /** "2026-11-23 08:00 UTC". */
  utc: string;
}

function timeInfo(instant: number, zone: string): TimeInfo {
  return { at: isoSeconds(new Date(instant)), local: localWords(instant, zone), utc: utcWords(instant) };
}

export interface ScheduleView {
  name: string;
  file: string;
  rule: ScheduleRule;
  /** The rule in words: "every Monday at 09:00". */
  words: string;
  zone: string;
  card: ScheduleTemplate;
  made: Stamp;
  since: string;
  changed?: Stamp;
  paused?: Stamp;
  /** Whose schedule it is, and whether it can make a card (its maker is a person of the board). */
  maker: { id: string; name: string; person: boolean };
  /** The next time it is due, unless it is paused; a time already passed when `dueNow` (the next run makes its card). */
  next?: TimeInfo;
  dueNow: boolean;
  last?: ScheduleLast;
  /** The last card it made, as it is now. */
  lastCard?: { id: CardId; due: string; at: string; title?: string; column?: string; archived?: boolean; open: boolean };
  /** A card it made that is open now (in Ready or In progress): while there is one, it makes no other. */
  open?: { id: CardId; column: string };
}

export interface ScheduleListing {
  /** The time the listing is for. */
  at: string;
  /** This machine's time zone: a schedule made now writes it down. */
  zone: string;
  /** The board's Ready column, when it has one: a board without it makes no scheduled card. */
  ready?: string;
  schedules: ScheduleView[];
  /** Files of `schedules/` that cannot be read as a schedule, with why. */
  unreadable: Array<{ file: string; problems: string[] }>;
}

function openCardOf(cards: Card[], name: string, ready: BoardColumn | undefined): Card | undefined {
  if (ready === undefined) return undefined;
  return cards
    .filter((card) => card.schedule?.name === name && isOpen(card, ready))
    .sort((left, right) => Number(right.id) - Number(left.id) || String(right.id).localeCompare(String(left.id)))[0];
}

/** Every schedule of the board, with when it is due next and the last card it made; writes nothing. */
export function listSchedules(ctx: BoardContext): ScheduleListing {
  const now = Date.parse(isoSeconds(ctx.now()));
  const { config } = readBoardConfig(ctx.dir);
  const ready = readyColumnOf(config);
  const loaded = readSchedules(ctx.dir);
  const cards = loaded.length === 0 ? [] : readItems(ctx).flatMap((item) => (item.card ? [item.card] : []));
  const schedules = loaded.flatMap((entry): ScheduleView[] => {
    const schedule = entry.schedule;
    if (schedule === undefined) return [];
    const maker = config.participants.find((participant) => participant.id === schedule.made.by);
    const due = schedule.paused === undefined ? nextDue(schedule.rule, schedule.zone, afterOf(schedule)) : undefined;
    const last = schedule.lastCard ? cards.find((card) => String(card.id) === String(schedule.lastCard!.id)) : undefined;
    const open = openCardOf(cards, schedule.name, ready);
    return [
      {
        name: schedule.name,
        file: entry.file,
        rule: schedule.rule,
        words: ruleWords(schedule.rule),
        zone: schedule.zone,
        card: schedule.card,
        made: schedule.made,
        since: schedule.since,
        ...(schedule.changed ? { changed: schedule.changed } : {}),
        ...(schedule.paused ? { paused: schedule.paused } : {}),
        maker: { id: schedule.made.by, name: maker?.name ?? schedule.made.by, person: maker?.kind === "person" },
        ...(due !== undefined ? { next: timeInfo(due, schedule.zone) } : {}),
        dueNow: due !== undefined && due <= now,
        ...(schedule.last ? { last: schedule.last } : {}),
        ...(schedule.lastCard
          ? {
              lastCard: {
                ...schedule.lastCard,
                ...(last ? { title: last.title, column: last.column, ...(last.archived !== undefined ? { archived: true } : {}) } : {}),
                open: last !== undefined && ready !== undefined && isOpen(last, ready)
              }
            }
          : {}),
        ...(open ? { open: { id: open.id, column: open.column } } : {})
      }
    ];
  });
  return {
    at: isoSeconds(new Date(now)),
    zone: zoneOf(ctx),
    ...(ready ? { ready: ready.id } : {}),
    schedules,
    unreadable: loaded.filter((entry) => entry.schedule === undefined).map((entry) => ({ file: entry.file, problems: entry.problems }))
  };
}

// ---------------------------------------------------------------------------------------------
// Running what is due: the one function

export type ScheduleOutcome = "created" | "skipped" | "held";

/** What a run did for one schedule that was due. */
export interface ScheduleRunEntry {
  schedule: string;
  outcome: ScheduleOutcome;
  /** The time it was due, the latest that passed (UTC): the card's. */
  due: string;
  /** How many of its times passed before that one while nothing ran: not made up (the card stands for them). */
  missedCount: number;
  /** The first of them (UTC), at most ten. */
  missed: string[];
  /** The card it made (created). */
  card?: { id: CardId; type: string; title: string; column: string; file: string; path: string };
  /** The card of it still open (skipped, for that reason). */
  open?: { id: CardId; column: string };
  /** In one sentence, as `schedules run` says it. */
  words: string;
}

export type ScheduleRunReason = "no-schedules" | "no-ready-column" | "nothing-due";

export interface ScheduleRun {
  /** The time the run is for. */
  at: string;
  /** The schedules that were due, each with what was done; empty when `reason` says why nothing was. */
  entries: ScheduleRunEntry[];
  reason?: ScheduleRunReason;
  /** The next time any schedule is due after this run. */
  next?: { schedule: string; due: string; words: string };
  /** What the run did, or why it did nothing, in words. */
  words: string;
  /** The events the run appended, in order. */
  events: BoardEvent[];
}

interface Due {
  loaded: LoadedSchedule;
  schedule: Schedule;
  times: DueTimes;
}

interface Plan {
  config: BoardConfig;
  ready?: BoardColumn;
  loaded: LoadedSchedule[];
  due: Due[];
}

/** What is due at `now`, as the files say it: read without the lock first, then again under it. */
function planOf(ctx: BoardContext, now: number): Plan {
  const { config } = readBoardConfig(ctx.dir);
  const ready = readyColumnOf(config);
  const loaded = readSchedules(ctx.dir);
  const due = loaded.flatMap((entry): Due[] => {
    const schedule = entry.schedule;
    if (schedule === undefined || schedule.paused !== undefined) return [];
    const times = dueBetween(schedule.rule, schedule.zone, afterOf(schedule), now);
    return times.count > 0 ? [{ loaded: entry, schedule, times }] : [];
  });
  return { config, ...(ready ? { ready } : {}), loaded, due };
}

/** The next time any schedule is due after `now`. */
function soonest(loaded: LoadedSchedule[], now: number): ScheduleRun["next"] {
  let best: { schedule: Schedule; due: number } | undefined;
  for (const entry of loaded) {
    const schedule = entry.schedule;
    if (schedule === undefined || schedule.paused !== undefined) continue;
    const due = nextDue(schedule.rule, schedule.zone, Math.max(afterOf(schedule), now));
    if (best === undefined || due < best.due) best = { schedule, due };
  }
  return best ? { schedule: best.schedule.name, due: isoSeconds(new Date(best.due)), words: bothWords(best.due, best.schedule.zone) } : undefined;
}

function nothingWords(plan: Plan, now: number): { reason: ScheduleRunReason; words: string; next?: ScheduleRun["next"] } {
  if (plan.loaded.length === 0) return { reason: "no-schedules", words: "This board has no schedules: nothing to run." };
  if (plan.ready === undefined) {
    return {
      reason: "no-ready-column",
      words: "This board has no Ready column, so no schedule makes a card: a schedule puts its card in Ready. `codelead board add-ready` gives the board its Ready column."
    };
  }
  const next = soonest(plan.loaded, now);
  if (next === undefined) return { reason: "nothing-due", words: plan.loaded.some((entry) => entry.schedule !== undefined) ? "Nothing is due: every schedule is paused." : "Nothing is due: no schedule of the board can be read (`codelead board validate` says why)." };
  return { reason: "nothing-due", words: `Nothing is due. The next is ${next.schedule}, ${next.words}.`, next };
}

/**
 * Makes the card of each schedule that is due at the board's `now`, under the board's lock, and
 * records it; says what it did. For each schedule that is due (not paused; its times from `since`
 * on, after the last one a run dealt with):
 *
 * - made by someone who is no person of the board now: nothing written, said (`held`);
 * - a card it made is still open (in Ready or In progress): no card; the schedule's file and the log
 *   say why, once for its due time (`skipped`);
 * - otherwise one card, for the latest of its times that passed, the earlier ones listed in its
 *   description (`created`); a card the board refuses now (its type removed, a name listed as private
 *   since) is said and recorded as skipped.
 *
 * Nothing is due, or there are no schedules, or no Ready column: nothing is written, not even the
 * lock, and the answer says why (and when the next is due).
 */
export function runSchedules(ctx: BoardContext): ScheduleRun {
  const at = isoSeconds(ctx.now());
  const now = Date.parse(at);
  const first = planOf(ctx, now);
  if (first.ready === undefined || first.due.length === 0) return { at, entries: [], events: [], ...nothingWords(first, now) };
  return withBoardLock(ctx.dir, () => {
    const plan = planOf(ctx, now);
    const ready = plan.ready;
    if (ready === undefined || plan.due.length === 0) return { at, entries: [], events: [], ...nothingWords(plan, now) };
    const { config } = plan;
    const cards = readItems(ctx).flatMap((item) => (item.card ? [item.card] : []));
    const entries: ScheduleRunEntry[] = [];
    const events: BoardEvent[] = [];
    for (const { loaded, schedule, times } of plan.due) {
      const due = isoSeconds(new Date(times.last!));
      const missed = times.first.filter((time) => time !== times.last).map((time) => isoSeconds(new Date(time)));
      const base = { schedule: schedule.name, due, missedCount: times.count - 1, missed };
      const when = bothWords(times.last!, schedule.zone);
      const maker = config.participants.find((participant) => participant.id === schedule.made.by);
      if (maker === undefined || maker.kind !== "person") {
        entries.push({
          ...base,
          outcome: "held",
          words: `The schedule ${schedule.name} was due ${when} and made no card: it was made by ${schedule.made.by}, who is ${maker ? "an agent" : "not a participant of the board"} now. A person of the board makes it again (remove it, then add it).`
        });
        continue;
      }
      const record = (last: ScheduleLast, extra: Partial<Schedule> = {}): void => writeSchedule(ctx.dir, { ...schedule, ...extra, last }, loaded);
      const open = openCardOf(cards, schedule.name, ready);
      if (open !== undefined) {
        const where = columnOf(config, open.column)?.name ?? open.column;
        const which = schedule.lastCard !== undefined && String(schedule.lastCard.id) === String(open.id) ? `the last one, #${String(open.id)}` : `#${String(open.id)}, a card it made`;
        const why = `${which}, is still open (in ${where})`;
        const event: BoardEvent = { at, by: maker.id, item: open.id, kind: "schedule.skipped", data: { schedule: schedule.name, due, why: "open", open: open.id, ...(base.missedCount > 0 ? { missed: base.missedCount } : {}) } };
        record({ due, at, skipped: why, open: open.id });
        appendEvents(ctx.dir, [event]);
        events.push(event);
        entries.push({ ...base, outcome: "skipped", open: { id: open.id, column: open.column }, words: `The schedule ${schedule.name} was due ${when} and made no card: ${why}.` });
        continue;
      }
      const template = schedule.card;
      const description = [template.description.trim(), noteOf(schedule, config, times)].filter((part) => part !== "").join("\n\n");
      const input: NewCardInput = {
        type: template.type,
        title: template.title,
        column: ready.id,
        tags: [...template.tags, `${SCHEDULED_TAG_PREFIX}${schedule.name}`],
        description,
        fields: template.fields,
        schedule: { name: schedule.name, by: maker.id, due },
        eventData: { schedule: schedule.name, due, ...(base.missedCount > 0 ? { missed: base.missedCount } : {}) }
      };
      let made: ReturnType<typeof createCards>[number];
      try {
        [made] = createCards(ctx, maker.id, [input], { tagCreator: false }) as [ReturnType<typeof createCards>[number]];
      } catch (error) {
        if (!(error instanceof BoardRefusal) || error.code === "busy") throw error;
        const why = `the board refused its card: ${error.message}`;
        const event: BoardEvent = { at, by: maker.id, kind: "schedule.skipped", data: { schedule: schedule.name, due, why: "refused", refused: error.code, words: error.message } };
        record({ due, at, skipped: why });
        appendEvents(ctx.dir, [event]);
        events.push(event);
        entries.push({ ...base, outcome: "skipped", words: `The schedule ${schedule.name} was due ${when} and made no card: ${why}` });
        continue;
      }
      const card = made.card;
      const ran: BoardEvent = { at, by: maker.id, item: card.id, kind: "schedule.ran", data: { schedule: schedule.name, due, ...(base.missedCount > 0 ? { missed: base.missedCount } : {}) } };
      record({ due, at, card: card.id }, { lastCard: { id: card.id, due, at } });
      appendEvents(ctx.dir, [ran]);
      events.push(...made.events, ran);
      const before = base.missedCount > 0 ? ` It was due ${base.missedCount === 1 ? "once" : `${base.missedCount} times`} before while nothing ran; this one card stands for ${base.missedCount === 1 ? "it" : "them"} (its description lists them).` : "";
      entries.push({
        ...base,
        outcome: "created",
        card: { id: card.id, type: card.type, title: card.title, column: card.column, file: card.file, path: path.relative(ctx.root, path.join(ctx.dir, card.file)).split(path.sep).join("/") },
        words: `The schedule ${schedule.name} put #${String(card.id)} in ${ready.name}: ${card.title} (due ${localWords(times.last!, schedule.zone)} ${schedule.zone}, ${utcWords(times.last!)}).${before}`
      });
    }
    const after = readSchedules(ctx.dir);
    const next = soonest(after, now);
    const created = entries.filter((entry) => entry.outcome === "created").length;
    return {
      at,
      entries,
      ...(next ? { next } : {}),
      words: entries.length === 0 ? "Nothing is due." : `${created} card${created === 1 ? "" : "s"} made; ${entries.length - created} schedule${entries.length - created === 1 ? "" : "s"} due made none.`,
      events
    };
  });
}

