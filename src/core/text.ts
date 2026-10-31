import { createHash } from "node:crypto";

/**
 * Small text rules every file of the board shares: a file keeps the line ending it was written
 * with (the first one it uses decides) and its byte-order mark; times are UTC to the second.
 */
export type Eol = "\n" | "\r\n";

export interface SplitText {
  /** The text with a byte-order mark removed and every line ending made "\n". */
  text: string;
  eol: Eol;
  bom: boolean;
}

/** Reads a file's text into one with "\n" line endings, remembering what it had. */
export function splitText(raw: string): SplitText {
  const bom = raw.charCodeAt(0) === 0xfeff;
  const body = bom ? raw.slice(1) : raw;
  const first = body.indexOf("\n");
  const eol: Eol = first > 0 && body[first - 1] === "\r" ? "\r\n" : "\n";
  return { text: body.replace(/\r\n/g, "\n"), eol, bom };
}

/** The inverse of `splitText`: the text with the file's own line ending and mark again. */
export function joinText(text: string, eol: Eol, bom: boolean): string {
  const withEol = eol === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text;
  return bom ? `﻿${withEol}` : withEol;
}

/** A time as the board writes it: UTC, to the second, `2026-10-03T00:52:10Z`. */
export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** True for a time with a date, a clock time and a zone, as ISO 8601 writes it. */
export function isIsoTime(value: unknown): value is string {
  return typeof value === "string" && ISO_TIME.test(value) && !Number.isNaN(Date.parse(value));
}

/** Milliseconds of an ISO time, or undefined for anything else. */
export function timeOf(value: unknown): number | undefined {
  return isIsoTime(value) ? Date.parse(value) : undefined;
}

/** A short name for a file, from a title: lower-case words of letters and digits joined by "-". */
export function slugify(title: string, max = 40): string {
  const words = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let slug = "";
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > max) {
      if (!slug) slug = word.slice(0, max);
      break;
    }
    slug = next;
  }
  return slug || "card";
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A short digest for comparing contents: the first 16 hex characters of the SHA-256. */
export function digest(text: string): string {
  return sha256(text).slice(0, 16);
}

/**
 * Walks markdown lines and says, for each, whether it sits inside a fenced code block (``` or
 * ~~~). A fence line itself counts as inside. Headings in a code block are text, never structure.
 *
 * As CommonMark reads it, a run of three or more backticks (after at most three spaces) opens a
 * fence only when no backtick follows it on the line: "```npm test``` first" is a line of text with
 * a code span, not a fence that would hide every line after it. A tilde fence may hold backticks.
 */
export function fencedLines(lines: string[]): boolean[] {
  const inside: boolean[] = [];
  let fence: string | undefined;
  for (const line of lines) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (match) {
      const marks = match[1]!;
      if (fence === undefined) {
        if (marks.startsWith("`") && match[2]!.includes("`")) {
          inside.push(false);
          continue;
        }
        fence = marks;
        inside.push(true);
        continue;
      }
      if (marks[0] === fence[0] && marks.length >= fence.length && match[2]!.trim() === "") {
        fence = undefined;
        inside.push(true);
        continue;
      }
    }
    inside.push(fence !== undefined);
  }
  return inside;
}

/** Removes blank lines at the start and end of a list of lines, and nothing else. */
export function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start += 1;
  while (end > start && lines[end - 1]!.trim() === "") end -= 1;
  return lines.slice(start, end);
}
