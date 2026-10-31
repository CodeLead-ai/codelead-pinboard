/**
 * Every refusal of the board carries a code (for programs) and its words (for people). The words
 * say what was refused, why, and that nothing was written; a program reads the code.
 */
export type RefusalCode =
  | "no-board"
  | "board-exists"
  | "not-found"
  | "stale"
  | "column"
  | "not-allowed"
  | "type"
  | "participant"
  | "secret"
  | "machine-path"
  | "private-name"
  | "structure"
  | "invalid"
  | "busy"
  | "imported"
  | "usage";

export class BoardRefusal extends Error {
  public readonly code: RefusalCode;

  public constructor(code: RefusalCode, message: string) {
    super(message);
    this.name = "BoardRefusal";
    this.code = code;
  }
}

export function isBoardRefusal(error: unknown): error is BoardRefusal {
  return error instanceof BoardRefusal;
}
