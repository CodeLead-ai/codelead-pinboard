import fs from "node:fs";
import path from "node:path";
import { changeCard, commentWithMove, findLoaded, readItems, relationsOf, requireParticipant, writeCardChange, type BoardContext, type LoadedCard, type WriteResult } from "./board.js";
import { columnOf, readBoardConfig, workspaceOf } from "./boardConfig.js";
import { claimOn, claimRanOut, dispatchOf, leaseEnd, leaseMinutesOf, placesMeet, placesOfField, placeWords, type Dispatch, type Place, type PlaceNames } from "./claim.js";
import { BoardRefusal } from "./errors.js";
import { readEvents, type ReadEvent } from "./events.js";
import { withBoardLock } from "./files.js";
import { cardRanks } from "./order.js";
import { DONE_WHEN_FIELD, forAgents, LIMIT_MINUTES_FIELD, LIMIT_MONEY_FIELD, MAY_TOUCH_FIELD, READY_TAKEN_INTO, readyColumnOf, readyGaps, type ReadyGap } from "./ready.js";
import { isoSeconds } from "./text.js";
import type { BoardColumn, BoardConfig, BoardEvent, Card, CardData, CardId, Claim, Participant } from "./types.js";
import type { YamlValue } from "./yaml.js";

/**
 * The dispatcher: one place decides which agent gets which Ready card. Agents do not race for a card
 * and do not choose one: an agent asks "what is mine to work now?" (`takeCard`), and the board, under
 * its lock, answers with one card or with none and why. The card it gives moves to In progress with a
 * claim, a lease the agent renews while it works (`renewClaim`), gives back to Ready with a reason
 * (`releaseCard`), or that ends when the agent hands the card to For review (a move). A claim whose
 * time passed is ended at the next take, by whoever asks, and its card returns to Ready: no card is
 * stuck because an agent stopped answering.
 *
 * Which card: among the Ready cards the agent may work, first those tagged `for:<the agent>`, then
 * those with no `for:` tag, each in the page's order of the column (top first); a card tagged for
 * another agent is never given. A card is not given while it waits on a card it is `blocked-by` that
 * is not in Done, while a claimed card may touch the same files (`mayTouch`, claim.ts), or when it no
 * longer says what Ready asks (a hand edit); an agent holds at most `dispatch.perAgent` cards at a
 * time (board.json; 1). `planTake` is that decision; the take, and the read for hosts
 * (`dispatchView`), call it. Times come from the board's one clock (`ctx.now`).
 */

/** Why a card in Ready would not be given now, said once for a program and once for a person. */
export type WaitReason = "not-ready" | "blocked" | "in-use" | "for-others" | "limit";

export interface Wait {
  why: WaitReason;
  /** One short line, as the card's tile shows it: "waits on #12", "its files are in use by #7", "for Codex". */
  line: string;
  /** In a sentence, as a take's answer says it: "waits on #12 (in Backlog), which is not in Done". */
  words: string;
  /** The cards it waits on (blocked), or the claimed cards whose files it may touch too (in-use). */
  cards?: CardId[];
  /** The agents it is for (for-others, limit). */
  agents?: string[];
  /** What it does not say that Ready asks (not-ready). */
  missing?: ReadyGap[];
  /** When the reason ends by itself: the end of the claims it rests on (in-use, limit). */
  until?: string;
}

/** Why a take gives no card. */
export type NothingReason = "no-ready-column" | "no-working-column" | "empty" | "at-limit" | "for-others" | "blocked";

/** A card an agent holds now, as an answer lists it. */
export interface Held {
  card: CardId;
  title: string;
  since: string;
  until: string;
  /** Its time passed: the next take ends the claim and returns the card to Ready. */
  ranOut: boolean;
}

/** A card in Ready an answer names, with what keeps it. */
export type Waiting = { card: CardId; title: string } & Wait;

/** The decision for one agent: the card it is given, or none and why. */
export interface TakePlan {
  card?: Card;
  reason?: NothingReason;
  /** Why there is no card, in a sentence that names each card and what keeps it; empty when a card is given. */
  words: string;
  holds: Held[];
  /** The cards in Ready this agent may work that wait, and those for other agents, each with what keeps it. */
  waiting: Waiting[];
}

