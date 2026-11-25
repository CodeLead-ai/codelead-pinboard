import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addSchedule, boardContext, initBoard, readSchedules } from "../core/index.js";
import { buildPage, createBoardServer, type BoardServer, pageLocation } from "../server/index.js";

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

const FIELDS = { definitionOfDone: "npm test passes", mayTouch: ["package.json"], limitMinutes: 30 };

/**
 * The schedules on the page: a card a schedule made says so on its tile and in its panel; the header's
 * Schedules view lists each schedule (its rule, its next time in its zone and in UTC, its last card),
 * pauses, resumes and removes one, and adds one through a form that shows the board's check of its
 * card (the Ready check's words) before it is saved. The page's process runs on the test's clock
 * (Monday 2026-11-23, 09:30 in Berlin) and its timer is the test's own: nothing waits for a time.
 */
describe.skipIf(!browser)("the schedules on the page", () => {
  let base: string;
  let dir: string;
  let server: BoardServer;
  let context: BrowserContext;
  let page: Page;
  const tile = (id: number) => page.locator(`.tile[data-card='${id}']`);
  const view = () => page.getByTestId("schedules");
  const row = (name: string) => view().locator(`[data-schedule='${name}']`);
  const schedule = (name: string) => readSchedules(dir).find((entry) => entry.name === name)?.schedule;

  beforeAll(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "pinboard-schedules-page-"));
    const root = path.join(base, "repo");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    dir = path.join(root, "board");
    const made = boardContext({ dir, root, home: "/home/tester", now: () => new Date("2026-11-20T09:00:00Z"), zone: "Europe/Berlin" });
    initBoard(made, { name: "Scheduled board", participants: PEOPLE });
    addSchedule(made, "robin", { name: "check-deps", rule: { kind: "weekly", days: ["mon"], at: "09:00" }, card: { type: "task", title: "Check the dependencies", fields: FIELDS } });
    addSchedule(made, "robin", { name: "weekly-report", rule: { kind: "weekly", days: ["wed"], at: "17:00" }, card: { type: "note", title: "Write the weekly report", tags: ["for:claude"], fields: FIELDS } });
    const pageDir = path.join(base, "page");
    await buildPage(pageLocation(), pageDir);
    // The page's process starts on Monday at 09:30 in Berlin: check-deps was due at 09:00, and its start makes the card.
    server = createBoardServer({
      dir,
      root,
      pageDir,
      now: () => new Date("2026-11-23T08:30:00Z"),
      zone: "Europe/Berlin",
      log: () => undefined,
      timers: { setInterval: () => "the test's", clearInterval: () => undefined }
    });
    const { url } = await server.listen(0);
    context = await browser!.newContext({ viewport: { width: 1600, height: 1000 } });
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

  it("says on a card a schedule made, on its tile and in its panel, that it is by the schedule, and whose", async () => {
    expect(await page.locator("[data-column='ready'] .tile[data-card='1']").count()).toBe(1);
    expect(await tile(1).getByTestId("tile-scheduled").textContent()).toBe("by the schedule check-deps");
    await tile(1).click();
    const panel = page.getByTestId("panel");
    await panel.getByTestId("panel-schedule").waitFor();
    expect(await panel.getByTestId("panel-schedule").textContent()).toMatch(/^Madeby the schedule check-deps, Robin's ask · due .*08:00Z$/);
    expect(await panel.getByTestId("thread-event").first().textContent()).toMatch(/^Robin had the schedule check-deps put it in Ready \(due 2026-11-23T08:00:00Z\)/);
    await page.keyboard.press("Escape");
    await expect.poll(() => page.getByTestId("panel").count()).toBe(0);
  });

  it("lists each schedule from the header: its rule, its next time in its zone and in UTC, and its last card", async () => {
    await page.getByTestId("schedules-button").click();
    await view().waitFor();
    await row("check-deps").waitFor();
    expect(await row("check-deps").getByTestId("schedule-rule").textContent()).toBe("every Monday at 09:00");
    expect(await row("check-deps").getByTestId("schedule-next").textContent()).toBe("Next: Mon 2026-11-30 09:00 · 2026-11-30 08:00 UTC");
    expect(await row("check-deps").getByTestId("schedule-last").textContent()).toBe("Last card: #1 Check the dependencies (in Ready)");
    expect(await row("weekly-report").getByTestId("schedule-next").textContent()).toBe("Next: Wed 2026-11-25 17:00 · 2026-11-25 16:00 UTC");
    expect(await row("weekly-report").textContent()).toContain("for Claude Code");
    expect(await row("weekly-report").getByTestId("schedule-last").textContent()).toBe("No card yet.");
    expect(await view().textContent()).toContain("this machine: Europe/Berlin");
  });

  it("pauses and resumes a schedule, as its file then says", async () => {
    await row("weekly-report").getByTestId("schedule-pause").click();
    await expect.poll(() => row("weekly-report").getByTestId("schedule-next").textContent()).toBe("Paused by Robin: it makes no card until it is resumed.");
    expect(schedule("weekly-report")?.paused).toEqual({ by: "robin", at: "2026-11-23T08:30:00Z" });
    expect(await view().getByTestId("schedules-said").textContent()).toBe("Paused weekly-report: it makes no card until you resume it; the times it misses meanwhile are not made up.");
    await row("weekly-report").getByTestId("schedule-resume").click();
    await expect.poll(() => row("weekly-report").getByTestId("schedule-next").textContent()).toBe("Next: Wed 2026-11-25 17:00 · 2026-11-25 16:00 UTC");
    expect(schedule("weekly-report")?.paused).toBeUndefined();
  });

  it("adds one through the form, showing the board's check of its card (the Ready check's words) before it is saved", async () => {
    await view().getByTestId("schedule-add").click();
    const form = view().getByTestId("schedule-form");
    await form.waitFor();
    expect(await form.getByTestId("schedule-check").textContent()).toBe("Give it a name and a title: the board's check of its card shows here before you save.");
    await form.getByTestId("schedule-kind-daily").check();
    await form.getByTestId("schedule-name-input").fill("logs");
    await form.getByTestId("schedule-at-input").fill("06:00");
    await form.getByTestId("schedule-title-input").fill("Rotate the logs");
    await form.getByTestId("schedule-doneWhen-input").fill("Older logs are gone");
    await expect
      .poll(() => form.getByTestId("schedule-check").textContent())
      .toBe(
        "The schedule's card cannot go to Ready yet: it does not name the repository, folder or files it may touch (mayTouch), and it names no limit in minutes or money (limitMinutes, limitMoney). Nothing was written: set what is missing, then make the schedule again."
      );
    expect(await form.getByTestId("schedule-save").isDisabled()).toBe(true);
    expect(await form.getByTestId("schedule-mayTouch").getAttribute("class")).toContain("ready-missing");
    expect(fs.existsSync(path.join(dir, "schedules", "logs.json"))).toBe(false);
    await form.getByTestId("schedule-mayTouch-input").fill("logs/");
    await form.getByTestId("schedule-limitMinutes-input").fill("10");
    await expect.poll(() => form.getByTestId("schedule-check").textContent()).toBe("The board accepts it. Its first card is due Tue 2026-11-24 06:00 Europe/Berlin (2026-11-24 05:00 UTC), in Ready.");
    await form.getByTestId("schedule-save").click();
    await row("logs").waitFor();
    expect(await view().getByTestId("schedules-said").textContent()).toBe("Made the schedule logs. Its first card is due Tue 2026-11-24 06:00 Europe/Berlin (2026-11-24 05:00 UTC), in Ready.");
    expect(schedule("logs")).toMatchObject({ rule: { kind: "daily", at: "06:00" }, zone: "Europe/Berlin", made: { by: "robin" }, card: { type: "task", title: "Rotate the logs", fields: { definitionOfDone: "Older logs are gone", mayTouch: ["logs/"], limitMinutes: 10 } } });
    expect(await row("logs").getByTestId("schedule-rule").textContent()).toBe("every day at 06:00");
  });

  it("removes one after asking, and leaves the cards it made; Esc closes the view", async () => {
    await row("check-deps").getByTestId("schedule-remove").click();
    expect(await row("check-deps").textContent()).toContain("Remove check-deps? The cards it made stay.");
    await row("check-deps").getByTestId("schedule-remove-yes").click();
    await expect.poll(() => row("check-deps").count()).toBe(0);
    expect(fs.existsSync(path.join(dir, "schedules", "check-deps.json"))).toBe(false);
    expect(await tile(1).count()).toBe(1);
    await page.locator(".topbar .brand-name").click();
    await expect.poll(() => view().count()).toBe(0);
    await page.getByTestId("schedules-button").click();
    await view().waitFor();
    await page.keyboard.press("Escape");
    await expect.poll(() => view().count()).toBe(0);
  });
});
