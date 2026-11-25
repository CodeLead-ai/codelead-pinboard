# @codelead/pinboard

Pinboard is the board between a person and their coding agents. The cards, their threads and
an event log are plain files in the repository, so a person, a page and any agent read and
write the same thing. Every write goes through one core, which refuses what the board's rules
refuse, in words, and writes nothing then.

It never calls a model and never runs code.

![The board: seven columns, cards with their type, tags and the last line of their thread; a decision card shows its ask and the answer on its face.](docs/screenshots/board.png)

*A demo board (made-up cards), one person and one agent. The screenshots in this file are from
it.*

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

Choose **Send to CodeLead** on a card to add `for:codelead` without moving it; **Take back from CodeLead** removes the tag.
The blue **CodeLead** badge follows the card through its columns, and the **For CodeLead** filter finds tagged cards across the board.
The queue is yours to fill: the commands refuse an agent that adds the tag (CodeLead itself may).

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
- **Read and answer:** open a card, read its thread, write a comment (seen rendered as you
  write, alone or side by side, like the description); type `@` to address someone
  (`@claude`): their next check lists that card first.
- **Move cards** by dragging. **Pinned**, **Ready** and **Done** are yours alone: no agent moves a
  card into them. An agent moves one out of Pinned or Done only when you asked for that card in
  its session (to start the work, or to reopen it): a convention of `AGENTS.md`, since no command
  can tell. Out of Ready no agent moves a card: the board gives an agent its card (below).
- **Decide:** a decision card shows the ask on its face; your answer goes in its `decided`
  field, and the agent's next check lists it under "Decided".
- **Tags, relations, attachments, a colour mark** (yours: no agent sets it) on each card;
  search by words or `#42`; "what changed since you last looked"; keyboard shortcuts under `?`;
  "open in the editor".
- **The editor works too.** A card is a markdown file in `items/`; a file changed by hand is
  noticed at the next check.

**With the agent, as usual:** ask for the work in its session ("do card 1"); the card and its
thread are its context. The board does not start work by itself and never calls a model. To let
an agent pick a card up without you in the session, put the card in **Ready** (next section).

