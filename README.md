# @codelead/pinboard

Pinboard is the board between a person and their coding agents. The cards, their threads and
an event log are plain files in the repository, so a person, a page and any agent read and
write the same thing. Every write goes through one core, which refuses what the board's rules
refuse, in words, and writes nothing then.

It never calls a model and never runs code.

You work on the page; the agent runs the commands; the files are the truth. "Using the board"
below shows the day; the rest of this file is the reference.

The package holds:

- **the core** (`src/core`): the files of a board and every rule about them;
- **the command line** (`src/cli`): the `pinboard` bin, and the same command tree as a factory
  a host adds to its own program (CodeLead adds it as `codelead board`);
- **the page's process** (`src/server`): the board's page and its HTTP API on 127.0.0.1;
- **the page** (`src/page`): a React app built with Vite;
- **the import** (`src/import`): a project's `PINNED.md`, `DECISIONS-PENDING.md` and its plan's
  status table turned into cards, once.

Node 22 or later. It depends on `commander` alone at run time.

## Installing

Two ways, both run as written on 2026-11-03 against the public repository:

- **In one project**, as a dependency; the commands are then `npx pinboard …` in that repository:

  ```sh
  npm install github:CodeLead-ai/codelead-pinboard
  npx pinboard init
  ```

- **On the machine**, for every repository; the commands are then `pinboard …` anywhere:

  ```sh
  git clone https://github.com/CodeLead-ai/codelead-pinboard.git
  cd codelead-pinboard
  npm install          # builds dist/
  npm install -g .
  ```

  (`npm install -g github:CodeLead-ai/codelead-pinboard` does not work yet: npm builds the package
  at install time without its build tools. The clone has them.)

The package is not on the npm registry.

## Using the board

The board is meant to take work off your hands, not to add a command line to your day. In
practice three parties touch it, each in its own way:

- **You** work on **the page** in your browser: write cards, read threads, answer, drag,
  decide. You type two commands in the life of a board (create it, start the page) and never
  another one.
- **The agent** runs **the commands** itself. `AGENTS.md` in the board folder teaches it; you see
  what it did on the page.
- **The command line** stays for whoever prefers it, and for the few things the page does not
  do (several cards from a file, an import, `validate`).

Everything below was run as written, on an empty repository called `my-app`, with one person
(`robin`) and one agent (`claude`). The outputs are the commands' own.

### Setting up, once

**1. Create the board.** One command in the repository, or ask the agent to do it ("set up a
Pinboard in this repository with `pinboard init`, then read `docs/codelead/board/AGENTS.md`"):

```sh
cd my-app
pinboard init --person robin:Robin
```

```
Board created in docs/codelead/board: board.json, AGENTS.md, events.jsonl, .gitignore, items/, cursors/.
Participants: robin (person), claude (agent). Agents read docs/codelead/board/AGENTS.md.

Tell the agent, once, in the file it reads at the start of every session (CLAUDE.md, a root AGENTS.md or the like):
  This repository has a Pinboard in docs/codelead/board. Read docs/codelead/board/AGENTS.md once per session, take part as `claude`, and run `pinboard check --as claude` at the start of the session and whenever asked; check again every 30 minutes while the session runs where you have a timer (Claude Code: `/loop 30m pinboard check --as claude`).
Before that file says it, the first session starts with one sentence to the agent: "Read docs/codelead/board/AGENTS.md and check the board as claude."
```

Without `--person`, the person is this machine's user; without `--agent`, the agent is
`claude` ("Claude Code"). `--agent codex:Codex` adds a second agent, a second `--person` a
second person. All of it can be changed later in `board.json`.

**2. Tell the agent the board exists.** `init` printed the paragraph. Put it in the file your
agent reads at the start of every session (`CLAUDE.md`, a root `AGENTS.md`, or the like):

```
This repository has a Pinboard in docs/codelead/board. Read docs/codelead/board/AGENTS.md
once per session, take part as `claude`, and run `pinboard check --as claude` at the start
of the session and whenever asked; check again every 30 minutes while the session runs
where you have a timer (Claude Code: `/loop 30m pinboard check --as claude`).
```

From then on every session starts the cycle by itself. There is no prompt to type.

**The first thing you say to the agent.** Before that file says it, the first session needs
one sentence from you. `init` printed it too:

```
Read docs/codelead/board/AGENTS.md and check the board as claude.
```

**About "every 30 minutes".** An agent has no clock of its own: it checks when a session
starts and when you ask. For a check while the session runs, start the timer the agent
offers: in Claude Code, `/loop 30m pinboard check --as claude`, which ends with the session;
Codex and others have their own, or none. The interval is `check.intervalMinutes` in
`board.json`.

`docs/codelead/board/AGENTS.md` holds the rest: the columns, what an agent may do, how to
check, reply, propose and record work. It was written for an agent that has never seen a board.

**3. Start the page.** The last command you type:

```sh
pinboard serve --open
```

It prints the page's address (`http://127.0.0.1:7414/`, or another port when that one is
taken) and, with `--open`, opens it in your browser. Leave it running in a terminal tab for as
long as you like, days included: it picks up what the agent and the editor write to the files.
If it stops, the same command brings it back. A host program gives it under its own name
(CodeLead: `codelead board serve --open`).