/** What the board read, as the decision reads it. */
interface Snapshot {
  config: BoardConfig;
  dispatch: Dispatch;
  now: number;
  names: PlaceNames;
  cards: Card[];
  /** The problems of each card's file, by id: a card with any is not given. */
  problems: Map<string, string[]>;
  ranks: Map<string, number>;
}

/** The names of the repositories a card's `mayTouch` may name: the board's, and the folders of its workspace. */
function placeNames(ctx: BoardContext, config: BoardConfig): PlaceNames {
  const repository = path.basename(ctx.root);
  let repositories: string[] = [];
  try {
    repositories = fs
      .readdirSync(workspaceOf(ctx.root, config), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== repository)
      .map((entry) => entry.name);
  } catch {
    // No workspace folder to read: only this repository is known by name.
  }
  return { repository, repositories: new Set(repositories) };
}

function snapshotOf(ctx: BoardContext, config: BoardConfig, items: LoadedCard[], events: ReadEvent[], now: number): Snapshot {
  const cards = items.flatMap((item) => (item.card ? [item.card] : []));
  return {
    config,
    dispatch: dispatchOf(config),
    now,
    names: placeNames(ctx, config),
    cards,
    problems: new Map(items.flatMap((item) => (item.card && item.problems.length > 0 ? [[String(item.card.id), item.problems] as const] : []))),
    ranks: cardRanks(events, cards)
  };
}

/**
 * The board as the next take will find it: every claim whose time passed ended, its card back at the
 * top of Ready (the take writes that first, under its lock). For the read, which writes nothing.
 */
function afterSweep(snapshot: Snapshot): Snapshot {
  const ready = readyColumnOf(snapshot.config);
  if (ready === undefined) return snapshot;
  let top = Math.max(0, ...snapshot.ranks.values());
  const ranks = new Map(snapshot.ranks);
  const cards = snapshot.cards.map((card) => {
    const claim = claimOn(card);
    if (claim === undefined || !claimRanOut(claim, snapshot.now) || snapshot.problems.has(String(card.id))) return card;
    top += 1;
    ranks.set(String(card.id), top);
    const back: Card = { ...card, column: ready.id };
    delete back.claim;
    return back;
  });
  return { ...snapshot, cards, ranks };
}

/** The column whose cards are done: Done (`done`), or the board's last column on a board without it. */
function doneColumn(config: BoardConfig): BoardColumn | undefined {
  return config.columns.find((column) => column.id === "done") ?? config.columns[config.columns.length - 1];
}

function nameOf(config: BoardConfig, id: string): string {
  return config.participants.find((participant) => participant.id.toLowerCase() === id.toLowerCase())?.name ?? id;
}

