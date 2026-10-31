/**
 * A mention addresses a participant: `@<id>` or `@<name>` in a comment's markdown or in a card's
 * description, where the id or the name is one of board.json's participants. Case does not matter,
 * and a name of several words is written joined, with nothing or with "-" between its words
 * (`@Claude`, `@claude`, `@ClaudeCode`, `@claude-code`, `@Robin`). A word that names no participant
 * is plain text. Nothing in code is a mention (a code span, a fenced block: a decorator there stays
 * code), and neither is an e-mail address, a scoped package (`@types/node`), a path or a domain: the
 * `@` begins a word, and the word ends where a sentence can go on.
 *
 * The mention stays in the text as it was written; the event of the write says who it addresses
 * (`data.addressed`). This module imports nothing, so that the board's page shares it: the page shows
 * as a mention exactly what the core records as one.
 */

/** What a mention is resolved against: a participant's id and name, as board.json lists them. */
export interface MentionTarget {
  id: string;
  name: string;
}

/** A mention found in a text. */
export interface MentionToken<T extends MentionTarget = MentionTarget> {
  /** Where it begins in the text (its `@`). */
  index: number;
  /** The mention as written, `@` included. */
  text: string;
  /** The participant it addresses. */
  participant: T;
}

/**
 * `@` at the start of a word (not after a letter, a digit or `.`, `+`, `-`, `/`, `\`, `@`: an
 * address, a path, an escape), then the word, which ends with a letter or a digit and is not
 * followed by more of a word, a path, an address or a domain (`.`, `_` or `:` before a letter).
 */
const MENTION = /(?<![\p{L}\p{N}.+\-\/\\@])@([\p{L}\p{N}](?:[\p{L}\p{N}._\-]*[\p{L}\p{N}])?)(?![\p{L}\p{N}\-\/@]|[._:][\p{L}\p{N}\/])/gu;

/** A mention being typed: `@` at the start of a word and what follows it up to the caret. */
const TYPING = /(?<![\p{L}\p{N}.+\-\/\\@])@([\p{L}\p{N}._\-]*)$/u;

/** The rest of a mention's word after the caret. */
const WORD_REST = /^[\p{L}\p{N}._\-]*/u;

/** A fence line: ``` or ~~~ (three or more), indented or quoted. */
const FENCE = /^(?:[ \t]*>)*[ \t]*(`{3,}|~{3,})(.*)$/;

/** A name's words, in lower case. */
function nameWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
}

/** How a mention writes a name: its words joined with nothing, or with "-" (`claudecode`, `claude-code`), in lower case. */
function nameForms(name: string): string[] {
  const words = nameWords(name);
  return words.length === 0 ? [] : [words.join(""), words.join("-")];
}

/** The participant a mention's word names: by its id, else by its name; case is ignored. */
export function participantNamed<T extends MentionTarget>(word: string, participants: readonly T[]): T | undefined {
  const wanted = word.toLowerCase();
  return participants.find((participant) => participant.id.toLowerCase() === wanted) ?? participants.find((participant) => nameForms(participant.name).includes(wanted));
}

/**
 * The mentions of a plain text, in order: every `@word` that names a participant. The text is read
 * as it is, code and all; `mentionsIn` leaves the code of a markdown text out first.
 */
export function mentionTokens<T extends MentionTarget>(text: string, participants: readonly T[]): Array<MentionToken<T>> {
  const tokens: Array<MentionToken<T>> = [];
  if (!text.includes("@") || participants.length === 0) return tokens;
  for (const match of text.matchAll(MENTION)) {
    const participant = participantNamed(match[1] ?? "", participants);
    if (participant) tokens.push({ index: match.index ?? 0, text: match[0], participant });
  }
  return tokens;
}

/**
 * Who a markdown text addresses: the ids of the participants it mentions outside its code, each
 * once, in the order of their first mention. What every writer of the board records as an event's
 * `data.addressed`.
 */
export function mentionsIn(text: string, participants: readonly MentionTarget[]): string[] {
  if (!text.includes("@")) return [];
  const ids: string[] = [];
  for (const token of mentionTokens(withoutCode(text), participants)) {
    if (!ids.includes(token.participant.id)) ids.push(token.participant.id);
  }
  return ids;
}

/**
 * The mention being typed at the caret, for the page's list: where its `@` is, where its word ends
 * (the caret, or past it when the caret sits inside the word), and what is typed after the `@`.
 * Undefined when the caret is not in a mention, or in code.
 */
export function mentionAt(text: string, caret: number): { start: number; end: number; query: string } | undefined {
  const before = text.slice(0, caret);
  const typing = TYPING.exec(before);
  if (!typing) return undefined;
  const start = typing.index;
  // In code (a fence, or a code span the person is still writing: closed here as a guess), no list.
  if (withoutCode(`${before}\``)[start] !== "@") return undefined;
  const rest = WORD_REST.exec(text.slice(caret))?.[0] ?? "";
  return { start, end: caret + rest.length, query: typing[1] ?? "" };
}

