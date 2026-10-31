import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  addComment,
  boardContext,
  boardLocation,
  checkBoard,
  colorName,
  columnOf,
  createBatch,
  createCards,
  decisionOf,
  defaultParticipants,
  describeDecision,
  describeEvent,
  eventLines,
  getCard,
  initBoard,
  isBoardRefusal,
  isIsoTime,
  isoSeconds,
  listCards,
  markOpened,
  moveCard,
  parseCardId,
  readBoard,
  readBoardConfig,
  relationsOf,
  TYPE_FIELDS,
  updateCard,
  validateBoard,
  type BoardConfig,
  type BoardContext,
  type BoardEvent,
  type Card,
  type CardChanges,
  type CardId,
  type CheckGroup,
  type Participant,
  type SanitizerFactory,
  type WriteResult,
  type YamlValue
} from "../core/index.js";
import { formatImportMapping, formatTidy, importDocuments, tidyImported } from "../import/index.js";
import { createBoardServer, ensurePageBuilt, pageLocation, personOf } from "../server/index.js";
import { consoleLog, type BoardLog } from "./log.js";

/**
 * `pinboard …` (or a host's `board …`, as `codelead board …`): Pinboard from a terminal, for a
 * person or an agent. Every command reads and writes the board's files through the core
 * (src/core), the same way the page does, and refuses what the board's rules refuse. It never calls
 * a model and never runs code.
 *
 * Exit 0 when done, 1 when a rule refused the write (or `validate` found problems), 2 when the
 * command cannot run (no board, no such card, a missing or wrong argument).
 */
export interface BoardCliDependencies {
  cwd?: () => string;
  /** Where the command's words go, line by line; the log's `say` when not given. */
  output?: (line: string) => void;
  now?: () => Date;
  /** The home folder the machine-path rule uses; the user's when not given. */
  home?: string;
  /** The host's log: `say` for the command's words; the console when not given. */
  log?: BoardLog;
  /** The host's sanitizer for the guard (secrets, machine paths); the board's own when not given. */
  sanitizer?: SanitizerFactory;
}

interface Common {
  board?: string;
  json?: boolean;
}

export interface BoardInitOptions extends Common {
  name?: string;
  person?: string[];
  agent?: string[];
}
export interface BoardCheckOptions extends Common {
  as?: string;
  ack?: boolean;
  /** Look from this time (a UTC time, or a day) instead of the cursor, which stays where it is. */
  since?: string;
}
export interface BoardListOptions extends Common {
  column?: string;
  tag?: string[];
  type?: string;
  repo?: string;
  archived?: boolean;
}
export interface BoardShowOptions extends Common {
  as?: string;
}
/**
 * `--rewrite-paths`: a path under the home folder, outside the workspace, is written as `<home>/…`
 * instead of refused. A path under the repository or the workspace needs no flag: every write cites
 * it as its path there, losing nothing.
 */
interface PathOptions {
  rewritePaths?: boolean;
}
export interface BoardNewOptions extends Common, PathOptions {
  as?: string;
  type?: string;
  title?: string;
  column?: string;
  tag?: string[];
  body?: string;
  bodyFile?: string;
  relate?: string[];
  session?: string;
  /** `name=value`: a field of the card's type (a decision's `ask="…"`). */
  field?: string[];
  /** A markdown file of several cards, each a heading `## <title>`, a YAML block and its description: all are created, or none. */
  batch?: string;
  /** Say what would be created, and write nothing. */
  dryRun?: boolean;
}
export interface BoardReplyOptions extends Common, PathOptions {
  as?: string;
  text?: string;
  file?: string;
  ifUpdated?: string;
}
export interface BoardMoveOptions extends Common, PathOptions {
  as?: string;
  to?: string;
  comment?: string;
  ifUpdated?: string;
}
export interface BoardSetOptions extends Common, PathOptions {
  as?: string;
  tag?: string[];
  untag?: string[];
  relate?: string[];
  unrelate?: string[];
  status?: string;
  /** One of the five colours (its hex, with or without "#", or its name), or "none". */
  color?: string;
  /** `name=value`: a field of the card's type (a decision's `ask="…"`). */
  field?: string[];
  /** A field to remove (one the card keeps from another type, too). */
  unsetField?: string[];
  ifUpdated?: string;
}
export interface BoardTidyOptions extends Common {
  imported?: boolean;
  as?: string;
  dryRun?: boolean;
}
export interface BoardImportOptions extends Common {
  from?: string;
  as?: string;
  plan?: string;
  section?: string;
  repo?: string;
  workspace?: string;
  dryRun?: boolean;
}
export interface BoardServeOptions extends Common {
  port?: string;
  open?: boolean;
}
export interface BoardServeDependencies extends BoardCliDependencies {
  /** The built page to serve; the package's page (dist/page), built when missing or stale, when not given. */
  pageDir?: string;
  /** Stops the board when aborted; Ctrl+C (or a stop signal) otherwise. */
  signal?: AbortSignal;
  /** Told the board's address once it is served. */
  started?: (url: string) => void;
  /** Opens an address in the browser (`--open`); the system's opener when not given. */
  openUrl?: (url: string) => void;
  /** How long a card file must be quiet before a change without an event is announced (the process's default when not given). */
  settleMs?: number;
}

/** The port `serve` tries first, so that a bookmarked filter keeps working; a free one when it is taken. */
export const DEFAULT_BOARD_PORT = 7414;

class UsageError extends Error {}

function contextFor(options: Common, dependencies: BoardCliDependencies): BoardContext {
  const cwd = dependencies.cwd?.() ?? process.cwd();
  const location = options.board ? { dir: path.resolve(cwd, options.board) } : boardLocation(cwd);
  return boardContext({
    dir: location.dir,
    ...("root" in location ? { root: location.root } : {}),
    ...(dependencies.home ? { home: dependencies.home } : {}),
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.sanitizer ? { sanitizer: dependencies.sanitizer } : {})
  });
}

