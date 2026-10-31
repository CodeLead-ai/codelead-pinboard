import fs from "node:fs";
import path from "node:path";
import { BoardRefusal } from "./errors.js";
import { writeFileAtomic } from "./files.js";
import { formatJson } from "./json.js";
import { joinText, splitText, type Eol } from "./text.js";
import { BOARD_SCHEMA, UNKNOWN_PARTICIPANT, type BoardColumn, type BoardConfig, type Participant } from "./types.js";

/**
 * `board.json`: the columns (spec section 6.1), the card types (section 5), the reserved tag
 * namespaces, the participants, which columns an agent may move a card into (Robin's answer:
 * Inbox, Backlog, Ideas, In progress, For review; never Pinned or Done, which belong to a person),
 * the check interval, the next card id, and the workspace (the folder of the repositories a card
 * may cite as `<repository>:<path>`, relative to the repository; its parent when not given).
 */
export const DEFAULT_COLUMNS: readonly BoardColumn[] = [
  { id: "inbox", name: "Inbox" },
  { id: "backlog", name: "Backlog" },
  { id: "ideas", name: "Ideas" },
  { id: "pinned", name: "Pinned", owner: "person" },
  { id: "in-progress", name: "In progress" },
  { id: "for-review", name: "For review" },
  { id: "done", name: "Done", owner: "person" }
];
export const DEFAULT_TYPES: readonly string[] = ["question", "decision", "task", "idea", "review", "note"];
export const DEFAULT_TAG_NAMESPACES: readonly string[] = ["repo", "area", "by"];
export const DEFAULT_AGENT_COLUMNS: readonly string[] = ["inbox", "backlog", "ideas", "in-progress", "for-review"];
export const DEFAULT_CHECK_MINUTES = 30;
/** The workspace when board.json gives none: the repository's parent, the folder of its sibling repositories. */
export const DEFAULT_WORKSPACE = "..";

const WORD = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function defaultBoardConfig(options: { name: string; participants: Participant[] }): BoardConfig {
  return {
    schema: BOARD_SCHEMA,
    name: options.name,
    columns: DEFAULT_COLUMNS.map((column) => ({ ...column })),
    types: [...DEFAULT_TYPES],
    tagNamespaces: [...DEFAULT_TAG_NAMESPACES],
    participants: options.participants.map((participant) => ({ ...participant })),
    agents: { mayMoveTo: [...DEFAULT_AGENT_COLUMNS], mayCreate: true },
    check: { intervalMinutes: DEFAULT_CHECK_MINUTES },
    nextId: 1
  };
}

export interface BoardConfigFile {
  config: BoardConfig;
  /** The file's text as read: a write that only raises nextId changes that number in it and nothing else. */
  raw: string;
  eol: Eol;
  bom: boolean;
}

export function boardConfigPath(dir: string): string {
  return path.join(dir, "board.json");
}

/** What is wrong with a board.json's content, in plain words; empty when nothing is. */
export function boardConfigProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["board.json must hold one JSON object"];
  const config = value as Record<string, unknown>;
  if (config.schema !== BOARD_SCHEMA) problems.push(`"schema" is ${JSON.stringify(config.schema)}; this board reads "${BOARD_SCHEMA}"`);
  if (typeof config.name !== "string" || config.name.trim() === "") problems.push('"name" must be a text');

  const columnIds: string[] = [];
  const personColumns = new Set<string>();
  if (!Array.isArray(config.columns) || config.columns.length === 0) problems.push('"columns" must be a list of at least one { "id", "name" }');
  else {
    config.columns.forEach((column, index) => {
      const entry = column as Record<string, unknown>;
      if (typeof column !== "object" || column === null || typeof entry.id !== "string" || !WORD.test(entry.id) || typeof entry.name !== "string") {
        problems.push(`column ${index + 1} must be { "id": <word>, "name": <text> }`);
        return;
      }
      if (columnIds.includes(entry.id)) problems.push(`the column id "${entry.id}" appears twice`);
      columnIds.push(entry.id);
      if (entry.owner !== undefined && entry.owner !== "person") problems.push(`column "${entry.id}": "owner" can only be "person"`);
      if (entry.owner === "person") personColumns.add(entry.id);
    });
  }

  if (!Array.isArray(config.types) || config.types.length === 0 || !config.types.every((type) => typeof type === "string" && WORD.test(type))) {
    problems.push('"types" must be a list of at least one word');
  } else if (new Set(config.types).size !== config.types.length) problems.push('a card type appears twice in "types"');
  if (config.tagNamespaces !== undefined && (!Array.isArray(config.tagNamespaces) || !config.tagNamespaces.every((name) => typeof name === "string" && WORD.test(name)))) {
    problems.push('"tagNamespaces" must be a list of words');
  }

  const participantIds: string[] = [];
  if (!Array.isArray(config.participants) || config.participants.length === 0) problems.push('"participants" must be a list of at least one { "id", "kind", "name" }');
  else {
    config.participants.forEach((participant, index) => {
      const entry = participant as Record<string, unknown>;
      if (typeof participant !== "object" || participant === null || typeof entry.id !== "string" || !WORD.test(entry.id) || (entry.kind !== "person" && entry.kind !== "agent") || typeof entry.name !== "string") {
        problems.push(`participant ${index + 1} must be { "id": <word>, "kind": "person" or "agent", "name": <text> }`);
        return;
      }
      if (entry.id === UNKNOWN_PARTICIPANT) problems.push(`"${UNKNOWN_PARTICIPANT}" cannot be a participant: it names who wrote a change that came without an event`);
      if (participantIds.includes(entry.id)) problems.push(`the participant id "${entry.id}" appears twice`);
      participantIds.push(entry.id);
    });
  }

  const agents = config.agents as Record<string, unknown> | undefined;
  if (typeof agents !== "object" || agents === null || !Array.isArray(agents.mayMoveTo) || typeof agents.mayCreate !== "boolean") {
    problems.push('"agents" must be { "mayMoveTo": [<column ids>], "mayCreate": true or false }');
  } else {
    for (const column of agents.mayMoveTo as unknown[]) {
      if (typeof column !== "string" || !columnIds.includes(column)) problems.push(`"agents.mayMoveTo" names ${JSON.stringify(column)}, which is not a column of the board`);
      else if (personColumns.has(column)) problems.push(`"agents.mayMoveTo" names "${column}", a column only a person moves cards into`);
    }
  }

  const check = config.check as Record<string, unknown> | undefined;
  if (check !== undefined && (typeof check !== "object" || check === null || typeof check.intervalMinutes !== "number" || !(check.intervalMinutes > 0))) {
    problems.push('"check" must be { "intervalMinutes": <minutes, more than 0> }');
  }
  if (config.nextId !== undefined && (typeof config.nextId !== "number" || !Number.isSafeInteger(config.nextId) || config.nextId < 1)) {
    problems.push('"nextId" must be a whole number of 1 or more');
  }
  if (config.imports !== undefined && !Array.isArray(config.imports)) problems.push('"imports" must be a list');
  // The workspace is a path relative to the repository: board.json is committed, and names no folder of this machine.
  if (config.workspace !== undefined) {
    if (typeof config.workspace !== "string" || config.workspace.trim() === "") problems.push('"workspace" must be a text: the folder of the repositories a card may cite, relative to the repository (".." for its parent)');
    else if (path.isAbsolute(config.workspace) || /^[A-Za-z]:|^[\\/]/.test(config.workspace)) problems.push(`"workspace" is ${JSON.stringify(config.workspace)}; it must be relative to the repository (".." for its parent), so that board.json names no folder of this machine`);
  }
  return problems;
}

