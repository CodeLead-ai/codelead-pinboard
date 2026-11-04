import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentsGuide } from "./agents.js";
import {
  agentColumns,
  boardConfigPath,
  boardConfigProblems,
  boardConfigText,
  columnOf,
  defaultBoardConfig,
  inspectBoardConfig,
  intervalMinutes,
  participantOf,
  readBoardConfig,
  workspaceOf,
  writeBoardConfig
} from "./boardConfig.js";
import { appendCommentText, cardFileName, fileNameFitsId, normalizeBody, parseCardText, serializeCard, structureLines, updateCardText } from "./card.js";
import { cursorProblems, readCursor, writeCursor, type CursorFile } from "./cursors.js";
import { BoardRefusal } from "./errors.js";
import { addressedTo, appendEvents, decisionOf, eventsPath, excerpt, readEvents, type ReadEvent } from "./events.js";
import { LOCK_FILE, withBoardLock, writeFileAtomic } from "./files.js";
import { findUnsafe, PRIVATE_NAMES_FILE, readPrivateNames, refuseUnsafe, rewritePaths, type GuardScope } from "./guard.js";
import type { SanitizerFactory } from "./sanitize.js";
import { checkedAsk, checkedDecided, decisionProblems, readDecision, requireCardColor, type DecisionWriter } from "./marks.js";
import { mentionsIn } from "./mentions.js";
import {
  changedParts,
  fileStamp,
  partsOf,
  readCardStates,
  sameStamp,
  STATE_FILE,
  writeCardStates,
  type CardState,
  type FileStamp,
  type FilesSeen
} from "./state.js";
import { digest, isIsoTime, isoSeconds, slugify, timeOf } from "./text.js";
import {
  ASK_FIELD,
  BOARD_FOLDER,
  DECIDED_FIELD,
  EVENT_KINDS,
  RELATION_KINDS,
  RELATION_SEEN_FROM_TARGET,
  TYPE_FIELDS,
  UNKNOWN_PARTICIPANT,
  type Attachment,
  type BoardColumn,
  type BoardConfig,
  type BoardEvent,
  type Card,
  type CardData,
  type CardId,
  type Comment,
  type Cursor,
  type Participant
} from "./types.js";
import { sameValue, type YamlMap, type YamlValue } from "./yaml.js";

/**
 * The board's operations, each a few plain rules, each refusing with words and writing nothing
 * when a rule says no:
 *
 * - A card is changed only by a participant of the board; an agent moves or creates a card only
 *   into the columns `agents.mayMoveTo` lists and no person owns.
 * - A write that names the `updated` it read is refused when the card's `updated` differs (a
 *   stale write), and every write is refused when the card's file changed while it was written.
 * - No text holding a secret, a path of this machine or a private name is written (guard.ts). A
 *   path under the repository or the workspace is first rewritten as a card cites it (its path in
 *   the repository, or `<repository>:<path>`), and the write's event lists each rewrite
 *   (`data.rewritten`); a path under the home folder outside the workspace is refused unless the
 *   writer asks for it to be written as `<home>/…`.
 * - Comments are appended, never rewritten; every change writes its event line.
 * - A card whose file changed without an event is announced as changed by `unknown`.
 */
export interface BoardOptions {
  /** The board folder. */
  dir: string;
  /** The repository the board is in; found from `dir` when not given. */
  root?: string;
  /** The home folder (a path under it is a path of this machine); the user's when not given. */
  home?: string;
  now?: () => Date;
  /** Makes the sanitizer the guard finds secrets and machine paths with; the board's own (sanitize.ts) when not given. */
  sanitizer?: SanitizerFactory;
}

export interface BoardContext {
  dir: string;
  root: string;
  home: string;
  now: () => Date;
  /** The host's sanitizer (BoardOptions.sanitizer); the board's own when absent. */
  sanitizer?: SanitizerFactory;
}

export interface WriteResult {
  card: Card;
  /** The events the write appended; none when there was nothing to change (and nothing was written). */
  events: BoardEvent[];
}

