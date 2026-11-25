import { BoardRefusal } from "./errors.js";
import type { BoardColumn, BoardConfig, CardData, CardId, Participant } from "./types.js";
import type { YamlMap, YamlValue } from "./yaml.js";

/**
 * Ready: the person's column of the cards an agent may pick up by itself. Moving a card there is
 * the person's ask for the work, so:
 *
 * - only a person moves a card into it: the column is the person's (`owner: "person"`), and the
 *   rule that keeps an agent out of the person's columns keeps it out of Ready too;
 * - a card goes there only when it can be worked alone (`readyGaps`): it says how to tell it is done
 *   (`definitionOfDone`, the task's own field, which any card may carry for this), what it may touch
 *   (`mayTouch`: a repository, a folder or files, at least one) and a limit (`limitMinutes`,
 *   `limitMoney`, or both: a number each);
 * - from Ready an agent takes a card into In progress, and moves it nowhere else; a card tagged
 *   `for:<agent>` is that agent's, a card with no such tag any agent's;
 * - while a card is in Ready, what it says it may do is the person's ask: an agent does not change
 *   those fields, and no change may take one of them away.
 *
 * Leaving Ready, by the person, needs no check. The column is the one with the id `ready` that the
 * person owns; a board made before it has none and works as before (`addReadyColumn` gives it one).
 */
export const READY_COLUMN_ID = "ready";

/** The column a new board has, and `addReadyColumn` adds. */
export const READY_COLUMN: Readonly<BoardColumn> = { id: READY_COLUMN_ID, name: "Ready", owner: "person" };

/** The column an agent takes a Ready card into. */
export const READY_TAKEN_INTO = "in-progress";

/** How anyone can tell the work is done: a sentence, a command, a test. A task's own field; any card may carry it for Ready. */
export const DONE_WHEN_FIELD = "definitionOfDone";
/** What the work may touch: a repository, a folder or named files; a text, or a list of them. */
export const MAY_TOUCH_FIELD = "mayTouch";
/** The most time the work may take, in minutes: a number above 0. */
export const LIMIT_MINUTES_FIELD = "limitMinutes";
/** The most the work may spend, in money: a number, 0 or more. */
export const LIMIT_MONEY_FIELD = "limitMoney";

/** The fields a card needs before it goes to Ready; any card type may carry them. */
export const READY_FIELDS: readonly string[] = [DONE_WHEN_FIELD, MAY_TOUCH_FIELD, LIMIT_MINUTES_FIELD, LIMIT_MONEY_FIELD];

/** The three things a card in Ready says. */
export type ReadyThing = "done-when" | "may-touch" | "limit";

/** One thing a card does not say yet, as a refusal names it: the thing, the fields that say it, and the words. */
export interface ReadyGap {
  what: ReadyThing;
  fields: string[];
  words: string;
}

/** The board's Ready column: the column `ready` that the person owns; undefined on a board without it. */
export function readyColumnOf(config: Pick<BoardConfig, "columns">): BoardColumn | undefined {
  const column = config.columns.find((entry) => entry.id === READY_COLUMN_ID);
  return column && column.owner === "person" ? column : undefined;
}

/** The texts a value says: a text that is not empty, or each such text of a list. */
function textsOf(value: YamlValue | undefined): string[] {
  if (typeof value === "string") return value.trim() === "" ? [] : [value];
  if (Array.isArray(value)) return value.flatMap((entry) => (typeof entry === "string" && entry.trim() !== "" ? [entry] : []));
  return [];
}

/** The lowest a limit may be: minutes above 0; money 0 or more (0: it may spend nothing). */
function limitAllows(name: string, value: number): boolean {
  return Number.isFinite(value) && (name === LIMIT_MONEY_FIELD ? value >= 0 : value > 0);
}

/** A limit as a card keeps it: a number, from a number or a text that reads as one; "invalid" for anything else; undefined when not given. */
export function limitOf(name: string, value: YamlValue | undefined): number | "invalid" | undefined {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return undefined;
  const number = typeof value === "number" ? value : typeof value === "string" && /^\s*\d+(\.\d+)?\s*$/.test(value) ? Number(value) : Number.NaN;
  return limitAllows(name, number) ? number : "invalid";
}

