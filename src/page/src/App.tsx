import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { BoardPayload, CardChangesInput, CardDetail, CardMessage, CardSummary, EventItem, NewCardInput, NotificationsPayload, ReadyMessage, WritePayload } from "../../server/contract.js";
import { api, Refused, wordsOf } from "./api.js";
import { BoardView } from "./Board.js";
import { CardPanel, type PanelActions } from "./CardPanel.js";
import { FilterBar } from "./FilterBar.js";
import { cardAbove, classes, columnCards, columnName, keyOf, lastColumnOf, matches, onBoard, rankFor, readFilter, readStack, writeQuery, type Filter } from "./model.js";
import { TopBar, type LiveState, type ThemeChoice } from "./TopBar.js";

/**
 * The board's page (spec section 6): the board, the cards' panels, the notifications, kept live by
 * the process's event stream. React's own state only; the files are the truth, and every change
 * the page makes goes through the process, as the board's person.
 */

function readTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem("pinboard.theme");
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

/**
 * Which columns the person collapsed or opened on this board, by column id (true: collapsed), kept
 * in this browser per board. A column the person never touched follows its default: Done is
 * collapsed while the window is narrower than WIDE_ENOUGH.
 */
type ColumnChoices = Record<string, boolean>;

/** Seven columns need about 1,700 px; under this width Done starts collapsed so that the others fit better. */
const WIDE_ENOUGH = 1500;

function choicesKey(board: string): string {
  return `pinboard.columns.${board}`;
}

function readColumnChoices(board: string): ColumnChoices {
  try {
    const stored = JSON.parse(localStorage.getItem(choicesKey(board)) ?? "null") as unknown;
    if (typeof stored === "object" && stored !== null && !Array.isArray(stored)) {
      return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
    }
    // The first page kept one list of collapsed columns for every board.
    const older = JSON.parse(localStorage.getItem("pinboard.collapsed") ?? "[]") as unknown;
    return Array.isArray(older) ? Object.fromEntries(older.filter((entry): entry is string => typeof entry === "string").map((entry) => [entry, true])) : {};
  } catch {
    return {};
  }
}

function writeColumnChoices(board: string, choices: ColumnChoices): void {
  try {
    localStorage.setItem(choicesKey(board), JSON.stringify(choices));
  } catch {
    // No storage: the columns open as they open by default on the next visit.
  }
}

/** True while the window is narrower than `width` px. */
function useNarrowerThan(width: number): boolean {
  const query = `(max-width: ${width - 0.02}px)`;
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const change = (): void => setNarrow(list.matches);
    change();
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }, [query]);
  return narrow;
}

function useNow(every = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(timer);
  }, [every]);
  return now;
}

function withCard(board: BoardPayload | null, summary: CardSummary): BoardPayload | null {
  if (!board) return board;
  const key = keyOf(summary.id);
  return { ...board, cards: [...board.cards.filter((card) => keyOf(card.id) !== key), summary] };
}

function applyCardMessage(board: BoardPayload | null, message: CardMessage): BoardPayload | null {
  if (!board) return board;
  if (message.card && !message.removed) return withCard(board, message.card);
  const key = keyOf(message.id);
  return { ...board, cards: board.cards.filter((card) => keyOf(card.id) !== key) };
}

type Message = { text: string; tone: "info" | "refusal" };