/** The nearest folder at or above `start` that holds `.git`, or undefined. */
export function findRepositoryRoot(start: string): string | undefined {
  let current = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** The board of the repository a folder is in: `docs/codelead/board` under the repository's root (or under the folder, outside any repository). */
export function boardLocation(start: string): { dir: string; root: string } {
  const root = findRepositoryRoot(start) ?? path.resolve(start);
  return { dir: path.join(root, ...BOARD_FOLDER.split("/")), root };
}

export function boardContext(options: BoardOptions): BoardContext {
  const dir = path.resolve(options.dir);
  let root = options.root ? path.resolve(options.root) : findRepositoryRoot(dir);
  if (!root) root = dir.split(path.sep).slice(-3).join("/") === BOARD_FOLDER ? path.resolve(dir, "..", "..", "..") : dir;
  return { dir, root, home: options.home ?? os.homedir(), now: options.now ?? (() => new Date()), ...(options.sanitizer ? { sanitizer: options.sanitizer } : {}) };
}

function scopeOf(ctx: BoardContext, config: BoardConfig): GuardScope {
  return { dir: ctx.dir, root: ctx.root, home: ctx.home, workspace: workspaceOf(ctx.root, config), ...(ctx.sanitizer ? { sanitizer: ctx.sanitizer } : {}) };
}

/** How one write cites the files of this machine its texts name (guard.ts `rewritePaths`). */
interface PathWriting {
  scope: GuardScope;
  /** Write a path under the home folder, outside the workspace, as `<home>/…`: the writer asked for it. */
  home: boolean;
}

function pathWriting(ctx: BoardContext, config: BoardConfig, home: boolean | undefined): PathWriting {
  return { scope: scopeOf(ctx, config), home: home === true };
}

/** A text with its paths of this machine rewritten as a card cites them; each rewrite is added to `into`, once. */
function cited(writing: PathWriting, text: string, into: string[]): string {
  const { text: written, rewritten } = rewritePaths(writing.scope, text, { home: writing.home });
  for (const entry of rewritten) if (!into.includes(entry)) into.push(entry);
  return written;
}

/** The rewrites of a write, as its event carries them (`data.rewritten`): nothing to add when there were none. */
function rewrittenData(rewritten: string[]): { rewritten?: string[] } {
  return rewritten.length > 0 ? { rewritten: [...rewritten] } : {};
}

/** "#42", "42" and "0042" name card 42; any other word names a card with that word as its id. */
export function parseCardId(text: string): CardId | undefined {
  const trimmed = text.trim().replace(/^#/, "");
  if (/^\d+$/.test(trimmed)) {
    const id = Number(trimmed);
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
  }
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed) ? trimmed : undefined;
}

// ---------------------------------------------------------------------------------------------
// Reading

/** One file of `items/`, read: the card when its front matter could be read, and its problems. */
export interface LoadedCard {
  file: string;
  raw: string;
  card?: Card;
  problems: string[];
  /** The file's size and times, taken just before it was read (when the reading asked for them). */
  stamp?: FileStamp;
}

/** The names of the card files in `items/`, sorted; undefined when there is no such folder. */
function itemNames(ctx: BoardContext): string[] | undefined {
  try {
    return fs
      .readdirSync(path.join(ctx.dir, "items"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return undefined;
  }
}

/** Reads every card file; with `stamped`, each file's stamp is taken before it is read, so that a change made while it is read shows as a different stamp next time. */
function readItems(ctx: BoardContext, stamped = false): LoadedCard[] {
  const folder = path.join(ctx.dir, "items");
  return (itemNames(ctx) ?? []).map((name) => {
    const file = `items/${name}`;
    const stamp = stamped ? fileStamp(path.join(folder, name)) : undefined;
    const raw = fs.readFileSync(path.join(folder, name), "utf8");
    const { card, problems } = parseCardText(raw);
    return { file, raw, problems, ...(stamp ? { stamp } : {}), ...(card ? { card: { ...card, file, hash: digest(raw) } } : {}) };
  });
}

function numericIdOf(item: LoadedCard): number | undefined {
  if (item.card && typeof item.card.id === "number") return item.card.id;
  const match = /^(\d+)(?:-|\.md$)/.exec(path.posix.basename(item.file));
  return match ? Number(match[1]) : undefined;
}

function idKeyOf(item: LoadedCard): string | undefined {
  if (item.card && item.card.id !== "") return String(item.card.id);
  const numeric = numericIdOf(item);
  return numeric === undefined ? undefined : String(numeric);
}

export interface BoardView {
  config: BoardConfig;
  /** Every card whose front matter could be read, archived ones included. */
  cards: Card[];
  /** Files of `items/` that are no card the board can read, with why. */
  unreadable: Array<{ file: string; problems: string[] }>;
}

export function readBoard(ctx: BoardContext): BoardView {
  const { config } = readBoardConfig(ctx.dir);
  const items = readItems(ctx);
  return {
    config,
    cards: items.flatMap((item) => (item.card ? [item.card] : [])),
    unreadable: items.filter((item) => !item.card).map((item) => ({ file: item.file, problems: item.problems }))
  };
}

export interface CardFilter {
  /** A column's id or name. */
  column?: string;
  /** Every one of these tags. */
  tags?: string[];
  type?: string;
  /** The repository, as the tag `repo:<name>`. */
  repo?: string;
  /** Words in the title or the description. */
  text?: string;
  /** Show archived cards (they are left out otherwise). */
  archived?: boolean;
}

/** True when a card passes every part of the filter. Filters never move a card out of its column. */
export function matchesFilter(card: CardData, filter: CardFilter, config: BoardConfig): boolean {
  if (card.archived !== undefined && !filter.archived) return false;
  if (filter.column !== undefined && card.column !== (columnOf(config, filter.column)?.id ?? filter.column)) return false;
  if (filter.type !== undefined && card.type !== filter.type) return false;
  if (filter.tags && !filter.tags.every((tag) => card.tags.includes(tag))) return false;
  if (filter.repo !== undefined && !card.tags.includes(`repo:${filter.repo}`)) return false;
  if (filter.text !== undefined) {
    const wanted = filter.text.toLowerCase();
    if (!card.title.toLowerCase().includes(wanted) && !card.description.toLowerCase().includes(wanted)) return false;
  }
  return true;
}

export function listCards(ctx: BoardContext, filter: CardFilter = {}): { view: BoardView; cards: Card[] } {
  const view = readBoard(ctx);
  if (filter.column !== undefined) requireColumn(view.config, filter.column);
  if (filter.type !== undefined) requireType(view.config, filter.type);
  return { view, cards: view.cards.filter((card) => matchesFilter(card, filter, view.config)) };
}

function findLoaded(items: LoadedCard[], id: CardId): LoadedCard {
  const wanted = String(id);
  const found = items.filter((item) => item.card && String(item.card.id) === wanted);
  if (found.length > 1) {
    throw new BoardRefusal("invalid", `Refused: the id ${wanted} belongs to more than one card (${found.map((item) => item.file).join(", ")}); nothing was written. Give one of them a new id.`);
  }
  if (found.length === 1) return found[0]!;
  const named = items.find((item) => !item.card && fileNameFitsId(path.posix.basename(item.file), id));
  if (named) {
    throw new BoardRefusal("invalid", `Refused: ${named.file} cannot be read as a card: ${named.problems.join("; ")}. Nothing was written.`);
  }
  throw new BoardRefusal("not-found", `No card #${wanted} on the board.`);
}

/** A card by its id, with its file's problems (a reader shows a card with problems; a writer refuses it). */
export function getCard(ctx: BoardContext, id: CardId): { card: Card; problems: string[] } {
  const loaded = findLoaded(readItems(ctx), id);
  return { card: loaded.card!, problems: loaded.problems };
}

/** A card's relations as the card states them, and as other cards state them towards it. */
export function relationsOf(cards: CardData[], id: CardId): Array<{ kind: string; to: CardId; statedBy: CardId }> {
  const wanted = String(id);
  const own = cards.find((card) => String(card.id) === wanted);
  const stated = (own?.relations ?? []).map((relation) => ({ kind: relation.kind, to: relation.to, statedBy: own!.id }));
  const seen = cards.flatMap((card) =>
    String(card.id) === wanted
      ? []
      : card.relations.filter((relation) => String(relation.to) === wanted).map((relation) => ({ kind: RELATION_SEEN_FROM_TARGET[relation.kind] ?? relation.kind, to: card.id, statedBy: card.id }))
  );
  return [...stated, ...seen];
}

// ---------------------------------------------------------------------------------------------
// Rules

function requireParticipant(config: BoardConfig, id: string): Participant {
  const participant = participantOf(config, id);
  if (!participant) {
    throw new BoardRefusal("participant", `Refused: "${id}" is not a participant of the board (${config.participants.map((entry) => entry.id).join(", ")}); add it to board.json's participants first. Nothing was written.`);
  }
  return participant;
}

function requireColumn(config: BoardConfig, idOrName: string): BoardColumn {
  const column = columnOf(config, idOrName);
  if (!column) throw new BoardRefusal("column", `Refused: "${idOrName}" is not a column of the board (${config.columns.map((entry) => entry.id).join(", ")}). Nothing was written.`);
  return column;
}

function requireType(config: BoardConfig, type: string): void {
  if (!config.types.includes(type)) throw new BoardRefusal("type", `Refused: "${type}" is not a card type of the board (${config.types.join(", ")}). Nothing was written.`);
}

/** An agent moves or creates a card only into the columns it may; a person, anywhere. */
function requireMayEnter(config: BoardConfig, participant: Participant, column: BoardColumn, verb: "move a card into" | "create a card in"): void {
  if (participant.kind === "person") return;
  const allowed = agentColumns(config);
  if (allowed.some((entry) => entry.id === column.id)) return;
  const why = column.owner === "person" ? "a person's column" : "not in agents.mayMoveTo";
  throw new BoardRefusal(
    "column",
    `Refused: ${participant.id} is an agent and may not ${verb} ${column.name} (${why}); an agent may ${verb} ${allowed.map((entry) => entry.name).join(", ")}. Nothing was written.`
  );
}

function requireFresh(card: Card, expectUpdated: string | undefined): void {
  if (expectUpdated !== undefined && card.updated !== expectUpdated) {
    throw new BoardRefusal("stale", `Refused: card #${card.id} changed since it was read (its updated is ${card.updated}; the write expected ${expectUpdated}); nothing was written. Read the card again and redo the change.`);
  }
}

function requireRelationKind(kind: string): void {
  if (!(RELATION_KINDS as readonly string[]).includes(kind)) {
    throw new BoardRefusal("usage", `Refused: "${kind}" is not a kind of relation (${RELATION_KINDS.join(", ")}). Nothing was written.`);
  }
}

function oneLine(text: string, what: string): string {
  const trimmed = text.trim();
  if (trimmed === "") throw new BoardRefusal("usage", `Refused: ${what} is empty; nothing was written.`);
  if (/[\r\n]/.test(trimmed)) throw new BoardRefusal("usage", `Refused: ${what} must be one line; nothing was written.`);
  return trimmed;
}

/** Every text of a card that is written into its file, with the name a refusal gives it (never the text itself). */
function cardTexts(card: CardData): Array<[string, string]> {
  const texts: Array<[string, string]> = [
    ["the title", card.title],
    ["the description", card.description]
  ];
  if (card.status !== undefined) texts.push(["the status", card.status]);
  if (card.session !== undefined) texts.push(["the session", card.session]);
  for (const tag of card.tags) texts.push(["a tag", tag]);
  for (const attachment of card.attachments) texts.push(["an attachment's path", `${attachment.path}${attachment.lines ? `:${attachment.lines}` : ""}`]);
  const walk = (value: YamlValue, name: string): void => {
    if (typeof value === "string") texts.push([`the field ${name}`, value]);
    else if (Array.isArray(value)) value.forEach((item) => walk(item, name));
    else if (value !== null && typeof value === "object") for (const [key, child] of Object.entries(value)) walk(child, `${name}.${key}`);
  };
  for (const [key, value] of Object.entries(card.fields)) walk(value, key);
  card.thread.forEach((comment, index) => texts.push([`comment ${index + 1}`, comment.body]));
  return texts;
}

function refuseUnsafeCard(scope: GuardScope, card: CardData, names: string[]): void {
  for (const [what, text] of cardTexts(card)) refuseUnsafe(scope, what, text, names);
}

/** A description as a card keeps it: its paths cited (the rewrites added to `rewritten`), then refused when it is still unsafe or would split the card. */
function checkedDescription(writing: PathWriting, text: string, names: string[], rewritten: string[]): string {
  const description = cited(writing, normalizeBody(text), rewritten);
  refuseUnsafe(writing.scope, "the description", description, names);
  if (structureLines(description, false).length > 0) {
    throw new BoardRefusal("structure", 'Refused: the description has a line "## Thread", which would begin the card\'s thread; put it in a code block or reword it. Nothing was written.');
  }
  return description;
}

/** A comment as a card keeps it: its paths cited (the rewrites added to `rewritten`), then refused when it is empty, still unsafe, or would split the card. */
function checkedComment(writing: PathWriting, text: string, rewritten: string[]): string {
  const given = normalizeBody(text);
  if (given === "") throw new BoardRefusal("usage", "Refused: the comment is empty; nothing was written.");
  const body = cited(writing, given, rewritten);
  refuseUnsafe(writing.scope, "the comment", body);
  const structure = structureLines(body, true);
  if (structure.length > 0) {
    throw new BoardRefusal("structure", `Refused: the comment has a line the card would read as its own structure (${JSON.stringify(structure[0]!.trim())}); put it in a code block or reword it. Nothing was written.`);
  }
  return body;
}

/** Who a comment's or a description's text addresses (`@robin`, `@Claude`), for its event's `data.addressed`: nothing to add when it names no one. */
function addressing(text: string, config: BoardConfig): { addressed?: string[] } {
  const ids = mentionsIn(text, config.participants);
  return ids.length > 0 ? { addressed: ids } : {};
}

/** A comment's event data: its first words, and who it addresses. */
function commentData(body: string, config: BoardConfig): Record<string, unknown> {
  return { excerpt: excerpt(body), ...addressing(body, config) };
}

/** Tags, each one line and said once; `rewrite` makes each tag as the card will keep it (its paths cited) before they are compared. */
function normalizeTags(tags: string[], rewrite: (tag: string) => string = (tag) => tag): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = rewrite(oneLine(raw, "a tag"));
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// What this machine saw of each card, and the events nobody wrote

function countByItem(events: ReadEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { event } of events) {
    if (event.item === undefined) continue;
    const key = String(event.item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** The event a card's file owes when it changed (or appeared) with no event naming it since this machine last saw it. */
function unrecordedEvent(ctx: BoardContext, item: LoadedCard, state: CardState | undefined, count: number): BoardEvent | undefined {
  const key = idKeyOf(item);
  if (key === undefined) return undefined;
  const hash = digest(item.raw);
  const itemId: CardId = item.card?.id !== undefined && item.card.id !== "" ? item.card.id : /^\d+$/.test(key) ? Number(key) : key;
  // The event's time is the file's, read only for an event that is owed.
  const at = (): string => {
    try {
      return isoSeconds(new Date(fs.statSync(path.join(ctx.dir, item.file)).mtimeMs));
    } catch {
      return isoSeconds(ctx.now());
    }
  };
  const unreadable = item.card ? {} : { problem: "the card's file cannot be read as a card" };
  if (!state) {
    if (count > 0) return undefined;
    return { at: at(), by: UNKNOWN_PARTICIPANT, item: itemId, kind: "item.created", data: { synthesized: true, file: item.file, ...(item.card ? { title: item.card.title } : {}), ...unreadable } };
  }
  if (state.hash === hash || count > state.events) return undefined;
  const fields = item.card ? changedParts(state.parts, partsOf(item.card)) : [];
  return { at: at(), by: UNKNOWN_PARTICIPANT, item: itemId, kind: "item.updated", data: { synthesized: true, fields, ...unreadable } };
}

/** After the board's own write: the written cards as they now are. The stamps of the files are dropped, since the write changed them. */
function noteCards(ctx: BoardContext, written: Array<{ id: CardId; file: string; raw: string; data: CardData }>): void {
  const { cards } = readCardStates(ctx.dir);
  const counts = countByItem(readEvents(ctx.dir).events);
  for (const entry of written) {
    cards[String(entry.id)] = { file: entry.file, hash: digest(entry.raw), events: counts.get(String(entry.id)) ?? 0, parts: partsOf(entry.data) };
  }
  writeCardStates(ctx.dir, { cards });
}

/**
 * The stamps of a reading of every file, when they can be trusted: the log did not change while it
 * was read, and no file was changed at or after the moment the reading took the lock (by the file
 * system's own clock, the lock file's time). A file changed within the same tick of that clock as
 * the reading could change again within it and keep its stamp, so such a reading leaves no stamps,
 * and the next check reads every file again.
 */
function filesSeen(ctx: BoardContext, items: LoadedCard[], log: { before?: FileStamp; after?: FileStamp; lines: number }): FilesSeen | undefined {
  const lockedAt = fileStamp(path.join(ctx.dir, LOCK_FILE))?.mtimeMs;
  if (lockedAt === undefined || log.before === undefined || !sameStamp(log.before, log.after)) return undefined;
  const settled = (stamp: FileStamp): boolean => stamp.mtimeMs < lockedAt && stamp.ctimeMs < lockedAt;
  if (!settled(log.before)) return undefined;
  const seen: Record<string, FileStamp> = {};
  for (const item of items) {
    if (item.stamp === undefined || !settled(item.stamp)) return undefined;
    seen[path.posix.basename(item.file)] = item.stamp;
  }
  return { log: { ...log.before, lines: log.lines }, items: seen };
}

/**
 * Reads every card file and the log, and announces what changed without an event (see
 * `synthesizeEvents`). A reading that announced nothing also records the files' stamps, so that
 * the next check can tell from the stamps alone that nothing changed. Returns the events it
 * appended, the cards it read and the log as it read it. Runs under the board's lock.
 */
function readAndSynthesize(ctx: BoardContext): { synthesized: BoardEvent[]; items: LoadedCard[]; log: ReturnType<typeof readEvents> } {
  const before = fileStamp(eventsPath(ctx.dir));
  const log = readEvents(ctx.dir);
  const after = fileStamp(eventsPath(ctx.dir));
  const counts = countByItem(log.events);
  const states = readCardStates(ctx.dir);
  const items = readItems(ctx, true);
  const next: Record<string, CardState> = {};
  const synthesized: BoardEvent[] = [];
  for (const item of items) {
    const key = idKeyOf(item);
    if (key === undefined) continue;
    const count = counts.get(key) ?? 0;
    const event = unrecordedEvent(ctx, item, states.cards[key], count);
    if (event) synthesized.push(event);
    next[key] = { file: item.file, hash: digest(item.raw), events: count + (event ? 1 : 0), parts: item.card ? partsOf(item.card) : {} };
  }
  appendEvents(ctx.dir, synthesized);
  const files = synthesized.length === 0 ? filesSeen(ctx, items, { before, after, lines: log.count }) : undefined;
  if (JSON.stringify(next) !== JSON.stringify(states.cards) || JSON.stringify(files) !== JSON.stringify(states.files)) {
    writeCardStates(ctx.dir, { cards: next, ...(files ? { files } : {}) });
  }
  return { synthesized, items, log };
}

/**
 * Appends `item.updated` by `unknown` for every card whose file changed with no event naming it
 * since this machine last looked, and `item.created` by `unknown` for a card that appeared with
 * no event at all; the event's time is the file's. Returns what it appended.
 */
export function synthesizeEvents(ctx: BoardContext): BoardEvent[] {
  return withBoardLock(ctx.dir, () => readAndSynthesize(ctx).synthesized);
}

// ---------------------------------------------------------------------------------------------
// Writing

function replaceCardFile(ctx: BoardContext, loaded: LoadedCard, text: string): void {
  const file = path.join(ctx.dir, loaded.file);
  let current: string | undefined;
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {
    current = undefined;
  }
  if (current !== loaded.raw) {
    throw new BoardRefusal("stale", `Refused: ${loaded.file} changed while it was being written; nothing was written. Read the card again and redo the change.`);
  }
  writeFileAtomic(file, text);
}

interface Change {
  next?: CardData;
  comment?: Comment;
  events: BoardEvent[];
}

/** The one path every change of an existing card takes: the rules, the file, the events, the state. */
function changeCard(
  ctx: BoardContext,
  id: CardId,
  as: string,
  expectUpdated: string | undefined,
  change: (card: Card, config: BoardConfig, participant: Participant, at: string, cards: Card[]) => Change
): WriteResult {
  return withBoardLock(ctx.dir, () => {
    const { config } = readBoardConfig(ctx.dir);
    const participant = requireParticipant(config, as);
    const items = readItems(ctx);
    const loaded = findLoaded(items, id);
    if (loaded.problems.length > 0) {
      throw new BoardRefusal("invalid", `Refused: ${loaded.file} has problems: ${loaded.problems.join("; ")}. Nothing was written; \`codelead board validate\` lists them.`);
    }
    const card = loaded.card!;
    requireFresh(card, expectUpdated);
    const at = isoSeconds(ctx.now());
    const result = change(card, config, participant, at, items.flatMap((item) => (item.card ? [item.card] : [])));
    if (result.events.length === 0) return { card, events: [] };

    // A change someone made to this card's file without an event is announced before this one.
    const key = String(card.id);
    const owed = unrecordedEvent(ctx, loaded, readCardStates(ctx.dir).cards[key], countByItem(readEvents(ctx.dir).events).get(key) ?? 0);
    const next: CardData = { ...(result.next ?? card), updated: at };
    let text = updateCardText(loaded.raw, card, next);
    if (result.comment) text = appendCommentText(text, result.comment);
    const reread = parseCardText(text);
    if (!reread.card || reread.problems.length > 0) {
      throw new BoardRefusal("invalid", `Refused: the card would not read back after the change: ${reread.problems.join("; ")}. Nothing was written.`);
    }
    replaceCardFile(ctx, loaded, text);
    appendEvents(ctx.dir, owed ? [owed, ...result.events] : result.events);
    noteCards(ctx, [{ id: card.id, file: loaded.file, raw: text, data: reread.card }]);
    return { card: { ...reread.card, file: loaded.file, hash: digest(text) }, events: result.events };
  });
}

export interface NewCardInput {
  /** A name for the card within one call, so that other cards of the same call can relate to it before it has an id. */
  ref?: string;
  /** How a refusal names this card among the cards of one call (`the card "## A title" (line 12 of cards.md)`): its refusal begins with it. */
  label?: string;
  type: string;
  title: string;
  /** A column's id or name; the board's first column when not given. */
  column?: string;
  tags?: string[];
  description?: string;
  /** Each relation names a card on the board by its id (`to`), or a card of the same call by its `ref`. */
  relations?: Array<{ kind: string; to?: CardId; ref?: string }>;
  attachments?: Attachment[];
  /** The type's fields; a decision's `ask` is checked as `updateCard` checks it. */
  fields?: YamlMap;
  session?: string;
  status?: string;
  /** The person's colour mark: one of CARD_COLORS (its hex or its name), or none. */
  color?: string;
  /** More for the `item.created` event's data (where the card came from). */
  eventData?: Record<string, unknown>;
}

/** Who writes now, as a decision written without its `by` or `on` records them: the writer, today (UTC). */
function decisionWriter(config: BoardConfig, as: string, at: string): DecisionWriter {
  return { as, today: at.slice(0, 10), participants: config.participants.map((participant) => participant.id) };
}

/**
 * The type's fields as a card keeps them: an ask checked (a text, one to three sentences), a
 * decision checked (`checkedDecided`: the option chosen, by a participant, on a day), an empty one
 * left out.
 */
function checkedFields(fields: YamlMap, writer: DecisionWriter): YamlMap {
  let kept = fields;
  if (Object.prototype.hasOwnProperty.call(kept, ASK_FIELD)) {
    const { [ASK_FIELD]: raw, ...rest } = kept;
    const ask = raw === null || raw === undefined ? undefined : checkedAsk(raw);
    kept = ask === undefined ? rest : { [ASK_FIELD]: ask, ...rest };
  }
  if (Object.prototype.hasOwnProperty.call(kept, DECIDED_FIELD)) {
    const { [DECIDED_FIELD]: raw, ...rest } = kept;
    const decided = raw === null || raw === undefined ? undefined : checkedDecided(raw, writer);
    // In its own place among the fields, as it was given.
    kept = decided === undefined ? rest : { ...kept, [DECIDED_FIELD]: decided };
  }
  return kept;
}

/** A recorded decision as an event carries it (`data.decided`): its option, by and on; null when there is none. */
function decisionData(value: YamlValue | undefined): Record<string, string> | null {
  const decision = value === undefined || value === null ? undefined : readDecision(value);
  return decision ? { option: decision.option, by: decision.by, on: decision.on } : null;
}

/** True when a value given for `fields.decided` gives a decision: anything but null or an empty text, which give none. */
function givesDecision(value: YamlValue | undefined): boolean {
  return value !== undefined && value !== null && !(typeof value === "string" && value.trim() === "");
}

/**
 * The decision is the person's (AGENTS.md: an agent never sets `fields.decided`; its recommendation
 * goes in the ask): an agent's write that gives a card a decision, or takes its decision away, is
 * refused in these words, and nothing is written.
 */
function refuseAgentDecision(participant: Participant): never {
  throw new BoardRefusal("usage", `Refused: ${participant.id} is an agent; the decision is the person's: an agent writes its recommendation in fields.ask. Nothing was written.`);
}

export interface CreateOptions {
  /** Tag each card `by:<creator>`, as a card made with `new` is. Default: yes. */
  tagCreator?: boolean;
  /** Work everything out and write nothing: the cards as they would be, with the ids they would get. */
  dryRun?: boolean;
  /**
   * Write each relation a new card states as its own `relation.added` event too, as `set --relate`
   * does, after the cards' `item.created` events (a batch does). Default: no.
   */
  relationEvents?: boolean;
  /** Write a path under the home folder, outside the workspace, as `<home>/…` instead of refusing it (`--rewrite-paths`). Default: no. */
  rewriteHomePaths?: boolean;
}

/** A card's refusal, beginning with how the call names the card (`label`), when it has one. */
function labelled<T>(label: string | undefined, work: () => T): T {
  if (label === undefined) return work();
  try {
    return work();
  } catch (error) {
    if (!(error instanceof BoardRefusal)) throw error;
    throw new BoardRefusal(error.code, `Refused: ${label}: ${error.message.replace(/^Refused: /, "")}`);
  }
}

/**
 * Creates cards: the ids come from board.json's `nextId` (never one a card already has), raised in
 * the same step; each card is written with its `item.created` event, which carries the card's
 * decision as `data.decided` when it is created with one (only a person gives one). All are checked
 * before any is written: one refusal and nothing is. Each result's events are the card's
 * `item.created`, then its `relation.added` ones when they are asked for; the log has every
 * `item.created` first, then the relations, so that a relation never names a card before it exists.
 */
export function createCards(ctx: BoardContext, as: string, inputs: NewCardInput[], options: CreateOptions = {}): WriteResult[] {
  return withBoardLock(ctx.dir, () => {
    const file = readBoardConfig(ctx.dir);
    const { config } = file;
    const participant = requireParticipant(config, as);
    if (participant.kind === "agent" && !config.agents.mayCreate) {
      throw new BoardRefusal("not-allowed", `Refused: ${as} is an agent, and agents do not create cards on this board (agents.mayCreate is false). Nothing was written.`);
    }
    const items = readItems(ctx);
    const known = new Set(items.flatMap((item) => (item.card ? [String(item.card.id)] : [])));
    const highest = Math.max(0, ...items.map(numericIdOf).filter((id): id is number => id !== undefined));
    const start = Math.max(config.nextId ?? 1, highest + 1);
    const refs = new Map<string, number>();
    inputs.forEach((input, index) => {
      if (input.ref === undefined) return;
      if (refs.has(input.ref)) throw new BoardRefusal("usage", `Refused: two new cards are both called "${input.ref}". Nothing was written.`);
      refs.set(input.ref, start + index);
    });
    const names = readPrivateNames(ctx.dir);
    const now = isoSeconds(ctx.now());
    const writing = pathWriting(ctx, config, options.rewriteHomePaths);

    const made = inputs.map((input, index) => labelled(input.label, () => {
      const id = start + index;
      const column = requireColumn(config, input.column ?? config.columns[0]!.id);
      requireMayEnter(config, participant, column, "create a card in");
      requireType(config, input.type);
      if (participant.kind === "agent" && givesDecision(input.fields?.[DECIDED_FIELD])) refuseAgentDecision(participant);
      // The paths of this machine the card's texts name, as the card now cites them: its event lists them.
      const rewritten: string[] = [];
      const title = cited(writing, oneLine(input.title, "the title"), rewritten);
      const description = checkedDescription(writing, input.description ?? "", names, rewritten);
      const tags = normalizeTags([...(input.tags ?? []), ...(options.tagCreator === false ? [] : [`by:${as}`])], (tag) => cited(writing, tag, rewritten));
      const relations: CardData["relations"] = [];
      for (const relation of input.relations ?? []) {
        requireRelationKind(relation.kind);
        const to = relation.ref !== undefined ? refs.get(relation.ref) : relation.to;
        if (to === undefined) throw new BoardRefusal("usage", `Refused: a relation names "${relation.ref ?? ""}", which is no card of this call. Nothing was written.`);
        // A card of this call is named by its ref; an id names a card already on the board, never one this call is about to number.
        if (relation.ref === undefined && !known.has(String(to))) throw new BoardRefusal("not-found", `Refused: a relation names card #${to}, which is not on the board. Nothing was written.`);
        if (String(to) === String(id)) throw new BoardRefusal("usage", "Refused: a card cannot relate to itself. Nothing was written.");
        if (!relations.some((entry) => entry.kind === relation.kind && String(entry.to) === String(to))) relations.push({ kind: relation.kind, to });
      }
      const attachments = (input.attachments ?? []).map((attachment) => ({ ...attachment, path: cited(writing, oneLine(attachment.path, "an attachment's path"), rewritten) }));
      const status = input.status !== undefined && input.status.trim() !== "" ? cited(writing, oneLine(input.status, "the status"), rewritten) : undefined;
      const color = input.color === undefined || ["", "none"].includes(input.color.trim().toLowerCase()) ? undefined : requireCardColor(input.color);
      const data: CardData = {
        id,
        type: input.type,
        title,
        column: column.id,
        tags,
        ...(color !== undefined ? { color } : {}),
        author: as,
        created: now,
        updated: now,
        relations,
        attachments,
        fields: checkedFields(input.fields ?? {}, decisionWriter(config, as, now)),
        ...(input.session !== undefined ? { session: oneLine(input.session, "the session") } : {}),
        ...(status !== undefined ? { status } : {}),
        extra: {},
        description,
        thread: []
      };
      refuseUnsafeCard(writing.scope, data, names);
      const text = serializeCard(data);
      const reread = parseCardText(text);
      if (reread.problems.length > 0) throw new BoardRefusal("invalid", `Refused: the new card would not read back: ${reread.problems.join("; ")}. Nothing was written.`);
      const fileName = cardFileName(id, slugify(title));
      // A card created with its decision (a person's `new --field decided=…`): the event records it, as an update's does.
      const decided = decisionData(data.fields[DECIDED_FIELD]);
      const event: BoardEvent = {
        at: now,
        by: as,
        item: id,
        kind: "item.created",
        data: { title, type: input.type, column: column.id, ...(decided ? { decided } : {}), ...(input.eventData ?? {}), ...addressing(description, config), ...rewrittenData(rewritten) }
      };
      const related: BoardEvent[] = options.relationEvents
        ? relations.map((relation) => ({ at: now, by: as, item: id, kind: "relation.added", data: { kind: relation.kind, to: relation.to } }))
        : [];
      return { data, text, file: `items/${fileName}`, event, related };
    }));

    const results = made.map((entry) => ({ card: { ...entry.data, file: entry.file, hash: digest(entry.text) }, events: [entry.event, ...entry.related] }));
    if (options.dryRun || made.length === 0) return results;
    writeBoardConfig(ctx.dir, file, { ...config, nextId: start + made.length });
    for (const entry of made) {
      const target = path.join(ctx.dir, ...entry.file.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.text, { encoding: "utf8", flag: "wx" });
    }
    appendEvents(ctx.dir, [...made.map((entry) => entry.event), ...made.flatMap((entry) => entry.related)]);
    noteCards(ctx, made.map((entry) => ({ id: entry.data.id, file: entry.file, raw: entry.text, data: entry.data })));
    return results;
  });
}

/** Creates one card, tagged `by:<creator>`. */
export function createCard(ctx: BoardContext, as: string, input: NewCardInput): WriteResult {
  return createCards(ctx, as, [input])[0]!;
}

/**
 * Appends a comment to a card's thread, with its `comment.added` event (`data.addressed`: who the
 * comment addresses, when it mentions anyone; `data.rewritten`: the paths of this machine it named,
 * as the comment now cites them). `rewriteHomePaths`: a path under the home folder outside the
 * workspace is written as `<home>/…` instead of refused.
 */
export function addComment(ctx: BoardContext, id: CardId, input: { as: string; body: string; expectUpdated?: string; rewriteHomePaths?: boolean }): WriteResult {
  return changeCard(ctx, id, input.as, input.expectUpdated, (card, config, _participant, at) => {
    const rewritten: string[] = [];
    const body = checkedComment(pathWriting(ctx, config, input.rewriteHomePaths), input.body, rewritten);
    return { comment: { author: input.as, at, body }, events: [{ at, by: input.as, item: card.id, kind: "comment.added", data: { ...commentData(body, config), ...rewrittenData(rewritten) } }] };
  });
}

/**
 * Moves a card into a column (an agent: only into its columns). With `comment`, the comment is
 * written first, both events carry the same time, and each names the other (`data.withMove` on the
 * comment, `data.withComment` on the move: "comment and move", one line wherever events are listed).
 * A card already in the
 * column is left as it is, unless there is a comment to write or a place to put it.
 *
 * `after` is where the card was dropped: below that card of the column (its id), or at the top
 * (null). The move's event records it (`data.after`), and the column's order is read from the
 * events (`cardRanks`): no rank is written into a card. Inside its own column a card with a place is
 * moved there (an `item.moved` from and to the same column). A place that names no other card of
 * the column (it moved away meanwhile) is no place: across columns the card goes to the top, and
 * inside its column nothing is written.
 *
 * The comment's paths of this machine are cited as `addComment` cites them, with the same
 * `rewriteHomePaths`.
 *
 * A landing is recorded where the card's face shows it: when the comment's first line starts with
 * `Landed:` (what AGENTS.md teaches for work that is done) and the card's type has a `landed` field
 * (a task), the words after `Landed:` on that line become one more entry of the field, with an
 * `item.updated` event that says so (`data.landed`). An entry already there is not written twice.
 */
export function moveCard(
  ctx: BoardContext,
  id: CardId,
  input: { as: string; to: string; expectUpdated?: string; comment?: string; after?: CardId | null; rewriteHomePaths?: boolean }
): WriteResult {
  return changeCard(ctx, id, input.as, input.expectUpdated, (card, config, participant, at, cards) => {
    const column = requireColumn(config, input.to);
    requireMayEnter(config, participant, column, "move a card into");
    const events: BoardEvent[] = [];
    let comment: Comment | undefined;
    if (input.comment !== undefined) {
      const rewritten: string[] = [];
      const body = checkedComment(pathWriting(ctx, config, input.rewriteHomePaths), input.comment, rewritten);
      comment = { author: input.as, at, body };
      events.push({ at, by: input.as, item: card.id, kind: "comment.added", data: { ...commentData(body, config), ...rewrittenData(rewritten), withMove: true } });
    }
    const anchor =
      input.after === undefined || input.after === null
        ? undefined
        : cards.find((other) => String(other.id) === String(input.after) && String(other.id) !== String(card.id) && other.column === column.id && other.archived === undefined);
    const placed = input.after === null || anchor !== undefined;
    if (card.column !== column.id || placed) {
      events.push({ at, by: input.as, item: card.id, kind: "item.moved", data: { from: card.column, to: column.id, ...(anchor ? { after: anchor.id } : {}), ...(comment ? { withComment: true } : {}) } });
    }
    let fields = card.fields;
    const landing = comment !== undefined ? landingOf(comment.body) : undefined;
    if (landing !== undefined && (TYPE_FIELDS[card.type] ?? []).includes("landed")) {
      const had = landedEntries(card.fields.landed);
      if (!had.includes(landing)) {
        fields = { ...card.fields, landed: [...had, landing] };
        events.push({ at, by: input.as, item: card.id, kind: "item.updated", data: { fields: ["fields"], landed: landing } });
      }
    }
    return { next: { ...card, column: column.id, fields }, ...(comment ? { comment } : {}), events };
  });
}

/** The words after `Landed:` on a comment's first line, or undefined when the comment does not start so. */
export function landingOf(body: string): string | undefined {
  const first = body.split("\n").find((line) => line.trim() !== "") ?? "";
  const match = /^\s*landed:\s*(.*\S)\s*$/i.exec(first);
  return match ? match[1] : undefined;
}

/** A `landed` field's entries as texts: a list as given, one text as one entry, nothing as none. */
function landedEntries(value: YamlValue | undefined): string[] {
  if (value === undefined || value === null || value === "") return [];
  return (Array.isArray(value) ? value : [value]).map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)));
}

export interface CardChanges {
  title?: string;
  type?: string;
  description?: string;
  /** A one-line status; null (or an empty text) removes it. */
  status?: string | null;
  /** The person's colour mark: one of CARD_COLORS (its hex, with or without "#", or its name); null, "" or "none" removes it. */
  color?: string | null;
  addTags?: string[];
  removeTags?: string[];
  addRelations?: Array<{ kind: string; to: CardId }>;
  removeRelations?: Array<{ kind: string; to: CardId }>;
  addAttachments?: Attachment[];
  /** Typed fields to set; null removes one. */
  fields?: Record<string, YamlValue | null>;
}

/**
 * Changes a card's fields, tags, relations and attachments. Each tag, relation and attachment
 * gets its own event; the other changes share one `item.updated` that names them (a decision's ask
 * as `ask`, the colour as `color`, the type's other fields as `fields`). When the decision
 * (`fields.decided`) is set, changed or removed, that event also carries it as `data.decided`
 * (`{ option, by, on }`, or null once removed): the person's answer, which the check says apart.
 * Only a person gives a decision or takes one away: an agent's write that would is refused.
 *
 * The title, the description, the status, each tag and each attachment's path have their paths of
 * this machine cited first (the repository's as the path in it, the workspace's as
 * `<repository>:<path>`; with `rewriteHomePaths`, the home folder's as `<home>/…`), and the event
 * of the change lists them (`data.rewritten`: the `item.updated` for the first three, a tag's or an
 * attachment's own event for the others).
 */
export function updateCard(ctx: BoardContext, id: CardId, input: { as: string; changes: CardChanges; expectUpdated?: string; rewriteHomePaths?: boolean }): WriteResult {
  return changeCard(ctx, id, input.as, input.expectUpdated, (card, config, participant, at, cards) => {
    const { changes } = input;
    // The decision is the person's: an agent's write that gives one (set, changed, even as it was) or removes the card's is refused.
    if (participant.kind === "agent" && changes.fields && Object.prototype.hasOwnProperty.call(changes.fields, DECIDED_FIELD)) {
      if (givesDecision(changes.fields[DECIDED_FIELD]) || decisionData(card.fields[DECIDED_FIELD]) !== null) refuseAgentDecision(participant);
    }
    const names = readPrivateNames(ctx.dir);
    const writing = pathWriting(ctx, config, input.rewriteHomePaths);
    const scope = writing.scope;
    const by = input.as;
    const item = card.id;
    const next: CardData = { ...card, tags: [...card.tags], relations: [...card.relations], attachments: [...card.attachments], fields: { ...card.fields } };
    const events: BoardEvent[] = [];
    const updated: string[] = [];
    // The rewrites of the texts the item.updated names: a text that ends up as the card had it changes nothing, and is not listed.
    const rewritten: string[] = [];
    const keep = (own: string[]): void => {
      for (const entry of own) if (!rewritten.includes(entry)) rewritten.push(entry);
    };

    if (changes.title !== undefined) {
      const own: string[] = [];
      const title = cited(writing, oneLine(changes.title, "the title"), own);
      if (title !== card.title) {
        refuseUnsafe(scope, "the title", title, names);
        next.title = title;
        updated.push("title");
        keep(own);
      }
    }
    if (changes.type !== undefined && changes.type !== card.type) {
      requireType(config, changes.type);
      next.type = changes.type;
      updated.push("type");
    }
    if (changes.description !== undefined) {
      const own: string[] = [];
      const description = checkedDescription(writing, changes.description, names, own);
      if (description !== card.description) {
        next.description = description;
        updated.push("description");
        keep(own);
      }
    }
    if (changes.status !== undefined) {
      const own: string[] = [];
      const status = changes.status === null || changes.status.trim() === "" ? undefined : cited(writing, oneLine(changes.status, "the status"), own);
      if (status !== card.status) {
        if (status === undefined) delete next.status;
        else {
          refuseUnsafe(scope, "the status", status, names);
          next.status = status;
        }
        updated.push("status");
        keep(own);
      }
    }
    if (changes.color !== undefined) {
      const color = changes.color === null || ["", "none"].includes(changes.color.trim().toLowerCase()) ? undefined : requireCardColor(changes.color);
      if (color !== card.color) {
        if (color === undefined) delete next.color;
        else next.color = color;
        updated.push("color");
      }
    }
    for (const given of normalizeTags(changes.addTags ?? [])) {
      const own: string[] = [];
      const tag = cited(writing, given, own);
      if (next.tags.includes(tag)) continue;
      refuseUnsafe(scope, "a tag", tag, names);
      next.tags.push(tag);
      events.push({ at, by, item, kind: "tag.added", data: { tag, ...rewrittenData(own) } });
    }
    // A tag to remove is named as it was added: its paths cited the same way (nothing to list, nothing is written).
    for (const tag of normalizeTags(changes.removeTags ?? [], (given) => cited(writing, given, []))) {
      const index = next.tags.indexOf(tag);
      if (index === -1) continue;
      next.tags.splice(index, 1);
      events.push({ at, by, item, kind: "tag.removed", data: { tag } });
    }
    const same = (left: { kind: string; to: CardId }, right: { kind: string; to: CardId }): boolean => left.kind === right.kind && String(left.to) === String(right.to);
    for (const relation of changes.addRelations ?? []) {
      requireRelationKind(relation.kind);
      if (String(relation.to) === String(card.id)) throw new BoardRefusal("usage", "Refused: a card cannot relate to itself. Nothing was written.");
      if (!cards.some((other) => String(other.id) === String(relation.to))) throw new BoardRefusal("not-found", `Refused: there is no card #${relation.to} on the board to relate to. Nothing was written.`);
      if (next.relations.some((entry) => same(entry, relation))) continue;
      next.relations.push({ kind: relation.kind, to: relation.to });
      events.push({ at, by, item, kind: "relation.added", data: { kind: relation.kind, to: relation.to } });
    }
    for (const relation of changes.removeRelations ?? []) {
      const index = next.relations.findIndex((entry) => same(entry, relation));
      if (index === -1) continue;
      next.relations.splice(index, 1);
      events.push({ at, by, item, kind: "relation.removed", data: { kind: relation.kind, to: relation.to } });
    }
    for (const attachment of changes.addAttachments ?? []) {
      const own: string[] = [];
      const written = { ...attachment, path: cited(writing, oneLine(attachment.path, "an attachment's path"), own) };
      if (next.attachments.some((entry) => entry.path === written.path && entry.lines === written.lines)) continue;
      refuseUnsafe(scope, "an attachment's path", `${written.path}${written.lines ? `:${written.lines}` : ""}`, names);
      next.attachments.push(written);
      events.push({ at, by, item, kind: "attachment.added", data: { path: written.path, ...(written.lines ? { lines: written.lines } : {}), ...rewrittenData(own) } });
    }
    if (changes.fields) {
      // A decision's ask is named on its own in the event ("changed its ask"); the other fields as "fields".
      const changed = new Set<string>();
      const writer = decisionWriter(config, by, at);
      for (const [key, raw] of Object.entries(changes.fields)) {
        const value = raw === null ? null : key === ASK_FIELD ? (checkedAsk(raw) ?? null) : key === DECIDED_FIELD ? (checkedDecided(raw, writer) ?? null) : raw;
        if (value === null) {
          if (Object.prototype.hasOwnProperty.call(next.fields, key)) {
            delete next.fields[key];
            changed.add(key === ASK_FIELD ? "ask" : "fields");
          }
          continue;
        }
        if (sameValue(next.fields[key], value)) continue;
        // A new ask is the decision's first field, as the type lists it.
        if (key === ASK_FIELD && !Object.prototype.hasOwnProperty.call(next.fields, key)) next.fields = { [ASK_FIELD]: value, ...next.fields };
        else next.fields[key] = value;
        changed.add(key === ASK_FIELD ? "ask" : "fields");
      }
      if (changed.size > 0) {
        refuseUnsafeCard(scope, { ...next, thread: [] }, names);
        for (const name of ["ask", "fields"]) if (changed.has(name)) updated.push(name);
      }
    }
    // A decision set, changed or removed rides on the event beside the fields it changed (`data.decided`):
    // the decision as read, its option, by and on, so that a key beside them changing is no new decision.
    const decision = decisionData(next.fields[DECIDED_FIELD]);
    const decided = sameValue(decisionData(card.fields[DECIDED_FIELD]), decision) ? {} : { decided: decision };
    // A new description that mentions someone addresses them (`data.addressed`), as a comment does.
    if (updated.length > 0) {
      events.unshift({ at, by, item, kind: "item.updated", data: { fields: updated, ...decided, ...(updated.includes("description") ? addressing(next.description, config) : {}), ...rewrittenData(rewritten) } });
    }
    return { next, events };
  });
}

/** Archives a card: it leaves the board and stays in its file, searchable. Only a person archives. */
export function archiveCard(ctx: BoardContext, id: CardId, input: { as: string; expectUpdated?: string }): WriteResult {
  return changeCard(ctx, id, input.as, input.expectUpdated, (card, _config, participant, at) => {
    if (participant.kind !== "person") throw new BoardRefusal("not-allowed", `Refused: ${participant.id} is an agent; only a person archives a card. Nothing was written.`);
    if (card.archived !== undefined) return { events: [] };
    return { next: { ...card, archived: at }, events: [{ at, by: input.as, item: card.id, kind: "item.archived", data: { column: card.column } }] };
  });
}

// ---------------------------------------------------------------------------------------------
// Checking: what changed since a participant's cursor

export interface CheckGroup {
  item?: CardId;
  title?: string;
  column?: string;
  type?: string;
  events: BoardEvent[];
}

export interface CheckResult {
  participant: string;
  /** The participant's cursor as it was before this check. */
  cursor: Cursor;
  /** The time the check read from instead of the cursor, when it was given one (`since`); absent otherwise. */
  since?: string;
  /** Events by others after the cursor, on cards the participant has not opened since: what the capsule counts. */
  notifications: BoardEvent[];
  /**
   * Of the notifications, those addressed to the participant (a comment or a description that
   * mentions them, `@claude`: the event's `data.addressed` names them), in order: what a check lists first.
   */
  addressed: BoardEvent[];
  /**
   * Of the notifications, the decisions recorded in a card's fields (the event's `data.decided`: the
   * person's answer to a decision card), in order: per card the last event that records one, unless
   * a later one removed it. What a check lists apart, under "Decided".
   */
  decided: BoardEvent[];
  /** The notifications by card: the card with the newest event first, each card's events in order. */
  groups: CheckGroup[];
  /** Events this check appended for cards changed without one. */
  synthesized: BoardEvent[];
  /** Every event after the cursor, the participant's own included. */
  after: number;
  /** Set when the check moved the cursor (`ack`). */
  acknowledged?: { seen: string; lines: number };
  intervalMinutes: number;
}

function openedSince(opened: Record<string, string>, event: BoardEvent): boolean {
  if (event.item === undefined) return false;
  const when = timeOf(opened[String(event.item)]);
  const at = timeOf(event.at);
  return when !== undefined && at !== undefined && when >= at;
}

/** Moves a participant's cursor to the end of the log (`ack`): the opened cards it has passed are forgotten. */
function acknowledge(ctx: BoardContext, as: string, file: CursorFile, count: number): { seen: string; lines: number } {
  const cursor = file.cursor;
  const now = isoSeconds(ctx.now());
  const nextOpened = Object.fromEntries(Object.entries(cursor.opened ?? {}).filter(([, when]) => (timeOf(when) ?? 0) > (timeOf(now) ?? 0)));
  const next: Cursor = { ...cursor, seen: now, lines: count };
  if (cursor.opened !== undefined || Object.keys(nextOpened).length > 0) next.opened = nextOpened;
  writeCursor(ctx.dir, as, file, next);
  return { seen: now, lines: count };
}

/**
 * A check with nothing new, told without reading a card file or a line of the log: the
 * participant's cursor stands where the last full reading counted the log's end, and every file
 * still has the stamp that reading took (the log, each card file, no file more and none less), so
 * nothing was written since. Undefined when anything differs: the check then reads the board.
 */
function quietCheck(ctx: BoardContext, as: string): { config: BoardConfig; cursorFile: CursorFile; lines: number } | undefined {
  const { config } = readBoardConfig(ctx.dir);
  requireParticipant(config, as);
  const cursorFile = readCursor(ctx.dir, as);
  const lines = cursorFile.cursor.lines;
  if (typeof lines !== "number") return undefined;
  const { files } = readCardStates(ctx.dir);
  if (files === undefined || files.log.lines !== lines || !sameStamp(fileStamp(eventsPath(ctx.dir)), files.log)) return undefined;
  const names = itemNames(ctx) ?? [];
  if (names.length !== Object.keys(files.items).length) return undefined;
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(files.items, name) || !sameStamp(fileStamp(path.join(ctx.dir, "items", name)), files.items[name])) return undefined;
  }
  return { config, cursorFile, lines };
}

