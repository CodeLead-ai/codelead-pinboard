import fs from "node:fs";
import path from "node:path";
import { readDecision } from "./marks.js";
import { isIsoTime, splitText, type Eol } from "./text.js";
import type { BoardEvent, Decision } from "./types.js";

/**
 * `events.jsonl`: one JSON object per line, appended and never edited. Each line says who did
 * what to which card and when: `{"at":…,"by":…,"item":…,"kind":…,"data":{…}}`, in that key order.
 * The line is what a notification says; the card's file is the truth.
 */
export function eventsPath(dir: string): string {
  return path.join(dir, "events.jsonl");
}

export interface ReadEvent {
  event: BoardEvent;
  /** The event's place among the file's lines that are not empty, from 1: what a cursor's `lines` counts. */
  position: number;
  /** The event's line in the file, from 1. */
  line: number;
}

/** What makes a line no event at all; undefined for a usable one. */
function shapeProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "is not a JSON object";
  const event = value as Record<string, unknown>;
  if (!isIsoTime(event.at)) return `"at" must be a UTC time like 2026-10-03T00:52:10Z, and is ${JSON.stringify(event.at)}`;
  if (typeof event.by !== "string" || event.by === "") return '"by" must name who did it';
  if (typeof event.kind !== "string" || event.kind === "") return '"kind" must say what happened';
  if (event.item !== undefined && typeof event.item !== "number" && typeof event.item !== "string") return '"item" must be a card id';
  if (event.data !== undefined && (typeof event.data !== "object" || event.data === null || Array.isArray(event.data))) return '"data" must be a JSON object';
  return undefined;
}

/** Reads every event, in order. A line that is no event is skipped and named in `problems`; it still counts as a line seen. */
export function readEvents(dir: string): { events: ReadEvent[]; count: number; problems: string[] } {
  let raw: string;
  try {
    raw = fs.readFileSync(eventsPath(dir), "utf8");
  } catch {
    return { events: [], count: 0, problems: [] };
  }
  const events: ReadEvent[] = [];
  const problems: string[] = [];
  let position = 0;
  splitText(raw)
    .text.split("\n")
    .forEach((text, index) => {
      if (text.trim() === "") return;
      position += 1;
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        problems.push(`line ${index + 1} is not JSON`);
        return;
      }
      const problem = shapeProblem(value);
      if (problem) {
        problems.push(`line ${index + 1}: ${problem}`);
        return;
      }
      events.push({ event: value as BoardEvent, position, line: index + 1 });
    });
  return { events, count: position, problems };
}

/** One event as its line: at, by, item, kind, data first, then any other key it carries. */
export function eventLine(event: BoardEvent): string {
  const { at, by, item, kind, data, ...rest } = event;
  const ordered: Record<string, unknown> = { at, by };
  if (item !== undefined) ordered.item = item;
  ordered.kind = kind;
  if (data !== undefined) ordered.data = data;
  return JSON.stringify(Object.assign(ordered, rest));
}

/** Appends events, each on its own line, with the line ending the file already uses (a last line left without one is ended first). */
export function appendEvents(dir: string, events: BoardEvent[]): void {
  if (events.length === 0) return;
  const file = eventsPath(dir);
  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    existing = "";
  }
  const eol: Eol = existing.includes("\n") ? splitText(existing).eol : "\n";
  const lead = existing !== "" && !existing.endsWith("\n") ? eol : "";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${lead}${events.map(eventLine).join(eol)}${eol}`, "utf8");
}

/**
 * Who an event is addressed to: the participant ids of its `data.addressed`, the one key that says
 * it, on every kind of event. The board writes it on a comment (`comment.added`) and on a card
 * created or changed with a description (`item.created`, `item.updated`) whose text mentions someone
 * (`@robin`). An event without it, as every event written before mentions, is addressed to no one.
 */
export function addressedTo(event: BoardEvent): string[] {
  const addressed = event.data?.addressed;
  return Array.isArray(addressed) ? addressed.filter((id): id is string => typeof id === "string") : [];
}

/**
 * The decision an event records: its `data.decided`, which the board writes on the `item.updated`
 * that sets or changes a card's `fields.decided` (the person's answer to a decision card), read on
 * every kind of event as `addressedTo` reads `addressed`. Null when the event removed the decision;
 * undefined when it says nothing of one, as every event written before this rule.
 */
export function decisionOf(event: BoardEvent): Decision | null | undefined {
  const data = event.data;
  if (data === undefined || !Object.prototype.hasOwnProperty.call(data, "decided")) return undefined;
  return data.decided === null ? null : readDecision(data.decided);
}

/** The first words of a text on one line, for an event's excerpt: at most `max` characters. */
export function excerpt(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
