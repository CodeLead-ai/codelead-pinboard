# @codelead/pinboard

Pinboard is the board between a person and their coding agents. The cards, their threads and
an event log are plain files in the repository, so a person, a page and any agent read and
write the same thing. Every write goes through one core, which refuses what the board's rules
refuse, in words, and writes nothing then.

It never calls a model and never runs code.

The package holds:

- **the core** (`src/core`): the files of a board and every rule about them;
- **the command line** (`src/cli`): the `pinboard` bin, and the same command tree as a factory
  a host adds to its own program (CodeLead adds it as `codelead board`);
- **the page's process** (`src/server`): the board's page and its HTTP API on 127.0.0.1;
- **the page** (`src/page`): a React app built with Vite;
- **the import** (`src/import`): a project's `PINNED.md`, `DECISIONS-PENDING.md` and its plan's
  status table turned into cards, once.

Node 22 or later. It depends on `commander` alone at run time.

## The files

A board is a folder, `docs/codelead/board` in the repository by default:

| File | What it is |
| --- | --- |
| `board.json` | The board: its columns, card types, tag namespaces, participants, what an agent may do, the check interval, the next id. `schema` is `codelead.board/1`. |
| `AGENTS.md` | The conventions, for an agent that has never seen the board. `init` writes it from `board.json` (`agentsGuide` in `src/core/agents.ts` is the template). |
| `items/<nnnn>-<slug>.md` | One card a file. |
| `events.jsonl` | One JSON object a line, appended, never edited. |
| `cursors/<participant>.json` | What a participant has seen. Per machine; git ignores it. |
| `imports/` | Optional: the printed mapping of an import, kept for the record. The import itself marks each document it read in `board.json` (`imports`), so that it runs once. |
| `.gitignore` | Keeps `cursors/`, the lock, `private-names.txt` and temporary files out of git. |
| `private-names.txt` | Optional. Names the board must never hold, one a line. Git ignores it. |

### `board.json`

```json
{
  "schema": "codelead.board/1",
  "name": "my-workspace",
  "columns": [
    { "id": "inbox", "name": "Inbox" },
    { "id": "backlog", "name": "Backlog" },
    { "id": "ideas", "name": "Ideas" },
    { "id": "pinned", "name": "Pinned", "owner": "person" },
    { "id": "in-progress", "name": "In progress" },
    { "id": "for-review", "name": "For review" },
    { "id": "done", "name": "Done", "owner": "person" }
  ],
  "types": ["question", "decision", "task", "idea", "review", "note"],
  "tagNamespaces": ["repo", "area", "by"],
  "participants": [
    { "id": "robin", "kind": "person", "name": "Robin" },
    { "id": "claude", "kind": "agent", "name": "Claude Code" }
  ],
  "agents": { "mayMoveTo": ["inbox", "backlog", "ideas", "in-progress", "for-review"], "mayCreate": true },
  "check": { "intervalMinutes": 30 },
  "nextId": 1
}
```

- A column with `"owner": "person"` is the person's: no agent moves a card into it.
- The participants are the whole account system. A second person is one more line.
- Unknown keys are kept as they were read.

### A card

```markdown
---
id: 42
type: task
title: "The composer reads the plan"
column: backlog
tags: [w5, repo:my-repo]
author: claude
created: 2026-10-03T00:40:00Z
updated: 2026-10-03T00:52:10Z
relations:
  - { kind: child-of, to: 7 }
attachments:
  - { path: "docs/design.md", lines: "198-276" }
fields:
  size: M
---

The description, in markdown.

## Thread

### claude · 2026-10-03T00:40:00Z
A comment, in markdown.

### robin · 2026-10-03T00:52:10Z
Fine. After packages 4 and 5.
```

- The front matter is YAML. Required: `id`, `type`, `title`, `column`, `author`, `created`,
  `updated`. Also read: `tags`, `color`, `relations`, `attachments`, `fields`, `session`,
  `status`, `archived`. Unknown keys, comments and blank lines are kept; a change rewrites only
  the lines it changes.
- The text before `## Thread` is the description. Each comment is a heading
  `### <participant> · <UTC time>` and its markdown. Comments are appended, never rewritten.
- The file name starts with the id, zero-padded, then a slug. The id is the key.
- `fields` holds the type's own fields: a decision's `ask`, `options`, `recommendation`,
  `decided`, `consequences`; a task's `definitionOfDone`, `size`, `landed`; and so on
  (`TYPE_FIELDS` in `src/core/types.ts`).
