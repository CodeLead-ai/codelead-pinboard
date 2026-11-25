import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { BoardPayload, ReadyGapInfo, ScheduleInfo, ScheduleInput, ScheduleRuleInfo, SchedulesPayload } from "../../server/contract.js";
import { api, Refused, wordsOf } from "./api.js";
import { ClockIcon } from "./icons.js";
import { classes, columnName, keyOf, participantName, plural } from "./model.js";

/**
 * The schedules on the page (core/schedules.ts): the person's standing asks, each of which puts a
 * card in Ready at its times, for an agent to take. A view of its own, reached from the header: the
 * list (the rule in words, the next time in the schedule's zone and in UTC, paused or not, the last
 * card it made), pause, resume and remove, and a form to add one. The form shows the board's own check
 * of the card (the Ready check's words) before it is saved: the page asks the board's process for a
 * dry run as the person writes.
 */

type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
const WEEKDAYS: Array<[Weekday, string]> = [
  ["mon", "Mon"],
  ["tue", "Tue"],
  ["wed", "Wed"],
  ["thu", "Thu"],
  ["fri", "Fri"],
  ["sat", "Sat"],
  ["sun", "Sun"]
];

/** What the person writes in the form: each thing as text. */
interface Draft {
  name: string;
  kind: "weekly" | "daily" | "every";
  days: Weekday[];
  at: string;
  count: string;
  unit: "minutes" | "hours" | "days";
  from: string;
  type: string;
  title: string;
  description: string;
  forAgent: string;
  tags: string;
  doneWhen: string;
  mayTouch: string;
  limitMinutes: string;
  limitMoney: string;
}

function emptyDraft(board: BoardPayload): Draft {
  return {
    name: "",
    kind: "weekly",
    days: ["mon"],
    at: "09:00",
    count: "1",
    unit: "hours",
    from: "",
    type: board.types.includes("task") ? "task" : (board.types[0] ?? "task"),
    title: "",
    description: "",
    forAgent: "",
    tags: "",
    doneWhen: "",
    mayTouch: "",
    limitMinutes: "",
    limitMoney: ""
  };
}

/** The draft as the board's process takes it: the rule of the kind picked, the card with what is filled in. */
function inputOf(draft: Draft): ScheduleInput {
  const rule: ScheduleRuleInfo =
    draft.kind === "weekly"
      ? { kind: "weekly", days: draft.days, at: draft.at }
      : draft.kind === "daily"
        ? { kind: "daily", at: draft.at }
        : { kind: "every", count: Number(draft.count), unit: draft.unit, from: draft.from };
  const fields: Record<string, unknown> = {};
  if (draft.doneWhen.trim() !== "") fields.definitionOfDone = draft.doneWhen.trim();
  const touch = draft.mayTouch
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (touch.length > 0) fields.mayTouch = touch;
  if (draft.limitMinutes.trim() !== "") fields.limitMinutes = draft.limitMinutes.trim();
  if (draft.limitMoney.trim() !== "") fields.limitMoney = draft.limitMoney.trim();
  const tags = [
    ...draft.tags
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag !== ""),
    ...(draft.forAgent !== "" ? [`for:${draft.forAgent}`] : [])
  ];
  return {
    name: draft.name.trim(),
    rule,
    card: { type: draft.type, title: draft.title, ...(draft.description.trim() !== "" ? { description: draft.description } : {}), ...(tags.length > 0 ? { tags } : {}), fields }
  };
}

/** The board's check of a draft: its words when it would refuse the schedule (and what is missing), or when its first card is due. */
type Check = { ok: true; next?: string } | { ok: false; message: string; missing: ReadyGapInfo[] };

