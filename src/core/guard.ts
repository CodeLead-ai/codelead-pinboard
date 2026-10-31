import fs from "node:fs";
import path from "node:path";
import { workspaceOf } from "./boardConfig.js";
import { BoardRefusal } from "./errors.js";
import { rewriteHomePaths, rewriteMachinePaths } from "./paths.js";
import { defaultSanitizer, type SanitizerFactory, type TextSanitizer } from "./sanitize.js";

/**
 * What must never be written into a card: a secret (a key, a connection-string password, a
 * bearer token), a path of this machine (under the repository or the home folder), and a name the
 * project keeps private. Secrets and paths are found by a sanitizer: a text is refused when the
 * sanitizer would change it there. The board's own (sanitize.ts) is used unless the host gives its
 * own (the scope's `sanitizer`): CodeLead gives its audit pack's, so that the board and the audit
 * pack hold one set of rules. Private names are listed, one per line, in `private-names.txt` in
 * the board folder, a file git ignores, so the list itself is never recorded.
 *
 * A writer rewrites a text's paths first (`rewritePaths`): a path under the repository or the
 * workspace becomes the path a card cites (paths.ts), so that only a path the card cannot cite
 * without losing something (under the home folder, outside the workspace) is left for the guard
 * to refuse.
 */
export const PRIVATE_NAMES_FILE = "private-names.txt";

export interface GuardScope {
  /** The board folder (where the private names are listed). */
  dir: string;
  /** The repository: a path under it is a path of this machine. */
  root: string;
  /** The home folder: a path under it is a path of this machine. */
  home: string;
  /** The workspace: a path under it is cited as `<repository>:<path>`; the repository's parent when not given. */
  workspace?: string;
  /** Makes the sanitizer that finds secrets and machine paths; the board's own (sanitize.ts) when not given. */
  sanitizer?: SanitizerFactory;
}

function sanitizerOf(scope: GuardScope): TextSanitizer {
  return (scope.sanitizer ?? defaultSanitizer)({ root: scope.root, home: scope.home });
}

/**
 * A text with its paths of this machine rewritten as a card cites them, and each rewrite as it is
 * now written: under the repository, the path in it; under the workspace, `<repository>:<path>`.
 * With `home`, a path under the home folder that is left is written as the sanitizer writes it,
 * `<home>/…` (the writer asked for it: the folder it was in is lost). Nothing else changes: a
 * secret or a private name stays in the text, for the guard to refuse.
 */
export function rewritePaths(scope: GuardScope, text: string, options: { home?: boolean } = {}): { text: string; rewritten: string[] } {
  const lossless = rewriteMachinePaths(text, { root: scope.root, workspace: scope.workspace ?? workspaceOf(scope.root) });
  if (!options.home) return lossless;
  const placed = rewriteHomePaths(lossless.text, scope.home);
  return { text: placed.text, rewritten: [...lossless.rewritten, ...placed.rewritten] };
}

export type UnsafeKind = "secret" | "machine-path" | "private-name";

export function readPrivateNames(dir: string): string[] {
  try {
    return fs
      .readFileSync(path.join(dir, PRIVATE_NAMES_FILE), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
  } catch {
    return [];
  }
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function namePattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu");
}

/** What in the text must not be written into a card, or undefined when nothing is. */
export function findUnsafe(scope: GuardScope, text: string, names: string[] = readPrivateNames(scope.dir)): UnsafeKind | undefined {
  const cleaned = sanitizerOf(scope).text(text);
  if (cleaned !== text) {
    if (occurrences(cleaned, "<redacted>") > occurrences(text, "<redacted>")) return "secret";
    if (occurrences(cleaned, "<repo>") > occurrences(text, "<repo>") || occurrences(cleaned, "<home>") > occurrences(text, "<home>")) return "machine-path";
  }
  if (names.some((name) => namePattern(name).test(text))) return "private-name";
  return undefined;
}

/** The words of the refusal for what was found in `what` ("the comment", "the title"). */
export function unsafeWords(kind: UnsafeKind, what: string): string {
  switch (kind) {
    case "secret":
      return `Refused: ${what} looks like it holds a secret (a key, a connection-string password or a bearer token); nothing was written. Leave the secret out and say where it is kept instead.`;
    case "machine-path":
      return `Refused: ${what} holds a path of this machine outside the workspace (under the home folder); nothing was written. Cite the file by its path in a repository of the workspace instead, or give --rewrite-paths to write it as <home>/….`;
    case "private-name":
      return `Refused: ${what} names someone the board keeps private (listed in ${PRIVATE_NAMES_FILE}); nothing was written.`;
  }
}

/** Refuses a text that holds a secret, a machine path or a private name; `what` names it in the refusal. */
export function refuseUnsafe(scope: GuardScope, what: string, text: string, names?: string[]): void {
  const found = findUnsafe(scope, text, names);
  if (found) throw new BoardRefusal(found, unsafeWords(found, what));
}

/**
 * The text with what must not be recorded replaced, as the sanitizer replaces it (`<redacted>`,
 * `<repo>`, `<home>`), and private names as `<name>`; with the count of each replacement. For a
 * writer that copies documents into cards and must say what it changed.
 */
export function cleanText(scope: GuardScope, text: string, names: string[] = readPrivateNames(scope.dir)): { text: string; secrets: number; paths: number; names: number } {
  let cleaned = sanitizerOf(scope).text(text);
  const secrets = occurrences(cleaned, "<redacted>") - occurrences(text, "<redacted>");
  const paths = occurrences(cleaned, "<repo>") - occurrences(text, "<repo>") + occurrences(cleaned, "<home>") - occurrences(text, "<home>");
  let replacedNames = 0;
  for (const name of names) {
    cleaned = cleaned.replace(namePattern(name), () => {
      replacedNames += 1;
      return "<name>";
    });
  }
  return { text: cleaned, secrets, paths, names: replacedNames };
}
