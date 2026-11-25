import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boardContext, createCards, getCard, initBoard, readBoardConfig, readEvents, validateBoard, type Participant } from "../core/index.js";
import { atOnce, buildCode, type Built, type Ran } from "./built.js";

/**
 * Two agents asking at the same moment never get the same card: separate processes of the built
 * bin (`pinboard take --as <agent> --json`), started at one moment against one board, many rounds,
 * more agents than Ready cards, two processes for each agent. What each process says, what the card
 * files say and what the log says must tell one story: every card given once at most, to an agent
 * it may go to; no agent above its limit; the two cards that may touch the same files never held
 * together.
 */

const ROUNDS = 12;
const AGENTS = 6;
const PROCESSES_PER_AGENT = 2;

let base: string;
let built: Built;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "pinboard-parallel-"));
  built = buildCode(base);
}, 60_000);

afterAll(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

const agents = Array.from({ length: AGENTS }, (_, index) => `agent-${index + 1}`);
const PEOPLE: Participant[] = [{ id: "robin", kind: "person", name: "Robin" }, ...agents.map((id) => ({ id, kind: "agent" as const, name: id }))];

/**
 * A board with five cards in Ready: two apart from all others, two that may touch the same files (a
 * folder and a file in it), and one for agent-3 alone.
 */
function makeBoard(round: number, perAgent: number): { dir: string } {
  const root = path.join(base, `round-${round}`, "app");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  const dir = path.join(root, "docs", "codelead", "board");
  const ctx = boardContext({ dir, root, home: path.join(base, "home") });
  initBoard(ctx, { name: "parallel", participants: PEOPLE });
  const config = readBoardConfig(dir).config;
  fs.writeFileSync(path.join(dir, "board.json"), `${JSON.stringify({ ...config, dispatch: { perAgent } }, null, 2)}\n`);
  const card = (title: string, touch: string, tags: string[] = []) => ({ type: "task", title, column: "ready", tags, fields: { definitionOfDone: "npm test passes", mayTouch: [touch], limitMinutes: 30 } });
  createCards(ctx, "robin", [card("Apart A", "src/a/"), card("Apart B", "src/b/"), card("Shared folder", "src/shared/"), card("Shared file", "src/shared/util.ts"), card("For agent-3", "src/c/", ["for:agent-3"])], { tagCreator: false });
  return { dir };
}

interface Answer {
  given: boolean;
  card?: { id: number };
  claim?: { by: string };
  reason?: string;
}

describe("the dispatcher across processes", () => {
  it(
    `gives each card to one agent at most, in ${ROUNDS} rounds of ${AGENTS * PROCESSES_PER_AGENT} processes at once, and the files and the log say the same`,
    async () => {
      const cli = built.cli;
      let busy = 0;
      for (let round = 0; round < ROUNDS; round += 1) {
        const perAgent = round % 2 === 0 ? 1 : 2;
        const { dir } = makeBoard(round, perAgent);
        const asks = agents.flatMap((agent) => Array.from({ length: PROCESSES_PER_AGENT }, () => agent));
        const ran = await atOnce(path.join(base, `round-${round}`, "gate"), path.join(built.dist, "cli", "board.js"), asks.map((agent) => ({ args: [cli, "take", "--as", agent, "--json", "--board", dir] })));
        // A process the board refused as busy (another writer held the lock longer than it waits) asks again, as its words say.
        const answers: Array<{ agent: string; answer: Answer }> = [];
        for (const [index, first] of ran.entries()) {
          let result: Ran = first;
          while (result.code === 1 && /"refused": ?"busy"/.test(result.stdout)) {
            busy += 1;
            [result] = await atOnce(path.join(base, `round-${round}`, `again-${index}`), path.join(built.dist, "cli", "board.js"), [{ args: [cli, "take", "--as", asks[index]!, "--json", "--board", dir] }]);
          }
          expect(result.code, `${asks[index]}: ${result.stdout}${result.stderr}`).toBe(0);
          answers.push({ agent: asks[index]!, answer: JSON.parse(result.stdout) as Answer });
        }

        // What the processes say: each card once at most; no agent above its limit; the shared folder and file not both; agent-3's card to agent-3.
        const gave = answers.filter((entry) => entry.answer.given).map((entry) => ({ agent: entry.agent, card: entry.answer.card!.id, by: entry.answer.claim!.by }));
        const ids = gave.map((entry) => entry.card);
        expect(new Set(ids).size, `round ${round}: ${JSON.stringify(gave)}`).toBe(ids.length);
        for (const agent of agents) expect(gave.filter((entry) => entry.agent === agent).length).toBeLessThanOrEqual(perAgent);
        for (const entry of gave) expect(entry.by).toBe(entry.agent);
        expect(ids.includes(3) && ids.includes(4)).toBe(false);
        for (const entry of gave.filter((one) => one.card === 5)) expect(entry.agent).toBe("agent-3");
        // Every card that may be given is: 1, 2, one of 3 and 4, and 5 (agent-3 asks too).
        expect([...ids].sort()).toEqual(expect.arrayContaining([1, 2, 5]));
        expect(ids.length).toBe(4);
        for (const entry of answers.filter((one) => !one.answer.given)) expect(["at-limit", "blocked", "for-others", "empty"]).toContain(entry.answer.reason);

        // What the files say: the cards given are in In progress, each held by the agent that was told so; the others are in Ready, held by no one.
        const ctx = boardContext({ dir });
        for (const id of [1, 2, 3, 4, 5]) {
          const card = getCard(ctx, id).card;
          const to = gave.find((entry) => entry.card === id);
          expect([card.column, card.claim?.by]).toEqual(to ? ["in-progress", to.agent] : ["ready", undefined]);
        }
        // What the log says: one take per card given, by that agent, each with its move; nothing else.
        const events = readEvents(dir).events.map(({ event }) => event);
        const taken = events.filter((event) => event.kind === "claim.taken");
        expect(taken.map((event) => [event.item, event.by]).sort()).toEqual(gave.map((entry) => [entry.card, entry.agent]).sort());
        const moves = events.filter((event) => event.kind === "item.moved");
        expect(moves.map((event) => [event.item, event.by, event.data]).sort()).toEqual(gave.map((entry) => [entry.card, entry.agent, { from: "ready", to: "in-progress", withClaim: true }]).sort());
        expect(events.length).toBe(5 + 2 * gave.length);
        expect(validateBoard(ctx).problems).toEqual([]);
      }
      // How often a process had to ask again is said, not hidden.
      if (busy > 0) console.log(`the board was busy for ${busy} take(s); each asked again`);
    },
    180_000
  );
});
