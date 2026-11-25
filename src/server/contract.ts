/**
 * What the board's page and its local process say to each other: the JSON of the HTTP API and
 * the messages of the event stream. Types only, with no import, so that the page imports them
 * without importing the process, and so that another host (the VS Code extension, later) can
 * answer the page with the same shapes.
 */

export type CardId = number | string;

export interface ParticipantInfo {
  id: string;
  kind: "person" | "agent";
  name: string;
}

export interface ColumnInfo {
  id: string;
  name: string;
  /** "person": only a person moves cards into it (Pinned, Done). */
  owner?: "person";
  limit?: number;
  /** True when an agent may move a card into it (board.json's agents.mayMoveTo). */
  agentsMay: boolean;
}

export interface LastComment {
  author: string;
  at: string;
  excerpt: string;
}

/** A card as the board shows it: what its tile needs, and its description for the free-text filter. */
export interface CardSummary {
  id: CardId;
  type: string;
  title: string;
  column: string;
  tags: string[];
  author: string;
  created: string;
  updated: string;
  status?: string;
  archived?: string;
  /** The person's colour mark: one of BoardPayload.colors, by its hex. */
  color?: string;
  /** A decision's ask (`fields.ask`): what is decided, the options, the recommendation. */
  ask?: string;
  /** A decision whose `decided` is written: no decision waits on the person any more. */
  decided?: boolean;
  /** What was decided (`fields.decided`): the option chosen, who decided and the day; the tile shows the option. */
  outcome?: { option: string; by: string; on: string };
  /**
   * Its place in its column, read from the event log (the higher, the nearer the top): a card takes
   * the top when it arrives in a column, and the place it was dropped at when the person drops it.
   */
  rank: number;
  description: string;
  comments: number;
  last?: LastComment;
  /** The last comment is by someone else than the person: it waits on them. */
  waitsOnYou: boolean;
  /** An agent's card the person has not touched yet (no event and no comment of theirs on it). */
  proposal: boolean;
  /** An agent wrote on it since it entered In progress: the agent reported working on it. */
  working?: { by: string; at: string };
  /** The agent the board gave it to from Ready, and until when it holds it (the tile counts down to `until`). */
  claim?: ClaimInfo;
  /** A card in Ready that would not be given now: why, in one short line ("waits on #12"), until `until` when it ends by itself. */
  wait?: WaitInfo;
  relations: number;
  attachments: number;
  file: string;
  hash: string;
}

/** A card's claim (core/claim.ts): the agent that holds it, since when, until when (UTC). */
export interface ClaimInfo {
  by: string;
  since: string;
  until: string;
}

/** Why a card in Ready would not be given now (core/dispatch.ts). */
export interface WaitInfo {
  why: "not-ready" | "blocked" | "in-use" | "for-others" | "limit";
  /** One short line: "waits on #12", "its files are in use by #7", "for Codex". */
  line: string;
  words: string;
  cards?: CardId[];
  agents?: string[];
  /** When the reason ends by itself (the claims it rests on run out): past it, the line no longer holds. */
  until?: string;
}

/** A colour a card may carry (the "Matte Rainbow" palette). */
export interface CardColor {
  hex: string;
  name: string;
}

/** Where the files the cards point at are, so that a path can open in the editor. */
export interface EditorInfo {
  /** The repository the board is in, as an absolute path of this machine. */
  root: string;
  /** The folder of the workspace's repositories (the repository's parent). */
  workspace: string;
  /** The repository's folder name. */
  repository: string;
}

/** One thing a card does not say yet that a card in Ready must say (the core's ReadyGap). */
export interface ReadyGapInfo {
  what: "done-when" | "may-touch" | "limit";
  /** The card's fields that say it. */
  fields: string[];
  /** The refusal's words for it ("it does not say how to tell it is done (definitionOfDone)"). */
  words: string;
}

/**
 * Ready: the person's column of the cards an agent may pick up by itself; a card goes there only
 * when it says how to tell it is done, what it may touch and a limit (core/ready.ts).
 */
export interface ReadyInfo {
  /** The column's id, when the board has it; absent on a board made before it. */
  column?: string;
  /** The fields a card in Ready says its three things in, by the names the files use. */
  fields: { doneWhen: string; mayTouch: string; limitMinutes: string; limitMoney: string };
  /** The command that gives a board without the column its column (`pinboard add-ready`). */
  command: string;
}