function listed(items: string[], last = "and"): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} ${last} ${items[items.length - 1]}`;
}

const SHORT_GAP: Record<string, string> = { "done-when": "how to tell it is done", "may-touch": "what it may touch", limit: "its limit" };

/** The claims held now, in the snapshot: cards in In progress with a claim. */
function claimed(snapshot: Snapshot): Array<{ card: Card; claim: Claim }> {
  return snapshot.cards.flatMap((card) => {
    const claim = claimOn(card);
    return claim ? [{ card, claim }] : [];
  });
}

/** The earliest end of some claims, as a time. */
function earliest(claims: Claim[]): string | undefined {
  return claims.map((claim) => claim.until).sort()[0];
}

/**
 * What keeps a card in Ready from being given to any agent now, whoever asks: it no longer says what
 * Ready asks (or its file has problems), it waits on a card it is blocked by, or a claimed card may
 * touch the same files. Undefined when nothing does.
 */
function cardWait(snapshot: Snapshot, card: Card, live: Array<{ card: Card; claim: Claim }>): Wait | undefined {
  const { config } = snapshot;
  const problems = snapshot.problems.get(String(card.id));
  if (problems) {
    return { why: "not-ready", line: "cannot be given: its file has problems", words: `cannot be given: its file has problems (${problems.join("; ")}); \`codelead board validate\` lists them` };
  }
  const gaps = readyGaps(card.fields);
  if (gaps.length > 0) {
    return {
      why: "not-ready",
      line: `cannot be given: it does not say ${listed(gaps.map((gap) => SHORT_GAP[gap.what] ?? gap.what))}`,
      words: `cannot be given: ${listed(gaps.map((gap) => gap.words))}`,
      missing: gaps
    };
  }
  const done = doneColumn(config);
  const blockers = relationsOf(snapshot.cards, card.id)
    .filter((relation) => relation.kind === "blocked-by")
    .flatMap((relation) => {
      const other = snapshot.cards.find((entry) => String(entry.id) === String(relation.to));
      if (other && done !== undefined && other.column === done.id) return [];
      return [{ id: relation.to, where: other ? (columnOf(config, other.column)?.name ?? other.column) : undefined }];
    })
    .filter((entry, index, all) => all.findIndex((other) => String(other.id) === String(entry.id)) === index);
  if (blockers.length > 0) {
    const ids = blockers.map((entry) => `#${String(entry.id)}`);
    return {
      why: "blocked",
      line: `waits on ${ids.join(", ")}`,
      words: `waits on ${listed(blockers.map((entry) => `#${String(entry.id)} (${entry.where === undefined ? "not on the board" : `in ${entry.where}`})`))}, not in ${done?.name ?? "Done"} yet`,
      cards: blockers.map((entry) => entry.id)
    };
  }
  const mine = placesOfField(card.fields[MAY_TOUCH_FIELD], snapshot.names);
  const meeting: Array<{ card: Card; claim: Claim; pair: [Place, Place] }> = [];
  for (const entry of live) {
    if (String(entry.card.id) === String(card.id)) continue;
    const theirs = placesOfField(entry.card.fields[MAY_TOUCH_FIELD], snapshot.names);
    let pair: [Place, Place] | undefined;
    for (const left of mine) for (const right of theirs) if (pair === undefined && placesMeet(left, right)) pair = [left, right];
    if (pair) meeting.push({ ...entry, pair });
  }
  if (meeting.length > 0) {
    const ids = meeting.map((entry) => `#${String(entry.card.id)}`);
    const until = earliest(meeting.map((entry) => entry.claim));
    return {
      why: "in-use",
      line: `its files are in use by ${ids.join(", ")}`,
      words: `its files are in use by ${listed(meeting.map((entry) => `#${String(entry.card.id)}, held by ${entry.claim.by} (${placeWords(entry.pair[0], snapshot.names)} meets ${placeWords(entry.pair[1], snapshot.names)})`))}`,
      cards: meeting.map((entry) => entry.card.id),
      ...(until ? { until } : {})
    };
  }
  return undefined;
}

/** The cards in Ready, not archived, top first. */
function readyCards(snapshot: Snapshot, ready: BoardColumn): Card[] {
  const rank = (card: Card): number => snapshot.ranks.get(String(card.id)) ?? 0;
  return snapshot.cards.filter((card) => card.column === ready.id && card.archived === undefined).sort((left, right) => rank(right) - rank(left) || String(left.id).localeCompare(String(right.id), undefined, { numeric: true }));
}

function heldOf(snapshot: Snapshot, agent: string): Held[] {
  return claimed(snapshot)
    .filter((entry) => entry.claim.by.toLowerCase() === agent.toLowerCase())
    .map((entry) => ({ card: entry.card.id, title: entry.card.title, since: entry.claim.since, until: entry.claim.until, ranOut: claimRanOut(entry.claim, snapshot.now) }));
}

/**
 * The decision: the card the board gives `agent` now, or none and why. Reads the snapshot as it is
 * (the take ends the claims whose time passed before it asks; the read asks `afterSweep`).
 */