/** Where a command's words go: the dependencies' output, else the log's `say`. */
function outputOf(dependencies: BoardCliDependencies): (line: string) => void {
  if (dependencies.output) return dependencies.output;
  const log = dependencies.log ?? consoleLog;
  return (line) => log.say(line);
}

/** Runs a command: a refusal is printed in its own words (JSON with --json) and becomes the exit code. */
async function run(options: Common, dependencies: BoardCliDependencies, work: (ctx: BoardContext, output: (line: string) => void) => number): Promise<number> {
  const output = outputOf(dependencies);
  try {
    return work(contextFor(options, dependencies), output);
  } catch (error) {
    if (error instanceof UsageError) {
      output(options.json ? JSON.stringify({ refused: "usage", message: error.message }) : error.message);
      return 2;
    }
    if (isBoardRefusal(error)) {
      output(options.json ? JSON.stringify({ refused: error.code, message: error.message }) : error.message);
      return ["no-board", "not-found", "usage"].includes(error.code) ? 2 : 1;
    }
    throw error;
  }
}

function need<T>(value: T | undefined, words: string): T {
  if (value === undefined || value === "") throw new UsageError(words);
  return value;
}

function cardIdOf(text: string): CardId {
  const id = parseCardId(text);
  if (id === undefined) throw new UsageError(`"${text}" is not a card id (42 or #42).`);
  return id;
}

/** `<kind>:<id>`, as `--relate child-of:7` writes it. */
function relationOf(text: string): { kind: string; to: CardId } {
  const at = text.lastIndexOf(":");
  if (at <= 0) throw new UsageError(`"${text}" is not a relation; write <kind>:<card id>, for example child-of:7.`);
  return { kind: text.slice(0, at).trim(), to: cardIdOf(text.slice(at + 1)) };
}

function readText(file: string, dependencies: BoardCliDependencies): string {
  const full = path.resolve(dependencies.cwd?.() ?? process.cwd(), file);
  try {
    return fs.readFileSync(full, "utf8");
  } catch {
    throw new UsageError(`Cannot read ${file}.`);
  }
}

/** `id` or `id:Display name`, as `--person robin:Robin` writes a participant. */
function participantOf(text: string, kind: Participant["kind"]): Participant {
  const at = text.indexOf(":");
  const id = (at === -1 ? text : text.slice(0, at)).trim();
  const name = at === -1 ? id.charAt(0).toUpperCase() + id.slice(1) : text.slice(at + 1).trim();
  return { id, kind, name };
}

function columnName(config: BoardConfig, id: string): string {
  return columnOf(config, id)?.name ?? id;
}

function cardLine(card: Card): string {
  return `#${String(card.id).padEnd(4)} ${card.type.padEnd(8)} ${card.title}${card.tags.length > 0 ? `  [${card.tags.join(", ")}]` : ""}`;
}

function isYamlValue(value: unknown): value is YamlValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isYamlValue);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).every(isYamlValue);
  return false;
}

/**
 * `name=value`, as `--field ask="…"` writes a field. A value that reads as a JSON list or mapping
 * is one (`--field options='["a TTL", "a version key"]'`); any other value is the text as given.
 */
function fieldOf(text: string): [string, YamlValue] {
  const at = text.indexOf("=");
  if (at <= 0) throw new UsageError(`"${text}" is not a field; write <name>=<value>, for example ask="Pick the cache: a TTL or a version key; I recommend the TTL."`);
  const name = text.slice(0, at).trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) throw new UsageError(`"${name}" is not a field name (a word of letters, digits, "_" and "-").`);
  const raw = text.slice(at + 1);
  if (/^\s*[[{]/.test(raw)) {
    try {
      const value: unknown = JSON.parse(raw);
      if (isYamlValue(value)) return [name, value];
    } catch {
      // Not JSON: the text as it was given.
    }
  }
  return [name, raw];
}

/** The fields to set, each one of the type's own (a typo is refused, not written as a new field). */
function typedFields(texts: string[], type: string): Record<string, YamlValue> {
  const known = TYPE_FIELDS[type];
  const fields: Record<string, YamlValue> = {};
  for (const text of texts) {
    const [name, value] = fieldOf(text);
    if (known && !known.includes(name)) {
      throw new UsageError(
        known.length === 0 ? `A ${type} has no fields; "${name}" is not one.` : `"${name}" is not a field of a ${type} (${known.join(", ")}); change the card's type first if it should have it.`
      );
    }
    fields[name] = value;
  }
  return fields;
}

/**
 * A check's events as lines: a comment and a move written in one step are one line. The lines of
 * the events addressed to the participant come first, each part in its order.
 */
function eventLinesOf(events: BoardEvent[], config: BoardConfig, addressed: BoardEvent[] = []): string[] {
  const lines = eventLines(events, config);
  const toYou = (line: (typeof lines)[number]): boolean => line.events.some((event) => addressed.includes(event));
  return [...lines.filter(toYou), ...lines.filter((line) => !toYou(line))].map((line) => `${line.events[0]!.by} · ${line.events[0]!.at}  ${line.text}`);
}

/** The paths of this machine a write rewrote, as its events list them (`data.rewritten`), each once. */
function rewrittenBy(events: BoardEvent[]): string[] {
  const out: string[] = [];
  for (const event of events) {
    const listed = event.data?.rewritten;
    if (!Array.isArray(listed)) continue;
    for (const entry of listed) if (typeof entry === "string" && !out.includes(entry)) out.push(entry);
  }
  return out;
}

/** What a write says of each path it rewrote, a line each, as the import says it. */
function rewriteLines(events: BoardEvent[]): string[] {
  return rewrittenBy(events).map((entry) => `a path of this machine is written as ${entry}`);
}

/** A write's answer: its words and a line for each path it rewrote; with --json, the card, the events and the rewrites. */
function writeSummary(result: WriteResult, json: boolean | undefined, words: string): string {
  const rewritten = rewrittenBy(result.events);
  if (json) return JSON.stringify({ card: result.card, events: result.events, ...(rewritten.length > 0 ? { rewritten } : {}) }, null, 2);
  return [words, ...rewriteLines(result.events)].join("\n");
}

/** The core's option for --rewrite-paths: nothing to add when it was not given. */
function homePaths(options: PathOptions): { rewriteHomePaths?: true } {
  return options.rewritePaths ? { rewriteHomePaths: true } : {};
}

// ---------------------------------------------------------------------------------------------

export async function runBoardInit(options: BoardInitOptions, dependencies: BoardCliDependencies = {}): Promise<number> {
  return run(options, dependencies, (ctx, output) => {
    const persons = (options.person ?? []).map((text) => participantOf(text, "person"));
    const agents = (options.agent ?? []).map((text) => participantOf(text, "agent"));
    const defaults = defaultParticipants();
    const participants = [...(persons.length > 0 ? persons : defaults.filter((entry) => entry.kind === "person")), ...(agents.length > 0 ? agents : defaults.filter((entry) => entry.kind === "agent"))];
    const written = initBoard(ctx, { ...(options.name ? { name: options.name } : {}), participants });
    const where = path.relative(dependencies.cwd?.() ?? process.cwd(), ctx.dir) || ".";
    output(options.json ? JSON.stringify({ dir: ctx.dir, written }, null, 2) : `Board created in ${where}: ${written.join(", ")}.\nParticipants: ${participants.map((entry) => `${entry.id} (${entry.kind})`).join(", ")}. Agents read ${path.join(where, "AGENTS.md")}.`);
    return 0;
  });
}

/** `--since`: a UTC time (2026-10-06T09:00:00Z), or a day (2026-10-06: from its first second, UTC). */
function sinceOf(text: string): string {
  const trimmed = text.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed) && isIsoTime(`${trimmed}T00:00:00Z`)) return `${trimmed}T00:00:00Z`;
  if (isIsoTime(trimmed)) return isoSeconds(new Date(Date.parse(trimmed)));
  throw new UsageError(`"${text}" is not a time: give a UTC time like 2026-10-06T09:00:00Z, or a day like 2026-10-06.`);
}

