import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { BoardPayload, CardSummary, ColumnInfo, NewCardInput } from "../../server/contract.js";
import { BubbleIcon, CheckIcon, CloseIcon, CollapseIcon, ExpandIcon, FlagIcon, GearIcon, MoreIcon, PlusIcon, TypeChip } from "./icons.js";
import { useMentionPicker } from "./Mentions.js";
import {
  ago,
  agoShort,
  askLine,
  classes,
  colorNameOf,
  COLUMN_NOTES,
  columnCards,
  columnLabel,
  EMPTY_WORDS,
  FOR_CODELEAD_TAG,
  hueOf,
  isFiltering,
  keyOf,
  matches,
  onBoard,
  participantName,
  waitsForDecision,
  type Filter
} from "./model.js";

const CARD_TYPE = "application/x-pinboard-card";
/** A drag of several picked cards: their keys, as JSON, beside the card dragged. */
const CARDS_TYPE = "application/x-pinboard-cards";

/** Where a dragged card would land: in this column, below that card (null: at the top). */
interface DropPlace {
  column: string;
  after: string | null;
}

/**
 * The place under the pointer in a column: below the last tile whose middle the pointer has passed
 * (the dragged cards themselves left out), or the top.
 */
function placeAt(column: HTMLElement, clientY: number, dragged: ReadonlySet<string>): string | null {
  let after: string | null = null;
  for (const tile of column.querySelectorAll<HTMLElement>(".column-body > .tile[data-card]")) {
    if (tile.dataset.card !== undefined && dragged.has(tile.dataset.card)) continue;
    const box = tile.getBoundingClientRect();
    if (clientY < box.top + box.height / 2) break;
    after = tile.dataset.card ?? null;
  }
  return after;
}

export interface BoardViewProps {
  board: BoardPayload;
  filter: Filter;
  unseen: Record<string, number>;
  /** Of the unseen, per card, the events addressed to the person (a mention of them): the tile's "@you". */
  addressed: Record<string, number>;
  selected: string | null;
  onSelect: (key: string) => void;
  onOpen: (key: string) => void;
  moving: string | null;
  onMovePick: (key: string, column: string) => void;
  onMoveCancel: () => void;
  /** A card dropped in a column, below `after` (null: at the top). */
  onDrop: (key: string, column: string, after: string | null) => void;
  /** Several picked cards dropped together (one of them was dragged): their keys in the board's order. */
  onDropMany: (keys: string[], column: string, after: string | null) => void;
  /** The cards picked for a bulk change. */
  picked: ReadonlySet<string>;
  /** Cmd/Ctrl-click or the checkbox toggles a card; Shift-click extends the pick within its column (the column's shown keys, top first). */
  onPick: (key: string, how: "toggle" | "extend", column: string[]) => void;
  /** "Select all in this column" (its shown keys), or, with null, clear the pick. */
  onPickColumn: (keys: string[] | null) => void;
  /** The picked keys in the board's order (what a drag of the pick moves). */
  pickedInOrder: string[];
  /** The tags a new card starts with (the project shown), removable in the form. */
  newCardTags: string[];
  composer: string | null;
  onCompose: (column: string | null) => void;
  onCreate: (input: NewCardInput) => Promise<boolean>;
  collapsed: ReadonlySet<string>;
  onCollapse: (column: string) => void;
  flashed: ReadonlySet<string>;
  now: number;
  tileRefs: Map<string, HTMLElement>;
}

