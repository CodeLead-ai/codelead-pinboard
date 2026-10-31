import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import {
  cardRanks,
  isBoardRefusal,
  LOCK_FILE,
  readBoard,
  readEvents,
  synthesizeEvents,
  type BoardConfig,
  type BoardContext,
  type BoardView,
  type CardId,
  type Participant,
  type ReadEvent
} from "../core/index.js";
import type { CardMessage, ReadyMessage } from "./contract.js";
import { eventItem, eventsByCard, personOf, summarize } from "./views.js";

/**
 * The live part of the process: it watches the board folder (fs.watch, debounced), compares what
 * it reads with what it last announced, and pushes the differences to every open page as
 * Server-Sent Events:
 *
 * - `event`: each new line of events.jsonl (the message's id is the line's place in the log, so a
 *   page that reconnects with Last-Event-ID gets the lines it missed);
 * - `card`: a card's file changed, appeared or went away, with its tile;
 * - `board`: board.json changed, or the log was rewritten: the page reads the board again;
 * - `notifications`: the person's unseen events may have changed: the page asks again;
 * - `ready`: the first message of a connection, after the lines it replays.
 *
 * A card whose file changed with no event line naming it (an agent that forgot, a hand edit) is
 * announced by the core's `synthesizeEvents` as changed by `unknown`, once the card files have been
 * quiet for `settleMs`: an agent that writes the card and then its event line in two steps is
 * given that long to write the line, and nothing is announced twice. While the folder is watched,
 * this is the only place that announces such a change (the page's notification check does not, see
 * `watching`); the changes made while the process was down are announced `settleMs` after it starts.
 */
export interface StreamOptions {
  /** How long the folder must be quiet before it is read again (fs events come in bursts). */
  debounceMs: number;
  /** How long the card files must be quiet before a change without an event is announced. */
  settleMs: number;
  /** How often an idle connection is sent a comment line so that nothing between closes it. */
  keepAliveMs: number;
  /** False: no fs.watch (the folder is read only on `scan()`). */
  watch: boolean;
  log: (line: string) => void;
}

interface Client {
  res: ServerResponse;
}

function idOf(key: string): CardId {
  return /^\d+$/.test(key) ? Number(key) : key;
}

export class BoardStream {
  private readonly clients = new Set<Client>();
  private watcher: fs.FSWatcher | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private settle: NodeJS.Timeout | undefined;
  private keepAlive: NodeJS.Timeout | undefined;
  /** How many lines of events.jsonl have been announced. */
  private lines = 0;
  /** Each card's file digest as last announced, by id. */
  private cards = new Map<string, string>();
  private unreadable = "";
  private config = "";
  private cursor = "";
  private cardsChangedAt = 0;
  private synthesisOwed = false;
  private closed = false;

  public constructor(
    private readonly ctx: BoardContext,
    private readonly options: StreamOptions
  ) {
    const view = readBoard(ctx);
    this.lines = readEvents(ctx.dir).count;
    this.cards = new Map(view.cards.map((card) => [String(card.id), card.hash]));
    this.unreadable = JSON.stringify(view.unreadable);
    this.config = this.configKey();
    this.cursor = this.cursorText(personOf(view.config).id);
  }

  /** How many lines of the log the stream has announced. */
  public get position(): number {
    return this.lines;
  }

  public get connections(): number {
    return this.clients.size;
  }

  /**
   * True while the folder is watched: the watcher then announces the changes made without an event,
   * after the quiet time, and nothing else should (an early announcement catches an agent between
   * writing a card and writing its event line). False when it could not be started or stopped.
   */
  public get watching(): boolean {
    return this.watcher !== undefined;
  }

