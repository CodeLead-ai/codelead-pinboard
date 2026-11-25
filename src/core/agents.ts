import { agentColumns, intervalMinutes } from "./boardConfig.js";
import { dispatchOf } from "./claim.js";
import { PRIVATE_NAMES_FILE } from "./guard.js";
import { DONE_WHEN_FIELD, LIMIT_MINUTES_FIELD, LIMIT_MONEY_FIELD, MAY_TOUCH_FIELD, READY_COLUMN_ID, READY_TAKEN_INTO, readyColumnOf } from "./ready.js";
import { EVENT_KINDS, type BoardConfig } from "./types.js";

/**
 * AGENTS.md: the conventions any agent follows to take part, written so that an agent that has
 * never seen CodeLead can (design section 2.5). The columns, the agent's columns and the interval
 * come from the board's own board.json, so the text stays true for any board.
 */
export function agentsGuide(config: BoardConfig): string {
  const moveTo = agentColumns(config).map((column) => (column.id === "in-progress" ? `${column.name} (only when the person asked for the work in the session)` : column.name));
  // That condition is a convention: no command can see what the person asked in a session.
  const working = agentColumns(config).find((column) => column.id === "in-progress")?.name;
  const personColumns = config.columns.filter((column) => column.owner === "person").map((column) => column.name);
  // Ready (ready.ts), when the board has it: the person's column too, with its own rule for a move out of it (its section below).
  const ready = readyColumnOf(config);
  const leftBy = config.columns.filter((column) => column.owner === "person" && column.id !== ready?.id).map((column) => column.name);
  // A move out of a person's column is a convention too: the person asked for the work in the session, or named the card.
  const asked =
    leftBy.length > 0
      ? ` Move a card out of ${listOf(leftBy, "or")} only when the person asked for it in the session (to start the work the person asked for, or to reopen a card the person named): no command can tell, so that rule${working ? `, like the one for ${working},` : ""} is yours to keep.`
      : working
        ? " No command can tell whether the person asked for the work, so that rule is yours to keep."
        : "";
  const first = config.columns[0]?.name ?? "the first column";
  const review = config.columns.find((column) => column.id === "for-review")?.name ?? "the review column";
  const done = config.columns.find((column) => column.id === "done")?.name;
  const minutes = intervalMinutes(config);
  const list = listOf;
  // Where the cards of a conversation land: the first column, and the backlog when the board has one.
  const backlog = config.columns.find((column) => column.id === "backlog")?.name;
  const intake = list([...new Set([first, ...(backlog !== undefined ? [backlog] : [])])], "or");
  return wrapLong(`# Pinboard: how an agent takes part

This folder is a board shared by a person and their coding agents. The files are the board:
read and write them with the tools you have. \`codelead board …\` makes the same writes with the
checks below, when CodeLead is installed (\`codelead board --help\`).

## The files
- \`board.json\`: the columns, the card types, the participants (add yourself as
  \`{ "id": "<you>", "kind": "agent", "name": "…" }\` before you write), \`agents.mayMoveTo\`,
  \`check.intervalMinutes\` (how often to check; ${minutes} when this file was written) and \`nextId\`.
- \`items/NNNN-<slug>.md\`: one card. YAML front matter (\`id\`, \`type\`, \`title\`, \`column\`, \`tags\`,
  \`author\`, \`created\`, \`updated\`; \`relations\`, \`attachments\`, \`fields\`, \`status\` when set; keep
  every key you do not know), the description in markdown, then \`## Thread\`: each comment is a
  line \`### <participant> · <UTC time>\` followed by its markdown.
- \`events.jsonl\`: one JSON line per change, appended, never edited:
  \`{"at":"2026-10-03T00:52:10Z","by":"<you>","item":42,"kind":"comment.added","data":{"excerpt":"…"}}\`
  Kinds: ${EVENT_KINDS.filter((kind) => ready !== undefined || !kind.startsWith("claim.")).join(", ")}.
- \`cursors/<you>.json\`: what you have seen (not in git): \`seen\`, the time of your last \`--ack\`;
  \`lines\`, how many lines of events.jsonl you have read; \`opened\`, when you opened each card:
  \`{ "seen": "<time>", "lines": 17, "opened": { "42": "<time>" } }\`.

## Check
Every \`check.intervalMinutes\` minutes, and whenever the person asks, read the lines of
\`events.jsonl\` after your cursor (\`codelead board check --as <you>\`). Act on what others
wrote, then move your cursor (\`--ack\`). When nothing changed, that is one short read.
The check every ${minutes} minutes needs a timer you do not have by yourself: in Claude Code the person
starts one (\`/loop ${minutes}m codelead board check --as <you>\`); without one, check at the start of the
session and whenever the person asks.
An event whose \`data.addressed\` holds your id is addressed to you (its text mentions \`@<you>\`): the check lists those cards first, under "Addressed to you"; answer them first.
An event with \`data.decided\` is the person's answer to a decision card, recorded in its fields: the check lists it under "Decided"; act on it as on a comment that says it.

## Write
- Re-read a card right before you change it, and set its \`updated\` to the time of your change.
- Reply: append \`### <you> · <time>\` and your markdown at the end of the card, then the event
  \`comment.added\`.
- Address someone with \`@<id>\` (or their name) in a comment or a description; its event's \`data.addressed\` is derived from the text: the ids it mentions outside code, \`["<id>", …]\`.
- Create: take \`nextId\` from board.json and raise it by one in the same step; put the card in
  ${first} (or another column you may move into); tag it \`by:<you>\`; event \`item.created\`.
- When the person asks to turn a conversation into cards: a card per decision, task, question or idea, its description standing on its own (what, why, where it came from and when), related to the others and to the cards it touches, tagged \`by:<you>\` and \`source:conversation\`, in ${intake}; show the person the list, and create them on their yes.
- On a decision, \`fields.ask\` says what the person is asked to decide, the options and your recommendation, in one to three sentences; \`color\` is the person's colour mark: leave it (the commands refuse it from an agent).
- Never set a decision's \`fields.decided\`: the decision is the person's; write your recommendation in \`fields.ask\`. The commands refuse it.
- You may move a card into ${list(moveTo)}; add tags and relations; create cards.${asked}
- Every change gets its event line, \`by\` you. Times are UTC: \`2026-10-03T00:52:10Z\`.

## Never
- Start code work because of a card. Work starts when the person asks for it in the session${ready ? `, or when the person moved the card to ${ready.name}` : ""}.
- Move a card into ${list(personColumns, "or") || "a person's column"}: ${personColumns.length === 1 ? "that column is" : "those columns are"} the person's.
- Edit or remove a comment, yours or another's; you only append to the thread.
- Write secrets (keys, passwords, tokens), names the project keeps private
  (\`${PRIVATE_NAMES_FILE}\`), or paths of your machine (\`<home>/…\`, \`C:\\…\`) into a card. Cite files
  by their path in the repository, or \`<repository>:<path>\` for another repository. The commands refuse such a text, a path that starts with \`~/\` included.
${ready ? `\n${readySection(config)}` : ""}
## Work the person asked for
When it is done: comment with what landed (the commit, the evidence record's id, the files),
and move the card to ${review}.${done ? ` The person moves it to ${done}.` : ""} A comment that starts with \`Landed:\` fills the task's \`landed\` field (its first line) by itself.
${codeleadSection(config)}`);
}

