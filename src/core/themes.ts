/**
 * The page's themes and the shape of the board's view preferences (`.local/preferences.json`): the
 * ten themes the page can wear, which of them a light and a dark system setting may follow, and what
 * a preferences document may hold. No dependency at all: the page's build bundles this file, as it
 * bundles mentions.ts, and the server checks a document with the same words before it writes one.
 */

export type ThemeMode = "light" | "dark";
export type ThemeGroup = "light" | "dark" | "contrast";

export interface ThemeInfo {
  id: string;
  name: string;
  mode: ThemeMode;
  group: ThemeGroup;
  /** The face the theme reads in, as the menu and the README name it. */
  font: string;
  /** What sets it apart, in a few words. */
  about: string;
}

/** The ten themes, in the menu's order: four light, four dark, two high contrast. */
export const THEMES: readonly ThemeInfo[] = [
  { id: "paper", name: "Paper", mode: "light", group: "light", font: "IBM Plex Sans", about: "cool paper, navy ink: the first theme" },
  { id: "linen", name: "Linen", mode: "light", group: "light", font: "Charter", about: "warm cream, brown ink, a serif" },
  { id: "frost", name: "Frost", mode: "light", group: "light", font: "Trebuchet MS", about: "cool blue-grey, teal accents" },
  { id: "sage", name: "Sage", mode: "light", group: "light", font: "Verdana", about: "soft grey-green, low glare, a wide face" },
  { id: "navy", name: "Navy", mode: "dark", group: "dark", font: "IBM Plex Sans", about: "the run report's navy: the first dark theme" },
  { id: "pitch", name: "Pitch", mode: "dark", group: "dark", font: "Tahoma", about: "true black" },
  { id: "dusk", name: "Dusk", mode: "dark", group: "dark", font: "Seravek", about: "dim blue-grey" },
  { id: "ember", name: "Ember", mode: "dark", group: "dark", font: "Iowan Old Style", about: "warm dark brown, a serif" },
  { id: "contrast-light", name: "High contrast light", mode: "light", group: "contrast", font: "Atkinson Hyperlegible Next", about: "black on white, 7:1 text" },
  { id: "contrast-dark", name: "High contrast dark", mode: "dark", group: "contrast", font: "Atkinson Hyperlegible Next", about: "white on black, 7:1 text" }
];

/** The choice that follows the system between the person's light theme and their dark theme. */
export const SYSTEM_THEME = "system";
export const DEFAULT_LIGHT_THEME = "paper";
export const DEFAULT_DARK_THEME = "navy";

/** A board background that is the theme's own (the default). */
export const THEME_BACKGROUND = "theme";

export function themeOf(id: string | undefined): ThemeInfo | undefined {
  return THEMES.find((theme) => theme.id === id);
}

/** The themes a light system setting may follow (the light ones and the light high-contrast one), or a dark one. */
export function themesFor(mode: ThemeMode): ThemeInfo[] {
  return THEMES.filter((theme) => theme.mode === mode);
}

export const PREFERENCES_SCHEMA = "pinboard.preferences/1";

/** The project "No project" stands for in an address and in `lastProject`: cards with no `repo:` tag. */
export const NO_PROJECT = "(none)";

/** A theme, a light and a dark theme for "System", and a board background: each optional in a project, which falls back to the default. */
export interface ThemeChoices {
  /** One of THEMES' ids, or "system". */
  theme?: string;
  /** What "system" follows when the system is light. */
  lightTheme?: string;
  /** What "system" follows when the system is dark. */
  darkTheme?: string;
  /** "theme" (the theme's own) or a colour, `#rrggbb`. */
  background?: string;
}

export interface Preferences {
  schema: string;
  default: { theme: string; lightTheme: string; darkTheme: string; background?: string };
  projects: Record<string, ThemeChoices>;
  /** The project the page showed last: "" for all projects, NO_PROJECT, or a project's name. */
  lastProject?: string;
}

export function defaultPreferences(): Preferences {
  return { schema: PREFERENCES_SCHEMA, default: { theme: SYSTEM_THEME, lightTheme: DEFAULT_LIGHT_THEME, darkTheme: DEFAULT_DARK_THEME }, projects: {} };
}

/** At most this many projects keep choices of their own. */
export const PREFERENCES_PROJECT_LIMIT = 500;

/** A project's name in the preferences: one line of up to 100 characters, no control character. */
export function projectNameProblem(name: string): string | undefined {
  if (name.trim() === "") return "is empty";
  if (name.length > 100) return "is longer than 100 characters";
  // Control characters (a line break, a tab): a project's name is one line.
  if (/[\u0000-\u001f\u007f]/.test(name)) return "is not one line";
  return undefined;
}