![A task card open on the page: description, the task's fields with what landed, related cards, and the thread with the agent's questions, the person's answers and the landing.](docs/screenshots/card.png)

*A task after the work: the thread holds the agent's questions, the answers and what landed;
"What landed" was filled by the landing comment.*

### Handing a card to an agent: Ready

There are two ways to give an agent a card:

- **In the session:** "do card 3". The agent works while you are there.
- **Ready:** drag the card to the **Ready** column. That is the ask: an agent may pick the card up
  by itself, without you in the session. The agent does not choose it: it asks the board for its
  next card, and the board gives it one. The board itself starts nothing.

A card goes to Ready only when it can be worked alone. It must say three things, in its fields:

| Field | What it says | Example |
| --- | --- | --- |
| `definitionOfDone` | How anyone can tell it is done: a sentence, a command, a test. | `npm test passes` |
| `mayTouch` | What the work may touch: a repository, a folder, or files. At least one. | `src/auth/` |
| `limitMinutes`, `limitMoney` | A limit in minutes, in money, or both. A number each. | `30` |

To say which agent a Ready card is for, tag it `for:<agent>` (`for:codex`). A card with no such tag
is for any agent.

**On the page:** drag the card to Ready (or use the move menu, or the bar of picked cards). When
something is missing, the card goes back, its panel opens beside the board, and the words say
what is missing. The three things are there to fill in; **Save and move to Ready** saves them and
moves the card. Once they are set, the card's panel shows them.

**With the commands**, the same card, an agent's proposal from earlier:

```
$ pinboard move 3 --to ready --as robin
Card #3 cannot go to Ready yet: it does not say how to tell it is done (definitionOfDone), it does not name the repository, folder or files it may touch (mayTouch), and it names no limit in minutes or money (limitMinutes, limitMoney). Nothing was written: set what is missing, then move it again.

$ pinboard set 3 --as robin --field definitionOfDone="Five failed sign-ins in a minute lock the form for ten minutes; npm test passes." --field mayTouch='["src/auth/", "test/auth.test.ts"]' --field limitMinutes=30
#3: changed its fields.

$ pinboard move 3 --to ready --as robin
Moved #3 from Backlog to Ready.
```

The card's file now says:

```yaml
fields:
  definitionOfDone: "Five failed sign-ins in a minute lock the form for ten minutes; npm test passes."
  mayTouch: [src/auth/, test/auth.test.ts]
  limitMinutes: 30
```

The rules, which the commands enforce for every agent:

- **Only you move a card into Ready, or out of it.** An agent's move there is refused, as for
  Pinned and Done; so is its move out of it, into In progress too.
- **An agent gets a card from Ready only from the board** (`take`, below). A card tagged for
  another agent is never given to it.
- **While a card is in Ready, its three things are your ask.** An agent may not change them, and
  no change may take one away. Nor may an agent add or remove a `for:` tag there.
- **You can move a card out of Ready** at any time, anywhere, with no check.

```
$ pinboard move 3 --to ready --as claude
Refused: claude is an agent and may not move a card into Ready (a person's column); an agent may move a card into Inbox, Backlog, Ideas, In progress, For review. Nothing was written.

$ pinboard move 3 --to in-progress --as claude
Refused: claude is an agent and does not move a card out of Ready (#3 into In progress): an agent asks the board for its card with `codelead board take --as claude`, which gives it the next card it may work, held for it in In progress. Nothing was written.
```

With `--json`, the refusal of the check carries its parts: `"refused": "ready"`, the `card`, and
`missing`, one entry per thing (`what`, `fields`, `words`).

**A board made before Ready** works as before, without the column. One command gives it the
column, and says what it did; it moves no card:

```
$ pinboard add-ready
Added the column Ready to board.json, between Pinned and In progress. It is yours: put a card there that an agent may pick up by itself, once the card says how to tell it is done, what it may touch and its limit.
AGENTS.md is written again, with the Ready rules.
No card was moved.
```

When `AGENTS.md` was changed by hand, it is left as it is, and the command prints the lines to add.
Until the column is there, the page's move menus say what to run. A board made earlier may also
have the old column "Queued for CodeLead" (`queued`): it stays as it is, and **Send to CodeLead**
(the tag `for:codelead`) still hands a card to CodeLead.

On such a board, `take` answers that there is no Ready column, and how to add it.

#### How an agent gets its card: take

Agents do not race for a card and do not choose one. One place decides which agent gets which
Ready card: the board, one agent at a time, under its lock. The agent asks; the board answers with
one card, or with none and why.

**One real run.** The agent asks for its card:

```
$ pinboard take --as claude
Took #3 (task): Rate-limit the sign-in form
claude holds it until 2026-11-20T09:30:00Z (30 minutes): renew it while you work (`pinboard renew 3 --as claude`), and hand it to For review when it is done.
Done when: Five failed sign-ins in a minute lock the form for ten minutes; npm test passes.
May touch: src/auth/, test/auth.test.ts
Limit: 30 minutes
docs/codelead/board/items/0003-rate-limit-the-sign-in-form.md
```

The card is now in In progress, and its file says who holds it, and until when:

```yaml
claim:
  by: claude
  since: 2026-11-20T09:00:00Z
  until: 2026-11-20T09:30:00Z
```

That is a **claim**: a lease, not a flag. While it works, the agent renews it; asked for another
card, the board says why not:

```
$ pinboard renew 3 --as claude
#3: claude holds it until 2026-11-20T09:40:00Z (30 minutes).

$ pinboard take --as claude
Nothing for claude: it holds #3 (until 2026-11-20T09:40:00Z) already, and an agent holds at most 1 card at a time on this board (dispatch.perAgent in board.json). Hand it to For review, or give it back, then ask again.
```

When the work is done, it hands the card to For review, as for any work. The claim ends there:

```
$ pinboard move 3 --to for-review --as claude --comment "Landed: 9b1e7d2 on main; src/auth/limit.ts, test/auth.test.ts (4 tests)."
Moved #3 from In progress to For review, with the comment.
```

**If it cannot finish**, it gives the card back instead, with the reason. The reason lands in the
card's thread, and the card returns to Ready:

```
$ pinboard release 3 --as claude --reason "The tests need a database this machine does not have."
Gave #3 back to Ready, with the reason in its thread.
```

**If it stops answering** (its session ended, the machine slept), the claim runs out at its time.
The next take, by any agent, first puts the card back at the top of Ready, with an event that says
whose claim ran out and when (`ended the claim of claude, which ran out at …: back to Ready`); then
it gives cards as usual. No card stays stuck. Until then, `validate` notes the claim.

**Which card.** Among the Ready cards the agent may work: first those tagged `for:<that agent>`,
then those with no `for:` tag; in each group, the order of the column on the page, top first. To
give a card to one agent, tag it `for:<agent>`; the agent cannot name the card it wants.

**What keeps a card back**, each said in the answer, and on the card's tile in one short line:

- **it waits on another card:** a relation `blocked-by` to a card that is not in Done
  (`waits on #12`);
- **its files are in use:** a card held now names an overlapping place in `mayTouch`: the same
  path, one inside the other, or the whole repository (`its files are in use by #7`). Write
  `mayTouch` as paths: `src/auth/`, `test/auth.test.ts`, `api:src/` for another repository, or a
  repository's name for all of it. Anything else (a sentence) counts as the whole repository;
- **the agent holds its limit:** at most `dispatch.perAgent` cards at a time (1 when not set);
- **it no longer says what Ready asks** (a hand edit removed a field): it is skipped and named,
  for you to fix.

**While a card is held**, the agent that holds it renews it, gives it back, or hands it to For
review. No other agent moves it or changes its three fields (it may comment); no agent adds or
removes its `for:` tags. Your moves always win: a held card you move out of In progress, or
archive, loses its claim at that move.

**On the page**, a held card says who holds it and for how long (`held by Claude Code · 24 min
left`; once its time has passed, `the claim of Claude Code ran out`), and its thread shows each
step of the claim in plain words.

**The settings**, in `board.json`, each optional:

```json
"dispatch": { "perAgent": 1, "leaseMinutes": 30, "maxLeaseMinutes": 240 }
```

`--lease <minutes>` on `take` or `renew` asks for another length, up to `maxLeaseMinutes`.

### Scheduled cards

A **schedule** is your standing ask. At its time it puts a card in **Ready**, and the board gives
that card to an agent like any other Ready card. The schedule belongs to the board, not to an
agent: whichever agent asks the board for its card gets the scheduled ones too. Every run leaves a
card with its record, so nothing runs unseen. The board still starts no agent.

- **Only you** make, change, pause or remove a schedule. The commands refuse an agent.
- **Its card must pass the Ready check** when you make the schedule: how to tell it is done, what it
  may touch, its limit. If it does not, the schedule is refused, in the check's own words.
- **When it is due**, one of three rules:
  - every N minutes, hours or days from a start time: `--every 30m`, `--every 2h`, `--every 1d`,
    with `--from "2026-11-23 09:00"` (now when not given);
  - every day at a time: `--daily --at 07:30`;
  - on days of the week at a time: `--weekly mon,thu --at 09:00`.
- **Times are this machine's local time.** The schedule writes its time zone down when you make it
  (`"zone": "Europe/Berlin"`), and reads its times in that zone from then on (`--zone` names
  another). Every time is shown in that zone and in UTC.
- **This is the one way a card enters Ready without your move at that moment.** It is allowed
  because you made the schedule: the card is your ask. You are its author, it is tagged
  `scheduled:<name>`, and its file says which schedule made it.

**One real run.** Every Monday at 09:00: check the dependencies. You make the schedule once:

```
$ pinboard schedules add check-deps --as robin --weekly mon --at 09:00 --title "Check the dependencies" --body 'Run `npm outdated`; update what is safe.' --field definitionOfDone="npm outdated lists nothing that is safe to update; npm test passes." --field mayTouch='["package.json", "package-lock.json"]' --field limitMinutes=30
Made the schedule check-deps: every Monday at 09:00 (Europe/Berlin).
Its first card is due Mon 2026-11-23 09:00 Europe/Berlin (2026-11-23 08:00 UTC), in Ready.
docs/codelead/board/schedules/check-deps.json
```

The list says what each schedule does and when it is due next:

```
$ pinboard schedules
1 schedule, each time in its zone and in UTC:

check-deps: every Monday at 09:00 (Europe/Berlin), made by robin on 2026-11-20 09:00 UTC
  next: Mon 2026-11-23 09:00 Europe/Berlin (2026-11-23 08:00 UTC)
  last card: none yet
```

On Monday at 09:00 the page's process makes the card by itself, if it is running. The command
does the same, once:

```
$ pinboard schedules run
The schedule check-deps put #1 in Ready: Check the dependencies (due Mon 2026-11-23 09:00 Europe/Berlin, 2026-11-23 08:00 UTC).
docs/codelead/board/items/0001-check-the-dependencies.md
```

The card is in Ready, written by you, tagged `scheduled:check-deps`. Its file says which schedule
made it, and the time it was due:

```yaml
schedule:
  name: check-deps
  by: robin
  due: 2026-11-23T08:00:00Z
```

An agent asks the board for its card, and gets it as any other:

```
$ pinboard take --as claude
Took #1 (task): Check the dependencies
claude holds it until 2026-11-23T08:35:00Z (30 minutes): renew it while you work (`pinboard renew 1 --as claude`), and hand it to For review when it is done.
Done when: npm outdated lists nothing that is safe to update; npm test passes.
May touch: package.json, package-lock.json
Limit: 30 minutes
docs/codelead/board/items/0001-check-the-dependencies.md
```

**Never several cards for one schedule.**

- **While its last card is still open** (in Ready or In progress), the schedule makes no new one.
  It says why, once for each time it was due:

  ```
  $ pinboard schedules run
  The schedule check-deps was due Mon 2026-11-30 09:00 Europe/Berlin (2026-11-30 08:00 UTC) and made no card: the last one, #1, is still open (in In progress).
  ```

  Once that card is in For review or Done, or archived, the next time it is due makes the next card.
- **A time missed while nothing ran** (the page was closed for three weeks) makes **one** card at
  the next run, not three. The card's description lists the times it stands for.
- **Two runs at the same moment** (the page's process and the command, say) make one card: the
  board's lock, and the last time each schedule dealt with, kept in its file.
- **A paused schedule** makes nothing (`pinboard schedules pause check-deps --as robin`). When you
  resume it, the times it missed are not made up.

**The nights the clock changes.** A time the clock skips (02:30 on the night it jumps from 02:00 to
03:00) is due an hour later that day, at 03:30, once. A time the clock passes twice (02:30 on the
night it goes back from 03:00 to 02:00) is due once, the first time. `--every` in minutes or hours
counts real time: across the change its local times move by an hour. `--every` in days keeps its
local time of day.

**Schedules run only while something calls them:** the page's process (`pinboard serve`, at its
start and every minute), a desktop app, or `pinboard schedules run` from your system's own
scheduler (cron, launchd, Task Scheduler); a time missed while nothing calls them makes one card at
the next call.

**On the page**, the clock in the top bar opens **Schedules**: each schedule with its rule, its next
time in its zone and in UTC, and its last card; **Pause**, **Resume** and **Remove**; and **Add a
schedule**, a form that shows the board's check of the card (the Ready check's words) before you
save. A card a schedule made says `by the schedule check-deps` on its tile and in its panel.