/** True when a participant's id, a word of its name, or its name joined, begins with what is typed after the `@` (case ignored). */
export function mentionCandidate(query: string, participant: MentionTarget): boolean {
  const wanted = query.toLowerCase();
  if (wanted === "" || participant.id.toLowerCase().startsWith(wanted)) return true;
  return [...nameWords(participant.name), ...nameForms(participant.name)].some((form) => form.startsWith(wanted));
}

/**
 * The text with its code blanked out: the lines of a fenced block (``` or ~~~, indented or quoted)
 * and each code span (`…`, or ``…`` around a backtick) become spaces; every other character stays
 * where it was. A fence that is never closed runs to the end, as markdown reads it.
 */
export function withoutCode(text: string): string {
  let fence: string | undefined;
  const lines = text.split("\n").map((line) => {
    const match = FENCE.exec(line.replace(/\r$/, ""));
    const marks = match?.[1] ?? "";
    const info = match?.[2] ?? "";
    if (fence === undefined) {
      // A run of backticks with a backtick after it on the line is a code span, not a fence.
      if (!match || (marks.startsWith("`") && info.includes("`"))) return line;
      fence = marks;
      return " ".repeat(line.length);
    }
    if (match && marks[0] === fence[0] && marks.length >= fence.length && info.trim() === "") fence = undefined;
    return " ".repeat(line.length);
  });
  return blankCodeSpans(lines.join("\n"));
}

/** True when the character at `index` is escaped: an odd number of backslashes before it. */
function escaped(text: string, index: number): boolean {
  let count = 0;
  for (let at = index - 1; at >= 0 && text[at] === "\\"; at -= 1) count += 1;
  return count % 2 === 1;
}

/** The end of a run of backticks that begins at `from`. */
function runEnd(text: string, from: number): number {
  let at = from;
  while (text[at] === "`") at += 1;
  return at;
}

/** Where the run of exactly `length` backticks that closes a code span begins, before its paragraph ends; -1 when there is none. */
function closingRun(text: string, from: number, length: number): number {
  const paragraph = /\n[ \t\r]*\n/g;
  paragraph.lastIndex = from;
  const end = paragraph.exec(text)?.index ?? text.length;
  for (let at = text.indexOf("`", from); at !== -1 && at < end; at = text.indexOf("`", at)) {
    const after = runEnd(text, at);
    if (after - at === length) return at;
    at = after;
  }
  return -1;
}

function blankCodeSpans(text: string): string {
  if (!text.includes("`")) return text;
  const chars = text.split("");
  let at = 0;
  for (let open = text.indexOf("`", at); open !== -1; open = text.indexOf("`", at)) {
    if (escaped(text, open)) {
      at = open + 1;
      continue;
    }
    const after = runEnd(text, open);
    const close = closingRun(text, after, after - open);
    if (close === -1) {
      at = after;
      continue;
    }
    const end = close + (after - open);
    for (let index = open; index < end; index += 1) if (chars[index] !== "\n") chars[index] = " ";
    at = end;
  }
  return chars.join("");
}