/**
 * The section of AGENTS.md on Ready, for a board that has the column (empty otherwise): what the
 * column means, what a card there says, that the board gives an agent its card (take, with a claim it
 * renews and that runs out), one real exchange, and what an agent never does there. `add-ready` prints
 * it for a guide it leaves as it is.
 */
export function readySection(config: BoardConfig): string {
  const ready = readyColumnOf(config);
  if (!ready) return "";
  const into = config.columns.find((column) => column.id === READY_TAKEN_INTO)?.name;
  const review = config.columns.find((column) => column.id === "for-review")?.name ?? "the review column";
  const minutes = dispatchOf(config).leaseMinutes;
  const take = into
    ? `You do not pick the card; the board gives it: \`codelead board take --as <you>\` gives you the next one you may work (yours, tagged \`for:<you>\`, first) in ${into}, held for you by a claim for ${minutes} minutes, or says why there is none. Renew the claim while you work (\`renew <id> --as <you>\`), and hand the card to ${review} when it is done; \`release <id> --as <you> --reason "…"\` gives it back. A claim not renewed runs out, and the next take puts the card back in ${ready.name}. For example: \`take --as claude\` says "Took #3 (task): Rate-limit the sign-in form" and until when claude holds it; claude works, runs \`renew 3 --as claude\` every few minutes, then \`move 3 --to for-review --as claude --comment "Landed: 4f2a9c1"\`. Never move a card into ${ready.name} or out of it, or change those fields or a \`for:\` tag while it is there or held: the commands refuse it.`
    : `Leave its cards where they are: the board has no column to take them into. Never move a card into ${ready.name}, or change those fields while it is there: the commands refuse it.`;
  return wrapLong(`## ${ready.name}
${ready.name} is the person's column of the cards an agent may pick up by itself: moving a card there is the person's ask for the work. A card there says how to tell it is done (\`fields.${DONE_WHEN_FIELD}\`), what it may touch (\`fields.${MAY_TOUCH_FIELD}\`) and its limit (\`fields.${LIMIT_MINUTES_FIELD}\`, \`fields.${LIMIT_MONEY_FIELD}\`): keep to them. ${take}
`);
}

