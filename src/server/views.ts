import {
  agentColumns,
  ASK_FIELD,
  BoardRefusal,
  CARD_COLORS,
  cardRanks,
  DECIDED_FIELD,
  describeEvent,
  eventLines,
  excerpt,
  getCard,
  intervalMinutes,
  readBoard,
  readDecision,
  readEvents,
  relationsOf,
  RELATION_KINDS,
  TYPE_FIELDS,
  UNKNOWN_PARTICIPANT,
  type BoardConfig,
  type BoardContext,
  type BoardEvent,
  type Card,
  type CardId,
  type CheckResult,
  type Participant,
  type ReadEvent,
  type YamlValue
} from "../core/index.js";
import type { BoardPayload, CardDetail, CardSummary, EditorInfo, EventItem, NotificationGroup, NotificationsPayload, ParticipantInfo } from "./contract.js";
import { attachmentLine, mentionsIn } from "./editor.js";

/**
 * What the page is shown, built from the core's reads: the board with a tile per card, one card
 * with its relations both ways and its links, the notifications. Nothing here writes.
 */

/** The column whose cards an agent works on: a gear on a card there means an agent reported working on it. */
export const WORKING_COLUMN = "in-progress";

/** How many events the notification list shows at most (spec 6.3); older ones are in the card's activity. */
export const NOTIFICATIONS_SHOWN = 50;

/** The person the page writes as: board.json's first person. */
export function personOf(config: BoardConfig): Participant {
  const person = config.participants.find((participant) => participant.kind === "person");
  if (!person) {
    throw new BoardRefusal(
      "participant",
      'Refused: the board has no person among its participants, and the page writes as the board\'s person. Add one to board.json\'s participants, as { "id": "alex", "kind": "person", "name": "Alex" }.'
    );
  }
  return person;
}

function info(participant: Participant): ParticipantInfo {
  return { id: participant.id, kind: participant.kind, name: participant.name };
}

export function nameOf(config: BoardConfig, id: string): string {
  if (id === UNKNOWN_PARTICIPANT) return "unknown";
  return config.participants.find((participant) => participant.id === id)?.name ?? id;
}

export function eventItem(event: BoardEvent, config: BoardConfig, position?: number): EventItem {
  return {
    ...(position !== undefined ? { position } : {}),
    at: event.at,
    by: event.by,
    byName: nameOf(config, event.by),
    ...(event.item !== undefined ? { item: event.item } : {}),
    kind: event.kind,
    text: describeEvent(event, config),
    ...(event.data !== undefined ? { data: event.data } : {})
  };
}

/** The log's events by the card they name, each card's in order. */
export function eventsByCard(events: ReadEvent[]): Map<string, ReadEvent[]> {
  const byCard = new Map<string, ReadEvent[]>();
  for (const entry of events) {
    if (entry.event.item === undefined) continue;
    const key = String(entry.event.item);
    const list = byCard.get(key);
    if (list) list.push(entry);
    else byCard.set(key, [entry]);
  }
  return byCard;
}

/** A decision's ask, when the card has one written: what the tile shows under the title. */
function askOf(card: Card): string | undefined {
  const ask = card.fields[ASK_FIELD];
  return typeof ask === "string" && ask.trim() !== "" ? ask.trim() : undefined;
}

/**
 * A card's tile: its words, its last comment, the three marks of spec 6.1 and 6.4, its colour, a
 * decision's ask and what was decided, and its place in its column (`rank`, from `cardRanks` over
 * the whole log; 0 when not given).
 */
