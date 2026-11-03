import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentsGuide,
  appendCommentText,
  boardConfigProblems,
  boardContext,
  defaultBoardConfig,
  eventLine,
  formatEntry,
  formatJson,
  formatScalar,
  initBoard,
  parseCardText,
  parseYamlMapping,
  serializeCard,
  structureLines,
  updateCardText,
  type CardData
} from "../core/index.js";
import { isPlainWord } from "../core/yaml.js";

/**
 * The golden files: the example files of the board's technical design (section 2: board.json, a
 * card, events.jsonl, a cursor), as the design gave them, in fixtures/format.
 */
const FORMAT = fileURLToPath(new URL("./fixtures/format/", import.meta.url));

function designFile(name: "board.json" | "card.md" | "events.jsonl" | "cursor.json"): string {
  return fs.readFileSync(path.join(FORMAT, name), "utf8");
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function folder(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pinboard-formats-"));
  roots.push(root);
  return root;
}

const DESIGN_CARD: CardData = {
  id: 42,
  type: "task",
  title: "W5 package 6: the composer reads the plan",
  column: "backlog",
  tags: ["w5", "repo:codelead"],
  author: "claude",
  created: "2026-10-03T00:40:00Z",
  updated: "2026-10-03T00:52:10Z",
  relations: [
    { kind: "child-of", to: 7 },
    { kind: "blocked-by", to: 41 }
  ],
  attachments: [{ path: "docs/w5-design-2026-10-02.md", lines: "198-276" }],
  fields: {
    definitionOfDone: "the shell's three parts and a feature's request are composed from the plan; golden texts; byte-identical with a version-1 map",
    size: "M",
    landed: []
  },
  session: "a35d7fdc-37ea-4117-bec8-3cc69e4d6b82",
  extra: {},
  description: "The composer plans from the System Model: the shell's three parts first, then …",
  thread: [
    { author: "claude", at: "2026-10-03T00:40:00Z", body: "Proposed from the session: the design's section 4 and design B's appendices A and B hold the\ngolden texts." },
    { author: "robin", at: "2026-10-03T00:52:10Z", body: "Fine. After packages 4 and 5." }
  ]
};

describe("the design's examples are the formats (golden files)", () => {
  it("reads the card of design 2.2 into its fields, and writes those fields back byte for byte", () => {
    const text = designFile("card.md");
    const { card, problems } = parseCardText(text);
    expect(problems).toEqual([]);
    expect(card).toEqual(DESIGN_CARD);
    expect(serializeCard(DESIGN_CARD)).toBe(text);
    // A write that changes nothing changes no byte.
    expect(updateCardText(text, card!, card!)).toBe(text);
  });

  it("reads board.json of design 2.1 as a valid board and writes it in the same layout", () => {
    const text = designFile("board.json");
    const config = JSON.parse(text) as Record<string, unknown>;
    expect(boardConfigProblems(config)).toEqual([]);
    expect(`${formatJson(config)}\n`).toBe(text);
  });

  it("writes each event of design 2.3 as the very line the design shows", () => {
    const lines = designFile("events.jsonl").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(eventLine(JSON.parse(line))).toBe(line);
    // Whatever order a writer used, the board writes at, by, item, kind, data, and keeps other keys after them.
    expect(eventLine({ data: { from: "inbox", to: "backlog" }, kind: "item.moved", item: 42, by: "robin", at: "2026-10-03T00:52:10Z", via: "page" })).toBe(
      '{"at":"2026-10-03T00:52:10Z","by":"robin","item":42,"kind":"item.moved","data":{"from":"inbox","to":"backlog"},"via":"page"}'
    );
  });

  it("writes the cursor of design 2.4 on its one line", () => {
    const text = designFile("cursor.json");
    expect(`${formatJson(JSON.parse(text))}\n`).toBe(text);
  });

  it("writes AGENTS.md: the conventions, in about forty lines, for an agent that has never seen CodeLead", () => {
    const config = defaultBoardConfig({ name: "codelead-workspace", participants: [{ id: "robin", kind: "person", name: "Robin" }, { id: "claude", kind: "agent", name: "Claude Code" }] });
    const expected = [
      "# Pinboard: how an agent takes part",
      "",
      "This folder is a board shared by a person and their coding agents. The files are the board:",
      "read and write them with the tools you have. `codelead board …` makes the same writes with the",
      "checks below, when CodeLead is installed (`codelead board --help`).",
      "",
      "## The files",
      "- `board.json`: the columns, the card types, the participants (add yourself as",
      '  `{ "id": "<you>", "kind": "agent", "name": "…" }` before you write), `agents.mayMoveTo`,',
      "  `check.intervalMinutes` (how often to check; 30 when this file was written) and `nextId`.",
      "- `items/NNNN-<slug>.md`: one card. YAML front matter (`id`, `type`, `title`, `column`, `tags`,",
      "  `author`, `created`, `updated`; `relations`, `attachments`, `fields`, `status` when set; keep",
      "  every key you do not know), the description in markdown, then `## Thread`: each comment is a",
      "  line `### <participant> · <UTC time>` followed by its markdown.",
      "- `events.jsonl`: one JSON line per change, appended, never edited:",
      '  `{"at":"2026-10-03T00:52:10Z","by":"<you>","item":42,"kind":"comment.added","data":{"excerpt":"…"}}`',
      "  Kinds: item.created, item.updated, item.moved, item.archived, comment.added, relation.added,",
      "  relation.removed, tag.added, tag.removed, attachment.added.",
      "- `cursors/<you>.json`: what you have seen (not in git):",
      '  `{ "seen": "<time>", "lines": <how many lines of events.jsonl you have read> }`.',
      "",
      "## Check",
      "Every `check.intervalMinutes` minutes, and whenever the person asks, read the lines of",
      "`events.jsonl` after your cursor (`codelead board check --as <you>`). Act on what others",
      "wrote, then move your cursor (`--ack`). When nothing changed, that is one short read.",
      "The check every 30 minutes needs a timer you do not have by yourself: in Claude Code the person",
      "starts one (`/loop 30m codelead board check --as <you>`); without one, check at the start of the",
      "session and whenever the person asks.",
      "An event whose `data.addressed` holds your id is addressed to you (its text mentions `@<you>`):",
      'the check lists those cards first, under "Addressed to you"; answer them first.',
      "An event with `data.decided` is the person's answer to a decision card, recorded in its fields:",
      'the check lists it under "Decided"; act on it as on a comment that says it.',
      "",
      "## Write",
      "- Re-read a card right before you change it, and set its `updated` to the time of your change.",
      "- Reply: append `### <you> · <time>` and your markdown at the end of the card, then the event",
      "  `comment.added`.",
      "- Address someone with `@<id>` (or their name) in a comment or a description; its event's",
      '  `data.addressed` is derived from the text: the ids it mentions outside code, `["<id>", …]`.',
      "- Create: take `nextId` from board.json and raise it by one in the same step; put the card in",
      "  Inbox (or another column you may move into); tag it `by:<you>`; event `item.created`.",
      "- When the person asks to turn a conversation into cards: a card per decision, task, question or",
      "  idea, its description standing on its own (what, why, where it came from and when), related to",
      "  the others and to the cards it touches, tagged `by:<you>` and `source:conversation`, in Inbox",
      "  or Backlog; show the person the list, and create them on their yes.",
      "- On a decision, `fields.ask` says what the person is asked to decide, the options and your",
      "  recommendation, in one to three sentences; `color` is the person's colour mark: leave it.",
      "- Never set a decision's `fields.decided`: the decision is the person's; write your",
      "  recommendation in `fields.ask`.",
      "- You may move a card into Inbox, Backlog, Ideas, In progress (only when the person asked for",
      "  the work in the session) and For review; add tags and relations; create cards.",
      "- Every change gets its event line, `by` you. Times are UTC: `2026-10-03T00:52:10Z`.",
      "",
      "## Never",
      "- Start code work because of a card. Work starts when the person asks for it in the session.",
      "- Move a card into Pinned or Done: those columns are the person's.",
      "- Edit or remove a comment, yours or another's; you only append to the thread.",
      "- Write secrets (keys, passwords, tokens), names the project keeps private",
      "  (`private-names.txt`), or paths of your machine (`<home>/…`, `C:\\…`) into a card. Cite files",
      "  by their path in the repository, or `<repository>:<path>` for another repository.",
      "",
      "## Work the person asked for",
      "When it is done: comment with what landed (the commit, the evidence record's id, the files),",
      "and move the card to For review. The person moves it to Done.",
      ""
    ].join("\n");
    expect(agentsGuide(config)).toBe(expected);
  });

  it("writes another board's AGENTS.md with that board's own columns", () => {
    const config = defaultBoardConfig({ name: "other", participants: [{ id: "ana", kind: "person", name: "Ana" }, { id: "codex", kind: "agent", name: "Codex" }] });
    config.columns = [
      { id: "todo", name: "To do" },
      { id: "waiting", name: "Waiting on me", owner: "person" },
      { id: "check", name: "Check" }
    ];
    config.agents.mayMoveTo = ["todo", "check"];
    config.check = { intervalMinutes: 60 };
    const guide = agentsGuide(config);
    expect(guide).toContain("- You may move a card into To do and Check; add tags and relations; create cards.");
    expect(guide).toContain("- Move a card into Waiting on me: that column is the person's.");
    expect(guide).toContain("put the card in\n  To do (or another column you may move into)");
    expect(guide).toContain("(how often to check; 60 when this file was written)");
    // The cards of a conversation land in the board's first column (and its backlog, when it has one).
    expect(guide.replace(/\s+/g, " ")).toContain("tagged `by:<you>` and `source:conversation`, in To do; show the person the list");
  });

  it("init writes the design's board.json, with the check interval (30 minutes) and the next id", async () => {
    const dir = path.join(await folder(), "docs", "codelead", "board");
    const ctx = boardContext({ dir, root: path.resolve(dir, "../../..") });
    initBoard(ctx, { name: "codelead-workspace", participants: [{ id: "robin", kind: "person", name: "Robin" }, { id: "claude", kind: "agent", name: "Claude Code" }] });
    const design = designFile("board.json");
    expect(fs.readFileSync(path.join(dir, "board.json"), "utf8")).toBe(design.replace(/\n}\n$/, ',\n  "check": { "intervalMinutes": 30 },\n  "nextId": 1\n}\n'));
  });
});

