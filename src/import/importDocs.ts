import fs from "node:fs";
import path from "node:path";
import {
  BoardRefusal,
  cleanText,
  createCards,
  isBoardRefusal,
  readBoard,
  readBoardConfig,
  rewriteMachinePaths,
  sha256,
  splitText,
  updateCard,
  withBoardLock,
  workspaceOf,
  writeBoardConfig,
  type Attachment,
  type BoardConfig,
  type BoardContext,
  type CardId,
  type ImportMarker,
  type NewCardInput,
  type PathScope
} from "../core/index.js";

/**
 * The import of today's documents into cards (spec section 9), run once by hand and checked by
 * the person against the mapping it prints:
 *
 * - `PINNED.md`: every list item becomes a card. Its section says what it is: "For action" a
 *   task, "For decision" a decision, "For review" a review, all in Pinned; "Answered" a decision
 *   in Done. An item named by a key (`0r`) is tagged `pinned:0r`.
 * - `DECISIONS-PENDING.md`: an item becomes a decision card when it is open and PINNED does not
 *   already carry it (the same first six words); in Pinned, or in Backlog under a "Parked"
 *   heading. Closed is: struck through, answered in place ("Answer:"), a closing word (decided,
 *   answered, shipped, done, closed, fixed, resolved, stopped, withdrawn, rejected, superseded)
 *   in its first words, or "nothing open". Open is: words that say something waits (needs
 *   <person>, <person>'s call, waits on <person>, question for <person>, your call, undecided,
 *   not started, open question, still open, decision pending, "— open", "Open:", check when).
 *   Anything else is a record, and stays in the document. Every item skipped is in the mapping
 *   with its reason.
 * - The plan's status table (section 8): one task card per row, tagged `plan:<item>`, in the
 *   column the row's status begins with: Done; After, Later, Not, Planned, Parked, Waiting,
 *   Blocked, Queued: Backlog; anything else: In progress. The body is the row's work, measured and
 *   status cells, each labelled.
 *
 * Every card is tagged `repo:<repository>`, carries its source document and lines as its first
 * attachment, every other path it names that exists (`path:12` gives the lines; a path in another
 * repository of the workspace becomes `<repository>:<path>`), and a `related` relation to every
 * other imported card whose key (`0r`, `W5`) it names. A path of this machine in the text becomes
 * the path in its repository; anything else the audit pack's sanitizer would remove is replaced
 * as it would replace it, and the mapping says so. The documents are only read. A marker per
 * document in board.json keeps the import from running twice on it.
 */
export const DEFAULT_PLAN = "behaviour-extraction-plan-2026-10-01.md";

export interface ImportOptions {
  /** The folder that holds PINNED.md, DECISIONS-PENDING.md and the plan. */
  from: string;
  /** The plan whose status table is imported; `<from>/behaviour-extraction-plan-2026-10-01.md` when not given. */
  plan?: string;
  /** The plan's section that holds the table; "8" when not given. */
  section?: string;
  /** The repository's name for the `repo:` tag; the repository folder's name when not given. */
  repo?: string;
  /** The folder that holds the workspace's repositories; the board's workspace (board.json's `workspace`, the repository's parent when it gives none) when not given. */
  workspace?: string;
  /** Who imports: a person of the board (the board's first person when not given). */
  as?: string;
  /** Work out the mapping and write nothing. */
  dryRun?: boolean;
}

export interface ImportedItem {
  /** The document, relative to the repository. */
  source: string;
  line: number;
  endLine: number;
  section: string;
  key?: string;
  title: string;
  outcome: "card" | "skipped";
  reason?: string;
  card?: { id: CardId; type: string; column: string };
  /** What the import found or changed: why an item is open, a path rewritten, a text replaced. */
  notes: string[];
}

export interface ImportedSource {
  source: string;
  found: boolean;
  section?: string;
  problem?: string;
  items: number;
  cards: number;
}

export interface ImportResult {
  from: string;
  as: string;
  items: ImportedItem[];
  sources: ImportedSource[];
  written: boolean;
}

