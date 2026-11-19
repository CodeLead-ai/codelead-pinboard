import { describe, expect, it } from "vitest";
import { BACKGROUNDS, backdropText, columnEdge, contrast, EDGE_CONTRAST, parseColour } from "../page/src/appearance.mjs";
import { inProject, NO_PROJECT, projectEntries, projectLabel, projectNamesOf, projectTags, readProject } from "../page/src/projects.mjs";
import { extend, inBoardOrder, prune, selectAll, toggle } from "../page/src/selection.mjs";

const card = (tags: string[], column = "backlog", archived?: string) => ({ tags, column, ...(archived ? { archived } : {}) });

describe("the project selector's model", () => {
  const cards = [
    card(["repo:api", "area:auth"]),
    card(["repo:api"], "done"),
    card(["repo:web"], "inbox"),
    card(["repo:web", "repo:api"], "pinned"),
    card(["area:ui"]),
    card([], "done"),
    card(["repo:docs"], "backlog", "2026-11-19T09:00:00Z"),
    card(["repo:"])
  ];

  it("lists All projects, each project by name with its open cards (not archived, not in the last column), then No project", () => {
    expect(projectEntries(cards, "done")).toEqual([
      { name: "", open: 5 },
      { name: "api", open: 2 },
      { name: "docs", open: 0 },
      { name: "web", open: 2 },
      { name: NO_PROJECT, open: 2 }
    ]);
    // A board with no project at all has nothing to choose but All projects.
    expect(projectEntries([card([]), card(["area:x"])], "done")).toEqual([{ name: "", open: 2 }]);
    expect(projectNamesOf(["repo:api", "repo:", "area:auth", "repo:web"])).toEqual(["api", "web"]);
  });

  it("narrows to a project: All projects takes every card, No project the cards with no repo: tag, a project its own (a card in two projects is in both)", () => {
    expect(cards.filter((entry) => inProject(entry, "")).length).toBe(cards.length);
    expect(cards.filter((entry) => inProject(entry, "api")).length).toBe(3);
    expect(cards.filter((entry) => inProject(entry, "web")).length).toBe(2);
    expect(cards.filter((entry) => inProject(entry, NO_PROJECT)).length).toBe(3);
    expect(projectLabel("")).toBe("All projects");
    expect(projectLabel(NO_PROJECT)).toBe("No project");
    expect(projectTags("api")).toEqual(["repo:api"]);
    expect(projectTags("")).toEqual([]);
    expect(projectTags(NO_PROJECT)).toEqual([]);
  });

  it("reads the project from the address (?project=), and a bookmark of the first page's ?repo= as one", () => {
    expect(readProject("?project=api&q=cache")).toBe("api");
    expect(readProject("?repo=web")).toBe("web");
    expect(readProject(`?project=${encodeURIComponent(NO_PROJECT)}`)).toBe(NO_PROJECT);
    expect(readProject("?q=cache")).toBeUndefined();
    expect(readProject("?project=")).toBe("");
  });
});

describe("the selection model", () => {
  const backlog = ["10", "4", "3", "2"];
  const ideas = ["16", "6", "5"];

  it("toggles a card, extends within a column from the anchor, selects a column, and never changes the set it is given", () => {
    const start = new Set(["2"]);
    expect([...toggle(start, "3")]).toEqual(["2", "3"]);
    expect([...toggle(start, "2")]).toEqual([]);
    expect([...start]).toEqual(["2"]);
    expect([...extend(start, "2", "10", backlog)].sort()).toEqual(["10", "2", "3", "4"]);
    expect([...extend(start, "10", "4", backlog)].sort()).toEqual(["10", "2", "4"]);
    // An anchor in another column, or none: the card alone.
    expect([...extend(start, "16", "4", backlog)].sort()).toEqual(["2", "4"]);
    expect([...extend(new Set<string>(), null, "4", backlog)]).toEqual(["4"]);
    expect([...selectAll(start, ideas)].sort()).toEqual(["16", "2", "5", "6"]);
  });

  it("follows the board: drops the cards no longer shown and keeps the same set when none left; orders the pick as the board does", () => {
    const picked = new Set(["3", "16", "99"]);
    expect([...prune(picked, new Set([...backlog, ...ideas]))]).toEqual(["3", "16"]);
    const same = new Set(["3"]);
    expect(prune(same, new Set(backlog))).toBe(same);
    expect(inBoardOrder(new Set(["5", "2", "10", "16"]), [backlog, ideas])).toEqual(["10", "2", "16", "5"]);
  });
});