**A board made before schedules** works as it is: it needs no new file, and `pinboard schedules`
says there is none. On a board without Ready, `schedules add` and `schedules run` say that
`codelead board add-ready` gives it the column.

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
  progress (a card the board gave it from Ready is there already); when the work lands, it writes
  what landed and hands the card over in one step:

  ```
  $ pinboard move 1 --to for-review --as claude --comment "Landed: 4f2a9c1 on main; src/pages/sign-in.ts, test/sign-in.test.ts (6 tests)."
  Moved #1 from In progress to For review, with the comment.
  ```

  A comment whose first line starts with `Landed:` also fills the card's "What landed" field
  (that line, after the word) by itself, so the card's face shows it without a second write.

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

  $ pinboard set 1 --tag for:codelead --as claude
  Refused: claude is an agent and may not tag a card for:codelead: the person queues a card for
  CodeLead; ask in the thread. Nothing was written.
  ```

  `~/notes/log.txt` gets the same answer as the full path. Each of these refusals exits 1 (the
  table of exit codes is under "The commands"). Names the board must never hold go in
  `docs/codelead/board/private-names.txt`, one a line, on each machine (git ignores it).

### Projects, themes and bulk operations

**Projects.** A project is a tag on a card: `repo:<name>`, as `repo:api`.

- The selector at the left of the top bar lists every project on the board, with how many of
  its cards are still open: not archived, and not in the board's last column (Done, on a board
  `init` made).
- Pick one and the whole board shows only its cards: the columns, the counts, the search.
  **No project** shows the cards without a `repo:` tag.
- The address keeps it (`?project=api`), so a bookmark opens on the project.
- A card you write while a project is picked gets its tag. You can take the tag off in the form.

**Themes.** The palette button in the top bar opens the theme menu:

- four light themes: **Paper**, **Linen**, **Frost**, **Sage**;
- four dark ones: **Navy**, **Pitch**, **Dusk**, **Ember**;
- two **high contrast** ones, light and dark: text at 7:1 or more;
- **System**: it follows your computer, between the light and the dark theme you picked last.

Each theme has an accent of its own: Paper blue, Linen terracotta, Frost teal, Sage forest green,
Navy blue, Pitch fuchsia, Dusk periwinkle, Ember orange-red.

Each theme reads in its own font. The text is the same size in all of them, and reads at 4.5:1 or
more on its ground. The fonts come with the package: the page needs no network.

**Board background.** In the same menu: the theme's own, one of twelve colours that suit the
theme, or any colour. Your colour is the backdrop only: each column keeps the theme's look, one
surface with its title and its cards. When the column's surface is close to your colour, a line
around each column keeps it apart by itself.

**Kept per project.** Pick Ember while `api` is shown, and `api` opens in Ember next time.
**All projects** keeps the default; **Use the default** forgets a project's own choice. The
choices live in the board folder, in `.local/preferences.json` (git ignores `.local/`), so the
page shows the same in a browser and in an editor's tab.

![Linen: warm sand, brown ink, a terracotta accent and a serif, with a card open.](docs/screenshots/themes/linen.png)

![High contrast dark: white on black, every edge visible.](docs/screenshots/themes/contrast-dark.png)

*The ten themes, the eight colour themes side by side (`all-themes.png`), the theme menu and a
picked background are in [`docs/screenshots/themes`](docs/screenshots/themes).*

**Several cards at once.**

- **Pick** cards: ⌘-click a card (Ctrl-click on Windows and Linux); Shift-click picks every card
  between it and the last one you picked in that column; `x` picks the card the keyboard is on;
  a column's ⋯ menu has **Select all in this column**. A ticked box shows what is picked. Esc
  clears.
- **The bar** at the bottom says how many are picked: **Move to…**, **Archive**, **Add tag…**,
  **Remove tag…**, **Set project…** (an existing project or a new name; tick "replace" to take
  off their other project), **Clear**.
- Each asks once, then says what happened, card by card: "6 archived, 1 refused: #42 changed
  since you read it". **Undo** puts it back.
- **Drag** one picked card and the others come with it, in their order.
- The commands do the same: `pinboard move 3 4 7 --to done --as robin`,
  `pinboard archive 3 4 --as robin` (and `unarchive`), `pinboard set 3 4 --tag area:auth --as robin`.

![Three cards picked: each shows a ticked box; the bar at the bottom offers Move to, Archive, Add tag, Remove tag, Set project and Clear.](docs/screenshots/themes/bulk-bar.png)

### Every day after

![The page with "Since you last looked" open: twelve changes on five cards, each with who did what and when.](docs/screenshots/whats-new.png)

- **Open the page** (it is still running). The "@you" marks and "what changed since you last
  looked" show what needs you.
- **Answer in the threads, drag to Done, decide** on the decision cards, pin what matters.
- **Ask for work in the session** by card number; the agent reads the card and its thread. Or
  put a card that can be worked alone in **Ready**, for an agent to pick up.
- **Commit the board** with the rest of your work, or let the agent do it with its landings.
- **A new machine:** clone, `pinboard serve --open`. The cursors do not travel, so the agent's
  first check there starts from the beginning of the log; it looks from a day instead
  (`pinboard check --as claude --since 2026-11-02`), then acks.

### The command line, for whoever prefers it

Every change the page makes to the board is a command too: the page's edit of a card is
`set` (`--title`, `--body`, `--type`, `--attach`, `--tag`, `--color`, `--field`, …). Two things
are the page's alone: a card's place inside its column (a drag), and the page's view choices (the
theme, the background, the project shown). Three things are commands only: several cards from a
file, an import, `validate`.

**A card, a comment, a move, a decision:**

```sh
pinboard new --as robin --type task --title "Add a sign-in page" \
  --body "Users need to sign in before they see the dashboard. See src/app.ts." --tag area:auth
