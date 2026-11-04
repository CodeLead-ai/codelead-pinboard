import { agentColumns, intervalMinutes } from "./boardConfig.js";
import { PRIVATE_NAMES_FILE } from "./guard.js";
import { EVENT_KINDS, type BoardConfig } from "./types.js";

/**
 * AGENTS.md: the conventions any agent follows to take part, written so that an agent that has
 * never seen CodeLead can (design section 2.5). The columns, the agent's columns and the interval
 * come from the board's own board.json, so the text stays true for any board.
 */
export function agentsGuide(config: BoardConfig): string {
  const moveTo = agentColumns(config).map((column) => (column.id === "in-progress" ? `${column.name} (only when the person asked for the work in the session)` : column.name));
  const personColumns = config.columns.filter((column) => column.owner === "person").map((column) => column.name);
  const first = config.columns[0]?.name ?? "the first column";
  const review = config.columns.find((column) => column.id === "for-review")?.name ?? "the review column";
  const done = config.columns.find((column) => column.id === "done")?.name;
  const minutes = intervalMinutes(config);
  const list = (items: string[], last = "and"): string => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} ${last} ${items[items.length - 1]}`);
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
  Kinds: ${EVENT_KINDS.join(", ")}.
- \`cursors/<you>.json\`: what you have seen (not in git):
  \`{ "seen": "<time>", "lines": <how many lines of events.jsonl you have read> }\`.

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
- On a decision, \`fields.ask\` says what the person is asked to decide, the options and your recommendation, in one to three sentences; \`color\` is the person's colour mark: leave it.
- Never set a decision's \`fields.decided\`: the decision is the person's; write your recommendation in \`fields.ask\`.
- You may move a card into ${list(moveTo)}; add tags and relations; create cards.
- Every change gets its event line, \`by\` you. Times are UTC: \`2026-10-03T00:52:10Z\`.

## Never
- Start code work because of a card. Work starts when the person asks for it in the session.
- Move a card into ${list(personColumns, "or") || "a person's column"}: ${personColumns.length === 1 ? "that column is" : "those columns are"} the person's.
- Edit or remove a comment, yours or another's; you only append to the thread.
- Write secrets (keys, passwords, tokens), names the project keeps private
  (\`${PRIVATE_NAMES_FILE}\`), or paths of your machine (\`<home>/…\`, \`C:\\…\`) into a card. Cite files
  by their path in the repository, or \`<repository>:<path>\` for another repository.

## Work the person asked for
When it is done: comment with what landed (the commit, the evidence record's id, the files),
and move the card to ${review}.${done ? ` The person moves it to ${done}.` : ""} A comment that starts with \`Landed:\` fills the task's \`landed\` field (its first line) by itself.
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
