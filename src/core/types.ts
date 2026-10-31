import type { YamlMap, YamlValue } from "./yaml.js";

/** The value of `schema` in every board.json this core reads and writes. */
export const BOARD_SCHEMA = "codelead.board/1";

/** Where the board lives in a repository. */
export const BOARD_FOLDER = "docs/codelead/board";

export interface BoardColumn {
  id: string;
  name: string;
  /** `"person"`: only a person moves cards into this column. */
  owner?: "person";
  limit?: number;
  [key: string]: unknown;
}

export interface Participant {
  id: string;
  kind: "person" | "agent";
  name: string;
  [key: string]: unknown;
}

/** One document the import has turned into cards: the marker that keeps it from running twice. */
export interface ImportMarker {
  source: string;
  at: string;
  by: string;
  sha256: string;
  cards: CardId[];
  [key: string]: unknown;
}

export interface BoardConfig {
  schema: string;
  name: string;
  columns: BoardColumn[];
  types: string[];
  tagNamespaces: string[];
  participants: Participant[];
  agents: { mayMoveTo: string[]; mayCreate: boolean; [key: string]: unknown };
  check?: { intervalMinutes: number; [key: string]: unknown };
  nextId?: number;
  imports?: ImportMarker[];
  /** The folder of the repositories a card may cite as `<repository>:<path>`, relative to the repository; `..` (its parent) when not given. */
  workspace?: string;
  [key: string]: unknown;
}

/** A card's id: a number today; the format allows a string id (`robin-12`, a ULID) for later. */
export type CardId = number | string;

/** The kinds of relation a card states, in its own front matter. */
export const RELATION_KINDS = ["parent-of", "child-of", "related", "blocks", "blocked-by", "duplicate-of", "follows"] as const;

/** How a relation reads from the other card, which does not state it: shown, never written. */
export const RELATION_SEEN_FROM_TARGET: Record<string, string> = {
  "parent-of": "child-of",
  "child-of": "parent-of",
  related: "related",
  blocks: "blocked-by",
  "blocked-by": "blocks",
  "duplicate-of": "duplicated-by",
  follows: "followed-by"
};

export interface Relation {
  kind: string;
  to: CardId;
  [key: string]: YamlValue;
}

export interface Attachment {
  /** A path in the repository, or `<repository>:<path>` for another repository of the workspace. */
  path: string;
  lines?: string;
  [key: string]: YamlValue | undefined;
}

export interface Comment {
  author: string;
  at: string;
  body: string;
}

/** A card as its file says it: the front matter's keys, the description and the thread. */
export interface CardData {
  id: CardId;
  type: string;
  title: string;
  column: string;
  tags: string[];
  author: string;
  created: string;
  updated: string;
  relations: Relation[];
  attachments: Attachment[];
  fields: YamlMap;
  session?: string;
  /** The person's colour mark: one of CARD_COLORS, by its hex in lower case (`"#b33f40"`). */
  color?: string;
  /** A one-line account of where the card stands, beside its column ("landed, waiting on the regression"). */
  status?: string;
  /** When the card left the board; it stays in its file and stays searchable. */
  archived?: string;
  /** Front-matter keys this core does not know, as read: kept in the file, never dropped. */
  extra: YamlMap;
  description: string;
  thread: Comment[];
}

export interface Card extends CardData {
  /** The card's file, relative to the board folder, with "/" (`items/0042-w5-wp6-composer.md`). */
  file: string;
  /** A digest of the file's text as it was read: what a write compares before it replaces the file. */
  hash: string;
}

/**
 * The colours a card may carry, the person's own colour coding (front-matter key `color`, stored by
 * its hex): the "Matte Rainbow" palette, in its order.
 */
export const CARD_COLORS: ReadonlyArray<{ hex: string; name: string }> = [
  { hex: "#b33f40", name: "red" },
  { hex: "#ed944d", name: "orange" },
  { hex: "#edd94c", name: "yellow" },
  { hex: "#48a14d", name: "green" },
  { hex: "#6577b3", name: "blue" }
];

/** The decision asked of the person, on a decision card (`fields.ask`): what is decided, the options, the recommendation. */
export const ASK_FIELD = "ask";

/** An ask is one to three sentences; the details belong in the description. */
export const ASK_LIMIT = 600;

/** The person's answer on a decision card (`fields.decided`): which option, by whom, on which day. */
export const DECIDED_FIELD = "decided";

/**
 * A decision as the board records it, in a card's `fields.decided` and in the `data.decided` of the
 * `item.updated` that set it: the option chosen, who decided (a participant's id) and the day
 * (`2026-10-05`).
 */
export interface Decision {
  option: string;
  by: string;
  on: string;
}

/** The typed fields of each card type (spec section 5), by the names the files use. */
export const TYPE_FIELDS: Record<string, string[]> = {
  question: ["askedBy", "answer"],
  decision: [ASK_FIELD, "options", "recommendation", DECIDED_FIELD, "consequences"],
  task: ["definitionOfDone", "size", "landed"],
  idea: ["hypothesis", "worthItIf"],
  review: ["toReview", "verdict"],
  note: []
};

export const EVENT_KINDS = [
  "item.created",
  "item.updated",
  "item.moved",
  "item.archived",
  "comment.added",
  "relation.added",
  "relation.removed",
  "tag.added",
  "tag.removed",
  "attachment.added"
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

/** One line of events.jsonl. Unknown keys are kept as read. */
export interface BoardEvent {
  at: string;
  by: string;
  item?: CardId;
  kind: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Who wrote an event that nobody wrote: the change of a card's file without an event line. */
export const UNKNOWN_PARTICIPANT = "unknown";

/** What a participant has seen (`cursors/<participant>.json`). Unknown keys are kept as read. */
export interface Cursor {
  /** The time of the participant's last acknowledged check. */
  seen?: string;
  /** How many lines of events.jsonl the participant has seen: the exact place of the cursor. */
  lines?: number;
  /** Per card id, when the participant last opened the card: its events before that are seen. */
  opened?: Record<string, string>;
  [key: string]: unknown;
}
