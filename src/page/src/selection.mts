/**
 * The cards picked for a bulk change, by key (`"42"`), apart from the one card the keyboard is on.
 * Cmd/Ctrl-click (or `x`, or a tile's checkbox) toggles a card; Shift-click extends the pick within a
 * column, from the last card toggled there to the card clicked; "Select all in this column" picks a
 * column's shown cards; Escape clears. The pick follows the board: a card that leaves it (archived,
 * removed, outside the project shown) leaves the pick, and the others stay through every live update.
 * Every function returns a new set and leaves the one it is given as it was.
 */

export type Picked = ReadonlySet<string>;

export function toggle(picked: Picked, key: string): Set<string> {
  const next = new Set(picked);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/**
 * Shift-click: every card of the column between the anchor and the target (both included) joins the
 * pick. When the anchor is not in that column (or there is none), the target alone is toggled.
 */
export function extend(picked: Picked, anchor: string | null, target: string, column: readonly string[]): Set<string> {
  const from = anchor === null ? -1 : column.indexOf(anchor);
  const to = column.indexOf(target);
  if (from === -1 || to === -1) return toggle(picked, target);
  const next = new Set(picked);
  const [low, high] = from <= to ? [from, to] : [to, from];
  for (const key of column.slice(low, high + 1)) next.add(key);
  return next;
}

/** "Select all in this column": the column's shown cards join the pick. */
export function selectAll(picked: Picked, column: readonly string[]): Set<string> {
  const next = new Set(picked);
  for (const key of column) next.add(key);
  return next;
}

/** The pick after the board changed: only the cards still shown stay; the same set when nothing left. */
export function prune(picked: Picked, shown: ReadonlySet<string>): Picked {
  for (const key of picked) {
    if (!shown.has(key)) return new Set([...picked].filter((entry) => shown.has(entry)));
  }
  return picked;
}

/** The picked keys in the board's order: column by column, each column top first. */
export function inBoardOrder(picked: Picked, columns: readonly (readonly string[])[]): string[] {
  return columns.flatMap((column) => column.filter((key) => picked.has(key)));
}
