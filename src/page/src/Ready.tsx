import { useState, type FormEvent, type ReactNode } from "react";
import type { BoardPayload } from "../../server/contract.js";
import { EditableList, EditableText, GrowingText, type Save } from "./Editors.js";
import { classes, columnName, FIELD_LABELS, type ReadyRefusal } from "./model.js";

/**
 * Ready on the page (core/ready.ts): the person puts a card there that an agent may pick up by
 * itself, once the card says how to tell it is done, what it may touch and its limit. A move there
 * that the board refuses comes back beside the card as `ReadyCheck`: the refusal's words, the three
 * things to fill in, and one button that saves them and moves the card. `ReadyFields` shows them on
 * the card once they are set.
 */

/**
 * On a board made before Ready, what to run to give it the column (the menus that move cards say it,
 * where Ready would be); nothing on a board that has it.
 */
export function NoReadyNote({ board }: { board: BoardPayload }) {
  if (board.ready.column !== undefined) return null;
  return (
    <p className="no-ready-note" data-testid="no-ready-note">
      No Ready column on this board yet, where you put a card an agent may pick up by itself. <code>{board.ready.command}</code> adds it.
    </p>
  );
}

function textOf(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function listOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(textOf).filter((entry) => entry.trim() !== "");
  const text = textOf(value);
  return text.trim() === "" ? [] : [text];
}

/** What the person writes in the Ready check: each thing as text, the list one a line. */
export interface ReadyDraft {
  doneWhen: string;
  mayTouch: string;
  limitMinutes: string;
  limitMoney: string;
}

/** The draft a card's fields give: what it says now. */
export function readyDraftOf(board: BoardPayload, fields: Record<string, unknown>): ReadyDraft {
  const names = board.ready.fields;
  return {
    doneWhen: textOf(fields[names.doneWhen]),
    mayTouch: listOf(fields[names.mayTouch]).join("\n"),
    limitMinutes: textOf(fields[names.limitMinutes]),
    limitMoney: textOf(fields[names.limitMoney])
  };
}

/**
 * The fields a draft changes, as the card's write takes them: each that differs from what the card
 * says, the list one entry a line, an emptied one removed (null). The board's process checks them
 * (a limit is a number) and the move checks the card.
 */
export function readyChanges(board: BoardPayload, fields: Record<string, unknown>, draft: ReadyDraft): Record<string, unknown> {
  const names = board.ready.fields;
  const now = readyDraftOf(board, fields);
  const changes: Record<string, unknown> = {};
  if (draft.doneWhen.trim() !== now.doneWhen.trim()) changes[names.doneWhen] = draft.doneWhen.trim() === "" ? null : draft.doneWhen.trim();
  const touch = draft.mayTouch
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (touch.join("\n") !== now.mayTouch) changes[names.mayTouch] = touch.length === 0 ? null : touch;
  for (const key of ["limitMinutes", "limitMoney"] as const) {
    if (draft[key].trim() !== now[key].trim()) changes[names[key]] = draft[key].trim() === "" ? null : draft[key].trim();
  }
  return changes;
}

/**
 * Beside a card the Ready check refused: the words of the refusal, the three things with what the
 * card says now (the missing ones marked), "Save and move to Ready", and "Not now".
 */