describe("a card's file: round trips", () => {
  const text = designFile("card.md");

  it("keeps unknown keys, comments and blank lines of the front matter; only the changed key's line differs", () => {
    const withUnknown = text.replace(
      "session:",
      ["priority: high", "# a note someone left", "review:", "  by: robin", "  on: 2026-10-04", "", "session:"].join("\n")
    );
    const { card, problems } = parseCardText(withUnknown);
    expect(problems).toEqual([]);
    expect(card!.extra).toEqual({ priority: "high", review: { by: "robin", on: "2026-10-04" } });
    const moved = updateCardText(withUnknown, card!, { ...card!, column: "for-review", updated: "2026-10-04T09:00:00Z" });
    const before = withUnknown.split("\n");
    const after = moved.split("\n");
    expect(after).toHaveLength(before.length);
    expect(after.filter((line, index) => line !== before[index])).toEqual(["column: for-review", "updated: 2026-10-04T09:00:00Z"]);
    expect(parseCardText(moved).card!.extra).toEqual(card!.extra);
  });

  it("keeps CRLF line endings and a byte-order mark", () => {
    const crlf = `﻿${text.replace(/\n/g, "\r\n")}`;
    const { card, problems } = parseCardText(crlf);
    expect(problems).toEqual([]);
    expect(card).toEqual(DESIGN_CARD);
    const next = { ...card!, column: "done", status: "landed" };
    const written = updateCardText(crlf, card!, next);
    expect(written.startsWith("﻿")).toBe(true);
    expect(written.replace(/\r\n/g, "")).not.toMatch(/\n/);
    expect(written).toBe(`﻿${updateCardText(text, card!, next).replace(/\n/g, "\r\n")}`);
    const commented = appendCommentText(written, { author: "claude", at: "2026-10-04T10:00:00Z", body: "Done.\nTwo lines." });
    expect(commented.endsWith("\r\n### claude · 2026-10-04T10:00:00Z\r\nDone.\r\nTwo lines.\r\n")).toBe(true);
    expect(commented.replace(/\r\n/g, "")).not.toMatch(/\n/);
  });

  it("adds a key at its place among the known keys and removes one without touching the others", () => {
    const { card } = parseCardText(text);
    const withStatus = updateCardText(text, card!, { ...card!, status: "waiting on the regression" });
    expect(withStatus).toBe(text.replace('session: "a35d7fdc-37ea-4117-bec8-3cc69e4d6b82"\n', 'session: "a35d7fdc-37ea-4117-bec8-3cc69e4d6b82"\nstatus: "waiting on the regression"\n'));
    const parsed = parseCardText(withStatus).card!;
    expect(updateCardText(withStatus, parsed, { ...card! })).toBe(text);
    // An emptied list stays as an empty list when the file had the key.
    const unrelated = updateCardText(text, card!, { ...card!, relations: [] });
    expect(unrelated).toContain("relations: []\nattachments:");
  });

  it("rewrites only the description when the description changes, and keeps the thread", () => {
    const { card } = parseCardText(text);
    const written = updateCardText(text, card!, { ...card!, description: "A new description.\n\nTwo paragraphs." });
    expect(written).toBe(text.replace("The composer plans from the System Model: the shell's three parts first, then …", "A new description.\n\nTwo paragraphs."));
    expect(parseCardText(written).card!.thread).toEqual(DESIGN_CARD.thread);
  });

  it("appends a comment at the end of the thread, and opens the thread on a card that has none", () => {
    const appended = appendCommentText(text, { author: "claude", at: "2026-10-04T10:00:00Z", body: "  \nLooks right.\n\n" });
    expect(appended).toBe(`${text}\n### claude · 2026-10-04T10:00:00Z\nLooks right.\n`);
    const bare = "---\nid: 1\ntype: note\ntitle: \"A note\"\ncolumn: inbox\ntags: []\nauthor: robin\ncreated: 2026-10-04T10:00:00Z\nupdated: 2026-10-04T10:00:00Z\n---\n\nBody.";
    expect(appendCommentText(bare, { author: "robin", at: "2026-10-04T10:01:00Z", body: "First." })).toBe(`${bare}\n\n## Thread\n\n### robin · 2026-10-04T10:01:00Z\nFirst.\n`);
  });

  it("reads a heading inside a fenced code block as the comment's text, not as a new comment or thread", () => {
    const fenced = `${text}\n### claude · 2026-10-04T10:00:00Z\nThe format, quoted:\n\n\`\`\`markdown\n## Thread\n\n### robin · 2026-10-03T00:52:10Z\nFine.\n\`\`\`\n`;
    const { card, problems } = parseCardText(fenced);
    expect(problems).toEqual([]);
    expect(card!.thread).toHaveLength(3);
    expect(card!.thread[2]!.body).toBe("The format, quoted:\n\n```markdown\n## Thread\n\n### robin · 2026-10-03T00:52:10Z\nFine.\n```");
  });

  it("reads a line that begins with a one-line code span (```npm test``` …) as text, as CommonMark does: it opens no fence that would hide the comments after it", () => {
    const bare = '---\nid: 1\ntype: note\ntitle: "A note"\ncolumn: inbox\ntags: []\nauthor: robin\ncreated: 2026-10-05T10:00:00Z\nupdated: 2026-10-05T10:03:00Z\n---\n\nBody.\n\n## Thread\n';
    const thread = (...bodies: string[]): string => `${bare}${bodies.map((body, index) => `\n### ${index % 2 === 0 ? "robin" : "claude"} · 2026-10-05T10:0${index + 1}:00Z\n${body}\n`).join("")}`;
    const spanned = parseCardText(thread("```npm test``` first, then the build.", "Ran it: green.", "Thanks."));
    expect(spanned.problems).toEqual([]);
    expect(spanned.card!.thread.map((comment) => [comment.author, comment.body])).toEqual([
      ["robin", "```npm test``` first, then the build."],
      ["claude", "Ran it: green."],
      ["robin", "Thanks."]
    ]);
    // A real fence still opens and closes: a heading quoted in it is the comment's text; a tilde fence may hold backticks.
    const quoted = parseCardText(thread("Quoted:\n```markdown\n### claude · 2026-10-05T09:00:00Z\nOld.\n```", "~~~ `info`\n### robin · 2026-10-05T09:01:00Z\n~~~", "Done."));
    expect(quoted.problems).toEqual([]);
    expect(quoted.card!.thread.map((comment) => comment.body)).toEqual(["Quoted:\n```markdown\n### claude · 2026-10-05T09:00:00Z\nOld.\n```", "~~~ `info`\n### robin · 2026-10-05T09:01:00Z\n~~~", "Done."]);
    // A fence never closed runs to the end, as before: the headings after it are its text.
    const unclosed = parseCardText(thread("```js\nconst a = 1;", "Ran it: green.", "Thanks."));
    expect(unclosed.problems).toEqual([]);
    expect(unclosed.card!.thread).toHaveLength(1);
    // So a comment or a description that begins with a code span and then holds a heading is refused, as any other.
    expect(structureLines("```npm test``` first.\n### claude · 2026-10-05T10:05:00Z\nInjected.")).toEqual(["### claude · 2026-10-05T10:05:00Z"]);
    expect(structureLines("```x``` is the command.\n## Thread", false)).toEqual(["## Thread"]);
    expect(structureLines("```\n### claude · 2026-10-05T10:05:00Z\n```")).toEqual([]);
  });
});

