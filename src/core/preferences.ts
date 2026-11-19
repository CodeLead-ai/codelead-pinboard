import fs from "node:fs";
import path from "node:path";
import type { BoardContext } from "./board.js";
import { BoardRefusal } from "./errors.js";
import { writeFileAtomic } from "./files.js";
import { readPrivateNames, refuseUnsafe, type GuardScope } from "./guard.js";
import { formatJson } from "./json.js";
import { defaultPreferences, NO_PROJECT, preferencesProblems, type Preferences } from "./themes.js";

/**
 * The board's view preferences on this machine: the theme and the board's background, by default and
 * per project, and the project the page showed last. They live in the board folder, in
 * `.local/preferences.json`, so that the page finds them in a browser and in an editor's tab alike
 * (whatever port the page is served on); `.local/` stays out of git (the board folder's .gitignore
 * says so, written here when it does not yet). Nothing in them is a card's: no event is written.
 *
 * A document is checked before it is written: its shape (themes.ts), its size, and every text in it
 * (the project names) by the guard that refuses secrets, machine paths and private names in a card.
 */
export const LOCAL_FOLDER = ".local";
export const PREFERENCES_FILE = "preferences.json";
/** The largest preferences document the board keeps. */
export const PREFERENCES_MAX_BYTES = 64 * 1024;

export function preferencesPath(dir: string): string {
  return path.join(dir, LOCAL_FOLDER, PREFERENCES_FILE);
}

export interface PreferencesRead {
  preferences: Preferences;
  /** True when the file was there and could be used; false when these are the defaults. */
  stored: boolean;
  /** Why a file that is there could not be used (the defaults are given then). */
  problems: string[];
}

/** The preferences as the file says them; the defaults when there is no file, or one that cannot be used. */
export function readPreferences(dir: string): PreferencesRead {
  let text: string;
  try {
    text = fs.readFileSync(preferencesPath(dir), "utf8");
  } catch {
    return { preferences: defaultPreferences(), stored: false, problems: [] };
  }
  let value: unknown;
  try {
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { preferences: defaultPreferences(), stored: false, problems: [`${LOCAL_FOLDER}/${PREFERENCES_FILE} is not JSON`] };
  }
  const problems = preferencesProblems(value);
  if (problems.length > 0) return { preferences: defaultPreferences(), stored: false, problems };
  return { preferences: value as Preferences, stored: true, problems: [] };
}

function scopeOf(ctx: BoardContext): GuardScope {
  return { dir: ctx.dir, root: ctx.root, home: ctx.home, ...(ctx.sanitizer ? { sanitizer: ctx.sanitizer } : {}) };
}

/** The document as the board keeps it, or a refusal in words: its shape, its size, and no secret, path or private name in its texts. */
export function checkedPreferences(ctx: BoardContext, value: unknown): Preferences {
  const problems = preferencesProblems(value);
  if (problems.length > 0) throw new BoardRefusal("usage", `Refused: the preferences cannot be kept: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? `; and ${problems.length - 5} more` : ""}. Nothing was written.`);
  const preferences = value as Preferences;
  const text = formatJson(preferences);
  if (Buffer.byteLength(text, "utf8") > PREFERENCES_MAX_BYTES) throw new BoardRefusal("usage", `Refused: the preferences are larger than ${PREFERENCES_MAX_BYTES / 1024} KB. Nothing was written.`);
  const scope = scopeOf(ctx);
  const names = readPrivateNames(ctx.dir);
  for (const name of Object.keys(preferences.projects)) refuseUnsafe(scope, "a project's name in the preferences", name, names);
  if (preferences.lastProject !== undefined && preferences.lastProject !== "" && preferences.lastProject !== NO_PROJECT) refuseUnsafe(scope, "the last project in the preferences", preferences.lastProject, names);
  return preferences;
}

/** The lines a board folder's .gitignore may already have for the local folder. */
const LOCAL_IGNORED = [".local", ".local/", "/.local", "/.local/", ".local/*", "/.local/*"];

/**
 * Makes sure git leaves `.local/` alone: a line in the board folder's .gitignore, added (or the file
 * created) when it has none. A board folder that is the repository's root is not given that line (the
 * repository's own .gitignore is never touched); `.local/` then gets a .gitignore of its own that
 * ignores everything in it. Returns what it wrote, relative to the board folder.
 */
export function ensureLocalIgnored(ctx: BoardContext): string[] {
  if (path.resolve(ctx.dir) === path.resolve(ctx.root)) {
    const inner = path.join(ctx.dir, LOCAL_FOLDER, ".gitignore");
    if (fs.existsSync(inner)) return [];
    fs.mkdirSync(path.dirname(inner), { recursive: true });
    fs.writeFileSync(inner, "*\n", "utf8");
    return [`${LOCAL_FOLDER}/.gitignore`];
  }
  const file = path.join(ctx.dir, ".gitignore");
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    text = "";
  }
  if (text.split(/\r?\n/).some((line) => LOCAL_IGNORED.includes(line.trim()))) return [];
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const joined = text === "" || text.endsWith("\n") ? text : `${text}${eol}`;
  fs.mkdirSync(ctx.dir, { recursive: true });
  fs.writeFileSync(file, `${joined}${LOCAL_FOLDER}/${eol}`, "utf8");
  return [".gitignore"];
}

/** Checks a preferences document and writes it (`.local/preferences.json`, whole, through a temporary file), after making sure git ignores it. */
export function writePreferences(ctx: BoardContext, value: unknown): Preferences {
  const preferences = checkedPreferences(ctx, value);
  if (!fs.existsSync(path.join(ctx.dir, "board.json"))) throw new BoardRefusal("no-board", `No board at ${ctx.dir} (no board.json there). Nothing was written.`);
  ensureLocalIgnored(ctx);
  writeFileAtomic(preferencesPath(ctx.dir), `${formatJson(preferences)}\n`);
  return preferences;
}