**4. Commit the board folder**, or let the agent do it: the cards, the log and `AGENTS.md`
travel with the repository; the cursors and the lock do not (`docs/codelead/board/.gitignore`
keeps them out).

```sh
git add docs/codelead/board
git commit -m "board: init"
```

### How to use it

Pinboard does not replace anything you use today. You still work in VS Code (or your editor)
and with Claude Code, Codex or another coding agent as usual; the board is a tool beside them
that makes a large or complex project, with one or several agents on it, easier to manage:
what is asked, what is being done, what waits on whom, all in one place, in files the agents
read and write too.

**Open the page.** After `pinboard serve`, the terminal prints the address:

```
Pinboard: http://127.0.0.1:7414/
The board in docs/codelead/board, as Robin. The page writes the board's files through the same rules as these commands; Ctrl+C stops it.
```

Open that address in your browser (`pinboard serve --open` opens it for you). The page is
served to this machine only. Leave the terminal running; if it stops, run the command again.

**On the page:**

- **Write a card:** a title, a type (task, question, decision, idea, review, note), a
  description in markdown. It lands in Inbox. That is how you ask an agent for something, or
  note something for later.
- **Read and answer:** open a card, read its thread, write a comment; type `@` to address
  someone (`@claude`): their next check lists that card first.
- **Move cards** by dragging. **Pinned** and **Done** are yours alone: no agent moves a card
  into them.
- **Decide:** a decision card shows the ask on its face; your answer goes in its `decided`
  field, and the agent's next check lists it under "Decided".
- **Tags, relations, attachments, a colour mark** on each card; search by words or `#42`;
  "what changed since you last looked"; keyboard shortcuts under `?`; "open in the editor".
- **The editor works too.** A card is a markdown file in `items/`; a file changed by hand is
  noticed at the next check.

**With the agent, as usual:** ask for the work in its session ("do card 1"); the card and its
thread are its context. The board does not start work by itself and never calls a model.

### What happens behind the scenes

Nothing below is typed by you. The agent does it by itself, because the paragraph you added in
step 2 and `AGENTS.md` tell it to; you see the result on the page.

- **It checks the board** at the start of each session, whenever you ask, and every 30 minutes
  while a session runs when you started its timer (step 2; `check.intervalMinutes` in
  `board.json`), and acts on what is new:

  ```
  $ pinboard check --as claude
  claude: 1 new on 1 card since the board began (no cursor yet).

  #1 Add a sign-in page  (task · Inbox)
    robin · 2026-11-02T19:30:05Z  created it (task in Inbox)

  Run again with --ack once these are dealt with. Next check in 30 minutes.
  ```

- **It answers** what is addressed to it, in the card's thread, and asks you back with
  `@robin` when it needs you.
- **It proposes:** a finding, an idea, a question for you becomes a card in Inbox, tagged
  `by:claude`. A decision card carries its recommendation in its ask; only you set `decided`.
- **It records its work:** when you ask for a card in the session, it moves the card to In
  progress; when the work lands, it writes what landed and hands the card over in one step:

  ```
  $ pinboard move 1 --to for-review --as claude --comment "Landed: 4f2a9c1 on main; src/pages/sign-in.ts, test/sign-in.test.ts (6 tests)."
  Moved #1 from In progress to For review, with the comment.
  ```

