import { cardColorOf, colorWords } from "./marks.js";
import { fencedLines, isIsoTime, joinText, splitText, trimBlankLines, type Eol } from "./text.js";
import { ASK_FIELD, type Attachment, type CardData, type CardId, type Comment, type Relation } from "./types.js";
import {
  formatEntry,
  formatFlow,
  formatScalar,
  joinEntries,
  parseYamlMapping,
  sameValue,
  splitEntries,
  YamlError,
  type YamlEntry,
  type YamlMap,
  type YamlValue
} from "./yaml.js";

/**
 * A card's file: YAML front matter between two `---` lines, the description in markdown, then a
 * `## Thread` heading and the comments, each a `### <participant> · <time>` heading followed by
 * its markdown. Nothing else is parsed: a comment may hold code blocks, tables and links, and a
 * heading inside a fenced code block is text.
 *
 * Writes are surgical: a changed key's lines are replaced and every other byte of the file stays
 * as it was (unknown keys, comments in the front matter, the line endings, a byte-order mark).
 */
export const KNOWN_KEYS = ["id", "type", "title", "column", "tags", "color", "author", "created", "updated", "relations", "attachments", "fields", "session", "status", "archived"] as const;
export type KnownKey = (typeof KNOWN_KEYS)[number];
export const REQUIRED_KEYS: readonly KnownKey[] = ["id", "type", "title", "column", "author", "created", "updated"];

export const THREAD_HEADING = "## Thread";
const COMMENT_HEADING = /^###\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s+·\s+(\S+)\s*$/;
/** A heading meant as a comment's but not written the way the board reads one (another separator, a missing space). */
const COMMENT_LOOKALIKE = /^###\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:-|–|—|\||:|•|\*|·)\s*(\d{4}-\d{2}-\d{2}T\S*)\s*$/;
const ID_TEXT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface Layout {
  eol: Eol;
  bom: boolean;
  /** The text with "\n" endings, split into lines (the last is "" when the file ends with a line break). */
  lines: string[];
  /** The index of the line that closes the front matter. */
  fmEnd: number;
  /** The index of the `## Thread` line, when there is one. */
  threadAt?: number;
}

function layoutOf(raw: string): Layout | string {
  const { text, eol, bom } = splitText(raw);
  const lines = text.split("\n");
  if (lines[0]?.trimEnd() !== "---") return 'the file does not begin with front matter (a first line "---")';
  let fmEnd = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]!.trimEnd() === "---") {
      fmEnd = index;
      break;
    }
  }
  if (fmEnd === -1) return 'the front matter is never closed (no second line "---")';
  const body = lines.slice(fmEnd + 1);
  const fenced = fencedLines(body);
  const offset = body.findIndex((line, index) => !fenced[index] && line.trimEnd() === THREAD_HEADING);
  return { eol, bom, lines, fmEnd, ...(offset === -1 ? {} : { threadAt: fmEnd + 1 + offset }) };
}

function asText(value: YamlValue | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function isMap(value: YamlValue | undefined): value is YamlMap {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readId(value: YamlValue | undefined): CardId | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && ID_TEXT.test(value)) return value;
  return undefined;
}

function parseThread(lines: string[], start: number): { comments: Comment[]; problems: string[] } {
  const problems: string[] = [];
  const comments: Comment[] = [];
  const body = lines.slice(start);
  const fenced = fencedLines(body);
  let current: { author: string; at: string; lines: string[] } | undefined;
  const preamble: string[] = [];
  const close = (): void => {
    if (current) comments.push({ author: current.author, at: current.at, body: trimBlankLines(current.lines).join("\n") });
  };
  body.forEach((line, index) => {
    const lineNo = start + index + 1;
    if (!fenced[index]) {
      const heading = COMMENT_HEADING.exec(line);
      if (heading) {
        close();
        if (!isIsoTime(heading[2])) problems.push(`line ${lineNo}: the comment's time "${heading[2]}" is not a UTC time like 2026-10-03T00:52:10Z`);
        current = { author: heading[1]!, at: heading[2]!, lines: [] };
        return;
      }
      if (COMMENT_LOOKALIKE.test(line)) {
        problems.push(`line ${lineNo}: "${line.trim()}" reads like a comment heading but is not written "### <participant> · <time>"`);
      }
    }
    if (current) current.lines.push(line);
    else preamble.push(line);
  });
  close();
  const stray = preamble.findIndex((line) => line.trim() !== "");
  if (stray !== -1) {
    problems.push(`line ${start + stray + 1}: the thread holds text before its first comment; a comment begins with "### <participant> · <time>"`);
  }
  return { comments, problems };
}