/** Reads board.json, or says why it cannot be read: `{ problems }` instead of a config. */
export function inspectBoardConfig(dir: string): BoardConfigFile | { problems: string[]; missing?: boolean } {
  let raw: string;
  try {
    raw = fs.readFileSync(boardConfigPath(dir), "utf8");
  } catch {
    return { problems: ["there is no board.json"], missing: true };
  }
  const { text, eol, bom } = splitText(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { problems: [`board.json does not parse as JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const problems = boardConfigProblems(parsed);
  if (problems.length > 0) return { problems };
  return { config: parsed as BoardConfig, raw, eol, bom };
}

/** Reads board.json; refuses (no board, or a board.json this core does not read) with the reasons. */
export function readBoardConfig(dir: string): BoardConfigFile {
  const inspected = inspectBoardConfig(dir);
  if ("config" in inspected) return inspected;
  if (inspected.missing) {
    throw new BoardRefusal("no-board", `No board at ${dir} (no board.json there). Run \`codelead board init\` in the repository first.`);
  }
  throw new BoardRefusal("invalid", `Refused: board.json cannot be used: ${inspected.problems.join("; ")}. Nothing was written.`);
}

function withoutKey(config: BoardConfig, key: string): string {
  const { [key]: _dropped, ...rest } = config;
  return JSON.stringify(rest);
}

/**
 * Writes board.json. When only `nextId` changed (every new card), that number is replaced in the
 * file as it stands and every other byte is kept; any other change writes the file in the
 * board's own layout. Unknown keys are kept either way, and so are the line endings.
 */
export function writeBoardConfig(dir: string, file: BoardConfigFile, next: BoardConfig): BoardConfigFile {
  const { text } = splitText(file.raw);
  let body: string | undefined;
  if (withoutKey(file.config, "nextId") === withoutKey(next, "nextId") && typeof next.nextId === "number") {
    const pattern = /("nextId"\s*:\s*)\d+/g;
    if ((text.match(pattern) ?? []).length === 1) body = text.replace(pattern, `$1${next.nextId}`);
  }
  body ??= `${formatJson(next)}\n`;
  const raw = joinText(body, file.eol, file.bom);
  writeFileAtomic(boardConfigPath(dir), raw);
  return { config: next, raw, eol: file.eol, bom: file.bom };
}

/** A new board.json's text. */
export function boardConfigText(config: BoardConfig): string {
  return `${formatJson(config)}\n`;
}

export function columnOf(config: BoardConfig, idOrName: string): BoardColumn | undefined {
  const wanted = idOrName.trim().toLowerCase();
  return config.columns.find((column) => column.id.toLowerCase() === wanted) ?? config.columns.find((column) => column.name.toLowerCase() === wanted);
}

export function participantOf(config: BoardConfig, id: string): Participant | undefined {
  return config.participants.find((participant) => participant.id === id);
}

/** The columns an agent may move a card into: those in agents.mayMoveTo that no person owns. */
export function agentColumns(config: BoardConfig): BoardColumn[] {
  return config.columns.filter((column) => config.agents.mayMoveTo.includes(column.id) && column.owner !== "person");
}

/**
 * The workspace's folder on this machine: board.json's `workspace` (a path relative to the
 * repository), or the repository's parent when it gives none. A card cites a file under it as
 * `<repository>:<path>`.
 */
export function workspaceOf(root: string, config?: Pick<BoardConfig, "workspace">): string {
  const relative = typeof config?.workspace === "string" && config.workspace.trim() !== "" ? config.workspace : DEFAULT_WORKSPACE;
  return path.resolve(root, relative);
}

export function intervalMinutes(config: BoardConfig): number {
  return config.check?.intervalMinutes ?? DEFAULT_CHECK_MINUTES;
}
