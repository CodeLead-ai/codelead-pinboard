import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addSchedule, archiveCard, getCard, readBoard, readEvents, removeSchedule, THEMES, updateCard, type BoardContext } from "../core/index.js";
import { buildPage, createBoardServer, pageLocation, type BoardServer } from "../server/index.js";
import { makeDemoBoard } from "./demoBoard.js";

/**
 * The ten themes, the projects, the board's background and the bulk bar, in a real browser on the
 * demo board (demoBoard.ts): every theme draws the board and an open card with its own tokens only and
 * the same font sizes; the eight colour themes each have an accent hue and a ground of their own; every
 * theme keeps text at 4.5:1 and the edges of inputs and buttons at 3:1, the two high-contrast ones text
 * at 7:1; on a picked background each column stays one surface, its title readable, its edge apart
 * from the colour; cards are picked and moved together, with an Undo; the project selector narrows the
 * board and carries its own theme.
 *
 * With PINBOARD_THEME_SCREENSHOTS=<folder>, it also saves the screenshots of docs/screenshots/themes,
 * the contact sheet of the eight colour themes (all-themes.png) among them.
 */
const browser: Browser | undefined = await (async () => {
  try {
    const { chromium } = await import("playwright");
    return await chromium.launch();
  } catch {
    return undefined;
  }
})();

const SHOTS = process.env.PINBOARD_THEME_SCREENSHOTS;

/** A colour in OKLCH: its lightness (0 to 1), chroma and hue (degrees), and its OKLab a and b. */
interface Lch {
  l: number;
  c: number;
  h: number;
  a: number;
  b: number;
}

