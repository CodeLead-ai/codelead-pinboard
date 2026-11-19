import { archiveCard, getCard, moveCard, readBoard, unarchiveCard, updateCard, type BoardContext, type CardChanges, type WriteResult } from "./board.js";
import { columnOf, participantOf, readBoardConfig } from "./boardConfig.js";
import { BoardRefusal, isBoardRefusal, type RefusalCode } from "./errors.js";
import { readEvents } from "./events.js";
import { cardRanks } from "./order.js";
import type { CardId } from "./types.js";

/**
 * One change asked of several cards at once (the page's bulk bar, the commands given several ids):
 * each card's write goes through the core's own function for it (moveCard, archiveCard,
 * unarchiveCard, updateCard), with its own rules and its own events, in the order of the ids. A
 * refusal on one card is that card's alone: the cards before it keep their writes, the cards after it
 * are still written, and the refusal is returned under the card's id in the core's words.
 *
 * What would make every card's write meaningless (no such participant, no such column, no tag to
 * add, a project's name that cannot be a tag) refuses the whole call before anything is written.
 */

/** At most this many cards in one call. */
export const BULK_LIMIT = 500;

/** A project is a `repo:<name>` tag. */
export const PROJECT_PREFIX = "repo:";

export type BulkOperation =
  /** Into a column: the cards keep their order there, the first at the top (or below `after`), each next one below the one before. */
  | { kind: "move"; to: string; after?: CardId | null; comment?: string }
  | { kind: "archive" }
  | { kind: "unarchive" }
  | { kind: "tags"; add?: string[]; remove?: string[] }
  /** The project's tag added to each card; with `replace`, the card's other project tags removed. */
  | { kind: "project"; name: string; replace?: boolean }
  | { kind: "set"; changes: CardChanges };

export interface BulkInput {
  as: string;
  operation: BulkOperation;
  ids: CardId[];
  /** Per card id, the `updated` the writer read: a card that changed since is refused as stale. */
  expectUpdated?: Record<string, string>;
  rewriteHomePaths?: boolean;
}

/** Where a card stood before the call: what an Undo puts back. */
export interface BulkBefore {
  column: string;
  /** The card right above it in its column, or null at the top. */
  above: CardId | null;
  tags: string[];
  archived?: string;
  updated: string;
}

export interface BulkCardResult {
  id: CardId;
  /** "changed": the write appended events; "unchanged": nothing to change on this card, nothing written; "refused": the core refused it, nothing written for it. */
  outcome: "changed" | "unchanged" | "refused";
  write?: WriteResult;
  refusal?: { code: RefusalCode; message: string };
  before?: BulkBefore;
}

/** A project's name, as a new project's tag takes it: one word of letters, digits, ".", "-" and "_", up to 64 characters. */
export function projectNameRefusal(name: string): string | undefined {
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) return undefined;
  return `"${name.slice(0, 70)}" cannot be a project's name: a project is the tag repo:<name>, and its name is one word of letters, digits, ".", "-" and "_" (up to 64 characters), starting with a letter or a digit`;
}

function usage(message: string): BoardRefusal {
  return new BoardRefusal("usage", `Refused: ${message}; nothing was written.`);
}

function tagList(value: string[] | undefined): string[] {
  return (value ?? []).map((tag) => tag.trim()).filter((tag) => tag !== "");
}

