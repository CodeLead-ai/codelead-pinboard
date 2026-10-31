import { useEffect, useRef } from "react";
import type { BoardPayload, NotificationsPayload } from "../../server/contract.js";
import { BellIcon, BrandMark, KeysIcon, MoonIcon, SunIcon, SystemIcon, TypeChip } from "./icons.js";
import { ago, classes, columnName, plural } from "./model.js";

export type ThemeChoice = "system" | "light" | "dark";
export type LiveState = "connecting" | "live" | "offline";

const THEME_NEXT: Record<ThemeChoice, ThemeChoice> = { system: "light", light: "dark", dark: "system" };
const THEME_WORDS: Record<ThemeChoice, string> = { system: "follows the system", light: "light", dark: "dark" };

export interface TopBarProps {
  board: BoardPayload | null;
  live: LiveState;
  theme: ThemeChoice;
  onTheme: (next: ThemeChoice) => void;
  notes: NotificationsPayload | null;
  open: boolean;
  onToggle: (open: boolean) => void;
  keys: boolean;
  onKeys: (open: boolean) => void;
  onOpenCard: (id: string) => void;
  onClearAll: () => void;
  now: number;
}

/** The keyboard (spec 6.4), as the legend lists it. */
const SHORTCUTS: Array<[string[], string]> = [
  [["/"], "search the cards"],
  [["n"], "a new card, in Inbox"],
  [["j", "k"], "next and previous card in a column"],
  [["h", "l"], "the column before and after"],
  [["Enter"], "open the card"],
  [["m"], "move the card: then a column's number"],
  [["Esc"], "close what is on top"],
  [["⌘", "↵"], "save, or send the comment"],
  [["?"], "this list"]
];

const LIVE_WORDS: Record<LiveState, [string, string]> = {
  connecting: ["connecting", "Connecting to the board's process…"],
  live: ["live", "Live: changes to the board's files show here as they happen."],
  offline: ["offline", "The board's process does not answer. Is `codelead board serve` still running? The page reconnects on its own."]
};

export function TopBar({ board, live, theme, onTheme, notes, open, onToggle, keys, onKeys, onOpenCard, onClearAll, now }: TopBarProps) {
  const count = notes?.count ?? 0;
  const wrap = useRef<HTMLDivElement>(null);
  const keysWrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent): void => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) onToggle(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open, onToggle]);

  useEffect(() => {
    if (!keys) return;
    const away = (event: PointerEvent): void => {
      if (keysWrap.current && !keysWrap.current.contains(event.target as Node)) onKeys(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [keys, onKeys]);

  const ThemeIcon = theme === "light" ? SunIcon : theme === "dark" ? MoonIcon : SystemIcon;
  const [liveWord, liveTitle] = LIVE_WORDS[live];

  return (
    <header className="topbar">
      <div className="brand">
        <BrandMark />
        <span className="brand-name">Pinboard</span>
        {board ? <span className="brand-board">{board.name}</span> : null}
        <span className={classes("live", `live-${live}`)} title={liveTitle}>
          <span className="live-dot" aria-hidden="true" />
          {liveWord}
        </span>
      </div>
      <div className="topbar-end">
        {board ? (
          <span className="person" title={`The page writes as ${board.person.name} (the board's person in board.json).`}>
            {board.person.name}
          </span>
        ) : null}
        <div className="keys-wrap" ref={keysWrap}>
          <button type="button" className="icon-button" onClick={() => onKeys(!keys)} aria-expanded={keys} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" data-testid="keys">
            <KeysIcon size={17} />
          </button>
          {keys ? (
            <div className="popover keys" role="dialog" aria-label="Keyboard shortcuts">
              <div className="popover-title">The keyboard</div>
              <dl>
                {SHORTCUTS.map(([combo, words]) => (
                  <div key={words}>
                    <dt>
                      {combo.map((key) => (
                        <kbd key={key}>{key}</kbd>
                      ))}
                    </dt>
                    <dd>{words}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={() => onTheme(THEME_NEXT[theme])}
          title={`Theme: ${THEME_WORDS[theme]}. Click for ${THEME_WORDS[THEME_NEXT[theme]]}.`}
          aria-label={`Theme: ${THEME_WORDS[theme]}`}
          data-testid="theme"
        >
          <ThemeIcon size={17} />
        </button>
        <div className="capsule-wrap" ref={wrap}>
          <button
            type="button"
            className={classes("capsule", count > 0 && "capsule-unseen")}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={count > 0 ? `${count} new` : "Nothing new"}
            title={count > 0 ? `${plural(count, "change")} by others since you last looked` : "Nothing new since you last looked"}
            onClick={() => onToggle(!open)}
            data-testid="capsule"
          >
            <BellIcon size={16} />
            {count > 0 ? (
              <span className="capsule-count">
                <b>{count}</b> new
              </span>
            ) : null}
          </button>
          {open ? <NotificationList board={board} notes={notes} onOpenCard={onOpenCard} onClearAll={onClearAll} now={now} /> : null}
        </div>
      </div>
    </header>
  );
}

function NotificationList({ board, notes, onOpenCard, onClearAll, now }: { board: BoardPayload | null; notes: NotificationsPayload | null; onOpenCard: (id: string) => void; onClearAll: () => void; now: number }) {
  const count = notes?.count ?? 0;
  return (
    <div className="notes" role="dialog" aria-label="What changed since you last looked" data-testid="notifications">
      <div className="notes-head">
        <span className="notes-title">Since you last looked</span>
        {count > 0 ? <span className="notes-sum">{`${plural(count, "change")} on ${plural(notes?.cards ?? 0, "card")}`}</span> : null}
      </div>
      {count === 0 ? (
        <p className="notes-empty">Nothing new. When an agent writes on the board, it shows here; nothing pops up.</p>
      ) : (
        <ol className="notes-list">
          {(notes?.groups ?? []).map((group) => {
            const id = group.item === undefined ? undefined : String(group.item);
            return (
              <li key={id ?? "board"} className="note-group">
                <button type="button" className="note-card" disabled={id === undefined} onClick={() => id && onOpenCard(id)}>
                  {group.type ? <TypeChip type={group.type} types={board?.types ?? []} size={11} small /> : null}
                  {id ? <span className="note-id">#{id}</span> : null}
                  <span className="note-title">{group.title ?? (id ? "a card no longer on the board" : "the board")}</span>
                  {board && group.column ? <span className="note-column">{columnName(board, group.column)}</span> : null}
                </button>
                <ul className="note-lines">
                  {group.events.map((event, index) => (
                    <li key={`${event.at}-${index}`}>
                      <button type="button" className="note-line" disabled={id === undefined} onClick={() => id && onOpenCard(id)}>
                        <span className="note-dot" aria-hidden="true" />
                        <span className="note-text">
                          <b className={event.by === "unknown" ? "note-unknown" : undefined}>{event.byName}</b> {event.text.replace(/`/g, "")}
                        </span>
                        <time className="note-age" dateTime={event.at} title={event.at}>
                          {ago(event.at, now)}
                        </time>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ol>
      )}
      <div className="notes-foot">
        {notes && notes.count > notes.shown ? <span className="notes-more">The last {notes.shown} are listed; the rest are in each card's activity.</span> : <span />}
        <button type="button" className="text-button" onClick={onClearAll} disabled={count === 0} data-testid="clear-all">
          Clear all
        </button>
      </div>
    </div>
  );
}
