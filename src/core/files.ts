import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BoardRefusal } from "./errors.js";

/**
 * How the board's files are written: whole files through a temporary file and a rename (a reader
 * never sees half a file), and every write of the board under one lock file, so that the page's
 * process, a command in a terminal and an agent's command in another never interleave their
 * read-change-write steps.
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

/** The board folders this process holds the lock of: how deep, and the lock file's text (its own, to know it again). */
const held = new Map<string, { depth: number; text: string }>();

/** Who wrote a lock file: its first line is the writer's process id, the second its machine, the third a word of its own. */
interface LockWriter {
  pid?: number;
  host?: string;
}

function writerOf(text: string): LockWriter {
  const [pid, host] = text.split("\n");
  return { ...(pid !== undefined && /^\d+$/.test(pid) ? { pid: Number(pid) } : {}), ...(host ? { host } : {}) };
}

/** True while a process with this id runs on this machine (one of another user's counts: it cannot be signalled, and it runs). */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether a lock someone else holds was left by a writer that is gone. A lock written on this machine
 * by a process that no longer runs is left, at once; one whose process still runs is held, however old
 * (a writer that takes long, or a machine that slept in the middle of a write: taking it over would let
 * two writers in). A lock this machine cannot tell about (written on another one, or by a version that
 * wrote only its process id) is left once it is older than thirty seconds, as before.
 */
function abandoned(text: string, ageMs: number): boolean {
  const writer = writerOf(text);
  // This process's own id counts as running too: another thread of it may hold the lock.
  if (writer.pid !== undefined && writer.host === os.hostname()) return !running(writer.pid);
  return ageMs > LOCK_STALE_MS;
}

/**
 * Takes over a lock its writer left (`abandoned`), so that exactly one of the writers waiting on it
 * does. The lock is first linked under a name made from what was read of it (its inode, its time and
 * its text): the link of the first waiter is made, every other waiter's link of the same name is
 * refused, and that waiter goes on waiting. The waiter whose link was made removes the lock only when
 * the linked file is the very lock it read; the lock it removes can then be no other (its writer is
 * gone, and no other waiter holds the name). A name left by a waiter that died in between is cleared
 * once it is older than thirty seconds. Where the file system makes no links, the lock is removed as
 * it was before there was this step.
 */
function takeOver(lock: string, seen: fs.Stats, text: string): void {
  const name = createHash("sha256").update(`${seen.ino}:${seen.mtimeMs}:${text}`).digest("hex").slice(0, 16);
  const mark = `${lock}.${name}.tmp`;
  try {
    fs.linkSync(lock, mark);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      try {
        // The link's own time is its inode's change time: when the link was made.
        if (Date.now() - fs.statSync(mark).ctimeMs > LOCK_STALE_MS) fs.rmSync(mark, { force: true });
      } catch {
        // Gone meanwhile: the waiter that made it is done.
      }
      return;
    }
    if (code === "ENOENT") return;
    fs.rmSync(lock, { force: true });
    return;
  }
  try {
    if (fs.statSync(mark).ino === seen.ino && fs.readFileSync(mark, "utf8") === text) fs.rmSync(lock, { force: true });
  } finally {
    fs.rmSync(mark, { force: true });
  }
}

/** Removes the lock when it is still this process's own (its text is the one this process wrote). */
function release(lock: string, text: string): void {
  try {
    if (fs.readFileSync(lock, "utf8") === text) fs.rmSync(lock, { force: true });
  } catch {
    // Gone already.
  }
}

/**
 * Runs `work` holding the board's lock (`.board.lock` in the board folder), so that one writer at a
 * time reads, decides and writes, across processes. The lock is a file made only when there is none
 * (one writer's make succeeds, the others' are refused by the file system), holding the writer's
 * process id, its machine and a word of its own. It is taken again freely by the same process (a write
 * inside a write). A lock left by a writer that is gone is taken over by one waiter (`abandoned`,
 * `takeOver`); a writer removes the lock only while it is its own. After three seconds of waiting
 * the write is refused, and nothing was written.
 */
export function withBoardLock<T>(dir: string, work: () => T): T {
  const key = path.resolve(dir);
  const mine = held.get(key);
  if (mine) {
    mine.depth += 1;
    try {
      return work();
    } finally {
      mine.depth -= 1;
    }
  }
  const lock = path.join(key, LOCK_FILE);
  const text = `${process.pid}\n${os.hostname()}\n${randomUUID()}\n`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lock, text, { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const seen = fs.statSync(lock);
        const theirs = fs.readFileSync(lock, "utf8");
        const age = Date.now() - seen.mtimeMs;
        // An empty lock is one being written this very moment (it is held), or one whose writer died before it wrote a word.
        if (theirs === "" ? age > LOCK_STALE_MS : abandoned(theirs, age)) {
          takeOver(lock, seen, theirs);
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
  held.set(key, { depth: 1, text });
  try {
    return work();
  } finally {
    held.delete(key);
    release(lock, text);
  }
}