/**
 * What changed since the participant's cursor. The cursor's `lines` (how many lines of the log it
 * has seen) places it exactly; a cursor with only `seen` takes the events after that time; no
 * cursor, every event. With `ack` the cursor moves to the end of the log. With `since` (a UTC
 * time) the check reads from that time instead of the cursor, the cards the participant opened
 * included, and leaves the cursor where it is (a person's own look; not with `ack`).
 *
 * A check first announces the cards changed without an event (`synthesizeEvents`), unless
 * `synthesize` is false: the page's process, which watches the folder, leaves that to its watcher,
 * which waits until the card files have been quiet, so that an agent writing a card and then its
 * event line is not announced as `unknown` in between.
 *
 * When nothing was written since the last full reading and the cursor stands at the log's end, the
 * check says so from the files' stamps alone (`quietCheck`): no card file and no line of the log is
 * read, and without `ack` nothing is written, not even the lock.
 */
export function checkBoard(ctx: BoardContext, input: { as: string; ack?: boolean; synthesize?: boolean; since?: string }): CheckResult {
  if (input.since !== undefined) {
    if (input.ack) throw new BoardRefusal("usage", "Refused: a check reads from a time (since) or moves the cursor to the end (ack), not both. Nothing was written.");
    if (!isIsoTime(input.since)) throw new BoardRefusal("usage", `Refused: "${input.since}" is not a UTC time like 2026-10-06T09:00:00Z. Nothing was written.`);
  }
  const nothingNew = (quiet: NonNullable<ReturnType<typeof quietCheck>>, acknowledged?: CheckResult["acknowledged"]): CheckResult => ({
    participant: input.as,
    cursor: quiet.cursorFile.cursor,
    notifications: [],
    addressed: [],
    decided: [],
    groups: [],
    synthesized: [],
    after: 0,
    ...(acknowledged ? { acknowledged } : {}),
    intervalMinutes: intervalMinutes(quiet.config)
  });
  if (!input.ack && input.since === undefined) {
    const quiet = quietCheck(ctx, input.as);
    if (quiet) return nothingNew(quiet);
  }
  return withBoardLock(ctx.dir, () => {
    if (input.ack) {
      const quiet = quietCheck(ctx, input.as);
      if (quiet) return nothingNew(quiet, acknowledge(ctx, input.as, quiet.cursorFile, quiet.lines));
    }
    const { config } = readBoardConfig(ctx.dir);
    requireParticipant(config, input.as);
    const cursorFile = readCursor(ctx.dir, input.as);
    const cursor = cursorFile.cursor;
    const read = input.synthesize === false ? undefined : readAndSynthesize(ctx);
    const synthesized = read?.synthesized ?? [];
    // The log as the reading above read it, when it appended nothing; read again otherwise.
    const { events, count } = read !== undefined && synthesized.length === 0 ? read.log : readEvents(ctx.dir);
    const from = input.since === undefined ? undefined : timeOf(input.since);
    const byLines = typeof cursor.lines === "number" && cursor.lines <= count;
    const seen = timeOf(cursor.seen);
    const after = events.filter(({ event, position }) => {
      if (from !== undefined) return (timeOf(event.at) ?? 0) > from;
      if (byLines) return position > cursor.lines!;
      if (seen !== undefined) return (timeOf(event.at) ?? 0) > seen;
      return true;
    });
    const opened = from !== undefined ? {} : (cursor.opened ?? {});
    const notifications = after.filter(({ event }) => event.by !== input.as && !openedSince(opened, event));
    // The titles of the cards named: from the reading above (a synthesis writes no card file), or read now, when there is any.
    const cards = new Map(notifications.length === 0 ? [] : (read?.items ?? readItems(ctx)).flatMap((item) => (item.card ? [[String(item.card.id), item.card] as const] : [])));
    const groups = new Map<string, { group: CheckGroup; last: number }>();
    for (const { event, position } of notifications) {
      const key = event.item === undefined ? "" : String(event.item);
      let entry = groups.get(key);
      if (!entry) {
        const card = cards.get(key);
        entry = {
          group: { ...(event.item !== undefined ? { item: event.item } : {}), ...(card ? { title: card.title, column: card.column, type: card.type } : {}), events: [] },
          last: position
        };
        groups.set(key, entry);
      }
      entry.group.events.push(event);
      entry.last = position;
    }
    // Per card, the last of its notifications that records or removes a decision: the decision as it now stands.
    const lastDecision = new Map<string, { event: BoardEvent; recorded: boolean }>();
    for (const { event } of notifications) {
      const decision = event.item === undefined ? undefined : decisionOf(event);
      if (decision !== undefined) lastDecision.set(String(event.item), { event, recorded: decision !== null });
    }
    const decided = notifications
      .map(({ event }) => event)
      .filter((event) => {
        const last = event.item === undefined ? undefined : lastDecision.get(String(event.item));
        return last !== undefined && last.event === event && last.recorded;
      });
    const acknowledged = input.ack ? acknowledge(ctx, input.as, cursorFile, count) : undefined;
    return {
      participant: input.as,
      cursor,
      ...(input.since !== undefined ? { since: input.since } : {}),
      notifications: notifications.map(({ event }) => event),
      addressed: notifications.filter(({ event }) => addressedTo(event).includes(input.as)).map(({ event }) => event),
      decided,
      groups: [...groups.values()].sort((left, right) => right.last - left.last).map((entry) => entry.group),
      synthesized,
      after: after.length,
      ...(acknowledged ? { acknowledged } : {}),
      intervalMinutes: intervalMinutes(config)
    };
  });
}