/** Checks the whole call before any card is written: the ids, the participant, the column, the tags, the project. */
function checkCall(ctx: BoardContext, input: BulkInput): CardId[] {
  if (input.ids.length === 0) throw usage("no card was named (ids)");
  if (input.ids.length > BULK_LIMIT) throw usage(`${input.ids.length} cards are named; one call changes at most ${BULK_LIMIT}`);
  const seen = new Set<string>();
  const ids = input.ids.filter((id) => {
    const key = String(id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const { config } = readBoardConfig(ctx.dir);
  if (!participantOf(config, input.as)) {
    throw new BoardRefusal("participant", `Refused: "${input.as}" is not a participant of the board (${config.participants.map((entry) => entry.id).join(", ")}); nothing was written.`);
  }
  const operation = input.operation;
  switch (operation.kind) {
    case "move":
      if (!columnOf(config, operation.to)) throw new BoardRefusal("column", `Refused: "${operation.to}" is not a column of the board (${config.columns.map((entry) => entry.id).join(", ")}). Nothing was written.`);
      break;
    case "tags":
      if (tagList(operation.add).length === 0 && tagList(operation.remove).length === 0) throw usage("there is no tag to add or remove");
      break;
    case "project": {
      const refusal = projectNameRefusal(operation.name.trim());
      if (refusal) throw usage(refusal);
      break;
    }
    case "set":
      if (Object.keys(operation.changes).length === 0) throw usage("there is nothing to change");
      break;
    default:
      break;
  }
  return ids;
}

/** Where each card stands now: its column, the card above it there, its tags. */
function placesOf(ctx: BoardContext): Map<string, BulkBefore> {
  const view = readBoard(ctx);
  const ranks = cardRanks(readEvents(ctx.dir).events, view.cards);
  const places = new Map<string, BulkBefore>();
  const byColumn = new Map<string, typeof view.cards>();
  for (const card of view.cards) {
    if (card.archived !== undefined) continue;
    byColumn.set(card.column, [...(byColumn.get(card.column) ?? []), card]);
  }
  for (const cards of byColumn.values()) {
    cards.sort((left, right) => (ranks.get(String(right.id)) ?? 0) - (ranks.get(String(left.id)) ?? 0) || String(right.id).localeCompare(String(left.id), undefined, { numeric: true }));
  }
  for (const card of view.cards) {
    const column = card.archived === undefined ? (byColumn.get(card.column) ?? []) : [];
    const at = column.findIndex((other) => String(other.id) === String(card.id));
    places.set(String(card.id), {
      column: card.column,
      above: at > 0 ? column[at - 1]!.id : null,
      tags: [...card.tags],
      ...(card.archived !== undefined ? { archived: card.archived } : {}),
      updated: card.updated
    });
  }
  return places;
}

/** Applies one operation to several cards, each through the core's own write, in order; see the module's words. */
export function bulkWrite(ctx: BoardContext, input: BulkInput): BulkCardResult[] {
  const ids = checkCall(ctx, input);
  const places = placesOf(ctx);
  const operation = input.operation;
  const paths = input.rewriteHomePaths ? { rewriteHomePaths: true } : {};
  const results: BulkCardResult[] = [];
  // A move keeps the cards' order in the column: each card that moves goes below the one moved before it.
  let lastMoved: CardId | undefined;
  for (const id of ids) {
    const before = places.get(String(id));
    const expectUpdated = input.expectUpdated?.[String(id)];
    const fresh = expectUpdated !== undefined ? { expectUpdated } : {};
    try {
      let write: WriteResult;
      switch (operation.kind) {
        case "move": {
          const stays = operation.after === undefined && before?.column === (columnOf(readBoardConfig(ctx.dir).config, operation.to)?.id ?? operation.to);
          const after = stays ? undefined : lastMoved !== undefined ? lastMoved : operation.after;
          write = moveCard(ctx, id, {
            as: input.as,
            to: operation.to,
            ...fresh,
            ...(after !== undefined ? { after } : {}),
            ...(operation.comment !== undefined ? { comment: operation.comment } : {}),
            ...paths
          });
          if (write.events.some((event) => event.kind === "item.moved")) lastMoved = write.card.id;
          break;
        }
        case "archive":
          write = archiveCard(ctx, id, { as: input.as, ...fresh });
          break;
        case "unarchive":
          write = unarchiveCard(ctx, id, { as: input.as, ...fresh });
          break;
        case "tags":
          write = updateCard(ctx, id, { as: input.as, changes: { addTags: tagList(operation.add), removeTags: tagList(operation.remove) }, ...fresh, ...paths });
          break;
        case "project": {
          const tag = `${PROJECT_PREFIX}${operation.name.trim()}`;
          const current = getCard(ctx, id).card;
          const others = operation.replace ? current.tags.filter((entry) => entry.startsWith(PROJECT_PREFIX) && entry !== tag) : [];
          write = updateCard(ctx, id, { as: input.as, changes: { addTags: [tag], ...(others.length > 0 ? { removeTags: others } : {}) }, ...fresh, ...paths });
          break;
        }
        case "set":
          write = updateCard(ctx, id, { as: input.as, changes: operation.changes, ...fresh, ...paths });
          break;
      }
      results.push({ id: write.card.id, outcome: write.events.length > 0 ? "changed" : "unchanged", write, ...(before ? { before } : {}) });
    } catch (error) {
      if (!isBoardRefusal(error)) throw error;
      results.push({ id, outcome: "refused", refusal: { code: error.code, message: error.message }, ...(before ? { before } : {}) });
    }
  }
  return results;
}

/** A refusal's reason, short, for a line that already names the card ("#42 changed since you read it"). */
export function refusalReason(refusal: { code: RefusalCode; message: string }): string {
  if (refusal.code === "stale") return "changed since you read it";
  if (refusal.code === "not-found") return "is not on the board";
  if (refusal.code === "busy") return "was being written by another writer; try again";
  return refusal.message
    .replace(/^Refused: /, "")
    .replace(/[;.]?\s*Nothing was written\.?\s*$/i, "")
    .replace(/[;,]\s*nothing was written\.?/i, "")
    .trim();
}
