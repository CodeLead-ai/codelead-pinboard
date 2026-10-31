import fs from "node:fs";
import path from "node:path";
import { BoardRefusal } from "./errors.js";

/**
 * How the board's files are written: whole files through a temporary file and a rename (a reader
 * never sees half a file), and every write of the board under one lock file, so that the page's
 * process and a command in a terminal never interleave their read-change-write steps.
 */
export const LOCK_FILE = ".board.lock";
const LOCK_WAIT_MS = 3_000;
const LOCK_STALE_MS = 30_000;

export function writeFileAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, text, "utf8");
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const held = new Map<string, number>();

/**
 * Runs `work` holding the board's lock (`.board.lock` in the board folder). The lock is taken
 * again freely by the same process (a write inside a write). A lock older than thirty seconds is
 * one a process left when it died, and is taken over. After three seconds of waiting the write is
 * refused, and nothing was written.
 */
export function withBoardLock<T>(dir: string, work: () => T): T {
  const key = path.resolve(dir);
  const depth = held.get(key) ?? 0;
  if (depth > 0) {
    held.set(key, depth + 1);
    try {
      return work();
    } finally {
      held.set(key, depth);
    }
  }
  const lock = path.join(key, LOCK_FILE);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lock, `${process.pid}\n`, { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) {
        throw new BoardRefusal("busy", `Refused: another writer holds the board (${LOCK_FILE} in ${key}); nothing was written. Retry; remove the file only when no writer is running.`);
      }
      sleepSync(25);
    }
  }
  held.set(key, 1);
  try {
    return work();
  } finally {
    held.delete(key);
    fs.rmSync(lock, { force: true });
  }
}
