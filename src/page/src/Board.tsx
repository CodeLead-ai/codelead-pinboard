import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { BoardPayload, CardSummary, ColumnInfo, NewCardInput } from "../../server/contract.js";
import { BubbleIcon, CollapseIcon, ExpandIcon, FlagIcon, GearIcon, PlusIcon, TypeChip } from "./icons.js";
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

/** Where a dragged card would land: in this column, below that card (null: at the top). */
interface DropPlace {
  column: string;
  after: string | null;
}

/**
 * The place under the pointer in a column: below the last tile whose middle the pointer has passed
 * (the dragged card itself left out), or the top.
 */
function placeAt(column: HTMLElement, clientY: number, dragged: string | null): string | null {
  let after: string | null = null;
  for (const tile of column.querySelectorAll<HTMLElement>(".column-body > .tile[data-card]")) {
    if (tile.dataset.card === dragged) continue;
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
  const shown = board.cards.filter((card) => onBoard(card, filter));
  const firstTile = board.columns.map((column) => columnCards(shown, column.id).find((card) => matches(card, filter))).find(Boolean);
  const tabStop = props.selected ?? (firstTile ? keyOf(firstTile.id) : null);

  return (
    <main className="board" aria-label="The board's columns">
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
            const after = collapsed ? null : placeAt(event.currentTarget, event.clientY, dragging);
            if (place?.column !== column.id || place.after !== after) setPlace({ column: column.id, after });
          },
          onDragLeave: (event: DragEvent<HTMLElement>) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPlace((current) => (current?.column === column.id ? null : current));
          },
          onDrop: (event: DragEvent<HTMLElement>) => {
            const key = event.dataTransfer.getData(CARD_TYPE);
            const after = collapsed ? null : placeAt(event.currentTarget, event.clientY, key || dragging);
            setPlace(null);
            setDragging(null);
            if (!key) return;
            event.preventDefault();
            props.onDrop(key, column.id, after);
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
        const landing = over ? (place!.after ?? visible.find((card) => keyOf(card.id) !== dragging)?.id ?? null) : null;
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
                <span className="column-tools">
                  <button type="button" className="icon-button small" onClick={() => props.onCompose(column.id)} aria-label={`New card in ${column.name}`} title={`New card in ${column.name}`}>
                    <PlusIcon size={14} />
                  </button>
                  <button type="button" className="icon-button small" onClick={() => props.onCollapse(column.id)} aria-label={`Collapse ${column.name}`} title={`Collapse ${column.name} to its name and count`}>
                    <CollapseIcon size={14} />
                  </button>
                </span>
              </div>
              {note ? <p className="column-note">{note}</p> : null}
            </header>
            <div className="column-body">
              {props.composer === column.id ? <Composer board={board} column={column} onCancel={() => props.onCompose(null)} onCreate={props.onCreate} /> : null}
              {visible.map((card) => {
                const key = keyOf(card.id);
                return (
                  <Tile
                    key={key}
                    board={board}
                    card={card}
                    faded={filtering && !matching.includes(card)}
                    selected={props.selected === key}
                    tabStop={tabStop === key}
                    unseen={props.unseen[key] ?? 0}
                    addressed={props.addressed[key] ?? 0}
                    flash={props.flashed.has(key)}
                    dragging={dragging === key}
                    landing={landing !== null && String(landing) === key ? landingSide : undefined}
                    now={props.now}
                    onSelect={() => props.onSelect(key)}
                    onOpen={() => props.onOpen(key)}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(CARD_TYPE, key);
                      event.dataTransfer.setData("text/plain", `#${key}`);
                      event.dataTransfer.effectAllowed = "move";
                      setDragging(key);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
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

function Tile({ board, card, faded, selected, tabStop, unseen, addressed, flash, dragging, landing, now, onSelect, onOpen, onDragStart, onDragEnd, register, children }: TileProps) {
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
        flash && "tile-flash",
        dragging && "tile-dragging",
        card.archived && "tile-archived",
        card.color && "tile-colored",
        !card.last && "tile-no-excerpt",
        landing && `landing-${landing}`
      )}
      role="button"
      tabIndex={tabStop ? 0 : -1}
      aria-label={`#${key} ${card.type}: ${card.title}${colorName ? `, marked ${colorName}` : ""}${unseen > 0 ? `, ${unseen} new` : ""}${addressed > 0 ? ", addressed to you" : ""}`}
      aria-describedby={describedBy || undefined}
      draggable
      data-card={key}
      onFocus={onSelect}
      onClick={() => {
        onSelect();
        onOpen();
      }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="tile-top">
        <TypeChip type={card.type} types={board.types} size={12} />
        <span className="tile-type">{card.type}</span>
        {card.proposal ? (
          <span className="tile-proposed" title={`${participantName(board, card.author)} proposed it; it looks like this until you touch it.`}>
            proposed
          </span>
        ) : null}
        {card.archived ? <span className="tile-proposed">archived</span> : null}
        <span className="tile-id">#{key}</span>
        {addressed > 0 ? (
          <span className="tile-mention" title={`Addressed to you since you last looked${addressed > 1 ? ` (${addressed} times)` : ""}: a comment or the description mentions you`} aria-hidden="true" data-testid="tile-mention">
            @you
          </span>
        ) : null}
        {unseen > 0 ? <span className="tile-unseen" title={`${unseen} new since you last looked`} aria-hidden="true" /> : null}
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
function Composer({ board, column, onCancel, onCreate }: { board: BoardPayload; column: ColumnInfo; onCancel: () => void; onCreate: (input: NewCardInput) => Promise<boolean> }) {
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
    const done = await onCreate({ type, title: title.trim(), column: column.id, ...(description.trim() !== "" ? { description } : {}) });
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
