import fs from "node:fs";
import path from "node:path";
import { BoardRefusal } from "./errors.js";
import { writeFileAtomic } from "./files.js";
import { formatJson } from "./json.js";
import { isIsoTime, joinText, splitText, type Eol } from "./text.js";
import type { Cursor } from "./types.js";

/**
 * `cursors/<participant>.json`: what a participant has seen. For a person it is the state of the
 * notification capsule; for an agent it is its check cursor. Cursors are per machine and stay out
 * of git (the board's .gitignore lists the folder). Unknown keys are kept.
 */
export function cursorPath(dir: string, participant: string): string {
  return path.join(dir, "cursors", `${participant}.json`);
}

export interface CursorFile {
  cursor: Cursor;
  eol: Eol;
  bom: boolean;
  /** False when the participant has no cursor yet: everything on the board is new to them. */
  exists: boolean;
}

/** What is wrong with a cursor's content; empty when nothing is. */
export function cursorProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["must hold one JSON object"];
  const cursor = value as Record<string, unknown>;
  const problems: string[] = [];
  if (cursor.seen !== undefined && !isIsoTime(cursor.seen)) problems.push(`"seen" must be a UTC time, and is ${JSON.stringify(cursor.seen)}`);
  if (cursor.lines !== undefined && !(typeof cursor.lines === "number" && Number.isSafeInteger(cursor.lines) && cursor.lines >= 0)) {
    problems.push(`"lines" must be a whole number of 0 or more, and is ${JSON.stringify(cursor.lines)}`);
  }
  if (cursor.opened !== undefined) {
    if (typeof cursor.opened !== "object" || cursor.opened === null || Array.isArray(cursor.opened)) problems.push('"opened" must map card ids to times');
    else {
      for (const [id, time] of Object.entries(cursor.opened)) {
        if (!isIsoTime(time)) problems.push(`"opened" says card ${id} was opened at ${JSON.stringify(time)}, which is not a UTC time`);
      }
    }
  }
  return problems;
}

export function readCursor(dir: string, participant: string): CursorFile {
  let raw: string;
  try {
    raw = fs.readFileSync(cursorPath(dir, participant), "utf8");
  } catch {
    return { cursor: {}, eol: "\n", bom: false, exists: false };
  }
  const { text, eol, bom } = splitText(raw);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  const problems = value === undefined ? ["is not JSON"] : cursorProblems(value);
  if (problems.length > 0) {
    throw new BoardRefusal("invalid", `Refused: cursors/${participant}.json ${problems.join("; ")}. Fix it, or delete it (without a cursor everything on the board is new). Nothing was written.`);
  }
  return { cursor: value as Cursor, eol, bom, exists: true };
}

export function writeCursor(dir: string, participant: string, file: CursorFile, next: Cursor): void {
  writeFileAtomic(cursorPath(dir, participant), joinText(`${formatJson(next)}\n`, file.eol, file.bom));
}