/** The board (spec 6.1): the columns in the board's order, each with its count, its cards, and a drop zone. */
export function BoardView(props: BoardViewProps) {
  const { board, filter } = props;
  const filtering = isFiltering(filter);
  const [place, setPlace] = useState<DropPlace | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  // The cards a drag carries: the dragged card, or every picked card when the dragged one is picked.
  const [carried, setCarried] = useState<ReadonlySet<string>>(() => new Set());
  const [menu, setMenu] = useState<string | null>(null);
  const shown = board.cards.filter((card) => onBoard(card, filter));
  const firstTile = board.columns.map((column) => columnCards(shown, column.id).find((card) => matches(card, filter))).find(Boolean);
  const tabStop = props.selected ?? (firstTile ? keyOf(firstTile.id) : null);

  return (
    <main className={classes("board", props.picked.size > 0 && "board-picking")} aria-label="The board's columns">
      {board.columns.map((column) => {
        const cards = columnCards(shown, column.id);
        const matching = cards.filter((card) => matches(card, filter));
        const visible = filter.show === "hide" ? matching : cards;
        const collapsed = props.collapsed.has(column.id);
        const over = place?.column === column.id;
        const dropProps = {
          onDragOver: (event: DragEvent<HTMLElement>) => {
            if (!event.dataTransfer.types.includes(CARD_TYPE)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            const after = collapsed ? null : placeAt(event.currentTarget, event.clientY, carried);
            if (place?.column !== column.id || place.after !== after) setPlace({ column: column.id, after });
          },
          onDragLeave: (event: DragEvent<HTMLElement>) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPlace((current) => (current?.column === column.id ? null : current));
          },
          onDrop: (event: DragEvent<HTMLElement>) => {
            const key = event.dataTransfer.getData(CARD_TYPE);
            let many: string[] = [];
            try {
              const listed = JSON.parse(event.dataTransfer.getData(CARDS_TYPE) || "[]") as unknown;
              if (Array.isArray(listed)) many = listed.filter((entry): entry is string => typeof entry === "string");
            } catch {
              many = [];
            }
            const moving = new Set(many.length > 0 ? many : key ? [key] : [...carried]);
            const after = collapsed ? null : placeAt(event.currentTarget, event.clientY, moving);
            setPlace(null);
            setDragging(null);
            setCarried(new Set());
            if (!key) return;
            event.preventDefault();
            if (many.length > 1) props.onDropMany(many, column.id, after);
            else props.onDrop(key, column.id, after);
          }
        };
        const label = columnLabel(column, matching.length, cards.length, filtering);
        if (collapsed) {
          return (
            <section key={column.id} className={classes("column", "column-collapsed", over && "drop-target")} aria-label={`${column.name}, ${label}, collapsed`} data-column={column.id} {...dropProps}>
              <button type="button" className="column-strip" onClick={() => props.onCollapse(column.id)} title={`Show ${column.name}`} aria-expanded={false} data-testid={`expand-${column.id}`}>
                <ExpandIcon size={14} />
                <span className="strip-name">{column.name}</span>
                <span className="count" data-testid={`count-${column.id}`}>
                  {label}
                </span>
              </button>
            </section>
          );
        }
        const note = COLUMN_NOTES[column.id];
        const overLimit = column.limit !== undefined && cards.length > column.limit;
        // The line that shows where the dragged card would land: above the first tile, or below the one it would follow.
        const landing = over ? (place!.after ?? visible.find((card) => !carried.has(keyOf(card.id)))?.id ?? null) : null;
        const shownKeys = visible.map((card) => keyOf(card.id));
        const landingSide = over && place!.after === null ? "before" : "after";
        return (
          <section
            key={column.id}
            className={classes("column", over && "drop-target", column.owner === "person" && "column-person", cards.length === 0 && props.composer !== column.id && "column-quiet")}
            aria-label={`${column.name}, ${label}`}
            data-column={column.id}
            {...dropProps}
          >
            <header className="column-head">
              <div className="column-title">
                <h2 title={column.owner === "person" ? `${column.name}: only you move cards here; agents never do.` : undefined}>{column.name}</h2>
                <span className={classes("count", overLimit && "count-over")} data-testid={`count-${column.id}`}>
                  {label}
                </span>
                <span className={classes("column-tools", menu === column.id && "column-tools-open")}>
                  <button type="button" className="icon-button small" onClick={() => props.onCompose(column.id)} aria-label={`New card in ${column.name}`} title={`New card in ${column.name}`}>
                    <PlusIcon size={14} />
                  </button>
                  <span className="column-menu-wrap">
                    <button
                      type="button"
                      className="icon-button small"
                      onClick={() => setMenu(menu === column.id ? null : column.id)}
                      aria-haspopup="menu"
                      aria-expanded={menu === column.id}
                      aria-label={`More for ${column.name}`}
                      title={`More for ${column.name}`}
                      data-testid={`column-menu-${column.id}`}
                    >
                      <MoreIcon size={14} />
                    </button>
                    {menu === column.id ? (
                      <ColumnMenu
                        column={column}
                        count={shownKeys.length}
                        picking={props.picked.size > 0}
                        onSelectAll={() => {
                          setMenu(null);
                          props.onPickColumn(shownKeys);
                        }}
                        onClear={() => {
                          setMenu(null);
                          props.onPickColumn(null);
                        }}
                        onClose={() => setMenu(null)}
                      />
                    ) : null}
                  </span>
                  <button type="button" className="icon-button small" onClick={() => props.onCollapse(column.id)} aria-label={`Collapse ${column.name}`} title={`Collapse ${column.name} to its name and count`}>
                    <CollapseIcon size={14} />
                  </button>
                </span>
              </div>
              {note ? <p className="column-note">{note}</p> : null}
            </header>
            <div className="column-body">
              {props.composer === column.id ? <Composer board={board} column={column} tags={props.newCardTags} onCancel={() => props.onCompose(null)} onCreate={props.onCreate} /> : null}
              {visible.map((card) => {
                const key = keyOf(card.id);
                return (
                  <Tile
                    key={key}
                    board={board}
                    card={card}
                    faded={filtering && !matching.includes(card)}
                    selected={props.selected === key}
                    picked={props.picked.has(key)}
                    tabStop={tabStop === key}
                    unseen={props.unseen[key] ?? 0}
                    addressed={props.addressed[key] ?? 0}
                    flash={props.flashed.has(key)}
                    dragging={dragging === key || (dragging !== null && carried.has(key))}
                    landing={landing !== null && String(landing) === key ? landingSide : undefined}
                    now={props.now}
                    onSelect={() => props.onSelect(key)}
                    onOpen={() => props.onOpen(key)}
                    onPick={(how) => props.onPick(key, how, shownKeys)}
                    onDragStart={(event) => {
                      const many = props.picked.has(key) && props.picked.size > 1 ? props.pickedInOrder : [key];
                      event.dataTransfer.setData(CARD_TYPE, key);
                      if (many.length > 1) event.dataTransfer.setData(CARDS_TYPE, JSON.stringify(many));
                      event.dataTransfer.setData("text/plain", many.map((entry) => `#${entry}`).join(" "));
                      event.dataTransfer.effectAllowed = "move";
                      setDragging(key);
                      setCarried(new Set(many));
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setCarried(new Set());
                      setPlace(null);
                    }}
                    register={(element) => {
                      if (element) props.tileRefs.set(key, element);
                      else props.tileRefs.delete(key);
                    }}
                  >
                    {props.moving === key ? <MovePicker board={board} card={card} onPick={(to) => props.onMovePick(key, to)} onCancel={props.onMoveCancel} /> : null}
                  </Tile>
                );
              })}
              {visible.length === 0 && props.composer !== column.id ? (
                <p className="column-empty">{cards.length === 0 ? (EMPTY_WORDS[column.id] ?? "No cards here.") : "No card here matches the filter."}</p>
              ) : null}
            </div>
          </section>
        );
      })}
    </main>
  );
}

