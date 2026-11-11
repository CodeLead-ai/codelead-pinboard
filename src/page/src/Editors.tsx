import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type TextareaHTMLAttributes } from "react";
import type { ParticipantInfo } from "../../server/contract.js";
import { CloseIcon, EditIcon, PlusIcon } from "./icons.js";
import { useMentionPicker } from "./Mentions.js";
import { classes, FOR_CODELEAD_TAG } from "./model.js";

/**
 * Editing a card is per field (spec 6.2), never a form that replaces the whole card. Each editor
 * keeps the card's `updated` from the moment editing began and sends it with the save, so a card
 * that changed meanwhile is refused (409) instead of overwritten; the refusal's words show under
 * the editor and the text stays in it. ⌘↵ (or Ctrl+Enter) saves, Esc cancels.
 */
export type Save<T> = (value: T, expectUpdated: string) => Promise<string | null>;

export function useEdit<T>(updated: string, save: Save<T>) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const since = useRef(updated);
  const latest = useRef(updated);
  latest.current = updated;
  /** Set by a refusal: the next save is made knowing the card as it was read again. */
  const knowsNewer = useRef(false);
  return {
    editing,
    error,
    busy,
    start: (): void => {
      since.current = updated;
      knowsNewer.current = false;
      setError(null);
      setEditing(true);
    },
    cancel: (): void => {
      setEditing(false);
      setError(null);
    },
    commit: async (value: T): Promise<void> => {
      if (knowsNewer.current) since.current = latest.current;
      setBusy(true);
      const refused = await save(value, since.current);
      setBusy(false);
      if (refused) {
        setError(refused);
        knowsNewer.current = true;
      } else {
        setEditing(false);
        setError(null);
      }
    }
  };
}

function editKeys(onSave: () => void, onCancel: () => void) {
  return (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSave();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };
}

/**
 * A textarea that grows with its text, up to a limit. With `mentions` (the board's participants),
 * typing `@` offers their names (Mentions.tsx): where a mention addresses someone, in a comment or
 * a description.
 */
export function GrowingText({
  value,
  onChange,
  minRows = 3,
  maxRows = 18,
  mentions,
  viewer,
  ...rest
}: { value: string; onChange: (value: string) => void; minRows?: number; maxRows?: number; mentions?: ParticipantInfo[] | undefined; viewer?: string | undefined } & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useMentionPicker({ textarea: ref, value, onChange, participants: mentions, viewer });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = "auto";
    const line = parseFloat(getComputedStyle(node).lineHeight) || 20;
    const padding = node.offsetHeight - node.clientHeight + parseFloat(getComputedStyle(node).paddingTop) + parseFloat(getComputedStyle(node).paddingBottom);
    node.style.height = `${Math.min(Math.max(node.scrollHeight, minRows * line + padding), maxRows * line + padding)}px`;
  }, [value, minRows, maxRows, rest.hidden]);
  const area = (
    <textarea
      ref={ref}
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
        picker.changed(event.target.value, event.target.selectionStart);
      }}
      {...rest}
      {...picker.bind(rest)}
    />
  );
  if (!mentions) return area;
  return (
    <div className={classes("mention-host", rest.hidden && "pane-hidden")}>
      {area}
      {picker.list}
    </div>
  );
}

function EditorButtons({ busy, onSave, onCancel, error, saveWords = "Save" }: { busy: boolean; onSave: () => void; onCancel: () => void; error: string | null; saveWords?: string }) {
  return (
    <>
      {error ? (
        <p className="refusal" role="alert">
          {error}
        </p>
      ) : null}
      <div className="editor-actions">
        <button type="button" className="primary small" onClick={onSave} disabled={busy}>
          {saveWords}
        </button>
        <button type="button" className="text-button" onClick={onCancel}>
          Cancel
        </button>
        <span className="hint">⌘↵ saves · Esc cancels</span>
      </div>
    </>
  );
}

export function EditButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="icon-button small edit-button" onClick={onClick} aria-label={`Edit ${label}`} title={`Edit ${label}`}>
      <EditIcon size={13} />
    </button>
  );
}