// ---------------------------------------------------------------------------------------------
// Reading markdown

interface ListItem {
  line: number;
  endLine: number;
  section: string;
  text: string;
}

function dedent(line: string, width: number): string {
  let index = 0;
  while (index < width && line[index] === " ") index += 1;
  return line.slice(index);
}

/**
 * The top-level list items of a markdown text, each with its section (the heading above it) and
 * its lines: the item's own line and every line under it until the next item, the next heading,
 * or a paragraph that follows a blank line. Continuation lines lose the item's indentation.
 */
export function listItems(markdown: string): ListItem[] {
  const lines = splitText(markdown).text.split("\n");
  const items: ListItem[] = [];
  let section = "";
  let current: { line: number; last: number; width: number; lines: string[]; section: string } | undefined;
  let fence: string | undefined;
  let afterBlank = false;
  const close = (): void => {
    if (!current) return;
    const kept = current.lines.slice(0, current.last - current.line + 2);
    while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
    items.push({ line: current.line, endLine: current.last + 1, section: current.section, text: kept.join("\n") });
    current = undefined;
  };
  lines.forEach((line, index) => {
    const marks = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marks || fence) {
      if (marks && !fence) fence = marks;
      else if (marks && fence && marks[0] === fence[0] && marks.length >= fence.length) fence = undefined;
      if (current) {
        current.lines.push(dedent(line, current.width));
        current.last = index;
      }
      afterBlank = false;
      return;
    }
    if (/^#{1,6}\s/.test(line)) {
      close();
      section = line.replace(/^#{1,6}\s+/, "").trim();
      afterBlank = false;
      return;
    }
    const marker = /^(\d+[.)]|[-*+])(\s+)(\S.*)$/.exec(line);
    if (marker) {
      close();
      current = { line: index + 1, last: index, width: marker[1]!.length + marker[2]!.length, lines: [marker[3]!], section };
      afterBlank = false;
      return;
    }
    if (line.trim() === "") {
      if (current) current.lines.push("");
      afterBlank = true;
      return;
    }
    if (!current) return;
    if (/^\s/.test(line) || !afterBlank) {
      current.lines.push(dedent(line, current.width));
      current.last = index;
      afterBlank = false;
      return;
    }
    close();
    afterBlank = false;
  });
  close();
  return items;
}

/** Markdown as plain words: no emphasis marks, no code marks, one space between words. */
function plain(text: string): string {
  return text.replace(/\*\*|__|~~|`/g, "").replace(/\s+/g, " ").trim();
}

function cap(text: string, max = 120): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:—–-]+$/, "")}…`;
}

/**
 * An item's title: its opening bold text, or else its first words up to " — ", ": " or ". ";
 * an item opened by a key ("0r — …") is titled "0r: …" and keyed by it.
 */
function leadOf(text: string): { key?: string; title: string } {
  const bold = /^\*\*([\s\S]+?)\*\*/.exec(text);
  let lead: string;
  if (bold && bold[1]!.length <= 400) lead = bold[1]!;
  else {
    const first = text.split("\n")[0]!;
    const cut = first.search(/\s[—–]\s|:\s|\.\s/);
    lead = cut > 0 ? first.slice(0, cut) : first;
  }
  lead = plain(lead).replace(/[\s.:;,—–-]+$/, "");
  const keyed = /^(\d[a-z])\s+[—–-]\s+(.+)$/.exec(lead);
  if (keyed) return { key: keyed[1]!, title: cap(`${keyed[1]}: ${keyed[2]}`) };
  return { title: cap(lead || plain(text).slice(0, 80) || "(untitled)") };
}

/** The first `count` words of a text, lower-case, punctuation removed: what "the same item" is compared by. */
function firstWords(text: string, count = 6): string[] {
  return plain(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, count);
}

/** The cells of a markdown table row; a | inside code or escaped as \| belongs to the cell. */
function rowCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let code = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === "\\" && line[index + 1] === "|") {
      cell += "|";
      index += 1;
      continue;
    }
    if (char === "`") code = !code;
    if (char === "|" && !code) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  if (cells[0] === "") cells.shift();
  if (cells[cells.length - 1] === "") cells.pop();
  return cells;
}

