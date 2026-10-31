import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runBoardImport, runBoardInit, runBoardValidate, type BoardCliDependencies } from "../cli/board.js";
import { boardContext, getCard, readEvents, sha256 } from "../core/index.js";
import { importDocuments, type ImportedItem } from "../import/index.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/import/", import.meta.url));
const DOCUMENTS = ["PINNED.md", "DECISIONS-PENDING.md", "behaviour-extraction-plan-2026-10-01.md"];

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function write(base: string, relative: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(base, relative)), { recursive: true });
  fs.writeFileSync(path.join(base, relative), text, "utf8");
}

/**
 * A workspace of the test's own: the repository `codelead` with trimmed copies of the three
 * documents in docs/ (the one machine path they hold pointing into this workspace), the files they
 * cite, and two other repositories beside it.
 */
async function workspace(documents = DOCUMENTS): Promise<{ ws: string; root: string; lines: string[]; deps: BoardCliDependencies; said: () => string }> {
  const ws = await mkdtemp(path.join(os.tmpdir(), "pinboard-import-"));
  roots.push(ws);
  const root = path.join(ws, "codelead");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  for (const name of documents) write(root, `docs/${name}`, fs.readFileSync(path.join(FIXTURES, name), "utf8").replaceAll("{{WORKSPACE}}", ws));
  write(root, "docs/kettlebook-desk-spec-2026-09-29.md", "# The spec\n");
  write(root, "docs/w5-design-2026-10-02.md", "# The design\n");
  write(root, "docs/truth-sets/sampleapp.system-model.truth.json", "{}\n");
  fs.mkdirSync(path.join(ws, "kettlebook-desk"));
  write(ws, "sampleapp-pilot/SampleApp.Game/Views/Player/EditProfile.cshtml", "<form></form>\n");
  const lines: string[] = [];
  const deps: BoardCliDependencies = { cwd: () => root, output: (line) => lines.push(line), now: () => new Date("2026-10-04T10:00:00Z"), home: "/home/tester" };
  expect(await runBoardInit({ name: "codelead-workspace", person: ["robin:Robin"], agent: ["claude:Claude Code"] }, deps)).toBe(0);
  lines.splice(0);
  return { ws, root, lines, deps, said: () => lines.splice(0).join("\n") };
}

/** One item of the mapping, as the person reads it: where, what became of it, its title, the notes. */
function row(item: ImportedItem): [string, number, string, string, string[]] {
  const outcome = item.card ? `#${String(item.card.id)} ${item.card.type} ${item.card.column}` : `skipped: ${item.reason ?? ""}`;
  return [item.source, item.line, outcome, item.title, item.notes];
}