export function App() {
  const [board, setBoard] = useState<BoardPayload | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notes, setNotes] = useState<NotificationsPayload | null>(null);
  const [filter, setFilter] = useState<Filter>(() => readFilter(window.location.search));
  const [stack, setStack] = useState<string[]>(() => readStack(window.location.search));
  const [details, setDetails] = useState<Record<string, CardDetail>>({});
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [composer, setComposer] = useState<string | null>(null);
  const [capsule, setCapsule] = useState(false);
  const [keys, setKeys] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  const [live, setLive] = useState<LiveState>("connecting");
  const [message, setMessage] = useState<Message | null>(null);
  const [choices, setChoices] = useState<{ board: string; columns: ColumnChoices } | null>(null);
  const narrow = useNarrowerThan(WIDE_ENOUGH);
  const [flashed, setFlashed] = useState<Set<string>>(() => new Set());
  const [confirm, setConfirm] = useState<string | null>(null);
  const [toThread, setToThread] = useState<string | null>(null);
  const now = useNow();
  const searchRef = useRef<HTMLInputElement>(null);
  const tileRefs = useRef(new Map<string, HTMLElement>()).current;
  const position = useRef(0);
  const stackRef = useRef(stack);
  stackRef.current = stack;
  const personRef = useRef<string | undefined>(undefined);
  personRef.current = board?.person.id;

  // ------------------------------------------------------------------------------------------
  // Reading

  const say = useCallback((text: string, tone: Message["tone"] = "info") => setMessage({ text, tone }), []);

  /** Where the stream starts: the log's position when the board was first read (no line falls between the two). */
  const [streamFrom, setStreamFrom] = useState<number | null>(null);

  /** Reads the board; `reset` when the log may have been rewritten (its positions start again). */
  const loadBoard = useCallback(async (reset = false) => {
    try {
      const next = await api.board();
      position.current = reset ? next.lines : Math.max(position.current, next.lines);
      setBoard(next);
      setFailure(null);
      setStreamFrom((previous) => previous ?? next.lines);
    } catch (error) {
      setFailure(wordsOf(error));
    }
  }, []);

  const loadNotes = useCallback(async () => {
    try {
      setNotes(await api.notifications());
    } catch {
      // The capsule keeps what it last knew; the live mark says the process is away.
    }
  }, []);

  const notesTimer = useRef<number | undefined>(undefined);
  const refreshNotes = useCallback(() => {
    window.clearTimeout(notesTimer.current);
    notesTimer.current = window.setTimeout(() => void loadNotes(), 120);
  }, [loadNotes]);

  const loadDetail = useCallback(
    async (key: string, open: boolean) => {
      try {
        const detail = await api.card(key, open);
        setDetails((previous) => ({ ...previous, [key]: detail }));
        setDetailErrors((previous) => {
          if (!(key in previous)) return previous;
          const { [key]: _gone, ...rest } = previous;
          return rest;
        });
        if (open) refreshNotes();
      } catch (error) {
        setDetailErrors((previous) => ({ ...previous, [key]: wordsOf(error) }));
      }
    },
    [refreshNotes]
  );

  /** An open card changed: read it again; it counts as opened when the person can see it. */
  const detailTimers = useRef(new Map<string, number>());
  const refreshDetail = useCallback(
    (key: string) => {
      if (!stackRef.current.includes(key)) return;
      window.clearTimeout(detailTimers.current.get(key));
      detailTimers.current.set(
        key,
        window.setTimeout(() => {
          const visible = document.visibilityState === "visible" && stackRef.current[stackRef.current.length - 1] === key;
          void loadDetail(key, visible);
        }, 80)
      );
    },
    [loadDetail]
  );

  const flash = useCallback((key: string) => {
    setFlashed((previous) => new Set(previous).add(key));
    window.setTimeout(() => {
      setFlashed((previous) => {
        const next = new Set(previous);
        next.delete(key);
        return next;
      });
    }, 2400);
  }, []);

  useEffect(() => {
    void loadBoard();
    void loadNotes();
    for (const key of readStack(window.location.search)) void loadDetail(key, true);
  }, [loadBoard, loadNotes, loadDetail]);

  // Back on the tab: the card in front of the person is seen now.
  useEffect(() => {
    const onVisible = (): void => {
      const top = stackRef.current[stackRef.current.length - 1];
      if (document.visibilityState === "visible" && top) void loadDetail(top, true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [loadDetail]);

  // The stream: every line of the log, every card file that changed, as they happen. A page that
  // reconnects is sent the lines it missed (Last-Event-ID); one that finds the log shorter than it
  // knew reads the board again.
  useEffect(() => {
    if (streamFrom === null) return;
    const source = new EventSource(`api/stream?since=${streamFrom}`);
    source.addEventListener("ready", (event) => {
      setLive("live");
      const ready = JSON.parse((event as MessageEvent<string>).data) as ReadyMessage;
      if (ready.lines !== position.current) {
        const rewritten = ready.lines < position.current;
        if (rewritten) position.current = ready.lines;
        void loadBoard(rewritten);
        refreshNotes();
        for (const key of stackRef.current) refreshDetail(key);
      }
    });
    source.addEventListener("event", (event) => {
      const item = JSON.parse((event as MessageEvent<string>).data) as EventItem;
      if (item.position !== undefined) {
        if (item.position <= position.current) return;
        position.current = item.position;
      }
      refreshNotes();
      if (item.item !== undefined) {
        const key = keyOf(item.item);
        refreshDetail(key);
        if (item.by !== personRef.current) flash(key);
      }
    });
    source.addEventListener("card", (event) => {
      const card = JSON.parse((event as MessageEvent<string>).data) as CardMessage;
      setBoard((previous) => applyCardMessage(previous, card));
      refreshDetail(keyOf(card.id));
    });
    source.addEventListener("board", () => void loadBoard(true));
    source.addEventListener("notifications", () => refreshNotes());
    source.onerror = () => setLive(source.readyState === EventSource.CLOSED ? "offline" : "connecting");
    return () => source.close();
  }, [streamFrom, loadBoard, refreshNotes, refreshDetail, flash]);

  // ------------------------------------------------------------------------------------------
  // What the page keeps: the filter and the open cards in the URL, the theme and the collapsed columns in this browser.

  useEffect(() => {
    const search = writeQuery(filter, stack);
    if (search !== window.location.search) window.history.replaceState(null, "", `${window.location.pathname}${search}`);
  }, [filter, stack]);

  useEffect(() => {
    const onPop = (): void => {
      setFilter(readFilter(window.location.search));
      setStack(readStack(window.location.search));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      if (theme === "system") localStorage.removeItem("pinboard.theme");
      else localStorage.setItem("pinboard.theme", theme);
    } catch {
      // No storage: the choice lasts as long as the page.
    }
  }, [theme]);

  // The columns the person collapsed or opened are this board's, kept per board; the others follow
  // their default (Done collapsed on a narrow window).
  const boardName = board?.name;
  useEffect(() => {
    if (boardName !== undefined) setChoices((previous) => (previous?.board === boardName ? previous : { board: boardName, columns: readColumnChoices(boardName) }));
  }, [boardName]);

  const collapsed = useMemo(() => {
    const set = new Set<string>();
    if (!board) return set;
    const done = board.columns.find((column) => column.id === "done")?.id ?? lastColumnOf(board);
    for (const column of board.columns) if (choices?.columns[column.id] ?? (narrow && column.id === done)) set.add(column.id);
    return set;
  }, [board, choices, narrow]);

  /** Collapses a column (`collapse` true) or opens it, and remembers that the person chose so, for this board. */
  const chooseColumn = useCallback(
    (column: string, collapse: boolean) => {
      if (!boardName) return;
      setChoices((previous) => {
        const columns = { ...(previous?.board === boardName ? previous.columns : readColumnChoices(boardName)), [column]: collapse };
        writeColumnChoices(boardName, columns);
        return { board: boardName, columns };
      });
    },
    [boardName]
  );

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), message.tone === "refusal" ? 14_000 : 5_000);
    return () => window.clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    const count = notes?.count ?? 0;
    document.title = count > 0 ? `(${count}) Pinboard · ${board?.name ?? ""}` : `Pinboard · ${board?.name ?? ""}`;
  }, [notes, board]);

  // ------------------------------------------------------------------------------------------
  // Writing: every write goes through the process; a refusal comes back in the core's words.

  const applyWrite = useCallback((result: WritePayload) => {
    const key = keyOf(result.card.card.id);
    setDetails((previous) => ({ ...previous, [key]: result.card }));
    setBoard((previous) => withCard(previous, result.summary));
  }, []);

  const perform = useCallback(
    async (key: string, work: () => Promise<WritePayload>): Promise<string | null> => {
      try {
        applyWrite(await work());
        return null;
      } catch (error) {
        if (error instanceof Refused && error.stale) {
          await loadDetail(key, false);
          return `${error.message} The page has read it again.`;
        }
        return wordsOf(error);
      }
    },
    [applyWrite, loadDetail]
  );

  const openCard = useCallback(
    (key: string, mode: "root" | "push" = "root", thread = false) => {
      setCapsule(false);
      setMoving(null);
      setStack((previous) => (mode === "push" ? [...previous.filter((entry) => entry !== key), key] : [key]));
      if (thread) setToThread(key);
      void loadDetail(key, true);
    },
    [loadDetail]
  );

  const popPanel = useCallback(() => {
    setStack((previous) => previous.slice(0, -1));
  }, []);

  /** The new-card form in a column (a collapsed column opens for it). */
  const compose = useCallback(
    (column: string | null) => {
      setComposer(column);
      if (column !== null && collapsed.has(column)) chooseColumn(column, false);
    },
    [collapsed, chooseColumn]
  );

  /**
   * Moves a card into a column: at the top, or, when it was dropped, below the card it was dropped
   * under (`after`; null: the top). Inside its own column only a drop moves it, and only when the
   * place differs from where it stands.
   */
  const moveCard = useCallback(
    async (key: string, to: string, after?: string | null) => {
      setMoving(null);
      const card = board?.cards.find((entry) => keyOf(entry.id) === key);
      if (!card || !board) return;
      if (card.column === to && (after === undefined || cardAbove(board.cards, key) === after)) return;
      // The card moves at once, to its place; it goes back if the board refuses.
      const rank = rankFor(board.cards, to, key, after ?? null);
      const place = (column: string, at: number) => (previous: BoardPayload | null): BoardPayload | null =>
        previous ? { ...previous, cards: previous.cards.map((entry) => (keyOf(entry.id) === key ? { ...entry, column, rank: at } : entry)) } : previous;
      setBoard(place(to, rank));
      const refused = await perform(key, () => api.move(key, to, card.updated, undefined, after));
      if (refused) {
        setBoard(place(card.column, card.rank));
        say(refused, "refusal");
      } else say(card.column === to ? `Moved #${key} within ${columnName(board, to)}.` : `Moved #${key} to ${columnName(board, to)}.`);
    },
    [board, perform, say]
  );

  const createCard = useCallback(
    async (input: NewCardInput): Promise<boolean> => {
      try {
        const result = await api.create(input);
        applyWrite(result);
        const key = keyOf(result.card.card.id);
        setSelected(key);
        openCard(key);
        return true;
      } catch (error) {
        say(wordsOf(error), "refusal");
        return false;
      }
    },
    [applyWrite, openCard, say]
  );

  const clearAll = useCallback(async () => {
    try {
      setNotes(await api.clearAll());
    } catch (error) {
      say(wordsOf(error), "refusal");
    }
  }, [say]);

  const archive = useCallback(
    async (key: string) => {
      setConfirm(null);
      const updated = details[key]?.card.updated;
      const refused = await perform(key, () => api.archive(key, updated));
      if (refused) say(refused, "refusal");
      else {
        setStack((previous) => previous.filter((entry) => entry !== key));
        say(`Archived #${key}: it left the board and stays in its file.`);
      }
    },
    [details, perform, say]
  );

  const actions: PanelActions = useMemo(
    () => ({
      update: (key: string, expectUpdated: string, changes: CardChangesInput) => perform(key, () => api.update(key, expectUpdated, changes)),
      say: (words: string) => say(words, "refusal"),
      comment: (key: string, body: string, expectUpdated: string, moveTo?: string) => perform(key, () => (moveTo ? api.move(key, moveTo, expectUpdated, body) : api.comment(key, body, expectUpdated))),
      move: async (key: string, to: string, expectUpdated: string) => {
        const refused = await perform(key, () => api.move(key, to, expectUpdated));
        if (refused) say(refused, "refusal");
        return refused;
      },
      archive: (key: string) => setConfirm(key),
      openRelated: (key: string) => openCard(key, "push"),
      back: popPanel,
      crumb: (index: number) => setStack((previous) => previous.slice(0, index + 1)),
      close: () => setStack([])
    }),
    [perform, say, openCard, popPanel]
  );

  // ------------------------------------------------------------------------------------------
  // The keyboard: `/` search, `n` new card, `j`/`k` (and the arrows) through a column, `h`/`l`
  // across columns, Enter opens, `m` moves, Esc closes what is on top.

  const navigable = useMemo(() => {
    if (!board) return [] as string[][];
    const shown = board.cards.filter((card) => onBoard(card, filter));
    return board.columns.filter((column) => !collapsed.has(column.id)).map((column) => columnCards(shown, column.id).filter((card) => matches(card, filter)).map((card) => keyOf(card.id)));
  }, [board, filter, collapsed]);

  const focusTile = useCallback(
    (key: string) => {
      setSelected(key);
      const tile = tileRefs.get(key);
      tile?.focus();
      tile?.scrollIntoView({ block: "nearest", inline: "nearest" });
    },
    [tileRefs]
  );

  useEffect(() => {
    const locate = (key: string | null): [number, number] | null => {
      if (key === null) return null;
      for (let column = 0; column < navigable.length; column += 1) {
        const index = navigable[column]!.indexOf(key);
        if (index !== -1) return [column, index];
      }
      return null;
    };
    const first = (): string | undefined => navigable.find((keys) => keys.length > 0)?.[0];
    const step = (delta: number): void => {
      const at = locate(selected);
      if (!at) {
        const start = first();
        if (start) focusTile(start);
        return;
      }
      const next = navigable[at[0]]![at[1] + delta];
      if (next) focusTile(next);
    };
    const across = (delta: number): void => {
      const at = locate(selected);
      let column = at ? at[0] : delta > 0 ? -1 : navigable.length;
      for (;;) {
        column += delta;
        if (column < 0 || column >= navigable.length) return;
        if (navigable[column]!.length > 0) break;
      }
      const keys = navigable[column]!;
      focusTile(keys[Math.min(at ? at[1] : 0, keys.length - 1)]!);
    };

    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || confirm) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const typing = target?.closest("input, textarea, select, [contenteditable='true']") != null;
      if (event.key === "Escape") {
        if (moving) setMoving(null);
        else if (capsule) setCapsule(false);
        else if (keys) setKeys(false);
        else if (typing) target?.blur();
        else if (composer) setComposer(null);
        else if (stackRef.current.length > 0) {
          popPanel();
          if (stackRef.current.length === 1 && selected) window.setTimeout(() => tileRefs.get(selected)?.focus(), 0);
        } else if (selected) {
          setSelected(null);
          target?.blur();
        } else return;
        event.preventDefault();
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey || !board) return;
      const panelOpen = stackRef.current.length > 0;
      const onTile = target?.closest(".tile") != null || target === document.body || target === null;
      switch (event.key) {
        case "/":
          event.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
          return;
        case "?":
          event.preventDefault();
          setKeys((open) => !open);
          return;
        case "n":
          event.preventDefault();
          compose(board.columns[0]?.id ?? null);
          return;
        case "m":
          event.preventDefault();
          if (panelOpen) document.querySelector<HTMLSelectElement>("[data-testid='panel'] [data-testid='panel-column']")?.focus();
          else if (selected) setMoving(selected);
          return;
        case "j":
        case "ArrowDown":
          if (panelOpen || !onTile) return;
          event.preventDefault();
          step(1);
          return;
        case "k":
        case "ArrowUp":
          if (panelOpen || !onTile) return;
          event.preventDefault();
          step(-1);
          return;
        case "h":
        case "ArrowLeft":
          if (panelOpen || !onTile) return;
          event.preventDefault();
          across(-1);
          return;
        case "l":
        case "ArrowRight":
          if (panelOpen || !onTile) return;
          event.preventDefault();
          across(1);
          return;
        case "Enter":
        case " ":
        case "o":
          if (panelOpen || !onTile || !selected) return;
          event.preventDefault();
          openCard(selected);
          return;
        default:
          return;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [board, navigable, selected, moving, capsule, keys, composer, confirm, focusTile, openCard, popPanel, compose, tileRefs]);

  // ------------------------------------------------------------------------------------------

  // A click on the board outside the panels closes them: the whole stack, since a click on the board
  // is a way back to the board (Esc and ‹ Back step back one card at a time). A press that turns
  // into a drag, a click on a card (it opens that card), on a control, or one that ends a text
  // selection does not count, and nothing on the board moves.
  const pressed = useRef<{ x: number; y: number } | null>(null);
  const onWorkspacePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    pressed.current = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
  };
  const onWorkspaceClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const start = pressed.current;
    pressed.current = null;
    if (stackRef.current.length === 0 || event.button !== 0 || !start) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest(".board") || target.closest(".panel, .tile, button, a, input, select, textarea, label, summary, .composer, .popover, [role='listbox']")) return;
    if ((window.getSelection()?.toString() ?? "") !== "") return;
    setStack([]);
  };

  const cardIds = useMemo(() => new Set((board?.cards ?? []).map((card) => keyOf(card.id))), [board?.cards]);
  const knownTags = useMemo(() => [...new Set((board?.cards ?? []).flatMap((card) => card.tags))].sort(), [board?.cards]);
  const shown = board ? board.cards.filter((card) => onBoard(card, filter)) : [];
  const matching = shown.filter((card) => matches(card, filter)).length;
  const titleOf = (key: string): string => details[key]?.card.title ?? board?.cards.find((card) => keyOf(card.id) === key)?.title ?? "";

  return (
    <div className={classes("app", stack.length > 0 && "app-panel-open")}>
      <TopBar
        board={board}
        live={live}
        theme={theme}
        onTheme={setTheme}
        notes={notes}
        open={capsule}
        onToggle={setCapsule}
        keys={keys}
        onKeys={setKeys}
        onOpenCard={(key) => {
          const group = notes?.groups.find((entry) => entry.item !== undefined && keyOf(entry.item) === key);
          openCard(key, "root", group?.events.some((event) => event.kind === "comment.added") ?? false);
        }}
        onClearAll={() => void clearAll()}
        now={now}
      />
      {board ? <FilterBar board={board} filter={filter} onChange={setFilter} matching={matching} total={shown.length} searchRef={searchRef} /> : null}
      {board && board.unreadable.length > 0 ? (
        <p className="banner banner-warn page-banner" role="alert">
          {board.unreadable.length === 1 ? "A file" : `${board.unreadable.length} files`} in items/ cannot be read as a card:{" "}
          {board.unreadable.map((entry) => `${entry.file} (${entry.problems.join("; ")})`).join("; ")}. `codelead board validate` lists every problem.
        </p>
      ) : null}
      <div className="workspace" onPointerDown={onWorkspacePointerDown} onClick={onWorkspaceClick}>
        {board ? (
          <BoardView
            board={board}
            filter={filter}
            unseen={notes?.unseenByCard ?? {}}
            addressed={notes?.addressedByCard ?? {}}
            selected={selected}
            onSelect={setSelected}
            onOpen={(key) => openCard(key)}
            moving={moving}
            onMovePick={(key, to) => void moveCard(key, to)}
            onMoveCancel={() => {
              const key = moving;
              setMoving(null);
              if (key) window.setTimeout(() => tileRefs.get(key)?.focus(), 0);
            }}
            onDrop={(key, to, after) => void moveCard(key, to, after)}
            composer={composer}
            onCompose={compose}
            onCreate={createCard}
            collapsed={collapsed}
            onCollapse={(column) => chooseColumn(column, !collapsed.has(column))}
            flashed={flashed}
            now={now}
            tileRefs={tileRefs}
          />
        ) : failure ? (
          <div className="state">
            <h2>The board's process does not answer.</h2>
            <p>{failure}</p>
            <button type="button" className="primary" onClick={() => void loadBoard()}>
              Try again
            </button>
          </div>
        ) : (
          <div className="state">
            <p className="loading">Reading the board…</p>
          </div>
        )}
        {board && stack.length > 0 ? (
          <div className="panels">
            {stack.map((key, index) => (
              <CardPanel
                key={key}
                board={board}
                id={key}
                detail={details[key]}
                error={detailErrors[key]}
                below={stack.length - 1 - index}
                crumbs={stack.slice(0, index + 1).map((entry) => ({ id: entry, title: titleOf(entry) }))}
                cards={cardIds}
                knownTags={knownTags}
                now={now}
                toThread={toThread === key}
                onThreadShown={() => setToThread(null)}
                actions={actions}
              />
            ))}
          </div>
        ) : null}
      </div>
      {message ? (
        <div className={classes("message", `message-${message.tone}`)} role={message.tone === "refusal" ? "alert" : "status"} data-testid="message">
          <span>{message.text}</span>
          <button type="button" className="text-button" onClick={() => setMessage(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {confirm && board ? <ConfirmArchive id={confirm} title={titleOf(confirm)} onConfirm={() => void archive(confirm)} onCancel={() => setConfirm(null)} /> : null}
    </div>
  );
}

/** The one dialog of the page (spec 6.4): archiving asks first. */
function ConfirmArchive({ id, title, onConfirm, onCancel }: { id: string; title: string; onConfirm: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="confirm"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      aria-labelledby="confirm-title"
      data-testid="confirm-archive"
    >
      <h2 id="confirm-title">Archive #{id}?</h2>
      <p>
        <q>{title}</q> leaves the board. It stays in its file, and the filter's <b>archived</b> shows it again.
      </p>
      <div className="confirm-actions">
        <button type="button" className="primary" onClick={onConfirm} autoFocus>
          Archive
        </button>
        <button type="button" className="text-button" onClick={onCancel}>
          Keep it on the board
        </button>
      </div>
    </dialog>
  );
}