function isColour(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
}

function choiceProblems(value: unknown, where: string, complete: boolean): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${where} must be an object`];
  const entry = value as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(entry)) {
    if (!["theme", "lightTheme", "darkTheme", "background"].includes(key)) problems.push(`${where} has a key "${key}" the preferences do not have (theme, lightTheme, darkTheme, background)`);
  }
  const ids = THEMES.map((theme) => theme.id);
  const check = (key: string, allowed: string[], words: string): void => {
    const given = entry[key];
    if (given === undefined) {
      if (complete) problems.push(`${where} has no ${key}`);
      return;
    }
    if (typeof given !== "string" || !allowed.includes(given)) problems.push(`${where}.${key} must be ${words}, and is ${JSON.stringify(given)}`);
  };
  check("theme", [...ids, SYSTEM_THEME], `one of ${[...ids, SYSTEM_THEME].join(", ")}`);
  check("lightTheme", themesFor("light").map((theme) => theme.id), `a light theme (${themesFor("light").map((theme) => theme.id).join(", ")})`);
  check("darkTheme", themesFor("dark").map((theme) => theme.id), `a dark theme (${themesFor("dark").map((theme) => theme.id).join(", ")})`);
  const background = entry.background;
  if (background !== undefined && (typeof background !== "string" || (background !== THEME_BACKGROUND && !isColour(background)))) {
    problems.push(`${where}.background must be "theme" or a colour like #2a3b4c, and is ${JSON.stringify(background)}`);
  }
  return problems;
}

/** What is wrong with a preferences document, in words; nothing when it is one. */
export function preferencesProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["the preferences must be one JSON object"];
  const doc = value as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(doc)) {
    if (!["schema", "default", "projects", "lastProject"].includes(key)) problems.push(`the preferences have a key "${key}" they do not have (schema, default, projects, lastProject)`);
  }
  if (doc.schema !== PREFERENCES_SCHEMA) problems.push(`"schema" must be "${PREFERENCES_SCHEMA}", and is ${JSON.stringify(doc.schema)}`);
  problems.push(...choiceProblems(doc.default, "default", true));
  const projects = doc.projects;
  if (typeof projects !== "object" || projects === null || Array.isArray(projects)) problems.push('"projects" must map each project\'s name to its choices');
  else {
    const names = Object.keys(projects);
    if (names.length > PREFERENCES_PROJECT_LIMIT) problems.push(`"projects" holds ${names.length} projects; at most ${PREFERENCES_PROJECT_LIMIT} keep choices of their own`);
    for (const name of names) {
      const problem = projectNameProblem(name);
      if (problem) problems.push(`the project name ${JSON.stringify(name.slice(0, 40))} ${problem}`);
      else problems.push(...choiceProblems((projects as Record<string, unknown>)[name], `projects[${JSON.stringify(name)}]`, false));
    }
  }
  const last = doc.lastProject;
  if (last !== undefined) {
    if (typeof last !== "string") problems.push('"lastProject" must be a project\'s name, "(none)" or ""');
    else if (last !== "") {
      const problem = projectNameProblem(last);
      if (problem) problems.push(`"lastProject" ${problem}`);
    }
  }
  return problems;
}

/** The choices that apply to a project: its own, then the default's, key by key. "" (all projects) and NO_PROJECT take the default. */
export function choicesFor(preferences: Preferences, project: string): Required<Pick<ThemeChoices, "theme" | "lightTheme" | "darkTheme" | "background">> {
  const own = project === "" || project === NO_PROJECT ? {} : (preferences.projects[project] ?? {});
  return {
    theme: own.theme ?? preferences.default.theme,
    lightTheme: own.lightTheme ?? preferences.default.lightTheme,
    darkTheme: own.darkTheme ?? preferences.default.darkTheme,
    background: own.background ?? preferences.default.background ?? THEME_BACKGROUND
  };
}

/** The theme a set of choices shows, given whether the system is dark now. */
export function effectiveTheme(choices: Pick<ThemeChoices, "theme" | "lightTheme" | "darkTheme">, systemDark: boolean): ThemeInfo {
  const wanted = choices.theme === SYSTEM_THEME || choices.theme === undefined ? (systemDark ? choices.darkTheme : choices.lightTheme) : choices.theme;
  return themeOf(wanted) ?? themeOf(systemDark ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME)!;
}