export async function runBoardCheck(options: BoardCheckOptions, dependencies: BoardCliDependencies = {}): Promise<number> {
  return run(options, dependencies, (ctx, output) => {
    const { config } = readBoardConfig(ctx.dir);
    const as = options.as ?? config.participants.find((entry) => entry.kind === "person")?.id ?? config.participants[0]!.id;
    if (options.since !== undefined && options.ack) throw new UsageError("check takes --since or --ack, not both: --since looks from a time and leaves the cursor where it is.");
    const from = options.since === undefined ? undefined : sinceOf(options.since);
    const result = checkBoard(ctx, { as, ...(options.ack ? { ack: true } : {}), ...(from !== undefined ? { since: from } : {}) });
    if (options.json) {
      output(JSON.stringify(result, null, 2));
      return 0;
    }
    const since = result.since !== undefined ? `since ${result.since}` : result.cursor.seen ? `since ${result.cursor.seen}` : "since the board began (no cursor yet)";
    const next = `Next check in ${result.intervalMinutes} minutes.`;
    const moved = result.acknowledged ? `Cursor moved to the end of the log (${result.acknowledged.lines} line${result.acknowledged.lines === 1 ? "" : "s"}).` : "";
    if (result.notifications.length === 0) {
      output(`${as}: nothing new ${since}.${moved ? ` ${moved}` : ""} ${next}`);
      return 0;
    }
    const cards = new Set(result.groups.map((group) => String(group.item ?? "")));
    const toYou = result.addressed.length;
    const decided = result.decided.length;
    const lines = [`${as}: ${result.notifications.length} new on ${cards.size} card${cards.size === 1 ? "" : "s"} ${since}${toYou > 0 ? `, ${toYou} addressed to you` : ""}${decided > 0 ? `, ${decided} decided` : ""}.`];
    // What is addressed to the participant comes first: those cards, each with its mentions first.
    // Then the decisions the person recorded in a card's fields, a line a card. An event that changed
    // nothing but the decision is said there, not again among the card's events; one that changed
    // more (or addresses the participant) keeps its line there too, so that nothing goes unsaid.
    const decidedCards = new Set(result.decided.map((event) => String(event.item)));
    const onlyTheFields = (event: BoardEvent): boolean => {
      const fields = event.data?.fields;
      return Array.isArray(fields) && fields.every((name) => name === "fields");
    };
    const saidAsDecided = (event: BoardEvent): boolean =>
      event.item !== undefined && decidedCards.has(String(event.item)) && decisionOf(event) !== undefined && onlyTheFields(event) && !result.addressed.includes(event);
    const eventsOf = (group: CheckGroup): BoardEvent[] => group.events.filter((event) => !saidAsDecided(event));
    const addressedHere = (group: CheckGroup): boolean => group.events.some((event) => result.addressed.includes(event));
    const printGroup = (group: CheckGroup): void => {
      lines.push("");
      lines.push(group.item === undefined ? "The board" : `#${String(group.item)} ${group.title ?? "(no such card now)"}${group.type ? `  (${group.type} · ${columnName(config, group.column ?? "")})` : ""}`);
      for (const line of eventLinesOf(eventsOf(group), config, result.addressed)) lines.push(`  ${line}`);
    };
    const first = result.groups.filter(addressedHere);
    const rest = result.groups.filter((group) => !addressedHere(group) && eventsOf(group).length > 0);
    if (first.length > 0) {
      lines.push("", `Addressed to you (${toYou})`);
      for (const group of first) printGroup(group);
    }
    if (decided > 0) {
      lines.push("", `Decided (${decided})`, "");
      for (const group of result.groups) {
        const event = result.decided.find((entry) => String(entry.item) === String(group.item));
        const decision = event ? decisionOf(event) : undefined;
        if (decision) lines.push(`#${String(group.item)} ${group.title ?? "(no such card now)"}: ${describeDecision(decision)}`);
      }
    }
    if ((first.length > 0 || decided > 0) && rest.length > 0) lines.push("", "Also new");
    for (const group of rest) printGroup(group);
    lines.push("");
    lines.push(moved ? `${moved} ${next}` : `Run again with --ack once these are dealt with. ${next}`);
    output(lines.join("\n"));
    return 0;
  });
}