/**
 * Reads a card's text. The card is returned whenever its front matter could be read, even with
 * problems (a missing key, a time that is not one), so that a check can name every problem at
 * once; a writer refuses a card with any problem.
 */
export function parseCardText(raw: string): { card?: CardData; problems: string[] } {
  const layout = layoutOf(raw);
  if (typeof layout === "string") return { problems: [layout] };
  const problems: string[] = [];
  let map: YamlMap;
  try {
    map = parseYamlMapping(layout.lines.slice(1, layout.fmEnd).join("\n"), 2);
  } catch (error) {
    return { problems: [`the front matter does not parse: ${error instanceof YamlError ? error.message : String(error)}`] };
  }

  for (const key of REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(map, key) || map[key] === null) problems.push(`the required key "${key}" is missing`);
  }
  const id = readId(map.id);
  if (map.id !== undefined && map.id !== null && id === undefined) problems.push(`the id ${JSON.stringify(map.id)} is neither a positive whole number nor a word of letters, digits, ".", "_" and "-"`);
  const word = (key: KnownKey): string => {
    const value = map[key];
    if (value === undefined || value === null) return "";
    if (typeof value !== "string" || value.trim() === "") {
      problems.push(`"${key}" must be a word, and is ${JSON.stringify(value)}`);
      return asText(value) ?? "";
    }
    return value;
  };
  const time = (key: KnownKey): string => {
    const value = map[key];
    if (value === undefined || value === null) return "";
    if (!isIsoTime(value)) problems.push(`"${key}" must be a UTC time like 2026-10-03T00:52:10Z, and is ${JSON.stringify(value)}`);
    return asText(value) ?? "";
  };
  const title = asText(map.title ?? undefined) ?? "";
  if (map.title !== undefined && map.title !== null) {
    if (asText(map.title) === undefined) problems.push('"title" must be a text');
    else if (title.trim() === "") problems.push('"title" is empty');
  }
  if (/[\r\n]/.test(title)) problems.push('"title" must be one line');

  const tags: string[] = [];
  if (map.tags !== undefined && map.tags !== null) {
    if (!Array.isArray(map.tags)) problems.push('"tags" must be a list, like [w5, repo:codelead]');
    else {
      for (const tag of map.tags) {
        const text = asText(tag);
        if (text === undefined || text.trim() === "") problems.push(`the tag ${JSON.stringify(tag)} is not a word`);
        else tags.push(text);
      }
    }
  }

  const relations: Relation[] = [];
  if (map.relations !== undefined && map.relations !== null) {
    if (!Array.isArray(map.relations)) problems.push('"relations" must be a list of { kind: …, to: … }');
    else {
      map.relations.forEach((item, index) => {
        if (!isMap(item) || typeof item.kind !== "string" || readId(item.to) === undefined) {
          problems.push(`relation ${index + 1} must be { kind: <kind>, to: <card id> }, and is ${JSON.stringify(item)}`);
          return;
        }
        relations.push({ ...item, kind: item.kind, to: readId(item.to)! });
      });
    }
  }

  const attachments: Attachment[] = [];
  if (map.attachments !== undefined && map.attachments !== null) {
    if (!Array.isArray(map.attachments)) problems.push('"attachments" must be a list of { path: …, lines: … }');
    else {
      map.attachments.forEach((item, index) => {
        const path = isMap(item) ? asText(item.path) : undefined;
        if (!isMap(item) || path === undefined || path.trim() === "") {
          problems.push(`attachment ${index + 1} must be { path: "<path>", lines: "<lines>" }, and is ${JSON.stringify(item)}`);
          return;
        }
        const lines = item.lines === undefined || item.lines === null ? undefined : asText(item.lines);
        const { path: _path, lines: _lines, ...rest } = item;
        attachments.push({ path, ...(lines !== undefined ? { lines } : {}), ...rest });
      });
    }
  }

  let fields: YamlMap = {};
  if (map.fields !== undefined && map.fields !== null) {
    if (!isMap(map.fields)) problems.push('"fields" must be a mapping of the type\'s fields');
    else fields = map.fields;
  }
  const ask = Object.prototype.hasOwnProperty.call(fields, ASK_FIELD) ? fields[ASK_FIELD] : undefined;
  if (ask !== undefined && ask !== null && typeof ask !== "string") {
    problems.push(`"fields.ask" must be a text (what is decided, the options, the recommendation), and is ${JSON.stringify(ask)}`);
  }

  // The person's colour mark: one of the five, written as its hex in double quotes.
  let color: string | undefined;
  if (map.color !== undefined && map.color !== null) {
    const text = asText(map.color);
    color = text !== undefined && /^#[0-9A-Fa-f]{6}$/.test(text) ? cardColorOf(text) : undefined;
    if (color === undefined) problems.push(`"color" must be one of ${colorWords()}, in double quotes, and is ${JSON.stringify(map.color)}`);
  } else if (layout.lines.slice(1, layout.fmEnd).some((line) => /^color:\s+#/.test(line))) {
    // `color: #b33f40` without quotes: YAML reads everything after " #" as a comment, so the card would lose its colour silently.
    problems.push('"color" is written without quotes, and YAML reads a # after a space as a comment: write it as color: "#b33f40"');
  }

  const optionalText = (key: KnownKey): string | undefined => {
    const value = map[key];
    if (value === undefined || value === null) return undefined;
    const text = asText(value);
    if (text === undefined) problems.push(`"${key}" must be a text`);
    return text;
  };
  const session = optionalText("session");
  const status = optionalText("status");
  if (status !== undefined && /[\r\n]/.test(status)) problems.push('"status" must be one line');
  const archived = map.archived === undefined || map.archived === null ? undefined : time("archived");

  const extra: YamlMap = {};
  for (const key of Object.keys(map)) {
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) Object.defineProperty(extra, key, { value: map[key], enumerable: true, writable: true, configurable: true });
  }

  const descriptionEnd = layout.threadAt ?? layout.lines.length;
  const description = trimBlankLines(layout.lines.slice(layout.fmEnd + 1, descriptionEnd)).join("\n");
  const thread = layout.threadAt === undefined ? { comments: [], problems: [] } : parseThread(layout.lines, layout.threadAt + 1);
  problems.push(...thread.problems);

  const card: CardData = {
    id: id ?? (asText(map.id ?? undefined) ?? ""),
    type: word("type"),
    title,
    column: word("column"),
    tags,
    ...(color !== undefined ? { color } : {}),
    author: word("author"),
    created: time("created"),
    updated: time("updated"),
    relations,
    attachments,
    fields,
    ...(session !== undefined ? { session } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(archived !== undefined ? { archived } : {}),
    extra,
    description,
    thread: thread.comments
  };
  return { card, problems };
}