pinboard reply 1 --as robin --text "Email and password. Magic links later."
pinboard move 1 --to done --as robin
pinboard set 2 --as robin --field decided="Cookie, revisit when we go multi-instance."
pinboard set 1 --as robin --title "Add a sign-in page with email" --attach docs/auth.md:10-24
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
`PINNED.md` and a `DECISIONS-PENDING.md` would become cards, and a plan's status table too when you
name the plan (`--plan docs/plan.md`); without `--dry-run` it creates them, once, and
`tidy --imported` cleans their titles.

## The files

A board is a folder, `docs/codelead/board` in the repository by default:

| File | What it is |
| --- | --- |
| `board.json` | The board: its columns, card types, tag namespaces, participants, what an agent may do, the check interval, the next id. `schema` is `codelead.board/1`. |
| `AGENTS.md` | The conventions, for an agent that has never seen the board. `init` writes it from `board.json` (`agentsGuide` in `src/core/agents.ts` is the template). |
| `items/<nnnn>-<slug>.md` | One card a file. |
| `events.jsonl` | One JSON object a line, appended, never edited. |
| `cursors/<participant>.json` | What a participant has seen. Per machine; git ignores it. |
| `schedules/<name>.json` | Optional. One schedule a file: its rule, its zone, its card, who made it, and the last time it was due that a run dealt with ("Scheduled cards"). One file each, so that two schedules made on two branches never touch the same file. Git carries them. |
| `imports/` | Optional: the printed mapping of an import, kept for the record. The import itself marks each document it read in `board.json` (`imports`), so that it runs once. |
| `.gitignore` | Keeps `cursors/`, the lock, `private-names.txt`, `.local/` and temporary files out of git. |
| `.local/preferences.json` | Optional. This machine's view choices: the theme and the board's background, by default and per project, and the project shown last (`pinboard.preferences/1`). Written by the page; git ignores it. |
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
    { "id": "ready", "name": "Ready", "owner": "person" },
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
- `ready` is Ready, the person's column of the cards an agent may pick up by itself ("Handing a
  card to an agent: Ready"). A board made before it has none; `add-ready` adds it.