export function ReadyCheck({
  board,
  fields,
  refusal,
  onSave,
  onDismiss
}: {
  board: BoardPayload;
  fields: Record<string, unknown>;
  refusal: ReadyRefusal;
  /** Writes the changed fields and moves the card to Ready; the refusal's words when either is refused. */
  onSave: (changes: Record<string, unknown>) => Promise<string | null>;
  onDismiss: () => void;
}) {
  const [draft, setDraft] = useState<ReadyDraft>(() => readyDraftOf(board, fields));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = board.ready.column ? columnName(board, board.ready.column) : "Ready";
  const missing = new Set(refusal.missing.map((gap) => gap.what));
  const set = (key: keyof ReadyDraft) => (value: string) => setDraft((previous) => ({ ...previous, [key]: value }));
  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    if (busy) return;
    setBusy(true);
    const words = await onSave(readyChanges(board, fields, draft));
    setBusy(false);
    // A refusal of the Ready check comes back as the card's new refusal (the words above); any other shows here.
    setError(words !== null && words !== refusal.message ? words : null);
  };
  const field = (key: keyof ReadyDraft, what: string, label: string, hint: string, input: ReactNode): ReactNode => (
    <label className={classes("mini-field", "ready-field", missing.has(what) && "ready-missing")} data-testid={`ready-${key}`}>
      <span>
        {label} <span className="ready-hint">{hint}</span>
      </span>
      {input}
    </label>
  );
  return (
    <section className="ready-check" data-testid="ready-check" aria-label={`What the card needs before it goes to ${ready}`}>
      <div className="ready-check-label">Before it goes to {ready}</div>
      <p className="refusal" role="alert" data-testid="ready-check-words">
        {refusal.message}
      </p>
      <form
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onDismiss();
          }
        }}
      >
        {field(
          "doneWhen",
          "done-when",
          "Done when",
          "how anyone can tell it is done: a sentence, a command, a test",
          <GrowingText className="field-input" value={draft.doneWhen} onChange={set("doneWhen")} minRows={2} maxRows={8} aria-label="Done when" data-testid="ready-done-when-input" />
        )}
        {field(
          "mayTouch",
          "may-touch",
          "May touch",
          "a repository, a folder or files, one a line",
          <GrowingText className="field-input" value={draft.mayTouch} onChange={set("mayTouch")} minRows={2} maxRows={8} placeholder="src/auth/" aria-label="May touch" data-testid="ready-may-touch-input" />
        )}
        <div className={classes("ready-limits", missing.has("limit") && "ready-missing")} role="group" aria-label="The limit: in minutes, in money, or both">
          <span className="ready-limits-label">
            Limit <span className="ready-hint">in minutes, in money, or both: a number each</span>
          </span>
          <label className="mini-field">
            <span>minutes</span>
            <input className="field-input" inputMode="decimal" value={draft.limitMinutes} onChange={(event) => set("limitMinutes")(event.target.value)} placeholder="30" aria-label="Limit in minutes" data-testid="ready-minutes-input" />
          </label>
          <label className="mini-field">
            <span>money</span>
            <input className="field-input" inputMode="decimal" value={draft.limitMoney} onChange={(event) => set("limitMoney")(event.target.value)} placeholder="2.50" aria-label="Limit in money" data-testid="ready-money-input" />
          </label>
        </div>
        {error ? (
          <p className="refusal" role="alert">
            {error}
          </p>
        ) : null}
        <div className="editor-actions">
          <button type="submit" className="primary small" disabled={busy} data-testid="ready-save">
            Save and move to {ready}
          </button>
          <button type="button" className="text-button" onClick={onDismiss} data-testid="ready-dismiss">
            Not now
          </button>
          <span className="hint">⌘↵ saves · Esc closes</span>
        </div>
      </form>
    </section>
  );
}

/**
 * The three Ready things on the card's own view, once any is set (or while the card is in Ready),
 * each edited on its own as the type's fields are. A task's "done when" is its definition of done,
 * shown with the task's fields: here it is left out (`shownElsewhere`).
 */
export function ReadyFields({
  board,
  fields,
  updated,
  shownElsewhere,
  inReady,
  onSave
}: {
  board: BoardPayload;
  fields: Record<string, unknown>;
  updated: string;
  /** The fields the panel shows already (a task's definitionOfDone). */
  shownElsewhere: string[];
  inReady: boolean;
  onSave: (name: string) => Save<unknown>;
}) {
  const names = board.ready.fields;
  const ready = board.ready.column ? columnName(board, board.ready.column) : "Ready";
  const rows: Array<[string, ReactNode]> = [];
  if (!shownElsewhere.includes(names.doneWhen)) {
    rows.push([
      names.doneWhen,
      <EditableText
        label="done when"
        value={textOf(fields[names.doneWhen])}
        updated={updated}
        multiline
        onSave={onSave(names.doneWhen)}
        display={<p>{textOf(fields[names.doneWhen])}</p>}
        emptyWords="Not said yet: how anyone can tell it is done."
        testId="ready-show-done-when"
      />
    ]);
  }
  rows.push([
    names.mayTouch,
    <EditableList
      label="may touch"
      value={listOf(fields[names.mayTouch])}
      updated={updated}
      numbered={false}
      onSave={(items, expectUpdated) => onSave(names.mayTouch)(items.length === 0 ? null : items, expectUpdated)}
      emptyWords="Not said yet: a repository, a folder or files."
      render={(item) => <code>{item}</code>}
    />
  ]);
  for (const name of [names.limitMinutes, names.limitMoney]) {
    rows.push([
      name,
      <EditableText label={(FIELD_LABELS[name] ?? name).toLowerCase()} value={textOf(fields[name])} updated={updated} onSave={onSave(name)} display={<p>{textOf(fields[name])}</p>} emptyWords="—" testId={`ready-show-${name}`} />
    ]);
  }
  return (
    <section className="panel-section" data-testid="panel-ready">
      <div className="section-head">
        <h3>{inReady ? `In ${ready}: what an agent needs to work it alone` : `For ${ready}: what an agent needs to work it alone`}</h3>
      </div>
      <div className="fields">
        {rows.map(([name, editor]) => (
          <div key={name} className="field-row">
            <div className="field-name">{name === names.doneWhen ? "Done when" : (FIELD_LABELS[name] ?? name)}</div>
            <div className="field-value">{editor}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
