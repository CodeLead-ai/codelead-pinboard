import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  addComment,
  archiveCard,
  boardContext,
  BoardRefusal,
  checkBoard,
  createCards,
  isBoardRefusal,
  isIsoTime,
  markOpened,
  moveCard,
  parseCardId,
  readBoardConfig,
  readEvents,
  updateCard,
  workspaceOf,
  type BoardContext,
  type CardChanges,
  type CardId,
  type NewCardInput,
  type RefusalCode,
  type SanitizerFactory,
  type WriteResult,
  type YamlValue
} from "../core/index.js";
import type { EditorInfo, EventsPayload, RefusalPayload, WritePayload } from "./contract.js";
import { editorInfo } from "./editor.js";
import { PageFiles } from "./page.js";
import { BoardStream } from "./stream.js";
import { boardPayload, cardDetail, eventItem, notificationsPayload, personOf, summaryOf } from "./views.js";

/**
 * The board's local process: Node's own HTTP server on 127.0.0.1, the page's files, a JSON API
 * whose every route hands its work to the core (as the board's person: the page is the person),
 * and the event stream. It never calls a model and never runs code; the folder is its only state.
 *
 * A refusal of the core becomes 409 when the card changed since the page read it (`stale`), 404
 * when there is no such card, 503 when another writer holds the board, and 422 for every other
 * rule, always with the core's own words. A request from another site is refused (the Host must
 * be this process's, a write's Origin too, and a write's body must be JSON), so that no web page
 * can write to the board through the browser.
 */
export interface BoardServerOptions {
  /** The board folder. */
  dir: string;
  /** The repository the board is in; found from `dir` when not given. */
  root?: string;
  /** The home folder the core's machine-path rule uses; the user's when not given. */
  home?: string;
  now?: () => Date;
  /** Makes the sanitizer the core's guard uses (secrets, machine paths); the board's own when not given. */
  sanitizer?: SanitizerFactory;
  /** The built page's folder. */
  pageDir: string;
  /** False: no folder watcher (tests that drive `scan()` themselves). Default: true. */
  watch?: boolean;
  /** Default 120 ms. */
  debounceMs?: number;
  /** How long card files must be quiet before a change without an event is announced. Default 10 s. */
  settleMs?: number;
  /** Default 25 s. */
  keepAliveMs?: number;
  log?: (line: string) => void;
}

export interface BoardServer {
  readonly ctx: BoardContext;
  readonly stream: BoardStream;
  /** The request handler (every route, the stream and the page). */
  handle(req: IncomingMessage, res: ServerResponse): void;
  /** Listens on 127.0.0.1 (port 0: a free port the system picks). */
  listen(port?: number): Promise<{ url: string; port: number }>;
  close(): Promise<void>;
}

const MAX_BODY = 2 * 1024 * 1024;

/** A request the process refuses before it reaches the board (not JSON, too large, from another site). */
class RequestProblem extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function usage(message: string): BoardRefusal {
  return new BoardRefusal("usage", message);
}

export function statusOfRefusal(code: RefusalCode): number {
  switch (code) {
    case "stale":
      return 409;
    case "not-found":
    case "no-board":
      return 404;
    case "busy":
      return 503;
    default:
      return 422;
  }
}

type Body = Record<string, unknown>;

async function readBody(req: IncomingMessage): Promise<Body> {
  const type = String(req.headers["content-type"] ?? "");
  if (!/^application\/json\b/i.test(type)) {
    throw new RequestProblem(415, "usage", "Refused: a write is sent as JSON (Content-Type: application/json); nothing was written.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY) throw new RequestProblem(413, "usage", "Refused: the request is larger than 2 MB; nothing was written.");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RequestProblem(400, "usage", "Refused: the request's body is not JSON; nothing was written.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RequestProblem(400, "usage", "Refused: the request's body must be one JSON object; nothing was written.");
  return value as Body;
}

function optionalText(body: Body, key: string, what: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw usage(`Refused: ${what} must be a text; nothing was written.`);
  return value;
}

function requiredText(body: Body, key: string, what: string): string {
  const value = optionalText(body, key, what);
  if (value === undefined) throw usage(`Refused: the request has no ${what}; nothing was written.`);
  return value;
}

function textList(body: Body, key: string, what: string): string[] | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw usage(`Refused: ${what} must be a list of texts; nothing was written.`);
  return value as string[];
}

function cardIdOf(text: string): CardId {
  let decoded: string;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    decoded = text;
  }
  const id = parseCardId(decoded);
  if (id === undefined) throw new BoardRefusal("not-found", `No card #${decoded} on the board ("${decoded}" is not a card id).`);
  return id;
}