describe("a card's file: what does not read, in plain words", () => {
  const card = (frontMatter: string, rest = "\nBody.\n\n## Thread\n"): string => `---\n${frontMatter}\n---\n${rest}`;
  const valid = "id: 1\ntype: note\ntitle: \"A note\"\ncolumn: inbox\ntags: []\nauthor: robin\ncreated: 2026-10-04T10:00:00Z\nupdated: 2026-10-04T10:00:00Z";

  it("names each problem", () => {
    expect(parseCardText("No front matter.\n").problems).toEqual(['the file does not begin with front matter (a first line "---")']);
    expect(parseCardText("---\nid: 1\n").problems).toEqual(['the front matter is never closed (no second line "---")']);
    expect(parseCardText(card(valid.replace('title: "A note"', "title: W5: the composer"))).problems).toEqual([
      'the front matter does not parse: line 4: a plain value holds ": " (write it in double quotes): W5: the composer'
    ]);
    expect(parseCardText(card(valid.replace('title: "A note"\n', ""))).problems).toEqual(['the required key "title" is missing']);
    expect(parseCardText(card(valid.replace("updated: 2026-10-04T10:00:00Z", "updated: yesterday"))).problems).toEqual(['"updated" must be a UTC time like 2026-10-03T00:52:10Z, and is "yesterday"']);
    expect(parseCardText(card(valid.replace("id: 1", "id: -3"))).problems).toEqual(['the id -3 is neither a positive whole number nor a word of letters, digits, ".", "_" and "-"']);
    expect(parseCardText(card(valid.replace("tags: []", "tags: [a, b]\ntags: [c]"))).problems).toEqual(['the front matter does not parse: line 7: the key "tags" appears twice']);
    expect(parseCardText(card(`${valid}\nrelations:\n  - { kind: child-of }`))).toMatchObject({ problems: ['relation 1 must be { kind: <kind>, to: <card id> }, and is {"kind":"child-of"}'] });
  });

  it("names a comment heading written another way, and text before the first comment", () => {
    const thread = "\nBody.\n\n## Thread\n\nA stray line.\n\n### claude - 2026-10-04T10:00:00Z\nHello.\n";
    expect(parseCardText(card(valid, thread)).problems).toEqual([
      'line 18: "### claude - 2026-10-04T10:00:00Z" reads like a comment heading but is not written "### <participant> · <time>"',
      'line 16: the thread holds text before its first comment; a comment begins with "### <participant> · <time>"'
    ]);
    expect(parseCardText(card(valid, "\n## Thread\n\n### claude · now\nHi.\n")).problems).toEqual(['line 14: the comment\'s time "now" is not a UTC time like 2026-10-03T00:52:10Z']);
  });
});