/** Records that the participant opened a card: its events up to now are seen (the capsule clears them). */
export function markOpened(ctx: BoardContext, as: string, id: CardId): void {
  withBoardLock(ctx.dir, () => {
    const { config } = readBoardConfig(ctx.dir);
    requireParticipant(config, as);
    const loaded = findLoaded(readItems(ctx), id);
    const cursorFile = readCursor(ctx.dir, as);
    const cursor = cursorFile.cursor;
    const next: Cursor = { ...cursor, opened: { ...(cursor.opened ?? {}), [String(loaded.card!.id)]: isoSeconds(ctx.now()) } };
    writeCursor(ctx.dir, as, cursorFile, next);
  });
}

// ---------------------------------------------------------------------------------------------
// A new board

export interface InitOptions {
  /** The board's name; `<repository folder>-workspace` when not given. */
  name?: string;
  /** The participants; the user of this machine as the person and Claude Code as the agent when not given. */
  participants?: Participant[];
}

/** The user of this machine as the board's person (`robin` → Robin), and Claude Code as its agent. */
export function defaultParticipants(userName?: string): Participant[] {
  let name = userName;
  if (name === undefined) {
    try {
      name = os.userInfo().username;
    } catch {
      name = undefined;
    }
  }
  const id = (name ?? "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "") || "me";
  return [
    { id, kind: "person", name: id.charAt(0).toUpperCase() + id.slice(1) },
    { id: "claude", kind: "agent", name: "Claude Code" }
  ];
}

const GITIGNORE = ["cursors/", LOCK_FILE, PRIVATE_NAMES_FILE, ".*.tmp", ""].join("\n");

/**
 * Creates the board folder: board.json, AGENTS.md, an empty events.jsonl, items/, cursors/ and a
 * .gitignore that keeps the cursors, the lock and the private names out of git. Refused when a
 * board.json is already there; a file already there is never overwritten. Returns the files it
 * wrote, relative to the board folder.
 */
export function initBoard(ctx: BoardContext, options: InitOptions = {}): string[] {
  if (fs.existsSync(boardConfigPath(ctx.dir))) {
    throw new BoardRefusal("board-exists", `A board is already at ${ctx.dir} (board.json is there); nothing was written.`);
  }
  const config = defaultBoardConfig({ name: options.name ?? `${path.basename(ctx.root)}-workspace`, participants: options.participants ?? defaultParticipants() });
  const problems = boardConfigProblems(config);
  if (problems.length > 0) throw new BoardRefusal("usage", `Refused: that board would not be valid: ${problems.join("; ")}. Nothing was written.`);
  const written: string[] = [];
  const create = (relative: string, text: string): void => {
    const file = path.join(ctx.dir, relative);
    if (fs.existsSync(file)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf8");
    written.push(relative);
  };
  fs.mkdirSync(ctx.dir, { recursive: true });
  create("board.json", boardConfigText(config));
  create("AGENTS.md", agentsGuide(config));
  create("events.jsonl", "");
  create(".gitignore", GITIGNORE);
  for (const folder of ["items", "cursors"]) {
    if (!fs.existsSync(path.join(ctx.dir, folder))) {
      fs.mkdirSync(path.join(ctx.dir, folder), { recursive: true });
      written.push(`${folder}/`);
    }
  }
  return written;
}

// ---------------------------------------------------------------------------------------------
// Validation: every file, every rule, every problem named

export interface Problem {
  file: string;
  message: string;
}

export interface ValidationResult {
  problems: Problem[];
  cards: number;
  events: number;
  cursors: number;
}

/**
 * What is wrong with a card on this board, beyond reading: a type, column or author the board
 * does not have, a comment by someone who is not a participant, a relation of no known kind or to
 * no card, a decision that is not `{ option, by, on }` with `by` a participant, a file name that
 * does not begin with the id. `ids` are the ids of the board's cards.
 * The page's process checks a card it is handed with this before it writes it.
 */
export function cardProblemsOnBoard(card: Card, config: BoardConfig, ids: Set<string>): string[] {
  const problems: string[] = [];
  const participants = config.participants.map((participant) => participant.id);
  if (card.type !== "" && !config.types.includes(card.type)) problems.push(`the type "${card.type}" is not a card type of the board (${config.types.join(", ")})`);
  if (card.column !== "" && !config.columns.some((column) => column.id === card.column)) {
    problems.push(`the column "${card.column}" is not a column of the board (${config.columns.map((column) => column.id).join(", ")})`);
  }
  if (card.author !== "" && !participants.includes(card.author)) problems.push(`the author "${card.author}" is not a participant of the board (${participants.join(", ")})`);
  card.thread.forEach((comment, index) => {
    if (!participants.includes(comment.author)) problems.push(`comment ${index + 1} is by "${comment.author}", who is not a participant of the board (${participants.join(", ")})`);
  });
  card.relations.forEach((relation, index) => {
    if (!(RELATION_KINDS as readonly string[]).includes(relation.kind)) problems.push(`relation ${index + 1}: "${relation.kind}" is not a kind of relation (${RELATION_KINDS.join(", ")})`);
    if (String(relation.to) === String(card.id)) problems.push(`relation ${index + 1} relates the card to itself`);
    else if (!ids.has(String(relation.to))) problems.push(`relation ${index + 1}: there is no card #${relation.to} on the board`);
  });
  // The person's answer to a decision: the option chosen, by a participant, on a day (null or none: not decided).
  const decided = card.fields[DECIDED_FIELD];
  if (decided !== undefined && decided !== null) for (const problem of decisionProblems(decided, participants)) problems.push(`"fields.decided" ${problem}`);
  if (card.id !== "" && !fileNameFitsId(path.posix.basename(card.file), card.id)) {
    problems.push(`the file's name does not begin with the card's id (${cardFileName(card.id, "…")})`);
  }
  return problems;
}

export function validateBoard(ctx: BoardContext): ValidationResult {
  const problems: Problem[] = [];
  const inspected = inspectBoardConfig(ctx.dir);
  if (!("config" in inspected)) {
    return { problems: inspected.problems.map((message) => ({ file: "board.json", message })), cards: 0, events: 0, cursors: 0 };
  }
  const { config } = inspected;
  if (!fs.existsSync(path.join(ctx.dir, "AGENTS.md"))) problems.push({ file: "AGENTS.md", message: "there is no AGENTS.md, so an agent has no conventions to read (`codelead board init` writes one)" });

  const items = readItems(ctx);
  const ids = new Set(items.flatMap((item) => (item.card ? [String(item.card.id)] : [])));
  const owners = new Map<string, string[]>();
  const names = readPrivateNames(ctx.dir);
  for (const item of items) {
    for (const message of item.problems) problems.push({ file: item.file, message });
    if (!item.card) continue;
    const key = String(item.card.id);
    owners.set(key, [...(owners.get(key) ?? []), item.file]);
    for (const message of cardProblemsOnBoard(item.card, config, ids)) problems.push({ file: item.file, message });
    for (const [what, text] of cardTexts(item.card)) {
      const found = findUnsafe(scopeOf(ctx, config), text, names);
      if (found === "secret") problems.push({ file: item.file, message: `${what} looks like it holds a secret` });
      if (found === "machine-path") problems.push({ file: item.file, message: `${what} holds a path of this machine` });
      if (found === "private-name") problems.push({ file: item.file, message: `${what} names someone the board keeps private` });
    }
  }
  for (const [id, files] of owners) {
    if (files.length > 1) for (const file of files) problems.push({ file, message: `the id ${id} is also the id of ${files.filter((other) => other !== file).join(", ")}` });
  }

  const { events, count, problems: eventProblems } = readEvents(ctx.dir);
  for (const message of eventProblems) problems.push({ file: "events.jsonl", message });
  const participants = new Set([...config.participants.map((participant) => participant.id), UNKNOWN_PARTICIPANT]);
  for (const { event, line } of events) {
    if (!(EVENT_KINDS as readonly string[]).includes(event.kind)) problems.push({ file: "events.jsonl", message: `line ${line}: "${event.kind}" is not an event kind (${EVENT_KINDS.join(", ")})` });
    if (!participants.has(event.by)) problems.push({ file: "events.jsonl", message: `line ${line}: "${event.by}" is not a participant of the board` });
    // Who an event is addressed to: a list of the board's participants, when it is there (an event written before mentions has none).
    const addressed = event.data?.addressed;
    if (addressed !== undefined) {
      if (!Array.isArray(addressed) || !addressed.every((id) => typeof id === "string")) {
        problems.push({ file: "events.jsonl", message: `line ${line}: "data.addressed" must list the ids of the participants the text addresses, and is ${JSON.stringify(addressed)}` });
      } else {
        for (const id of addressed as string[]) {
          if (!config.participants.some((participant) => participant.id === id)) problems.push({ file: "events.jsonl", message: `line ${line}: "data.addressed" names "${id}", who is not a participant of the board` });
        }
      }
    }
    // The decision an event records, when it is there: { option, by, on }, or null when the decision was removed.
    const decided = event.data?.decided;
    if (decided !== undefined && decided !== null) {
      for (const problem of decisionProblems(decided, config.participants.map((participant) => participant.id))) problems.push({ file: "events.jsonl", message: `line ${line}: "data.decided" ${problem}` });
    }
  }

  let cursors = 0;
  try {
    for (const entry of fs.readdirSync(path.join(ctx.dir, "cursors"), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.startsWith(".") || entry.name === STATE_FILE) continue;
      cursors += 1;
      const file = `cursors/${entry.name}`;
      const participant = entry.name.slice(0, -".json".length);
      if (!config.participants.some((candidate) => candidate.id === participant)) problems.push({ file, message: `"${participant}" is not a participant of the board` });
      let value: unknown;
      try {
        value = JSON.parse(fs.readFileSync(path.join(ctx.dir, "cursors", entry.name), "utf8").replace(/^﻿/, ""));
      } catch {
        problems.push({ file, message: "is not JSON" });
        continue;
      }
      for (const message of cursorProblems(value)) problems.push({ file, message });
    }
  } catch {
    // No cursors folder: nobody has checked yet on this machine.
  }
  return { problems, cards: items.length, events: count, cursors };
}
