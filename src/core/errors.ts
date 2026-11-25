/**
 * Every refusal of the board carries a code (for programs) and its words (for people). The words
 * say what was refused, why, and that nothing was written; a program reads the code.
 *
 * The codes fall in two classes, and a command's exit code says which (`exitCodeOfRefusal`):
 *
 * - **the command cannot run as written** (exit 2): `usage` (a missing or malformed argument, or
 *   two that do not go together), `no-board` (no board where the command looks), `not-found` (no
 *   card with the id given);
 * - **a rule of the board refused the write** (exit 1): every other code.
 */
export const REFUSAL_CODES = [
  "no-board",
  "board-exists",
  "not-found",
  "stale",
  "column",
  "not-allowed",
  "type",
  "participant",
  "secret",
  "machine-path",
  "private-name",
  "structure",
  "invalid",
  "busy",
  "imported",
  // A decision written or removed by an agent, a decision that is none, an ask that is not one to three sentences.
  "decision",
  // A colour that is none of the five.
  "color",
  // A card related to itself, a kind of relation the board does not have, a relation to no card of the call.
  "relation",
  // A text the card cannot keep as given: an empty comment, title or tag; a title, status or tag of more than one line.
  "text",
  // A card that cannot go to Ready yet (it does not say how to tell it is done, what it may touch, or a limit), a change that
  // would take one of these from a card in Ready, a limit that is not a number.
  "ready",
  // A claim (dispatch.ts): a take by a person, a lease longer than the board allows, a renewal or a release by anyone but the
  // agent that holds the card, a move of a claimed card by another agent (or by its holder anywhere but For review).
  "claim",
  // A schedule (schedules.ts): a name the board has a schedule of already, a name that is no schedule's word.
  "schedule",
  "usage"
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

/** The codes that say the command cannot run as written (exit 2); every other code is a rule of the board (exit 1). */
export const COMMAND_LINE_REFUSALS: readonly RefusalCode[] = ["usage", "no-board", "not-found"];

/** A command's exit code for a refusal: 2 when the command cannot run as written, 1 when a rule of the board refused the write. */
export function exitCodeOfRefusal(code: RefusalCode): 1 | 2 {
  return COMMAND_LINE_REFUSALS.includes(code) ? 2 : 1;
}

export class BoardRefusal extends Error {
  public readonly code: RefusalCode;
  /** What a program reads of the refusal beside its words, when it says more (the Ready check: the card and each thing missing). */
  public readonly details?: Record<string, unknown>;

  public constructor(code: RefusalCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "BoardRefusal";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function isBoardRefusal(error: unknown): error is BoardRefusal {
  return error instanceof BoardRefusal;
}