- `dispatch`, optional: how many cards an agent holds at a time and how long a claim lasts
  (`perAgent`, `leaseMinutes`, `maxLeaseMinutes`; 1, 30 and 240 when not given). See "How an
  agent gets its card: take".
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
  `status`, `archived`, `claim`, `schedule`. Unknown keys, comments and blank lines are kept; a
  change rewrites only the lines it changes.
- `claim` is written by the board alone, on a card it gave an agent from Ready: `by` (the agent),
  `since` and `until` (UTC). It is there while the card is in In progress, and goes when the claim
  ends.
- `schedule` is written by the board alone, on a card a schedule made: `name` (the schedule),
  `by` (the person whose schedule it is, the card's author) and `due` (the time it was due, UTC).
- The text before `## Thread` is the description. Each comment is a heading
  `### <participant> · <UTC time>` and its markdown. Comments are appended, never rewritten.
- The file name starts with the id, zero-padded, then a slug. The id is the key.
- `fields` holds the type's own fields: a decision's `ask`, `options`, `recommendation`,
  `decided`, `consequences`; a task's `definitionOfDone`, `size`, `landed`; and so on
  (`TYPE_FIELDS` in `src/core/types.ts`). Any card may also carry the fields Ready asks for:
  `definitionOfDone`, `mayTouch`, `limitMinutes`, `limitMoney` (`src/core/ready.ts`).
- A path a card cites is a path in the repository, or `<repository>:<path>` for another
  repository of the workspace (the repository's parent folder, or `workspace` in `board.json`).

### `events.jsonl`

```json
{"at":"2026-10-03T00:52:10Z","by":"robin","item":42,"kind":"comment.added","data":{"excerpt":"Fine. After packages 4 and 5."}}
{"at":"2026-10-03T00:52:10Z","by":"robin","item":42,"kind":"item.moved","data":{"from":"inbox","to":"backlog"}}
```

Kinds: `item.created`, `item.updated`, `item.moved`, `item.archived`, `item.unarchived`,
`comment.added`, `relation.added`, `relation.removed`, `tag.added`, `tag.removed`,
`attachment.added`, and those of a claim:

| Kind | What happened | `data` |
| --- | --- | --- |
| `claim.taken` | The board gave the card to the agent (`by`) from Ready. | `until`, `minutes` |
| `claim.renewed` | The agent that holds it renewed its claim. | `until`, `minutes` |
| `claim.released` | The agent gave it back to Ready (its reason is the comment written with it). | `since`, `until` |
| `claim.expired` | A take found the claim had run out, and put the card back in Ready (`by`: whose take). | `holder`, `since`, `until` |
| `claim.ended` | The card left In progress (handed to For review, moved by the person) or was archived. | `holder`, `until`, `to` or `archived` |

A move that comes with a claim (a take, a release, an expired claim) is an `item.moved` marked
`withClaim`, written just before the claim's event; the two read as one line.

And those of a schedule (`by`: the person whose schedule it is):

| Kind | What happened | `data` |
| --- | --- | --- |
| `schedule.added` | The person made the schedule. | `schedule`, `rule`, `zone` |
| `schedule.changed` | The person changed it. | `schedule`, `changed` (`rule`, `zone`, `card`); `rule` and `zone` when they changed |
| `schedule.paused` | The person paused it. | `schedule` |
| `schedule.resumed` | The person resumed it. | `schedule` |
| `schedule.removed` | The person removed it; the cards it made stay. | `schedule` |
| `schedule.ran` | At its time it put its card (`item`) in Ready. | `schedule`, `due`; `missed` when it stands for times missed |
| `schedule.skipped` | It was due and made no card: its card (`item`) is still open, or the board refused the card. | `schedule`, `due`, `why` (`open` or `refused`), `open` or `refused` and `words` |

The card a schedule makes has its `item.created`, marked with `schedule` and `due`, written just
before the `schedule.ran`; the two read as one line ("created it by the schedule check-deps (task in
Ready), due …").

The card is the truth; the line is what a check reports. A card file that changed with no event
(a hand edit, an agent that forgot) gets an event by `unknown` at the next check, or from the
page's process once the file has been quiet.

### `cursors/<participant>.json`

```json
{ "seen": "2026-10-03T00:52:10Z", "lines": 17, "opened": { "42": "2026-10-03T00:52:10Z" } }
```

What the participant has seen. For an agent it is also its check cursor.

- `seen`: the time of the participant's last check with `--ack`.
- `lines`: how many lines of `events.jsonl` it has seen, the cursor's exact place.
- `opened`: per card id, when it last opened the card (`show --as`, or the page): the card's
  events before that are seen.

### What is never written into a card

A write is refused when its text holds:

- **a secret**: a key or a token (a provider's, a cloud's, a code host's), a password (in a
  settings line, a JSON or XML file, a connection string, an address, a command line), a bearer
  token, a private key;
- **a path of this machine** outside the workspace (under the home folder), written in full or
  from `~` (`~/notes/log.txt`, when the home folder holds `notes`; an application's own
  `~/Views/Home/Index.cshtml` names nothing there, and is written as it is);
- **a private name**, listed in `private-names.txt`.

**What the secret guard catches, and what it cannot.** The guard looks for a value, not for a
word. A card may talk about passwords and keys: "the token expired", `` `Password=` `` in a
code span, `scheme://user:password@host` as an example, `<your password>` or `${DB_PASSWORD}`
in place of one. It refuses the card when a value is there: `DB_PASSWORD=…` with a real value
after it, `"password": "…"` in JSON, a password in a connection string or an address, a key in
a known shape (OpenAI, Anthropic, AWS, GitHub, GitLab, Slack, Stripe, Google and others), a
private key. The rules are in `src/core/secretRules.ts`. They cannot know every shape: a secret
written in a shape no rule knows, such as "my password is …" in a sentence, can still pass. So
read what you paste into a card, and say where a secret is kept rather than what it is.

A path under the repository or the workspace is not refused: it is rewritten as the card cites
it, and the write's event lists each rewrite. `--rewrite-paths` writes a home-folder path as
`<home>/…` instead of refusing it.

## The commands

Run `pinboard` in any repository that has a board folder, or give `--board <dir>`. A host
gives the same commands under its own name (`codelead board …`).

| Command | What it does |
| --- | --- |
| `init` | Creates the board folder: `board.json`, `AGENTS.md`, `events.jsonl`, `.gitignore`, `items/`, `cursors/`. |
| `check --as <you>` | What changed since your cursor: what is addressed to you first, then the decisions, then the rest. `--ack` moves the cursor to the end; `--since <time>` looks from a time. |
| `list` | The cards by column. `--column`, `--tag`, `--type`, `--repo`, `--archived`. |
| `show <id>` | One card: fields, relations both ways, attachments, description, thread. |
| `new --as <you>` | Creates a card (`--type`, `--title`, `--body`, `--field`, …), or every card of a markdown file (`--batch`), all or none. `--dry-run` writes nothing. |
| `reply <id> --as <you>` | Appends a comment (`--text` or `--file`). |
| `move <id…> --to <column> --as <you>` | Moves a card, or several (they keep their order); an agent only into `agents.mayMoveTo`, and never out of Ready. Into Ready, only a card that says how to tell it is done, what it may touch and its limit. |
| `take --as <agent>` | An agent asks the board for its card: the next Ready card it may work, moved to In progress and held for it, or none and why. `--lease <minutes>`. Exit 0 either way; `--json` says `given`. |
| `renew <id> --as <agent>` | The agent that holds the card renews its claim, from now. `--lease <minutes>`. |
| `release <id> --as <agent> --reason <text>` | The agent that holds the card gives it back to Ready, with the reason in its thread. |
| `set <id…> --as <you>` | Changes the title (`--title`), the description (`--body`, `--body-file`), the type (`--type`), tags, relations, attachments (`--attach <path[:lines]>`), the status line, the colour, the fields of a card, or the same on several (a title or a description: one card only). |
| `archive <id…> --as <person>` | Archives cards: they leave the board and stay in their files. A person only. |
| `unarchive <id…> --as <person>` | Brings archived cards back to their columns. A person only. |
| `validate` | Checks every file of the board. |
| `add-ready` | Gives a board made before Ready its Ready column, and says what it did. `AGENTS.md` is written again when it is still the package's text. No card moves. |
| `schedules` | The schedules: each one's rule in words, the next time it is due in its zone and in UTC, whether it is paused, the last card it made. A board with none says so. (`schedules list` too.) |
| `schedules add <name> --as <person>` | Makes a schedule (a person only): `--every <30m\|2h\|1d>` with `--from`, `--daily` or `--weekly <days>` with `--at <HH:MM>`, `--zone`; its card from `--type`, `--title`, `--body`, `--body-file`, `--tag`, `--for <agent>`, `--field` (the three things Ready asks), or `--from-card <id>`. `--dry-run` writes nothing. |
| `schedules change <name> --as <person>` | Changes its rule (its times count from then), zone or card (`--untag`, `--unset-field` too). |
| `schedules pause\|resume\|remove <name> --as <person>` | Pauses it (the times it misses are not made up), resumes it, or removes it (the cards it made stay). |
| `schedules run` | Makes, once, the card of each schedule that is due now, and says what it did; or that nothing is due, and when the next is. Exit 0 either way. |
| `import --from <folder>` | Turns `PINNED.md`, `DECISIONS-PENDING.md` and, with `--plan <file>`, a plan's status table into cards, once. `--from` is required; no plan is read unless it is named. |
| `tidy --imported` | After the import: strips the bold repetition of the title from imported cards. |
| `serve` | Serves the page on 127.0.0.1 (port 7414, or a free one). `--open` opens it. |

Every command takes `--board <dir>` and `--json`. With `--json` a command prints one JSON
document, a refusal too: `{ "refused": "<code>", "message": "…" }`.

`pinboard --help` and `pinboard <command> --help` give every option.

### Exit codes

| Exit | What it means |
| --- | --- |
| **0** | Done, or nothing to change. |
| **1** | A rule of the board refused the write, and nothing was written; or `validate` found problems. |
| **2** | The command cannot run as written, and nothing was written: a missing or malformed argument, an unknown option, no board, no such card. |

Every refusal, by the code `--json` gives it:

| `refused` | Exit | When |
| --- | --- | --- |
| `usage` | 2 | A missing option or argument (`new` without `--as`); two that do not go together (`--body` and `--body-file`); a value of the wrong form (not a card id, a relation that is not `<kind>:<id>`, a field that is not `<name>=<value>` or not one of the card's type, not a time, not a port); a file that cannot be read; `init` arguments that make no valid board; `serve` with no page built and no tools to build it; a schedule's rule that is none of the three, or a time zone this machine does not know. The parser's own refusals (an unknown option, a missing `<id>`) exit 2 too, in its words. |
| `no-board` | 2 | No `board.json` where the command looks. |
| `not-found` | 2 | No card with the id given, a relation's included; no schedule of the name given. |
| `board-exists` | 1 | `init` where a board already is. |
| `participant` | 1 | `--as` names no participant of the board. |
| `not-allowed` | 1 | The participant may not do it: an agent archives, creates on a board whose `agents.mayCreate` is false, sets a card's colour, or tags a card `for:codelead` (CodeLead itself may); an agent imports; an agent changes the Ready fields of a card in Ready or of a held card, or adds or removes a `for:` tag on either; an agent makes, changes, pauses, resumes or removes a schedule. |
| `column` | 1 | No such column; an agent moves or creates a card in a column it may not (a person's column, or one not in `agents.mayMoveTo`); an agent moves a card out of Ready (the board gives it its card: `take`); a schedule made on a board without Ready. |
| `claim` | 1 | A take by a person; a lease longer than `dispatch.maxLeaseMinutes`; a renewal or a release by anyone but the agent that holds the card, or of a card no one holds; another agent's move of a held card, or its holder's move anywhere but For review. |
| `schedule` | 1 | `schedules add` under a name the board has a schedule of already, or a name that is no short word of lower-case letters, digits and `-`. |
| `type` | 1 | No such card type. |
| `decision` | 1 | An agent sets or removes a decision; a decision that is not the option chosen, by a participant, on a day; an ask that is not one to three sentences. |
| `color` | 1 | A colour that is none of the five. |
| `relation` | 1 | A card related to itself; a kind of relation the board does not have; a batch's relation to a key no card of it has. |
| `text` | 1 | An empty comment, title or tag; a title, status or tag of more than one line. |
| `ready` | 1 | A card moved to Ready, or made there, that does not say how to tell it is done, what it may touch, or a limit in minutes or money; a change that would take one of these from a card in Ready; a limit that is not a number; a schedule whose card would not pass this check. |
| `structure` | 1 | A line the card would read as its own structure (`## Thread`, a comment's heading). |
| `secret` | 1 | The text holds a secret (a key or a token, a password, a private key). |
| `machine-path` | 1 | The text holds a path of this machine outside the workspace. |
| `private-name` | 1 | The text holds a name of `private-names.txt`. |
| `stale` | 1 | The card changed since it was read (`--if-updated`), or while it was written; a schedule's file changed while it was written. |
| `invalid` | 1 | A file of the board that cannot be read (a card, `board.json`, a cursor), or one id on two cards; a batch file that does not read, or two of its cards with one key. |
| `imported` | 1 | `import` of a document it imported already. |
| `busy` | 1 | Another writer holds the board's lock: retry. |

A command given several ids answers for each card; it exits 2 when every refusal is of the
first three codes, and 1 when any is a rule's.

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

The page loads nothing from elsewhere: its fonts are bundled (`src/page/public/fonts`, each under
the SIL Open Font Licence with its text beside it). Its Content-Security-Policy allows its own
scripts only.

Besides the board and its cards, the page's process answers `GET` and `PUT /api/preferences`
(the view choices, checked like a card's text: no secret, no path of this machine) and
`POST /api/cards/batch` (one operation on several cards, `{ operation, ids, … , expectUpdated }`,
each card written on its own and answered on its own).

For a host that runs agents (a panel that shows them, a loop that starts them), the dispatcher's
routes, each through the same core:

- `GET /api/dispatch`: for the whole board, what each agent holds and what it would be given if it
  asked now, or why not, and what keeps each Ready card back (the core's `dispatchView`). It
  writes nothing, as the next take would decide it.
- `POST /api/take` `{ as, lease? }`: the agent's take (the core's `takeCard`).
- `POST /api/items/<id>/renew` `{ as, lease? }` and `POST /api/items/<id>/release`
  `{ as, reason }`: the holder's renewal and release.

The schedules' routes ("Scheduled cards"), each through the same core:

- `GET /api/schedules`: every schedule, with its rule in words, its next time in its zone and in
  UTC, and its last card (the core's `listSchedules`).
- `POST /api/schedules` `{ name, rule, zone?, card, dryRun? }`, `PUT /api/schedules/<name>`, and
  `POST /api/schedules/<name>/pause`, `/resume`, `/remove`: the person's writes, as the board's
  person. `dryRun` checks and writes nothing (the page shows the Ready check's words before saving).
- `POST /api/schedules/run`: runs what is due now (the core's `runSchedules`), as the timer does.

While it listens, the page's process runs the schedules that are due at its start and every minute
(`schedulesEveryMs` in `createBoardServer`'s options, 60 000 by default, 0 for never; `timers` to
give it another timer), and says in its log what it made. A host that runs the schedules itself
(a desktop app) sets 0 and calls the core's `runSchedules(ctx)`, or the route, on its own timer:
the board's lock and each schedule's file make one card however many call it at once.

Nothing in the package starts an agent, or runs a loop or a timer for one. The one timer it runs is
the page's process's, for the schedules: it makes cards in Ready, and starts nothing.

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