/** How a markdown text is edited: the source alone, its rendering alone, or the two side by side. */
export type PreviewMode = "write" | "preview" | "split";
const PREVIEW_MODES: Array<[PreviewMode, string]> = [
  ["write", "Write"],
  ["preview", "Preview"],
  ["split", "Side by side"]
];

/** An editor opens on the source, or side by side when that is how the person left the last one; the rendering alone is a look, not a way to open. */
function readPreviewMode(): PreviewMode {
  try {
    return localStorage.getItem("pinboard.preview") === "split" ? "split" : "write";
  } catch {
    return "write";
  }
}

/**
 * The mode a markdown text is seen in while it is written, kept across editors and comment boxes (card #284: the reply box
 * previews the same way as the description): "write" or "split" is remembered for the next one, "preview" is a look.
 */
export function usePreviewMode(): [PreviewMode, (next: PreviewMode) => void] {
  const [mode, setMode] = useState<PreviewMode>(readPreviewMode);
  const choose = (next: PreviewMode): void => {
    setMode(next);
    if (next === "preview") return;
    try {
      localStorage.setItem("pinboard.preview", next);
    } catch {
      // No storage: the choice lasts as long as the page.
    }
  };
  return [mode, choose];
}

/** The strip of the three modes: Write, Preview, Side by side. */
export function PreviewModes({ shown, onChoose, testId = "preview" }: { shown: PreviewMode; onChoose: (next: PreviewMode) => void; testId?: string }) {
  return (
    <div className="segmented preview-modes" role="group" aria-label="Write, or see it rendered" data-testid={`${testId}-modes`}>
      {PREVIEW_MODES.map(([entry, words]) => (
        <button key={entry} type="button" aria-pressed={shown === entry} className={classes(shown === entry && "on")} onClick={() => onChoose(entry)} data-testid={`${testId}-${entry}`}>
          {words}
        </button>
      ))}
    </div>
  );
}

/** The rendering of a draft beside or in place of its source; empty words when nothing is written yet. */
export function PreviewPane({ draft, preview, testId = "preview" }: { draft: string; preview: (draft: string) => ReactNode; testId?: string }) {
  return (
    <div className="preview-pane" data-testid={`${testId}-pane`} aria-label="How it will read">
      {draft.trim() === "" ? <p className="empty-words">Nothing written yet.</p> : preview(draft)}
    </div>
  );
}