export function SchedulesMenu({
  board,
  open,
  onToggle,
  version,
  onOpenCard
}: {
  board: BoardPayload;
  open: boolean;
  onToggle: (open: boolean) => void;
  /** Raised when the schedules may have changed (the stream said so): the open view reads them again. */
  version: number;
  onOpenCard: (id: string) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent): void => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) onToggle(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open, onToggle]);
  return (
    <div className="schedules-wrap" ref={wrap}>
      <button type="button" className="icon-button" onClick={() => onToggle(!open)} aria-expanded={open} aria-haspopup="dialog" aria-label="Schedules" title="Schedules: cards put in Ready at their times" data-testid="schedules-button">
        <ClockIcon size={17} />
      </button>
      {open ? <SchedulesView board={board} version={version} onOpenCard={onOpenCard} /> : null}
    </div>
  );
}

function SchedulesView({ board, version, onOpenCard }: { board: BoardPayload; version: number; onOpenCard: (id: string) => void }) {
  const [listing, setListing] = useState<SchedulesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setListing(await api.schedules());
      setError(null);
    } catch (failure) {
      setError(wordsOf(failure));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, version]);
  const act = async (name: string, verb: "pause" | "resume" | "remove"): Promise<void> => {
    try {
      const written = await api.scheduleState(name, verb);
      setSaid(
        verb === "pause"
          ? `Paused ${name}: it makes no card until you resume it; the times it misses meanwhile are not made up.`
          : verb === "resume"
            ? `Resumed ${name}${written.nextWords ? `: its next card is due ${written.nextWords}` : ""}.`
            : `Removed ${name}: it makes no more cards; the cards it made stay on the board.`
      );
      setError(null);
    } catch (failure) {
      setError(wordsOf(failure));
    }
    await load();
  };
  const count = listing?.schedules.length ?? 0;
  return (
    <div className="notes schedules" role="dialog" aria-label="Schedules" data-testid="schedules">
      <div className="notes-head">
        <span className="notes-title">Schedules</span>
        {listing ? <span className="notes-sum">{plural(count, "schedule")}</span> : null}
      </div>
      <div className="schedules-body">
        <p className="schedules-intro">
          A schedule puts a card in Ready at its times, for an agent to take; nothing runs unseen: each run leaves its card. Only you make one. Times are in each schedule's zone
          {listing ? ` (this machine: ${listing.zone})` : ""} and in UTC. They run while this page's process (or the app, or <code>schedules run</code>) is running; a time missed meanwhile makes one card at the next run.
        </p>
        {listing && listing.ready === undefined ? (
          <p className="no-ready-note" data-testid="schedules-no-ready">
            No Ready column on this board yet, where a schedule puts its card. <code>{listing.command}</code> adds it.
          </p>
        ) : null}
        {said ? (
          <p className="schedules-said" role="status" data-testid="schedules-said">
            {said}
          </p>
        ) : null}
        {error ? (
          <p className="refusal" role="alert" data-testid="schedules-error">
            {error}
          </p>
        ) : null}
        {listing === null ? <p className="notes-empty">Reading the schedules…</p> : null}
        {listing && count === 0 && !adding ? <p className="notes-empty" data-testid="schedules-empty">No schedule yet. Add one below: every Monday at 09:00, check the dependencies.</p> : null}
        {listing && count > 0 ? (
          <ol className="schedules-list">
            {listing.schedules.map((schedule) => (
              <ScheduleRow key={schedule.name} board={board} schedule={schedule} onAct={(verb) => void act(schedule.name, verb)} onOpenCard={onOpenCard} />
            ))}
          </ol>
        ) : null}
        {listing?.unreadable.map((entry) => (
          <p key={entry.file} className="refusal">
            {entry.file} cannot be read as a schedule: {entry.problems.join("; ")}.
          </p>
        ))}
        {adding && listing ? (
          <ScheduleForm
            board={board}
            onCancel={() => setAdding(false)}
            onSaved={(words) => {
              setAdding(false);
              setSaid(words);
              void load();
            }}
          />
        ) : null}
      </div>
      <div className="notes-foot">
        <span className="notes-more">Each is a file in the board's schedules/ folder.</span>
        {!adding ? (
          <button type="button" className="primary small" onClick={() => setAdding(true)} disabled={listing?.ready === undefined} data-testid="schedule-add">
            Add a schedule
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ScheduleRow({ board, schedule, onAct, onOpenCard }: { board: BoardPayload; schedule: ScheduleInfo; onAct: (verb: "pause" | "resume" | "remove") => void; onOpenCard: (id: string) => void }) {
  const [removing, setRemoving] = useState(false);
  const forAgents = schedule.card.tags.filter((tag) => /^for:/i.test(tag)).map((tag) => participantName(board, tag.slice(4)));
  const last = schedule.lastCard;
  return (
    <li className={classes("schedule", schedule.paused && "schedule-paused")} data-testid="schedule" data-schedule={schedule.name}>
      <div className="schedule-head">
        <b className="schedule-name">{schedule.name}</b>
        <span className="schedule-rule" data-testid="schedule-rule">
          {schedule.words}
        </span>
        <span className="schedule-zone">{schedule.zone}</span>
        {schedule.paused ? <span className="badge">paused</span> : null}
      </div>
      {schedule.paused ? (
        <p className="schedule-next" data-testid="schedule-next">
          Paused by {participantName(board, schedule.paused.by)}: it makes no card until it is resumed.
        </p>
      ) : schedule.next ? (
        <p className="schedule-next" data-testid="schedule-next">
          {schedule.dueNow ? "Due now, since" : "Next:"} <time dateTime={schedule.next.at}>{schedule.next.local}</time> <span className="schedule-utc">· {schedule.next.utc}</span>
        </p>
      ) : null}
      <p className="schedule-card">
        Its card: <b>{schedule.card.title}</b> ({schedule.card.type}), {forAgents.length > 0 ? `for ${forAgents.join(" or ")}` : "for any agent"} · {participantName(board, schedule.made.by)}'s
      </p>
      {!schedule.maker.person ? <p className="refusal">It makes no card: {schedule.maker.id} is no person of the board now.</p> : null}
      <p className="schedule-last" data-testid="schedule-last">
        {last ? (
          <>
            Last card:{" "}
            <button type="button" className="link-button" onClick={() => onOpenCard(keyOf(last.id))}>
              #{String(last.id)}
              {last.title ? ` ${last.title}` : ""}
            </button>{" "}
            {last.column !== undefined ? (last.archived ? "(archived)" : `(in ${columnName(board, last.column)})`) : "(no longer on the board)"}
          </>
        ) : (
          "No card yet."
        )}
        {schedule.last?.skipped ? <span className="schedule-skipped"> Last time due: no card, as {schedule.last.skipped}.</span> : null}
      </p>
      <div className="schedule-actions">
        {removing ? (
          <>
            <span className="hint">Remove {schedule.name}? The cards it made stay.</span>
            <button type="button" className="text-button danger" onClick={() => onAct("remove")} data-testid="schedule-remove-yes">
              Remove
            </button>
            <button type="button" className="text-button" onClick={() => setRemoving(false)}>
              Keep it
            </button>
          </>
        ) : (
          <>
            <button type="button" className="text-button" onClick={() => onAct(schedule.paused ? "resume" : "pause")} data-testid={schedule.paused ? "schedule-resume" : "schedule-pause"}>
              {schedule.paused ? "Resume" : "Pause"}
            </button>
            <button type="button" className="text-button" onClick={() => setRemoving(true)} data-testid="schedule-remove">
              Remove
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function ScheduleForm({ board, onCancel, onSaved }: { board: BoardPayload; onCancel: () => void; onSaved: (words: string) => void }) {
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(board));
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Draft>(key: K) => (value: Draft[K]) => setDraft((previous) => ({ ...previous, [key]: value }));
  const ready = board.ready.column ? columnName(board, board.ready.column) : "Ready";
  const agents = board.participants.filter((participant) => participant.kind === "agent");
  const complete = draft.name.trim() !== "" && draft.title.trim() !== "" && (draft.kind !== "every" || draft.from !== "");

  // The board's check of the draft, as the person writes: a dry run, a moment after the last key.
  useEffect(() => {
    if (!complete) {
      setCheck(null);
      return;
    }
    let current = true;
    const timer = window.setTimeout(() => {
      api
        .addSchedule({ ...inputOf(draft), dryRun: true })
        .then((written) => {
          if (current) setCheck({ ok: true, ...(written.nextWords ? { next: written.nextWords } : {}) });
        })
        .catch((failure: unknown) => {
          if (!current) return;
          if (failure instanceof Refused) setCheck({ ok: false, message: failure.message, missing: failure.missing });
          else setCheck({ ok: false, message: wordsOf(failure), missing: [] });
        });
    }, 250);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [draft, complete]);

  const missing = new Set<string>(check && !check.ok ? check.missing.map((gap) => gap.what) : []);
  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    if (busy || !complete) return;
    setBusy(true);
    try {
      const written = await api.addSchedule(inputOf(draft));
      onSaved(`Made the schedule ${written.name}.${written.nextWords ? ` Its first card is due ${written.nextWords}, in ${ready}.` : ""}`);
    } catch (failure) {
      setError(wordsOf(failure));
      if (failure instanceof Refused) setCheck({ ok: false, message: failure.message, missing: failure.missing });
    } finally {
      setBusy(false);
    }
  };
  const field = (key: keyof Draft, label: string, input: ReactNode, what?: string): ReactNode => (
    <label className={classes("mini-field", "ready-field", what !== undefined && missing.has(what) && "ready-missing")} data-testid={`schedule-${key}`}>
      <span>{label}</span>
      {input}
    </label>
  );
  const text = (key: "name" | "title" | "doneWhen" | "limitMinutes" | "limitMoney" | "tags" | "at" | "count", placeholder: string, more: Record<string, unknown> = {}) => (
    <input className="field-input" value={draft[key]} onChange={(event) => set(key)(event.target.value)} placeholder={placeholder} data-testid={`schedule-${key}-input`} {...more} />
  );
  return (
    <form
      className="schedule-form"
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void submit();
        }
      }}
      data-testid="schedule-form"
      aria-label="A new schedule"
    >
      <div className="ready-check-label">A new schedule</div>
      {field("name", "Name (a short word: check-deps)", text("name", "check-deps", { "aria-label": "Name" }))}
      <fieldset className="schedule-when">
        <legend>When</legend>
        <div className="schedule-kinds" role="radiogroup" aria-label="When it is due">
          {(
            [
              ["weekly", "Weekly"],
              ["daily", "Daily"],
              ["every", "Every …"]
            ] as const
          ).map(([kind, label]) => (
            <label key={kind} className={classes("chip", draft.kind === kind && "chip-chosen")}>
              <input type="radio" name="schedule-kind" value={kind} checked={draft.kind === kind} onChange={() => set("kind")(kind)} data-testid={`schedule-kind-${kind}`} /> {label}
            </label>
          ))}
        </div>
        {draft.kind === "weekly" ? (
          <div className="schedule-days" role="group" aria-label="On these days">
            {WEEKDAYS.map(([day, label]) => (
              <label key={day} className={classes("chip", draft.days.includes(day) && "chip-chosen")}>
                <input
                  type="checkbox"
                  checked={draft.days.includes(day)}
                  onChange={(event) => set("days")(event.target.checked ? WEEKDAYS.map(([one]) => one).filter((one) => one === day || draft.days.includes(one)) : draft.days.filter((one) => one !== day))}
                  data-testid={`schedule-day-${day}`}
                />{" "}
                {label}
              </label>
            ))}
          </div>
        ) : null}
        {draft.kind !== "every" ? (
          field("at", "At (local time)", text("at", "09:00", { type: "time", "aria-label": "At" }))
        ) : (
          <div className="schedule-every">
            {field("count", "Every", text("count", "1", { inputMode: "numeric", "aria-label": "Every how many" }))}
            <label className="mini-field">
              <span>Unit</span>
              <select className="field-input" value={draft.unit} onChange={(event) => set("unit")(event.target.value as Draft["unit"])} aria-label="Unit" data-testid="schedule-unit-input">
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
            </label>
            <label className="mini-field">
              <span>From (local time)</span>
              <input type="datetime-local" className="field-input" value={draft.from} onChange={(event) => set("from")(event.target.value)} aria-label="From" data-testid="schedule-from-input" />
            </label>
          </div>
        )}
      </fieldset>
      <fieldset className="schedule-template">
        <legend>The card it puts in {ready}</legend>
        <div className="schedule-pair">
          <label className="mini-field">
            <span>Type</span>
            <select className="field-input" value={draft.type} onChange={(event) => set("type")(event.target.value)} aria-label="Type" data-testid="schedule-type-input">
              {board.types.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label className="mini-field">
            <span>For</span>
            <select className="field-input" value={draft.forAgent} onChange={(event) => set("forAgent")(event.target.value)} aria-label="For" data-testid="schedule-for-input">
              <option value="">any agent</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {field("title", "Title", text("title", "Check the dependencies", { "aria-label": "Title" }))}
        <label className="mini-field">
          <span>Description</span>
          <textarea className="field-input" rows={2} value={draft.description} onChange={(event) => set("description")(event.target.value)} aria-label="Description" data-testid="schedule-description-input" />
        </label>
        {field("tags", "Tags (comma between)", text("tags", "area:deps", { "aria-label": "Tags" }))}
        {field("doneWhen", "Done when", text("doneWhen", "npm test passes", { "aria-label": "Done when" }), "done-when")}
        <label className={classes("mini-field", "ready-field", missing.has("may-touch") && "ready-missing")} data-testid="schedule-mayTouch">
          <span>May touch (one a line)</span>
          <textarea className="field-input" rows={2} value={draft.mayTouch} onChange={(event) => set("mayTouch")(event.target.value)} placeholder="package.json" aria-label="May touch" data-testid="schedule-mayTouch-input" />
        </label>
        <div className={classes("ready-limits", missing.has("limit") && "ready-missing")} role="group" aria-label="The limit: in minutes, in money, or both">
          <span className="ready-limits-label">
            Limit <span className="ready-hint">in minutes, in money, or both: a number each</span>
          </span>
          <label className="mini-field">
            <span>minutes</span>
            {text("limitMinutes", "30", { inputMode: "decimal", "aria-label": "Limit in minutes" })}
          </label>
          <label className="mini-field">
            <span>money</span>
            {text("limitMoney", "2.50", { inputMode: "decimal", "aria-label": "Limit in money" })}
          </label>
        </div>
      </fieldset>
      {check === null ? (
        <p className="hint" data-testid="schedule-check">
          Give it a name and a title: the board's check of its card shows here before you save.
        </p>
      ) : check.ok ? (
        <p className="schedules-said" role="status" data-testid="schedule-check">
          The board accepts it.{check.next ? ` Its first card is due ${check.next}, in ${ready}.` : ""}
        </p>
      ) : (
        <p className="refusal" role="status" data-testid="schedule-check">
          {check.message}
        </p>
      )}
      {error && (check === null || check.ok || check.message !== error) ? (
        <p className="refusal" role="alert">
          {error}
        </p>
      ) : null}
      <div className="editor-actions">
        <button type="submit" className="primary small" disabled={busy || !complete || (check !== null && !check.ok)} data-testid="schedule-save">
          Save the schedule
        </button>
        <button type="button" className="text-button" onClick={onCancel}>
          Cancel
        </button>
        <span className="hint">⌘↵ saves</span>
      </div>
    </form>
  );
}
