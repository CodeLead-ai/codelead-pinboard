import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boardContext, createCards, initBoard, takeCard, type NewCardInput } from "../core/index.js";
import { buildPage, createBoardServer, pageLocation, type BoardServer } from "../server/index.js";

const browser: Browser | undefined = await (async () => {
  try {
    const { chromium } = await import("playwright");
    return await chromium.launch();
  } catch {
    return undefined;
  }
})();

const PEOPLE = [
  { id: "robin", kind: "person" as const, name: "Robin" },
  { id: "claude", kind: "agent" as const, name: "Claude Code" },
  { id: "codex", kind: "agent" as const, name: "Codex" }
];

function ready(title: string, touch: string, more: Partial<NewCardInput> = {}): NewCardInput {
  return { type: "task", title, column: "ready", ...more, fields: { definitionOfDone: "npm test passes", mayTouch: [touch], limitMinutes: 30 } };
}

/**
 * The claim on the page: a held card's tile says who holds it and how long is left (or that its
 * claim ran out), a Ready card that would not be given now says why in one line, and the card's
 * thread tells each step of its claim in words.
 */
describe.skipIf(!browser)("the dispatcher on the page", () => {
  let base: string;
  let server: BoardServer;
  let context: BrowserContext;
  let page: Page;
  const tile = (id: number) => page.locator(`.tile[data-card='${id}']`);

  beforeAll(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "pinboard-dispatch-page-"));
    const root = path.join(base, "repo");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    const dir = path.join(root, "board");
    const ctx = boardContext({ dir, root, home: "/home/tester" });
    initBoard(ctx, { name: "Dispatch board", participants: PEOPLE });
    createCards(ctx, "robin", [{ type: "task", title: "Pick the store", column: "backlog" }, ready("Auth folder", "src/auth/")], { tagCreator: false });
    // Claude is given #2 now; Codex was given #3 an hour ago, and its claim ran out.
    expect(takeCard(ctx, { as: "claude" })).toMatchObject({ given: true, card: { id: 2 } });
    createCards(ctx, "robin", [ready("Old work", "src/old/")], { tagCreator: false });
    const hourAgo = boardContext({ dir, root, home: "/home/tester", now: () => new Date(Date.now() - 60 * 60_000) });
    expect(takeCard(hourAgo, { as: "codex" })).toMatchObject({ given: true, card: { id: 3 } });
    createCards(
      ctx,
      "robin",
      [ready("Login form", "src/auth/login.ts"), ready("Sessions", "src/sessions/", { relations: [{ kind: "blocked-by", to: 1 }] }), ready("For Codex only", "src/codex/", { tags: ["for:codex"] })],
      { tagCreator: false }
    );

    const pageDir = path.join(base, "page");
    await buildPage(pageLocation(), pageDir);
    server = createBoardServer({ dir, root, pageDir, log: () => undefined });
    const { url } = await server.listen(0);
    context = await browser!.newContext({ viewport: { width: 1700, height: 1000 } });
    await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
    page = await context.newPage();
    await page.goto(url);
    await tile(1).waitFor();
  }, 120_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await server?.close();
    if (base) fs.rmSync(base, { recursive: true, force: true });
  }, 120_000);

  it("says on a held card's tile who holds it and how long is left, and when its claim ran out", async () => {
    expect(await page.locator("[data-column='in-progress'] .tile[data-card='2']").count()).toBe(1);
    expect(await tile(2).getByTestId("tile-claim").textContent()).toMatch(/^held by Claude Code · (30|29) min left$/);
    expect(await tile(3).getByTestId("tile-claim").textContent()).toBe("the claim of Codex ran out");
    expect(await tile(3).getByTestId("tile-claim").getAttribute("class")).toContain("tile-claim-out");
  });

  it("says on each Ready card that would not be given now why, in one short line", async () => {
    expect(await tile(4).getByTestId("tile-wait").textContent()).toBe("its files are in use by #2");
    expect(await tile(5).getByTestId("tile-wait").textContent()).toBe("waits on #1");
    expect(await tile(6).getByTestId("tile-wait").textContent()).toBe("for Codex");
    // A card in another column has no such line.
    expect(await tile(1).getByTestId("tile-wait").count()).toBe(0);
  });

  it("tells the claim's steps in the card's thread, in words, and who holds it beside the card's front matter", async () => {
    await tile(2).click();
    const panel = page.getByTestId("panel");
    await panel.waitFor();
    expect(await panel.getByTestId("panel-claim").textContent()).toMatch(/^Held byClaude Code · until \d\d:\d\dZ$/);
    const events = panel.getByTestId("thread-event");
    expect(await events.count()).toBe(1);
    expect(await events.first().textContent()).toMatch(/^Claude Code was given it from Ready: holds it until \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ \(30 minutes\)\d\d:\d\dZ$/);
  });
});
