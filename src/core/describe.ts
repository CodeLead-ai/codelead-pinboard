import { decisionOf } from "./events.js";
import type { BoardConfig, BoardEvent, Decision } from "./types.js";

/** A decision in words, as the check and the notifications say it: "decided: <option> (by <who>, <day>)". */
export function describeDecision(decision: Decision): string {
  const about = [decision.by !== "" ? `by ${decision.by}` : "", decision.on].filter((part) => part !== "");
  return `decided: ${decision.option.replace(/\s+/g, " ").trim()}${about.length > 0 ? ` (${about.join(", ")})` : ""}`;
}

/**
 * An event in words, as a notification says it ("moved it from Inbox to Backlog"): the same
 * words for the CLI's check and the page's notification list.
 */
export function describeEvent(event: BoardEvent, config?: BoardConfig): string {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const column = (id: unknown): string => config?.columns.find((entry) => entry.id === id)?.name ?? String(id);
  const card = (id: unknown): string => `#${String(id)}`;
  switch (event.kind) {
    case "item.created": {
      if (data.synthesized) return "created it by writing its file, with no event";
      const created = `created it${data.type ? ` (${String(data.type)}${data.column ? ` in ${column(data.column)}` : ""})` : ""}`;
      // Created with its decision (by a person): the decision is said too.
      const decision = decisionOf(event);
      return decision ? `${created}; ${describeDecision(decision)}` : created;
    }
    case "item.updated": {
      const fields = Array.isArray(data.fields) ? (data.fields as unknown[]).map(String) : [];
      if (data.synthesized) return `changed its file with no event${fields.length > 0 ? ` (${fields.join(", ")})` : ""}`;
      // A landing recorded from the comment of a move (`data.landed`) is said as that.
      if (typeof data.landed === "string") return `recorded what landed: ${data.landed}`;
      // A decision recorded in the card's fields is said as the decision, not as "changed its fields";
      // what else the same write changed comes first.
      const decision = decisionOf(event);
      if (decision !== undefined) {
        const others = fields.filter((name) => name !== "fields");
        const said = decision === null ? "removed its decision" : describeDecision(decision);
        return others.length > 0 ? `changed its ${others.join(", ")}; ${said}` : said;
      }
      return `changed ${fields.length > 0 ? `its ${fields.join(", ")}` : "it"}`;
    }
    case "item.moved":
      // A move inside its own column puts the card at a place in it (dragged above or below another).
      if (data.from !== undefined && data.from === data.to) {
        return data.after !== undefined && data.after !== null ? `moved it below ${card(data.after)} in ${column(data.to)}` : `moved it to the top of ${column(data.to)}`;
      }
      return `moved it from ${column(data.from)} to ${column(data.to)}`;
    case "item.archived":
      return "archived it";
    case "comment.added":
      return `commented: ${typeof data.excerpt === "string" ? data.excerpt : ""}`.trimEnd();
    case "relation.added":
      return `related it: ${String(data.kind)} ${card(data.to)}`;
    case "relation.removed":
      return `removed the relation ${String(data.kind)} ${card(data.to)}`;
    case "tag.added":
      return `tagged it ${String(data.tag)}`;
    case "tag.removed":
      return `removed the tag ${String(data.tag)}`;
    case "attachment.added":
      return `attached ${String(data.path)}${data.lines ? `:${String(data.lines)}` : ""}`;
    default:
      return event.kind;
  }
}

/**
 * A comment and a move written in one step ("Comment & move": the same time, the same participant,
 * the same card, next to each other, in either order), as the pair; undefined for any other two
 * events. The step marks its two events (`data.withMove` on the comment, `data.withComment` on the
 * move): where either event is marked, only a marked move pairs, so a plain move of the same second
 * (an agent's "In progress" a moment before its landing) stays its own line. Events written before
 * the marks existed carry neither, and pair by time alone as they always did.
 */
export function commentAndMove<T extends BoardEvent>(first: T, second: T | undefined): { comment: T; move: T } | undefined {
  if (!second || first.item === undefined || second.item === undefined || String(first.item) !== String(second.item)) return undefined;
  if (first.at !== second.at || first.by !== second.by) return undefined;
  const pair =
    first.kind === "comment.added" && second.kind === "item.moved"
      ? { comment: first, move: second }
      : first.kind === "item.moved" && second.kind === "comment.added"
        ? { comment: second, move: first }
        : undefined;
  if (pair === undefined) return undefined;
  const marked = pair.comment.data?.withMove !== undefined || pair.move.data?.withComment !== undefined;
  return !marked || pair.move.data?.withComment === true ? pair : undefined;
}

/** A comment and a move written in one step, in one line: "commented and moved it to Done: <the comment's first words>". */
export function describeCommentAndMove(comment: BoardEvent, move: BoardEvent, config?: BoardConfig): string {
  const data = (move.data ?? {}) as Record<string, unknown>;
  const to = config?.columns.find((entry) => entry.id === data.to)?.name ?? String(data.to);
  const said = (comment.data as Record<string, unknown> | undefined)?.excerpt;
  return `commented and moved it to ${to}${typeof said === "string" && said !== "" ? `: ${said}` : ""}`;
}

/**
 * Events as the lines a person reads, in the order given: each event its own line, except that a
 * comment and a move written in one step are one line.
 */
export function eventLines<T extends BoardEvent>(events: T[], config?: BoardConfig): Array<{ events: T[]; text: string }> {
  const lines: Array<{ events: T[]; text: string }> = [];
  for (let index = 0; index < events.length; index += 1) {
    const pair = commentAndMove(events[index]!, events[index + 1]);
    if (pair) {
      lines.push({ events: [events[index]!, events[index + 1]!], text: describeCommentAndMove(pair.comment, pair.move, config) });
      index += 1;
    } else lines.push({ events: [events[index]!], text: describeEvent(events[index]!, config) });
  }
  return lines;
}