interface TileProps {
  board: BoardPayload;
  card: CardSummary;
  faded: boolean;
  selected: boolean;
  /** Picked for a bulk change: a ticked box and a ring. */
  picked: boolean;
  tabStop: boolean;
  unseen: number;
  /** How many of the unseen events address the person (a mention of them in a comment or a description). */
  addressed: number;
  flash: boolean;
  dragging: boolean;
  /** A dragged card would land just above this tile ("before") or just below it ("after"). */
  landing?: "before" | "after";
  now: number;
  onSelect: () => void;
  onOpen: () => void;
  onPick: (how: "toggle" | "extend") => void;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  register: (element: HTMLElement | null) => void;
  children?: ReactNode;
}

function Tag({ tag }: { tag: string }) {
  if (tag === FOR_CODELEAD_TAG) return <span className="chip chip-codelead" title={FOR_CODELEAD_TAG}>CodeLead</span>;
  if (tag.startsWith("repo:")) {
    return (
      <span className={`chip chip-repo hue-${hueOf(tag.slice(5))}`} title={`repository ${tag.slice(5)}`}>
        {tag.slice(5)}
      </span>
    );
  }
  return <span className={classes("chip", tag.startsWith("by:") && "chip-by")}>{tag}</span>;
}

function Tile({ board, card, faded, selected, picked, tabStop, unseen, addressed, flash, dragging, landing, now, onSelect, onOpen, onPick, onDragStart, onDragEnd, register, children }: TileProps) {
  const key = keyOf(card.id);
  const workingName = card.working ? participantName(board, card.working.by) : "";
  const colorName = colorNameOf(board, card.color);
  const ask = card.type === "decision" && card.ask ? askLine(card.ask) : undefined;
  const askMissing = card.type === "decision" && !card.ask && waitsForDecision(card, board);
  // What was decided, under the ask, in the ask's shape: the option chosen; who and when on hover.
  const outcome = card.type === "decision" && card.outcome ? askLine(card.outcome.option) : undefined;
  const outcomeTitle = card.outcome
    ? `Decided${card.outcome.by ? ` by ${participantName(board, card.outcome.by)}` : ""}${card.outcome.on ? ` on ${card.outcome.on}` : ""}${outcome?.cut ? "; the answer goes on in the card" : ""}`
    : undefined;
  const describedBy = [ask || askMissing ? `ask-${key}` : "", outcome ? `decided-${key}` : ""].filter((id) => id !== "").join(" ");
  return (
    <article
      ref={register}
      className={classes(
        "tile",
        card.proposal && "tile-proposal",
        faded && "tile-faded",
        selected && "tile-selected",
        picked && "tile-picked",
        flash && "tile-flash",
        dragging && "tile-dragging",
        card.archived && "tile-archived",
        card.color && "tile-colored",
        !card.last && "tile-no-excerpt",
        landing && `landing-${landing}`
      )}
      role="button"
      tabIndex={tabStop ? 0 : -1}
      aria-label={`#${key} ${card.type}: ${card.title}${colorName ? `, marked ${colorName}` : ""}${unseen > 0 ? `, ${unseen} new` : ""}${addressed > 0 ? ", addressed to you" : ""}${picked ? ", selected" : ""}`}
      aria-describedby={describedBy || undefined}
      draggable
      data-card={key}
      onFocus={onSelect}
      onClick={(event) => {
        // Cmd/Ctrl-click picks the card for a bulk change, Shift-click extends the pick in the column; a plain click opens it.
        if (event.metaKey || event.ctrlKey || event.shiftKey) {
          event.preventDefault();
          onSelect();
          onPick(event.shiftKey ? "extend" : "toggle");
          return;
        }
        onSelect();
        onOpen();
      }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="tile-top">
        <span
          className={classes("tile-pick", picked && "on")}
          role="checkbox"
          aria-checked={picked}
          aria-label={`Select #${key}`}
          title={picked ? `#${key} is selected (x, or Cmd/Ctrl-click, to unselect)` : `Select #${key} (x, or Cmd/Ctrl-click)`}
          onClick={(event) => {
            event.stopPropagation();
            onSelect();
            onPick(event.shiftKey ? "extend" : "toggle");
          }}
          data-testid="tile-pick"
        >
          {picked ? <CheckIcon size={13} /> : null}
        </span>
        <TypeChip type={card.type} types={board.types} size={12} />
        <span className="tile-type">{card.type}</span>
        {card.proposal ? (
          <span className="tile-proposed" title={`${participantName(board, card.author)} proposed it; it looks like this until you touch it.`}>
            proposed
          </span>
        ) : null}
        {card.archived ? <span className="tile-proposed">archived</span> : null}
        <span className="tile-top-end">
        <span className="tile-id">#{key}</span>
        {addressed > 0 ? (
          <span className="tile-mention" title={`Addressed to you since you last looked${addressed > 1 ? ` (${addressed} times)` : ""}: a comment or the description mentions you`} aria-hidden="true" data-testid="tile-mention">
            @you
          </span>
        ) : null}
        {unseen > 0 ? <span className="tile-unseen" title={`${unseen} new since you last looked`} aria-hidden="true" /> : null}
        </span>
      </div>
      <h3 className="tile-title">{card.title}</h3>
      {ask ? (
        <p id={`ask-${key}`} className="tile-ask" title={ask.cut ? "The ask goes on in the card" : undefined} data-testid="tile-ask">
          {ask.text}
        </p>
      ) : askMissing ? (
        <p id={`ask-${key}`} className="tile-ask tile-ask-missing" data-testid="tile-ask">
          Ask not written yet
        </p>
      ) : null}
      {outcome ? (
        <p id={`decided-${key}`} className="tile-decided" title={outcomeTitle} data-testid="tile-decided">
          <span className="tile-decided-label">Decided:</span> {outcome.text}
        </p>
      ) : null}
      {card.status ? <p className="tile-status">{card.status}</p> : null}
      {card.tags.length > 0 ? (
        <div className="tile-tags">
          {card.tags.map((tag) => (
            <Tag key={tag} tag={tag} />
          ))}
        </div>
      ) : null}
      <div className="tile-foot">
        <p className="tile-who">
          {card.last ? (
            <>
              <span className="who">{participantName(board, card.last.author)}</span>{" "}
              <time className="age" dateTime={card.last.at} title={`${card.last.at} (${ago(card.last.at, now)})`}>
                {agoShort(card.last.at, now)}
              </time>
            </>
          ) : (
            <span className="age" title={card.created}>{`by ${participantName(board, card.author)} · ${ago(card.created, now)}`}</span>
          )}
        </p>
        <span className="tile-marks">
          {card.waitsOnYou ? (
            <span className="mark mark-flag" title={`The last comment is ${participantName(board, card.last?.author ?? "")}'s: it waits on you.`}>
              <FlagIcon size={13} label="waits on you" />
            </span>
          ) : null}
          {card.working ? (
            <span className="mark mark-gear" title={`${workingName} reported working on it · ${ago(card.working.at, now)}`}>
              <GearIcon size={13} label={`${workingName} is working on it`} />
            </span>
          ) : null}
          {card.comments > 0 ? (
            <span className="mark mark-count" title={`${card.comments} comment${card.comments === 1 ? "" : "s"}`}>
              <BubbleIcon size={13} />
              {card.comments}
            </span>
          ) : null}
        </span>
      </div>
      {card.last ? <p className="tile-excerpt">{card.last.excerpt.replace(/`/g, "")}</p> : null}
      {card.color ? <span className="tile-color" style={{ "--card-color": card.color } as CSSProperties} title={`Colour: ${colorName ?? card.color}`} data-testid="tile-color" data-color={card.color} /> : null}
      {children}
    </article>
  );
}

/** A column's menu (its ⋯): select every card it shows, or clear the selection. */
function ColumnMenu({ column, count, picking, onSelectAll, onClear, onClose }: { column: ColumnInfo; count: number; picking: boolean; onSelectAll: () => void; onClear: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[role='menuitem']:not(:disabled)")?.focus();
    const away = (event: PointerEvent): void => {
      if (ref.current && !ref.current.parentElement?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="popover column-menu"
      role="menu"
      aria-label={`${column.name}: more`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <button type="button" role="menuitem" className="menu-item" onClick={onSelectAll} disabled={count === 0} data-testid={`select-column-${column.id}`}>
        <CheckIcon size={14} />
        Select all in this column{count > 0 ? ` (${count})` : ""}
      </button>
      {picking ? (
        <button type="button" role="menuitem" className="menu-item" onClick={onClear}>
          <CloseIcon size={13} />
          Clear the selection
        </button>
      ) : null}
    </div>
  );
}

/** The keyboard way to move a card (`m`): pick a column by its number, or with the arrows and Enter. */
function MovePicker({ board, card, onPick, onCancel }: { board: BoardPayload; card: CardSummary; onPick: (column: string) => void; onCancel: () => void }) {
  const current = Math.max(0, board.columns.findIndex((column) => column.id === card.column));
  const [index, setIndex] = useState(current);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.focus();
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const digit = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1;
    if (digit >= 0 && digit < board.columns.length) {
      event.preventDefault();
      onPick(board.columns[digit]!.id);
    } else if (event.key === "ArrowDown" || event.key === "j") {
      event.preventDefault();
      setIndex((value) => Math.min(board.columns.length - 1, value + 1));
    } else if (event.key === "ArrowUp" || event.key === "k") {
      event.preventDefault();
      setIndex((value) => Math.max(0, value - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      onPick(board.columns[index]!.id);
    } else if (event.key === "Escape" || event.key === "m") {
      event.preventDefault();
      onCancel();
    }
    event.stopPropagation();
  };
  return (
    <div
      className="popover move-picker"
      role="listbox"
      tabIndex={-1}
      ref={list}
      aria-label={`Move #${keyOf(card.id)} to`}
      aria-activedescendant={`move-${board.columns[index]?.id ?? ""}`}
      onKeyDown={onKeyDown}
      onClick={(event) => event.stopPropagation()}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onCancel();
      }}
      data-testid="move-picker"
    >
      <div className="popover-title">Move #{keyOf(card.id)} to</div>
      {board.columns.map((column, position) => (
        <button
          key={column.id}
          id={`move-${column.id}`}
          type="button"
          role="option"
          aria-selected={position === index}
          className={classes("move-option", position === index && "on", column.id === card.column && "here")}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(column.id)}
        >
          <kbd>{position + 1}</kbd>
          {column.name}
          {column.id === card.column ? <span className="here-note">here now</span> : null}
        </button>
      ))}
    </div>
  );
}

/** A new card, written in place (`n`, or the + of a column): type, title, description; it lands in this column. */
function Composer({ board, column, tags: startTags, onCancel, onCreate }: { board: BoardPayload; column: ColumnInfo; tags: string[]; onCancel: () => void; onCreate: (input: NewCardInput) => Promise<boolean> }) {
  // The project shown gives a new card its tag; the person can take it off before creating the card.
  const [tags, setTags] = useState<string[]>(startTags);
  const [type, setType] = useState(() => {
    try {
      const last = localStorage.getItem("pinboard.newType");
      if (last && board.types.includes(last)) return last;
    } catch {
      // No storage: the default type.
    }
    return board.types.includes("task") ? "task" : (board.types[0] ?? "note");
  });
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  // A mention in the description addresses that participant: `@` offers their names here too.
  const picker = useMentionPicker({ textarea: descriptionRef, value: description, onChange: setDescription, participants: board.participants, viewer: board.person.id });
  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    if (title.trim() === "" || busy) return;
    setBusy(true);
    try {
      localStorage.setItem("pinboard.newType", type);
    } catch {
      // No storage: nothing to remember.
    }
    const done = await onCreate({ type, title: title.trim(), column: column.id, ...(description.trim() !== "" ? { description } : {}), ...(tags.length > 0 ? { tags } : {}) });
    setBusy(false);
    if (done) onCancel();
  };
  return (
    <form
      className="composer"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void submit();
        }
      }}
      data-testid="composer"
    >
      <div className="composer-row">
        <label className="select select-small">
          <select value={type} onChange={(event) => setType(event.target.value)} aria-label="Type">
            {board.types.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
        <span className="composer-where">new card in {column.name}</span>
      </div>
      {tags.length > 0 ? (
        <div className="composer-tags" data-testid="composer-tags">
          {tags.map((tag) => (
            <span key={tag} className="chip chip-chosen">
              {tag}
              <button type="button" className="chip-x" onClick={() => setTags((current) => current.filter((entry) => entry !== tag))} aria-label={`Do not tag the new card ${tag}`} title={`Do not tag it ${tag}`}>
                <CloseIcon size={11} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <input ref={titleRef} className="field-input" placeholder="Title" value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Title" />
      <div className="mention-host">
        <textarea
          ref={descriptionRef}
          className="field-input"
          placeholder="Description (markdown, optional)"
          rows={3}
          value={description}
          onChange={(event) => {
            setDescription(event.target.value);
            picker.changed(event.target.value, event.target.selectionStart);
          }}
          aria-label="Description"
          {...picker.bind({})}
        />
        {picker.list}
      </div>
      <div className="composer-actions">
        <button type="submit" className="primary" disabled={title.trim() === "" || busy}>
          Create card
        </button>
        <button type="button" className="text-button" onClick={onCancel}>
          Cancel
        </button>
        <span className="hint">⌘↵ creates · Esc cancels</span>
      </div>
    </form>
  );
}