- **It is held to the rules.** The same guard runs under the page, the commands and a host's
  code; a refusal writes nothing and says why:

  ```
  $ pinboard move 1 --to pinned --as claude
  Refused: claude is an agent and may not move a card into Pinned (a person's column); an agent
  may move a card into Inbox, Backlog, Ideas, In progress, For review. Nothing was written.

  $ pinboard reply 2 --as claude --text "Server=db;Password=s3cretpassw0rd;"
  Refused: the comment looks like it holds a secret (a key, a connection-string password or a
  bearer token); nothing was written. Leave the secret out and say where it is kept instead.

  $ pinboard reply 2 --as claude --text "The log is in /Users/robin/notes/log.txt"
  Refused: the comment holds a path of this machine outside the workspace (under the home
  folder); nothing was written. Cite the file by its path in a repository of the workspace
  instead, or give --rewrite-paths to write it as <home>/….
  ```

  Names the board must never hold go in `docs/codelead/board/private-names.txt`, one a line,
  on each machine (git ignores it).

### Every day after

- **Open the page** (it is still running). The "@you" marks and "what changed since you last
  looked" show what needs you.
- **Answer in the threads, drag to Done, decide** on the decision cards, pin what matters.
- **Ask for work in the session** by card number; the agent reads the card and its thread.
- **Commit the board** with the rest of your work, or let the agent do it with its landings.
- **A new machine:** clone, `pinboard serve --open`. The cursors do not travel, so the agent's
  first check there starts from the beginning of the log; it looks from a day instead
  (`pinboard check --as claude --since 2026-11-02`), then acks.

### The command line, for whoever prefers it

Every action of the page is a command, and three things are commands only.

**A card, a comment, a move, a decision:**

```sh
pinboard new --as robin --type task --title "Add a sign-in page" \
  --body "Users need to sign in before they see the dashboard. See src/app.ts." --tag area:auth
pinboard reply 1 --as robin --text "Email and password. Magic links later."
pinboard move 1 --to done --as robin
pinboard set 2 --as robin --field decided="Cookie, revisit when we go multi-instance."
pinboard check --as robin          # what changed since your cursor; --ack moves it to the end
```

```
Created #1 (task) in Inbox: Add a sign-in page
docs/codelead/board/items/0001-add-a-sign-in-page.md
```

**Several cards at once**, from one markdown file (a conversation turned into cards, a plan's
items). Each card is a heading, a YAML block and its description; a card relates to another of
the file by its `key` (`"@ratelimit"`) and to a card on the board by its id:

````markdown
## Rate-limit the sign-in form

```yaml
key: ratelimit
type: task
column: backlog
tags: [area:auth]
relations:
  - { kind: related, to: 1 }
```

Five failed attempts in a minute lock the form for ten minutes. Came out of the sign-in work (#1).

## Should sessions survive a restart?

```yaml
key: survive
type: question
relations:
  - { kind: related, to: "@ratelimit" }
  - { kind: related, to: 2 }
```

With a cookie session they do; with Redis they do if Redis persists. Decide before the store is chosen.
````

```sh
pinboard new --as claude --batch cards.md --dry-run   # prints the cards with the ids they would get
pinboard new --as claude --batch cards.md
```

```
Created 2 cards from cards.md:
  #3 (task) in Backlog: Rate-limit the sign-in form  [area:auth, by:claude]
      related #1
  #4 (question) in Inbox: Should sessions survive a restart?  [by:claude]
      related #3, related #2
```

All of them are created, or none.

**Now and then:**

```sh
pinboard list                  # the cards by column; --column, --tag, --type, --repo
pinboard validate              # every file of the board
```

```
The board is valid: 4 cards, 17 events, 2 cursors.
```

**A project with existing notes:** `pinboard import --from docs --dry-run` prints how a
`PINNED.md`, a `DECISIONS-PENDING.md` and a plan's status table would become cards; without
`--dry-run` it creates them, once, and `tidy --imported` cleans their titles.

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

- **a secret**: a key, a connection-string password (`Password=…`, or inside an address,
  `scheme://user:password@host`), a bearer token;
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

The words of a refusal, of `AGENTS.md` and of the page still name the command as CodeLead
gives it (`codelead board init`, `codelead board validate`): the package was extracted from
CodeLead without changing a word, so a host's board reads as before. Under the bin, read them
as `pinboard init`, `pinboard validate`.

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

MIT (`LICENSE`). Use it, change it, ship it with your own work; keep the copyright notice.