/** The mapping the import must print for the trimmed documents, written out by hand. */
const EXPECTED: Array<[string, number, string, string, string[]]> = [
  ["docs/PINNED.md", 9, "#1 task pinned", "Ask the partner two lists", []],
  [
    "docs/PINNED.md",
    15,
    "#2 decision pinned",
    "0j: KettleBook Desk (side project): BUILT 2026-09-29 (0.1.0, fifteen commits, kettlebook-desk); left: the name, and…",
    ["a path of this machine is written as kettlebook-desk (2 times)"]
  ],
  ["docs/PINNED.md", 19, "#3 decision pinned", "0s: W4 merged (2026-10-03 00:09Z): six overlay entries to review, and one disputed target", []],
  ["docs/PINNED.md", 21, "#4 decision pinned", "0r: The W5 design: review it, and seven decisions (2026-10-02)", []],
  ["docs/PINNED.md", 25, "#5 review pinned", "Partner feedback spec", []],
  ["docs/PINNED.md", 30, "#6 decision pinned", "EF Core migration task on ShopSample", []],
  ["docs/PINNED.md", 35, "#7 decision done", '0p: ANSWERED 2026-10-02 (Robin): "yes, follow the intent and hide it until initialize."', []],
  ["docs/PINNED.md", 36, "#8 decision done", "SQL Server for the pilot", []],
  ["docs/DECISIONS-PENDING.md", 5, 'skipped: closed: "SHIPPED" in its first words', "Evidence records now cover repairs and pre-proposal stops — SHIPPED 2026-09-17 17:01Z", []],
  ["docs/DECISIONS-PENDING.md", 6, "#9 decision pinned", "Toolchain floor is a plan-time fact (product rule, from the SampleApp after-build 2026-09-17)", ['open: it says "Robin\'s call"']],
  ["docs/DECISIONS-PENDING.md", 7, "skipped: closed: it says nothing is open", "Harness gaps from the Muse runs (2026-09-15 04:15Z)", []],
  ["docs/DECISIONS-PENDING.md", 9, 'skipped: closed: "answered" in its first words', "SampleApp pilot Day-1", []],
  ["docs/DECISIONS-PENDING.md", 12, 'skipped: closed: "DECIDED" in its first words', "DECIDED (Robin, 2026-09-17) — migration UX", []],
  ["docs/DECISIONS-PENDING.md", 13, "skipped: PINNED carries it (line 30)", "EF Core migration task on ShopSample needs dotnet ef (2026-09-16)", []],
  ["docs/DECISIONS-PENDING.md", 14, "#10 decision backlog", "Plan claims are beliefs until checked (ShopSample t1b–t1d, 2026-09-16)", ['open: it says "undecided"']],
  ["docs/DECISIONS-PENDING.md", 15, "skipped: closed: struck through", "Effort experiments at the end of the queue superseded", []],
  ["docs/DECISIONS-PENDING.md", 16, "skipped: a record: nothing in it waits on anyone", "Off-domain 1, Tally (12:20Z): 8/8, 122.3 min, 1 retry, live oracle 32/32", []],
  ["docs/DECISIONS-PENDING.md", 17, "#11 decision backlog", "QUESTION FOR ROBIN (16:07Z, from 11b inc-12/13)", ['open: it says "QUESTION FOR ROBIN"']],
  ["docs/DECISIONS-PENDING.md", 23, "skipped: answered in the document (Answer: …)", '§10.1 naming ("CodeLead Modernize"; Dossier vs Assessment)', []],
  ["docs/DECISIONS-PENDING.md", 24, "#12 decision pinned", "§10.6 PKB roadmap placement (fold §6 into codelead-pkb now vs hold)", ['open: it says "— open"']],
  ["docs/behaviour-extraction-plan-2026-10-01.md", 9, "#13 task done", "0. Truth set", []],
  ["docs/behaviour-extraction-plan-2026-10-01.md", 10, "#14 task in-progress", "W5. Proof", []],
  ["docs/behaviour-extraction-plan-2026-10-01.md", 11, "#15 task backlog", "W7. Brownfield blast radius", []]
];

