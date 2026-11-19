import fs from "node:fs";
import path from "node:path";
import { addComment, boardContext, createCards, initBoard, moveCard, updateCard, type BoardContext, type NewCardInput } from "../core/index.js";

/**
 * A made-up board for the themes' tests and screenshots: one person (robin) and two agents (claude,
 * codex) on three projects (api, web, docs) and a few cards with no project, in every column, with
 * decisions and their asks, tags, colour marks, threads, a mention of the person and an agent at work.
 * Nothing in it is real.
 */
export function makeDemoBoard(root: string, now: () => Date = () => new Date()): { ctx: BoardContext; dir: string } {
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  const dir = path.join(root, "docs", "codelead", "board");
  const ctx = boardContext({ dir, root, home: "/home/tester", now });
  initBoard(ctx, {
    name: "demo-workspace",
    participants: [
      { id: "robin", kind: "person", name: "Robin" },
      { id: "claude", kind: "agent", name: "Claude Code" },
      { id: "codex", kind: "agent", name: "Codex" }
    ]
  });
  const byRobin = (inputs: NewCardInput[]): void => {
    createCards(ctx, "robin", inputs, { tagCreator: false });
  };
  byRobin([
    {
      type: "task",
      title: "Add a sign-in page",
      column: "inbox",
      tags: ["repo:web", "area:auth"],
      description: "Users sign in before they see the dashboard. Email and password first; magic links later.\n\nSee `src/pages/home.ts` for the layout the page should follow."
    },
    { type: "task", title: "Rate-limit the sign-in form", column: "backlog", tags: ["repo:api", "area:auth"], fields: { size: "M" } },
    { type: "task", title: "Write the API reference for /cards", column: "backlog", tags: ["repo:docs"] },
    { type: "task", title: "Move the settings page to the new layout", column: "backlog", tags: ["repo:web"], color: "green" },
    { type: "idea", title: "A weekly summary of what landed", column: "ideas" },
    { type: "note", title: "Notes from the design review", column: "ideas", tags: ["repo:docs"] },
    {
      type: "decision",
      title: "Pick the session store",
      column: "pinned",
      tags: ["repo:api", "area:auth"],
      fields: { ask: "Cookie or Redis for sessions? I recommend the cookie until we run more than one instance.", options: ["A signed cookie", "Redis"] },
      description: "Two ways to keep a session. The cookie needs nothing new; Redis survives a restart and serves several instances."
    },
    { type: "decision", title: "Name the public package", column: "pinned", fields: { ask: "Two names are free: pinboard-kit and pinboard-core. I lean to pinboard-kit.", decided: { option: "pinboard-kit", by: "robin", on: "2026-11-18" } } },
    { type: "task", title: "Cache the board's reads", column: "backlog", tags: ["repo:api", "for:codelead"], fields: { definitionOfDone: "A read of an unchanged board touches no card file." } },
    { type: "task", title: "Keyboard shortcuts for the filter bar", column: "backlog", tags: ["repo:web", "area:ui"] },
    { type: "review", title: "Review the error messages", column: "for-review", tags: ["repo:web"], color: "orange" },
    { type: "task", title: "Upgrade the test runner", column: "in-progress", tags: ["repo:api"] },
    { type: "task", title: "Set up the board", column: "done" },
    { type: "task", title: "Fix the flaky upload test", column: "done", tags: ["repo:web"] }
  ]);
  createCards(ctx, "claude", [
    { type: "question", title: "Should sessions survive a restart?", column: "inbox", tags: ["repo:api"], description: "It decides the store (#7). @robin, which do you expect?" },
    { type: "idea", title: "Show the build time on each card", column: "ideas" }
  ]);
  addComment(ctx, 1, { as: "claude", body: "I can take this after #7 is decided. Which fields does the form need besides email and password?" });
  addComment(ctx, 1, { as: "robin", body: "Email and password only. A \"remember me\" box can wait." });
  addComment(ctx, 7, { as: "claude", body: "With one instance the cookie is enough; Redis only pays off once we scale out. @robin" });
  moveCard(ctx, 9, { as: "claude", to: "in-progress", comment: "Started, as you asked in the session: reading the stamps before the files." });
  addComment(ctx, 9, { as: "claude", body: "Half done: a quiet check reads no card file now. The log still reads in full; next." });
  addComment(ctx, 10, { as: "codex", body: "Proposal: `/` searches, `n` new card, `f` focuses the filter. Conflicts with nothing." });
  addComment(ctx, 12, { as: "codex", body: "Landed: the runner on the new major; 214 tests green, two slow ones marked." });
  updateCard(ctx, 12, { as: "codex", changes: { status: "waiting on the regression" } });
  addComment(ctx, 11, { as: "claude", body: "Seven messages rewritten to say what to do next; the list is in the description." });
  return { ctx, dir };
}