/** A text field: one line, or markdown over several; shown as `display` until edited. With `preview`, the markdown can be seen rendered while it is edited. */
export function EditableText({
  label,
  value,
  updated,
  onSave,
  multiline = false,
  display,
  emptyWords,
  className,
  testId,
  preview,
  minRows = 4,
  mentions,
  viewer
}: {
  label: string;
  value: string;
  updated: string;
  onSave: Save<string>;
  multiline?: boolean;
  display: ReactNode;
  emptyWords: string;
  className?: string;
  testId?: string;
  /** Renders the draft as the card will show it (the same renderer as `display`). */
  preview?: (draft: string) => ReactNode;
  minRows?: number;
  /** The board's participants, offered after `@` (a description: a mention there addresses them). */
  mentions?: ParticipantInfo[];
  /** The page's person, last in that list. */
  viewer?: string;
}) {
  const edit = useEdit(updated, onSave);
  const [draft, setDraft] = useState(value);
  const [mode, choose] = usePreviewMode();
  const begunWith = useRef(value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (edit.editing) input.current?.focus();
  }, [edit.editing]);
  const begin = (): void => {
    begunWith.current = value;
    setDraft(value);
    edit.start();
  };
  const save = (): void => {
    void edit.commit(draft);
  };
  if (edit.editing) {
    const previewing = multiline && preview !== undefined;
    const shown = previewing ? mode : "write";
    return (
      <div className={classes("editor", className, previewing && `editor-${shown}`)} data-testid={testId ? `${testId}-editor` : undefined} onKeyDown={previewing ? editKeys(save, edit.cancel) : undefined}>
        {previewing ? <PreviewModes shown={shown} onChoose={choose} /> : null}
        {multiline ? (
          <div className="editor-panes">
            <GrowingText
              className={classes("field-input", shown === "preview" && "pane-hidden")}
              value={draft}
              onChange={setDraft}
              onKeyDown={previewing ? undefined : editKeys(save, edit.cancel)}
              autoFocus
              aria-label={label}
              minRows={minRows}
              hidden={shown === "preview"}
              mentions={mentions}
              viewer={viewer}
            />
            {previewing && shown !== "write" ? <PreviewPane draft={draft} preview={preview} /> : null}
          </div>
        ) : (
          <input ref={input} className="field-input" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={editKeys(save, edit.cancel)} aria-label={label} />
        )}
        <EditorButtons busy={edit.busy} onSave={save} onCancel={edit.cancel} error={edit.error} />
        {edit.error && value !== begunWith.current ? (
          // This very field changed meanwhile: what the card says now, to merge by hand before saving again.
          <div className="newer">
            <span className="newer-label">Now on the card</span>
            <p>{value === "" ? "(empty)" : value}</p>
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className={classes("editable", className)} data-testid={testId}>
      <div className="editable-value">{value.trim() === "" ? <p className="empty-words">{emptyWords}</p> : display}</div>
      <EditButton label={label} onClick={begin} />
    </div>
  );
}

/** A list field (options, what landed): one item per line when edited. */
export function EditableList({ label, value, updated, onSave, numbered, emptyWords, render }: { label: string; value: string[]; updated: string; onSave: Save<string[]>; numbered: boolean; emptyWords: string; render: (item: string) => ReactNode }) {
  const edit = useEdit(updated, onSave);
  const [draft, setDraft] = useState(value.join("\n"));
  const begin = (): void => {
    setDraft(value.join("\n"));
    edit.start();
  };
  const save = (): void => {
    void edit.commit(
      draft
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
    );
  };
  if (edit.editing) {
    return (
      <div className="editor">
        <GrowingText className="field-input" value={draft} onChange={setDraft} onKeyDown={editKeys(save, edit.cancel)} autoFocus aria-label={label} minRows={3} placeholder="One per line" />
        <EditorButtons busy={edit.busy} onSave={save} onCancel={edit.cancel} error={edit.error} />
      </div>
    );
  }
  return (
    <div className="editable">
      <div className="editable-value">
        {value.length === 0 ? (
          <p className="empty-words">{emptyWords}</p>
        ) : (
          <ol className={classes("field-list", numbered && "numbered")}>
            {value.map((item, index) => (
              <li key={`${index}-${item}`}>
                {numbered ? <span className="option-number">({index + 1})</span> : null}
                {render(item)}
              </li>
            ))}
          </ol>
        )}
      </div>
      <EditButton label={label} onClick={begin} />
    </div>
  );
}

export interface Decided {
  option: string;
  by: string;
  on: string;
}

/** The decision's `decided` (spec 5): which option, by whom, on which day. */
export function DecidedEditor({ value, options, people, person, updated, onSave, describe }: { value: Decided | undefined; options: string[]; people: Array<{ id: string; name: string }>; person: string; updated: string; onSave: Save<Decided | null>; describe: (decided: Decided) => ReactNode }) {
  const edit = useEdit(updated, onSave);
  const today = new Date().toISOString().slice(0, 10);
  const [draft, setDraft] = useState<Decided>(value ?? { option: options[0] ?? "", by: person, on: today });
  const begin = (): void => {
    setDraft(value ?? { option: options[0] ?? "", by: person, on: today });
    edit.start();
  };
  const save = (): void => {
    void edit.commit({ ...draft, option: draft.option.trim() });
  };
  if (edit.editing) {
    const listed = options.includes(draft.option);
    return (
      <div className="editor decided-editor" onKeyDown={editKeys(save, edit.cancel)}>
        <div className="decided-row">
          <label className="mini-field">
            <span>option</span>
            {options.length > 0 ? (
              <select className="field-input" value={listed ? draft.option : "__other"} onChange={(event) => setDraft({ ...draft, option: event.target.value === "__other" ? "" : event.target.value })}>
                {options.map((option, index) => (
                  <option key={option} value={option}>
                    ({index + 1}) {option.length > 60 ? `${option.slice(0, 59)}…` : option}
                  </option>
                ))}
                <option value="__other">another answer…</option>
              </select>
            ) : null}
            {!listed || options.length === 0 ? <input className="field-input" value={draft.option} onChange={(event) => setDraft({ ...draft, option: event.target.value })} placeholder="The answer" autoFocus /> : null}
          </label>
          <label className="mini-field">
            <span>by</span>
            <select className="field-input" value={draft.by} onChange={(event) => setDraft({ ...draft, by: event.target.value })}>
              {people.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
          <label className="mini-field">
            <span>on</span>
            <input className="field-input" type="date" value={draft.on.slice(0, 10)} onChange={(event) => setDraft({ ...draft, on: event.target.value })} />
          </label>
        </div>
        <EditorButtons busy={edit.busy} onSave={save} onCancel={edit.cancel} error={edit.error} saveWords="Record the decision" />
        {value ? (
          <button type="button" className="text-button danger" onClick={() => void edit.commit(null)}>
            Remove the decision
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="editable">
      <div className="editable-value">{value ? describe(value) : <p className="empty-words">Not decided yet.</p>}</div>
      {value ? (
        <EditButton label="the decision" onClick={begin} />
      ) : (
        <button type="button" className="secondary small" onClick={begin}>
          Record the decision
        </button>
      )}
    </div>
  );
}

/** The task's size: S, M or L; a click sets it, a click on the one set clears it. */
export function SizePicker({ value, updated, onSave }: { value: string | undefined; updated: string; onSave: Save<string | null> }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <div className="segmented" role="group" aria-label="Size">
        {["S", "M", "L"].map((size) => (
          <button
            key={size}
            type="button"
            aria-pressed={value === size}
            className={classes(value === size && "on")}
            onClick={async () => setError(await onSave(value === size ? null : size, updated))}
          >
            {size}
          </button>
        ))}
      </div>
      {error ? (
        <p className="refusal" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Tags as chips (spec 6.2), each removable, and one more added with Enter. */
export function TagEditor({ tags, known, updated, onAdd, onRemove }: { tags: string[]; known: string[]; updated: string; onAdd: Save<string>; onRemove: Save<string> }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const forCodeLead = tags.includes(FOR_CODELEAD_TAG);
  const toggleCodeLead = async (): Promise<void> => {
    if (sending) return;
    setSending(true);
    try {
      setError(await (forCodeLead ? onRemove : onAdd)(FOR_CODELEAD_TAG, updated));
    } finally {
      setSending(false);
    }
  };
  const add = async (): Promise<void> => {
    const tag = draft.trim();
    if (tag === "") return;
    const refused = await onAdd(tag, updated);
    setError(refused);
    if (!refused) {
      setDraft("");
      setAdding(false);
    }
  };
  return (
    <div className="tag-editor">
      <button type="button" className="secondary small" disabled={sending} onClick={() => void toggleCodeLead()} title={forCodeLead ? "Remove for:codelead; keep the card in this column" : "Add for:codelead; keep the card in this column"}>
        {forCodeLead ? "Take back from CodeLead" : "Send to CodeLead"}
      </button>
      {tags.map((tag) => (
        <span key={tag} className={classes("chip", tag.startsWith("repo:") && "chip-repo-plain", tag.startsWith("by:") && "chip-by", tag === FOR_CODELEAD_TAG && "chip-codelead")}>
          {tag === FOR_CODELEAD_TAG ? "CodeLead" : tag}
          <button type="button" className="chip-x" aria-label={`Remove the tag ${tag}`} title={`Remove ${tag}`} onClick={async () => setError(await onRemove(tag, updated))}>
            <CloseIcon size={10} />
          </button>
        </span>
      ))}
      {adding ? (
        <span className="tag-add">
          <input
            className="field-input tag-input"
            list="pinboard-known-tags"
            value={draft}
            autoFocus
            placeholder="tag, or repo:name"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void add();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setAdding(false);
                setDraft("");
              }
            }}
            onBlur={() => {
              if (draft.trim() === "") setAdding(false);
            }}
            aria-label="New tag"
          />
          <datalist id="pinboard-known-tags">
            {known.map((tag) => (
              <option key={tag} value={tag} />
            ))}
          </datalist>
        </span>
      ) : (
        <button type="button" className="chip chip-add" onClick={() => setAdding(true)} aria-label="Add a tag">
          <PlusIcon size={11} /> tag
        </button>
      )}
      {error ? (
        <p className="refusal" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
