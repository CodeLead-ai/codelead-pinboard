import { NO_PROJECT } from "../../core/themes.js";

/**
 * Projects on the page: a project is a `repo:<name>` tag on the cards. The selector at the left of the
 * top bar shows "All projects", one entry per project found on the cards (with how many of its cards
 * are open: not archived, not in the board's last column), and "No project" for the cards with no
 * `repo:` tag. The choice narrows the whole board and is kept in the address (`?project=<name>`).
 */

export { NO_PROJECT };

export const PROJECT_PREFIX = "repo:";

/** What the selector needs of a card. */
export interface ProjectCard {
  tags: string[];
  column: string;
  archived?: string;
}

export interface ProjectEntry {
  /** "" for all projects, NO_PROJECT, or the project's name. */
  name: string;
  /** Its open cards: not archived, not in the last column. */
  open: number;
}

/** The project names a card's tags give (a card may carry more than one). */
export function projectNamesOf(tags: readonly string[]): string[] {
  return tags.filter((tag) => tag.startsWith(PROJECT_PREFIX) && tag.length > PROJECT_PREFIX.length).map((tag) => tag.slice(PROJECT_PREFIX.length));
}

/** True when the card belongs to the project: "" takes every card, NO_PROJECT the cards with no project. */
export function inProject(card: Pick<ProjectCard, "tags">, project: string): boolean {
  if (project === "") return true;
  const names = projectNamesOf(card.tags);
  if (project === NO_PROJECT) return names.length === 0;
  return names.includes(project);
}

function isOpen(card: ProjectCard, lastColumn: string | undefined): boolean {
  return card.archived === undefined && card.column !== lastColumn;
}

/**
 * The selector's entries: All projects, then each project by name, then No project (only when a card
 * has no project and some card has one), each with its open cards.
 */
export function projectEntries(cards: readonly ProjectCard[], lastColumn: string | undefined): ProjectEntry[] {
  const counts = new Map<string, number>();
  let none = 0;
  let noneSeen = false;
  let all = 0;
  for (const card of cards) {
    const names = projectNamesOf(card.tags);
    const open = isOpen(card, lastColumn);
    if (open) all += 1;
    if (names.length === 0) {
      if (card.archived === undefined) noneSeen = true;
      if (open) none += 1;
    }
    for (const name of new Set(names)) counts.set(name, (counts.get(name) ?? 0) + (open ? 1 : 0));
  }
  const named = [...counts.keys()].sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }));
  return [
    { name: "", open: all },
    ...named.map((name) => ({ name, open: counts.get(name)! })),
    ...(named.length > 0 && noneSeen ? [{ name: NO_PROJECT, open: none }] : [])
  ];
}

/** The project the address names (`?project=`; a bookmark of the first page's `?repo=` too), or undefined when it names none. */
export function readProject(search: string): string | undefined {
  const query = new URLSearchParams(search);
  const project = query.get("project") ?? query.get("repo");
  return project === null ? undefined : project;
}

/** The selector's words for a project. */
export function projectLabel(project: string): string {
  if (project === "") return "All projects";
  if (project === NO_PROJECT) return "No project";
  return project;
}

/** The tags a new card gets while a project is selected: the project's tag (none for all projects or no project). */
export function projectTags(project: string): string[] {
  return project === "" || project === NO_PROJECT ? [] : [`${PROJECT_PREFIX}${project}`];
}