  public start(): void {
    if (this.options.watch) {
      try {
        this.watcher = fs.watch(this.ctx.dir, { recursive: true }, (_kind, name) => this.noticed(name === null ? null : String(name)));
        this.watcher.on("error", (error) => {
          this.watcher = undefined;
          this.options.log(`Pinboard: the folder watcher stopped (${error.message}); changes made outside the page show after a reload.`);
        });
      } catch (error) {
        this.watcher = undefined;
        this.options.log(`Pinboard: cannot watch ${this.ctx.dir} (${error instanceof Error ? error.message : String(error)}); changes made outside the page show after a reload.`);
      }
    }
    if (this.watcher) {
      // What changed while the process was down is announced once the files have been quiet.
      this.synthesisOwed = true;
      this.cardsChangedAt = Date.now();
      this.synthesizeWhenSettled();
    }
    this.keepAlive = setInterval(() => {
      for (const client of this.clients) this.send(client.res, ": keep-alive\n\n");
    }, this.options.keepAliveMs);
    this.keepAlive.unref();
  }

  public close(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = undefined;
    for (const timer of [this.debounce, this.settle]) if (timer) clearTimeout(timer);
    if (this.keepAlive) clearInterval(this.keepAlive);
    for (const client of this.clients) client.res.end();
    this.clients.clear();
  }

  /** Opens a stream for a page: the lines after `since` (or Last-Event-ID) that were announced, then `ready`. */
  public connect(req: IncomingMessage, res: ServerResponse, since: number | undefined): void {
    // What changed and was not announced yet is announced first, so that the new page starts from
    // the log as it is; then everything that can be refused is read before its headers go out.
    this.scan();
    const { config } = readBoard(this.ctx);
    const ready: ReadyMessage = { lines: this.lines, person: personOf(config).id };
    const header = req.headers["last-event-id"];
    const lastId = typeof header === "string" && /^\d+$/.test(header.trim()) ? Number(header.trim()) : undefined;
    const from = lastId ?? since;
    const replay = from !== undefined && from < this.lines ? readEvents(this.ctx.dir).events.filter(({ position }) => position > from && position <= this.lines) : [];

    req.socket.setNoDelay(true);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    this.send(res, "retry: 2000\n\n");
    for (const { event, position } of replay) this.message(res, "event", eventItem(event, config, position), position);
    this.message(res, "ready", ready);
    const client: Client = { res };
    this.clients.add(client);
    const drop = (): void => {
      this.clients.delete(client);
    };
    req.on("close", drop);
    res.on("close", drop);
  }