/** The value a known key has in a card, as YAML; undefined when the card does not carry it. */
function knownValue(key: KnownKey, card: CardData): YamlValue | undefined {
  switch (key) {
    case "tags":
      return card.tags;
    case "relations":
      return card.relations as YamlValue[];
    case "attachments":
      return card.attachments.map((attachment) => Object.fromEntries(Object.entries(attachment).filter(([, value]) => value !== undefined)) as YamlMap);
    case "fields":
      return card.fields;
    default:
      return card[key];
  }
}

/**
 * A known key's lines as the board writes them. `keepEmpty`: an empty list or mapping is written
 * (`relations: []`) rather than left out, for a key the file already had.
 */
function formatKnown(key: KnownKey, card: CardData, keepEmpty = false): string[] | undefined {
  switch (key) {
    case "id":
      return [`id: ${formatScalar(card.id)}`];
    case "title":
      return [`title: ${JSON.stringify(card.title)}`];
    case "tags":
      return formatEntry("tags", card.tags);
    case "relations":
      if (card.relations.length === 0) return keepEmpty ? ["relations: []"] : undefined;
      return ["relations:", ...card.relations.map((relation) => `  - ${formatFlow(relation as YamlMap) ?? JSON.stringify(relation)}`)];
    case "attachments": {
      if (card.attachments.length === 0) return keepEmpty ? ["attachments: []"] : undefined;
      const quoted = new Set(["path", "lines"]);
      return ["attachments:", ...(knownValue("attachments", card) as YamlMap[]).map((attachment) => `  - ${formatFlow(attachment, quoted) ?? JSON.stringify(attachment)}`)];
    }
    case "fields":
      if (Object.keys(card.fields).length === 0) return keepEmpty ? ["fields: {}"] : undefined;
      return formatEntry("fields", card.fields);
    case "session":
    case "status":
    case "color":
      return card[key] === undefined ? undefined : [`${key}: ${JSON.stringify(card[key])}`];
    case "archived":
      return card.archived === undefined ? undefined : [`archived: ${formatScalar(card.archived)}`];
    default:
      return [`${key}: ${formatScalar(card[key])}`];
  }
}

function formatFrontMatter(card: CardData): string[] {
  const lines = KNOWN_KEYS.flatMap((key) => formatKnown(key, card) ?? []);
  for (const [key, value] of Object.entries(card.extra)) lines.push(...formatEntry(key, value));
  return lines;
}

/** A new card's text, as the board writes it ("\n" line endings; the design's layout). */
export function serializeCard(card: CardData): string {
  const lines = ["---", ...formatFrontMatter(card), "---", ""];
  if (card.description !== "") lines.push(...card.description.split("\n"), "");
  lines.push(THREAD_HEADING);
  let text = `${lines.join("\n")}\n`;
  for (const comment of card.thread) text += `\n### ${comment.author} · ${comment.at}\n${comment.body}\n`;
  return text;
}