export async function runBoardList(options: BoardListOptions, dependencies: BoardCliDependencies = {}): Promise<number> {
  return run(options, dependencies, (ctx, output) => {
    const filter = {
      ...(options.column ? { column: options.column } : {}),
      ...(options.tag && options.tag.length > 0 ? { tags: options.tag } : {}),
      ...(options.type ? { type: options.type } : {}),
      ...(options.repo ? { repo: options.repo } : {}),
      ...(options.archived ? { archived: true } : {})
    };
    const { view, cards } = listCards(ctx, filter);
    const filtered = Object.keys(filter).some((key) => key !== "archived");
    const columns = view.config.columns.map((column) => {
      const all = view.cards.filter((card) => card.column === column.id && (options.archived || card.archived === undefined));
      return { id: column.id, name: column.name, total: all.length, cards: cards.filter((card) => card.column === column.id) };
    });
    if (options.json) {
      output(
        JSON.stringify(
          {
            columns: columns.map((column) => ({
              ...column,
              cards: column.cards.map(({ id, type, title, column: where, tags, updated, status, color, file }) => ({ id, type, title, column: where, tags, updated, ...(status ? { status } : {}), ...(color ? { color } : {}), file }))
            })),
            unreadable: view.unreadable
          },
          null,
          2
        )
      );
      return 0;
    }
    const lines: string[] = [];
    for (const column of columns) {
      if (options.column && column.cards.length === 0 && columnOf(view.config, options.column)?.id !== column.id) continue;
      lines.push(`${column.name} (${filtered ? `${column.cards.length} of ${column.total}` : column.total})`);
      for (const card of column.cards) lines.push(`  ${cardLine(card)}`);
    }
    for (const entry of view.unreadable) lines.push(`Not a card the board can read: ${entry.file} (${entry.problems.join("; ")})`);
    output(lines.join("\n"));
    return 0;
  });
}

