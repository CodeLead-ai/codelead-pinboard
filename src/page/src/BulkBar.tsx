import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { BoardPayload, CardSummary } from "../../server/contract.js";
import { ArchiveIcon, CloseIcon, FolderIcon, TagIcon } from "./icons.js";
import { classes, keyOf, plural } from "./model.js";
import { PROJECT_PREFIX } from "./projects.mjs";
import { NoReadyNote } from "./Ready.js";

export type BulkAction = "move" | "archive" | "add-tag" | "remove-tag" | "project";

export interface BulkBarProps {
  board: BoardPayload;
  /** The picked cards' keys, in the board's order. */
  picked: string[];
  /** The projects found on the cards, for "Set project…". */
  projects: string[];
  /** Every tag on the board, for "Add tag…". */
  knownTags: string[];
  busy: boolean;
  onMove: (to: string) => void;
  onArchive: () => void;
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
  onSetProject: (name: string, replace: boolean) => void;
  onClear: () => void;
}

/**
 * The bar the picked cards bring up ("7 selected"): move them, archive them, add or remove a tag, set
 * their project, or clear the pick. Each asks once, in a dialog that names how many cards it changes;
 * what happened comes back as a message with an Undo (App.tsx).
 */
export function BulkBar(props: BulkBarProps) {
  const [dialog, setDialog] = useState<BulkAction | null>(null);
  const count = props.picked.length;
  const button = (action: BulkAction, words: string, icon?: ReactNode) => (
    <button type="button" className="bulk-action" onClick={() => setDialog(action)} disabled={props.busy} data-testid={`bulk-${action}`}>
      {icon}
      {words}
    </button>
  );
  return (
    <>
      <div className="bulk-bar" role="toolbar" aria-label={`${plural(count, "card")} selected`} data-testid="bulk-bar">
        <span className="bulk-count" aria-live="polite" data-testid="bulk-count">
          <b>{count}</b> selected
        </span>
        <span className="bulk-sep" aria-hidden="true" />
        {button("move", "Move to…")}
        {button("archive", "Archive", <ArchiveIcon size={14} />)}
        {button("add-tag", "Add tag…", <TagIcon size={14} />)}
        {button("remove-tag", "Remove tag…")}
        {button("project", "Set project…", <FolderIcon size={14} />)}
        <span className="bulk-sep" aria-hidden="true" />
        <button type="button" className="bulk-action bulk-clear" onClick={props.onClear} title="Clear the selection (Esc)" data-testid="bulk-clear">
          <CloseIcon size={13} />
          Clear
        </button>
      </div>
      {dialog ? <BulkDialog action={dialog} {...props} onClose={() => setDialog(null)} /> : null}
    </>
  );
}