/**
 * A limit field as a write keeps it: a number (a text that reads as one becomes the number), null
 * when it is emptied (the field is removed); refused, in words, when it is neither.
 */
export function checkedLimit(name: string, value: YamlValue): number | null {
  const limit = limitOf(name, value);
  if (limit === undefined) return null;
  if (limit === "invalid") {
    const what = name === LIMIT_MONEY_FIELD ? "a limit in money, a number of 0 or more (5, or 2.50)" : "a limit in minutes, a number above 0 (30, or 1.5)";
    throw new BoardRefusal("ready", `Refused: ${name} is ${what}; ${JSON.stringify(value)} is not one. Nothing was written.`);
  }
  return limit;
}

/** True when a field's name is one of the limits. */
export function isLimitField(name: string): boolean {
  return name === LIMIT_MINUTES_FIELD || name === LIMIT_MONEY_FIELD;
}

/**
 * What a card does not say yet that a card in Ready must say, in the order a refusal names it; empty
 * when it can be worked alone. The one place that decides whether a card may go to Ready: the core's
 * moves and creations call it, and so the commands, the page's process and the page do.
 */
export function readyGaps(fields: YamlMap): ReadyGap[] {
  const gaps: ReadyGap[] = [];
  if (textsOf(fields[DONE_WHEN_FIELD]).length === 0) gaps.push({ what: "done-when", fields: [DONE_WHEN_FIELD], words: `it does not say how to tell it is done (${DONE_WHEN_FIELD})` });
  if (textsOf(fields[MAY_TOUCH_FIELD]).length === 0) {
    gaps.push({ what: "may-touch", fields: [MAY_TOUCH_FIELD], words: `it does not name the repository, folder or files it may touch (${MAY_TOUCH_FIELD})` });
  }
  const minutes = limitOf(LIMIT_MINUTES_FIELD, fields[LIMIT_MINUTES_FIELD]);
  const money = limitOf(LIMIT_MONEY_FIELD, fields[LIMIT_MONEY_FIELD]);
  if (typeof minutes !== "number" && typeof money !== "number") {
    // A limit written by hand that is no number is said as such: the card names one, and it does not count.
    const wrong = [LIMIT_MINUTES_FIELD, LIMIT_MONEY_FIELD].find((name) => limitOf(name, fields[name]) === "invalid");
    gaps.push({
      what: "limit",
      fields: [LIMIT_MINUTES_FIELD, LIMIT_MONEY_FIELD],
      words:
        wrong === undefined
          ? `it names no limit in minutes or money (${LIMIT_MINUTES_FIELD}, ${LIMIT_MONEY_FIELD})`
          : `its limit cannot be read (${wrong} is ${JSON.stringify(fields[wrong])}; ${LIMIT_MINUTES_FIELD} takes a number above 0, ${LIMIT_MONEY_FIELD} a number of 0 or more)`
    });
  }
  return gaps;
}

