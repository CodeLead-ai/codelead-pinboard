import { BoardRefusal } from "./errors.js";
import { isIsoTime } from "./text.js";
import { ASK_LIMIT, CARD_COLORS, type Decision } from "./types.js";
import type { YamlMap, YamlValue } from "./yaml.js";

/**
 * The marks a card carries for the person: its colour (`color`, one of the five of CARD_COLORS or
 * none) and, on a decision, its ask (`fields.ask`: what is decided, the options, the
 * recommendation, in one to three sentences) and its answer (`fields.decided`: the option chosen,
 * by whom, on which day). A reader and a writer check them the same way.
 */

/** The colour a text names, as the file stores it (`#b33f40`): its hex with or without "#", in any case, or its name (`red`). */
export function cardColorOf(text: string): string | undefined {
  const wanted = text.trim().toLowerCase();
  if (wanted === "") return undefined;
  const hex = wanted.startsWith("#") ? wanted : `#${wanted}`;
  return CARD_COLORS.find((entry) => entry.hex === hex || entry.name === wanted)?.hex;
}

/** A colour's name (`red`), or the text itself when it is none of the five. */
export function colorName(hex: string): string {
  return CARD_COLORS.find((entry) => entry.hex === hex.toLowerCase())?.name ?? hex;
}

/** The five colours in words: "#b33f40 (red), #ed944d (orange), … and #6577b3 (blue)". */
export function colorWords(): string {
  const words = CARD_COLORS.map((entry) => `${entry.hex} (${entry.name})`);
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]!}`;
}

/** A colour a writer asked for, as the file stores it; refused, in words, when it is none of the five. */
export function requireCardColor(text: string): string {
  const color = cardColorOf(text);
  if (!color) throw new BoardRefusal("usage", `Refused: "${text.trim()}" is not a card colour; the colours are ${colorWords()}, or none. Nothing was written.`);
  return color;
}

/**
 * An ask as it is written: line endings made "\n", no blank space around it. Undefined when it is
 * empty (no ask). Refused when it is not a text, or when it is longer than one to three sentences
 * can be (ASK_LIMIT characters): the details belong in the card's description.
 */
export function checkedAsk(value: YamlValue): string | undefined {
  if (typeof value !== "string") {
    throw new BoardRefusal("usage", `Refused: the ask must be a text (what is decided, the options, the recommendation), and is ${JSON.stringify(value)}. Nothing was written.`);
  }
  const ask = value.replace(/\r\n?/g, "\n").trim();
  if (ask === "") return undefined;
  if (ask.length > ASK_LIMIT) {
    throw new BoardRefusal(
      "usage",
      `Refused: the ask is ${ask.length} characters; it says in one to three sentences what is decided, the options and the recommendation (at most ${ASK_LIMIT} characters), and the details go in the description. Nothing was written.`
    );
  }
  return ask;
}

/** True for the day of a decision: a date as the page writes it (`2026-10-05`), or a UTC time. */
export function isDecisionDay(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const time = Date.parse(`${value}T00:00:00Z`);
    return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
  }
  return isIsoTime(value);
}

/**
 * What keeps a value from being a recorded decision (`fields.decided`, an event's `data.decided`): a
 * mapping of `option` (the option chosen, a text), `by` (who decided: a participant's id) and `on`
 * (the day, `2026-10-05`). Each problem in words, to follow the name of the value; none for a decision.
 */
export function decisionProblems(value: unknown, participants: readonly string[]): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [`is ${JSON.stringify(value)}, not the decision recorded: { option, by, on }, the option chosen, who decided (a participant's id) and the day (2026-10-05)`];
  }
  const entry = value as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof entry.option !== "string" || entry.option.trim() === "") problems.push("has no option chosen (option: a text)");
  if (entry.by === undefined || entry.by === null || entry.by === "") problems.push("does not say who decided (by: a participant's id)");
  else if (typeof entry.by !== "string" || !participants.includes(entry.by)) problems.push(`names ${JSON.stringify(entry.by)} as who decided (by), who is not a participant of the board`);
  if (entry.on === undefined || entry.on === null || entry.on === "") problems.push("does not say on which day (on: a date like 2026-10-05)");
  else if (!isDecisionDay(entry.on)) problems.push(`has ${JSON.stringify(entry.on)} as its day (on), which is no date like 2026-10-05`);
  return problems;
}

/** Who writes a decision, and the day of the write: what a decision leaves out of who and when. */
export interface DecisionWriter {
  as: string;
  /** The day of the write, UTC (`2026-10-05`). */
  today: string;
  /** The board's participants, by id: who may have decided. */
  participants: readonly string[];
}

/**
 * A decision as a writer records it in `fields.decided`: a text is the option chosen, decided by the
 * writer on the day of the write; a mapping is checked (`option` a text, `by` a participant, `on` a
 * date), and what it leaves out of who and when is the writer and that day; its other keys are kept.
 * Undefined for an empty text (no decision). Refused, in words, when it is no decision.
 */
export function checkedDecided(value: YamlValue, writer: DecisionWriter): YamlMap | undefined {
  if (typeof value === "string") {
    const option = value.trim();
    return option === "" ? undefined : { option, by: writer.as, on: writer.today };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BoardRefusal("usage", `Refused: the decision must be the option chosen (a text) or { option, by, on }, and is ${JSON.stringify(value)}. Nothing was written.`);
  }
  const { option, by, on, ...rest } = value;
  const missing = (part: YamlValue | undefined): boolean => part === undefined || part === null || part === "";
  const decided: YamlMap = { option: typeof option === "string" ? option.trim() : (option ?? null), by: missing(by) ? writer.as : by!, on: missing(on) ? writer.today : on!, ...rest };
  const problems = decisionProblems(decided, writer.participants);
  if (problems.length > 0) throw new BoardRefusal("usage", `Refused: the decision ${problems.join("; ")}. Nothing was written.`);
  return decided;
}

/**
 * The decision a value records, read as leniently as a reader may: a mapping with an option (a
 * text), its `by` and `on` when they are texts; a text alone is the option. Undefined for anything
 * else. (A writer records only what `checkedDecided` passes; `validate` names the rest.)
 */
export function readDecision(value: unknown): Decision | undefined {
  if (typeof value === "string") return value.trim() === "" ? undefined : { option: value.trim(), by: "", on: "" };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  if (typeof entry.option !== "string" || entry.option.trim() === "") return undefined;
  return { option: entry.option.trim(), by: typeof entry.by === "string" ? entry.by : "", on: typeof entry.on === "string" ? entry.on : "" };
}