/** OKLCH of a `#rrggbb` colour (Björn Ottosson's OKLab). */
function lch(hex: string): Lch {
  const linear = [1, 3, 5].map((at) => {
    const value = parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const [r, g, b] = linear;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: lightness, c: Math.hypot(a, bb), h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360, a, b: bb };
}

const hueDistance = (first: number, second: number): number => Math.min(Math.abs(first - second), 360 - Math.abs(first - second));
const distance = (first: Lch, second: Lch): number => Math.hypot(first.l - second.l, first.a - second.a, first.b - second.b);

/**
 * The page's checks, defined in the page (this file is checked without the DOM's types): the colours
 * the theme's tokens give, the elements using any other colour, and the contrast of text and edges.
 */
const CHECKS = String.raw`
window.__checks = (() => {
  const parse = (text) => {
    let m = /^rgba?\(([^)]+)\)$/.exec(text);
    if (m) { const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
    m = /^color\(srgb ([^)]+)\)$/.exec(text);
    if (m) { const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 }; }
    return undefined;
  };
  const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
  const channel = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const describe = (el) => el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : "") + (el.dataset && el.dataset.card ? "[" + el.dataset.card + "]" : "");
  const skipped = (el) => !!el.closest("[data-theme-scope], .tile-color, .swatch, .background-swatch, .brand > svg, option");
  const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";

  /** Every colour a custom property on :root gives in this theme. */
  const tokenColours = () => {
    const names = new Set();
    const walk = (rules) => { for (const rule of rules) { if (rule.cssRules && !rule.selectorText) walk(rule.cssRules); if (rule.selectorText && rule.selectorText.includes(":root")) for (const prop of rule.style) if (prop.startsWith("--")) names.add(prop); } };
    for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch (error) {} }
    for (const prop of document.documentElement.style) if (prop.startsWith("--")) names.add(prop);
    const probe = document.createElement("span");
    document.body.appendChild(probe);
    const out = new Set(["rgba(0, 0, 0, 0)"]);
    for (const name of names) { probe.style.backgroundColor = ""; probe.style.backgroundColor = "var(" + name + ")"; out.add(getComputedStyle(probe).backgroundColor); }
    probe.remove();
    return out;
  };

  /** The elements (under the page) whose colour, background, borders, outline or underline is no token's colour. */
  const outsideTokens = () => {
    const allowed = tokenColours();
    const found = [];
    for (const el of [document.body, ...document.querySelectorAll("#root *")]) {
      if (el instanceof SVGElement || skipped(el) || !visible(el)) continue;
      const cs = getComputedStyle(el);
      const props = ["color", "backgroundColor"];
      for (const side of ["Top", "Right", "Bottom", "Left"]) if (parseFloat(cs["border" + side + "Width"]) > 0 && cs["border" + side + "Style"] !== "none") props.push("border" + side + "Color");
      if (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) props.push("outlineColor");
      if (cs.textDecorationLine !== "none") props.push("textDecorationColor");
      for (const prop of props) if (!allowed.has(cs[prop])) found.push(describe(el) + " " + prop + " " + cs[prop]);
    }
    return [...new Set(found)];
  };

  /** The colour behind an element: its own and its ancestors' grounds, layered (a linear gradient by its first colour). */
  const behind = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      let c = parse(cs.backgroundColor);
      if ((!c || c.a === 0) && cs.backgroundImage.startsWith("linear-gradient")) { const m = /rgba?\([^)]+\)/.exec(cs.backgroundImage); if (m) c = parse(m[0]); }
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (const layer of layers.reverse()) base = over(layer, base);
    return base;
  };
  const faded = (el) => { for (let e = el; e; e = e.parentElement) { if (parseFloat(getComputedStyle(e).opacity) < 1) return true; if (e.matches && e.matches(":disabled")) return true; } return false; };

  /**
   * Text under 'min' to its ground, placeholders included, and the edges of the controls 'edges' names
   * under 'edge' to the ground around them.
   */
  const contrast = (scope, min, edge, edges = "button, input, select, textarea, .tile, .select, .search, .field-input") => {
    const low = [];
    const root = document.querySelector(scope) || document.body;
    for (const el of [root, ...root.querySelectorAll("*")]) {
      if (el instanceof SVGElement || skipped(el) || !visible(el) || faded(el)) continue;
      const hasText = [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim() !== "");
      if (hasText) {
        const fg = parse(getComputedStyle(el).color);
        const r = fg ? ratio(over(fg, behind(el)), behind(el)) : 0;
        if (r < min) low.push("text " + describe(el) + " " + r.toFixed(2) + ": " + el.textContent.trim().slice(0, 30));
      }
      if (el.matches("input[placeholder], textarea[placeholder]") && el.value === "") {
        const fg = parse(getComputedStyle(el, "::placeholder").color);
        const r = fg ? ratio(over(fg, behind(el)), behind(el)) : 0;
        if (r < min) low.push("placeholder " + describe(el) + " " + r.toFixed(2) + ": " + el.placeholder.slice(0, 30));
      }
      if (el.matches(edges)) {
        const cs = getComputedStyle(el);
        const width = parseFloat(cs.borderTopWidth);
        const bc = parse(cs.borderTopColor);
        if (width > 0 && cs.borderTopStyle !== "none" && bc && bc.a > 0 && el.parentElement) {
          const r = ratio(over(bc, behind(el.parentElement)), behind(el.parentElement));
          if (r < edge) low.push("edge " + describe(el) + " " + r.toFixed(2));
        }
      }
    }
    return [...new Set(low)];
  };

  const ratioOf = (fg, bg) => ratio(parse(fg), parse(bg));

  /** A column's edge against what is around it: its line drawn over its fill (a transparent line shows the fill), to the ground behind the column. */
  const edge = (el) => {
    const cs = getComputedStyle(el);
    const around = behind(el.parentElement);
    const fill = over(parse(cs.backgroundColor), around);
    return ratio(over(parse(cs.borderTopColor), fill), around);
  };
  return { outsideTokens, contrast, ratioOf, behind: (el) => behind(el), edge };
})();
`;

describe.skipIf(!browser)("themes, projects, the board's background and the bulk bar", () => {
  let base = "";
  let dir = "";
  let ctx: BoardContext;
  let server: BoardServer;
  let url = "";
  let context: BrowserContext;
  let page: Page;
  const problems: string[] = [];
  const tile = (id: number) => page.locator(`.tile[data-card='${id}']`);
  const column = (id: string): Promise<string[]> => page.locator(`[data-column='${id}'] .tile .tile-id`).allTextContents();
  const preferencesFile = (): string => path.join(dir, ".local", "preferences.json");
  const shot = async (name: string, keepMessage = false): Promise<void> => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    // A message left by an earlier step is not part of the picture.
    if (!keepMessage && (await page.getByTestId("message").count()) > 0) await page.getByTestId("message").getByRole("button", { name: "Dismiss" }).click();
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  };
  const evaluate = async <T>(expression: string): Promise<T> => {
    if (!(await page.evaluate("typeof window.__checks === 'object'"))) await page.evaluate(CHECKS);
    return (await page.evaluate(expression)) as T;
  };
  /** Writes the preferences as another page would; this page follows the stream. */
  const prefer = async (preferences: unknown): Promise<void> => {
    const response = await fetch(new URL("api/preferences", url), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(preferences) });
    expect(response.status).toBe(200);
  };
  const defaults = { schema: "pinboard.preferences/1", default: { theme: "system", lightTheme: "paper", darkTheme: "navy" }, projects: {} };
  const showTheme = async (id: string, background?: string): Promise<void> => {
    await prefer({ ...defaults, default: { theme: id, lightTheme: "paper", darkTheme: "navy", ...(background ? { background } : {}) } });
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(id);
    await expect.poll(() => page.locator("html").getAttribute("data-background")).toBe(background ?? null);
  };

  beforeAll(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), "pinboard-themes-"));
    let time = Date.parse("2026-11-19T08:00:00Z");
    ({ ctx, dir } = makeDemoBoard(path.join(base, "repo"), () => new Date((time += 37_000))));
    const outDir = path.join(base, "page");
    await buildPage(pageLocation(), outDir);
    server = createBoardServer({ dir, root: path.join(base, "repo"), home: "/home/tester", pageDir: outDir, debounceMs: 30, settleMs: 300, log: () => undefined });
    url = (await server.listen(0)).url;
    // Reduced motion: no transition is caught half way between two themes' colours.
    context = await browser!.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "light", reducedMotion: "reduce" });
    // The page must need no network: any request that leaves this machine fails the test.
    await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => {
      problems.push(`a request left the machine: ${route.request().url()}`);
      void route.abort();
    });
    page = await context.newPage();
    page.on("pageerror", (error) => problems.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !/status of 409 \(Conflict\)/.test(message.text())) problems.push(message.text());
    });
    await page.goto(url);
    await tile(1).waitFor();
  }, 120_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await server?.close();
    if (base) await rm(base, { recursive: true, force: true });
  }, 120_000);

  it("draws the board and an open card in each of the ten themes with that theme's tokens only, in its face, at the same sizes", async () => {
    const sizes: string[] = [];
    for (const theme of THEMES) {
      await showTheme(theme.id);
      expect(await evaluate<string[]>("window.__checks.outsideTokens()"), `${theme.id}: the board`).toEqual([]);
      await tile(7).click();
      await page.getByTestId("panel").locator(".panel-title").waitFor();
      await page.evaluate("document.fonts.ready");
      expect(await evaluate<string[]>("window.__checks.outsideTokens()"), `${theme.id}: the open card`).toEqual([]);
      const family = String(await page.evaluate("getComputedStyle(document.body).fontFamily"));
      expect(family.replace(/"/g, ""), theme.id).toContain(theme.font === "Atkinson Hyperlegible Next" ? "Atkinson Hyperlegible Next" : theme.font);
      sizes.push(
        String(
          await page.evaluate(
            "JSON.stringify([getComputedStyle(document.documentElement).getPropertyValue('--text-size').trim(), getComputedStyle(document.documentElement).getPropertyValue('--text-leading').trim(), ...['body', '.tile-title', '.column-title h2', '.panel-title', '.md', '.chip', '.count'].map((s) => { const cs = getComputedStyle(document.querySelector(s)); return cs.fontSize + '/' + cs.lineHeight; })])"
          )
        )
      );
      await shot(`${theme.id}`);
      // An editor with its markdown preview beside it, and the notification list.
      const panel = page.getByTestId("panel");
      await panel.getByRole("button", { name: "Edit the description" }).click();
      await panel.getByTestId("preview-split").click();
      await panel.getByTestId("preview-pane").waitFor();
      expect(await evaluate<string[]>("window.__checks.outsideTokens()"), `${theme.id}: an editor`).toEqual([]);
      await panel.getByRole("button", { name: "Cancel" }).click();
      await page.keyboard.press("Escape");
      await expect.poll(() => page.getByTestId("panel").count()).toBe(0);
      await page.getByTestId("capsule").click();
      await page.getByTestId("notifications").waitFor();
      expect(await evaluate<string[]>("window.__checks.outsideTokens()"), `${theme.id}: the notifications`).toEqual([]);
      await page.getByTestId("capsule").click();
      await expect.poll(() => page.getByTestId("notifications").count()).toBe(0);
    }
    // The same sizes and line heights in every theme: only the face changes.
    expect(new Set(sizes).size).toBe(1);
    expect(JSON.parse(sizes[0]!).slice(0, 2)).toEqual(["14px", "1.5"]);
    // The bundled faces load from the page itself.
    expect(await page.evaluate("document.fonts.check('14px \"Atkinson Hyperlegible Next\"') && document.fonts.check('14px \"IBM Plex Sans\"')")).toBe(true);
  }, 120_000);

  it("gives each of the eight colour themes a character of its own: an accent hue far from the others of its lightness, its own ground, its columns and cards apart from it", async () => {
    const colourThemes = THEMES.filter((theme) => theme.group !== "contrast");
    const looks: Record<string, { ground: Lch; column: Lch; card: Lch; accent: Lch; columnLine: string; cardLine: string }> = {};
    const cells: Array<{ caption: string; image: string }> = [];
    for (const theme of colourThemes) {
      await showTheme(theme.id);
      const tokens = (await page.evaluate(
        "['--ground', '--well-solid', '--surface', '--accent-ink', '--well-line', '--tile-line'].map((name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim())"
      )) as string[];
      const [ground, column, card, accent, columnLine, cardLine] = tokens as [string, string, string, string, string, string];
      looks[theme.id] = { ground: lch(ground), column: lch(column), card: lch(card), accent: lch(accent), columnLine, cardLine };
      // The same region of the board in each, for the contact sheet.
      if (SHOTS) cells.push({ caption: `${theme.name}: ${theme.about}`, image: (await page.screenshot({ clip: { x: 0, y: 0, width: 1280, height: 700 } })).toString("base64") });
    }
    if (SHOTS) {
      // The contact sheet: the eight side by side, the light ones above the dark ones.
      const sheet = await context.newPage();
      await sheet.setViewportSize({ width: 2128, height: 600 });
      await sheet.setContent(
        `<!doctype html><html><body style="margin:0;padding:16px;background:#c9ced6;color:#0b1630;font:600 17px/1.3 system-ui,sans-serif"><div style="display:grid;grid-template-columns:repeat(4,512px);gap:20px 16px">${cells
          .map((cell) => `<figure style="margin:0"><img src="data:image/png;base64,${cell.image}" style="display:block;width:512px;height:280px;border-radius:6px;box-shadow:0 0 0 1px rgba(0,0,0,.3)"><figcaption style="padding:7px 2px 0">${cell.caption}</figcaption></figure>`)
          .join("")}</div></body></html>`
      );
      await sheet.screenshot({ path: path.join(SHOTS, "all-themes.png"), fullPage: true });
      await sheet.close();
    }
    for (const mode of ["light", "dark"] as const) {
      const ids = colourThemes.filter((theme) => theme.mode === mode).map((theme) => theme.id);
      for (const [index, first] of ids.entries()) {
        for (const second of ids.slice(index + 1)) {
          // An accent of its own: 30 degrees of hue or more from every other theme of the same lightness.
          expect(hueDistance(looks[first]!.accent.h, looks[second]!.accent.h), `${first} and ${second}: their accents`).toBeGreaterThanOrEqual(30);
          // A ground of its own.
          expect(distance(looks[first]!.ground, looks[second]!.ground), `${first} and ${second}: their grounds`).toBeGreaterThanOrEqual(0.025);
        }
      }
    }
    for (const theme of colourThemes) {
      const look = looks[theme.id]!;
      // The ladder: a card stands off its column by its fill or its line, and a column off the ground (or it has a line of its own).
      const cardEdge = Math.max(Math.abs(look.card.l - look.column.l), look.cardLine.startsWith("#") ? Math.abs(lch(look.cardLine).l - look.column.l) : 0);
      expect(cardEdge, `${theme.id}: a card on its column`).toBeGreaterThanOrEqual(0.03);
      if (look.columnLine === "transparent") expect(Math.abs(look.column.l - look.ground.l), `${theme.id}: a column on the ground`).toBeGreaterThanOrEqual(0.025);
    }
  }, 60_000);

  it("keeps the high-contrast themes at 7:1 for text and 3:1 for control edges and the focus ring, the board and the open card", async () => {
    for (const id of ["contrast-light", "contrast-dark"]) {
      await showTheme(id);
      expect(await evaluate<string[]>("window.__checks.contrast('.app', 7, 3)"), `${id}: the board`).toEqual([]);
      await tile(9).click();
      await page.getByTestId("panel").locator(".panel-title").waitFor();
      expect(await evaluate<string[]>("window.__checks.contrast('[data-testid=panel]', 7, 3)"), `${id}: the open card`).toEqual([]);
      const focus = await evaluate<number[]>(
        "(() => { const p = document.createElement('span'); document.body.appendChild(p); const c = (n) => { p.style.color = 'var(' + n + ')'; return getComputedStyle(p).color; }; const out = ['--surface', '--ground', '--surface-2'].map((n) => window.__checks.ratioOf(c('--focus'), c(n))); p.remove(); return out; })()"
      );
      for (const value of focus) expect(value, `${id}: the focus ring`).toBeGreaterThanOrEqual(3);
      await page.keyboard.press("Escape");
      await expect.poll(() => page.getByTestId("panel").count()).toBe(0);
      // The bulk bar and the project list.
      await tile(2).click({ modifiers: ["ControlOrMeta"] });
      await page.getByTestId("bulk-bar").waitFor();
      expect(await evaluate<string[]>("window.__checks.contrast('[data-testid=bulk-bar]', 7, 3)"), `${id}: the bulk bar`).toEqual([]);
      await page.keyboard.press("Escape");
      await page.getByTestId("project").click();
      expect(await evaluate<string[]>("window.__checks.contrast('[data-testid=project-list]', 7, 3)"), `${id}: the project list`).toEqual([]);
      await page.keyboard.press("Escape");
    }
  }, 60_000);

  it("keeps the text of every theme at 4.5:1 on its ground, placeholders included, and the edges of its inputs and buttons at 3:1: the board, an open card, an editor, a new card, the menus", async () => {
    const controls = JSON.stringify("button, input, select, textarea, .select, .search, .field-input");
    const check = (scope: string): Promise<string[]> => evaluate<string[]>(`window.__checks.contrast(${JSON.stringify(scope)}, 4.5, 3, ${controls})`);
    const found: string[] = [];
    const note = (where: string, low: string[]): void => {
      for (const line of low) found.push(`${where}: ${line}`);
    };
    for (const theme of THEMES) {
      await showTheme(theme.id);
      note(`${theme.id} board`, await check(".app"));
      // A card open, then its description in the editor with the preview beside it.
      await tile(7).click();
      const panel = page.getByTestId("panel");
      await panel.locator(".panel-title").waitFor();
      note(`${theme.id} open card`, await check("[data-testid=panel]"));
      await panel.getByRole("button", { name: "Edit the description" }).click();
      await panel.getByTestId("preview-split").click();
      await panel.getByTestId("preview-pane").waitFor();
      note(`${theme.id} editor`, await check("[data-testid=panel]"));
      await panel.getByRole("button", { name: "Cancel" }).click();
      await page.keyboard.press("Escape");
      await expect.poll(() => page.getByTestId("panel").count()).toBe(0);
      // A new card's form: its placeholders.
      await page.locator("[data-column='inbox']").hover();
      await page.getByRole("button", { name: "New card in Inbox" }).click();
      await page.getByTestId("composer").waitFor();
      note(`${theme.id} new card`, await check("[data-testid=composer]"));
      await page.getByTestId("composer").getByRole("button", { name: "Cancel" }).click();
      await expect.poll(() => page.getByTestId("composer").count()).toBe(0);
      // The theme menu and the notification list.
      await page.getByTestId("theme").click();
      note(`${theme.id} theme menu`, await check("[data-testid=theme-menu]"));
      await page.keyboard.press("Escape");
      await page.getByTestId("capsule").click();
      await page.getByTestId("notifications").waitFor();
      note(`${theme.id} notifications`, await check("[data-testid=notifications]"));
      await page.getByTestId("capsule").click();
      await expect.poll(() => page.getByTestId("notifications").count()).toBe(0);
    }
    expect(found).toEqual([]);
  }, 120_000);

  it("keeps every theme's top bar, filter bar and cards inside the window at 1280 and at 800 px", async () => {
    for (const width of [1280, 800]) {
      await page.setViewportSize({ width, height: 800 });
      for (const theme of THEMES) {
        await showTheme(theme.id);
        const overflow = await page.evaluate(
          "(() => { const out = []; for (const s of ['.topbar', '.filterbar', '.topbar-end', '.brand']) { const el = document.querySelector(s); if (el && el.scrollWidth > el.clientWidth + 1) out.push(s + ' ' + el.scrollWidth + '>' + el.clientWidth); } for (const el of document.querySelectorAll('.tile')) if (el.scrollWidth > el.clientWidth + 1) out.push('tile ' + el.dataset.card); if (document.documentElement.scrollWidth > window.innerWidth + 1) out.push('page'); return out; })()"
        );
        expect(overflow, `${theme.id} at ${width} px`).toEqual([]);
        if (width === 800 && ["sage", "contrast-dark"].includes(theme.id)) await shot(`${theme.id}-800`);
      }
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  }, 120_000);

  it("keeps each column one surface on a background of the person's own: the theme's column surface holds the header and the cards, the title reads at 4.5:1 there, the edge stands 3:1 apart from the colour", async () => {
    const token = (name: string): Promise<string> => page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`) as Promise<string>;
    const rgb = (hex: string): string => `rgb(${[1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(", ")})`;
    interface Column {
      id: string;
      fill: string;
      behindTitle: string;
      titleOnHead: number;
      headInside: boolean;
      title: number;
      edge: number;
    }
    const columns = (): Promise<Column[]> =>
      evaluate<Column[]>(
        "[...document.querySelectorAll('.column')].map((column) => { const head = column.querySelector('.column-head, .column-strip'); const title = column.querySelector('.column-title h2, .strip-name'); const c = column.getBoundingClientRect(), h = head.getBoundingClientRect(); const fill = getComputedStyle(column).backgroundColor; const b = window.__checks.behind(title); return { id: column.dataset.column, fill, behindTitle: 'rgb(' + [b.r, b.g, b.b].map(Math.round).join(', ') + ')', headInside: h.left >= c.left && h.right <= c.right && h.top >= c.top && h.bottom <= c.bottom, title: window.__checks.ratioOf(getComputedStyle(title).color, fill), titleOnHead: window.__checks.ratioOf(getComputedStyle(title).color, 'rgb(' + [b.r, b.g, b.b].join(', ') + ')'), edge: window.__checks.edge(column) }; })"
      );
    for (const theme of THEMES) {
      await showTheme(theme.id);
      const surface = await token("--well-solid");
      // A light green, a dark navy, and the theme's own column surface.
      for (const background of ["#dff1e6", "#1a2a3a", surface]) {
        await showTheme(theme.id, background);
        const where = `${theme.id} on ${background}`;
        expect(await page.evaluate("getComputedStyle(document.querySelector('.board')).backgroundColor"), where).toBe(rgb(background));
        const shown = await columns();
        // Done is collapsed at this width: a collapsed column is held to the same.
        expect(shown.map((column) => column.id), where).toContain("done");
        for (const column of shown) {
          expect(column.fill, `${where}: ${column.id}'s surface`).toBe(rgb(surface));
          if (background !== surface) expect(column.fill, `${where}: ${column.id}`).not.toBe(rgb(background));
          // Behind the title: the column's header (the theme's tint, where it has one) on that surface, never the colour.
          if (background !== surface) expect(column.behindTitle, `${where}: behind ${column.id}'s title`).not.toBe(rgb(background));
          expect(column.titleOnHead, `${where}: ${column.id}'s title on its header`).toBeGreaterThanOrEqual(4.5);
          expect(column.headInside, `${where}: ${column.id}'s header`).toBe(true);
          expect(column.title, `${where}: ${column.id}'s title`).toBeGreaterThanOrEqual(4.5);
          expect(column.edge, `${where}: ${column.id}'s edge`).toBeGreaterThanOrEqual(3);
        }
        // The cards keep the theme's surface.
        expect(await page.evaluate("getComputedStyle(document.querySelector(\".tile[data-card='2']\")).backgroundColor"), where).toBe(await page.evaluate("(() => { const p = document.createElement('span'); p.style.color = 'var(--surface)'; document.body.appendChild(p); const c = getComputedStyle(p).color; p.remove(); return c; })()"));
      }
    }
    // What is still drawn on the colour itself, the board's scrollbar, switches to stay readable: Paper's text for a dark ground on a dark navy.
    await showTheme("paper", "#1a2a3a");
    expect(await token("--board-muted")).toBe("#c3cee0");
    expect(String(await page.evaluate("getComputedStyle(document.querySelector('.board')).scrollbarColor"))).toMatch(/^rgb\(195, 206, 224\)/);
    await showTheme("paper", "#ffffff");
    expect(await token("--board-muted")).toBe(await token("--muted"));
    // Picked from the menu: kept in the preferences.
    await page.getByTestId("theme").click();
    await page.locator("[data-background='#dcebf7']").click();
    await expect.poll(() => (JSON.parse(fs.readFileSync(preferencesFile(), "utf8")) as { default: { background?: string } }).default.background).toBe("#dcebf7");
    await page.keyboard.press("Escape");
    await showTheme("linen", "#dff1e6");
    await shot("custom-background");
    await showTheme("ember", "#0f2a2c");
    await shot("custom-background-dark");
    await showTheme("paper");
  }, 120_000);

  it("picks cards with Cmd/Ctrl-click, x, Shift-click and a column's menu, keeps the pick through live changes, and Esc clears it", async () => {
    await showTheme("paper");
    const count = () => page.getByTestId("bulk-count").textContent();
    await tile(2).click({ modifiers: ["ControlOrMeta"] });
    await expect.poll(count).toBe("1 selected");
    expect(await page.getByTestId("panel").count()).toBe(0);
    // Shift-click: every card between the last one picked and this one, in the column.
    expect(await column("backlog")).toEqual(["#10", "#4", "#3", "#2"]);
    await tile(10).click({ modifiers: ["Shift"] });
    await expect.poll(count).toBe("4 selected");
    await tile(3).click({ modifiers: ["ControlOrMeta"] });
    await expect.poll(count).toBe("3 selected");
    // x on the card the keyboard is on.
    await tile(1).focus();
    await page.keyboard.press("x");
    await expect.poll(count).toBe("4 selected");
    expect(await tile(1).getByTestId("tile-pick").getAttribute("aria-checked")).toBe("true");
    // A live change keeps the pick; a card that leaves the board leaves it.
    updateCard(ctx, 2, { as: "claude", changes: { status: "looked at" } });
    await expect.poll(() => tile(2).locator(".tile-status").count()).toBe(1);
    await expect.poll(count).toBe("4 selected");
    archiveCard(ctx, 1, { as: "robin" });
    await expect.poll(() => tile(1).count()).toBe(0);
    await expect.poll(count).toBe("3 selected");
    await page.keyboard.press("Escape");
    await expect.poll(() => page.getByTestId("bulk-bar").count()).toBe(0);
    // "Select all in this column".
    await page.locator("[data-column='ideas']").hover();
    await page.getByTestId("column-menu-ideas").click();
    await page.getByTestId("select-column-ideas").click();
    await expect.poll(count).toBe("3 selected");
    await page.getByTestId("bulk-clear").click();
    await expect.poll(() => page.getByTestId("bulk-bar").count()).toBe(0);
  });

  it("moves the picked cards together in their order after one question, says what happened, and undoes it", async () => {
    await tile(4).click({ modifiers: ["ControlOrMeta"] });
    await tile(2).click({ modifiers: ["ControlOrMeta"] });
    await tile(6).click({ modifiers: ["ControlOrMeta"] });
    await expect.poll(() => page.getByTestId("bulk-count").textContent()).toBe("3 selected");
    await shot("bulk-bar");
    const lines = readEvents(dir).count;
    await page.getByTestId("bulk-move").click();
    const dialog = page.getByTestId("bulk-dialog");
    await dialog.getByText("For review", { exact: true }).click();
    expect(await page.getByTestId("bulk-confirm").textContent()).toBe("Move 3 cards to For review");
    await page.getByTestId("bulk-confirm").click();
    await expect.poll(() => page.getByTestId("message").textContent()).toContain("3 moved to For review.");
    await shot("bulk-result", true);
    // In the board's order (Backlog top first, then Ideas), the first at the top; one event per card.
    expect(await column("for-review")).toEqual(["#4", "#2", "#6", "#11"]);
    expect(readEvents(dir).events.slice(lines).map(({ event }) => [event.item, event.kind])).toEqual([
      [4, "item.moved"],
      [2, "item.moved"],
      [6, "item.moved"]
    ]);
    await page.getByTestId("undo").click();
    await expect.poll(() => page.getByTestId("message").textContent()).toContain("Undone: 3 moved back.");
    expect(await column("backlog")).toEqual(["#10", "#4", "#3", "#2"]);
    expect(await column("ideas")).toEqual(["#16", "#6", "#5"]);
    // Archive asks once, then the cards leave the board (and the pick); Undo brings them back.
    await page.getByTestId("bulk-archive").click();
    expect(await page.getByTestId("bulk-confirm").textContent()).toBe("Archive 3 cards");
    await page.getByTestId("bulk-confirm").click();
    await expect.poll(() => page.getByTestId("message").textContent()).toContain("3 archived.");
    await expect.poll(() => tile(2).count()).toBe(0);
    expect(getCard(ctx, 2).card.archived).toBeDefined();
    await expect.poll(() => page.getByTestId("bulk-bar").count()).toBe(0);
    await page.getByTestId("undo").click();
    await expect.poll(() => page.getByTestId("message").textContent()).toContain("Undone: 3 brought back to the board.");
    await expect.poll(() => tile(2).count()).toBe(1);
    expect(getCard(ctx, 2).card.archived).toBeUndefined();
  });

  it("brings an archived card back from its panel", async () => {
    archiveCard(ctx, 5, { as: "robin" });
    await expect.poll(() => tile(5).count()).toBe(0);
    await page.goto(`${url}?card=5`);
    await page.getByTestId("unarchive").click();
    await expect.poll(() => page.getByTestId("message").textContent()).toContain("Brought #5 back to the board.");
    await expect.poll(() => tile(5).count()).toBe(1);
    expect(getCard(ctx, 5).card.archived).toBeUndefined();
    expect(readEvents(dir).events.at(-1)?.event).toMatchObject({ item: 5, kind: "item.unarchived", by: "robin" });
    await page.keyboard.press("Escape");
    await expect.poll(() => page.getByTestId("panel").count()).toBe(0);
  });

  it("drags a picked card and every picked card goes with it", async () => {
    await tile(3).click({ modifiers: ["ControlOrMeta"] });
    await tile(10).click({ modifiers: ["ControlOrMeta"] });
    await page.dragAndDrop(".tile[data-card='3']", "[data-column='inbox'] .column-body", { targetPosition: { x: 40, y: 4 } });
    await expect.poll(() => column("inbox")).toEqual(["#10", "#3", "#15"]);
    await page.keyboard.press("Escape");
  });

  it("adds and removes a tag and sets a project on the picked cards, a new project included, each with an Undo", async () => {
    await tile(3).click({ modifiers: ["ControlOrMeta"] });
    await tile(10).click({ modifiers: ["ControlOrMeta"] });
    await page.getByTestId("bulk-add-tag").click();
    await page.getByTestId("bulk-tag-input").fill("area:docs");
    await page.getByTestId("bulk-confirm").click();
    await expect.poll(() => page.getByTestId("message").textContent()).toContain("2 tagged area:docs.");
    expect(getCard(ctx, 3).card.tags).toContain("area:docs");
    await page.getByTestId("bulk-remove-tag").click();
    await page.getByTestId("bulk-dialog").getByText("area:docs", { exact: true }).click();
    await page.getByTestId("bulk-confirm").click();
    await expect.poll(() => page.getByTestId("message").textContent()).toContain("2 untagged area:docs.");
    await page.getByTestId("bulk-project").click();
    await page.getByTestId("bulk-project-input").fill("mobile");
    await page.getByTestId("bulk-project-replace").check();
    await page.getByTestId("bulk-confirm").click();
    await expect.poll(() => page.getByTestId("message").textContent()).toContain("2 set to the project mobile.");
    expect(getCard(ctx, 3).card.tags).toEqual(["repo:mobile"]);
    expect(getCard(ctx, 10).card.tags).toEqual(["area:ui", "repo:mobile"]);
    await page.getByTestId("undo").click();
    await expect.poll(() => page.getByTestId("message").textContent()).toContain("Undone: 2 put back in their projects.");
    // The same tags as before (a tag put back goes at the end).
    expect(getCard(ctx, 3).card.tags).toEqual(["repo:docs"]);
    expect([...getCard(ctx, 10).card.tags].sort()).toEqual(["area:ui", "repo:web"]);
    await page.keyboard.press("Escape");
  });

  it("narrows the whole board to a project, keeps it in the address, tags a new card with it, and shows the project's own theme", async () => {
    await showTheme("paper");
    await page.getByTestId("project").click();
    // Each entry with its open cards (not archived, not in Done), counted here from the files.
    const cards = readBoard(ctx).cards.filter((card) => card.archived === undefined && card.column !== "done");
    const open = (name: string): number => cards.filter((card) => card.tags.includes(`repo:${name}`)).length;
    const none = cards.filter((card) => !card.tags.some((tag) => tag.startsWith("repo:"))).length;
    const options = await page.getByTestId("project-list").locator("[role='option']").allTextContents();
    expect(options).toEqual([`All projects${cards.length}`, `api${open("api")}`, `docs${open("docs")}`, `web${open("web")}`, `No project${none}`]);
    expect(open("api")).toBeGreaterThan(2);
    await page.getByTestId("project-option-api").click();
    await expect.poll(() => page.url()).toContain("project=api");
    const apiCards = readBoard(ctx).cards.filter((card) => card.archived === undefined && card.tags.includes("repo:api"));
    await expect.poll(() => page.locator(".tile").count()).toBe(apiCards.filter((card) => card.column !== "done").length);
    expect(await page.getByTestId("count-pinned").textContent()).toBe("1");
    // The search searches the project only: "sign-in" is in a web card's title too, and only the api one counts.
    await page.getByTestId("search").fill("sign-in");
    await expect.poll(() => page.locator(".filter-sum").textContent()).toContain(`1 of ${apiCards.length} match`);
    await page.getByTestId("clear-filter").click();
    const before = await page.locator(".tile").count();
    // A new card here starts with the project's tag.
    await page.keyboard.press("n");
    expect(await page.getByTestId("composer-tags").textContent()).toBe("repo:api");
    await page.getByTestId("composer").getByLabel("Title").fill("Log the slow requests");
    await page.getByTestId("composer").getByRole("button", { name: "Create card" }).click();
    await expect.poll(() => page.locator(".tile").count()).toBe(before + 1);
    // The new card opens; Esc (twice when the panel's first field has the focus) goes back to the board.
    for (let tries = 0; tries < 3 && (await page.getByTestId("panel").count()) > 0; tries += 1) await page.keyboard.press("Escape");
    expect(await page.getByTestId("panel").count()).toBe(0);
    // A theme picked here is the project's own.
    await page.getByTestId("theme").click();
    expect(await page.getByTestId("theme-for").textContent()).toBe("for api");
    await page.locator("[data-theme-option='ember']").click();
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("ember");
    await page.keyboard.press("Escape");
    await expect.poll(() => (JSON.parse(fs.readFileSync(preferencesFile(), "utf8")) as { projects: Record<string, { theme?: string }> }).projects.api?.theme).toBe("ember");
    // All projects shows the default; back on api, its own again.
    await page.getByTestId("project").click();
    await page.getByTestId("project-option-all").click();
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("paper");
    expect(page.url()).not.toContain("project=");
    await page.getByTestId("project").click();
    await page.getByTestId("project-option-api").click();
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("ember");
    await shot("project-theme");
    // A link opens on its project; without one, the page opens on the last project shown.
    await page.goto(`${url}?project=web`);
    await tile(11).waitFor();
    const webOpen = readBoard(ctx).cards.filter((card) => card.archived === undefined && card.column !== "done" && card.tags.includes("repo:web")).length;
    await expect.poll(() => page.locator(".tile").count()).toBe(webOpen);
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("paper");
    await page.goto(url);
    await expect.poll(() => page.getByTestId("project").textContent()).toBe("api");
    // "Use the default" forgets the project's own.
    await page.getByTestId("theme").click();
    await page.getByTestId("theme-use-default").click();
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("paper");
    await page.keyboard.press("Escape");
    await page.getByTestId("project").click();
    await page.getByTestId("project-option-all").click();
    await expect.poll(() => page.locator(".tile").count()).toBeGreaterThan(10);
  });

  it("shows the theme menu: the ten themes grouped, each in its own face, System, and the background", async () => {
    await showTheme("paper");
    await page.getByTestId("theme").click();
    const menu = page.getByTestId("theme-menu");
    await menu.waitFor();
    expect(await menu.locator(".theme-group-name").allTextContents()).toEqual(["Light", "Dark", "High contrast"]);
    expect(await menu.locator("[role='radio'][data-theme-option]").count()).toBe(11);
    const faces = await page.evaluate("[...document.querySelectorAll('.theme-option .theme-name[data-theme-scope]')].map((el) => getComputedStyle(el).fontFamily.split(',')[0].replace(/\"/g, ''))");
    expect(faces).toEqual(["IBM Plex Sans", "Charter", "Trebuchet MS", "Verdana", "IBM Plex Sans", "Tahoma", "Seravek", "Iowan Old Style", "Atkinson Hyperlegible Next", "Atkinson Hyperlegible Next"]);
    // The keyboard: the list opens on the theme in use; arrows move, Enter picks, Esc closes.
    await expect.poll(() => page.evaluate("document.activeElement && document.activeElement.dataset.themeOption")).toBe("paper");
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => page.evaluate("document.activeElement.dataset.themeOption")).toBe("linen");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("linen");
    expect(await menu.locator("[data-theme-option='linen']").getAttribute("aria-checked")).toBe("true");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("paper");
    await shot("theme-menu");
    await page.keyboard.press("Escape");
    await expect.poll(() => menu.count()).toBe(0);
    await expect.poll(() => page.evaluate("document.activeElement && document.activeElement.dataset.testid")).toBe("theme");
  });

  it("draws the schedules' view, its list and its form, in each of the ten themes with that theme's tokens only, its text at 4.5:1 (7:1 in the high-contrast ones) and its edges at 3:1", async () => {
    // Made now, due next week: nothing the page's timer makes while the tests run.
    const now = { ...ctx, now: () => new Date() };
    addSchedule(now, "robin", { name: "check-deps", rule: { kind: "weekly", days: ["mon"], at: "09:00" }, card: { type: "task", title: "Check the dependencies", tags: ["for:claude"], fields: { definitionOfDone: "npm test passes", mayTouch: ["package.json"], limitMinutes: 30 } } });
    const controls = JSON.stringify("button, input, select, textarea, .select, .search, .field-input");
    const found: string[] = [];
    for (const theme of THEMES) {
      await showTheme(theme.id);
      await page.getByTestId("schedules-button").click();
      const view = page.getByTestId("schedules");
      await view.locator("[data-schedule='check-deps']").waitFor();
      await view.getByTestId("schedule-add").click();
      await view.getByTestId("schedule-form").waitFor();
      for (const line of await evaluate<string[]>("window.__checks.outsideTokens()")) found.push(`${theme.id} tokens: ${line}`);
      const min = theme.group === "contrast" ? 7 : 4.5;
      for (const line of await evaluate<string[]>(`window.__checks.contrast("[data-testid=schedules]", ${min}, 3, ${controls})`)) found.push(`${theme.id}: ${line}`);
      if (theme.id === "paper" || theme.id === "navy") await shot(`schedules-${theme.id}`);
      await page.keyboard.press("Escape");
      await expect.poll(() => view.count()).toBe(0);
    }
    expect(found).toEqual([]);
    removeSchedule(now, "robin", "check-deps");
  }, 120_000);

  it("raised no error in the page and sent no request off the machine along the way", () => {
    expect(problems).toEqual([]);
  });
}, 120_000);