/** "a", "a, and b", "a, b, and c": the parts of one refusal. */
function joined(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/** What a refusal of the Ready check carries for a program (`--json`, the page's process): the card and each thing missing. */
export function readyDetails(id: CardId | undefined, gaps: ReadyGap[]): Record<string, unknown> {
  return { ...(id !== undefined ? { card: id } : {}), missing: gaps.map((gap) => ({ what: gap.what, fields: [...gap.fields], words: gap.words })) };
}

/**
 * Refuses a card that cannot go to Ready yet, naming each thing it does not say:
 * `Card #42 cannot go to Ready yet: it does not say how to tell it is done (definitionOfDone), and it
 * names no limit in minutes or money (limitMinutes, limitMoney). Nothing was written: set what is
 * missing, then move it again.` A card being created is "The new card".
 */
export function requireReady(card: Pick<CardData, "id" | "fields">, column: Pick<BoardColumn, "name">, options: { created?: boolean } = {}): void {
  const gaps = readyGaps(card.fields);
  if (gaps.length === 0) return;
  const subject = options.created ? "The new card" : `Card #${String(card.id)}`;
  const then = options.created ? "then create it again" : "then move it again";
  throw new BoardRefusal("ready", `${subject} cannot go to ${column.name} yet: ${joined(gaps.map((gap) => gap.words))}. Nothing was written: set what is missing, ${then}.`, readyDetails(card.id, gaps));
}

/**
 * Refuses a change to a card in Ready that would take away one of the things it says (the change
 * leaves it with a gap it did not have): the dispatcher of a later step, and every agent, read a card
 * in Ready as one that can be worked alone.
 */
export function requireStillReady(before: Pick<CardData, "id" | "fields">, after: YamlMap, column: Pick<BoardColumn, "name">): void {
  const had = new Set(readyGaps(before.fields).map((gap) => gap.what));
  const gaps = readyGaps(after).filter((gap) => !had.has(gap.what));
  if (gaps.length === 0) return;
  throw new BoardRefusal(
    "ready",
    `Card #${String(before.id)} is in ${column.name}, so it must keep what lets an agent work it alone; after this change ${joined(gaps.map((gap) => gap.words))}. Nothing was written: keep it, or move the card out of ${column.name} first.`,
    readyDetails(before.id, gaps)
  );
}

/**
 * While a card is in Ready, what it says it may do is the person's ask: an agent's write that
 * changes one of the Ready fields is refused (the agent asks in the thread).
 */
export function refuseAgentReadyFields(participant: Participant, column: Pick<BoardColumn, "name">, changed: string[]): void {
  if (participant.kind !== "agent" || changed.length === 0) return;
  throw new BoardRefusal(
    "not-allowed",
    `Refused: ${participant.id} is an agent and may not change what a card in ${column.name} says it may do (${changed.join(", ")}): that is the person's ask; ask in the thread. Nothing was written.`
  );
}

/** The agents a card is meant for: the ids its `for:<agent>` tags name, in lower case. */
export function forAgents(tags: readonly string[]): string[] {
  return tags.flatMap((tag) => {
    const match = /^for:([A-Za-z0-9][A-Za-z0-9._-]*)$/i.exec(tag.trim());
    return match ? [match[1]!.toLowerCase()] : [];
  });
}

/**
 * An agent's move of a card out of Ready: into In progress only (that is how an agent takes it), and
 * only a card meant for it (no `for:<agent>` tag, or one that names it). A person's move out of
 * Ready is always allowed.
 */
export function requireMayLeaveReady(config: Pick<BoardConfig, "columns">, participant: Participant, card: Pick<CardData, "id" | "tags">, ready: Pick<BoardColumn, "name">, to: BoardColumn): void {
  if (participant.kind !== "agent") return;
  const into = config.columns.find((column) => column.id === READY_TAKEN_INTO);
  if (to.id !== READY_TAKEN_INTO) {
    throw new BoardRefusal(
      "column",
      into
        ? `Refused: ${participant.id} is an agent and may move a card out of ${ready.name} only into ${into.name}, to take it; not into ${to.name}. Nothing was written.`
        : `Refused: ${participant.id} is an agent and may not move a card out of ${ready.name}: the board has no column an agent takes it into. Nothing was written.`
    );
  }
  const meant = forAgents(card.tags);
  if (meant.length > 0 && !meant.includes(participant.id.toLowerCase())) {
    throw new BoardRefusal(
      "not-allowed",
      `Refused: card #${String(card.id)} in ${ready.name} is for ${meant.join(" or ")} (${meant.map((id) => `for:${id}`).join(", ")}); ${participant.id} may not take it. Nothing was written.`
    );
  }
}

/**
 * The board's columns with Ready added: before In progress when the board has it (the place it has
 * on a new board, after Pinned), otherwise at the end.
 */
export function columnsWithReady(columns: readonly BoardColumn[]): { columns: BoardColumn[]; at: number } {
  const working = columns.findIndex((column) => column.id === READY_TAKEN_INTO);
  const at = working === -1 ? columns.length : working;
  return { columns: [...columns.slice(0, at), { ...READY_COLUMN }, ...columns.slice(at)], at };
}