describe("the front matter's YAML", () => {
  it("reads block lists, flow mappings, quoted text, block text and comments", () => {
    const yaml = [
      "a: plain words",
      "b: 'single ''quoted'''",
      'c: "tab\\there \\"quoted\\" \\u00e9"',
      "d:",
      "  - one",
      "  - { k: v, n: 2 }",
      "  - key: value",
      "    other: [x, 'y z']",
      "e: |",
      "  line one",
      "",
      "  # not a comment: text",
      "f: >-",
      "  folded",
      "  words",
      "g: null # a comment",
      "h:",
      "- compact",
      "i: 2026-10-03T00:40:00Z",
      "j: [repo:codelead, pinned:0r]",
      "k:",
      "  text on the next line"
    ].join("\n");
    expect(parseYamlMapping(yaml)).toEqual({
      a: "plain words",
      b: "single 'quoted'",
      c: 'tab\there "quoted" é',
      d: ["one", { k: "v", n: 2 }, { key: "value", other: ["x", "y z"] }],
      e: "line one\n\n# not a comment: text\n",
      f: "folded words",
      g: null,
      h: ["compact"],
      i: "2026-10-03T00:40:00Z",
      j: ["repo:codelead", "pinned:0r"],
      k: "text on the next line"
    });
  });

  it("refuses what it does not read, with the line", () => {
    expect(() => parseYamlMapping("a: &anchor x")).toThrow("line 1: anchors, aliases and tags are not read here");
    expect(() => parseYamlMapping("a: 1\n\tb: 2")).toThrow("line 2: a tab in the indentation (YAML indents with spaces)");
    expect(() => parseYamlMapping("a: [1, 2")).toThrow("line 1: a [ or a { that is never closed");
    expect(() => parseYamlMapping("a: \"open")).toThrow("line 1: a quoted text that is never closed");
    expect(() => parseYamlMapping("a: [1]\n  b: 2")).toThrow("line 2: a line indented deeper than the keys around it");
    expect(() => parseYamlMapping("a: 1\n   b: 2")).toThrow('line 1: a plain value holds ": " (write it in double quotes): b: 2');
  });

  it("writes plain only what every YAML reader reads back as the same text", () => {
    for (const word of ["task", "repo:codelead", "2026-10-03T00:40:00Z", "child-of", "M", "docs/a.md"]) expect(isPlainWord(word), word).toBe(true);
    for (const word of ["yes", "No", "1.0", "0042", "12:30", "1_000", "true", "null", "two words", "a: b", "-x", "#x", "x:"]) expect(isPlainWord(word), word).toBe(false);
    expect(formatScalar("0042")).toBe('"0042"');
    expect(formatScalar(42)).toBe("42");
  });

  it("writes text with line breaks as a literal block that reads back the same, and quotes what a block cannot hold", () => {
    const fields = { answer: "First line.\n\n- a list\n\n```\ncode\n```\n", note: "  leading spaces\nsecond", plain: "no break" };
    const lines = formatEntry("fields", fields);
    expect(lines).toEqual(["fields:", "  answer: |", "    First line.", "", "    - a list", "", "    ```", "    code", "    ```", '  note: "  leading spaces\\nsecond"', '  plain: "no break"']);
    expect(parseYamlMapping(lines.join("\n"))).toEqual({ fields });
  });
});