export function summarize(card: Card, config: BoardConfig, person: Participant, events: ReadEvent[], rank = 0): CardSummary {
  const kinds = new Map(config.participants.map((participant) => [participant.id, participant.kind]));
  const isAgent = (id: string): boolean => kinds.get(id) === "agent";
  const isPerson = (id: string): boolean => kinds.get(id) === "person";
  const last = card.thread[card.thread.length - 1];
  const outcome = readDecision(card.fields[DECIDED_FIELD]);

  // An agent's proposal keeps its dashed border until a person touches the card.
  const proposed = isAgent(card.author) || card.tags.some((tag) => tag.startsWith("by:") && isAgent(tag.slice(3)));
  const touched = events.some(({ event }) => isPerson(event.by)) || card.thread.some((comment) => isPerson(comment.author));

  // The gear: an agent wrote on the card since it last entered the working column.
  let working: CardSummary["working"];
  if (card.column === WORKING_COLUMN) {
    let from = 0;
    events.forEach(({ event }, index) => {
      if (event.kind === "item.moved" && (event.data as { to?: unknown } | undefined)?.to === WORKING_COLUMN) from = index;
    });
    for (const { event } of events.slice(from)) if (isAgent(event.by)) working = { by: event.by, at: event.at };
  }

  return {
    id: card.id,
    type: card.type,
    title: card.title,
    column: card.column,
    tags: card.tags,
    author: card.author,
    created: card.created,
    updated: card.updated,
    ...(card.status !== undefined ? { status: card.status } : {}),
    ...(card.archived !== undefined ? { archived: card.archived } : {}),
    ...(card.color !== undefined ? { color: card.color } : {}),
    ...(askOf(card) !== undefined ? { ask: askOf(card)! } : {}),
    ...(card.fields.decided !== undefined && card.fields.decided !== null && card.fields.decided !== "" ? { decided: true } : {}),
    ...(outcome ? { outcome } : {}),
    rank,
    description: card.description,
    comments: card.thread.length,
    ...(last ? { last: { author: last.author, at: last.at, excerpt: excerpt(last.body, 140) } } : {}),
    waitsOnYou: last !== undefined && last.author !== person.id,
    proposal: proposed && !touched,
    ...(working ? { working } : {}),
    relations: card.relations.length,
    attachments: card.attachments.length,
    file: card.file,
    hash: card.hash
  };
}

/** One card's tile, read from the files as they are now. */
export function summaryOf(ctx: BoardContext, id: CardId): CardSummary {
  const { card } = getCard(ctx, id);
  const view = readBoard(ctx);
  const person = personOf(view.config);
  const { events } = readEvents(ctx.dir);
  const mine = events.filter(({ event }) => event.item !== undefined && String(event.item) === String(card.id));
  return summarize(card, view.config, person, mine, cardRanks(events, view.cards).get(String(card.id)) ?? 0);
}

export function boardPayload(ctx: BoardContext, editor: EditorInfo): BoardPayload {
  const view = readBoard(ctx);
  const { config } = view;
  const person = personOf(config);
  const { events, count } = readEvents(ctx.dir);
  const byCard = eventsByCard(events);
  const ranks = cardRanks(events, view.cards);
  const agentMay = new Set(agentColumns(config).map((column) => column.id));
  return {
    name: config.name,
    person: info(person),
    participants: config.participants.map(info),
    columns: config.columns.map((column) => ({
      id: column.id,
      name: column.name,
      ...(column.owner === "person" ? { owner: "person" as const } : {}),
      ...(typeof column.limit === "number" ? { limit: column.limit } : {}),
      agentsMay: agentMay.has(column.id)
    })),
    types: [...config.types],
    typeFields: Object.fromEntries(config.types.map((type) => [type, TYPE_FIELDS[type] ?? []])),
    colors: CARD_COLORS.map((color) => ({ hex: color.hex, name: color.name })),
    relationKinds: [...RELATION_KINDS],
    tagNamespaces: [...(config.tagNamespaces ?? [])],
    cards: view.cards.map((card) => summarize(card, config, person, byCard.get(String(card.id)) ?? [], ranks.get(String(card.id)) ?? 0)),
    unreadable: view.unreadable,
    lines: count,
    editor,
    checkMinutes: intervalMinutes(config)
  };
}

function fieldTexts(value: YamlValue | undefined): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(fieldTexts);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(fieldTexts);
  return [];
}

/** How many of a card's events the panel's activity lists. */
const ACTIVITY_SHOWN = 200;

