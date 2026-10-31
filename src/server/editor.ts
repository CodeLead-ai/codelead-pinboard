import fs from "node:fs";
import path from "node:path";
import type { AttachmentLine, EditorInfo, Mention } from "./contract.js";

/**
 * Editor links: a path a card names opens in VS Code (`vscode://file/<absolute>:<line>`) when the
 * file is on this machine. A card names files of its own repository (`docs/plan.md:42`), and files
 * of another repository of the workspace as `<repository>:<path>` (the attachments' form) or
 * `<repository>/<path>`. Nothing outside the workspace folder (and the repository) is ever linked,
 * and a path that names nothing on this machine stays plain text.
 *
 * The workspace is board.json's (`workspace`, relative to the repository), the repository's parent
 * when it gives none: the folder whose repositories every write cites as `<repository>:<path>`.
 */
export function editorInfo(root: string, workspace?: string): EditorInfo {
  const resolved = path.resolve(root);
  return { root: resolved, workspace: workspace !== undefined ? path.resolve(workspace) : path.dirname(resolved), repository: path.basename(resolved) };
}

/** `vscode://file/<absolute path>[:line]`, each segment encoded (a Windows drive letter kept as it is). */
export function vscodeHref(absolute: string, line?: number): string {
  const forward = absolute.replace(/\\/g, "/");
  const rooted = forward.startsWith("/") ? forward : `/${forward}`;
  const encoded = rooted
    .split("/")
    .map((segment, index) => (index === 1 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join("/");
  return `vscode://file${encoded}${line !== undefined ? `:${line}` : ""}`;
}

export interface PathTarget {
  path: string;
  line?: number;
  kind: "file" | "folder";
}

type Probe = (candidate: string) => "file" | "folder" | undefined;

const probeDisk: Probe = (candidate) => {
  try {
    const stat = fs.statSync(candidate);
    return stat.isFile() ? "file" : stat.isDirectory() ? "folder" : undefined;
  } catch {
    return undefined;
  }
};

const WITH_LINE = /^(.+?)(?::(\d+)(?:[-–]\d+)?|#L(\d+)(?:-L?\d+)?)$/;
const PREFIXED = /^([A-Za-z0-9][A-Za-z0-9._-]*):(.+)$/;

function inside(folder: string, candidate: string): boolean {
  const relative = path.relative(folder, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** A file a card may link to: in the workspace, or in the repository (which a workspace set in board.json need not hold). */
function insideWorkspace(editor: EditorInfo, candidate: string): boolean {
  return inside(editor.workspace, candidate) || inside(editor.root, candidate);
}

/** Where a path a card names is on this machine, or undefined when it names nothing there. */
export function resolveCardPath(text: string, editor: EditorInfo, probe: Probe = probeDisk): PathTarget | undefined {
  let body = text.trim();
  let line: number | undefined;
  const lined = WITH_LINE.exec(body);
  if (lined && (lined[2] !== undefined || lined[3] !== undefined)) {
    body = lined[1]!;
    line = Number(lined[2] ?? lined[3]);
  }
  if (body === "" || /\s/.test(body) || body.includes("://") || body.includes("\\")) return undefined;
  if (body.startsWith("/") || body.startsWith("~") || body.startsWith("-") || body.startsWith(".")) return undefined;
  if (/^[A-Za-z]:/.test(body) && !PREFIXED.test(body)) return undefined;
  const candidates: string[] = [];
  const prefixed = PREFIXED.exec(body);
  if (prefixed) {
    if (prefixed[2]!.split("/").includes("..")) return undefined;
    candidates.push(path.join(editor.workspace, prefixed[1]!, prefixed[2]!));
  } else {
    if (body.split("/").includes("..")) return undefined;
    candidates.push(path.join(editor.root, body));
    if (body.includes("/")) candidates.push(path.join(editor.workspace, body));
  }
  for (const candidate of candidates) {
    if (!insideWorkspace(editor, candidate)) continue;
    const kind = probe(candidate);
    if (kind) return { path: candidate, kind, ...(line !== undefined ? { line } : {}) };
  }
  return undefined;
}

/** An attachment as the panel lists it: the card's words, and the editor link when the file is here. */
export function attachmentLine(attachment: { path: string; lines?: string }, editor: EditorInfo, probe: Probe = probeDisk): AttachmentLine {
  const label = `${attachment.path}${attachment.lines ? `:${attachment.lines}` : ""}`;
  const target = resolveCardPath(attachment.path, editor, probe);
  const first = attachment.lines ? /\d+/.exec(attachment.lines) : null;
  return {
    path: attachment.path,
    ...(attachment.lines ? { lines: attachment.lines } : {}),
    label,
    exists: target !== undefined,
    ...(target?.kind === "file" ? { href: vscodeHref(target.path, first ? Number(first[0]) : target.line) } : {})
  };
}

const EVIDENCE_ID = /^ev-\d{14}-[a-z0-9]{6}$/;

/** An evidence record's file: `.codelead/evidence/<id>.json` in the repository, or in another repository of the workspace. */
export function resolveEvidence(id: string, editor: EditorInfo, probe: Probe = probeDisk): string | undefined {
  if (!EVIDENCE_ID.test(id)) return undefined;
  const own = path.join(editor.root, ".codelead", "evidence", `${id}.json`);
  if (probe(own) === "file") return own;
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(editor.workspace, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== editor.repository)
      .map((entry) => entry.name)
      .sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    const candidate = path.join(editor.workspace, name, ".codelead", "evidence", `${id}.json`);
    if (probe(candidate) === "file") return candidate;
  }
  return undefined;
}

const CODE_SPAN = /`([^`\n]+)`/g;
const LINK_TARGET = /\]\(\s*<?([^)\s>]+)>?(?:\s+["'(][^)]*)?\)/g;
const BARE_PATH = /(?<![\w./:@-])((?:[A-Za-z0-9][A-Za-z0-9._-]*:)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.@-]+)+\/?(?::\d+(?:[-–]\d+)?)?)/g;
// A file at the top of another repository of the workspace, as a write cites it: `<repository>:<file>` (`ledgerbook-rebuild:README.md`).
const BARE_TOP_FILE = /(?<![\w./:@-])([A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9_-][A-Za-z0-9_.-]*\.[A-Za-z0-9]+(?::\d+(?:[-–]\d+)?)?)(?![\w/])/g;
const EVIDENCE_IN_TEXT = /\bev-\d{14}-[a-z0-9]{6}\b/g;
const MAX_CANDIDATES = 400;

/** A mention's text without the punctuation that ends a sentence around it. */
export function trimMention(text: string): string {
  return text.trim().replace(/[.,;:!?)\]]+$/, "");
}

/**
 * The paths and evidence records the texts name that are on this machine, by the text that names
 * them (a code span's content, a markdown link's target, a bare path, an evidence record id). The
 * page turns exactly these texts into links; nothing else in a card becomes an editor link.
 */
export function mentionsIn(texts: string[], editor: EditorInfo, probe: Probe = probeDisk): Record<string, Mention> {
  const found: Record<string, Mention> = {};
  const seen = new Set<string>();
  const consider = (raw: string): void => {
    const text = trimMention(raw);
    if (text === "" || seen.has(text) || seen.size >= MAX_CANDIDATES) return;
    seen.add(text);
    if (EVIDENCE_ID.test(text)) {
      const file = resolveEvidence(text, editor, probe);
      if (file) found[text] = { path: file, href: vscodeHref(file), kind: "evidence" };
      return;
    }
    const target = resolveCardPath(text, editor, probe);
    if (target?.kind === "file") found[text] = { path: target.path, href: vscodeHref(target.path, target.line), kind: "path", ...(target.line !== undefined ? { line: target.line } : {}) };
  };
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(CODE_SPAN)) consider(match[1]!);
    for (const match of text.matchAll(LINK_TARGET)) consider(match[1]!);
    for (const match of text.matchAll(BARE_PATH)) consider(match[1]!);
    for (const match of text.matchAll(BARE_TOP_FILE)) consider(match[1]!);
    for (const match of text.matchAll(EVIDENCE_IN_TEXT)) consider(match[0]);
  }
  return found;
}
