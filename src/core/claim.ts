import path from "node:path";
import { BoardRefusal } from "./errors.js";
import { READY_TAKEN_INTO } from "./ready.js";
import { timeOf } from "./text.js";
import type { BoardColumn, BoardConfig, CardData, Claim, DispatchSettings, Participant } from "./types.js";
import type { YamlValue } from "./yaml.js";

/**
 * Claims (the rules dispatch.ts gives cards by, and the ones every write keeps): a card the board
 * gave an agent from Ready carries a claim, `{ by, since, until }`, while it is in In progress. The
 * claim is a lease: the agent renews it while it works; the next take ends a claim whose time passed
 * and returns its card to Ready. While a card is claimed, the agent that holds it hands it to For
 * review or gives it back; no other agent moves it or changes what it says it may do; the person's
 * moves always win, and end the claim.
 */

/** How many cards an agent holds at a time when board.json says nothing (`dispatch.perAgent`). */
export const DEFAULT_PER_AGENT = 1;
/** How long a claim lasts before it is renewed, in minutes, when board.json says nothing (`dispatch.leaseMinutes`). */
export const DEFAULT_LEASE_MINUTES = 30;
/** The longest lease a take or a renewal may ask for, in minutes, when board.json says nothing (`dispatch.maxLeaseMinutes`). */
export const DEFAULT_MAX_LEASE_MINUTES = 240;

/** board.json's `dispatch`, each key with its value or its default. */
export interface Dispatch {
  perAgent: number;
  leaseMinutes: number;
  maxLeaseMinutes: number;
}

export function dispatchOf(config: Pick<BoardConfig, "dispatch">): Dispatch {
  const given: DispatchSettings = config.dispatch ?? {};
  const leaseMinutes = typeof given.leaseMinutes === "number" ? given.leaseMinutes : DEFAULT_LEASE_MINUTES;
  return {
    perAgent: typeof given.perAgent === "number" ? given.perAgent : DEFAULT_PER_AGENT,
    leaseMinutes,
    maxLeaseMinutes: typeof given.maxLeaseMinutes === "number" ? given.maxLeaseMinutes : Math.max(DEFAULT_MAX_LEASE_MINUTES, leaseMinutes)
  };
}

/** What is wrong with board.json's `dispatch`, in plain words (boardConfigProblems); empty when nothing is. */
export function dispatchProblems(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ['"dispatch" must be { "perAgent": <cards>, "leaseMinutes": <minutes>, "maxLeaseMinutes": <minutes> }, each optional'];
  const given = value as Record<string, unknown>;
  const problems: string[] = [];
  if (given.perAgent !== undefined && !(typeof given.perAgent === "number" && Number.isSafeInteger(given.perAgent) && given.perAgent >= 1)) {
    problems.push('"dispatch.perAgent" must be a whole number of 1 or more: how many cards an agent holds at a time');
  }
  for (const key of ["leaseMinutes", "maxLeaseMinutes"]) {
    const minutes = given[key];
    if (minutes !== undefined && !(typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0)) problems.push(`"dispatch.${key}" must be a number of minutes above 0`);
  }
  if (typeof given.leaseMinutes === "number" && typeof given.maxLeaseMinutes === "number" && given.maxLeaseMinutes < given.leaseMinutes) {
    problems.push('"dispatch.maxLeaseMinutes" must be at least "dispatch.leaseMinutes"');
  }
  return problems;
}

/**
 * The minutes a take or a renewal holds the card for: the board's lease when none is asked for, or
 * the one asked for, from above 0 to the board's longest; refused, in words, beyond it.
 */
export function leaseMinutesOf(dispatch: Dispatch, asked: number | undefined): number {
  if (asked === undefined) return dispatch.leaseMinutes;
  if (!Number.isFinite(asked) || asked <= 0) throw new BoardRefusal("usage", `Refused: a lease is a number of minutes above 0; ${String(asked)} is not one. Nothing was written.`);
  if (asked > dispatch.maxLeaseMinutes) {
    throw new BoardRefusal("claim", `Refused: a lease on this board is at most ${dispatch.maxLeaseMinutes} minutes (dispatch.maxLeaseMinutes in board.json); ${asked} is more. Ask for less, and renew it while you work. Nothing was written.`);
  }
  return asked;
}