/** A list in words: "a", "a and b", "a, b and c" (or "or" for the last). */
function listOf(items: string[], last = "and"): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} ${last} ${items[items.length - 1]}`;
}

/** Guidance for a board CodeLead joined, including boards with only the legacy queue column. */
function codeleadSection(config: BoardConfig): string {
  const queue = config.columns.find((column) => column.id === "queued");
  if (!queue && !config.participants.some((participant) => participant.id === "codelead" && participant.kind === "agent")) return "";
  const backlog = config.columns.find((column) => column.id === "backlog")?.name ?? "Backlog";
  const excluded = ["in-progress", "for-review", "done"].map((id) => config.columns.find((column) => column.id === id)?.name).filter((name): name is string => name !== undefined);
  const notTaken = excluded.length < 2 ? excluded.join("") : `${excluded.slice(0, -1).join(", ")} or ${excluded[excluded.length - 1]}`;
  const working = config.columns.find((column) => column.id === "in-progress")?.name ?? "In progress";
  const review = config.columns.find((column) => column.id === "for-review")?.name ?? "the review column";
  const personColumns = config.columns.filter((column) => column.owner === "person").map((column) => column.name);
  const never = personColumns.length === 0 ? "a person's column" : personColumns.length === 1 ? personColumns[0]! : `${personColumns.slice(0, -1).join(", ")} or ${personColumns[personColumns.length - 1]}`;
  // A person's column the queue takes from (Pinned): a tagged card there is taken too. Not Ready: any agent takes a card out of it into In progress.
  const takenFrom = config.columns.filter((column) => column.owner === "person" && !["in-progress", "for-review", "done", READY_COLUMN_ID].includes(column.id)).map((column) => column.name);
  const outOf = takenFrom.length === 0 ? "" : ` (out of ${listOf(takenFrom, "or")} too)`;
  return wrapLong(`
## CodeLead on the board
CodeLead takes part as the participant \`codelead\` (an agent), on every card it works, in the session (\`/implement --card <id>\`) and unattended (\`codelead implement --card <id>\`, \`codelead implement --queue\`). The card is the request: its title, its description, the person's comments (as clarifications), its related cards and attachments.
- The queue is the tag \`for:codelead\`: the person tags a card to hand it to CodeLead. \`codelead implement --queue\` takes tagged cards that are not archived${notTaken ? ` and not in ${notTaken}` : ""}, top of ${backlog} first, then the other columns in board order, each in page order. CodeLead moves each card to ${working}${outOf} and keeps the tag. Agents do not add or remove the tag (the commands refuse an agent's adding it: ask the person in the thread), and do not take the cards that carry it.
${queue ? `- The old column "${queue.name}" is kept for a while: it supplies its untagged cards after the tagged cards. Tag a card \`for:codelead\` instead.\n` : ""}- CodeLead writes: \`Started:\` when it starts, with the lint of the card's text; in an unattended run, one comment with the questions the preflight asked and the answers it took; at the end, \`Landed:\` from the evidence record (the card moves to ${review}), or \`Stopped:\` with the reason and the options, addressed to the person (the card stays where it is).
- CodeLead never writes a decision (\`fields.decided\`) and never moves a card into ${never}. An agent does not write CodeLead's comments for it.
- To run a card again, the person answers in its thread and moves it back to ${backlog}, tagged \`for:codelead\`.
`);
}

/** Wraps the lines longer than `width` at a space, a list item's continuation indented two spaces. */
function wrapLong(text: string, width = 96): string {
  return text
    .split("\n")
    .flatMap((line) => {
      const out: string[] = [];
      let rest = line;
      const indent = /^(- |  )/.test(line) ? "  " : "";
      while (rest.length > width) {
        const at = rest.lastIndexOf(" ", width);
        if (at <= indent.length) break;
        out.push(rest.slice(0, at));
        rest = indent + rest.slice(at + 1);
      }
      out.push(rest);
      return out;
    })
    .join("\n");
}