- A path a card cites is a path in the repository, or `<repository>:<path>` for another
  repository of the workspace (the repository's parent folder, or `workspace` in `board.json`).

### `events.jsonl`

```json
{"at":"2026-10-03T00:52:10Z","by":"robin","item":42,"kind":"comment.added","data":{"excerpt":"Fine. After packages 4 and 5."}}
{"at":"2026-10-03T00:52:10Z","by":"robin","item":42,"kind":"item.moved","data":{"from":"inbox","to":"backlog"}}
```

Kinds: `item.created`, `item.updated`, `item.moved`, `item.archived`, `comment.added`,
`relation.added`, `relation.removed`, `tag.added`, `tag.removed`, `attachment.added`.

The card is the truth; the line is what a check reports. A card file that changed with no event
(a hand edit, an agent that forgot) gets an event by `unknown` at the next check, or from the
page's process once the file has been quiet.

### `cursors/<participant>.json`

```json
{ "seen": "2026-10-03T00:52:10Z", "opened": { "42": "2026-10-03T00:52:10Z" } }
```

What the participant has seen. For an agent it is also its check cursor.

### What is never written into a card

A write is refused when its text holds:

- **a secret**: a key, a connection-string password, a bearer token;
- **a path of this machine** outside the workspace (under the home folder);
- **a private name**, listed in `private-names.txt`.

A path under the repository or the workspace is not refused: it is rewritten as the card cites
it, and the write's event lists each rewrite. `--rewrite-paths` writes a home-folder path as
`<home>/…` instead of refusing it.

## The commands

Run `pinboard` in any repository that has a board folder, or give `--board <dir>`. A host
gives the same commands under its own name (`codelead board …`).

| Command | What it does |
| --- | --- |
| `init` | Creates the board folder: `board.json`, `AGENTS.md`, `items/`, `events.jsonl`, `cursors/`. |
| `check --as <you>` | What changed since your cursor: what is addressed to you first, then the decisions, then the rest. `--ack` moves the cursor to the end; `--since <time>` looks from a time. |
| `list` | The cards by column. `--column`, `--tag`, `--type`, `--repo`, `--archived`. |
| `show <id>` | One card: fields, relations both ways, attachments, description, thread. |
| `new --as <you>` | Creates a card (`--type`, `--title`, `--body`, `--field`, …), or every card of a markdown file (`--batch`), all or none. `--dry-run` writes nothing. |
| `reply <id> --as <you>` | Appends a comment (`--text` or `--file`). |
| `move <id> --to <column> --as <you>` | Moves a card; an agent only into `agents.mayMoveTo`. |
| `set <id> --as <you>` | Changes tags, relations, the status line, the colour, the fields. |
| `validate` | Checks every file of the board. |
| `import --from <folder>` | Turns `PINNED.md`, `DECISIONS-PENDING.md` and the plan's status table into cards, once. |
| `tidy --imported` | After the import: strips the bold repetition of the title from imported cards. |
| `serve` | Serves the page on 127.0.0.1 (port 7414, or a free one). `--open` opens it. |

Every command takes `--board <dir>` and `--json`.

Exit codes: **0** done; **1** a rule refused the write (or `validate` found problems);
**2** the command cannot run (no board, no such card, a missing or wrong argument).

`pinboard --help` and `pinboard <command> --help` give every option.

## How a host embeds it

The package's entries:

| Import | What it gives |
| --- | --- |
| `@codelead/pinboard` | The core, and `createBoardCommand`. |
| `@codelead/pinboard/core` | The core alone. |
| `@codelead/pinboard/cli` | The command tree: `createBoardCommand` and each `runBoard…` function. |
| `@codelead/pinboard/server` | The page's process: `createBoardServer`, `pageLocation`, `buildPage`. |
| `@codelead/pinboard/import` | `importDocuments`, `tidyImported`. |

Add the command tree to a host's program:

```ts
import { createBoardCommand } from "@codelead/pinboard/cli";

program.addCommand(
  createBoardCommand({
    // Optional: the command's name ("board" when not given).
    name: "board",
    // Optional: where the commands' words go; the console when not given.
    log: { say: (line) => console.log(line), warn: (line) => console.warn(line) },
    // Optional: the host's own sanitizer for the guard; the board's own when not given.
    sanitizer: (paths) => new MySanitizer(paths)
  })
);
```

The host's injection points:

- **`sanitizer`**: a function from `{ root, home }` to an object with `text(text)`. It must write
  a secret as `<redacted>`, the repository's paths as `<repo>`, and the home folder's as
  `<home>`: the guard refuses a text the sanitizer would change. The same option is taken by
  `boardContext({ … })` (every write of the core), `createBoardServer({ … })` and each
  `runBoard…` function's dependencies. Without it, the board's own (`BoardSanitizer`,
  `src/core/sanitize.ts`) is used.
- **`log`**: `say(line)` for a command's words, `warn(line)` for what goes wrong outside them.
- **`name`**: the command's name.

A host that writes cards itself uses the core directly:

```ts
import { boardContext, createCard } from "@codelead/pinboard";

const ctx = boardContext({ dir: "docs/codelead/board", sanitizer: mySanitizer });
createCard(ctx, "claude", { type: "task", title: "Write the tests" });
```

A refusal is thrown as a `BoardRefusal` (`isBoardRefusal(error)`), with a `code` and the
refusal's words.

## The page

The page's sources are in `src/page` (React, Vite). The package ships its build in `dist/page`:

- `npm run build` builds the code and the page; `npm install` in this folder runs it.
- `npm run build:page` builds the page alone.
- `serve` builds the page first when its build is missing or older than its sources, when Vite
  is installed (a checkout of this package). An installed copy serves the build it ships.
- `npx vite src/page` serves the sources for work on the page, with the API proxied to a
  `serve` on port 7414.

The page loads nothing from elsewhere but its fonts (Google Fonts). Its Content-Security-Policy
allows its own scripts only.

## Working on the package

```sh
npm install          # also builds dist/ (prepare)
npm run typecheck    # the Node side with its tests, then the page
npm test             # every test; the browser tests need Playwright's Chromium
npm run build
```

The browser tests (`*.browser.test.ts`) build the page into a folder of their own and drive it
with Playwright's Chromium. They are skipped when Chromium cannot start
(`npx playwright install chromium` installs it).

## Licence

See `LICENSE`.