// ---------------------------------------------------------------------------------------------
// Rules for each document

const CLOSING_WORD = /\b(decided|answered|shipped|done|closed|fixed|resolved|stopped|withdrawn|rejected|superseded)\b/i;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function waitingMarkers(persons: string[]): RegExp[] {
  const who = persons.map(escapeRegex).join("|") || "(?!)";
  return [
    new RegExp(`\\bneeds (?:${who})\\b`, "i"),
    new RegExp(`\\bquestion for (?:${who})\\b`, "i"),
    new RegExp(`\\b(?:${who})['’]s (?:call|decision)\\b`, "i"),
    new RegExp(`\\bwaits? on (?:${who})\\b`, "i"),
    /\byour (?:call|decision)\b/i,
    /\bundecided\b/i,
    /\bnot started\b/i,
    /\bopen question\b/i,
    /\bstill open\b/i,
    /\bdecision pending\b/i,
    /\s[—–]\s*open\b/i,
    /(?:^|\s)open:/i,
    /\bcheck when\b/i
  ];
}

/** Whether a DECISIONS-PENDING item is still open, and in which words. */
function openness(text: string, persons: string[]): { open: true; because: string } | { open: false; reason: string } {
  if (/^~~/.test(text.trim())) return { open: false, reason: "closed: struck through" };
  if (/\bAnswer:/.test(text)) return { open: false, reason: "answered in the document (Answer: …)" };
  const closing = CLOSING_WORD.exec(plain(text).slice(0, 100));
  if (closing) return { open: false, reason: `closed: "${closing[1]}" in its first words` };
  if (/\bnothing open\b/i.test(text)) return { open: false, reason: "closed: it says nothing is open" };
  for (const marker of waitingMarkers(persons)) {
    const found = marker.exec(text);
    if (found) return { open: true, because: found[0].trim() };
  }
  return { open: false, reason: "a record: nothing in it waits on anyone" };
}

function pinnedKind(section: string): { type: string; column: string } {
  if (/answered|decided|for the record/i.test(section)) return { type: "decision", column: "done" };
  if (/decision/i.test(section)) return { type: "decision", column: "pinned" };
  if (/review/i.test(section)) return { type: "review", column: "pinned" };
  if (/action/i.test(section)) return { type: "task", column: "pinned" };
  return { type: "note", column: "pinned" };
}

function columnForStatus(status: string): string {
  const first = (plain(status).split(/\s+/)[0] ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (first === "done") return "done";
  if (["after", "later", "not", "planned", "parked", "waiting", "waits", "blocked", "queued"].includes(first)) return "backlog";
  return "in-progress";
}

// ---------------------------------------------------------------------------------------------
// Paths (a path of this machine is rewritten by the core's rule, core/paths.ts, which every write shares)

function exists(file: string): boolean {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * The paths a text names in code marks that exist: in the repository (as written, or next to
 * the document), or in another repository of the workspace (`<repository>/<path>` or
 * `<repository>:<path>`). A name with no folder and no extension is a word, not a path.
 */
function namedPaths(text: string, scope: PathScope, documentDir: string): Attachment[] {
  const found = new Map<string, Attachment>();
  const add = (written: string, lines: string | undefined): void => {
    const existing = found.get(written);
    if (!existing) {
      found.set(written, { path: written, ...(lines ? { lines } : {}) });
      return;
    }
    if (lines && !(existing.lines ?? "").split(", ").includes(lines)) existing.lines = existing.lines ? `${existing.lines}, ${lines}` : lines;
  };
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1]!.trim();
    if (/\s/.test(token) || token.length > 240) continue;
    const parts = /^(.*?)(?::(\d+(?:[-–]\d+)?))?$/.exec(token)!;
    const candidate = parts[1]!;
    const lines = parts[2]?.replace("–", "-");
    if (candidate === "" || candidate.startsWith("/") || /^[A-Za-z]:[\\/]/.test(candidate) || candidate.includes("*")) continue;
    // A path that climbs out (`..`) cites nothing in the workspace.
    if (candidate.split(/[\\/:]/).includes("..")) continue;
    const colon = candidate.indexOf(":");
    if (colon > 0) {
      const name = candidate.slice(0, colon);
      const inner = candidate.slice(colon + 1);
      if (inner && exists(path.join(scope.workspace, name, inner))) add(`${name}:${inner}`, lines);
      continue;
    }
    const segments = candidate.replace(/\/+$/, "").split("/");
    if (segments.length < 2 && !segments[0]!.includes(".")) continue;
    if (exists(path.join(scope.root, candidate))) {
      add(candidate, lines);
      continue;
    }
    const [first, ...rest] = segments;
    if (rest.length > 0 && first !== path.basename(scope.root) && exists(path.join(scope.workspace, first!, ...rest))) {
      add(`${first}:${candidate.slice(first!.length + 1)}`, lines);
      continue;
    }
    const nextToDocument = path.join(documentDir, candidate);
    if (exists(nextToDocument)) {
      const relative = path.relative(scope.root, nextToDocument).split(path.sep).join("/");
      if (!relative.startsWith("..")) add(relative, lines);
    }
  }
  return [...found.values()];
}

