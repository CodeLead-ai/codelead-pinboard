import type {
  BoardPayload,
  CardChangesInput,
  CardDetail,
  CardId,
  MoveInput,
  NewCardInput,
  NotificationsPayload,
  RefusalPayload,
  WritePayload
} from "../../server/contract.js";

/**
 * The page's calls to its process. Every write sends the `updated` the page read (expectUpdated),
 * so that a card changed meanwhile is refused (409) instead of overwritten; a refusal comes back
 * with the core's own words, which the page shows as they are.
 */
export class Refused extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }

  public get stale(): boolean {
    return this.status === 409;
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
  } catch {
    throw new Refused(0, "offline", "The board's process does not answer. Is `codelead board serve` still running?");
  }
  const text = await response.text();
  let data: unknown;
  try {
    data = text === "" ? {} : JSON.parse(text);
  } catch {
    data = { message: text };
  }
  if (!response.ok) {
    const refusal = data as Partial<RefusalPayload> & { error?: string };
    throw new Refused(response.status, refusal.refused ?? "error", refusal.message ?? refusal.error ?? `The process answered ${response.status}.`);
  }
  return data as T;
}

const item = (id: CardId): string => `api/items/${encodeURIComponent(String(id))}`;

export const api = {
  board: (): Promise<BoardPayload> => call("GET", "api/board"),
  /** `open`: the person opened the card, so its notifications clear. */
  card: (id: CardId, open: boolean): Promise<CardDetail> => call("GET", `${item(id)}${open ? "?open=1" : ""}`),
  update: (id: CardId, expectUpdated: string | undefined, changes: CardChangesInput): Promise<WritePayload> => call("PUT", item(id), { expectUpdated, changes }),
  create: (input: NewCardInput): Promise<WritePayload> => call("POST", "api/items", input),
  comment: (id: CardId, body: string, expectUpdated?: string): Promise<WritePayload> => call("POST", `${item(id)}/comments`, { body, expectUpdated }),
  /** `after`: where the card was dropped in the column, below that card or at the top (null); left out, the top. */
  move: (id: CardId, to: string, expectUpdated?: string, comment?: string, after?: CardId | null): Promise<WritePayload> => {
    const body: MoveInput = { to, ...(expectUpdated !== undefined ? { expectUpdated } : {}), ...(comment !== undefined ? { comment } : {}), ...(after !== undefined ? { after } : {}) };
    return call("POST", `${item(id)}/move`, body);
  },
  archive: (id: CardId, expectUpdated?: string): Promise<WritePayload> => call("POST", `${item(id)}/archive`, { expectUpdated }),
  notifications: (): Promise<NotificationsPayload> => call("GET", "api/notifications"),
  clearAll: (): Promise<NotificationsPayload> => call("POST", "api/check/ack", {})
};

export function wordsOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
