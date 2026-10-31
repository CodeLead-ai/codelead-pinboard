import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./files.js";
import { formatJson } from "./json.js";
import { digest } from "./text.js";
import { ASK_FIELD, type CardData } from "./types.js";

/**
 * What this machine last saw of each card: the digest of its file, how many events named it then,
 * and a digest of each of its parts. It is how a change made to a card's file without an event
 * line (an agent that forgot, a hand edit) is found and announced as `item.updated` by `unknown`,
 * with the names of the parts that changed. Kept beside the cursors (`cursors/.cards.json`): per
 * machine, out of git. Beside the cards, the stamps of the files as the last full reading found
 * them (`files`), so that a check with nothing new reads no card file.
 */
export const STATE_FILE = ".cards.json";

export interface CardState {
  file: string;
  hash: string;
  /** How many events named the card when the state was taken. */
  events: number;
  parts: Record<string, string>;
}

/** A file's size and times as the file system gives them: what tells, without reading the file, that it is as it was. */
export interface FileStamp {
  size: number;
  mtimeMs: number;
  /** The time of the file's last change of any kind, which no tool can set back (a content change that keeps the modification time still moves it). */
  ctimeMs: number;
}

/**
 * The board's files as the last reading of all of them found them (`synthesizeEvents`): each card
 * file's stamp by its name, and the log's stamp with how many lines it held. While every stamp is
 * still the same, nothing was written since that reading: a check then answers from the cursor
 * alone, reading no card file and no line of the log.
 */
export interface FilesSeen {
  log: FileStamp & { lines: number };
  items: Record<string, FileStamp>;
}

export interface CardStates {
  cards: Record<string, CardState>;
  /** Taken only by a reading that read every file and wrote no event; dropped by any write of the board's own. */
  files?: FilesSeen;
}

function statePath(dir: string): string {
  return path.join(dir, "cursors", STATE_FILE);
}

/** A file's stamp, or undefined when there is no such file. */
export function fileStamp(file: string): FileStamp | undefined {
  try {
    const stat = fs.statSync(file);
    return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  } catch {
    return undefined;
  }
}

export function sameStamp(left: FileStamp | undefined, right: FileStamp | undefined): boolean {
  return left !== undefined && right !== undefined && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function isStamp(value: unknown): value is FileStamp {
  const stamp = value as Partial<FileStamp> | null;
  return typeof stamp === "object" && stamp !== null && typeof stamp.size === "number" && typeof stamp.mtimeMs === "number" && typeof stamp.ctimeMs === "number";
}

function filesSeenOf(value: unknown): FilesSeen | undefined {
  const files = value as Partial<FilesSeen> | null;
  if (typeof files !== "object" || files === null || !isStamp(files.log) || typeof files.log.lines !== "number") return undefined;
  if (typeof files.items !== "object" || files.items === null || !Object.values(files.items).every(isStamp)) return undefined;
  return { log: files.log, items: files.items };
}

export function readCardStates(dir: string): CardStates {
  try {
    const value = JSON.parse(fs.readFileSync(statePath(dir), "utf8")) as Partial<CardStates>;
    if (value && typeof value.cards === "object" && value.cards !== null) {
      const files = filesSeenOf(value.files);
      return { cards: value.cards, ...(files ? { files } : {}) };
    }
  } catch {
    // No state yet, or one that cannot be read: every card is taken as it is now.
  }
  return { cards: {} };
}

export function writeCardStates(dir: string, states: CardStates): void {
  writeFileAtomic(statePath(dir), `${formatJson(states)}\n`);
}

const PART_KEYS = ["id", "type", "title", "column", "tags", "author", "created", "relations", "attachments", "fields", "session", "status", "archived", "description"] as const;

/**
 * A digest per part of a card: each front-matter key (unknown ones too), the description, the
 * thread. A decision's ask is a part of its own, apart from the other fields, and so is the colour;
 * both only when the card has them, so that a state taken before they existed reads the same.
 */
export function partsOf(card: CardData): Record<string, string> {
  const parts: Record<string, string> = {};
  const { [ASK_FIELD]: ask, ...fields } = card.fields;
  for (const key of PART_KEYS) parts[key] = digest(JSON.stringify(key === "fields" ? fields : (card[key] ?? null)));
  if (ask !== undefined) parts.ask = digest(JSON.stringify(ask));
  if (card.color !== undefined) parts.color = digest(JSON.stringify(card.color));
  for (const [key, value] of Object.entries(card.extra)) parts[`extra.${key}`] = digest(JSON.stringify(value));
  parts.thread = digest(JSON.stringify(card.thread));
  return parts;
}

/** The names of the parts that differ between two states of a card (`thread` when a comment was added or changed). */
export function changedParts(before: Record<string, string>, after: Record<string, string>): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((name) => before[name] !== after[name]).map((name) => name.replace(/^extra\./, ""));
}