// ---------------------------------------------------------------------------------------------
// The import

interface Draft {
  item: ImportedItem;
  input?: NewCardInput;
  keys: string[];
  text: string;
}

function keyPattern(key: string): RegExp {
  const escaped = escapeRegex(key);
  return /[A-Za-z]$/.test(key) ? new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`) : new RegExp(`(?<![A-Za-z0-9])${escaped}(?![0-9])`);
}

function lineRange(item: { line: number; endLine: number }): string {
  return item.line === item.endLine ? String(item.line) : `${item.line}-${item.endLine}`;
}

export function importDocuments(ctx: BoardContext, options: ImportOptions): ImportResult {
  return withBoardLock(ctx.dir, () => {
    const { config } = readBoardConfig(ctx.dir);
    const persons = config.participants.filter((participant) => participant.kind === "person");
    const as = options.as ?? persons[0]?.id;
    const participant = config.participants.find((entry) => entry.id === as);
    if (!as || !participant) {
      throw new BoardRefusal("participant", `Refused: "${as ?? ""}" is not a participant of the board (${config.participants.map((entry) => entry.id).join(", ")}). Nothing was written.`);
    }
    if (participant.kind !== "person") {
      throw new BoardRefusal("not-allowed", `Refused: the import writes into Pinned and Done, a person's columns, and ${as} is an agent; run it as a person (--as ${persons[0]?.id ?? "<person>"}). Nothing was written.`);
    }
    const relativeToRoot = (file: string): string => path.relative(ctx.root, file).split(path.sep).join("/");
    const fromDir = path.resolve(options.from);
    const section = options.section ?? "8";
    // The workspace: as given, or the board's (board.json's `workspace`, the repository's parent when it gives none).
    const scope: PathScope = { root: ctx.root, workspace: path.resolve(options.workspace ?? workspaceOf(ctx.root, config)) };
    const repo = options.repo ?? path.basename(ctx.root);
    const sources = [
      { kind: "pinned" as const, file: path.join(fromDir, "PINNED.md") },
      { kind: "decisions" as const, file: path.join(fromDir, "DECISIONS-PENDING.md") },
      { kind: "plan" as const, file: options.plan ? path.resolve(options.plan) : path.join(fromDir, DEFAULT_PLAN) }
    ];
    const marked = new Map((config.imports ?? []).map((marker) => [marker.source, marker]));
    for (const source of sources) {
      const marker = marked.get(relativeToRoot(source.file));
      if (marker && exists(source.file)) {
        throw new BoardRefusal("imported", `Refused: ${marker.source} was imported on ${marker.at} (board.json "imports"); the import runs once per document. Nothing was written.`);
      }
    }
    const personWords = persons.flatMap((person) => [person.id, person.name]);
    const drafts: Draft[] = [];
    const sourceSummaries: ImportedSource[] = [];
    const pinnedTitles: Array<{ words: string[]; line: number }> = [];
    const texts = new Map<string, string>();

    /** The text as a card may hold it: paths of this machine rewritten, what the sanitizer removes replaced. */
    const prepare = (text: string, notes: string[]): string => {
      const rewritten = rewriteMachinePaths(text, scope);
      for (const written of rewritten.rewritten) notes.push(`a path of this machine is written as ${written}`);
      const cleaned = cleanText({ dir: ctx.dir, root: ctx.root, home: ctx.home, ...(ctx.sanitizer ? { sanitizer: ctx.sanitizer } : {}) }, rewritten.text);
      if (cleaned.secrets > 0) notes.push(`${cleaned.secrets} secret(s) replaced by <redacted>`);
      if (cleaned.paths > 0) notes.push(`${cleaned.paths} path(s) of this machine replaced by <repo> or <home>`);
      if (cleaned.names > 0) notes.push(`${cleaned.names} private name(s) replaced by <name>`);
      return cleaned.text;
    };

    for (const source of sources) {
      const relative = relativeToRoot(source.file);
      if (!exists(source.file)) {
        sourceSummaries.push({ source: relative, found: false, items: 0, cards: 0 });
        continue;
      }
      const raw = fs.readFileSync(source.file, "utf8");
      texts.set(relative, raw);
      const documentDir = path.dirname(source.file);
      const before = drafts.length;
      const summary: ImportedSource = { source: relative, found: true, items: 0, cards: 0, ...(source.kind === "plan" ? { section } : {}) };

      if (source.kind === "pinned" || source.kind === "decisions") {
        for (const listItem of listItems(raw)) {
          const notes: string[] = [];
          const body = prepare(listItem.text, notes);
          const lead = leadOf(body);
          const item: ImportedItem = { source: relative, line: listItem.line, endLine: listItem.endLine, section: listItem.section, ...(lead.key ? { key: lead.key } : {}), title: lead.title, outcome: "skipped", notes };
          let type: string;
          let column: string;
          if (source.kind === "pinned") {
            ({ type, column } = pinnedKind(listItem.section));
            pinnedTitles.push({ words: firstWords(lead.title.replace(/^\d[a-z]: /, "")), line: listItem.line });
          } else {
            const state = openness(listItem.text, personWords);
            if (!state.open) {
              item.reason = state.reason;
              drafts.push({ item, keys: [], text: body });
              continue;
            }
            const words = firstWords(lead.title);
            const carrier = words.length >= 4 ? pinnedTitles.find((pinned) => pinned.words.length >= 4 && pinned.words.join(" ") === words.join(" ")) : undefined;
            if (carrier) {
              item.reason = `PINNED carries it (line ${carrier.line})`;
              drafts.push({ item, keys: [], text: body });
              continue;
            }
            notes.unshift(`open: it says "${state.because}"`);
            type = "decision";
            column = /parked|not pending/i.test(listItem.section) ? "backlog" : "pinned";
          }
          const input: NewCardInput = {
            ref: `${relative}:${listItem.line}`,
            type,
            title: lead.title,
            column,
            tags: [`repo:${repo}`, ...(source.kind === "pinned" && lead.key ? [`pinned:${lead.key}`] : [])],
            description: body,
            attachments: [{ path: relative, lines: lineRange(listItem) }, ...namedPaths(body, scope, documentDir).filter((attachment) => attachment.path !== relative)],
            eventData: { source: `${relative}:${lineRange(listItem)}` }
          };
          drafts.push({ item, input, keys: lead.key ? [lead.key] : [], text: body });
        }
      } else {
        const lines = splitText(raw).text.split("\n");
        const heading = lines.findIndex((line) => new RegExp(`^##\\s+${escapeRegex(section)}\\.\\s`).test(line));
        let header: string[] | undefined;
        let at = heading;
        if (heading !== -1) {
          for (at = heading + 1; at < lines.length && !/^##\s/.test(lines[at]!); at += 1) {
            if (lines[at]!.startsWith("|")) {
              header = rowCells(lines[at]!).map((cell) => plain(cell).toLowerCase());
              break;
            }
          }
        }
        const column = (name: string): number => header?.findIndex((cell) => cell.startsWith(name)) ?? -1;
        const [itemAt, workAt, measuredAt, statusAt] = [column("item"), column("work"), column("measured"), column("status")];
        if (heading === -1 || !header || itemAt === -1 || statusAt === -1) {
          summary.problem = heading === -1 ? `no section ${section}` : `section ${section} has no table with Item and Status columns`;
        } else {
          for (let row = at + 2; row < lines.length && lines[row]!.startsWith("|"); row += 1) {
            const cells = rowCells(lines[row]!);
            const notes: string[] = [];
            const itemCell = plain(prepare(cells[itemAt] ?? "", notes));
            const key = /^(W\d+|\d+)\./.exec(itemCell)?.[1];
            const status = prepare(cells[statusAt] ?? "", notes);
            const parts = [
              workAt !== -1 ? `**Work:** ${prepare(cells[workAt] ?? "", notes)}` : "",
              measuredAt !== -1 ? `**Measured:** ${prepare(cells[measuredAt] ?? "", notes)}` : "",
              `**Status:** ${status}`
            ].filter(Boolean);
            const body = parts.join("\n\n");
            const title = cap(itemCell.replace(/[\s.:;,]+$/, "") || `Row ${row + 1}`);
            const where = { line: row + 1, endLine: row + 1 };
            const item: ImportedItem = { source: relative, ...where, section: lines[heading]!.replace(/^##\s+/, ""), ...(key ? { key } : {}), title, outcome: "skipped", notes };
            const input: NewCardInput = {
              ref: `${relative}:${row + 1}`,
              type: "task",
              title,
              column: columnForStatus(status),
              tags: [`repo:${repo}`, ...(key ? [`plan:${key}`] : [])],
              description: body,
              attachments: [{ path: relative, lines: String(row + 1) }, ...namedPaths(body, scope, documentDir).filter((attachment) => attachment.path !== relative)],
              eventData: { source: `${relative}:${row + 1}` }
            };
            drafts.push({ item, input, keys: key && /[A-Za-z]/.test(key) ? [key] : [], text: body });
          }
        }
      }
      summary.items = drafts.length - before;
      sourceSummaries.push(summary);
    }

    // A card relates to every other card of the import whose key it names, once per pair.
    const withInput = drafts.filter((draft) => draft.input);
    for (const draft of withInput) {
      for (const other of withInput) {
        if (other === draft || other.keys.length === 0) continue;
        if (!other.keys.some((key) => keyPattern(key).test(draft.text))) continue;
        const already = (other.input!.relations ?? []).some((relation) => relation.ref === draft.input!.ref);
        if (already) continue;
        draft.input!.relations = [...(draft.input!.relations ?? []), { kind: "related", ref: other.input!.ref! }];
      }
    }

    const results = createCards(ctx, as, withInput.map((draft) => draft.input!), { tagCreator: false, ...(options.dryRun ? { dryRun: true } : {}) });
    withInput.forEach((draft, index) => {
      const card = results[index]!.card;
      draft.item.outcome = "card";
      draft.item.card = { id: card.id, type: card.type, column: card.column };
    });
    // A note said several times is said once, with how many times.
    for (const draft of drafts) {
      const counts = new Map<string, number>();
      for (const note of draft.item.notes) counts.set(note, (counts.get(note) ?? 0) + 1);
      draft.item.notes = [...counts].map(([note, count]) => (count > 1 ? `${note} (${count} times)` : note));
    }
    for (const summary of sourceSummaries) summary.cards = drafts.filter((draft) => draft.item.source === summary.source && draft.item.outcome === "card").length;

    if (!options.dryRun) {
      const at = results[0]?.card.created ?? new Date().toISOString();
      const markers: ImportMarker[] = sourceSummaries
        .filter((summary) => summary.found)
        .map((summary) => ({
          source: summary.source,
          at,
          by: as,
          sha256: sha256(texts.get(summary.source) ?? ""),
          cards: drafts.filter((draft) => draft.item.source === summary.source && draft.item.card).map((draft) => draft.item.card!.id)
        }));
      const fresh = readBoardConfig(ctx.dir);
      writeBoardConfig(ctx.dir, fresh, { ...fresh.config, imports: [...(fresh.config.imports ?? []), ...markers] });
    }
    return { from: relativeToRoot(fromDir) || ".", as, items: drafts.map((draft) => draft.item), sources: sourceSummaries, written: !options.dryRun };
  });
}