function rewriteFrontMatter(text: string, before: CardData, after: CardData): string {
  const { leading, entries } = splitEntries(text);
  const changed = (key: KnownKey): boolean => !sameValue(knownValue(key, before), knownValue(key, after));
  const out: YamlEntry[] = [];
  const present = new Set<string>();
  for (const entry of entries) {
    present.add(entry.key);
    const key = entry.key as KnownKey;
    if (!(KNOWN_KEYS as readonly string[]).includes(key) || !changed(key)) {
      out.push(entry);
      continue;
    }
    const lines = formatKnown(key, after, true);
    if (lines !== undefined) {
      out.push({ key, lines, trailing: entry.trailing });
      continue;
    }
    // The key is gone: what followed it (a blank line, a comment) stays where it was.
    const previous = out[out.length - 1];
    if (previous) previous.trailing.push(...entry.trailing);
    else leading.push(...entry.trailing);
  }
  for (const key of KNOWN_KEYS) {
    if (present.has(key) || !changed(key)) continue;
    const lines = formatKnown(key, after);
    if (lines === undefined) continue;
    const order = KNOWN_KEYS.indexOf(key);
    let at = -1;
    out.forEach((entry, index) => {
      const known = KNOWN_KEYS.indexOf(entry.key as KnownKey);
      if (known !== -1 && known < order) at = index;
    });
    out.splice(at + 1, 0, { key, lines, trailing: [] });
  }
  return joinEntries(leading, out);
}

/**
 * The card's text with `after`'s values where they differ from `before`'s (which must be what
 * `raw` says): only the changed keys' lines and, when it changed, the description are rewritten.
 * The thread is never rewritten here; comments are appended with `appendCommentText`.
 */
export function updateCardText(raw: string, before: CardData, after: CardData): string {
  const layout = layoutOf(raw);
  if (typeof layout === "string") throw new Error(layout);
  const { lines, fmEnd } = layout;
  const frontMatter = rewriteFrontMatter(lines.slice(1, fmEnd).join("\n"), before, after).split("\n");
  const descriptionEnd = layout.threadAt ?? lines.length;
  const description =
    before.description === after.description
      ? lines.slice(fmEnd + 1, descriptionEnd)
      : after.description === ""
        ? [""]
        : ["", ...after.description.split("\n"), ""];
  const result = [lines[0]!, ...frontMatter, lines[fmEnd]!, ...description, ...lines.slice(descriptionEnd)];
  return joinText(result.join("\n"), layout.eol, layout.bom);
}

/** The card's text with one more comment at the end of its thread (and the thread's heading, when it had none). */
export function appendCommentText(raw: string, comment: Comment): string {
  const layout = layoutOf(raw);
  if (typeof layout === "string") throw new Error(layout);
  let text = `${layout.lines.join("\n").replace(/\n*$/, "")}\n`;
  if (layout.threadAt === undefined) text += `\n${THREAD_HEADING}\n`;
  text += `\n### ${comment.author} · ${comment.at}\n${normalizeBody(comment.body)}\n`;
  return joinText(text, layout.eol, layout.bom);
}

/** A comment's or a description's text as it is written: "\n" endings, no blank lines around it, no trailing spaces at its end. */
export function normalizeBody(text: string): string {
  return trimBlankLines(text.replace(/\r\n?/g, "\n").split("\n")).join("\n").replace(/\s+$/, "");
}

/**
 * Lines of a text that a card would read as its own structure, outside code blocks: a thread
 * heading, or a comment heading (or one that looks meant as one). A description or a comment
 * holding one would split the card; it is refused with the line named.
 */
export function structureLines(text: string, commentHeadings = true): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const fenced = fencedLines(lines);
  return lines.filter(
    (line, index) => !fenced[index] && (line.trimEnd() === THREAD_HEADING || (commentHeadings && (COMMENT_HEADING.test(line) || COMMENT_LOOKALIKE.test(line))))
  );
}

/** A card's file name: the id, zero-padded to four digits so that a listing sorts, and a slug for people. */
export function cardFileName(id: CardId, slug: string): string {
  const head = typeof id === "number" ? String(id).padStart(4, "0") : id;
  return `${head}-${slug}.md`;
}

/** True when a file name starts the way the card with this id's file must. */
export function fileNameFitsId(fileName: string, id: CardId): boolean {
  const head = typeof id === "number" ? String(id).padStart(4, "0") : id;
  return fileName === `${head}.md` || fileName.startsWith(`${head}-`);
}
