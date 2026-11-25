import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BoardRefusal, LOCK_FILE, withBoardLock } from "../core/index.js";
import { atOnce, buildCode, type Built } from "./built.js";

/**
 * The board's lock across processes: one writer at a time reads, decides and writes. A lock left by
 * a writer that died is taken over by one waiter only; a lock whose writer still runs is never taken
 * over; a writer removes the lock only while it is its own.
 */

let base: string;
let built: Built;
let worker: string;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "pinboard-lock-"));
  built = buildCode(base);
  // A writer that holds the board's lock for a while, and says whether another writer was inside with it.
  worker = path.join(base, "writer.mjs");
  fs.writeFileSync(
    worker,
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      "const [files, dir] = process.argv.slice(2);",
      "const { withBoardLock } = await import(files);",
      "const wait = new Int32Array(new SharedArrayBuffer(4));",
      "let overlap = false;",
      "try {",
      "  withBoardLock(dir, () => {",
      '    try { fs.writeFileSync(path.join(dir, "inside"), String(process.pid), { flag: "wx" }); } catch { overlap = true; return; }',
      "    Atomics.wait(wait, 0, 0, 40);",
      '    fs.rmSync(path.join(dir, "inside"));',
      "  });",
      '  process.stdout.write(overlap ? "overlap" : "ok");',
      "} catch (error) {",
      '  process.stdout.write(`refused:${error.code}`);',
      "}",
      ""
    ].join("\n")
  );
}, 60_000);

afterAll(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

/** The id of a process that ran and ended: no process has it now. */
function endedPid(): number {
  return Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).stdout.toString());
}

function board(name: string): string {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("the board's lock across processes", () => {
  it("lets one writer in at a time when a lock left by a writer that died is taken over, however many wait on it", async () => {
    const files = path.join(built.dist, "core", "files.js");
    const said: string[] = [];
    for (let round = 0; round < 6; round += 1) {
      const dir = board(`stale-${round}`);
      const lock = path.join(dir, LOCK_FILE);
      // Half the rounds: a lock as an earlier version wrote it (its process id alone), a minute old; the others: a lock of
      // this machine, just written, by a process that ended.
      if (round % 2 === 0) {
        fs.writeFileSync(lock, `${endedPid()}\n`);
        const old = new Date(Date.now() - 60_000);
        fs.utimesSync(lock, old, old);
      } else fs.writeFileSync(lock, `${endedPid()}\n${os.hostname()}\nleft-by-a-writer-that-died\n`);
      const ran = await atOnce(path.join(dir, "gate"), files, Array.from({ length: 8 }, () => ({ args: [worker, files, dir] })));
      said.push(...ran.map((entry) => entry.stdout));
      expect(fs.existsSync(lock)).toBe(false);
    }
    expect(said).toEqual(Array.from({ length: 48 }, () => "ok"));
  }, 120_000);

  it("never takes over the lock of a writer that still runs on this machine, however old the lock is", async () => {
    const dir = board("alive");
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore" });
    try {
      const lock = path.join(dir, LOCK_FILE);
      const text = `${sleeper.pid}\n${os.hostname()}\nheld-by-a-writer-that-runs\n`;
      fs.writeFileSync(lock, text);
      const old = new Date(Date.now() - 120_000);
      fs.utimesSync(lock, old, old);
      let wrote = false;
      let refused: unknown;
      try {
        withBoardLock(dir, () => {
          wrote = true;
        });
      } catch (error) {
        refused = error;
      }
      expect(wrote).toBe(false);
      expect(refused).toBeInstanceOf(BoardRefusal);
      expect((refused as BoardRefusal).code).toBe("busy");
      expect(fs.readFileSync(lock, "utf8")).toBe(text);
    } finally {
      sleeper.kill();
    }
  }, 20_000);

  it("takes over at once a lock this machine's writer left when it died, and removes only its own lock when it is done", () => {
    const dir = board("own");
    const lock = path.join(dir, LOCK_FILE);
    fs.writeFileSync(lock, `${endedPid()}\n${os.hostname()}\nleft-by-a-writer-that-died\n`);
    const start = Date.now();
    expect(withBoardLock(dir, () => "written")).toBe("written");
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(fs.existsSync(lock)).toBe(false);
    // A lock that is no longer this writer's when it is done (another's took its place) is left where it is.
    const theirs = `${process.pid + 1}\nanother-machine\nnot-mine\n`;
    withBoardLock(dir, () => {
      fs.writeFileSync(lock, theirs);
    });
    expect(fs.readFileSync(lock, "utf8")).toBe(theirs);
  });
});
