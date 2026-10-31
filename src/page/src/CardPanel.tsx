import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import type { BoardPayload, CardChangesInput, CardColor, CardDetail } from "../../server/contract.js";
import { DecidedEditor, EditableList, EditableText, GrowingText, SizePicker, TagEditor, type Decided } from "./Editors.js";
import { ActivityIcon, ArchiveIcon, ChevronDown, ChevronLeft, CloseIcon, FileIcon, TypeChip } from "./icons.js";
import { Markdown } from "./Markdown.js";
import { ago, classes, clock, columnName, FIELD_LABELS, isAgent, LIST_FIELDS, MARKDOWN_FIELDS, participantName, plural, RELATION_WORDS } from "./model.js";

/** A decision's ask is shown at the top of its panel, not among the decision's other fields. */
const ASK = "ask";

export interface PanelActions {
  update: (id: string, expectUpdated: string, changes: CardChangesInput) => Promise<string | null>;
  /** Shows a refusal of a one-click action (no editor around it to show it in). */
  say: (words: string) => void;
  comment: (id: string, body: string, expectUpdated: string, moveTo?: string) => Promise<string | null>;
  move: (id: string, to: string, expectUpdated: string) => Promise<string | null>;
  archive: (id: string) => void;
  openRelated: (id: string) => void;
  back: () => void;
  crumb: (index: number) => void;
  close: () => void;
}

export interface CardPanelProps {
  board: BoardPayload;
  id: string;
  detail: CardDetail | undefined;
  error: string | undefined;
  /** How far below the top of the stack this panel is (0: the top, the one in use). */
  below: number;
  crumbs: Array<{ id: string; title: string }>;
  cards: ReadonlySet<string>;
  knownTags: string[];
  now: number;
  /** Scroll to the thread once loaded (opened from a notification about a comment). */
  toThread: boolean;
  onThreadShown: () => void;
  actions: PanelActions;
}

