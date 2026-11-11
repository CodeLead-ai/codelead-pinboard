import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boardContext, createCards, initBoard, readBoard, readEvents, updateCard, type BoardContext } from "../core/index.js";
import { buildPage, createBoardServer, pageLocation, type BoardServer } from "../server/index.js";

const browser: Browser | undefined = await (async () => {
  try {
    const { chromium } = await import("playwright");
    return await chromium.launch();
  } catch {
    return undefined;
  }
})();

describe.skipIf(!browser)("the For CodeLead tag on the page", () => {
  let base: string;
  let ctx: BoardContext;
  let server: BoardServer;
  let context: BrowserContext;
  let page: Page;
  let url: string;
  const tile = (id: number) => page.locator(`.tile[data-card='${id}']`);

  beforeAll(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "pinboard-codelead-"));
    const root = path.join(base, "repo");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    const dir = path.join(root, "board");
    ctx = boardContext({ dir, root, home: "/home/tester" });
    initBoard(ctx, { name: "Demo board", participants: [
      { id: "person", kind: "person", name: "Person" },
      { id: "codex", kind: "agent", name: "Codex" }
    ] });
    const columns = ["inbox", "backlog", "ideas", "pinned", "in-progress", "for-review", "done"];
    createCards(ctx, "person", columns.map((column) => ({ type: "task", title: `Work in ${column}`, column, tags: ["for:codelead", "area:cache"] })), { tagCreator: false });
    createCards(ctx, "person", [{ type: "task", title: "Review the cache plan", column: "backlog", tags: ["area:cache"] }], { tagCreator: false });
    const pageDir = path.join(base, "page");
    await buildPage(pageLocation(), pageDir);
    server = createBoardServer({ dir, root, pageDir, log: () => undefined });
    url = (await server.listen(0)).url;
    context = await browser!.newContext({ viewport: { width: 1600, height: 900 } });
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

  it("shows the blue CodeLead badge in every column, including working and done", async () => {
    expect(await page.locator(".tile .chip-codelead").count()).toBe(7);
    for (let id = 1; id <= 7; id++) expect(await tile(id).locator(".chip-codelead").textContent()).toBe("CodeLead");
    expect(await tile(8).locator(".chip-codelead").count()).toBe(0);
  });

  it("filters tagged cards across columns, persists in the URL, and toggles off", async () => {
    const chip = page.getByRole("button", { name: "For CodeLead", exact: true });
    expect(await chip.count()).toBe(1);
    await chip.click();
    expect(await chip.getAttribute("aria-pressed")).toBe("true");
    expect(new URL(page.url()).searchParams.getAll("tag")).toEqual(["for:codelead"]);
    expect(await tile(8).getAttribute("class")).toContain("tile-faded");
    await page.getByTestId("show-hide").click();
    expect(await page.locator(".tile").count()).toBe(7);
    await page.reload();
    await tile(1).waitFor();
    expect(await chip.getAttribute("aria-pressed")).toBe("true");
    await chip.click();
    expect(await page.locator(".tile").count()).toBe(8);
    expect(new URL(page.url()).searchParams.getAll("tag")).toEqual([]);
  });

  it("sends and takes back in one click as the person, preserving column and other tags", async () => {
    await tile(8).click();
    const panel = page.getByTestId("panel");
    await panel.getByTestId("panel-title").waitFor();
    const send = panel.getByRole("button", { name: "Send to CodeLead", exact: true });
    expect(await send.count()).toBe(1);
    await send.click();
    const takeBack = panel.getByRole("button", { name: "Take back from CodeLead", exact: true });
    await takeBack.waitFor();
    expect(readBoard(ctx).cards.find((card) => card.id === 8)?.tags).toEqual(["area:cache", "for:codelead"]);
    expect(await tile(8).locator(".chip-codelead").count()).toBe(1);
    await takeBack.click();
    await send.waitFor();
    const card = readBoard(ctx).cards.find((entry) => entry.id === 8)!;
    expect(card.tags).toEqual(["area:cache"]);
    expect(card.column).toBe("backlog");
    const events = readEvents(ctx.dir).events.map((entry) => entry.event).filter((event) => event.item === 8 && event.kind.startsWith("tag."));
    expect(events.map((event) => [event.by, event.kind])).toEqual([["person", "tag.added"], ["person", "tag.removed"]]);
    await page.keyboard.press("Escape");
  });

  it("shows a refused toggle and keeps the card's latest tags", async () => {
    await tile(8).click();
    const panel = page.getByTestId("panel");
    await panel.getByTestId("panel-title").waitFor();
    const send = panel.getByRole("button", { name: "Send to CodeLead", exact: true });
    expect(await send.count()).toBe(1);
    await page.route("**/api/items/8", async (route) => {
      if (route.request().method() === "PUT") {
        updateCard(ctx, 8, { as: "person", changes: { addTags: ["area:review"] } });
      }
      await route.continue();
    });
    await send.click();
    await expect.poll(() => panel.locator(".refusal").count()).toBeGreaterThan(0);
    expect(readBoard(ctx).cards.find((entry) => entry.id === 8)?.tags).toEqual(["area:cache", "area:review"]);
    await page.unroute("**/api/items/8");
  });
});