export async function runBoardShow(id: string, options: BoardShowOptions, dependencies: BoardCliDependencies = {}): Promise<number> {
  return run(options, dependencies, (ctx, output) => {
    const cardId = cardIdOf(id);
    const { card, problems } = getCard(ctx, cardId);
    const view = readBoard(ctx);
    const relations = relationsOf(view.cards, card.id);
    if (options.as) markOpened(ctx, options.as, card.id);
    if (options.json) {
      output(JSON.stringify({ card, relations, problems }, null, 2));
      return 0;
    }
    const titleOf = (target: CardId): string => {
      const other = view.cards.find((entry) => String(entry.id) === String(target));
      return other ? `(${columnName(view.config, other.column)}) ${other.title}` : "(not on the board)";
    };
    const lines = [`#${String(card.id)} · ${card.type} · ${columnName(view.config, card.column)}${card.archived ? ` · archived ${card.archived}` : ""}`, card.title];
    if (problems.length > 0) lines.push(`Problems: ${problems.join("; ")}`);
    if (card.tags.length > 0) lines.push(`tags: ${card.tags.join(", ")}`);
    lines.push(`by ${card.author} · created ${card.created} · updated ${card.updated}`);
    lines.push(`file: ${card.file}`);
    if (card.status) lines.push(`status: ${card.status}`);
    if (card.color) lines.push(`color: ${card.color} (${colorName(card.color)})`);
    if (card.session) lines.push(`session: ${card.session}`);
    if (relations.length > 0) {
      lines.push("relations:");
      for (const relation of relations) lines.push(`  ${relation.kind} #${String(relation.to)} ${titleOf(relation.to)}${String(relation.statedBy) !== String(card.id) ? `  (stated by #${String(relation.statedBy)})` : ""}`);
    }
    if (card.attachments.length > 0) {
      lines.push("attachments:");
      for (const attachment of card.attachments) lines.push(`  ${attachment.path}${attachment.lines ? `:${attachment.lines}` : ""}`);
    }
    const fieldNames = Object.keys(card.fields);
    if (fieldNames.length > 0) {
      lines.push("fields:");
      for (const name of fieldNames) lines.push(`  ${name}: ${typeof card.fields[name] === "string" ? String(card.fields[name]) : JSON.stringify(card.fields[name])}`);
    }
    if (card.description) lines.push("", card.description);
    lines.push("", `Thread (${card.thread.length})`);
    for (const comment of card.thread) lines.push("", `### ${comment.author} · ${comment.at}`, comment.body);
    output(lines.join("\n"));
    return 0;
  });
}

/** The options of `new` that make one card; a batch takes them from its file. */
const ONE_CARD_OPTIONS: Array<[keyof BoardNewOptions, string]> = [
  ["type", "--type"],
  ["title", "--title"],
  ["body", "--body"],
  ["bodyFile", "--body-file"],
  ["relate", "--relate"],
  ["field", "--field"]
];

/** A card as a batch lists it: its id, type, column, title and tags, and its relations on a line of their own. */
function batchLines(card: Card, config: BoardConfig): string[] {
  const lines = [`  #${String(card.id)} (${card.type}) in ${columnName(config, card.column)}: ${card.title}${card.tags.length > 0 ? `  [${card.tags.join(", ")}]` : ""}`];
  if (card.relations.length > 0) lines.push(`      ${card.relations.map((relation) => `${relation.kind} #${String(relation.to)}`).join(", ")}`);
  return lines;
}

/**
 * `new --batch <file>`: every card of a markdown file, or none (the core's `createBatch`). The
 * command's --column, --tag and --session apply to every card that does not give its own; the
 * options of one card (--type, --title, …) are refused, since each card gives them in the file.
 */
function newBatch(ctx: BoardContext, as: string, file: string, options: BoardNewOptions, dependencies: BoardCliDependencies, output: (line: string) => void): number {
  const oneCard = ONE_CARD_OPTIONS.find(([name]) => options[name] !== undefined);
  if (oneCard) {
    throw new UsageError(`new --batch takes each card's type, title, description, relations and fields from the file, so ${oneCard[1]} goes with a card made alone; --column, --tag and --session apply to every card of the batch.`);
  }
  const result = createBatch(ctx, as, readText(file, dependencies), {
    source: file,
    defaults: { ...(options.column ? { column: options.column } : {}), ...(options.tag ? { tags: options.tag } : {}), ...(options.session ? { session: options.session } : {}) },
    ...(options.dryRun ? { dryRun: true } : {}),
    ...homePaths(options)
  });
  if (options.json) {
    output(JSON.stringify(result, null, 2));
    return 0;
  }
  const { config } = readBoardConfig(ctx.dir);
  const count = `${result.cards.length} card${result.cards.length === 1 ? "" : "s"}`;
  const lines = [result.dryRun ? `Would create ${count} from ${file}; nothing was written:` : `Created ${count} from ${file}:`];
  for (const card of result.cards) lines.push(...batchLines(card, config));
  lines.push(...rewriteLines(result.events));
  if (result.dryRun) lines.push("Run it again without --dry-run to create them.");
  output(lines.join("\n"));
  return 0;
}

export async function runBoardNew(options: BoardNewOptions, dependencies: BoardCliDependencies = {}): Promise<number> {
  return run(options, dependencies, (ctx, output) => {
    const as = need(options.as, "new needs --as <participant>: who creates the card.");
    if (options.batch !== undefined) return newBatch(ctx, as, need(options.batch, "new --batch needs the file of the cards."), options, dependencies, output);
    const type = need(options.type, "new needs --type <type>: question, decision, task, idea, review or note.");
    const title = need(options.title, "new needs --title <text>.");
    if (options.body !== undefined && options.bodyFile !== undefined) throw new UsageError("new takes --body or --body-file, not both.");
    const description = options.bodyFile !== undefined ? readText(options.bodyFile, dependencies) : options.body;
    const fields = options.field && options.field.length > 0 ? typedFields(options.field, type) : undefined;
    const input = {
      type,
      title,
      ...(options.column ? { column: options.column } : {}),
      ...(options.tag ? { tags: options.tag } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(options.relate ? { relations: options.relate.map(relationOf) } : {}),
      ...(options.session ? { session: options.session } : {}),
      ...(fields ? { fields } : {})
    };
    const result = createCards(ctx, as, [input], { ...(options.dryRun ? { dryRun: true } : {}), ...homePaths(options) })[0]!;
    const { config } = readBoardConfig(ctx.dir);
    const made = `#${String(result.card.id)} (${result.card.type}) in ${columnName(config, result.card.column)}: ${result.card.title}`;
    if (options.dryRun) {
      const rewritten = rewrittenBy(result.events);
      output(
        options.json
          ? JSON.stringify({ dryRun: true, card: result.card, events: result.events, ...(rewritten.length > 0 ? { rewritten } : {}) }, null, 2)
          : [`Would create ${made}; nothing was written.`, ...rewriteLines(result.events)].join("\n")
      );
      return 0;
    }
    output(writeSummary(result, options.json, `Created ${made}\n${path.relative(dependencies.cwd?.() ?? process.cwd(), path.join(ctx.dir, result.card.file))}`));
    return 0;
  });
}

export async function runBoardReply(id: string, options: BoardReplyOptions, dependencies: BoardCliDependencies = {}): Promise<number> {
  return run(options, dependencies, (ctx, output) => {
    const cardId = cardIdOf(id);
    const as = need(options.as, "reply needs --as <participant>: who writes the comment.");
    if ((options.text === undefined) === (options.file === undefined)) throw new UsageError("reply needs the comment: --text <markdown> or --file <path> (one of them).");
    const body = options.file !== undefined ? readText(options.file, dependencies) : options.text!;
    const result = addComment(ctx, cardId, { as, body, ...(options.ifUpdated ? { expectUpdated: options.ifUpdated } : {}), ...homePaths(options) });
    output(writeSummary(result, options.json, `Commented on #${String(result.card.id)} as ${as} (${result.events[0]?.at ?? ""}).`));
    return 0;
  });
}

export async function runBoardMove(id: string, options: BoardMoveOptions, dependencies: BoardCliDependencies = {}): Promise<number> {
  return run(options, dependencies, (ctx, output) => {
    const cardId = cardIdOf(id);
    const to = need(options.to, "move needs --to <column>.");
    const as = need(options.as, "move needs --as <participant>: who moves the card.");
    const before = getCard(ctx, cardId).card.column;
    const result = moveCard(ctx, cardId, {
      as,
      to,
      ...(options.comment !== undefined ? { comment: options.comment } : {}),
      ...(options.ifUpdated ? { expectUpdated: options.ifUpdated } : {}),
      ...homePaths(options)
    });
    const { config } = readBoardConfig(ctx.dir);
    const moved = result.events.some((event) => event.kind === "item.moved");
    const commented = result.events.some((event) => event.kind === "comment.added");
    const words = moved
      ? `Moved #${String(result.card.id)} from ${columnName(config, before)} to ${columnName(config, result.card.column)}${commented ? ", with the comment" : ""}.`
      : `#${String(result.card.id)} is already in ${columnName(config, result.card.column)}${commented ? "; the comment was added" : "; nothing was written"}.`;
    output(writeSummary(result, options.json, words));
    return 0;
  });
}

export async function runBoardSet(id: string, options: BoardSetOptions, dependencies: BoardCliDependencies = {}): Promise<number> {
  return run(options, dependencies, (ctx, output) => {
    const cardId = cardIdOf(id);
    const as = need(options.as, "set needs --as <participant>: who changes the card.");
    const fields: Record<string, YamlValue | null> = {};
    if (options.field && options.field.length > 0) Object.assign(fields, typedFields(options.field, getCard(ctx, cardId).card.type));
    for (const name of options.unsetField ?? []) {
      if (Object.prototype.hasOwnProperty.call(fields, name)) throw new UsageError(`set cannot both set and remove the field ${name}.`);
      fields[name] = null;
    }
    const changes: CardChanges = {
      ...(options.tag ? { addTags: options.tag } : {}),
      ...(options.untag ? { removeTags: options.untag } : {}),
      ...(options.relate ? { addRelations: options.relate.map(relationOf) } : {}),
      ...(options.unrelate ? { removeRelations: options.unrelate.map(relationOf) } : {}),
      ...(options.status !== undefined ? { status: options.status } : {}),
      ...(options.color !== undefined ? { color: options.color } : {}),
      ...(Object.keys(fields).length > 0 ? { fields } : {})
    };
    if (Object.keys(changes).length === 0) throw new UsageError("set needs something to change: --tag, --untag, --relate, --unrelate, --status, --color, --field or --unset-field.");
    const result = updateCard(ctx, cardId, { as, changes, ...(options.ifUpdated ? { expectUpdated: options.ifUpdated } : {}), ...homePaths(options) });
    const said = result.events.map((event) => describeEvent(event));
    output(writeSummary(result, options.json, said.length > 0 ? `#${String(result.card.id)}: ${said.join("; ")}.` : `Nothing to change on #${String(result.card.id)}; nothing was written.`));
    return 0;
  });
}

export async function runBoardValidate(options: Common, dependencies: BoardCliDependencies = {}): Promise<number> {
  return run(options, dependencies, (ctx, output) => {
    if (!fs.existsSync(path.join(ctx.dir, "board.json"))) readBoardConfig(ctx.dir);
    const result = validateBoard(ctx);
    if (options.json) {
      output(JSON.stringify(result, null, 2));
      return result.problems.length > 0 ? 1 : 0;
    }
    const counts = `${result.cards} card${result.cards === 1 ? "" : "s"}, ${result.events} event${result.events === 1 ? "" : "s"}, ${result.cursors} cursor${result.cursors === 1 ? "" : "s"}`;
    if (result.problems.length === 0) {
      output(`The board is valid: ${counts}.`);
      return 0;
    }
    output([`The board has ${result.problems.length} problem${result.problems.length === 1 ? "" : "s"} (${counts}):`, ...result.problems.map((problem) => `  ${problem.file}: ${problem.message}`)].join("\n"));
    return 1;
  });
}

export async function runBoardImport(options: BoardImportOptions, dependencies: BoardCliDependencies = {}): Promise<number> {
  return run(options, dependencies, (ctx, output) => {
    const cwd = dependencies.cwd?.() ?? process.cwd();
    const from = path.resolve(cwd, need(options.from, "import needs --from <folder>: the folder of PINNED.md, DECISIONS-PENDING.md and the plan (docs)."));
    if (!fs.existsSync(from)) throw new UsageError(`No folder ${options.from}.`);
    const result = importDocuments(ctx, {
      from,
      ...(options.as ? { as: options.as } : {}),
      ...(options.plan ? { plan: path.resolve(cwd, options.plan) } : {}),
      ...(options.section ? { section: options.section } : {}),
      ...(options.repo ? { repo: options.repo } : {}),
      ...(options.workspace ? { workspace: path.resolve(cwd, options.workspace) } : {}),
      ...(options.dryRun ? { dryRun: true } : {})
    });
    const { config } = readBoardConfig(ctx.dir);
    output(options.json ? JSON.stringify(result, null, 2) : formatImportMapping(result, config).join("\n"));
    return 0;
  });
}

/**
 * `board tidy --imported`: once the import is done, strips from each imported card's
 * description the opening repetition of its title in bold (the import copied the item's bold lead
 * into both). Only the cards board.json's `imports` lists; `--dry-run` shows every change first.
 */
export async function runBoardTidy(options: BoardTidyOptions, dependencies: BoardCliDependencies = {}): Promise<number> {
  return run(options, dependencies, (ctx, output) => {
    if (!options.imported) {
      throw new UsageError("tidy needs --imported: it strips from each imported card's description the opening repetition of its title in bold (run it with --dry-run first to see every change).");
    }
    const result = tidyImported(ctx, { ...(options.as ? { as: options.as } : {}), ...(options.dryRun ? { dryRun: true } : {}) });
    output(options.json ? JSON.stringify(result, null, 2) : formatTidy(result).join("\n"));
    return 0;
  });
}

/** Opens an address with the system's opener; says the address when that cannot be done. */
function openInBrowser(url: string, output: (line: string) => void): void {
  const [command, args]: [string, string[]] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => output(`Open ${url} in your browser.`));
    child.unref();
  } catch {
    output(`Open ${url} in your browser.`);
  }
}

/**
 * `board serve`: the board's page and its API on 127.0.0.1 until Ctrl+C. The page is built first
 * when its build is missing or older than its sources. Every write the page asks for goes through
 * the core as the board's person; the process never calls a model and never runs code.
 */
export async function runBoardServe(options: BoardServeOptions, dependencies: BoardServeDependencies = {}): Promise<number> {
  const output = outputOf(dependencies);
  const cwd = dependencies.cwd?.() ?? process.cwd();
  const say = (refused: string, message: string, code: number): number => {
    output(options.json ? JSON.stringify({ refused, message }) : message);
    return code;
  };
  let wanted: number | undefined;
  if (options.port !== undefined) {
    if (!/^\d+$/.test(options.port.trim()) || Number(options.port) > 65535) {
      return say("usage", `"${options.port}" is not a port: give a whole number from 1 to 65535, or 0 for a free one the system picks.`, 2);
    }
    wanted = Number(options.port);
  }

  let ctx: BoardContext;
  let server: ReturnType<typeof createBoardServer>;
  try {
    ctx = contextFor(options, dependencies);
    readBoardConfig(ctx.dir);
    let pageDir = dependencies.pageDir;
    if (pageDir === undefined) {
      const location = pageLocation();
      await ensurePageBuilt(location, options.json ? () => undefined : output);
      pageDir = location.dist;
    }
    server = createBoardServer({
      dir: ctx.dir,
      root: ctx.root,
      home: ctx.home,
      now: ctx.now,
      ...(ctx.sanitizer ? { sanitizer: ctx.sanitizer } : {}),
      pageDir,
      ...(dependencies.settleMs !== undefined ? { settleMs: dependencies.settleMs } : {}),
      log: (line) => output(line)
    });
  } catch (error) {
    if (isBoardRefusal(error)) return say(error.code, error.message, ["no-board", "not-found", "usage"].includes(error.code) ? 2 : 1);
    throw error;
  }

  let address: { url: string; port: number };
  try {
    address = await server.listen(wanted ?? DEFAULT_BOARD_PORT);
  } catch (error) {
    if (wanted === undefined && (error as NodeJS.ErrnoException).code === "EADDRINUSE") address = await server.listen(0);
    else {
      await server.close();
      return say("usage", `Cannot serve the board on port ${wanted ?? DEFAULT_BOARD_PORT}: ${error instanceof Error ? error.message : String(error)}.`, 2);
    }
  }

  const person = personOf(readBoardConfig(ctx.dir).config);
  const where = path.relative(cwd, ctx.dir) || ".";
  output(
    options.json
      ? JSON.stringify({ url: address.url, port: address.port, board: ctx.dir, person: person.id })
      : `Pinboard: ${address.url}\nThe board in ${where}, as ${person.name}. The page writes the board's files through the same rules as these commands; Ctrl+C stops it.`
  );
  dependencies.started?.(address.url);
  if (options.open) (dependencies.openUrl ?? ((url: string) => openInBrowser(url, output)))(address.url);

  await new Promise<void>((resolve) => {
    const signal = dependencies.signal;
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      signal?.removeEventListener("abort", stop);
      resolve();
    };
    if (signal) {
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
      return;
    }
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await server.close();
  if (!options.json) output("Pinboard stopped.");
  return 0;
}

// ---------------------------------------------------------------------------------------------

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

function common(command: Command): Command {
  return command.option("--board <dir>", "the board folder (default: docs/codelead/board of the repository you are in)").option("--json", "print JSON");
}

/** `--rewrite-paths`, on every command that writes a card's text. */
function rewritable(command: Command): Command {
  return command.option(
    "--rewrite-paths",
    "write a path under your home folder, outside the workspace, as <home>/… instead of refusing it (a path under the repository or the workspace is always written as its path there, or as <repository>:<path>)"
  );
}

/**
 * What a host gives the command tree: its name (`board` under a host's program, as `codelead
 * board`; `pinboard` as the package's own bin), its log, and its sanitizer for the guard. Each is
 * the package's own when not given.
 */
export interface BoardHost {
  /** The command's name: "board" when not given. */
  name?: string;
  /** Where the commands' words go (`say`) and what goes wrong outside them (`warn`); the console when not given. */
  log?: BoardLog;
  /** Makes the sanitizer the guard finds secrets and machine paths with; the board's own (core/sanitize.ts) when not given. */
  sanitizer?: SanitizerFactory;
}

/** The dependencies every command of a host's tree runs with. */
function hostDependencies(host: BoardHost): BoardCliDependencies {
  return { ...(host.log ? { log: host.log } : {}), ...(host.sanitizer ? { sanitizer: host.sanitizer } : {}) };
}

/** The command tree (`board`, or the host's name): one command per action; each hands its options to its `runBoard…` function. */
export function createBoardCommand(host: BoardHost = {}): Command {
  const board = new Command(host.name ?? "board").description("Pinboard: the board between you and your coding agents, kept as files in docs/codelead/board (cards with threads, an event log, cursors)");
  const deps = hostDependencies(host);
  const exit = (code: number): void => {
    process.exitCode = code;
  };

  board.addCommand(
    common(new Command("init"))
      .description("Create the board folder in this repository: board.json, AGENTS.md, items/, events.jsonl, cursors/")
      .option("--name <name>", "the board's name (default: <repository>-workspace)")
      .option("--person <id[:Name]>", "a person of the board (repeatable; default: this machine's user)", collect)
      .option("--agent <id[:Name]>", "an agent of the board (repeatable; default: claude:Claude Code)", collect)
      .action(async (options: BoardInitOptions) => exit(await runBoardInit(options, deps)))
  );
  board.addCommand(
    common(new Command("check"))
      .description("What changed since your cursor: the events by others, grouped by card, what is addressed to you (an @mention of you) first, then the decisions recorded in a card's fields; --ack moves the cursor to the end")
      .option("--as <participant>", "whose cursor (default: the board's first person)")
      .option("--ack", "move the cursor to the end of the log once read")
      .option("--since <time>", "look from a UTC time (2026-10-06T09:00:00Z) or a day (2026-10-06) instead of the cursor, which stays where it is")
      .action(async (options: BoardCheckOptions) => exit(await runBoardCheck(options, deps)))
  );
  board.addCommand(
    common(new Command("list"))
      .description("The cards by column; filters keep the columns and show matching of total")
      .option("--column <column>", "one column (its id or name)")
      .option("--tag <tag>", "cards with this tag (repeatable: every tag)", collect)
      .option("--type <type>", "cards of this type")
      .option("--repo <name>", "cards tagged repo:<name>")
      .option("--archived", "include archived cards")
      .action(async (options: BoardListOptions) => exit(await runBoardList(options, deps)))
  );
  board.addCommand(
    common(new Command("show"))
      .description("One card: its fields, relations (both ways), attachments, description and thread")
      .argument("<id>", "the card's id (42 or #42)")
      .option("--as <participant>", "record that you opened it: its events up to now are seen")
      .action(async (id: string, options: BoardShowOptions) => exit(await runBoardShow(id, options, deps)))
  );
  board.addCommand(
    rewritable(common(new Command("new")))
      .description("Create a card (the id from nextId), tagged by:<participant>, with its event; or every card of a markdown file (--batch), all or none")
      .option("--as <participant>", "who creates it")
      .option("--type <type>", "question, decision, task, idea, review or note")
      .option("--title <text>", "the title (one line)")
      .option("--column <column>", "where it lands (default: the first column, Inbox)")
      .option("--tag <tag>", "a tag (repeatable)", collect)
      .option("--body <markdown>", "the description")
      .option("--body-file <path>", "the description, from a file")
      .option("--relate <kind:id>", "a relation, as child-of:7 (repeatable)", collect)
      .option("--session <id>", "the agent session the card came from")
      .option("--field <name=value>", 'a field of the type, as ask="…" on a decision: what is decided, the options, the recommendation (repeatable)', collect)
      .option(
        "--batch <file>",
        'several cards from one markdown file, each a heading "## <title>", a ```yaml block (type, and key, column, tags, fields, relations: { kind, to: <id> or "@key" }) and its description; all are created, or none'
      )
      .option("--dry-run", "print what would be created, with the ids, and write nothing")
      .action(async (options: BoardNewOptions) => exit(await runBoardNew(options, deps)))
  );
  board.addCommand(
    rewritable(common(new Command("reply")))
      .description("Append a comment to a card's thread, with its event")
      .argument("<id>", "the card's id")
      .option("--as <participant>", "who writes it")
      .option("--text <markdown>", "the comment")
      .option("--file <path>", "the comment, from a file")
      .option("--if-updated <time>", "refuse when the card's updated is not this (a stale write)")
      .action(async (id: string, options: BoardReplyOptions) => exit(await runBoardReply(id, options, deps)))
  );
  board.addCommand(
    rewritable(common(new Command("move")))
      .description("Move a card to a column (an agent: only into agents.mayMoveTo, never a person's column)")
      .argument("<id>", "the card's id")
      .option("--to <column>", "the column (its id or name)")
      .option("--as <participant>", "who moves it")
      .option("--comment <markdown>", "a comment written with the move")
      .option("--if-updated <time>", "refuse when the card's updated is not this (a stale write)")
      .action(async (id: string, options: BoardMoveOptions) => exit(await runBoardMove(id, options, deps)))
  );
  board.addCommand(
    rewritable(common(new Command("set")))
      .description("Change a card's tags, relations, status line, colour or fields, each change with its event")
      .argument("<id>", "the card's id")
      .option("--as <participant>", "who changes it")
      .option("--tag <tag>", "add a tag (repeatable)", collect)
      .option("--untag <tag>", "remove a tag (repeatable)", collect)
      .option("--relate <kind:id>", "add a relation, as related:12 (repeatable)", collect)
      .option("--unrelate <kind:id>", "remove a relation (repeatable)", collect)
      .option("--status <text>", "the one-line status beside the column (an empty text removes it)")
      .option("--color <hex|none>", "the person's colour mark: b33f40 red, ed944d orange, edd94c yellow, 48a14d green, 6577b3 blue (quote it when you write the #), or none")
      .option("--field <name=value>", 'set a field of the card\'s type, as ask="…" on a decision; a JSON list or mapping is read as one (repeatable)', collect)
      .option("--unset-field <name>", "remove a field, one the card keeps from another type too (repeatable)", collect)
      .option("--if-updated <time>", "refuse when the card's updated is not this (a stale write)")
      .action(async (id: string, options: BoardSetOptions) => exit(await runBoardSet(id, options, deps)))
  );
  board.addCommand(
    common(new Command("validate"))
      .description("Check every file of the board; exit 1 with the reasons when something is wrong")
      .action(async (options: Common) => exit(await runBoardValidate(options, deps)))
  );
  board.addCommand(
    common(new Command("import"))
      .description("Turn PINNED.md, DECISIONS-PENDING.md and the plan's status table into cards, once, and print the mapping to check")
      .option("--from <folder>", "the folder of the documents (docs)")
      .option("--as <person>", "who imports (default: the board's first person)")
      .option("--plan <file>", "the plan (default: <from>/behaviour-extraction-plan-2026-10-01.md)")
      .option("--section <n>", "the plan's section with the status table (default: 8)")
      .option("--repo <name>", "the repository's name for the repo: tag (default: the repository folder's name)")
      .option("--workspace <folder>", "the folder of the workspace's repositories (default: the repository's parent)")
      .option("--dry-run", "print the mapping and write nothing")
      .action(async (options: BoardImportOptions) => exit(await runBoardImport(options, deps)))
  );
  board.addCommand(
    common(new Command("tidy"))
      .description("Once the import is done: strip from each imported card's description the opening repetition of its title in bold")
      .option("--imported", "the cards board.json's imports lists (the only tidy there is)")
      .option("--as <participant>", "who changes them (default: the board's first person)")
      .option("--dry-run", "print every change and write nothing")
      .action(async (options: BoardTidyOptions) => exit(await runBoardTidy(options, deps)))
  );
  board.addCommand(
    common(new Command("serve"))
      .description("Serve the board's page on this machine (127.0.0.1 only): the columns, the cards and their threads, the notifications, live as the files change")
      .option("--port <port>", `the port (default ${DEFAULT_BOARD_PORT}, or a free one when it is taken; 0: a free one)`)
      .option("--open", "open the page in the browser")
      .action(async (options: BoardServeOptions) => exit(await runBoardServe(options, deps)))
  );
  return board;
}
