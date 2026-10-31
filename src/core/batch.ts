import { createCards, parseCardId, type BoardContext, type NewCardInput } from "./board.js";
import { BoardRefusal } from "./errors.js";
import { fencedLines, splitText } from "./text.js";
import { TYPE_FIELDS, type BoardEvent, type Card, type CardId } from "./types.js";
import { parseYamlMapping, YamlError, type YamlMap, type YamlValue } from "./yaml.js";

/**
 * A batch: several cards in one markdown file, as an agent writes them when it turns a
 * conversation into cards (`codelead board new --batch <file>`). Each card is a heading
 * `## <title>`, then a fenced YAML block, then its description:
 *
 *     ## Pick the cache
 *
 *     ```yaml
 *     key: cache
 *     type: decision
 *     column: backlog
 *     tags: [area:board]
 *     fields: { ask: "A TTL or a version key; I recommend the TTL." }
 *     relations:
 *       - { kind: related, to: "@other-key" }
 *       - { kind: related, to: 42 }
 *     ```
 *
 *     The description, in markdown, its own headings ### or deeper.
 *
 * `key` names a card within the file, so that another card of the batch relates to it as
 * `"@key"` before either has an id; a number relates to a card already on the board. Before the
 * first card only blank lines and a title (`# …`) may stand, so that a card written under another
 * heading is not lost unseen. Every card is checked before any is written: one bad card refuses
 * the batch, in words that name its heading, and nothing is written.
 */
export const BATCH_KEYS = ["key", "type", "column", "tags", "fields", "relations", "session"] as const;

/** What the command gives every card of a batch: a column and a session for a card that names none, tags added to each. */
export interface BatchDefaults {
  column?: string;
  tags?: string[];
  session?: string;
}

export interface BatchOptions {
  /** How the refusals name the file (`cards.md`); "the batch" when not given. */
  source?: string;
  defaults?: BatchDefaults;
}

const CARD_HEADING = /^ {0,3}##(?=[ \t]|$)(.*)$/;
const TITLE_HEADING = /^ {0,3}#(?=[ \t]|$)/;
const YAML_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(?:yaml|yml)[ \t]*$/i;
const KEY_WORD = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RELATION_SHAPE = '{ kind: <kind>, to: <card id, or "@key" of a card of this batch> }';

function isMap(value: YamlValue | undefined): value is YamlMap {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A heading's text without the closing run of "#" that markdown allows (`## A title ##`). */
function headingTitle(rest: string): string {
  return rest.replace(/(?:^|[ \t]+)#+[ \t]*$/, "").trim();
}

/** True when a line closes a fence opened with `marks`, as `fencedLines` reads one. */
function closesFence(line: string, marks: string): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return match !== null && match[1]![0] === marks[0] && match[1]!.length >= marks.length;
}

function refuse(message: string): never {
  throw new BoardRefusal("invalid", `Refused: ${message} Nothing was written.`);
}

/** One card of the file: its heading's line and what its block and the lines under it say. */
function readCard(lines: string[], start: number, end: number, source: string, defaults: BatchDefaults): { input: NewCardInput; key?: string; named: Array<{ index: number; ref: string }> } {
  const title = headingTitle(CARD_HEADING.exec(lines[start]!)![1]!);
  const label = `the card "## ${title}" (line ${start + 1} of ${source})`;
  function fail(why: string): never {
    return refuse(`${label}: ${why}.`);
  }

  let open = start + 1;
  while (open < end && lines[open]!.trim() === "") open += 1;
  const fence = open < end ? YAML_FENCE.exec(lines[open]!) : null;
  if (!fence) fail('its block is missing: the first line under the heading opens it, "```yaml", and it gives the card\'s type (and its key, column, tags, fields, relations)');
  const marks = fence[1]!;
  let close = open + 1;
  while (close < end && !closesFence(lines[close]!, marks)) close += 1;
  if (close >= end) fail(`its block, opened on line ${open + 1}, is never closed (a line "${marks}")`);

  let block: YamlMap;
  try {
    block = parseYamlMapping(lines.slice(open + 1, close).join("\n"), open + 2);
  } catch (error) {
    if (error instanceof YamlError) fail(`its block does not read: ${error.message}`);
    throw error;
  }
  for (const name of Object.keys(block)) {
    if ((BATCH_KEYS as readonly string[]).includes(name)) continue;
    if (name === "title") fail('the title is the heading ("## <title>"), not a key of the block');
    if (name === "description") fail("the description is the text under the block, not a key of it");
    fail(`"${name}" is not a key of a card's block (${BATCH_KEYS.join(", ")})`);
  }
  const given = (name: (typeof BATCH_KEYS)[number]): YamlValue | undefined => (block[name] === null ? undefined : block[name]);
  function word(name: "type" | "column" | "session"): string | undefined {
    const value = given(name);
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim() === "") fail(`its "${name}" must be a word, and is ${JSON.stringify(value)}`);
    return value;
  }

  const type = word("type");
  if (type === undefined) fail('its block has no "type" (the card\'s type, one of the board\'s types)');
  const key = given("key");
  if (key !== undefined && (typeof key !== "string" || !KEY_WORD.test(key))) {
    fail(`its "key" must be a word of letters, digits, ".", "_" and "-" (another card names it "@<key>"), and is ${JSON.stringify(key)}`);
  }

  const tags: string[] = [];
  const listed = given("tags");
  if (listed !== undefined) {
    if (!Array.isArray(listed)) fail('its "tags" must be a list, like [area:board, source:conversation]');
    for (const tag of listed) {
      if ((typeof tag !== "string" && typeof tag !== "number") || String(tag).trim() === "") fail(`its tag ${JSON.stringify(tag)} is not a word`);
      tags.push(String(tag));
    }
  }

  const fields = given("fields");
  if (fields !== undefined) {
    if (!isMap(fields)) fail(`its "fields" must be a mapping of the type's fields, and is ${JSON.stringify(fields)}`);
    // The type's own fields only, as `new --field` takes them: a typo is refused, not written as a field of its own.
    const known = TYPE_FIELDS[type];
    for (const name of Object.keys(fields)) {
      if (known && !known.includes(name)) fail(known.length === 0 ? `a ${type} has no fields; "${name}" is not one` : `"${name}" is not a field of a ${type} (${known.join(", ")})`);
    }
  }

  const relations: NonNullable<NewCardInput["relations"]> = [];
  const named: Array<{ index: number; ref: string }> = [];
  const stated = given("relations");
  if (stated !== undefined) {
    if (!Array.isArray(stated)) fail(`its "relations" must be a list of ${RELATION_SHAPE}`);
    stated.forEach((item, index) => {
      const shape = `relation ${index + 1} must be ${RELATION_SHAPE}, and is ${JSON.stringify(item)}`;
      if (!isMap(item) || typeof item.kind !== "string" || !Object.keys(item).every((name) => name === "kind" || name === "to")) fail(shape);
      const to = item.to;
      if (typeof to === "string" && to.startsWith("@")) {
        relations.push({ kind: item.kind, ref: to.slice(1) });
        named.push({ index, ref: to.slice(1) });
        return;
      }
      const id: CardId | undefined = typeof to === "number" ? (Number.isSafeInteger(to) && to > 0 ? to : undefined) : typeof to === "string" ? parseCardId(to) : undefined;
      if (id === undefined) fail(shape);
      relations.push({ kind: item.kind, to: id });
    });
  }

  const column = word("column") ?? defaults.column;
  const session = word("session") ?? defaults.session;
  const input: NewCardInput = {
    ...(key !== undefined ? { ref: key } : {}),
    label,
    type,
    title,
    ...(column !== undefined ? { column } : {}),
    tags: [...tags, ...(defaults.tags ?? [])],
    description: lines.slice(close + 1, end).join("\n"),
    relations,
    ...(fields !== undefined ? { fields } : {}),
    ...(session !== undefined ? { session } : {})
  };
  return { input, ...(key !== undefined ? { key } : {}), named };
}