function BulkDialog({ action, board, picked, projects, knownTags, onMove, onArchive, onAddTag, onRemoveTag, onSetProject, onClose }: BulkBarProps & { action: BulkAction; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const count = picked.length;
  const cards = useMemo(() => {
    const keys = new Set(picked);
    return board.cards.filter((card) => keys.has(keyOf(card.id)));
  }, [board.cards, picked]);
  const [column, setColumn] = useState("");
  const [text, setText] = useState("");
  const [replace, setReplace] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const tagsOnCards = useMemo(() => tagCounts(cards), [cards]);
  const [tag, setTag] = useState(() => tagCounts(cards)[0]?.[0] ?? "");

  useEffect(() => {
    const element = ref.current;
    if (element && !element.open) element.showModal();
    return () => element?.close();
  }, []);

  const cardsWords = plural(count, "card");
  let title: string;
  let body: ReactNode;
  let confirm: string;
  let ready = true;
  let run: () => void;

  switch (action) {
    case "move": {
      const target = board.columns.find((entry) => entry.id === column);
      title = `Move ${cardsWords}`;
      body = (
        <div className="bulk-choices" role="radiogroup" aria-label="The column">
          {board.columns.map((entry) => (
            <label key={entry.id} className={classes("bulk-choice", column === entry.id && "on")}>
              <input type="radio" name="bulk-column" value={entry.id} checked={column === entry.id} onChange={() => setColumn(entry.id)} />
              <span>{entry.name}</span>
              {entry.id === board.ready.column ? (
                <span className="bulk-note">yours: an agent may pick these up; each card must say how to tell it is done, what it may touch and its limit</span>
              ) : entry.owner === "person" ? (
                <span className="bulk-note">yours: agents never move cards here</span>
              ) : null}
              <span className="bulk-note bulk-count-note">{cards.filter((card) => card.column === entry.id).length > 0 ? `${cards.filter((card) => card.column === entry.id).length} there now` : ""}</span>
            </label>
          ))}
          <NoReadyNote board={board} />
        </div>
      );
      confirm = target ? `Move ${cardsWords} to ${target.name}` : "Move";
      ready = target !== undefined;
      run = () => onMove(column);
      break;
    }
    case "archive":
      title = `Archive ${cardsWords}?`;
      body = <p>They leave the board and stay in their files; the filter's <b>archived</b> shows them again, and Undo brings them back.</p>;
      confirm = `Archive ${cardsWords}`;
      run = onArchive;
      break;
    case "add-tag":
      title = `Add a tag to ${cardsWords}`;
      body = (
        <label className="bulk-field">
          <span>The tag</span>
          <input className="field-input" list="bulk-known-tags" value={text} onChange={(event) => setText(event.target.value)} placeholder="area:auth" autoFocus data-testid="bulk-tag-input" />
          <datalist id="bulk-known-tags">
            {knownTags.filter((entry) => !entry.startsWith(PROJECT_PREFIX)).map((entry) => (
              <option key={entry} value={entry} />
            ))}
          </datalist>
        </label>
      );
      confirm = `Add the tag to ${cardsWords}`;
      ready = text.trim() !== "";
      run = () => onAddTag(text.trim());
      break;
    case "remove-tag":
      title = `Remove a tag from ${cardsWords}`;
      body =
        tagsOnCards.length === 0 ? (
          <p>None of these cards has a tag.</p>
        ) : (
          <div className="bulk-choices" role="radiogroup" aria-label="The tag">
            {tagsOnCards.map(([name, on]) => (
              <label key={name} className={classes("bulk-choice", tag === name && "on")}>
                <input type="radio" name="bulk-tag" value={name} checked={tag === name} onChange={() => setTag(name)} />
                <span className="bulk-tag">{name}</span>
                <span className="bulk-note">on {plural(on, "card")}</span>
              </label>
            ))}
          </div>
        );
      confirm = tag ? `Remove ${tag} from ${plural(tagsOnCards.find(([name]) => name === tag)?.[1] ?? 0, "card")}` : "Remove";
      ready = tag !== "";
      run = () => onRemoveTag(tag);
      break;
    case "project":
      title = `Set the project of ${cardsWords}`;
      body = (
        <>
          <label className="bulk-field">
            <span>The project (an existing one, or a new name)</span>
            <input
              className="field-input"
              list="bulk-projects"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setProblem(null);
              }}
              placeholder={projects[0] ?? "my-app"}
              autoFocus
              data-testid="bulk-project-input"
            />
            <datalist id="bulk-projects">
              {projects.map((entry) => (
                <option key={entry} value={entry} />
              ))}
            </datalist>
          </label>
          <label className="check bulk-replace">
            <input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} data-testid="bulk-project-replace" />
            Replace their other project (remove its tag)
          </label>
          <p className="bulk-hint">
            {text.trim() !== "" && !projects.includes(text.trim()) ? (
              <>
                A new project: the cards get the tag <code>{PROJECT_PREFIX}{text.trim()}</code>.
              </>
            ) : (
              <>The cards get the project's tag; without "replace", a card keeps the project it has too.</>
            )}
          </p>
          {problem ? <p className="refusal">{problem}</p> : null}
        </>
      );
      confirm = `Set the project on ${cardsWords}`;
      ready = text.trim() !== "";
      run = () => {
        const name = text.trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
          setProblem('A project\'s name is one word of letters, digits, ".", "-" and "_", starting with a letter or a digit.');
          throw new Error("not a project name");
        }
        onSetProject(name, replace);
      };
      break;
  }

  const submit = (event?: FormEvent): void => {
    event?.preventDefault();
    if (!ready) return;
    try {
      run();
    } catch {
      return;
    }
    onClose();
  };

  return (
    <dialog
      ref={ref}
      className="confirm bulk-dialog"
      aria-labelledby="bulk-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      data-testid="bulk-dialog"
    >
      <form onSubmit={submit}>
        <h2 id="bulk-dialog-title">{title}</h2>
        {body}
        <div className="confirm-actions">
          <button type="submit" className="primary" disabled={!ready} autoFocus={action === "archive"} data-testid="bulk-confirm">
            {confirm}
          </button>
          <button type="button" className="text-button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** The tags on the picked cards, with how many carry each, most first. */
function tagCounts(cards: CardSummary[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const card of cards) for (const tag of card.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}