  /** A change in the folder, as fs.watch names it (relative to the board folder; null when it could not say). */
  public noticed(name: string | null): void {
    if (this.closed) return;
    if (name !== null) {
      const relative = name.split(path.sep).join("/");
      const base = path.posix.basename(relative);
      // The lock file, and the temporary files of atomic writes: nothing the page shows.
      if (base === LOCK_FILE || (base.startsWith(".") && base.endsWith(".tmp"))) return;
      if (relative.startsWith("imports/")) return;
    }
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.scan(), this.options.debounceMs);
  }

  /** Reads the folder now and announces every difference since the last announcement. */
  public scan(): void {
    if (this.closed) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = undefined;
    try {
      const view = readBoard(this.ctx);
      const log = readEvents(this.ctx.dir);
      const person = personOf(view.config);
      const announced = this.announceEvents(view.config, log);
      const announcedEvents = announced.length;
      // A card placed by a new line of the log (moved, created) has a new place in its column even
      // when its file did not change since it was announced (an agent writes the card, then the line).
      const placed = new Set(announced.filter(({ event }) => event.item !== undefined && (event.kind === "item.moved" || event.kind === "item.created")).map(({ event }) => String(event.item)));
      if (this.announceCards(view, person, log.events, placed) > 0) {
        this.cardsChangedAt = Date.now();
        this.synthesisOwed = true;
      }
      this.announceConfig();
      const cursor = this.cursorText(person.id);
      if (announcedEvents > 0 || cursor !== this.cursor) {
        this.cursor = cursor;
        this.broadcast("notifications", {});
      }
    } catch (error) {
      // A board.json or a cursor that cannot be read: the page is told to read the board again,
      // and the route it calls answers with the core's words.
      this.broadcast("board", { problem: error instanceof Error ? error.message : String(error) });
    }
    this.synthesizeWhenSettled();
  }

  /** Writes to one page, unless its connection has gone (a keep-alive can come after a close). */
  private send(res: ServerResponse, text: string): void {
    if (res.destroyed || res.writableEnded) return;
    res.write(text);
  }

  private message(res: ServerResponse, kind: string, data: unknown, id?: number): void {
    this.send(res, `${id !== undefined ? `id: ${id}\n` : ""}event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private broadcast(kind: string, data: unknown, id?: number): void {
    for (const client of this.clients) this.message(client.res, kind, data, id);
  }

  /** Announces each new line of the log; returns the lines announced. */
  private announceEvents(config: BoardConfig, log: { events: ReadEvent[]; count: number }): ReadEvent[] {
    if (log.count < this.lines) {
      // The log is shorter than what was announced (a checkout, a hand edit): start again from it.
      this.lines = log.count;
      this.broadcast("board", { problem: "events.jsonl was rewritten" });
      return [];
    }
    if (log.count === this.lines) return [];
    const announced: ReadEvent[] = [];
    for (const entry of log.events) {
      if (entry.position <= this.lines) continue;
      this.broadcast("event", eventItem(entry.event, config, entry.position), entry.position);
      announced.push(entry);
    }
    this.lines = log.count;
    return announced;
  }

  /**
   * Announces each card whose file differs from the last announcement, and each card of `placed`
   * (a new place in its column); returns how many files changed.
   */
  private announceCards(view: BoardView, person: Participant, events: ReadEvent[], placed: ReadonlySet<string> = new Set()): number {
    let byCard: Map<string, ReadEvent[]> | undefined;
    let ranks: Map<string, number> | undefined;
    const next = new Map<string, string>();
    let changed = 0;
    for (const card of view.cards) {
      const key = String(card.id);
      next.set(key, card.hash);
      const fileChanged = this.cards.get(key) !== card.hash;
      if (!fileChanged && !placed.has(key)) continue;
      byCard ??= eventsByCard(events);
      ranks ??= cardRanks(events, view.cards);
      const message: CardMessage = { id: card.id, card: summarize(card, view.config, person, byCard.get(key) ?? [], ranks.get(key) ?? 0) };
      this.broadcast("card", message);
      if (fileChanged) changed += 1;
    }
    for (const key of this.cards.keys()) {
      if (next.has(key)) continue;
      const message: CardMessage = { id: idOf(key), removed: true };
      this.broadcast("card", message);
      changed += 1;
    }
    this.cards = next;
    const unreadable = JSON.stringify(view.unreadable);
    if (unreadable !== this.unreadable) {
      this.unreadable = unreadable;
      this.broadcast("board", {});
      changed += 1;
    }
    return changed;
  }

  /** board.json without nextId (which every new card raises): a change of anything else reloads the page's board. */
  private configKey(): string {
    try {
      const raw = fs.readFileSync(path.join(this.ctx.dir, "board.json"), "utf8");
      // A byte-order mark (code 0xFEFF) at the start is not part of the JSON.
      const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as Record<string, unknown>;
      delete parsed.nextId;
      return JSON.stringify(parsed);
    } catch {
      return "";
    }
  }

  private announceConfig(): void {
    const key = this.configKey();
    if (key === this.config) return;
    this.config = key;
    this.broadcast("board", {});
  }

  private cursorText(person: string): string {
    try {
      return fs.readFileSync(path.join(this.ctx.dir, "cursors", `${person}.json`), "utf8");
    } catch {
      return "";
    }
  }

  /** Once the card files have been quiet for settleMs, the core announces the changes that came without an event. */
  private synthesizeWhenSettled(): void {
    if (!this.synthesisOwed || this.closed) return;
    if (this.settle) clearTimeout(this.settle);
    const wait = this.cardsChangedAt + this.options.settleMs - Date.now();
    if (wait > 0) {
      this.settle = setTimeout(() => this.synthesizeWhenSettled(), wait);
      return;
    }
    this.settle = undefined;
    this.synthesisOwed = false;
    try {
      if (synthesizeEvents(this.ctx).length > 0) this.scan();
    } catch (error) {
      if (isBoardRefusal(error) && error.code === "busy") {
        // Another writer holds the board: try again shortly.
        this.synthesisOwed = true;
        this.cardsChangedAt = Date.now() - this.options.settleMs + 250;
        this.settle = setTimeout(() => this.synthesizeWhenSettled(), 250);
        return;
      }
      this.options.log(`Pinboard: could not announce the changes made without an event: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