function planTake(snapshot: Snapshot, agent: string): TakePlan {
  const { config } = snapshot;
  const holds = heldOf(snapshot, agent);
  const nothing = (reason: NothingReason, words: string, waiting: Waiting[] = []): TakePlan => ({ reason, words, holds, waiting });
  const ready = readyColumnOf(config);
  if (ready === undefined) {
    return nothing(
      "no-ready-column",
      "This board has no Ready column, so no card is given: Ready is where the person puts a card an agent may pick up by itself. `codelead board add-ready` gives the board its Ready column."
    );
  }
  const working = columnOf(config, READY_TAKEN_INTO);
  if (working === undefined || working.id !== READY_TAKEN_INTO) {
    return nothing("no-working-column", `This board has no In progress column ("${READY_TAKEN_INTO}"), so no card is given from ${ready.name}: a card given to an agent is held for it there.`);
  }
  const cards = readyCards(snapshot, ready);
  const live = claimed(snapshot);
  const me = agent.toLowerCase();
  const meant = (card: Card): string[] => forAgents(card.tags);
  const others: Waiting[] = cards
    .filter((card) => meant(card).length > 0 && !meant(card).includes(me))
    .map((card) => ({ card: card.id, title: card.title, why: "for-others", line: `for ${listed(meant(card).map((id) => nameOf(config, id)), "or")}`, words: `for ${listed(meant(card), "or")}`, agents: meant(card) }));
  const otherWords = others.length > 0 ? ` (${listed(others.map((entry) => `#${String(entry.card)} is ${entry.words}`))}.)` : "";
  if (holds.length >= snapshot.dispatch.perAgent) {
    const one = holds.length === 1 ? "it" : "one";
    return nothing(
      "at-limit",
      `Nothing for ${agent}: it holds ${listed(holds.map((entry) => `#${String(entry.card)} (until ${entry.until})`))} already, and an agent holds at most ${snapshot.dispatch.perAgent} card${snapshot.dispatch.perAgent === 1 ? "" : "s"} at a time on this board (dispatch.perAgent in board.json). Hand ${one} to For review, or give ${one} back, then ask again.`
    );
  }
  if (cards.length === 0) return nothing("empty", `Nothing for ${agent}: ${ready.name} is empty. The person puts a card there when an agent may pick it up by itself.`);
  // Its own cards first, then the cards for any agent; each group in the column's order, top first.
  const mineFirst = [...cards.filter((card) => meant(card).includes(me)), ...cards.filter((card) => meant(card).length === 0)];
  if (mineFirst.length === 0) return nothing("for-others", `Nothing for ${agent}: every card in ${ready.name} is for another agent: ${listed(others.map((entry) => `#${String(entry.card)} ${entry.words}`))}.`, others);
  const waiting: Waiting[] = [];
  for (const card of mineFirst) {
    const wait = cardWait(snapshot, card, live);
    if (wait === undefined) return { card, words: "", holds, waiting };
    waiting.push({ card: card.id, title: card.title, ...wait });
  }
  return nothing("blocked", `Nothing for ${agent}: each card in ${ready.name} it may work waits: ${waiting.map((entry) => `#${String(entry.card)} ${entry.words}`).join("; ")}.${otherWords}`, [...waiting, ...others]);
}

// ---------------------------------------------------------------------------------------------
// Taking a card

/** A claim the take ended because its time had passed, and the card it returned to Ready. */
export interface Swept {
  card: CardId;
  title: string;
  holder: string;
  until: string;
}

/** What a take gives: the card with what it says it may do, where its file is, and the claim. */
export interface GivenCard {
  id: CardId;
  title: string;
  type: string;
  definitionOfDone?: YamlValue;
  mayTouch?: YamlValue;
  limitMinutes?: YamlValue;
  limitMoney?: YamlValue;
  /** The card's file, relative to the board folder (`items/0003-….md`). */
  file: string;
  /** The card's file, relative to the repository (`docs/codelead/board/items/0003-….md`). */
  path: string;
}

export type TakeResult =
  | { given: true; card: GivenCard; claim: Claim; minutes: number; events: BoardEvent[]; swept: Swept[] }
  | { given: false; reason: NothingReason; message: string; holds: Held[]; waiting: Waiting[]; swept: Swept[] };

function givenCard(ctx: BoardContext, card: CardData & { file: string }): GivenCard {
  const field = (name: string): Record<string, YamlValue> => (card.fields[name] !== undefined ? { [name]: card.fields[name]! } : {});
  return {
    id: card.id,
    title: card.title,
    type: card.type,
    ...field(DONE_WHEN_FIELD),
    ...field(MAY_TOUCH_FIELD),
    ...field(LIMIT_MINUTES_FIELD),
    ...field(LIMIT_MONEY_FIELD),
    file: card.file,
    path: path.relative(ctx.root, path.join(ctx.dir, card.file)).split(path.sep).join("/")
  };
}

/**
 * Ends every claim whose time passed: its card goes back to Ready (at the top), with the move and a
 * `claim.expired` that says whose claim ran out and when, written by the participant whose take swept
 * it. Under the board's lock.
 */
function sweep(ctx: BoardContext, ready: BoardColumn, by: string, at: string, now: number): Swept[] {
  const swept: Swept[] = [];
  for (const loaded of readItems(ctx)) {
    const card = loaded.card;
    if (card === undefined || loaded.problems.length > 0) continue;
    const claim = claimOn(card);
    if (claim === undefined || !claimRanOut(claim, now)) continue;
    const next: CardData = { ...card, column: ready.id };
    delete next.claim;
    writeCardChange(ctx, loaded, at, {
      next,
      events: [
        { at, by, item: card.id, kind: "item.moved", data: { from: card.column, to: ready.id, withClaim: true } },
        { at, by, item: card.id, kind: "claim.expired", data: { holder: claim.by, since: claim.since, until: claim.until } }
      ]
    });
    swept.push({ card: card.id, title: card.title, holder: claim.by, until: claim.until });
  }
  return swept;
}

/**
 * An agent asks for its card: under the board's lock, the claims whose time passed are ended (their
 * cards back to Ready), then the board picks the next Ready card this agent may work (`planTake`),
 * checks it again against what Ready asks, moves it to In progress and records the claim, for the
 * board's lease or `leaseMinutes` (up to the board's longest). No card: the answer says why. Only an
 * agent asks; a person moves cards.
 */
export function takeCard(ctx: BoardContext, input: { as: string; leaseMinutes?: number }): TakeResult {
  return withBoardLock(ctx.dir, () => {
    const { config } = readBoardConfig(ctx.dir);
    const participant = requireParticipant(config, input.as);
    if (participant.kind !== "agent") {
      throw new BoardRefusal("claim", `Refused: ${participant.id} is a person; a take is how an agent asks the board for its card from Ready. Move the card yourself: you move any card anywhere. Nothing was written.`);
    }
    const minutes = leaseMinutesOf(dispatchOf(config), input.leaseMinutes);
    const at = isoSeconds(ctx.now());
    const now = Date.parse(at);
    const ready = readyColumnOf(config);
    const swept = ready !== undefined && columnOf(config, READY_TAKEN_INTO)?.id === READY_TAKEN_INTO ? sweep(ctx, ready, participant.id, at, now) : [];
    const items = readItems(ctx);
    const plan = planTake(snapshotOf(ctx, config, items, readEvents(ctx.dir).events, now), participant.id);
    if (plan.card === undefined) return { given: false, reason: plan.reason!, message: plan.words, holds: plan.holds, waiting: plan.waiting, swept };
    const loaded = findLoaded(items, plan.card.id);
    const card = loaded.card!;
    // The card is checked again, as it is in its file now, before it is given.
    const gaps = readyGaps(card.fields);
    if (gaps.length > 0 || card.column !== ready!.id) throw new BoardRefusal("invalid", `Refused: card #${String(card.id)} changed while it was given; nothing was written. Ask again.`);
    const claim: Claim = { by: participant.id, since: at, until: leaseEnd(now, minutes) };
    const write = writeCardChange(ctx, loaded, at, {
      next: { ...card, column: READY_TAKEN_INTO, claim },
      events: [
        { at, by: participant.id, item: card.id, kind: "item.moved", data: { from: ready!.id, to: READY_TAKEN_INTO, withClaim: true } },
        { at, by: participant.id, item: card.id, kind: "claim.taken", data: { until: claim.until, minutes } }
      ]
    });
    return { given: true, card: givenCard(ctx, write.card), claim, minutes, events: write.events, swept };
  });
}

// ---------------------------------------------------------------------------------------------
// Renewing and giving back

/** The claim of a card the participant holds; refused, in words, for a person, for a card no one holds, and for another agent's. */
function requireHolder(card: Card, participant: Participant, config: BoardConfig, verb: "renew" | "give back"): Claim {
  const id = String(card.id);
  if (participant.kind !== "agent") {
    throw new BoardRefusal(
      "claim",
      `Refused: ${participant.id} is a person; only the agent that holds a card ${verb === "renew" ? "renews its claim" : "gives it back"}. Move the card yourself: a move of yours ends its claim. Nothing was written.`
    );
  }
  const claim = claimOn(card);
  if (claim === undefined) {
    const where = columnOf(config, card.column)?.name ?? card.column;
    const ready = readyColumnOf(config);
    const back =
      ready !== undefined && card.column === ready.id
        ? ` A claim that is not renewed runs out, and the next take returns its card to ${ready.name}: ask the board for a card again with \`codelead board take --as ${participant.id}\`.`
        : "";
    throw new BoardRefusal("claim", `Refused: card #${id} is held by no one (it is in ${where}${card.archived !== undefined ? ", archived" : ""}).${back} Nothing was written.`);
  }
  if (claim.by !== participant.id) {
    throw new BoardRefusal("claim", `Refused: card #${id} is held by ${claim.by}, not by ${participant.id}; only the agent that holds a card renews it or gives it back. Nothing was written.`);
  }
  return claim;
}

export interface RenewResult extends WriteResult {
  claim: Claim;
  minutes: number;
}

/**
 * The agent that holds a card extends its claim while it works: it now runs until `leaseMinutes`
 * (the board's lease when not given, up to its longest) from now. Only the holder; only while the card
 * is in In progress and its claim was not ended (a claim whose time passed may still be renewed until
 * the next take ends it).
 */
export function renewClaim(ctx: BoardContext, id: CardId, input: { as: string; leaseMinutes?: number }): RenewResult {
  let renewed: { claim: Claim; minutes: number } | undefined;
  const result = changeCard(ctx, id, input.as, undefined, (card, config, participant, at) => {
    const claim = requireHolder(card, participant, config, "renew");
    const minutes = leaseMinutesOf(dispatchOf(config), input.leaseMinutes);
    const next: Claim = { ...claim, until: leaseEnd(Date.parse(at), minutes) };
    renewed = { claim: next, minutes };
    return { next: { ...card, claim: next }, events: [{ at, by: participant.id, item: card.id, kind: "claim.renewed", data: { until: next.until, minutes } }] };
  });
  return { ...result, ...renewed! };
}

/**
 * The agent that holds a card gives it back: the card returns to Ready (at the top), with the reason
 * as a comment in its thread, the move, and a `claim.released`. This restores the person's own ask; it
 * is no new one. Only the holder (the person moves the card instead).
 */
export function releaseCard(ctx: BoardContext, id: CardId, input: { as: string; reason: string; rewriteHomePaths?: boolean }): WriteResult {
  return changeCard(ctx, id, input.as, undefined, (card, config, participant, at) => {
    const claim = requireHolder(card, participant, config, "give back");
    const ready = readyColumnOf(config);
    if (ready === undefined) throw new BoardRefusal("claim", `Refused: card #${String(card.id)} cannot go back to Ready: the board has no Ready column now. Hand it to For review, or ask the person in the thread. Nothing was written.`);
    if (input.reason.trim() === "") throw new BoardRefusal("usage", "Refused: a card is given back with the reason why (the person reads it in the card's thread); nothing was written.");
    const written = commentWithMove(ctx, config, participant.id, card.id, at, input.reason, input.rewriteHomePaths);
    const next: CardData = { ...card, column: ready.id };
    delete next.claim;
    return {
      next,
      comment: written.comment,
      events: [
        written.event,
        { at, by: participant.id, item: card.id, kind: "item.moved", data: { from: card.column, to: ready.id, withComment: true, withClaim: true } },
        { at, by: participant.id, item: card.id, kind: "claim.released", data: { since: claim.since, until: claim.until } }
      ]
    };
  });
}

// ---------------------------------------------------------------------------------------------
// The read for hosts

export interface AgentDispatch {
  id: string;
  name: string;
  /** The cards it holds now (a claim whose time passed included, flagged). */
  holds: Held[];
  /** The card it would be given if it asked now. */
  next?: { card: CardId; title: string };
  /** Why it would be given none, when it would not. */
  nothing?: { reason: NothingReason; words: string; waiting: Waiting[] };
}

export interface DispatchView {
  /** The time the answer is for. */
  at: string;
  /** The Ready column's id; absent on a board without it. */
  ready?: string;
  settings: Dispatch;
  agents: AgentDispatch[];
  /** Each card in Ready, top first, with what keeps it from being given now, when anything does. */
  cards: Array<{ card: CardId; title: string; for: string[]; wait?: Wait }>;
}

/**
 * What keeps each card in Ready from being given now, whoever asks (the line its tile shows): what
 * `cardWait` says, else that it is for agents who hold their limit, or for another agent, or that
 * every agent holds its limit. As the next take will find the board (`afterSweep`).
 */
function waitsOf(snapshot: Snapshot): Map<string, Wait> {
  const waits = new Map<string, Wait>();
  const ready = readyColumnOf(snapshot.config);
  if (ready === undefined) return waits;
  const { config } = snapshot;
  const live = claimed(snapshot);
  const agents = config.participants.filter((participant) => participant.kind === "agent");
  const full = (id: string): boolean => live.filter((entry) => entry.claim.by.toLowerCase() === id.toLowerCase()).length >= snapshot.dispatch.perAgent;
  const endOf = (ids: string[]): Record<string, string> => {
    const until = earliest(live.filter((entry) => ids.some((id) => id.toLowerCase() === entry.claim.by.toLowerCase())).map((entry) => entry.claim));
    return until ? { until } : {};
  };
  for (const card of readyCards(snapshot, ready)) {
    const wait = cardWait(snapshot, card, live);
    if (wait) {
      waits.set(String(card.id), wait);
      continue;
    }
    const meant = forAgents(card.tags);
    const names = listed(meant.map((id) => nameOf(config, id)), "or");
    if (meant.length > 0) {
      const holding = meant.every(full);
      waits.set(String(card.id), {
        why: holding ? "limit" : "for-others",
        line: holding ? `for ${names}, who ${meant.length === 1 ? "holds its" : "hold their"} limit` : `for ${names}`,
        words: holding ? `for ${listed(meant, "or")}, who ${meant.length === 1 ? "holds its" : "hold their"} limit of cards` : `for ${listed(meant, "or")}`,
        agents: meant,
        ...(holding ? endOf(meant) : {})
      });
    } else if (agents.length > 0 && agents.every((agent) => full(agent.id))) {
      waits.set(String(card.id), { why: "limit", line: "every agent holds its limit", words: "every agent holds its limit of cards", agents: [], ...endOf(agents.map((agent) => agent.id)) });
    }
  }
  return waits;
}

/** Reads the board as the dispatcher does, without the lock and without writing: the read for hosts and the page. */
function readSnapshot(ctx: BoardContext): Snapshot {
  const { config } = readBoardConfig(ctx.dir);
  return snapshotOf(ctx, config, readItems(ctx), readEvents(ctx.dir).events, ctx.now().getTime());
}

/**
 * For the whole board: what each agent holds, and what each would be given if it asked now (or why
 * not), with what keeps each card in Ready; as the next take will decide it, the claims whose time
 * passed ended. Writes nothing and starts nothing: a host's panel, or its dispatcher loop, reads it.
 */
export function dispatchView(ctx: BoardContext): DispatchView {
  const read = readSnapshot(ctx);
  const next = afterSweep(read);
  const ready = readyColumnOf(read.config);
  const agents = read.config.participants
    .filter((participant) => participant.kind === "agent")
    .map((participant): AgentDispatch => {
      const plan = planTake(next, participant.id);
      return {
        id: participant.id,
        name: participant.name,
        holds: heldOf(read, participant.id),
        ...(plan.card ? { next: { card: plan.card.id, title: plan.card.title } } : { nothing: { reason: plan.reason!, words: plan.words, waiting: plan.waiting } })
      };
    });
  const waits = waitsOf(next);
  return {
    at: isoSeconds(new Date(read.now)),
    ...(ready ? { ready: ready.id } : {}),
    settings: read.dispatch,
    agents,
    cards: ready ? readyCards(next, ready).map((card) => ({ card: card.id, title: card.title, for: forAgents(card.tags), ...(waits.has(String(card.id)) ? { wait: waits.get(String(card.id))! } : {}) })) : []
  };
}

/** What keeps each card in Ready from being given now, by id (the page's line on each tile). */
export function readyWaits(ctx: BoardContext, view?: { config: BoardConfig; items: LoadedCard[]; events: ReadEvent[] }): Map<string, Wait> {
  const read = view ? snapshotOf(ctx, view.config, view.items, view.events, ctx.now().getTime()) : readSnapshot(ctx);
  return waitsOf(afterSweep(read));
}
