import { decisionOf } from "./events.js";
import type { BoardConfig, BoardEvent, Decision } from "./types.js";
import { checkedRule, ruleWords, type ScheduleRule } from "./when.js";

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
      // A card a schedule made (schedules.ts): by the schedule, the ask of its person (the event's `by`).
      const created = `created it${typeof data.schedule === "string" ? ` by the schedule ${data.schedule}` : ""}${data.type ? ` (${String(data.type)}${data.column ? ` in ${column(data.column)}` : ""})` : ""}`;
      // Created with its decision (by a person): the decision is said too.
      const decision = decisionOf(event);
      return decision ? `${created}; ${describeDecision(decision)}` : created;
    }
    case "item.updated": {
      // The parts as a person reads them: the file's `color` is said "colour", as the page and the help say it.
      const fields = Array.isArray(data.fields) ? (data.fields as unknown[]).map(String).map((name) => (name === "color" ? "colour" : name)) : [];
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
    case "item.unarchived":
      return "brought it back from the archive";
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
    // A claim (dispatch.ts): the board gave the card to an agent from Ready, which holds it until a time it renews.
    case "claim.taken":
      return `was given it from ${column("ready")}: holds it until ${String(data.until)}${typeof data.minutes === "number" ? ` (${data.minutes} minutes)` : ""}`;
    case "claim.renewed":
      return `renewed its claim: holds it until ${String(data.until)}`;
    case "claim.released":
      return `gave it back to ${column("ready")}`;
    case "claim.expired":
      return `ended the claim of ${String(data.holder)}, which ran out at ${String(data.until)}: back to ${column("ready")}`;
    case "claim.ended": {
      const why = data.archived === true ? "archived" : `it moved to ${column(data.to)}`;
      return data.holder === event.by ? `ended its claim (${why})` : `ended the claim of ${String(data.holder)} (${why})`;
    }
    // A schedule (schedules.ts): the person's standing ask, which puts a card in Ready at its times.
    case "schedule.added": {
      const rule = ruleOf(data.rule);
      return `made the schedule ${String(data.schedule)}${rule ? `: ${ruleWords(rule)}${typeof data.zone === "string" ? ` (${data.zone})` : ""}` : ""}`;
    }
    case "schedule.changed": {
      const parts = Array.isArray(data.changed) ? (data.changed as unknown[]).map((part) => (part === "card" ? "its card" : `its ${String(part)}`)) : [];
      const rule = ruleOf(data.rule);
      return `changed the schedule ${String(data.schedule)}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}${rule ? `: ${ruleWords(rule)}${typeof data.zone === "string" ? ` (${data.zone})` : ""}` : ""}`;
    }
    case "schedule.paused":
      return `paused the schedule ${String(data.schedule)}`;
    case "schedule.resumed":
      return `resumed the schedule ${String(data.schedule)}`;
    case "schedule.removed":
      return `removed the schedule ${String(data.schedule)}`;
    case "schedule.ran":
      return `had the schedule ${String(data.schedule)} put it in ${column("ready")} (due ${String(data.due)})`;
    case "schedule.skipped": {
      const why = data.why === "open" ? `#${String(data.open)} is still open` : `the board refused its card (${String(data.refused ?? "")})`;
      return `had the schedule ${String(data.schedule)} due at ${String(data.due)}: no new card, as ${why}`;
    }
    default:
      return event.kind;
  }
}

/** A rule an event carries, when it reads as one. */
function ruleOf(value: unknown): ScheduleRule | undefined {
  if (value === undefined) return undefined;
  try {
    return checkedRule(value);
  } catch {
    return undefined;
  }
}

/** The card a schedule made and its run: its `item.created`, then the `schedule.ran` of the same card, by the same person at the same time. */
function runOfCreation<T extends BoardEvent>(created: T | undefined, next: T | undefined): T | undefined {
  if (!created || !next || created.kind !== "item.created" || next.kind !== "schedule.ran" || typeof created.data?.schedule !== "string") return undefined;
  return String(created.item) === String(next.item) && created.at === next.at && created.by === next.by ? next : undefined;
}

/** The claim event a move belongs to: the move of a take, a release or an ended lease (`data.withClaim`), then its claim event, by the same participant at the same time. */
function claimOfMove<T extends BoardEvent>(move: T | undefined, next: T | undefined): T | undefined {
  if (!move || !next || move.kind !== "item.moved" || move.data?.withClaim !== true || !next.kind.startsWith("claim.")) return undefined;
  return String(move.item) === String(next.item) && move.at === next.at && move.by === next.by ? next : undefined;
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
 * comment and a move written in one step are one line, and so are the move of a claim and its claim
 * event ("was given it from Ready: holds it until …"), with the comment of a release ("gave it back
 * to Ready: <the reason's first words>"), and so are a card a schedule made and its run ("created it
 * by the schedule check-deps (task in Ready), due …").
 */
export function eventLines<T extends BoardEvent>(events: T[], config?: BoardConfig): Array<{ events: T[]; text: string }> {
  const lines: Array<{ events: T[]; text: string }> = [];
  for (let index = 0; index < events.length; index += 1) {
    const run = runOfCreation(events[index], events[index + 1]);
    if (run) {
      lines.push({ events: [events[index]!, run], text: `${describeEvent(events[index]!, config)}, due ${String(run.data?.due)}` });
      index += 1;
      continue;
    }
    const pair = commentAndMove(events[index]!, events[index + 1]);
    const claim = claimOfMove(pair?.move ?? events[index], pair ? events[index + 2] : events[index + 1]);
    if (pair && claim) {
      const said = (pair.comment.data as Record<string, unknown> | undefined)?.excerpt;
      lines.push({ events: [events[index]!, events[index + 1]!, claim], text: `${describeEvent(claim, config)}${typeof said === "string" && said !== "" ? `: ${said}` : ""}` });
      index += 2;
    } else if (pair) {
      lines.push({ events: [events[index]!, events[index + 1]!], text: describeCommentAndMove(pair.comment, pair.move, config) });
      index += 1;
    } else if (claim) {
      lines.push({ events: [events[index]!, claim], text: describeEvent(claim, config) });
      index += 1;
    } else lines.push({ events: [events[index]!], text: describeEvent(events[index]!, config) });
  }
  return lines;
}