export interface BoardPayload {
  name: string;
  /** The person the page writes as (board.json's first person). */
  person: ParticipantInfo;
  participants: ParticipantInfo[];
  columns: ColumnInfo[];
  types: string[];
  /** The typed fields of each card type, by the names the files use. */
  typeFields: Record<string, string[]>;
  /** The colours a card may carry, in the palette's order. */
  colors: CardColor[];
  relationKinds: string[];
  tagNamespaces: string[];
  /** Every card the board can read, archived ones included (flagged). */
  cards: CardSummary[];
  /** Files of items/ that are no card the board can read, with why. */
  unreadable: Array<{ file: string; problems: string[] }>;
  /** How many lines of events.jsonl the stream has announced: its position. */
  lines: number;
  editor: EditorInfo;
  checkMinutes: number;
  ready: ReadyInfo;
}

/** One event as a line the person reads: who did what, when, on which card. */
export interface EventItem {
  /** The event's place in the log (from 1), when it is known. */
  position?: number;
  at: string;
  by: string;
  /** The participant's name ("Claude Code"); "unknown" for a change that came without an event. */
  byName: string;
  item?: CardId;
  kind: string;
  /** The event in words, as the CLI's check says it ("moved it from Inbox to Backlog"). */
  text: string;
  data?: Record<string, unknown>;
  /**
   * In the notification list: the kinds of the events this one line stands for, when it stands for
   * more than one (a comment and a move written in one step are one line, "commented and moved it
   * to Done: …").
   */
  merged?: string[];
}

export interface RelationLine {
  kind: string;
  to: CardId;
  /** The card whose file states the relation; a line stated by the other card is shown, never removed from here. */
  statedBy: CardId;
  own: boolean;
  title?: string;
  type?: string;
  column?: string;
  archived?: boolean;
}

export interface AttachmentLine {
  path: string;
  lines?: string;
  /** `path:lines`, as the card says it. */
  label: string;
  /** The editor link (`vscode://file/…:line`) when the file is on this machine. */
  href?: string;
  exists: boolean;
}

/** A path or an evidence record named in a card's text that is on this machine, keyed by the text that names it. */
export interface Mention {
  path: string;
  line?: number;
  href: string;
  kind: "path" | "evidence";
}

export interface CardDetail {
  card: {
    id: CardId;
    type: string;
    title: string;
    column: string;
    tags: string[];
    author: string;
    created: string;
    updated: string;
    relations: Array<{ kind: string; to: CardId }>;
    attachments: Array<{ path: string; lines?: string }>;
    fields: Record<string, unknown>;
    session?: string;
    status?: string;
    archived?: string;
    color?: string;
    claim?: ClaimInfo;
    extra: Record<string, unknown>;
    description: string;
    thread: Array<{ author: string; at: string; body: string }>;
    file: string;
    hash: string;
  };
  /** What is wrong with the card's file (a reader shows it; a write is refused until it is fixed). */
  problems: string[];
  relations: RelationLine[];
  attachments: AttachmentLine[];
  /** The card's events, newest first. */
  activity: EventItem[];
  mentions: Record<string, Mention>;
}

export interface NotificationGroup {
  item?: CardId;
  title?: string;
  type?: string;
  column?: string;
  /** The time of the group's newest event. */
  latest: string;
  /** Newest first. */
  events: EventItem[];
}

export interface NotificationsPayload {
  /** Unseen events by others: the capsule's count. */
  count: number;
  /** How many cards they are on. */
  cards: number;
  /** By card, the card with the newest event first; at most the last 50 events in all. */
  groups: NotificationGroup[];
  shown: number;
  /** Unseen events per card id, for the dot on a card. */
  unseenByCard: Record<string, number>;
  /** Of `count`, the events addressed to the person: a comment or a description that mentions them (`@robin`). */
  addressed: number;
  /** Those per card id, for the "@you" on a card. */
  addressedByCard: Record<string, number>;
  /** The time of the person's last "clear all". */
  since?: string;
}

/** What every write answers: the card as it is now, its tile, and the events the write appended. */
export interface WritePayload {
  card: CardDetail;
  summary: CardSummary;
  events: EventItem[];
}

export interface EventsPayload {
  lines: number;
  events: EventItem[];
}

/** A write the board refused, in the core's words. */
export interface RefusalPayload {
  refused: string;
  message: string;
  /** The Ready check (`refused: "ready"`): the card it is about, when it has an id yet. */
  card?: CardId;
  /** The Ready check: each thing the card does not say yet. */
  missing?: ReadyGapInfo[];
}