/** The mapping the person checks: every item of every document, the card it became or why it did not. */
export function formatImportMapping(result: ImportResult, config?: BoardConfig): string[] {
  const columnName = (id: string): string => config?.columns.find((column) => column.id === id)?.name ?? id;
  const cards = result.items.filter((item) => item.outcome === "card").length;
  const lines = [
    `Import from ${result.from} as ${result.as}: ${cards} card${cards === 1 ? "" : "s"} from ${result.sources.filter((source) => source.found).length} documents; ${result.items.length - cards} item${result.items.length - cards === 1 ? "" : "s"} skipped.${result.written ? "" : " Dry run: nothing was written, and the ids are the ones the cards would get."}`
  ];
  for (const source of result.sources) {
    lines.push("");
    if (!source.found) {
      lines.push(`${source.source}: not found, nothing imported from it`);
      continue;
    }
    const skipped = source.items - source.cards;
    lines.push(`${source.source}${source.section ? ` §${source.section}` : ""}: ${source.items} item${source.items === 1 ? "" : "s"}, ${source.cards} card${source.cards === 1 ? "" : "s"}${skipped > 0 ? `, ${skipped} skipped` : ""}${source.problem ? ` (${source.problem})` : ""}`);
    for (const item of result.items.filter((entry) => entry.source === source.source)) {
      const where = `line ${item.line}`.padEnd(10);
      if (item.card) lines.push(`  ${where} → #${String(item.card.id).padEnd(4)} ${item.card.type.padEnd(8)} ${columnName(item.card.column).padEnd(11)} ${item.title}`);
      else lines.push(`  ${where} skipped: ${item.reason ?? ""} · ${item.title}`);
      for (const note of item.notes) lines.push(`${" ".repeat(13)}${note}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Tidying the imported cards, once the import is done

export interface TidyOptions {
  /** Who tidies: a participant of the board (the board's first person when not given). */
  as?: string;
  /** Work out every change and write nothing. */
  dryRun?: boolean;
}

export interface TidiedCard {
  id: CardId;
  title: string;
  outcome: "tidied" | "skipped";
  /** Why the card is left as it is. */
  reason?: string;
  /** The description's first words before the change, and after it. */
  before?: string;
  after?: string;
}

export interface TidyResult {
  as: string;
  /** Every card the import made (board.json's `imports`), by id. */
  cards: TidiedCard[];
  tidied: number;
  written: boolean;
}

function opening(text: string, max = 110): string {
  return cap(text.replace(/\s+/g, " ").trim(), max);
}

/**
 * A description without its opening repetition of the title in bold (the import took an item's bold
 * lead as its title and kept the whole item as the description, so both said it): the bold text and
 * the punctuation that joined it to the rest go, and the rest begins with a capital. When the
 * description does not begin with its title in bold, the reason instead. A title the import cut at
 * 120 characters is not a repetition: its bold says more, and stays.
 */
export function withoutTitleLead(description: string, title: string): { text: string } | { reason: string } {
  const bold = /^\*\*([\s\S]+?)\*\*/.exec(description);
  if (!bold) return { reason: "its description does not begin in bold" };
  if (leadOf(description).title !== title) return { reason: "its bold opening is not its title" };
  if (title.endsWith("…")) return { reason: "its title was cut at 120 characters, so the bold says more than the title" };
  // A bold run longer than the lead the import read (400 characters) is the item's own text, not a
  // repetition of the title, even when its first words are the title; and a tidy never leaves a
  // card with nothing to read (the first run on the real board would have emptied one card).
  if (bold[1]!.length > 400) return { reason: "its bold opening is longer than a title lead, so it is the item's own text" };
  const rest = description.slice(bold[0].length).replace(/^[\s.:;,—–-]+/, "");
  if (rest.trim() === "") return { reason: "its description is only the bold opening, so nothing would be left" };
  return { text: /^\p{Ll}/u.test(rest) ? rest.charAt(0).toUpperCase() + rest.slice(1) : rest };
}

/**
 * `codelead board tidy --imported`: strips the opening repetition of the title in bold from the
 * description of every card the import made (the cards board.json's `imports` lists), and from no
 * other card. Each card is changed through `updateCard`, so each change has its `item.updated`
 * event and the board's rules; a card changed meanwhile is left as it is, with the reason. A second
 * run finds nothing to do. With `dryRun`, nothing is written.
 */
export function tidyImported(ctx: BoardContext, options: TidyOptions = {}): TidyResult {
  return withBoardLock(ctx.dir, () => {
    const { config } = readBoardConfig(ctx.dir);
    const as = options.as ?? config.participants.find((participant) => participant.kind === "person")?.id;
    if (!as || !config.participants.some((participant) => participant.id === as)) {
      throw new BoardRefusal("participant", `Refused: "${as ?? ""}" is not a participant of the board (${config.participants.map((entry) => entry.id).join(", ")}). Nothing was written.`);
    }
    const imported = [...new Set((config.imports ?? []).flatMap((marker) => (Array.isArray(marker.cards) ? marker.cards.map(String) : [])))];
    imported.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    const cards = new Map(readBoard(ctx).cards.map((card) => [String(card.id), card]));
    const result: TidiedCard[] = [];
    for (const key of imported) {
      const card = cards.get(key);
      if (!card) {
        result.push({ id: /^\d+$/.test(key) ? Number(key) : key, title: "", outcome: "skipped", reason: "no card with this id is on the board now" });
        continue;
      }
      const stripped = withoutTitleLead(card.description, card.title);
      if ("reason" in stripped) {
        result.push({ id: card.id, title: card.title, outcome: "skipped", reason: stripped.reason });
        continue;
      }
      const entry: TidiedCard = { id: card.id, title: card.title, outcome: "tidied", before: opening(card.description), after: opening(stripped.text) };
      if (!options.dryRun) {
        try {
          updateCard(ctx, card.id, { as, changes: { description: stripped.text }, expectUpdated: card.updated });
        } catch (error) {
          if (!isBoardRefusal(error)) throw error;
          result.push({ id: card.id, title: card.title, outcome: "skipped", reason: error.message });
          continue;
        }
      }
      result.push(entry);
    }
    return { as, cards: result, tidied: result.filter((card) => card.outcome === "tidied").length, written: !options.dryRun };
  });
}

/** What the tidy did (or would do), for the person to read: each card tidied with its opening before and after, then the cards left as they are. */
export function formatTidy(result: TidyResult): string[] {
  const skipped = result.cards.filter((card) => card.outcome === "skipped");
  const lines = [
    `Tidy of the imported cards as ${result.as}: ${result.tidied} of ${result.cards.length} began with their title in bold${result.tidied > 0 ? (result.written ? "; the repetition is gone" : "; dry run: nothing was written") : "; nothing to do"}.`
  ];
  for (const card of result.cards.filter((entry) => entry.outcome === "tidied")) {
    lines.push("", `  #${String(card.id).padEnd(4)} ${card.title}`, `        before: ${card.before ?? ""}`, `        after:  ${card.after ?? ""}`);
  }
  if (skipped.length > 0) {
    lines.push("", `Left as they are (${skipped.length}):`);
    for (const card of skipped) lines.push(`  #${String(card.id).padEnd(4)} ${card.reason ?? ""}${card.title ? ` · ${card.title}` : ""}`);
  }
  return lines;
}
