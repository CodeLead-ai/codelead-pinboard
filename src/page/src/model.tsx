import type { BoardPayload, CardId, CardSummary, ColumnInfo } from "../../server/contract.js";

/**
 * The board as the page reads it: the filter (kept in the URL's query, so a browser tab can stay on
 * "what waits on me in the rebuild"), which cards match it, the order of a column, and the words.
 */

export interface Filter {
  /** Free text over title and description; "42" or "#42" also finds card 42. */
  q: string;
  column: string;
  type: string;
  /** Every one of these tags. */
  tags: string[];
  repo: string;
  /** "hide" removes the cards that do not match; "fade" dims them. */
  show: "fade" | "hide";
  /** Show archived cards too. */
  archived: boolean;
}

export const EMPTY_FILTER: Filter = { q: "", column: "", type: "", tags: [], repo: "", show: "fade", archived: false };

export function readFilter(search: string): Filter {
  const query = new URLSearchParams(search);
  return {
    q: query.get("q") ?? "",
    column: query.get("column") ?? "",
    type: query.get("type") ?? "",
    tags: query.getAll("tag").filter((tag) => tag !== ""),
    repo: query.get("repo") ?? "",
    show: query.get("show") === "hide" ? "hide" : "fade",
    archived: query.get("archived") === "1"
  };
}

/** The open panels, bottom first (`?card=10&card=43`). */
export function readStack(search: string): string[] {
  return new URLSearchParams(search).getAll("card").filter((id) => id !== "");
}

export function writeQuery(filter: Filter, stack: string[]): string {
  const query = new URLSearchParams();
  if (filter.q.trim() !== "") query.set("q", filter.q);
  if (filter.column) query.set("column", filter.column);
  if (filter.type) query.set("type", filter.type);
  for (const tag of filter.tags) query.append("tag", tag);
  if (filter.repo) query.set("repo", filter.repo);
  if (filter.show === "hide") query.set("show", "hide");
  if (filter.archived) query.set("archived", "1");
  for (const id of stack) query.append("card", id);
  const text = query.toString();
  return text === "" ? "" : `?${text}`;
}

/** True when any part of the filter narrows the board (fade/hide and archived alone do not). */
export function isFiltering(filter: Filter): boolean {
  return filter.q.trim() !== "" || filter.column !== "" || filter.type !== "" || filter.tags.length > 0 || filter.repo !== "";
}

export function keyOf(id: CardId): string {
  return String(id);
}

export function matches(card: CardSummary, filter: Filter): boolean {
  if (filter.column && card.column !== filter.column) return false;
  if (filter.type && card.type !== filter.type) return false;
  if (filter.tags.length > 0 && !filter.tags.every((tag) => card.tags.includes(tag))) return false;
  if (filter.repo && !card.tags.includes(`repo:${filter.repo}`)) return false;
  const q = filter.q.trim().toLowerCase();
  if (q !== "") {
    const asId = /^#?([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(q);
    if (asId && String(card.id).toLowerCase() === asId[1]) return true;
    if (!card.title.toLowerCase().includes(q) && !card.description.toLowerCase().includes(q)) return false;
  }
  return true;
}

/** The cards the board shows: archived ones only when asked for. */
export function onBoard(card: CardSummary, filter: Filter): boolean {
  return card.archived === undefined || filter.archived;
}

/**
 * A column's cards in their order: the newest arrival on top, and a card the person dropped at the
 * place it was dropped (the process reads each card's `rank` from the event log). A comment or an
 * edit does not move a card.
 */
export function columnCards(cards: CardSummary[], column: string): CardSummary[] {
  return cards.filter((card) => card.column === column).sort((left, right) => right.rank - left.rank || String(right.id).localeCompare(String(left.id), undefined, { numeric: true }));
}

/**
 * The rank a card takes when it is dropped in a column below `after` (or at the top: null), worked
 * out as the process works it out from the move's event, so that the card stands at its new place
 * before the process answers.
 */
export function rankFor(cards: CardSummary[], column: string, key: string, after: string | null): number {
  const others = columnCards(cards, column).filter((card) => keyOf(card.id) !== key);
  const top = (others[0]?.rank ?? 0) + 1;
  if (after === null) return top;
  const at = others.findIndex((card) => keyOf(card.id) === after);
  if (at === -1) return top;
  const anchor = others[at]!.rank;
  const under = others[at + 1]?.rank;
  return under === undefined ? anchor - 1 : (anchor + under) / 2;
}