describe("the board's background", () => {
  const paper = { ink: "#0b1630", muted: "#5b6b86", inkOnLight: "#0b1630", inkOnDark: "#f4f7fb", mutedOnLight: "#3d4b66", mutedOnDark: "#c3cee0" };

  it("keeps the theme's own text while it reads at 4.5:1 on the colour, and otherwise takes the theme's text for a light or a dark ground", () => {
    expect(backdropText(paper, "#ffffff")).toBeUndefined();
    expect(backdropText(paper, "#1a2a3a")).toEqual({ ink: "#f4f7fb", muted: "#c3cee0" });
    // A mid grey: the ink still reads, the muted text does not and takes the darker one.
    expect(backdropText(paper, "#c8ccd2")).toEqual({ ink: "#0b1630", muted: "#3d4b66" });
    expect(backdropText(paper, "not a colour")).toBeUndefined();
  });

  it("keeps a column's own edge while it stands 3:1 apart from the colour, then its surface's, then the theme's quietest colour that does", () => {
    const lines = ["#c4cfe0", "#66738b", "#5b6b86", "#31405c", "#0b1630", "#3d4b66", "#c3cee0", "#0b1630", "#f4f7fb"];
    const well = "#e5ebf5";
    // A dark navy: the light column is its own edge, through its transparent line.
    expect(columnEdge(well, "transparent", "#1a2a3a", lines)).toBeUndefined();
    // A light green, and the column's own surface: the first line that stands 3:1 apart.
    for (const background of ["#dff1e6", well]) {
      const edge = columnEdge(well, "transparent", background, lines)!;
      expect(edge).toBe("#66738b");
      expect(contrast(parseColour(edge)!, parseColour(background)!)).toBeGreaterThanOrEqual(EDGE_CONTRAST);
    }
    // A grey line of a high-contrast theme: kept on a light colour, given the white surface's colour on a dark one.
    expect(columnEdge("#ffffff", "#6b6b6b", "#dff1e6", lines)).toBeUndefined();
    expect(columnEdge("#ffffff", "#6b6b6b", "#1a2a3a", lines)).toBe("#ffffff");
    // A mid grey close to a dark theme's column: the light text does it.
    const navy = ["#2a3a5a", "#7787a3", "#8fa0bc", "#c3cee0", "#e8eef8", "#3d4b66", "#c3cee0", "#0b1630", "#e8eef8"];
    const edge = columnEdge("#0b1222", "transparent", "#2a3346", navy)!;
    expect(contrast(parseColour(edge)!, parseColour("#2a3346")!)).toBeGreaterThanOrEqual(EDGE_CONTRAST);
    expect(columnEdge(well, "transparent", "not a colour", lines)).toBeUndefined();
  });

  it("offers twelve backgrounds for each lightness, light ones that keep a dark ink readable and dark ones that keep a light ink readable", () => {
    expect(BACKGROUNDS.light).toHaveLength(12);
    expect(BACKGROUNDS.dark).toHaveLength(12);
    for (const colour of BACKGROUNDS.light) expect(contrast(parseColour(colour.hex)!, parseColour("#0b1630")!)).toBeGreaterThanOrEqual(7);
    for (const colour of BACKGROUNDS.dark) expect(contrast(parseColour(colour.hex)!, parseColour("#e8eef8")!)).toBeGreaterThanOrEqual(7);
    expect(parseColour("rgba(10, 20, 30, 0.5)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColour("color(srgb 1 0 0.5)")).toEqual({ r: 255, g: 0, b: 127.5, a: 1 });
  });
});