describe("the import of today's documents", () => {
  it("maps every item to the card it becomes, or to why it does not, and a dry run writes nothing", async () => {
    const { root, deps, said } = await workspace();
    const board = path.join(root, "docs", "codelead", "board");
    const ctx = boardContext({ dir: board, root, home: "/home/tester", now: () => new Date("2026-10-04T10:00:00Z") });
    const result = importDocuments(ctx, { from: path.join(root, "docs"), dryRun: true });
    expect(result.items.map(row)).toEqual(EXPECTED);
    expect(result.sources).toEqual([
      { source: "docs/PINNED.md", found: true, items: 8, cards: 8 },
      { source: "docs/DECISIONS-PENDING.md", found: true, items: 12, cards: 4 },
      { source: "docs/behaviour-extraction-plan-2026-10-01.md", found: true, section: "8", items: 3, cards: 3 }
    ]);
    expect(fs.readdirSync(path.join(board, "items"))).toEqual([]);

    // The command prints the same mapping, for the person to check.
    expect(await runBoardImport({ from: "docs", dryRun: true }, deps)).toBe(0);
    const printed = said().split("\n");
    expect(printed[0]).toBe("Import from docs as robin: 15 cards from 3 documents; 8 items skipped. Dry run: nothing was written, and the ids are the ones the cards would get.");
    expect(printed).toContain("docs/PINNED.md: 8 items, 8 cards");
    expect(printed).toContain("  line 9     → #1    task     Pinned      Ask the partner two lists");
    expect(printed).toContain("             a path of this machine is written as kettlebook-desk (2 times)");
    expect(printed).toContain("docs/DECISIONS-PENDING.md: 12 items, 4 cards, 8 skipped");
    expect(printed).toContain("  line 13    skipped: PINNED carries it (line 30) · EF Core migration task on ShopSample needs dotnet ef (2026-09-16)");
    expect(printed).toContain("docs/behaviour-extraction-plan-2026-10-01.md §8: 3 items, 3 cards");
    expect(printed).toContain("  line 10    → #14   task     In progress W5. Proof");
    expect(fs.readdirSync(path.join(board, "items"))).toEqual([]);
    expect(fs.readFileSync(path.join(board, "events.jsonl"), "utf8")).toBe("");
  });

  it("writes one card per item with the item's text and citations, its source and the paths it names, and leaves the documents as they were", async () => {
    const { ws, root, deps, said } = await workspace();
    const before = DOCUMENTS.map((name) => fs.readFileSync(path.join(root, "docs", name), "utf8"));
    expect(await runBoardImport({ from: "docs" }, deps)).toBe(0);
    expect(said().split("\n")[0]).toBe("Import from docs as robin: 15 cards from 3 documents; 8 items skipped.");
    expect(DOCUMENTS.map((name) => fs.readFileSync(path.join(root, "docs", name), "utf8"))).toEqual(before);

    const board = path.join(root, "docs", "codelead", "board");
    const ctx = boardContext({ dir: board, root, home: "/home/tester" });
    const card = (id: number) => getCard(ctx, id).card;
    expect(fs.readdirSync(path.join(board, "items"))).toHaveLength(15);

    expect(card(1)).toMatchObject({ type: "task", column: "pinned", author: "robin", tags: ["repo:codelead"], attachments: [{ path: "docs/PINNED.md", lines: "9-11" }] });
    expect(card(1).description).toBe(
      "**Ask the partner two lists** (spec §5 O2, your answer to Q2.1): their last ten\napplication requests (to choose the first building blocks) and their last ten modernization\nenquiries by type (to weight the taxonomy in §3.1)."
    );
    // The citations are kept; the path of this machine is now the repository it points at.
    expect(card(2)).toMatchObject({ tags: ["repo:codelead", "pinned:0j"], attachments: [{ path: "docs/PINNED.md", lines: "15-17" }, { path: "docs/kettlebook-desk-spec-2026-09-29.md" }] });
    expect(card(2).description).toContain("(§1 the Electron decision, lines 5–7; §3 the feature list by priority, lines 72–95)");
    expect(card(2).description).toContain("repository (`kettlebook-desk` proposed).");
    expect(card(2).description).not.toContain(ws);
    // A path in another repository of the workspace is attached as <repository>:<path>, with its line.
    expect(card(3)).toMatchObject({
      relations: [{ kind: "related", to: 4 }],
      attachments: [{ path: "docs/PINNED.md", lines: "19" }, { path: "sampleapp-pilot:SampleApp.Game/Views/Player/EditProfile.cshtml", lines: "25" }]
    });
    expect(card(3).description).toContain("(`sampleapp-pilot/SampleApp.Game/Views/Player/EditProfile.cshtml:25`)");
    expect(card(4)).toMatchObject({ tags: ["repo:codelead", "pinned:0r"], relations: [{ kind: "related", to: 14 }], attachments: [{ path: "docs/PINNED.md", lines: "21" }, { path: "docs/w5-design-2026-10-02.md" }] });
    expect(card(4).description).toBe(
      "**0r — The W5 design: review it, and seven decisions (2026-10-02).** `docs/w5-design-2026-10-02.md`: the seven rulings are section 2 (lines 29–66); the decisions are section 9 (lines 446–491)."
    );
    // A path that is not in the repository is left in the text and not attached.
    expect(card(5).attachments).toEqual([{ path: "docs/PINNED.md", lines: "25-26" }]);
    expect(card(6).attachments).toEqual([{ path: "docs/PINNED.md", lines: "30-31" }, { path: "docs/DECISIONS-PENDING.md" }]);
    expect(card(9)).toMatchObject({ type: "decision", column: "pinned", attachments: [{ path: "docs/DECISIONS-PENDING.md", lines: "6" }] });
    expect(card(13)).toMatchObject({
      type: "task",
      column: "done",
      tags: ["repo:codelead", "plan:0"],
      attachments: [{ path: "docs/behaviour-extraction-plan-2026-10-01.md", lines: "9" }, { path: "docs/truth-sets/sampleapp.system-model.truth.json" }]
    });
    expect(card(13).description).toBe(
      "**Work:** SampleApp' behaviour written by hand from the old sources (`docs/truth-sets/sampleapp.system-model.truth.json`).\n\n**Measured:** Caller edges 14/64 = 0.22, load triggers 0/2.\n\n**Status:** **Done 2026-10-01.** The second truth set is the partner's first app."
    );
    // W5 names 0r, which already relates to W5: the pair is related once.
    expect(card(14)).toMatchObject({ column: "in-progress", tags: ["repo:codelead", "plan:W5"], relations: [] });
    expect(card(15)).toMatchObject({ column: "backlog", tags: ["repo:codelead", "plan:W7"] });

    const events = readEvents(board).events.map(({ event }) => event);
    expect(events).toHaveLength(15);
    expect(events[0]).toEqual({ at: "2026-10-04T10:00:00Z", by: "robin", item: 1, kind: "item.created", data: { title: "Ask the partner two lists", type: "task", column: "pinned", source: "docs/PINNED.md:9-11" } });

    const config = JSON.parse(fs.readFileSync(path.join(board, "board.json"), "utf8")) as { nextId: number; imports: unknown[] };
    expect(config.nextId).toBe(16);
    expect(config.imports).toEqual([
      { source: "docs/PINNED.md", at: "2026-10-04T10:00:00Z", by: "robin", sha256: sha256(before[0]!), cards: [1, 2, 3, 4, 5, 6, 7, 8] },
      { source: "docs/DECISIONS-PENDING.md", at: "2026-10-04T10:00:00Z", by: "robin", sha256: sha256(before[1]!), cards: [9, 10, 11, 12] },
      { source: "docs/behaviour-extraction-plan-2026-10-01.md", at: "2026-10-04T10:00:00Z", by: "robin", sha256: sha256(before[2]!), cards: [13, 14, 15] }
    ]);
    expect(await runBoardValidate({}, deps)).toBe(0);
    said();

    // Once per document: a second run is refused, and writes nothing.
    expect(await runBoardImport({ from: "docs" }, deps)).toBe(1);
    expect(said()).toBe('Refused: docs/PINNED.md was imported on 2026-10-04T10:00:00Z (board.json "imports"); the import runs once per document. Nothing was written.');
    expect(fs.readdirSync(path.join(board, "items"))).toHaveLength(15);
  });

  it("attaches only paths inside the workspace's repositories: a path that climbs out with .. stays text", async () => {
    const { ws, root, deps, said } = await workspace([]);
    write(ws, "outside.md", "# not in any repository\n");
    write(root, "docs/PINNED.md", "# Pinned\n\n## For review\n\n0. **Two paths** — `../outside.md` and `docs/w5-design-2026-10-02.md:3-4`.\n");
    expect(await runBoardImport({ from: "docs" }, deps)).toBe(0);
    said();
    const ctx = boardContext({ dir: path.join(root, "docs", "codelead", "board"), root, home: "/home/tester" });
    expect(getCard(ctx, 1).card).toMatchObject({
      type: "review",
      title: "Two paths",
      attachments: [{ path: "docs/PINNED.md", lines: "5" }, { path: "docs/w5-design-2026-10-02.md", lines: "3-4" }]
    });
  });

  it("runs as a person only, and says which documents it did not find", async () => {
    const { deps, said } = await workspace(["PINNED.md"]);
    expect(await runBoardImport({ from: "docs", as: "claude" }, deps)).toBe(1);
    expect(said()).toBe("Refused: the import writes into Pinned and Done, a person's columns, and claude is an agent; run it as a person (--as robin). Nothing was written.");
    expect(await runBoardImport({ from: "docs", dryRun: true }, deps)).toBe(0);
    const printed = said();
    expect(printed).toContain("docs/DECISIONS-PENDING.md: not found, nothing imported from it");
    expect(printed).toContain("docs/behaviour-extraction-plan-2026-10-01.md: not found, nothing imported from it");
    expect(await runBoardImport({ from: "nowhere" }, deps)).toBe(2);
    expect(said()).toBe("No folder nowhere.");
  });
});