/** When a lease of `minutes` that starts at `from` (ms) runs out, as the board writes times. */
export function leaseEnd(from: number, minutes: number): string {
  return new Date(from + Math.round(minutes * 60_000)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The claim a card carries while it is claimed: in In progress, not archived, with a claim; undefined otherwise. */
export function claimOn(card: Pick<CardData, "claim" | "column" | "archived">): Claim | undefined {
  return card.claim !== undefined && card.column === READY_TAKEN_INTO && card.archived === undefined ? card.claim : undefined;
}

/** True when a claim's time has passed at `now` (ms): the next take ends it. */
export function claimRanOut(claim: Pick<Claim, "until">, now: number): boolean {
  return (timeOf(claim.until) ?? 0) <= now;
}

/** "a", "a and b", "a, b and c". */
function listed(items: string[], last = "and"): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} ${last} ${items[items.length - 1]}`;
}

// ---------------------------------------------------------------------------------------------
// The places a card may touch, and when two of them meet

/**
 * One place a card's `mayTouch` names, as the board compares it: a repository (by its folder's name,
 * in lower case) and a path in it (`""` for the whole repository), in lower case, with "/".
 */
export interface Place {
  repository: string;
  path: string;
}

/** The repository the board is in, and the names of the other repositories of the workspace, as places name them. */
export interface PlaceNames {
  repository: string;
  repositories: ReadonlySet<string>;
}

/** A path as the board compares it: "/" for "\", no "./", no "." or ".." it can resolve, no "/" at either end, cut before a wildcard. */
function cleanPath(text: string): string {
  const posix = path.posix.normalize(text.replace(/\\/g, "/")).replace(/^(\.\/)+/, "");
  const segments: string[] = [];
  for (const segment of posix.split("/")) {
    if (/[*?[\]{}]/.test(segment)) break;
    if (segment !== "" && segment !== ".") segments.push(segment);
  }
  return segments.join("/").toLowerCase();
}

/**
 * The places one entry of `mayTouch` names: `<repository>:<path>` a path in another repository of
 * the workspace (`<repository>:` all of it); a word that is the name of this repository or of another
 * one of the workspace, all of that repository (and, for another's name, a folder of that name here
 * too, since the word may mean either); `../<repository>/<path>`, a path there; any other path, a path
 * in this repository. An entry that is no path (it holds a space: "the api code") is all of this
 * repository: what a card may touch is read in the way that keeps two cards apart, never together.
 */
export function placesOf(entry: string, names: PlaceNames): Place[] {
  const text = entry.trim().replace(/^[`'"]+|[`'"]+$/g, "");
  const here = names.repository.toLowerCase();
  if (text === "" || /\s/.test(text)) return [{ repository: here, path: "" }];
  const cited = /^([A-Za-z0-9][A-Za-z0-9._-]*):(?![\\/])(.*)$/.exec(text);
  if (cited && cited[1]!.length > 1) return [{ repository: cited[1]!.toLowerCase(), path: cleanPath(cited[2]!) }];
  const relative = path.posix.normalize(text.replace(/\\/g, "/"));
  const up = /^\.\.\/([^/]+)(?:\/(.*))?$/.exec(relative);
  if (up) return [{ repository: up[1]!.toLowerCase(), path: cleanPath(up[2] ?? "") }];
  const word = text.replace(/\/+$/, "");
  if (!word.includes("/")) {
    const lower = word.toLowerCase();
    if (lower === here) return [{ repository: here, path: "" }];
    if ([...names.repositories].some((name) => name.toLowerCase() === lower)) return [{ repository: lower, path: "" }, { repository: here, path: cleanPath(word) }];
  }
  return [{ repository: here, path: cleanPath(text) }];
}

/** The places a card's `mayTouch` names (a text, or a list of texts). */
export function placesOfField(value: YamlValue | undefined, names: PlaceNames): Place[] {
  const entries = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return entries.flatMap((entry) => placesOf(entry, names));
}

/** True when two places meet: the same repository, and the same path, or one inside the other (all of a repository holds every path in it). */
export function placesMeet(left: Place, right: Place): boolean {
  if (left.repository !== right.repository) return false;
  if (left.path === "" || right.path === "" || left.path === right.path) return true;
  return left.path.startsWith(`${right.path}/`) || right.path.startsWith(`${left.path}/`);
}

/** A place as a person reads it: `src/auth`, `api:` for all of another repository, `the whole repository` for all of this one. */
export function placeWords(place: Place, names: PlaceNames): string {
  if (place.repository === names.repository.toLowerCase()) return place.path === "" ? "the whole repository" : place.path;
  return `${place.repository}:${place.path}`;
}