function relationList(body: Body, key: string): Array<{ kind: string; to: CardId }> | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw usage(`Refused: ${key} must be a list of { kind, to }; nothing was written.`);
  return value.map((item) => {
    const entry = item as Record<string, unknown>;
    if (typeof item !== "object" || item === null || typeof entry.kind !== "string" || (typeof entry.to !== "number" && typeof entry.to !== "string")) {
      throw usage(`Refused: each of ${key} must be { kind: <kind>, to: <card id> }; nothing was written.`);
    }
    const to = typeof entry.to === "number" ? entry.to : parseCardId(entry.to);
    if (to === undefined) throw usage(`Refused: "${String(entry.to)}" is not a card id; nothing was written.`);
    return { kind: entry.kind, to };
  });
}

function isYamlValue(value: unknown): value is YamlValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isYamlValue);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).every(isYamlValue);
  return false;
}

function changesOf(body: Body): CardChanges {
  const raw = body.changes;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw usage("Refused: the request has no changes ({ changes: { … } }); nothing was written.");
  const input = raw as Body;
  const changes: CardChanges = {};
  const title = optionalText(input, "title", "the title");
  if (title !== undefined) changes.title = title;
  const type = optionalText(input, "type", "the type");
  if (type !== undefined) changes.type = type;
  const description = optionalText(input, "description", "the description");
  if (description !== undefined) changes.description = description;
  if (input.status === null) changes.status = null;
  else {
    const status = optionalText(input, "status", "the status");
    if (status !== undefined) changes.status = status;
  }
  if (input.color === null) changes.color = null;
  else {
    const color = optionalText(input, "color", "the colour");
    if (color !== undefined) changes.color = color;
  }
  const addTags = textList(input, "addTags", "addTags");
  if (addTags) changes.addTags = addTags;
  const removeTags = textList(input, "removeTags", "removeTags");
  if (removeTags) changes.removeTags = removeTags;
  const addRelations = relationList(input, "addRelations");
  if (addRelations) changes.addRelations = addRelations;
  const removeRelations = relationList(input, "removeRelations");
  if (removeRelations) changes.removeRelations = removeRelations;
  if (input.addAttachments !== undefined && input.addAttachments !== null) {
    if (!Array.isArray(input.addAttachments)) throw usage("Refused: addAttachments must be a list of { path, lines }; nothing was written.");
    changes.addAttachments = input.addAttachments.map((item) => {
      const entry = item as Record<string, unknown>;
      if (typeof item !== "object" || item === null || typeof entry.path !== "string" || (entry.lines !== undefined && typeof entry.lines !== "string")) {
        throw usage('Refused: each attachment must be { path: "<path in the repository>", lines: "<lines>" }; nothing was written.');
      }
      return { path: entry.path, ...(typeof entry.lines === "string" && entry.lines.trim() !== "" ? { lines: entry.lines.trim() } : {}) };
    });
  }
  if (input.fields !== undefined && input.fields !== null) {
    if (typeof input.fields !== "object" || Array.isArray(input.fields)) throw usage("Refused: fields must map each field's name to its value; nothing was written.");
    const fields: Record<string, YamlValue | null> = {};
    for (const [key, value] of Object.entries(input.fields as Record<string, unknown>)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) throw usage(`Refused: "${key}" is not a field name; nothing was written.`);
      if (!isYamlValue(value)) throw usage(`Refused: the field ${key} holds a value a card cannot keep; nothing was written.`);
      fields[key] = value;
    }
    changes.fields = fields;
  }
  return changes;
}

/** Where a dropped card goes in its column: below the card `after` names, or at the top (null); undefined when the move does not say. */
function placeOf(body: Body): CardId | null | undefined {
  const value = body.after;
  if (value === undefined) return undefined;
  if (value === null) return null;
  const id = typeof value === "number" ? (Number.isSafeInteger(value) && value > 0 ? value : undefined) : typeof value === "string" ? parseCardId(value) : undefined;
  if (id === undefined) throw usage(`Refused: "after" names the card the moved card goes below (its id), or null for the top; "${String(value)}" is neither. Nothing was written.`);
  return id;
}