/** The stream's first message, after any events it replays. */
export interface ReadyMessage {
  lines: number;
  person: string;
}

/** A card's file changed (or appeared, or went away). */
export interface CardMessage {
  id: CardId;
  removed?: boolean;
  card?: CardSummary;
}

/** The changes a page asks of a card (the core's CardChanges). */
export interface CardChangesInput {
  title?: string;
  type?: string;
  description?: string;
  status?: string | null;
  /** One of BoardPayload.colors by its hex; null removes the colour. */
  color?: string | null;
  addTags?: string[];
  removeTags?: string[];
  addRelations?: Array<{ kind: string; to: CardId }>;
  removeRelations?: Array<{ kind: string; to: CardId }>;
  addAttachments?: Array<{ path: string; lines?: string }>;
  fields?: Record<string, unknown>;
}

/** A move the page asks for: the column, and where in it the card was dropped (below `after`, or at the top: null). */
export interface MoveInput {
  to: string;
  expectUpdated?: string;
  comment?: string;
  after?: CardId | null;
}

export interface NewCardInput {
  type: string;
  title: string;
  column?: string;
  description?: string;
  tags?: string[];
  relations?: Array<{ kind: string; to: CardId }>;
  /** The card's fields (a card made in Ready gives the three things a card there says). */
  fields?: Record<string, unknown>;
}

/** One theme's choices, by default or for one project (core/themes.ts): each optional in a project, which falls back to the default. */
export interface ThemeChoicesInfo {
  /** One of the ten themes' ids, or "system". */
  theme?: string;
  lightTheme?: string;
  darkTheme?: string;
  /** "theme" (the theme's own) or a colour, `#rrggbb`. */
  background?: string;
}

/** The board's view preferences on this machine (`.local/preferences.json` in the board folder). */
export interface PreferencesDocument {
  schema: string;
  default: { theme: string; lightTheme: string; darkTheme: string; background?: string };
  projects: Record<string, ThemeChoicesInfo>;
  /** "" for all projects, "(none)" for cards with no project, or a project's name. */
  lastProject?: string;
}

/** GET and PUT /api/preferences answer this. */
export interface PreferencesPayload {
  preferences: PreferencesDocument;
  /** False while there is no file yet (or one that cannot be used): these are the defaults. */
  stored: boolean;
  /** Why a file that is there could not be used. */
  problems?: string[];
}

/** POST /api/take: an agent asks the board for its card (`as`, an agent of the board), for the board's lease or `lease` minutes. */
export interface TakeInput {
  as: string;
  lease?: number;
}

/** POST /api/items/:id/renew: the agent that holds the card extends its claim. */
export interface RenewInput {
  as: string;
  lease?: number;
}

/** POST /api/items/:id/release: the agent that holds the card gives it back to Ready, with the reason. */
export interface ReleaseInput {
  as: string;
  reason: string;
}

export type BatchOperationName = "move" | "archive" | "unarchive" | "tags" | "project";

/** POST /api/cards/batch: one operation on several cards, each card's write its own, in order. */
export interface BatchInput {
  /** Who writes: the board's person when not given (the page is the person). */
  as?: string;
  operation: BatchOperationName;
  ids: CardId[];
  /** move: the column. */
  to?: string;
  /** move: where the first card goes (below that card, or the top: null); the others follow it in order. */
  after?: CardId | null;
  /** tags: the tags to add and to remove. */
  add?: string[];
  remove?: string[];
  /** project: the project's name (its tag is repo:<name>). */
  project?: string;
  /** project: remove the cards' other project tags. */
  replace?: boolean;
  /** Per card id, the `updated` the page read: a card changed since is refused, the others are written. */
  expectUpdated?: Record<string, string>;
}

export interface BatchCardResult {
  id: CardId;
  outcome: "changed" | "unchanged" | "refused";
  /** The core's refusal of this card's write, and its reason, short ("changed since you read it"); the Ready check's `missing` too. */
  refused?: { code: string; message: string; reason: string; missing?: ReadyGapInfo[] };
  /** The card's tile as it is now (after a write that was not refused). */
  summary?: CardSummary;
  events?: EventItem[];
  /** Where the card stood before the call: what an Undo puts back. */
  before?: { column: string; above: CardId | null; tags: string[]; archived?: string; updated: string };
}

export interface BatchPayload {
  operation: BatchOperationName;
  results: BatchCardResult[];
  changed: number;
  unchanged: number;
  refused: number;
}
