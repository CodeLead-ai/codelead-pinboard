import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addComment, boardContext, createCards, initBoard, moveCard, readEvents, type BoardContext, type NewCardInput } from "../core/index.js";
import { buildPage, createBoardServer, pageLocation, type BoardServer } from "../server/index.js";

/**
 * Package 2b's flows in a real browser, against the page as built and served, on a board of the
 * test's own: the type colours, a card's colour on its tile and in its panel, a click outside that
 * closes the panel, a decision's ask (and its absence), Done collapsed under 1,500 px, a comment and
 * a move in one notification line, the markdown preview, and a card dropped at a place.
 */
const browser: Browser | undefined = await (async () => {
  try {
    const { chromium } = await import("playwright");
    return await chromium.launch();
  } catch {
    return undefined;
  }
})();

const ASK = "Pick the cache: a TTL or a version key. I recommend the TTL.";
const LONG_ASK = `Three ways to cache the board's reads: ${"a TTL, a version key, or none at all, ".repeat(6)}and I recommend the TTL.`;

describe.skipIf(!browser)("the board's page in a browser: package 2b", () => {
  let base = "";
  let dir = "";
  let ctx: BoardContext;
  let server: BoardServer;
  let url = "";
  let context: BrowserContext;
  let page: Page;
  const problems: string[] = [];

  const fileText = (id: number): string => {
    const name = fs.readdirSync(path.join(dir, "items")).find((entry) => entry.startsWith(`${String(id).padStart(4, "0")}-`));
    if (!name) throw new Error(`no file for card ${id}`);
    return fs.readFileSync(path.join(dir, "items", name), "utf8");
  };
  const tile = (id: number, on: Page = page) => on.locator(`.tile[data-card='${id}']`);
  const panel = () => page.getByTestId("panel");
  /** A computed style, read with an expression (this file is checked without the DOM's types). */
  const style = (selector: string, property: string, on: Page = page): Promise<string> =>
    on.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).${property}`) as Promise<string>;
  const column = (id: string, on: Page = page): Promise<string[]> => on.locator(`[data-column='${id}'] .tile .tile-id`).allTextContents();
  const watchPage = (target: Page): void => {
    target.on("pageerror", (error) => problems.push(error.message));
    target.on("console", (message) => {
      if (message.type() === "error" && !/fonts\.googleapis|ERR_FAILED/.test(message.text())) problems.push(message.text());
    });
  };

  beforeAll(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), "pinboard-2b-page-"));
    const root = path.join(base, "repo");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    dir = path.join(root, "docs", "codelead", "board");
    ctx = boardContext({ dir, root, home: "/home/tester" });
    initBoard(ctx, { name: "test-2b", participants: [
      { id: "robin", kind: "person", name: "Robin" },
      { id: "claude", kind: "agent", name: "Claude Code" }
    ] });
    const byPerson = (inputs: NewCardInput[]): void => {
      createCards(ctx, "robin", inputs, { tagCreator: false });
    };
    byPerson([
      { type: "decision", title: "Pick the cache strategy", column: "pinned", fields: { ask: ASK, options: ["a TTL", "a version key"] } },
      { type: "decision", title: "Name the app", column: "pinned" },
      { type: "decision", title: "An old question", column: "done" },
      { type: "decision", title: "Decided already", column: "pinned", fields: { decided: { option: "A", by: "robin", on: "2026-10-05" } } },
      { type: "task", title: "Write the cache layer", column: "backlog" },
      { type: "task", title: "Measure the reads", column: "backlog" },
      { type: "task", title: "Try a version key", column: "backlog" }
    ]);
    createCards(ctx, "claude", [{ type: "idea", title: "Cache the board's reads" }]);
    byPerson([
      { type: "question", title: "Which TTL?", column: "for-review" },
      { type: "review", title: "Review the cache plan", column: "for-review" },
      { type: "note", title: "Notes on the reads", column: "ideas" },
      { type: "idea", title: "Idea A", column: "ideas" },
      { type: "idea", title: "Idea B", column: "ideas" },
      { type: "idea", title: "Idea C", column: "ideas" },
      { type: "task", title: "Drag me", column: "inbox" },
      { type: "decision", title: "A long ask", column: "pinned", fields: { ask: LONG_ASK.slice(0, 590) } }
    ]);

    const outDir = path.join(base, "page");
    await buildPage(pageLocation(), outDir);
    server = createBoardServer({ dir, root, home: "/home/tester", pageDir: outDir, debounceMs: 30, settleMs: 300, log: () => undefined });
    url = (await server.listen(0)).url;
    context = await browser!.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: "light" });
    await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
    page = await context.newPage();
    watchPage(page);
    await page.goto(url);
    await tile(1).waitFor();
  }, 120_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await server?.close();
    if (base) await rm(base, { recursive: true, force: true });
  }, 120_000);

  it("draws each type's glyph in its own colour of the palette, on its chip, in both themes", async () => {
    const tones = await Promise.all([1, 5, 8, 9, 10, 11].map((id) => tile(id).locator(".type-chip").getAttribute("data-tone")));
    expect(tones).toEqual(["brown", "slate", "sand", "taupe", "khaki", "plain"]);
    // Light: the colour fills the chip, the glyph is in the ink.
    expect(await style(".tile[data-card='1'] .type-chip", "backgroundColor")).toBe("rgb(147, 103, 68)");
    expect(await style(".tile[data-card='1'] .type-chip", "color")).toBe("rgb(11, 22, 48)");
    expect(await style(".tile[data-card='8'] .type-chip", "backgroundColor")).toBe("rgb(200, 189, 172)");
    // Dark: the glyph is in the colour, on a chip tinted with it.
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => style(".tile[data-card='1'] .type-chip", "color")).toBe("rgb(147, 103, 68)");
    expect(await style(".tile[data-card='5'] .type-chip", "color")).toBe("rgb(119, 126, 144)");
    await page.emulateMedia({ colorScheme: "light" });
    // The panel's type select wears the same chip.
    await tile(1).click();
    await panel().locator(".panel-title").waitFor();
    expect(await panel().locator(".type-select .type-chip").getAttribute("data-tone")).toBe("brown");
    await page.keyboard.press("Escape");
    await expect.poll(() => panel().count()).toBe(0);
  });

  it("shows a decision's ask on its tile in full, cut with … only past about 240 characters, and the gap where it is missing", async () => {
    expect(await tile(1).getByTestId("tile-ask").textContent()).toBe(ASK);
    expect(await tile(2).getByTestId("tile-ask").textContent()).toBe("Ask not written yet");
    expect(await tile(2).locator(".tile-ask-missing").count()).toBe(1);
    // In Done, or decided: no decision waits, and no gap is shown.
    expect(await tile(3).getByTestId("tile-ask").count()).toBe(0);
    expect(await tile(4).getByTestId("tile-ask").count()).toBe(0);
    const long = (await tile(16).getByTestId("tile-ask").textContent()) ?? "";
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(241);
    expect(long.length).toBeGreaterThan(200);
    // A task carries no ask.
    expect(await tile(5).getByTestId("tile-ask").count()).toBe(0);
  });

  it("puts the ask at the top of a decision's panel, above the description, and edits it in place", async () => {
    await tile(16).click();
    await expect.poll(() => panel().locator(".panel-title").textContent()).toBe("A long ask");
    expect(await panel().getByTestId("panel-ask").innerText()).toContain(LONG_ASK.slice(0, 590).trim());
    await page.keyboard.press("Escape");
    await tile(2).click();
    await expect.poll(() => panel().locator(".panel-title").textContent()).toBe("Name the app");
    const block = panel().getByTestId("panel-ask");
    expect(await block.innerText()).toMatch(/^Asked of you\s+Ask not written yet/i);
    expect((await block.boundingBox())!.y).toBeLessThan((await panel().getByTestId("panel-description").boundingBox())!.y);
    // The decision's fields below do not repeat it.
    expect(await panel().getByTestId("panel-fields").innerText()).not.toMatch(/\bAsk\b/);
    await block.getByRole("button", { name: "Edit the ask" }).click();
    await block.getByLabel("the ask").fill("Name it: Desk or Bench? I recommend Desk.");
    await block.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => tile(2).getByTestId("tile-ask").textContent()).toBe("Name it: Desk or Bench? I recommend Desk.");
    expect(fileText(2)).toContain('fields:\n  ask: "Name it: Desk or Bench? I recommend Desk."\n');
    expect(await block.innerText()).toContain("Name it: Desk or Bench? I recommend Desk.");
  });

  it("sets a card's colour from the panel: a small circle on the tile and the swatch ringed below the tags; none takes it off", async () => {
    await tile(5).click();
    await expect.poll(() => panel().locator(".panel-title").textContent()).toBe("Write the cache layer");
    const red = panel().getByTestId("panel-colors").getByRole("button", { name: "red", exact: true });
    await red.click();
    await expect.poll(() => tile(5).getByTestId("tile-color").count()).toBe(1);
    expect(await tile(5).getByTestId("tile-color").getAttribute("data-color")).toBe("#b33f40");
    expect(await style(".tile[data-card='5'] [data-testid='tile-color']", "backgroundColor")).toBe("rgb(179, 63, 64)");
    expect(await red.getAttribute("aria-pressed")).toBe("true");
    expect(await panel().locator(".color-name").textContent()).toBe("red");
    expect(fileText(5)).toContain('color: "#b33f40"');
    // The circle sits in the tile's bottom right corner.
    const box = (await tile(5).boundingBox())!;
    const dot = (await tile(5).getByTestId("tile-color").boundingBox())!;
    expect(box.x + box.width - (dot.x + dot.width)).toBeLessThan(14);
    expect(box.y + box.height - (dot.y + dot.height)).toBeLessThan(14);
    await panel().getByTestId("panel-colors").getByRole("button", { name: "no colour" }).click();
    await expect.poll(() => tile(5).getByTestId("tile-color").count()).toBe(0);
    expect(fileText(5)).not.toContain("color:");
  });

  it("closes the open panel on a click on the board outside it, without moving a card; a press that becomes a drag does not count", async () => {
    await expect.poll(() => panel().count()).toBe(1);
    const events = readEvents(dir).count;
    await page.locator("[data-column='backlog'] .column-body").click({ position: { x: 30, y: 640 } });
    await expect.poll(() => panel().count()).toBe(0);
    expect(readEvents(dir).count).toBe(events);
    // A click on another card while one is open opens that card instead.
    await tile(6).click();
    await expect.poll(() => panel().locator(".panel-title").textContent()).toBe("Measure the reads");
    await tile(7).click();
    await expect.poll(() => panel().locator(".panel-title").textContent()).toBe("Try a version key");
    // Dragging a card while a panel is open moves the card and leaves the panel open.
    await page.dragAndDrop(".tile[data-card='15']", "[data-column='backlog'] .column-body", { targetPosition: { x: 40, y: 4 } });
    await page.locator("[data-column='backlog'] .tile[data-card='15']").waitFor();
    expect(await panel().count()).toBe(1);
    expect(await panel().locator(".panel-title").textContent()).toBe("Try a version key");
    await page.keyboard.press("Escape");
    await expect.poll(() => panel().count()).toBe(0);
  });

  it("drops a card where it is dropped, keeps it there across a reload and an agent's comment, and moves it inside its column", async () => {
    expect(await column("ideas")).toEqual(["#14", "#13", "#12", "#11"]);
    // Into Ideas, between B (#13) and A (#12).
    await page.dragAndDrop(".tile[data-card='15']", ".tile[data-card='12']", { targetPosition: { x: 40, y: 4 } });
    await expect.poll(() => column("ideas")).toEqual(["#14", "#13", "#15", "#12", "#11"]);
    expect(readEvents(dir).events.at(-1)!.event).toMatchObject({ by: "robin", item: 15, kind: "item.moved", data: { from: "backlog", to: "ideas", after: 13 } });
    await page.reload();
    await tile(15).waitFor();
    expect(await column("ideas")).toEqual(["#14", "#13", "#15", "#12", "#11"]);
    // An agent writes on a card: it does not move.
    addComment(ctx, 11, { as: "claude", body: "These notes are still right." });
    await expect.poll(() => tile(11).locator(".mark-count").textContent()).toBe("1");
    expect(await column("ideas")).toEqual(["#14", "#13", "#15", "#12", "#11"]);
    // Inside its own column: to the top.
    await page.dragAndDrop(".tile[data-card='11']", ".tile[data-card='14']", { targetPosition: { x: 40, y: 3 } });
    await expect.poll(() => column("ideas")).toEqual(["#11", "#14", "#13", "#15", "#12"]);
    expect(readEvents(dir).events.at(-1)!.event).toMatchObject({ item: 11, kind: "item.moved", data: { from: "ideas", to: "ideas" } });
  });

  it("says an agent's comment and move of one step in one notification line", async () => {
    // A card the person has not opened (an event in the second the person opened a card counts as seen).
    moveCard(ctx, 9, { as: "claude", to: "in-progress", comment: "Started, as you asked in the session." });
    await page.locator("[data-column='in-progress'] .tile[data-card='9']").waitFor();
    await page.getByTestId("capsule").click();
    const list = page.getByTestId("notifications");
    await list.waitFor();
    const lines = list.locator(".note-line", { hasText: "Started, as you asked in the session." });
    await expect.poll(() => lines.count(), { timeout: 4000 }).toBe(1);
    expect(await lines.innerText()).toContain("Claude Code commented and moved it to In progress: Started, as you asked in the session.");
    expect(await list.locator(".note-line", { hasText: "moved it from For review" }).count()).toBe(0);
    await page.keyboard.press("Escape");
  });

  it("previews the description's markdown while it is edited: alone, or side by side, with the same renderer", async () => {
    await tile(7).click();
    await expect.poll(() => panel().locator(".panel-title").textContent()).toBe("Try a version key");
    await panel().getByRole("button", { name: "Edit the description" }).click();
    const editor = panel().getByLabel("the description");
    await editor.fill("A **bold** step, then #1 and `code`.");
    await panel().getByTestId("preview-preview").click();
    const pane = panel().getByTestId("preview-pane");
    expect(await pane.locator("strong").textContent()).toBe("bold");
    expect(await pane.locator("a.ref-card[data-card='1']").count()).toBe(1);
    expect(await editor.isVisible()).toBe(false);
    await panel().getByTestId("preview-split").click();
    expect(await editor.isVisible()).toBe(true);
    expect(await pane.isVisible()).toBe(true);
    await panel().getByTestId("preview-write").click();
    expect(await pane.count()).toBe(0);
    expect(await editor.inputValue()).toBe("A **bold** step, then #1 and `code`.");
    await panel().getByRole("button", { name: "Save" }).click();
    await expect.poll(() => panel().getByTestId("panel-description").locator("strong").textContent()).toBe("bold");
    expect(fileText(7)).toContain("A **bold** step, then #1 and `code`.");
    await page.keyboard.press("Escape");
  });

  it("closes the whole stack on a click outside, when a related card is open on top (Esc steps back one)", async () => {
    await tile(7).click();
    await expect.poll(() => panel().locator(".panel-title").textContent()).toBe("Try a version key");
    await panel().getByTestId("panel-description").locator("a.ref-card[data-card='1']").click();
    await expect.poll(() => panel().locator(".panel-title").textContent()).toBe("Pick the cache strategy");
    expect(await page.getByTestId("panel-below").count()).toBe(1);
    await page.locator("[data-column='inbox'] .column-body").click({ position: { x: 30, y: 500 } });
    await expect.poll(() => page.getByTestId("panel").count()).toBe(0);
    expect(await page.getByTestId("panel-below").count()).toBe(0);
  });

  it("collapses Done by default under 1,500 px, expands it on a click, and remembers the choice for this board", async () => {
    expect(await page.locator("[data-column='done']").getAttribute("class")).not.toContain("column-collapsed");
    const narrow = await browser!.newContext({ viewport: { width: 1366, height: 820 }, colorScheme: "light" });
    await narrow.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
    try {
      const laptop = await narrow.newPage();
      watchPage(laptop);
      await laptop.goto(url);
      await tile(1, laptop).waitFor();
      expect(await laptop.locator("[data-column='done']").getAttribute("class")).toContain("column-collapsed");
      expect(await laptop.getByTestId("count-done").textContent()).toBe("1");
      // Every column is in reach: the board scrolls when it must, and Done's strip ends inside the board's margin.
      const reach = await laptop.evaluate(
        "(() => { const board = document.querySelector('.board'); board.scrollLeft = board.scrollWidth; const done = document.querySelector(\"[data-column='done']\").getBoundingClientRect(); return board.getBoundingClientRect().right - done.right; })()"
      );
      expect(Number(reach)).toBeGreaterThan(0);
      await laptop.getByTestId("expand-done").click();
      await expect.poll(() => laptop.locator("[data-column='done']").getAttribute("class")).not.toContain("column-collapsed");
      expect(await tile(3, laptop).count()).toBe(1);
      await laptop.reload();
      await tile(1, laptop).waitFor();
      expect(await laptop.locator("[data-column='done']").getAttribute("class")).not.toContain("column-collapsed");
      expect(await laptop.evaluate("Object.keys(localStorage).filter((key) => key.startsWith('pinboard.columns.'))")).toEqual(["pinboard.columns.test-2b"]);
      await laptop.locator("[data-column='done']").getByRole("button", { name: "Collapse Done" }).click();
      await laptop.reload();
      await tile(1, laptop).waitFor();
      expect(await laptop.locator("[data-column='done']").getAttribute("class")).toContain("column-collapsed");
    } finally {
      await narrow.close();
    }
  });

  it("raised no error in the page along the way", () => {
    expect(problems).toEqual([]);
  });
}, 60_000);
