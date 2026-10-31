import type { ReadEvent } from "./events.js";
import type { CardData } from "./types.js";

/**
 * The order of the cards in each column, read from the event log alone: no rank is written into a
 * card. A card takes its place when it arrives in a column (created there, or moved there), and that
 * place is the top, so a column lists its cards newest first. A move that says where the card was
 * dropped (`data.after`: a card of that column) puts it right below that card, and a move inside its
 * own column gives it a new place there. A comment or an edit never moves a card: a column does not
 * reshuffle while the person reads it.
 *
 * Returns each card's rank, the higher the nearer the top, to compare within a column. A card's rank
 * changes only when that card is placed again, so the page re-sorts a column with the one new rank
 * a move brings. A card whose column changed with no move event (its file edited by hand) takes the
 * place of its last event, as if it arrived then.
 */
export function cardRanks(events: ReadEvent[], cards: Array<Pick<CardData, "id" | "column">>): Map<string, number> {
  const places = new Map<string, { column: string; rank: number }>();
  const lastEvent = new Map<string, number>();
  for (const { event, position } of events) {
    if (event.item === undefined) continue;
    const key = String(event.item);
    lastEvent.set(key, position);
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (event.kind === "item.created") {
      places.set(key, { column: typeof data.column === "string" ? data.column : "", rank: position });
      continue;
    }
    if (event.kind !== "item.moved" || typeof data.to !== "string") continue;
    const to = data.to;
    const anchorKey = data.after === undefined || data.after === null ? undefined : String(data.after);
    const anchor = anchorKey !== undefined && anchorKey !== key ? places.get(anchorKey) : undefined;
    if (!anchor || anchor.column !== to) {
      // The top: an event's place in the log is higher than every rank before it.
      places.set(key, { column: to, rank: position });
      continue;
    }
    // Right below the anchor: halfway to the card under it, or one below it when it is the last.
    let under: number | undefined;
    for (const [other, place] of places) {
      if (other === key || place.column !== to || place.rank >= anchor.rank) continue;
      if (under === undefined || place.rank > under) under = place.rank;
    }
    places.set(key, { column: to, rank: under === undefined ? anchor.rank - 1 : (anchor.rank + under) / 2 });
  }
  const ranks = new Map<string, number>();
  for (const card of cards) {
    const key = String(card.id);
    const place = places.get(key);
    ranks.set(key, place && place.column === card.column ? place.rank : (lastEvent.get(key) ?? 0));
  }
  return ranks;
}
