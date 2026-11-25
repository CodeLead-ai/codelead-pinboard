import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentsGuide, boardContext, createCards, getCard, initBoard, readBoardConfig, readEvents, type BoardConfig, type BoardContext } from "../core/index.js";
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
  { id: "claude", kind: "agent" as const, name: "Claude Code" }
];

/**
 * Ready on the page: the column with its line, a move there that the board refuses coming back
 * beside the card with the three things to fill in, the card's own view of them, the bar of picked
 * cards, and a board made before Ready, whose move menus say what to run.
 */
describe.skipIf(!browser)("the Ready column on the page", () => {
  let base: string;
  let ctx: BoardContext;
  let oldDir: string;
  let servers: BoardServer[] = [];
  let context: BrowserContext;
  let page: Page;
  let url: string;
  let oldUrl: string;
  const tile = (id: number) => page.locator(`.tile[data-card='${id}']`);
  const inColumn = (column: string, id: number) => page.locator(`[data-column='${column}'] .tile[data-card='${id}']`);

  beforeAll(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "pinboard-ready-page-"));
    const root = path.join(base, "repo");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    const dir = path.join(root, "board");
    ctx = boardContext({ dir, root, home: "/home/tester" });
    initBoard(ctx, { name: "Ready board", participants: PEOPLE });
    createCards(
      ctx,
      "robin",
      [
        { type: "task", title: "Rate-limit the sign-in form", column: "backlog" },
        { type: "task", title: "Tidy the logs", column: "backlog", fields: { definitionOfDone: "No log line repeats.", mayTouch: ["src/log.ts"], limitMinutes: 15 } },
        { type: "idea", title: "A weekly summary", column: "ideas" },
        { type: "note", title: "Notes from the review", column: "inbox" }
      ],
      { tagCreator: false }
    );

    // A board made before Ready: its board.json without the column, its guide as the package wrote it then.
    const oldRoot = path.join(base, "old");
    fs.mkdirSync(path.join(oldRoot, ".git"), { recursive: true });
    oldDir = path.join(oldRoot, "board");
    const oldCtx = boardContext({ dir: oldDir, root: oldRoot, home: "/home/tester" });
    initBoard(oldCtx, { name: "Old board", participants: PEOPLE });
    const config = readBoardConfig(oldDir).config;
    const before: BoardConfig = { ...config, columns: config.columns.filter((column) => column.id !== "ready") };
    fs.writeFileSync(path.join(oldDir, "board.json"), `${JSON.stringify(before, null, 2)}\n`);
    fs.writeFileSync(path.join(oldDir, "AGENTS.md"), agentsGuide(before));
    createCards(oldCtx, "robin", [{ type: "task", title: "An old card", column: "backlog" }], { tagCreator: false });

    const pageDir = path.join(base, "page");
    await buildPage(pageLocation(), pageDir);
    const server = createBoardServer({ dir, root, pageDir, log: () => undefined });
    const oldServer = createBoardServer({ dir: oldDir, root: oldRoot, pageDir, log: () => undefined, command: "codelead board" });
    servers = [server, oldServer];
    url = (await server.listen(0)).url;
    oldUrl = (await oldServer.listen(0)).url;
    context = await browser!.newContext({ viewport: { width: 1700, height: 1000 } });
    await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
    page = await context.newPage();
    await page.goto(url);
    await tile(1).waitFor();
  }, 120_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    for (const server of servers) await server.close();
    if (base) fs.rmSync(base, { recursive: true, force: true });
  }, 120_000);

  it("shows Ready among the columns, after Pinned, with its line under its name", async () => {
    expect(await page.locator(".column-title h2").allTextContents()).toEqual(["Inbox", "Backlog", "Ideas", "Pinned", "Ready", "In progress", "For review", "Done"]);
    expect(await page.locator("[data-column='ready'] .column-note").textContent()).toBe("an agent may pick these up");
    expect(await page.locator("[data-column='ready'] .column-empty").textContent()).toContain("Nothing is ready for an agent.");
  });

  it("a drag to Ready of a card that misses the three things: the card goes back, its panel opens with the words and the fields; Save and move to Ready moves it", async () => {
    const before = readEvents(ctx.dir).count;
    await page.dragAndDrop(".tile[data-card='1']", "[data-column='ready'] .column-body", { targetPosition: { x: 40, y: 20 } });
    const check = page.getByTestId("ready-check");
    await check.waitFor();
    expect(await page.getByTestId("panel").getAttribute("data-card")).toBe("1");
    expect(await page.getByTestId("ready-check-words").textContent()).toBe(
      "Card #1 cannot go to Ready yet: it does not say how to tell it is done (definitionOfDone), it does not name the repository, folder or files it may touch (mayTouch), and it names no limit in minutes or money (limitMinutes, limitMoney). Nothing was written: set what is missing, then move it again."
    );
    // Each missing thing is marked; the card is back where it was; nothing was written.
    expect(await check.locator(".ready-missing").count()).toBe(3);
    await inColumn("backlog", 1).waitFor();
    expect(getCard(ctx, 1).card.column).toBe("backlog");
    expect(readEvents(ctx.dir).count).toBe(before);
    // The tile says it too.
    expect(await tile(1).getByTestId("tile-not-ready").textContent()).toBe("Cannot go to Ready yet: open it to fill in what is missing.");

    // Only part filled in: the board says what is still missing, beside the card.
    await page.getByTestId("ready-done-when-input").fill("Five failed sign-ins in a minute lock the form for ten minutes; npm test passes.");
    await page.getByTestId("ready-save").click();
    await expect.poll(() => page.getByTestId("ready-check-words").textContent()).toBe(
      "Card #1 cannot go to Ready yet: it does not name the repository, folder or files it may touch (mayTouch), and it names no limit in minutes or money (limitMinutes, limitMoney). Nothing was written: set what is missing, then move it again."
    );
    expect(getCard(ctx, 1).card.fields.definitionOfDone).toBe("Five failed sign-ins in a minute lock the form for ten minutes; npm test passes.");
    expect(getCard(ctx, 1).card.column).toBe("backlog");

    await page.getByTestId("ready-may-touch-input").fill("src/auth/\ntest/auth.test.ts");
    await page.getByTestId("ready-minutes-input").fill("30");
    await page.getByTestId("ready-save").click();
    await inColumn("ready", 1).waitFor();
    await expect.poll(() => page.getByTestId("ready-check").count()).toBe(0);
    const card = getCard(ctx, 1).card;
    expect(card.column).toBe("ready");
    expect(card.fields).toEqual({ definitionOfDone: "Five failed sign-ins in a minute lock the form for ten minutes; npm test passes.", mayTouch: ["src/auth/", "test/auth.test.ts"], limitMinutes: 30 });
    expect(readEvents(ctx.dir).events.slice(before).map(({ event }) => [event.by, event.kind])).toEqual([
      ["robin", "item.updated"],
      ["robin", "item.updated"],
      ["robin", "item.moved"]
    ]);
    expect(await tile(1).getByTestId("tile-not-ready").count()).toBe(0);
    // The card's own view shows the three things now that they are set (a task's "done when" is with its own fields).
    const shown = page.getByTestId("panel-ready");
    await shown.waitFor();
    expect(await shown.locator("h3").textContent()).toBe("In Ready: what an agent needs to work it alone");
    expect(await shown.textContent()).toContain("src/auth/");
    expect(await shown.getByTestId("ready-show-limitMinutes").textContent()).toContain("30");
    expect(await page.getByTestId("panel-fields").textContent()).toContain("Five failed sign-ins");
    await page.keyboard.press("Escape");
  });

  it("the card's move menu runs the same check; a card that says the three things moves; Not now puts the check away", async () => {
    /** Opens a card alone on top (its tile clicked), and moves it with the panel's column menu. */
    const moveFromPanel = async (id: number, to: string): Promise<void> => {
      while ((await page.getByTestId("panel").count()) > 0) await page.getByTestId("panel-close").click();
      await tile(id).click();
      await expect.poll(() => page.getByTestId("panel").getAttribute("data-card")).toBe(String(id));
      await page.getByTestId("panel").getByTestId("panel-column").selectOption(to);
    };
    await moveFromPanel(2, "ready");
    await inColumn("ready", 2).waitFor();
    expect(getCard(ctx, 2).card.column).toBe("ready");
    expect(await page.getByTestId("ready-check").count()).toBe(0);

    await moveFromPanel(3, "ready");
    await page.getByTestId("ready-check").waitFor();
    expect(await page.getByTestId("panel").getAttribute("data-card")).toBe("3");
    expect(await page.getByTestId("ready-check-words").textContent()).toMatch(/^Card #3 cannot go to Ready yet: it does not say how to tell it is done/);
    // The menu shows where the card is: still in Ideas.
    await expect.poll(() => page.getByTestId("panel").getByTestId("panel-column").inputValue()).toBe("ideas");
    // An idea has no fields of its own: the panel shows all three to fill in, "done when" included.
    expect(await page.getByTestId("ready-done-when-input").count()).toBe(1);
    await page.getByTestId("ready-dismiss").click();
    await expect.poll(() => page.getByTestId("ready-check").count()).toBe(0);
    expect(await tile(3).getByTestId("tile-not-ready").count()).toBe(0);
    expect(getCard(ctx, 3).card.column).toBe("ideas");
    await page.getByTestId("panel-close").click();
  });

  it("the bar of picked cards: the ones that can be worked alone move, the others are refused and say so on their tiles", async () => {
    await page.keyboard.press("Escape");
    await tile(3).click({ modifiers: ["ControlOrMeta"] });
    await tile(4).click({ modifiers: ["ControlOrMeta"] });
    await expect.poll(() => page.getByTestId("bulk-count").textContent()).toBe("2 selected");
    await page.getByTestId("bulk-move").click();
    const dialog = page.getByTestId("bulk-dialog");
    expect(await dialog.textContent()).toContain("yours: an agent may pick these up; each card must say how to tell it is done, what it may touch and its limit");
    await dialog.getByText("Ready", { exact: true }).click();
    await page.getByTestId("bulk-confirm").click();
    // In the board's order: Inbox's #4 first, then Ideas' #3.
    await expect.poll(() => page.getByTestId("message").textContent()).toContain("0 moved to Ready, 2 refused: #4 cannot go to Ready yet: it does not say how to tell it is done (definitionOfDone),");
    expect(await page.getByTestId("message").textContent()).toContain("; #3 cannot go to Ready yet: it does not say how to tell it is done (definitionOfDone),");
    await tile(3).getByTestId("tile-not-ready").waitFor();
    expect(await tile(4).getByTestId("tile-not-ready").count()).toBe(1);
    await page.getByTestId("bulk-clear").click();
    // One click away: the tile opens the card with the check.
    await tile(4).click();
    await page.getByTestId("ready-check").waitFor();
    expect(await page.getByTestId("ready-check-words").textContent()).toMatch(/^Card #4 cannot go to Ready yet:/);
    await page.getByTestId("ready-done-when-input").fill("The notes are in docs/review.md.");
    await page.getByTestId("ready-may-touch-input").fill("docs/");
    await page.getByTestId("ready-money-input").fill("0");
    await page.getByTestId("ready-save").click();
    await inColumn("ready", 4).waitFor();
    expect(getCard(ctx, 4).card.fields).toEqual({ definitionOfDone: "The notes are in docs/review.md.", mayTouch: ["docs/"], limitMoney: 0 });
    await page.keyboard.press("Escape");
  });

  it("a board made before Ready opens as before, and its move menus say what to run", async () => {
    const old = await context.newPage();
    await old.goto(oldUrl);
    await old.locator(".tile[data-card='1']").waitFor();
    expect(await old.locator(".column-title h2").allTextContents()).toEqual(["Inbox", "Backlog", "Ideas", "Pinned", "In progress", "For review", "Done"]);
    // The keyboard's move picker (m): the page's keys follow the selected card once its selection has rendered.
    const picker = old.getByTestId("move-picker");
    await expect
      .poll(async () => {
        await old.locator(".tile[data-card='1']").focus();
        await expect.poll(() => old.locator(".tile[data-card='1']").getAttribute("class")).toContain("tile-selected");
        await old.keyboard.press("m");
        return picker.waitFor({ timeout: 1000 }).then(
          () => true,
          () => false
        );
      })
      .toBe(true);
    expect(await old.getByTestId("no-ready-note").textContent()).toBe("No Ready column on this board yet, where you put a card an agent may pick up by itself. codelead board add-ready adds it.");
    await old.keyboard.press("Escape");
    await old.locator(".tile[data-card='1']").click({ modifiers: ["ControlOrMeta"] });
    await old.getByTestId("bulk-move").click();
    expect(await old.getByTestId("bulk-dialog").getByTestId("no-ready-note").count()).toBe(1);
    await old.close();
    // Nothing was written to the old board by looking.
    expect(readBoardConfig(oldDir).config.columns.map((column) => column.id)).not.toContain("ready");
  });
}, 60_000);