function newCardOf(body: Body): NewCardInput {
  const description = optionalText(body, "description", "the description");
  const column = optionalText(body, "column", "the column");
  const tags = textList(body, "tags", "tags");
  const relations = relationList(body, "relations");
  return {
    type: requiredText(body, "type", "type"),
    title: requiredText(body, "title", "title"),
    ...(column !== undefined && column.trim() !== "" ? { column } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(tags ? { tags } : {}),
    ...(relations ? { relations } : {})
  };
}

interface Reply {
  status: number;
  body: unknown;
}

interface Route {
  method: "GET" | "PUT" | "POST";
  pattern: RegExp;
  run: (match: RegExpExecArray, url: URL, body: Body) => Reply;
}

export function createBoardServer(options: BoardServerOptions): BoardServer {
  const ctx = boardContext({
    dir: options.dir,
    ...(options.root ? { root: options.root } : {}),
    ...(options.home ? { home: options.home } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.sanitizer ? { sanitizer: options.sanitizer } : {})
  });
  const log = options.log ?? ((line: string) => console.error(line));
  // A board that cannot be served is refused now, in the core's words: no board.json, or no person.
  personOf(readBoardConfig(ctx.dir).config);
  // Where the files the cards cite are: the repository and the board's workspace, read with each request (board.json may change while it is served).
  const editor = (): EditorInfo => editorInfo(ctx.root, workspaceOf(ctx.root, readBoardConfig(ctx.dir).config));
  const page = new PageFiles(options.pageDir);
  const stream = new BoardStream(ctx, {
    debounceMs: options.debounceMs ?? 120,
    settleMs: options.settleMs ?? 10_000,
    keepAliveMs: options.keepAliveMs ?? 25_000,
    watch: options.watch ?? true,
    log
  });
  let server: http.Server | undefined;
  let port: number | undefined;

  const person = (): string => personOf(readBoardConfig(ctx.dir).config).id;

  /** A write's answer: the card as it is now, its tile, the events it appended. The stream tells the other pages. */
  const written = (result: WriteResult, status = 200): Reply => {
    const { config } = readBoardConfig(ctx.dir);
    stream.scan();
    const payload: WritePayload = {
      card: cardDetail(ctx, editor(), result.card.id),
      summary: summaryOf(ctx, result.card.id),
      events: result.events.map((event) => eventItem(event, config))
    };
    return { status, body: payload };
  };

  const routes: Route[] = [
    { method: "GET", pattern: /^\/api\/board$/, run: () => ({ status: 200, body: boardPayload(ctx, editor()) }) },
    {
      method: "GET",
      pattern: /^\/api\/items\/([^/]+)$/,
      run: (match, url) => {
        const id = cardIdOf(match[1]!);
        if (url.searchParams.get("open") === "1") {
          // Opening a card clears its notifications (spec 6.3).
          markOpened(ctx, person(), id);
          stream.scan();
        }
        return { status: 200, body: cardDetail(ctx, editor(), id) };
      }
    },
    {
      method: "PUT",
      pattern: /^\/api\/items\/([^/]+)$/,
      run: (match, _url, body) => {
        const expectUpdated = optionalText(body, "expectUpdated", "expectUpdated");
        return written(updateCard(ctx, cardIdOf(match[1]!), { as: person(), changes: changesOf(body), ...(expectUpdated !== undefined ? { expectUpdated } : {}) }));
      }
    },
    {
      method: "POST",
      pattern: /^\/api\/items$/,
      // The person's own cards are not tagged by:<person>; that tag marks an agent's proposals.
      run: (_match, _url, body) => written(createCards(ctx, person(), [newCardOf(body)], { tagCreator: false })[0]!, 201)
    },
    {
      method: "POST",
      pattern: /^\/api\/items\/([^/]+)\/comments$/,
      run: (match, _url, body) => {
        const expectUpdated = optionalText(body, "expectUpdated", "expectUpdated");
        const text = requiredText(body, "body", "comment (body)");
        return written(addComment(ctx, cardIdOf(match[1]!), { as: person(), body: text, ...(expectUpdated !== undefined ? { expectUpdated } : {}) }));
      }
    },
    {
      method: "POST",
      pattern: /^\/api\/items\/([^/]+)\/move$/,
      run: (match, _url, body) => {
        const expectUpdated = optionalText(body, "expectUpdated", "expectUpdated");
        const comment = optionalText(body, "comment", "the comment");
        const after = placeOf(body);
        return written(
          moveCard(ctx, cardIdOf(match[1]!), {
            as: person(),
            to: requiredText(body, "to", "column to move the card to (to)"),
            ...(comment !== undefined && comment.trim() !== "" ? { comment } : {}),
            ...(expectUpdated !== undefined ? { expectUpdated } : {}),
            ...(after !== undefined ? { after } : {})
          })
        );
      }
    },
    {
      method: "POST",
      pattern: /^\/api\/items\/([^/]+)\/archive$/,
      run: (match, _url, body) => {
        const expectUpdated = optionalText(body, "expectUpdated", "expectUpdated");
        return written(archiveCard(ctx, cardIdOf(match[1]!), { as: person(), ...(expectUpdated !== undefined ? { expectUpdated } : {}) }));
      }
    },
    {
      method: "GET",
      pattern: /^\/api\/events$/,
      run: (_match, url) => {
        const since = url.searchParams.get("since") ?? "0";
        const { config } = readBoardConfig(ctx.dir);
        const { events, count } = readEvents(ctx.dir);
        let after: typeof events;
        if (/^\d+$/.test(since)) after = events.filter(({ position }) => position > Number(since));
        else if (isIsoTime(since)) after = events.filter(({ event }) => Date.parse(event.at) > Date.parse(since));
        else throw usage(`Refused: since is a count of lines (since=42) or a UTC time (since=2026-10-03T00:52:10Z), not "${since}".`);
        const payload: EventsPayload = { lines: count, events: after.map(({ event, position }) => eventItem(event, config, position)) };
        return { status: 200, body: payload };
      }
    },
    {
      method: "POST",
      pattern: /^\/api\/check\/ack$/,
      run: () => {
        // "Clear all": the person's cursor moves to the end of the log.
        checkBoard(ctx, { as: person(), ack: true, synthesize: !stream.watching });
        stream.scan();
        const { config } = readBoardConfig(ctx.dir);
        return { status: 200, body: notificationsPayload(checkBoard(ctx, { as: person(), synthesize: !stream.watching }), config) };
      }
    },
    {
      method: "GET",
      pattern: /^\/api\/notifications$/,
      run: () => {
        // While the folder is watched, a change made without an event is the watcher's to announce,
        // after the files have been quiet: a check here would catch an agent between writing a card
        // and writing its event line, and announce its change as unknown's.
        const { config } = readBoardConfig(ctx.dir);
        return { status: 200, body: notificationsPayload(checkBoard(ctx, { as: person(), synthesize: !stream.watching }), config) };
      }
    }
  ];

  const sendJson = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra });
    res.end(text);
  };

  const refuse = (res: ServerResponse, status: number, code: string, message: string): void => {
    const body: RefusalPayload = { refused: code, message };
    sendJson(res, status, body);
  };

  /** The Host a browser sends to this process; anything else is a page of another site reaching it through DNS. */
  const hostAllowed = (req: IncomingMessage): boolean => {
    if (port === undefined) return true;
    const host = String(req.headers.host ?? "").toLowerCase();
    return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
  };

  const originAllowed = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    if (port === undefined) return false;
    return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
  };

  const respond = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!hostAllowed(req)) {
      refuse(res, 403, "host", "Refused: this process answers only to 127.0.0.1 and localhost on its own port.");
      return;
    }
    if (url.pathname === "/api/stream") {
      if (method !== "GET") {
        refuse(res, 405, "usage", "The stream is read with GET.");
        return;
      }
      const since = url.searchParams.get("since");
      stream.connect(req, res, since !== null && /^\d+$/.test(since) ? Number(since) : undefined);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const matching = routes.filter((route) => route.pattern.test(url.pathname));
      const route = matching.find((candidate) => candidate.method === method);
      if (!route) {
        if (matching.length > 0) sendJson(res, 405, { refused: "usage", message: `${url.pathname} answers ${matching.map((entry) => entry.method).join(", ")}.` }, { Allow: matching.map((entry) => entry.method).join(", ") });
        else refuse(res, 404, "not-found", `No route ${method} ${url.pathname}.`);
        return;
      }
      if (method !== "GET" && !originAllowed(req)) {
        refuse(res, 403, "origin", "Refused: a write from another site; nothing was written.");
        return;
      }
      const body = method === "GET" ? {} : await readBody(req);
      const reply = route.run(route.pattern.exec(url.pathname)!, url, body);
      sendJson(res, reply.status, reply.body);
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      refuse(res, 405, "usage", "The page's files are read with GET.");
      return;
    }
    if (!page.serve(req, res, url.pathname)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found.\n");
    }
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    respond(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (isBoardRefusal(error)) refuse(res, statusOfRefusal(error.code), error.code, error.message);
      else if (error instanceof RequestProblem) refuse(res, error.status, error.code, error.message);
      else {
        const message = error instanceof Error ? error.message : String(error);
        log(`Pinboard: ${req.method} ${req.url} failed: ${message}`);
        sendJson(res, 500, { error: message });
      }
    });
  };

  return {
    ctx,
    stream,
    handle,
    listen: (wanted = 0) =>
      new Promise((resolve, reject) => {
        const created = http.createServer(handle);
        created.once("error", reject);
        created.listen(wanted, "127.0.0.1", () => {
          created.off("error", reject);
          server = created;
          port = (created.address() as AddressInfo).port;
          stream.start();
          resolve({ url: `http://127.0.0.1:${port}/`, port });
        });
      }),
    close: () =>
      new Promise((resolve) => {
        stream.close();
        if (!server) {
          resolve();
          return;
        }
        const closing = server;
        server = undefined;
        closing.close(() => resolve());
        closing.closeAllConnections();
      })
  };
}