/** The card right above a card in its column (null at the top): where it stands now. */
export function cardAbove(cards: CardSummary[], key: string): string | null | undefined {
  const card = cards.find((entry) => keyOf(entry.id) === key);
  if (!card) return undefined;
  const order = columnCards(cards, card.column);
  const at = order.findIndex((entry) => keyOf(entry.id) === key);
  return at > 0 ? keyOf(order[at - 1]!.id) : null;
}

/**
 * The colour of each card type's glyph: the "Mister Coyote" palette, one colour per type of the
 * board (a type this page does not know takes the palette's colours in turn); a note, which has
 * nothing beyond its body, stays in the ink.
 */
const TYPE_TONES: Record<string, string> = { question: "taupe", decision: "brown", task: "slate", idea: "sand", review: "khaki", note: "plain" };
const TONES = ["taupe", "sand", "khaki", "slate", "brown"];

export function toneOf(type: string, types: readonly string[] = []): string {
  const known = TYPE_TONES[type];
  if (known) return known;
  const index = types.filter((entry) => !(entry in TYPE_TONES)).indexOf(type);
  return index === -1 ? "plain" : TONES[index % TONES.length]!;
}

/** A decision's ask as its tile shows it: in full up to about `max` characters, cut at a word with "…" beyond. */
export function askLine(ask: string, max = 240): { text: string; cut: boolean } {
  const flat = ask.replace(/`/g, "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return { text: flat, cut: false };
  const room = flat.slice(0, max);
  const space = room.lastIndexOf(" ");
  return { text: `${(space > max * 0.6 ? room.slice(0, space) : room).replace(/[\s,;:—–-]+$/, "")}…`, cut: true };
}

/** The board's last column (Done), where a card's work is over. */
export function lastColumnOf(board: BoardPayload): string | undefined {
  return board.columns[board.columns.length - 1]?.id;
}

/** A decision that still waits on the person (not decided, not in Done, not archived): its tile shows when its ask is missing. */
export function waitsForDecision(card: CardSummary, board: BoardPayload): boolean {
  return card.type === "decision" && !card.decided && card.archived === undefined && card.column !== lastColumnOf(board);
}

/** A card colour's name ("red"), from the board's palette. */
export function colorNameOf(board: BoardPayload, hex: string | undefined): string | undefined {
  return hex === undefined ? undefined : (board.colors.find((color) => color.hex === hex)?.name ?? hex);
}

/** The repositories named by `repo:` tags, for the repository filter. */
export function repositoriesOf(cards: CardSummary[]): string[] {
  const names = new Set<string>();
  for (const card of cards) for (const tag of card.tags) if (tag.startsWith("repo:") && tag.length > 5) names.add(tag.slice(5));
  return [...names].sort((left, right) => left.localeCompare(right));
}

export interface TagGroup {
  name: string;
  /** True for a namespace board.json reserves (area:, by:, …). */
  reserved: boolean;
  tags: string[];
}

/**
 * The tags of the board for the tag filter, grouped: the reserved namespaces first (repo: has its
 * own filter), then the other namespaces, then the plain tags.
 */
export function tagGroups(cards: CardSummary[], reserved: string[]): TagGroup[] {
  const byGroup = new Map<string, Set<string>>();
  for (const card of cards) {
    for (const tag of card.tags) {
      const at = tag.indexOf(":");
      const space = at > 0 ? tag.slice(0, at) : "";
      if (space === "repo") continue;
      const set = byGroup.get(space) ?? new Set<string>();
      set.add(tag);
      byGroup.set(space, set);
    }
  }
  const sorted = (set: Set<string> | undefined): string[] => [...(set ?? [])].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const groups: TagGroup[] = [];
  for (const space of reserved) if (space !== "repo" && byGroup.has(space)) groups.push({ name: space, reserved: true, tags: sorted(byGroup.get(space)) });
  for (const space of [...byGroup.keys()].filter((name) => name !== "" && !reserved.includes(name)).sort()) groups.push({ name: space, reserved: false, tags: sorted(byGroup.get(space)) });
  if (byGroup.has("")) groups.push({ name: "", reserved: false, tags: sorted(byGroup.get("")) });
  return groups;
}

/** The spec's words under a column's name (6.1). */
export const COLUMN_NOTES: Record<string, string> = {
  pinned: "waits on you",
  queued: "CodeLead takes the top card",
  "in-progress": "an agent is on it",
  "for-review": "your look"
};

/** What an empty column says, so that an empty state says what to do (6.4). */
export const EMPTY_WORDS: Record<string, string> = {
  inbox: "Nothing new. Press n to write a card here.",
  backlog: "Nothing planned. Cards wait here until they start.",
  ideas: "No ideas parked yet.",
  pinned: "No card waits on you.",
  queued: "Nothing queued for CodeLead. Drag a card here and it runs next.",
  "in-progress": "No agent is on a card.",
  "for-review": "Nothing waits for your look.",
  done: "Nothing is done yet."
};

export function columnName(board: BoardPayload, id: string): string {
  return board.columns.find((column) => column.id === id)?.name ?? id;
}

export function participantName(board: BoardPayload, id: string): string {
  if (id === "unknown") return "unknown";
  return board.participants.find((participant) => participant.id === id)?.name ?? id;
}

export function isAgent(board: BoardPayload, id: string): boolean {
  return board.participants.some((participant) => participant.id === id && participant.kind === "agent");
}

export function columnLabel(column: ColumnInfo, matching: number, total: number, filtering: boolean): string {
  if (filtering) return `${matching} of ${total}`;
  return column.limit !== undefined ? `${total} / ${column.limit}` : String(total);
}

/** The words of the typed fields (spec section 5), by the names the files use. */
export const FIELD_LABELS: Record<string, string> = {
  askedBy: "Asked by",
  answer: "Answer",
  options: "Options",
  recommendation: "Recommendation",
  decided: "Decided",
  consequences: "Consequences",
  definitionOfDone: "Definition of done",
  size: "Size",
  landed: "What landed",
  hypothesis: "Hypothesis",
  worthItIf: "Worth doing if",
  toReview: "What to review",
  verdict: "Verdict"
};

/** Fields whose value is markdown of more than one line. */
export const MARKDOWN_FIELDS = new Set(["answer", "consequences", "verdict", "definitionOfDone", "toReview"]);

/** Fields whose value is a list (one item per line when edited). */
export const LIST_FIELDS = new Set(["options", "landed"]);

export const RELATION_WORDS: Record<string, string> = {
  "parent-of": "parent of",
  "child-of": "child of",
  related: "related",
  blocks: "blocks",
  "blocked-by": "blocked by",
  "duplicate-of": "duplicate of",
  "duplicated-by": "duplicated by",
  follows: "follows",
  "followed-by": "followed by"
};

// ---------------------------------------------------------------------------------------------
// Times: ages for the board ("12 min ago"), UTC clock times for threads, as the documents write them.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function ago(at: string, now: number): string {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return at;
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  const date = new Date(time);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}${date.getUTCFullYear() !== new Date(now).getUTCFullYear() ? `, ${date.getUTCFullYear()}` : ""}`;
}

/** The age a tile has room for: "now", "12 min", "3 h", "4 d", then the date. */
export function agoShort(at: string, now: number): string {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return at;
  const minutes = Math.round(Math.max(0, now - time) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} d`;
  return ago(at, now);
}

/** "22:50Z" today (UTC), "Oct 3 · 22:50Z" another day. */
export function clock(at: string, now: number): string {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return at;
  const date = new Date(time);
  const hhmm = `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}Z`;
  const today = new Date(now);
  if (date.getUTCFullYear() === today.getUTCFullYear() && date.getUTCMonth() === today.getUTCMonth() && date.getUTCDate() === today.getUTCDate()) return hhmm;
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}${date.getUTCFullYear() !== today.getUTCFullYear() ? `, ${date.getUTCFullYear()}` : ""} · ${hhmm}`;
}

/** A time to the second, UTC, as the board writes it. */
export function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function classes(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}

/** A small, stable colour for a repository tag: one of six hues, by its name. */
export function hueOf(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 6;
}