function Section({ title, children, aside, testId }: { title: ReactNode; children: ReactNode; aside?: ReactNode; testId?: string }) {
  return (
    <section className="panel-section" data-testid={testId}>
      <div className="section-head">
        <h3>{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function textOf(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function listOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(textOf);
  if (value === undefined || value === null || value === "") return [];
  return [textOf(value)];
}

function decidedOf(value: unknown): Decided | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return typeof value === "string" && value !== "" ? { option: value, by: "", on: "" } : undefined;
  const entry = value as Record<string, unknown>;
  return { option: textOf(entry.option), by: textOf(entry.by), on: textOf(entry.on) };
}

/** The card (spec 6.2): a panel over the board, in reading order, every field edited on its own. */
export function CardPanel({ board, id, detail, error, below, crumbs, cards, knownTags, now, toThread, onThreadShown, actions }: CardPanelProps) {
  const top = below === 0;
  const threadRef = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!toThread || !detail) return;
    threadRef.current?.scrollIntoView({ block: "start" });
    onThreadShown();
  }, [toThread, detail, onThreadShown]);

  useEffect(() => {
    if (top) scroller.current?.focus({ preventScroll: true });
  }, [top, id]);

  const card = detail?.card;
  const lastColumn = board.columns[board.columns.length - 1]?.id;
  const type = card?.type ?? "";
  const typed = board.typeFields[type] ?? [];
  const isDecision = typed.includes(ASK);
  const shownFields = typed.filter((name) => name !== ASK);
  // Fields the card keeps from another type (an idea that became a task keeps its hypothesis).
  const otherFields = card ? Object.keys(card.fields).filter((name) => !typed.includes(name)) : [];
  const ask = card ? textOf(card.fields[ASK]) : "";
  const markdown = (text: string, className?: string): ReactNode => (
    <Markdown text={text} mentions={detail?.mentions} cards={cards} onOpenCard={actions.openRelated} {...(className ? { className } : {})} />
  );
  /** A description: where a mention addresses a participant, it shows as their chip. */
  const addressing = (text: string): ReactNode => (
    <Markdown text={text} mentions={detail?.mentions} cards={cards} participants={board.participants} viewer={board.person.id} onOpenCard={actions.openRelated} />
  );
  const saveField = (name: string) => (value: unknown, expectUpdated: string) => actions.update(id, expectUpdated, { fields: { [name]: value === "" ? null : value } });
  /** A one-click change: its refusal, if any, goes to the message bar. */
  const act = async (changes: CardChangesInput): Promise<void> => {
    if (!card) return;
    const refused = await actions.update(id, card.updated, changes);
    if (refused) actions.say(refused);
  };

  return (
    <aside
      className={classes("panel", top && "panel-top")}
      style={{ ["--below" as string]: below }}
      aria-label={card ? `Card #${id}: ${card.title}` : `Card #${id}`}
      inert={!top}
      data-testid={top ? "panel" : "panel-below"}
      data-card={id}
    >
      <div className="panel-scroll" ref={scroller} tabIndex={-1}>
        <div className="panel-bar">
          {crumbs.length > 1 ? (
            <nav className="crumbs" aria-label="The cards open on top of each other">
              <button type="button" className="back" onClick={actions.back} title="Back to the card below (Esc)">
                <ChevronLeft size={14} /> Back
              </button>
              {crumbs.map((crumb, index) =>
                index < crumbs.length - 1 ? (
                  <span key={crumb.id} className="crumb">
                    <button type="button" onClick={() => actions.crumb(index)}>
                      #{crumb.id} {crumb.title}
                    </button>
                    <span className="crumb-sep" aria-hidden="true">
                      ›
                    </span>
                  </span>
                ) : (
                  <span key={crumb.id} className="crumb crumb-here" aria-current="page">
                    #{crumb.id}
                  </span>
                )
              )}
            </nav>
          ) : null}
          <div className="panel-controls">
            {card ? (
              <>
                <label className="select select-small type-select" title="The card's type">
                  <TypeChip type={card.type} types={board.types} size={12} small />
                  <select value={card.type} onChange={(event) => void act({ type: event.target.value })} aria-label="Type" data-testid="panel-type">
                    {board.types.map((entry) => (
                      <option key={entry} value={entry}>
                        {entry}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={12} className="select-chevron" />
                </label>
                <span className="panel-id">#{id}</span>
                <label className="select select-small column-select" title="Move the card: it moves behind the panel (m)">
                  <select value={card.column} onChange={(event) => void actions.move(id, event.target.value, card.updated)} aria-label="Column" data-testid="panel-column">
                    {board.columns.map((column) => (
                      <option key={column.id} value={column.id}>
                        {column.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={12} className="select-chevron" />
                </label>
              </>
            ) : (
              <span className="panel-id">#{id}</span>
            )}
            <span className="grow" />
            {card && card.column === lastColumn && !card.archived ? (
              <button type="button" className="secondary small" onClick={() => actions.archive(id)} title="Archive: it leaves the board and stays in its file" data-testid="archive">
                <ArchiveIcon size={14} /> Archive
              </button>
            ) : null}
            <button type="button" className="icon-button" onClick={actions.close} aria-label="Close the card" title="Close (Esc closes the top card)" data-testid="panel-close">
              <CloseIcon size={16} />
            </button>
          </div>
        </div>

        {!card ? (
          <div className="panel-body">{error ? <p className="refusal">{error}</p> : <p className="loading">Reading card #{id}…</p>}</div>
        ) : (
          <div className="panel-body">
            <TagEditor
              tags={card.tags}
              known={knownTags.filter((tag) => !card.tags.includes(tag))}
              updated={card.updated}
              onAdd={(tag, expectUpdated) => actions.update(id, expectUpdated, { addTags: [tag] })}
              onRemove={(tag, expectUpdated) => actions.update(id, expectUpdated, { removeTags: [tag] })}
            />
            <ColorPicker colors={board.colors} value={card.color} onPick={(color) => act({ color })} />

            <EditableText
              label="the title"
              value={card.title}
              updated={card.updated}
              onSave={(value, expectUpdated) => actions.update(id, expectUpdated, { title: value })}
              display={<h1 className="panel-title">{card.title}</h1>}
              emptyWords="No title."
              className="title-edit"
              testId="panel-title"
            />

            {isDecision ? (
              <section className={classes("ask-block", ask === "" && "ask-block-missing")} data-testid="panel-ask" aria-label="The decision asked of you">
                <div className="ask-label">Asked of you</div>
                <EditableText
                  label="the ask"
                  value={ask}
                  updated={card.updated}
                  multiline
                  minRows={3}
                  onSave={(value, expectUpdated) => actions.update(id, expectUpdated, { fields: { [ASK]: value.trim() === "" ? null : value } })}
                  display={markdown(ask, "ask-text")}
                  preview={(draft) => markdown(draft, "ask-text")}
                  emptyWords="Ask not written yet: in one to three sentences, what is decided, the options and the recommendation."
                  testId="panel-ask-text"
                />
              </section>
            ) : null}

            <dl className="front-matter" aria-label="The card's front matter">
              <div>
                <dt>Author</dt>
                <dd>
                  {participantName(board, card.author)}
                  {isAgent(board, card.author) ? <span className="badge">agent</span> : null}
                </dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>
                  <time dateTime={card.created} title={card.created}>
                    {clock(card.created, now)}
                  </time>
                </dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>
                  <time dateTime={card.updated} title={card.updated}>
                    {ago(card.updated, now)}
                  </time>
                </dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  <EditableText
                    label="the status"
                    value={card.status ?? ""}
                    updated={card.updated}
                    onSave={(value, expectUpdated) => actions.update(id, expectUpdated, { status: value.trim() === "" ? null : value })}
                    display={<span>{card.status}</span>}
                    emptyWords="—"
                  />
                </dd>
              </div>
              {card.session ? (
                <div className="wide">
                  <dt>Session</dt>
                  <dd className="mono" title="The agent session the card came from">
                    {card.session}
                  </dd>
                </div>
              ) : null}
              <div className="wide">
                <dt>File</dt>
                <dd className="mono">{card.file}</dd>
              </div>
              {Object.entries(card.extra).map(([key, value]) => (
                <div key={key} className="wide">
                  <dt>{key}</dt>
                  <dd className="mono">{textOf(value)}</dd>
                </div>
              ))}
            </dl>

            {detail.problems.length > 0 ? (
              <p className="banner banner-warn" role="alert">
                This card's file has problems, so writes to it are refused until they are fixed: {detail.problems.join("; ")}. `codelead board validate` lists them.
              </p>
            ) : null}
            {card.archived ? <p className="banner">Archived {clock(card.archived, now)}: off the board, kept in its file.</p> : null}

            <Section title="Description" testId="panel-description">
              <EditableText
                label="the description"
                value={card.description}
                updated={card.updated}
                multiline
                onSave={(value, expectUpdated) => actions.update(id, expectUpdated, { description: value })}
                display={addressing(card.description)}
                preview={(draft) => addressing(draft)}
                emptyWords="No description yet."
                mentions={board.participants}
                viewer={board.person.id}
              />
            </Section>

            {shownFields.length > 0 || otherFields.length > 0 ? (
              <Section title={type.charAt(0).toUpperCase() + type.slice(1)} testId="panel-fields">
                <div className="fields">
                  {shownFields.map((name) => {
                    const value = card.fields[name];
                    const label = FIELD_LABELS[name] ?? name;
                    let editor: ReactNode;
                    if (name === "decided") {
                      editor = (
                        <DecidedEditor
                          value={decidedOf(value)}
                          options={listOf(card.fields.options)}
                          people={board.participants}
                          person={board.person.id}
                          updated={card.updated}
                          onSave={saveField("decided")}
                          describe={(decided) => (
                            <p className="decided">
                              <b>{decided.option}</b>
                              {decided.by ? ` · by ${participantName(board, decided.by)}` : ""}
                              {decided.on ? ` · on ${decided.on}` : ""}
                            </p>
                          )}
                        />
                      );
                    } else if (name === "size") {
                      editor = <SizePicker value={textOf(value) || undefined} updated={card.updated} onSave={saveField("size")} />;
                    } else if (LIST_FIELDS.has(name)) {
                      editor = (
                        <EditableList
                          label={label.toLowerCase()}
                          value={listOf(value)}
                          updated={card.updated}
                          numbered={name === "options"}
                          onSave={(items, expectUpdated) => actions.update(id, expectUpdated, { fields: { [name]: items.length === 0 ? null : items } })}
                          emptyWords={name === "options" ? "No options listed." : "Nothing landed yet."}
                          render={(item) => <Markdown text={item} mentions={detail.mentions} cards={cards} onOpenCard={actions.openRelated} className="md-inline" />}
                        />
                      );
                    } else {
                      const multiline = MARKDOWN_FIELDS.has(name);
                      editor = (
                        <EditableText
                          label={label.toLowerCase()}
                          value={textOf(value)}
                          updated={card.updated}
                          multiline={multiline}
                          onSave={saveField(name)}
                          display={multiline ? markdown(textOf(value)) : <p>{textOf(value)}</p>}
                          {...(multiline ? { preview: (draft: string) => markdown(draft) } : {})}
                          emptyWords="—"
                        />
                      );
                    }
                    return (
                      <div key={name} className="field-row">
                        <div className="field-name">{label}</div>
                        <div className="field-value">{editor}</div>
                      </div>
                    );
                  })}
                  {otherFields.map((name) => (
                    <div key={name} className="field-row field-other">
                      <div className="field-name" title={`Not a field of a ${type}; the card keeps it from before.`}>
                        {FIELD_LABELS[name] ?? name}
                      </div>
                      <div className="field-value editable">
                        <div className="editable-value">
                          <p className="mono">{listOf(card.fields[name]).join(" · ")}</p>
                        </div>
                        <button type="button" className="chip-x" aria-label={`Remove the field ${name}`} title="Remove this field" onClick={() => void act({ fields: { [name]: null } })}>
                          <CloseIcon size={10} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            ) : null}

            <div className="panel-pair">
              <Section title={`Related (${detail.relations.length})`} testId="panel-related">
                {detail.relations.length === 0 ? <p className="empty-words">No related cards.</p> : null}
                <ul className="relations">
                  {detail.relations.map((relation) => (
                    <li key={`${relation.kind}-${String(relation.to)}-${String(relation.statedBy)}`}>
                      <span className="rel-kind">{RELATION_WORDS[relation.kind] ?? relation.kind}</span>
                      <button type="button" className="rel-card" onClick={() => actions.openRelated(String(relation.to))} disabled={relation.title === undefined} title={relation.title ? "Open it on top" : "Not on the board"}>
                        {relation.type ? <TypeChip type={relation.type} types={board.types} size={11} small /> : null}
                        <span className="rel-id">#{String(relation.to)}</span>
                        <span className="rel-title">{relation.title ?? "not on the board"}</span>
                      </button>
                      <span className="rel-column">{relation.archived ? "archived" : relation.column ? columnName(board, relation.column) : ""}</span>
                      {relation.own ? (
                        <button type="button" className="chip-x" aria-label={`Remove the relation ${relation.kind} #${String(relation.to)}`} title="Remove the relation" onClick={() => void act({ removeRelations: [{ kind: relation.kind, to: relation.to }] })}>
                          <CloseIcon size={10} />
                        </button>
                      ) : (
                        <span className="rel-stated" title={`Card #${String(relation.statedBy)} states this relation; it is changed there.`}>
                          stated by #{String(relation.statedBy)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                <RelationAdder board={board} id={id} kinds={board.relationKinds} onAdd={(kind, to) => actions.update(id, card.updated, { addRelations: [{ kind, to }] })} />
              </Section>

              <Section title={`Attachments (${detail.attachments.length})`} testId="panel-attachments">
                {detail.attachments.length === 0 ? <p className="empty-words">No attachments.</p> : null}
                <ul className="attachments">
                  {detail.attachments.map((attachment) => (
                    <li key={attachment.label}>
                      <FileIcon size={13} />
                      {attachment.href ? (
                        <a className="ref ref-path" href={attachment.href} title="Open in the editor">
                          {attachment.label}
                        </a>
                      ) : (
                        <span className="plain-path" title={attachment.exists ? "A folder" : "Not on this machine"}>
                          {attachment.label}
                          {attachment.exists ? null : <span className="muted"> · not here</span>}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                <AttachmentAdder onAdd={(path, lines) => actions.update(id, card.updated, { addAttachments: [{ path, ...(lines ? { lines } : {}) }] })} />
              </Section>
            </div>

            <div ref={threadRef} className="thread-anchor" />
            <Section title={`Thread (${card.thread.length})`} testId="panel-thread">
              {card.thread.length === 0 ? <p className="empty-words">No comments yet. Write the first one below; an agent sees it on its next check.</p> : null}
              <ol className="thread">
                {card.thread.map((comment, index) => {
                  const agent = isAgent(board, comment.author);
                  const name = participantName(board, comment.author);
                  return (
                    <li key={`${comment.at}-${index}`} className={classes("comment", agent && "comment-agent")} data-testid="comment">
                      <div className="comment-head">
                        <span className={classes("avatar", agent ? "avatar-agent" : "avatar-person")} aria-hidden="true">
                          {name.charAt(0).toUpperCase()}
                        </span>
                        <b className="comment-who">{name}</b>
                        {agent ? <span className="badge">agent</span> : null}
                        <time dateTime={comment.at} title={comment.at}>
                          {clock(comment.at, now)}
                        </time>
                      </div>
                      <Markdown
                        text={comment.body}
                        mentions={detail.mentions}
                        cards={cards}
                        participants={board.participants}
                        viewer={board.person.id}
                        onOpenCard={actions.openRelated}
                        className="comment-body"
                      />
                    </li>
                  );
                })}
              </ol>
              <Reply board={board} column={card.column} onSend={(body, moveTo) => actions.comment(id, body, card.updated, moveTo)} />
            </Section>

            <details className="panel-more" data-testid="panel-activity">
              <summary>
                <ActivityIcon size={14} /> Activity ({plural(detail.activity.length, "event")})
              </summary>
              <ol className="activity">
                {detail.activity.map((event, index) => (
                  <li key={`${event.position ?? index}`}>
                    <b className={event.by === "unknown" ? "note-unknown" : undefined}>{event.byName}</b> {event.text}
                    <time dateTime={event.at} title={event.at}>
                      {clock(event.at, now)}
                    </time>
                  </li>
                ))}
              </ol>
            </details>
          </div>
        )}
      </div>
    </aside>
  );
}

/** The reply box (spec 6.2): Comment, or Comment & move in one step ("answered, to Done"). */
function Reply({ board, column, onSend }: { board: BoardPayload; column: string; onSend: (body: string, moveTo?: string) => Promise<string | null> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const away = (event: PointerEvent): void => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenu(false);
    };
    // Esc closes the menu, not the card.
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMenu(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape, true);
    };
  }, [menu]);
  const send = async (moveTo?: string): Promise<void> => {
    if (text.trim() === "" || busy) return;
    setBusy(true);
    const refused = await onSend(text, moveTo);
    setBusy(false);
    setMenu(false);
    if (refused) setError(refused);
    else {
      setText("");
      setError(null);
    }
  };
  const empty = text.trim() === "";
  return (
    <div className="reply" data-testid="reply">
      <GrowingText
        className="field-input"
        value={text}
        onChange={setText}
        minRows={3}
        maxRows={14}
        placeholder="Write a comment (markdown); type @ to address someone…"
        aria-label="Write a comment"
        mentions={board.participants}
        viewer={board.person.id}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send();
          }
        }}
        data-testid="reply-text"
      />
      {error ? (
        <p className="refusal" role="alert">
          {error}
        </p>
      ) : null}
      <div className="reply-actions">
        <span className="hint">Markdown · ⌘↵ sends</span>
        <span className="grow" />
        <button type="button" className="primary" onClick={() => void send()} disabled={empty || busy} data-testid="reply-send">
          Comment
        </button>
        <div className="split" ref={menuRef}>
          <button type="button" className="secondary" onClick={() => setMenu(!menu)} disabled={empty || busy} aria-expanded={menu} aria-haspopup="menu" data-testid="reply-move">
            Comment &amp; move <ChevronDown size={13} />
          </button>
          {menu ? (
            <div className="popover move-menu" role="menu">
              <div className="popover-title">Comment, then move to</div>
              {board.columns
                .filter((entry) => entry.id !== column)
                .map((entry) => (
                  <button key={entry.id} type="button" role="menuitem" className="move-option" onClick={() => void send(entry.id)}>
                    {entry.name}
                  </button>
                ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The person's colour mark (below the tags): five swatches of the "Matte Rainbow" palette and none.
 * The one the card carries is ringed; it shows on the card's tile as a small circle.
 */
function ColorPicker({ colors, value, onPick }: { colors: CardColor[]; value: string | undefined; onPick: (color: string | null) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const pick = async (color: string | null): Promise<void> => {
    if (busy || (color ?? undefined) === value) return;
    setBusy(true);
    await onPick(color);
    setBusy(false);
  };
  const current = colors.find((color) => color.hex === value);
  return (
    <div className="color-row" role="group" aria-label="The card's colour" data-testid="panel-colors">
      <span className="color-label">Colour</span>
      {colors.map((color) => (
        <button
          key={color.hex}
          type="button"
          className={classes("swatch", value === color.hex && "on")}
          style={{ "--swatch": color.hex } as CSSProperties}
          aria-pressed={value === color.hex}
          aria-label={color.name}
          title={value === color.hex ? `Marked ${color.name}` : `Mark it ${color.name}`}
          onClick={() => void pick(color.hex)}
          data-color={color.hex}
        />
      ))}
      <button type="button" className={classes("swatch", "swatch-none", value === undefined && "on")} aria-pressed={value === undefined} aria-label="no colour" title="No colour" onClick={() => void pick(null)} data-color="none" />
      <span className="color-name" aria-live="polite">
        {current ? current.name : value ? value : "none"}
      </span>
    </div>
  );
}

function RelationAdder({ board, id, kinds, onAdd }: { board: BoardPayload; id: string; kinds: string[]; onAdd: (kind: string, to: string | number) => Promise<string | null> }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("related");
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const match = /^#?(\d+|[A-Za-z0-9][A-Za-z0-9._-]*)/.exec(target.trim());
    if (!match) {
      setError("Name the card by its number, like 42.");
      return;
    }
    const to = /^\d+$/.test(match[1]!) ? Number(match[1]) : match[1]!;
    const refused = await onAdd(kind, to);
    setError(refused);
    if (!refused) {
      setTarget("");
      setOpen(false);
    }
  };
  if (!open) {
    return (
      <button type="button" className="text-button add-line" onClick={() => setOpen(true)}>
        + Relate a card
      </button>
    );
  }
  return (
    <form
      className="adder"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <label className="select select-small">
        <select value={kind} onChange={(event) => setKind(event.target.value)} aria-label="Kind of relation">
          {kinds.map((entry) => (
            <option key={entry} value={entry}>
              {RELATION_WORDS[entry] ?? entry}
            </option>
          ))}
        </select>
      </label>
      <input className="field-input" list={`cards-for-${id}`} value={target} onChange={(event) => setTarget(event.target.value)} placeholder="card number" autoFocus aria-label="The card to relate" />
      <datalist id={`cards-for-${id}`}>
        {board.cards
          .filter((entry) => String(entry.id) !== id && entry.archived === undefined)
          .map((entry) => (
            <option key={String(entry.id)} value={`${String(entry.id)} ${entry.title}`} />
          ))}
      </datalist>
      <button type="submit" className="secondary small">
        Relate
      </button>
      {error ? (
        <p className="refusal" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function AttachmentAdder({ onAdd }: { onAdd: (path: string, lines?: string) => Promise<string | null> }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const value = text.trim();
    if (value === "") return;
    const lined = /^(.*?):(\d+(?:-\d+)?)$/.exec(value);
    const refused = await onAdd(lined ? lined[1]! : value, lined ? lined[2] : undefined);
    setError(refused);
    if (!refused) {
      setText("");
      setOpen(false);
    }
  };
  if (!open) {
    return (
      <button type="button" className="text-button add-line" onClick={() => setOpen(true)}>
        + Attach a file
      </button>
    );
  }
  return (
    <form
      className="adder"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <input className="field-input" value={text} onChange={(event) => setText(event.target.value)} placeholder="docs/plan.md:40-60, or repository:path" autoFocus aria-label="The file to attach" />
      <button type="submit" className="secondary small">
        Attach
      </button>
      {error ? (
        <p className="refusal" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