/**
 * The cards of a batch file, in order, as `createCards` takes them: each with its key as `ref`
 * and its heading as `label`, the command's defaults applied. Refuses the first card that does not
 * read, naming it by its heading and its line.
 */
export function parseBatch(text: string, options: BatchOptions = {}): NewCardInput[] {
  const source = options.source ?? "the batch";
  const lines = splitText(text).text.split("\n");
  const fenced = fencedLines(lines);
  const starts = lines.flatMap((line, index) => (!fenced[index] && CARD_HEADING.test(line) ? [index] : []));
  if (starts.length === 0) refuse(`${source} holds no card: each card begins with a heading "## <title>", then its block "\`\`\`yaml" and its description.`);
  const stray = lines.slice(0, starts[0]).findIndex((line) => line.trim() !== "" && !TITLE_HEADING.test(line));
  if (stray !== -1) refuse(`line ${stray + 1} of ${source} comes before the first card; each card begins with a heading "## <title>" (only a title "# …" may come first).`);

  const cards = starts.map((start, index) => readCard(lines, start, starts[index + 1] ?? lines.length, source, options.defaults ?? {}));
  const keys = new Map<string, string>();
  for (const card of cards) {
    if (card.key === undefined) continue;
    const other = keys.get(card.key);
    if (other !== undefined) refuse(`${card.input.label!}: its key "${card.key}" is also the key of ${other}.`);
    keys.set(card.key, card.input.label!);
  }
  // A relation by key may name a card further down the file: checked once every key is known.
  for (const card of cards) {
    for (const { index, ref } of card.named) {
      if (!keys.has(ref)) {
        refuse(`${card.input.label!}: relation ${index + 1} names "@${ref}", which is no card of this batch (${keys.size > 0 ? `its keys: ${[...keys.keys()].join(", ")}` : "no card of it has a key"}).`);
      }
    }
  }
  return cards.map((card) => card.input);
}

export interface BatchResult {
  /** The cards in the file's order, with the ids they got (or would get, on a dry run). */
  cards: Card[];
  /** The events as the log has them (or would): every card's `item.created`, then each relation's `relation.added`. */
  events: BoardEvent[];
  dryRun: boolean;
}

/**
 * Creates every card of a batch file, or none: the ids in the file's order from board.json's
 * `nextId`, the `@key` relations resolved, one `item.created` per card and one `relation.added`
 * per relation, all written only when every card passes the board's rules (an agent creates only
 * in its own columns, as `new` does). With `dryRun`, the cards as they would be, and nothing written.
 */
export function createBatch(ctx: BoardContext, as: string, text: string, options: BatchOptions & { dryRun?: boolean; rewriteHomePaths?: boolean } = {}): BatchResult {
  const inputs = parseBatch(text, options);
  const results = createCards(ctx, as, inputs, { relationEvents: true, ...(options.dryRun ? { dryRun: true } : {}), ...(options.rewriteHomePaths ? { rewriteHomePaths: true } : {}) });
  return {
    cards: results.map((result) => result.card),
    events: [...results.map((result) => result.events[0]!), ...results.flatMap((result) => result.events.slice(1))],
    dryRun: options.dryRun === true
  };
}