export function cardDetail(ctx: BoardContext, editor: EditorInfo, id: CardId): CardDetail {
  const { card, problems } = getCard(ctx, id);
  const view = readBoard(ctx);
  const { config } = view;
  const others = new Map(view.cards.map((other) => [String(other.id), other]));
  const key = String(card.id);
  const relations = relationsOf(view.cards, card.id).map((relation) => {
    const other = others.get(String(relation.to));
    return {
      kind: relation.kind,
      to: relation.to,
      statedBy: relation.statedBy,
      own: String(relation.statedBy) === key,
      ...(other ? { title: other.title, type: other.type, column: other.column, ...(other.archived !== undefined ? { archived: true } : {}) } : {})
    };
  });
  const activity = readEvents(ctx.dir)
    .events.filter(({ event }) => event.item !== undefined && String(event.item) === key)
    .reverse()
    .slice(0, ACTIVITY_SHOWN)
    .map(({ event, position }) => eventItem(event, config, position));
  const texts = [card.description, card.status ?? "", ...card.thread.map((comment) => comment.body), ...fieldTexts(card.fields)];
  return {
    card: {
      id: card.id,
      type: card.type,
      title: card.title,
      column: card.column,
      tags: card.tags,
      author: card.author,
      created: card.created,
      updated: card.updated,
      relations: card.relations.map((relation) => ({ kind: relation.kind, to: relation.to })),
      attachments: card.attachments.map((attachment) => ({ path: attachment.path, ...(attachment.lines ? { lines: attachment.lines } : {}) })),
      fields: card.fields,
      ...(card.session !== undefined ? { session: card.session } : {}),
      ...(card.status !== undefined ? { status: card.status } : {}),
      ...(card.archived !== undefined ? { archived: card.archived } : {}),
      ...(card.color !== undefined ? { color: card.color } : {}),
      extra: card.extra,
      description: card.description,
      thread: card.thread.map((comment) => ({ author: comment.author, at: comment.at, body: comment.body })),
      file: card.file,
      hash: card.hash
    },
    problems,
    relations,
    attachments: card.attachments.map((attachment) => attachmentLine(attachment, editor)),
    activity,
    mentions: mentionsIn(texts, editor)
  };
}

/**
 * A card's notifications as the lines of the list, newest first: a comment and a move written in
 * one step are one line ("commented and moved it to Done: …"), which stands for both events.
 */
function notificationLines(events: BoardEvent[], config: BoardConfig): EventItem[] {
  return eventLines(events, config).map((line) => {
    if (line.events.length === 1) return eventItem(line.events[0]!, config);
    const comment = line.events.find((event) => event.kind === "comment.added") ?? line.events[0]!;
    return { ...eventItem(comment, config), text: line.text, merged: line.events.map((event) => event.kind) };
  });
}

/**
 * The capsule's state from the core's check: the count of everything unseen (events, as the spec
 * counts them), the list of the last 50, by card, a comment and a move of one step in one line, and
 * per card what is unseen and what of it is addressed to the person (the tile's dot and "@you").
 */
export function notificationsPayload(result: CheckResult, config: BoardConfig): NotificationsPayload {
  const all = result.notifications;
  const shown = new Set(all.slice(-NOTIFICATIONS_SHOWN));
  const byCard = (events: BoardEvent[]): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const event of events) {
      if (event.item === undefined) continue;
      const key = String(event.item);
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  };
  const groups: NotificationGroup[] = [];
  for (const group of result.groups) {
    const events = group.events.filter((event) => shown.has(event)).reverse();
    if (events.length === 0) continue;
    groups.push({
      ...(group.item !== undefined ? { item: group.item } : {}),
      ...(group.title !== undefined ? { title: group.title } : {}),
      ...(group.type !== undefined ? { type: group.type } : {}),
      ...(group.column !== undefined ? { column: group.column } : {}),
      latest: events[0]!.at,
      events: notificationLines(events, config)
    });
  }
  return {
    count: all.length,
    cards: result.groups.length,
    groups,
    shown: shown.size,
    unseenByCard: byCard(all),
    addressed: result.addressed.length,
    addressedByCard: byCard(result.addressed),
    ...(result.cursor.seen ? { since: result.cursor.seen } : {})
  };
}