// ---------------------------------------------------------------------------------------------
// The rules every write keeps for a claimed card

/** "card #3 is held by claude (until 10:30:00Z)". */
function heldWords(card: Pick<CardData, "id">, claim: Claim): string {
  return `card #${String(card.id)} is held by ${claim.by} (its claim runs until ${claim.until})`;
}

/**
 * A move of a claimed card: the person moves it anywhere (and the move ends the claim); the agent that
 * holds it hands it to For review (the claim ends there), or moves it inside In progress; no other
 * agent moves it. Refused in words that say what the participant may do instead.
 */
export function requireMayMoveClaimed(participant: Participant, card: Pick<CardData, "id">, claim: Claim, from: string, to: BoardColumn, review: BoardColumn | undefined): void {
  if (participant.kind === "person") return;
  const id = String(card.id);
  if (participant.id !== claim.by) {
    throw new BoardRefusal("claim", `Refused: ${heldWords(card, claim)}; ${participant.id} may comment on it, not move it. Nothing was written.`);
  }
  if (to.id === from || (review !== undefined && to.id === review.id)) return;
  throw new BoardRefusal(
    "claim",
    `Refused: ${heldWords(card, claim)}: hand it to ${review?.name ?? "the review column"} when the work is done, or give it back to Ready with \`codelead board release ${id} --as ${claim.by} --reason "…"\`; not into ${to.name}. Nothing was written.`
  );
}

/** The person's word on which agent a card is for: an agent adds or removes no `for:` tag on a card in Ready or claimed. */
export function refuseAgentForTags(participant: Participant, card: Pick<CardData, "id">, tags: readonly string[], where: { ready?: BoardColumn; claim?: Claim }): void {
  if (participant.kind !== "agent") return;
  const named = tags.filter((tag) => /^for:/i.test(tag.trim()));
  if (named.length === 0 || (where.ready === undefined && where.claim === undefined)) return;
  const place = where.claim ? `while ${where.claim.by} holds it` : `while it is in ${where.ready!.name}`;
  throw new BoardRefusal(
    "not-allowed",
    `Refused: ${participant.id} is an agent and may not add or remove a for: tag (${named.join(", ")}) on card #${String(card.id)} ${place}: the person says which agent a card is for; ask in the thread. Nothing was written.`
  );
}

/** While a card is claimed, what it says it may do is the person's ask still: no agent changes it (the holder included). */
export function refuseAgentClaimedFields(participant: Participant, card: Pick<CardData, "id">, claim: Claim, changed: string[]): void {
  if (participant.kind !== "agent" || changed.length === 0) return;
  throw new BoardRefusal(
    "not-allowed",
    `Refused: ${participant.id} is an agent and may not change what card #${String(card.id)} says it may do (${changed.join(", ")}) while ${claim.by} holds it: that is the person's ask; ask in the thread. Nothing was written.`
  );
}

/**
 * What `validate` says of a card's claim: problems (a claim on a card not in In progress, or by no
 * agent of the board) and, given the time, a note (its time passed: not a problem, the next take ends it).
 */
export function claimFindings(card: Pick<CardData, "claim" | "column" | "archived">, config: Pick<BoardConfig, "columns" | "participants">, now?: number): { problems: string[]; notes: string[] } {
  const claim = card.claim;
  if (claim === undefined) return { problems: [], notes: [] };
  const problems: string[] = [];
  const notes: string[] = [];
  const working = config.columns.find((column) => column.id === READY_TAKEN_INTO)?.name ?? READY_TAKEN_INTO;
  if (card.column !== READY_TAKEN_INTO) problems.push(`the card has a claim (by ${claim.by}) and is not in ${working}: a claim lives only there; remove the key "claim"`);
  else if (card.archived !== undefined) problems.push(`the card has a claim (by ${claim.by}) and is archived; remove the key "claim"`);
  const holder = config.participants.find((participant) => participant.id === claim.by);
  if (!holder) problems.push(`the claim is by "${claim.by}", who is not a participant of the board (${listed(config.participants.map((participant) => participant.id))})`);
  else if (holder.kind !== "agent") problems.push(`the claim is by ${claim.by}, a person: a claim is an agent's`);
  if (problems.length === 0 && now !== undefined && claimRanOut(claim, now)) notes.push(`the claim of ${claim.by} ran out at ${claim.until}; the next take returns the card to Ready`);
  return { problems, notes };
}
