import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Browser, BrowserContext, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addComment, boardContext, createCards, initBoard, moveCard, readEvents, type BoardContext, type NewCardInput } from "../core/index.js";
import { buildPage, createBoardServer, pageLocation, type BoardServer } from "../server/index.js";

/**
 * The page's main flows in a real browser, against the page as it is built and served, on a
 * board of the test's own: open the board, open a card from a notification, reply, move by drag
 * and by keyboard, filter without losing the columns, see a card edited on disk change in place,
 * create a card, comment and move in one step, archive, both themes, the mentions (the list
 * after @, the chip, the "@you" on a card), and a decision recorded on the panel (its event, its tile).
 *
 * With PINBOARD_SCREENSHOTS=<folder>, it also saves the board and a card's panel, light and dark.
 */
const browser: Browser | undefined = await (async () => {
  try {
    const { chromium } = await import("playwright");
    return await chromium.launch();
  } catch {
    return undefined;
  }
})();

const SHOTS = process.env.PINBOARD_SCREENSHOTS;

describe.skipIf(!browser)("the board's page in a browser", () => {
  let base = "";
  let dir = "";
  let ctx: BoardContext;
  let server: BoardServer;
  let url = "";
  let context: BrowserContext;
  let page: Page;
  const problems: string[] = [];

  const fileOf = (id: number): string => {
    const name = fs.readdirSync(path.join(dir, "items")).find((entry) => entry.startsWith(`${String(id).padStart(4, "0")}-`));
    if (!name) throw new Error(`no file for card ${id}`);
    return path.join(dir, "items", name);
  };
  const tile = (id: number) => page.locator(`.tile[data-card='${id}']`);
  const capsule = () => page.getByTestId("capsule");
  const shot = async (name: string): Promise<void> => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  };

  beforeAll(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), "pinboard-page-"));
    const root = path.join(base, "repo");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "plan.md"), "# The plan\n\nThe two options.\n");
    dir = path.join(root, "docs", "codelead", "board");
    ctx = boardContext({ dir, root, home: "/home/tester" });
    initBoard(ctx, { name: "test-workspace", participants: [
      { id: "robin", kind: "person", name: "Robin" },
      { id: "claude", kind: "agent", name: "Claude Code" }
    ] });
    const byPerson = (input: NewCardInput): void => {
      createCards(ctx, "robin", [input], { tagCreator: false });
    };
    byPerson({ type: "decision", title: "Pick the cache strategy", column: "pinned", tags: ["repo:demo", "area:cache"], description: "Weigh the two options in `docs/plan.md:3`; the layer itself is #2." });
    byPerson({ type: "task", title: "Write the cache layer", column: "backlog", relations: [{ kind: "child-of", to: 1 }] });
    createCards(ctx, "claude", [{ type: "idea", title: "Cache the board's reads", tags: ["repo:demo"] }]);
    byPerson({ type: "question", title: "Which TTL?", column: "for-review" });
    byPerson({ type: "task", title: "Measure the reads", column: "backlog" });
    addComment(ctx, 1, { as: "claude", body: "Option B reads best: a TTL of one minute." });
    moveCard(ctx, 2, { as: "claude", to: "in-progress", comment: "Started, as you asked in the session; it follows #1." });

    const outDir = path.join(base, "page");
    await buildPage(pageLocation(), outDir);
    server = createBoardServer({ dir, root, home: "/home/tester", pageDir: outDir, debounceMs: 30, settleMs: 300, log: () => undefined });
    url = (await server.listen(0)).url;

    // Wider than 1,500 px: under it, Done starts collapsed (package 2b), and these flows look into Done.
    context = await browser!.newContext({ viewport: { width: 1600, height: 900 }, colorScheme: "light" });
    // The page asks Google Fonts for its faces; the test keeps to this machine and the fallbacks.
    await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
    page = await context.newPage();
    page.on("pageerror", (error) => problems.push(error.message));
    page.on("console", (message) => {
      // Not page errors: the fonts this test blocks, and the browser's line for the 409 one flow provokes on purpose.
      if (message.type() === "error" && !/fonts\.googleapis|ERR_FAILED|status of 409 \(Conflict\)/.test(message.text())) problems.push(message.text());
    });
  }, 120_000);

  // Closing the browser under the whole suite's load took longer than the default 10 s once (the
  // package-2 gate, 2026-10-04): the teardown gets the same room as the set-up.
  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await server?.close();
    if (base) await rm(base, { recursive: true, force: true });
  }, 120_000);

  it("is built into one script and one stylesheet, served with its content security policy", async () => {
    const index = fs.readFileSync(path.join(base, "page", "index.html"), "utf8");
    expect(index).toMatch(/<script type="module" crossorigin src="\.\/assets\/index-[\w-]+\.js"><\/script>/);
    expect(index).toMatch(/<link rel="stylesheet" crossorigin href="\.\/assets\/index-[\w-]+\.css">/);
    const response = await fetch(url);
    expect(response.headers.get("content-security-policy")).toMatch(/script-src 'self' 'sha256-/);
  });

  it("opens the board: the columns in the board's order with their counts, the tiles, the capsule", async () => {
    await page.goto(url);
    await tile(1).waitFor();
    expect(await page.locator(".column-title h2").allTextContents()).toEqual(["Inbox", "Backlog", "Ideas", "Pinned", "In progress", "For review", "Done"]);
    expect(await page.getByTestId("count-backlog").textContent()).toBe("1");
    expect(await page.getByTestId("count-pinned").textContent()).toBe("1");
    expect(await page.locator("[data-column='pinned'] .column-note").textContent()).toBe("waits on you");
    expect(await page.locator("[data-column='ideas'] .column-empty").textContent()).toBe("No ideas parked yet.");
    // A tile: type, title, tags (the repository in colour), who wrote last and when, the excerpt, the flag.
    await expect.poll(() => tile(1).innerText()).toContain("Option B reads best");
    const decision = await tile(1).innerText();
    expect(decision).toMatch(/decision/i);
    expect(decision).toContain("Pick the cache strategy");
    expect(decision).toMatch(/Claude Code (now|\d+ min)/);
    expect(await tile(1).locator(".chip-repo").textContent()).toBe("demo");
    expect(await tile(1).locator(".mark-flag").count()).toBe(1);
    // The agent's proposal is dashed until the person touches it; the agent's work shows a gear.
    expect(await tile(3).getAttribute("class")).toContain("tile-proposal");
    expect(await tile(2).locator(".mark-gear").count()).toBe(1);
    // The capsule: Claude's idea, its comment on #1, its comment and move on #2.
    await expect.poll(() => capsule().getAttribute("aria-label")).toBe("4 new");
    expect(await tile(1).locator(".tile-unseen").count()).toBe(1);
    await shot("board-light");
  });

  it("opens a card from a notification: the panel shows it, its lines clear, a related card opens on top and Esc pops it", async () => {
    await capsule().click();
    const list = page.getByTestId("notifications");
    await list.waitFor();
    expect(await list.locator(".note-card .note-id").allTextContents()).toEqual(["#2", "#1", "#3"]);
    await list.locator(".note-line", { hasText: "Option B reads best" }).click();
    const panel = page.getByTestId("panel");
    await expect.poll(() => panel.locator(".panel-title").textContent()).toBe("Pick the cache strategy");
    await expect.poll(() => capsule().getAttribute("aria-label")).toBe("3 new");
    expect(await panel.getByTestId("comment").first().innerText()).toContain("Option B reads best");
    // The description's path opens in the editor; the card id opens that card on top.
    const link = panel.locator("a.ref-path");
    expect(await link.getAttribute("href")).toBe(`vscode://file${path.join(dir, "..", "..", "plan.md").split(path.sep).map(encodeURIComponent).join("/")}:3`);
    await shot("panel-light");
    await panel.locator("a.ref-card[data-card='2']").click();
    await expect.poll(() => page.getByTestId("panel").locator(".panel-title").textContent()).toBe("Write the cache layer");
    expect(await page.getByTestId("panel").locator(".crumbs").innerText()).toContain("#1 Pick the cache strategy");
    expect(await page.getByTestId("panel").getByTestId("panel-related").innerText()).toContain("child of");
    // A card id in a comment that names no file is a link too.
    expect(await page.getByTestId("panel").locator(".comment-body a.ref-card[data-card='1']").count()).toBe(1);
    await expect.poll(() => capsule().getAttribute("aria-label")).toBe("1 new");
    await page.keyboard.press("Escape");
    await expect.poll(() => page.getByTestId("panel").locator(".panel-title").textContent()).toBe("Pick the cache strategy");
    expect(await page.getByTestId("panel-below").count()).toBe(0);
  });

  it("replies in the thread: the comment shows, and it is in the card's file", async () => {
    const panel = page.getByTestId("panel");
    await panel.getByTestId("reply-text").fill("Option B, with a TTL of one minute.");
    await panel.getByTestId("reply-send").click();
    await expect.poll(() => panel.getByTestId("comment").allInnerTexts()).toEqual([expect.stringContaining("Option B reads best"), expect.stringContaining("Option B, with a TTL of one minute.")]);
    expect(fs.readFileSync(fileOf(1), "utf8")).toMatch(/### robin · \d{4}-\d\d-\d\dT[\d:]+Z\nOption B, with a TTL of one minute\.\n/);
    expect(await panel.getByTestId("reply-text").inputValue()).toBe("");
    // Esc leaves the reply box, then closes the card.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect.poll(() => page.getByTestId("panel").count()).toBe(0);
    // The person answered: the flag is gone from the tile.
    await expect.poll(() => tile(1).locator(".mark-flag").count()).toBe(0);
  });

  it("moves a card by drag and drop, and the agent's proposal stops looking like one", async () => {
    // Dropped at the top of Backlog: a card lands where it is dropped (package 2b), and the next flow walks it from there.
    await page.dragAndDrop(".tile[data-card='3']", "[data-column='backlog'] .column-body", { targetPosition: { x: 60, y: 4 } });
    await page.locator("[data-column='backlog'] .tile[data-card='3']").waitFor();
    expect(fs.readFileSync(fileOf(3), "utf8")).toContain("column: backlog");
    await expect.poll(() => tile(3).getAttribute("class")).not.toContain("tile-proposal");
    expect(await page.getByTestId("count-backlog").textContent()).toBe("2");
    expect(await page.getByTestId("count-inbox").textContent()).toBe("0");
  });

  it("moves a card by keyboard: j and k walk a column, m and a column's number move", async () => {
    await tile(3).focus();
    await page.keyboard.press("j");
    expect(await page.locator(":focus").getAttribute("data-card")).toBe("5");
    await page.keyboard.press("k");
    expect(await page.locator(":focus").getAttribute("data-card")).toBe("3");
    await tile(4).focus();
    await page.keyboard.press("m");
    await page.getByTestId("move-picker").waitFor();
    await page.keyboard.press("7");
    await page.locator("[data-column='done'] .tile[data-card='4']").waitFor();
    expect(fs.readFileSync(fileOf(4), "utf8")).toContain("column: done");
    expect(await page.getByTestId("move-picker").count()).toBe(0);
  });

  it("filters without losing a column: counts say matching of total, the URL keeps the filter, hide removes, / searches", async () => {
    await page.getByTestId("filter-type").selectOption("decision");
    expect(await page.locator(".column-title h2").count()).toBe(7);
    await expect.poll(() => page.getByTestId("count-pinned").textContent()).toBe("1 of 1");
    expect(await page.getByTestId("count-backlog").textContent()).toBe("0 of 2");
    expect(page.url()).toContain("type=decision");
    expect(await tile(5).getAttribute("class")).toContain("tile-faded");
    await page.getByTestId("show-hide").click();
    await expect.poll(() => tile(5).count()).toBe(0);
    expect(page.url()).toContain("show=hide");
    await page.reload();
    await tile(1).waitFor();
    expect(await page.getByTestId("filter-type").inputValue()).toBe("decision");
    expect(await tile(5).count()).toBe(0);
    expect(await page.locator(".column-title h2").count()).toBe(7);
    await page.getByTestId("clear-filter").click();
    await page.getByTestId("show-fade").click();
    await expect.poll(() => tile(5).count()).toBe(1);
    expect(page.url()).not.toContain("type=");

    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("/");
    expect(await page.locator(":focus").getAttribute("data-testid")).toBe("search");
    await page.keyboard.type("cache");
    await expect.poll(() => page.locator(".filter-sum").innerText()).toBe("3 of 5 match Clear");
    expect(page.url()).toContain("q=cache");
    await page.getByTestId("search").fill("#5");
    await expect.poll(() => page.locator(".filter-sum").innerText()).toBe("1 of 5 match Clear");
    await page.getByTestId("clear-filter").click();
    await page.keyboard.press("Escape");
  });

  it("updates a card edited on disk without a reload, and counts the change the core announced for it", async () => {
    await expect.poll(() => capsule().getAttribute("aria-label")).toBe("1 new");
    const file = fileOf(5);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('title: "Measure the reads"', 'title: "Measure the reads twice"'));
    await expect.poll(() => tile(5).locator(".tile-title").textContent(), { timeout: 5000 }).toBe("Measure the reads twice");
    // Nobody wrote an event for that edit: after the settle time the core announces it, by unknown.
    await expect.poll(() => capsule().getAttribute("aria-label"), { timeout: 5000 }).toBe("2 new");
    // An agent writes through the core (as the CLI does): the tile and the capsule follow.
    addComment(ctx, 5, { as: "claude", body: "Measured: 40 ms a read on the real board." });
    await expect.poll(() => tile(5).locator(".mark-count").textContent(), { timeout: 5000 }).toBe("1");
    await expect.poll(() => capsule().getAttribute("aria-label"), { timeout: 5000 }).toBe("3 new");
    expect(await tile(5).locator(".mark-flag").count()).toBe(1);
    await capsule().click();
    expect(await page.getByTestId("notifications").innerText()).toContain("unknown changed its file with no event (title)");
    await page.getByTestId("clear-all").click();
    await expect.poll(() => capsule().getAttribute("aria-label")).toBe("Nothing new");
    await page.keyboard.press("Escape");
  });

  it("creates a card with n: it lands in Inbox, opens, and its file is written", async () => {
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("n");
    const composer = page.getByTestId("composer");
    await composer.waitFor();
    expect(await composer.locator(".composer-where").textContent()).toBe("new card in Inbox");
    await composer.getByLabel("Title").fill("Try a TTL of five minutes");
    await composer.getByRole("button", { name: "Create card" }).click();
    await expect.poll(() => page.getByTestId("panel").locator(".panel-title").textContent()).toBe("Try a TTL of five minutes");
    await page.locator("[data-column='inbox'] .tile[data-card='6']").waitFor();
    const text = fs.readFileSync(fileOf(6), "utf8");
    expect(text).toContain("column: inbox");
    expect(text).toContain("author: robin");
    expect(text).not.toContain("by:robin");
  });

  it("comments and moves in one step, then archives from Done after a confirm", async () => {
    const panel = page.getByTestId("panel");
    await panel.getByTestId("reply-text").fill("Five minutes is too long; one it is.");
    await panel.getByTestId("reply-move").click();
    await panel.locator(".move-menu button", { hasText: "Done" }).click();
    await page.locator("[data-column='done'] .tile[data-card='6']").waitFor();
    await expect.poll(() => panel.getByTestId("panel-column").inputValue()).toBe("done");
    expect(await panel.getByTestId("comment").innerText()).toContain("Five minutes is too long");
    const last = readEvents(dir).events.slice(-2).map(({ event }) => [event.kind, event.at]);
    expect(last.map(([kind]) => kind)).toEqual(["comment.added", "item.moved"]);
    expect(last[0]![1]).toBe(last[1]![1]);

    await panel.getByTestId("archive").click();
    const dialog = page.getByTestId("confirm-archive");
    await dialog.waitFor();
    expect(await dialog.innerText()).toContain("Archive #6?");
    await dialog.getByRole("button", { name: "Archive" }).click();
    await expect.poll(() => tile(6).count()).toBe(0);
    expect(await page.getByTestId("panel").count()).toBe(0);
    expect(fs.readFileSync(fileOf(6), "utf8")).toMatch(/\narchived: \d{4}-/);
    await page.getByTestId("filter-archived").check();
    await expect.poll(() => tile(6).count()).toBe(1);
    expect(await tile(6).locator(".tile-proposed").textContent()).toBe("archived");
    await page.getByTestId("filter-archived").uncheck();
  });

  it("refuses an edit of a card that changed meanwhile in the core's words, keeps the text, and saves it the second time", async () => {
    await tile(2).click();
    const panel = page.getByTestId("panel");
    await expect.poll(() => panel.locator(".panel-title").textContent()).toBe("Write the cache layer");
    await panel.getByRole("button", { name: "Edit the description" }).click();
    const editor = panel.getByLabel("the description");
    await editor.fill("Wrap the reads in a cache with a TTL of one minute.");
    // An agent writes on the card meanwhile (a second later, so that the card's updated changes).
    await page.waitForTimeout(1100);
    addComment(ctx, 2, { as: "claude", body: "Half done; the TTL is still open." });
    await expect.poll(() => panel.getByTestId("comment").count()).toBe(2);
    await panel.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => panel.locator(".refusal").textContent()).toMatch(/^Refused: card #2 changed since it was read .* The page has read it again\.$/);
    expect(await editor.inputValue()).toBe("Wrap the reads in a cache with a TTL of one minute.");
    expect(fs.readFileSync(fileOf(2), "utf8")).not.toContain("Wrap the reads");
    // The description itself did not change meanwhile: nothing to merge, and the second save is the person's choice.
    expect(await panel.locator(".newer").count()).toBe(0);
    await panel.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => panel.getByTestId("panel-description").innerText()).toContain("Wrap the reads in a cache");
    expect(fs.readFileSync(fileOf(2), "utf8")).toContain("Wrap the reads in a cache with a TTL of one minute.");
    await page.keyboard.press("Escape");
    await expect.poll(() => page.getByTestId("panel").count()).toBe(0);
  });

  it("renders dark by the system and switches with the toggle", async () => {
    // Expressions, not functions: this file is checked without the DOM's types (as the repository's other browser tests are).
    const background = async (): Promise<string> => String(await page.evaluate("getComputedStyle(document.body).backgroundColor"));
    expect(await background()).toBe("rgb(243, 246, 251)");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(background).toBe("rgb(6, 11, 24)");
    expect(await page.evaluate("getComputedStyle(document.querySelector(\".tile[data-card='1']\")).backgroundColor")).toBe("rgb(13, 21, 38)");
    await shot("board-dark");
    await tile(1).click();
    await page.getByTestId("panel").locator(".panel-title").waitFor();
    await shot("panel-dark");
    await page.keyboard.press("Escape");
    // system → light → dark → system
    await page.getByTestId("theme").click();
    await expect.poll(background).toBe("rgb(243, 246, 251)");
    expect(await page.locator("html").getAttribute("data-theme")).toBe("light");
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByTestId("theme").click();
    await expect.poll(background).toBe("rgb(6, 11, 24)");
    await page.getByTestId("theme").click();
    await expect.poll(background).toBe("rgb(243, 246, 251)");
    expect(await page.locator("html").getAttribute("data-theme")).toBeNull();
  });

  // Package 3a, the mentions: on cards of their own, so that they run alone too (`-t mention`).
  const selectedName = (list: Locator): Promise<string | null> => list.getByRole("option", { selected: true }).locator(".mention-name").textContent();
  const onTheBoard = async (): Promise<void> => {
    if (!page.url().startsWith(url)) await page.goto(url);
  };

  it("offers the participants after @ in the comment box (a mention): narrowed as you type, picked with Enter or a click, closed with Esc; the comment lands with them", async () => {
    await onTheBoard();
    const id = Number(createCards(ctx, "robin", [{ type: "question", title: "Who takes the TTL?", column: "backlog" }], { tagCreator: false })[0]!.card.id);
    await tile(id).click();
    const panel = page.getByTestId("panel");
    await expect.poll(() => panel.locator(".panel-title").textContent()).toBe("Who takes the TTL?");
    const reply = panel.getByTestId("reply-text");
    await reply.click();
    await page.keyboard.type("@");
    const list = panel.getByTestId("mention-list");
    await list.waitFor();
    // Each by name and id: the others first, the person who writes last; the first is chosen.
    expect(await list.locator(".mention-name").allTextContents()).toEqual(["Claude Code", "Robin"]);
    expect(await list.locator(".mention-id").allTextContents()).toEqual(["@claude", "@robin"]);
    expect(await selectedName(list)).toBe("Claude Code");
    expect(await reply.getAttribute("aria-activedescendant")).toBe(await list.getByRole("option", { selected: true }).getAttribute("id"));
    await shot("mention-list-light");
    // It narrows as the person types; Enter writes the mention and a space.
    await page.keyboard.type("r");
    await expect.poll(() => list.locator(".mention-name").allTextContents()).toEqual(["Robin"]);
    await page.keyboard.press("Enter");
    expect(await reply.inputValue()).toBe("@robin ");
    expect(await list.count()).toBe(0);
    // The arrows choose; a click picks.
    await page.keyboard.type("and @");
    await list.waitFor();
    await page.keyboard.press("ArrowDown");
    expect(await selectedName(list)).toBe("Robin");
    await page.keyboard.press("ArrowUp");
    expect(await selectedName(list)).toBe("Claude Code");
    await list.getByRole("option", { name: /Claude Code/ }).click();
    expect(await reply.inputValue()).toBe("@robin and @claude ");
    // Esc closes the list, and nothing else: the card stays open, the text as typed.
    await page.keyboard.type("@");
    await list.waitFor();
    await page.keyboard.press("Escape");
    expect(await list.count()).toBe(0);
    expect(await page.getByTestId("panel").count()).toBe(1);
    expect(await reply.inputValue()).toBe("@robin and @claude @");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("please take it.");
    await panel.getByTestId("reply-send").click();
    await expect.poll(() => panel.getByTestId("comment").count()).toBe(1);
    expect(fs.readFileSync(fileOf(id), "utf8")).toMatch(/### robin · [\dT:-]+Z\n@robin and @claude please take it\.\n/);
    expect(readEvents(dir).events.at(-1)!.event).toMatchObject({ by: "robin", item: id, kind: "comment.added", data: { addressed: ["robin", "claude"] } });
    // In the thread each mention is a chip: the participant's name after their mark, the person's or an agent's.
    const chips = panel.getByTestId("comment").locator(".mention");
    expect(await chips.allTextContents()).toEqual(["Robin", "Claude Code"]);
    expect(await chips.nth(0).getAttribute("class")).toBe("mention mention-person mention-you");
    expect(await chips.nth(1).getAttribute("class")).toBe("mention mention-agent");
    expect(await chips.nth(1).locator(".mention-avatar").getAttribute("class")).toBe("mention-avatar avatar-agent");
    await shot("mention-light");
    if (SHOTS) {
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForTimeout(2600);
      await shot("mention-dark");
      await page.emulateMedia({ colorScheme: "light" });
    }
    // Sent with ⌘↵ while the list is open: the box empties, and the list goes with it.
    await reply.click();
    await page.keyboard.type("Thanks @");
    await list.waitFor();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect.poll(() => panel.getByTestId("comment").count()).toBe(2);
    expect(await reply.inputValue()).toBe("");
    expect(await list.count()).toBe(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect.poll(() => page.getByTestId("panel").count()).toBe(0);
  });

  it("marks a card @you while an agent's mention of the person is unseen, clears it once opened; code stays text; the description editor offers the names too", async () => {
    await onTheBoard();
    const id = Number(createCards(ctx, "robin", [{ type: "task", title: "Name the cache key", column: "backlog" }], { tagCreator: false })[0]!.card.id);
    await tile(id).waitFor();
    expect(await tile(id).getByTestId("tile-mention").count()).toBe(0);
    addComment(ctx, id, { as: "claude", body: "@Robin, which name? `@robin` in code is no mention." });
    await expect.poll(() => tile(id).getByTestId("tile-mention").count(), { timeout: 5000 }).toBe(1);
    expect(await tile(id).getByTestId("tile-mention").textContent()).toBe("@you");
    expect(await tile(id).getAttribute("aria-label")).toContain(", addressed to you");
    await shot("mention-tile-light");
    if (SHOTS) {
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForTimeout(2600);
      await shot("mention-tile-dark");
      await page.emulateMedia({ colorScheme: "light" });
    }
    await tile(id).click();
    const panel = page.getByTestId("panel");
    await expect.poll(() => panel.locator(".panel-title").textContent()).toBe("Name the cache key");
    const body = panel.getByTestId("comment").locator(".comment-body");
    expect(await body.locator(".mention").allTextContents()).toEqual(["Robin"]);
    expect(await body.locator("code").textContent()).toBe("@robin");
    expect(await body.locator("code .mention").count()).toBe(0);
    // Opened: the mark is gone, as the dot is.
    await expect.poll(() => tile(id).getByTestId("tile-mention").count()).toBe(0);
    // The description: the same list after @; the saved text shows the chip and its event says who it addresses.
    await panel.getByRole("button", { name: "Edit the description" }).click();
    const editor = panel.getByLabel("the description");
    await editor.click();
    await page.keyboard.type("Over to @cl");
    const list = panel.getByTestId("mention-list");
    await list.waitFor();
    expect(await list.locator(".mention-name").allTextContents()).toEqual(["Claude Code"]);
    await page.keyboard.press("Enter");
    expect(await editor.inputValue()).toBe("Over to @claude ");
    await panel.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => panel.getByTestId("panel-description").locator(".mention").allTextContents()).toEqual(["Claude Code"]);
    expect(readEvents(dir).events.at(-1)!.event).toMatchObject({ by: "robin", item: id, kind: "item.updated", data: { fields: ["description"], addressed: ["claude"] } });
    await page.keyboard.press("Escape");
    await expect.poll(() => page.getByTestId("panel").count()).toBe(0);
  });

  // Package 3b, a decision recorded in the fields: on a card of its own, so that it runs alone too (`-t decision`).
  it("records a decision on the panel: its event carries it as data.decided, and the tile says the option chosen under the ask", async () => {
    await onTheBoard();
    const ask = "Keep a TTL or use a version key? I recommend the version key.";
    const id = Number(createCards(ctx, "robin", [{ type: "decision", title: "Name the cache's key", column: "pinned", fields: { ask, options: ["Keep a TTL", "Use a version key"] } }], { tagCreator: false })[0]!.card.id);
    await tile(id).waitFor();
    expect(await tile(id).getByTestId("tile-ask").textContent()).toBe(ask);
    expect(await tile(id).getByTestId("tile-decided").count()).toBe(0);
    await tile(id).click();
    const panel = page.getByTestId("panel");
    await expect.poll(() => panel.locator(".panel-title").textContent()).toBe("Name the cache's key");
    const fields = panel.getByTestId("panel-fields");
    expect(await fields.innerText()).toContain("Not decided yet.");
    await fields.getByRole("button", { name: "Record the decision" }).click();
    // The editor: the options to choose from (the first chosen), the person, today.
    const editor = fields.locator(".decided-editor");
    await editor.waitFor();
    await editor.locator("select").first().selectOption("Use a version key");
    await editor.getByRole("button", { name: "Record the decision" }).click();
    await expect.poll(() => fields.locator(".decided").textContent()).toMatch(/^Use a version key · by Robin · on \d{4}-\d{2}-\d{2}$/);
    // The event says it: the decision beside the fields it changed, as the check reads it.
    expect(readEvents(dir).events.at(-1)!.event).toMatchObject({
      by: "robin",
      item: id,
      kind: "item.updated",
      data: { fields: ["fields"], decided: { option: "Use a version key", by: "robin", on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) } }
    });
    // The tile says what was decided, under the ask; who and when on hover.
    await page.keyboard.press("Escape");
    await expect.poll(() => page.getByTestId("panel").count()).toBe(0);
    await expect.poll(() => tile(id).getByTestId("tile-decided").textContent()).toBe("Decided: Use a version key");
    expect(await tile(id).getByTestId("tile-decided").getAttribute("title")).toMatch(/^Decided by Robin on \d{4}-\d{2}-\d{2}$/);
    expect(await tile(id).getAttribute("aria-describedby")).toBe(`ask-${id} decided-${id}`);
    expect(await tile(id).getByTestId("tile-ask").textContent()).toBe(ask);
    await shot("decided-light");
    if (SHOTS) {
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForTimeout(2600);
      await shot("decided-dark");
      await page.emulateMedia({ colorScheme: "light" });
    }
  });

  it("raised no error in the page along the way", () => {
    expect(problems).toEqual([]);
  });
}, 30_000);
