import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoardSanitizer, boardContext, cleanText, createCard, findUnsafe, initBoard, isBoardRefusal, type SanitizerFactory } from "../core/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("the board's own sanitizer (the part of the audit pack's that the guard uses)", () => {
  it("sanitizes paths longest first, passwords and keys", () => {
    const sanitizer = new BoardSanitizer({ root: "/Users/x/proj", home: "/Users/x" });
    expect(sanitizer.text("at /Users/x/proj/a and /Users/x/other; pwd=abc; sk-or-v1-abcdef Bearer ABCDEFGHIJKLMNOPQRSTUVWXYZ123")).toBe("at <repo>/a and <home>/other; pwd=<redacted>; <redacted> Bearer <redacted>");
  });

  it("finds an Anthropic key and a connection string's password, keeps the name of what it removed, and leaves a short bearer word alone", () => {
    const sanitizer = new BoardSanitizer({ root: "/work/repo", home: "/home/tester" });
    expect(sanitizer.text("key sk-ant-api03-abc_DEF-123 here")).toBe("key <redacted> here");
    expect(sanitizer.text('Server=db;User Id=sa;Password=s3cr3t!;"')).toBe('Server=db;User Id=sa;Password=<redacted>;"');
    expect(sanitizer.text("Bearer of good news")).toBe("Bearer of good news");
  });

  it("finds a Windows path in either slash, and with its backslashes doubled as JSON writes them", () => {
    const sanitizer = new BoardSanitizer({ root: "C:\\src\\repo", home: "C:\\Users\\tester" });
    expect(sanitizer.text("C:\\src\\repo\\docs\\a.md and C:/src/repo/docs/b.md")).toBe("<repo>\\docs\\a.md and <repo>/docs/b.md");
    expect(sanitizer.text('{"file":"C:\\\\Users\\\\tester\\\\notes.txt"}')).toBe('{"file":"<home>\\\\notes.txt"}');
  });

  it("changes nothing in a text without a secret or a path of the machine", () => {
    const text = "The plan's section 4, `docs/plan.md:12`, and card #7.";
    expect(new BoardSanitizer({ root: "/work/repo", home: "/home/tester" }).text(text)).toBe(text);
  });
});

describe("a host's sanitizer, given in the board's options", () => {
  /** A host's sanitizer that knows one more secret than the board's own: the word "hunter2". */
  const stricter: SanitizerFactory = (paths) => {
    const own = new BoardSanitizer(paths);
    return { text: (text) => own.text(text).replaceAll("hunter2", "<redacted>") };
  };

  it("is what the guard asks: a text it would change is refused, one it leaves is written", () => {
    const scope = { dir: "/nowhere", root: "/work/repo", home: "/home/tester" };
    expect(findUnsafe(scope, "the password is hunter2", [])).toBeUndefined();
    expect(findUnsafe({ ...scope, sanitizer: stricter }, "the password is hunter2", [])).toBe("secret");
    expect(findUnsafe({ ...scope, sanitizer: stricter }, "see /home/tester/notes.txt", [])).toBe("machine-path");
    expect(cleanText({ ...scope, sanitizer: stricter }, "the password is hunter2", [])).toEqual({ text: "the password is <redacted>", secrets: 1, paths: 0, names: 0 });
  });

  it("goes from the board's context to every write: a card that holds what the host's sanitizer finds is refused, and nothing is written", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pinboard-sanitize-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, ".git"));
    const dir = path.join(root, "docs", "codelead", "board");
    const plain = boardContext({ dir, root, home: "/home/tester", now: () => new Date("2026-10-31T09:00:00Z") });
    initBoard(plain, { name: "test", participants: [{ id: "robin", kind: "person", name: "Robin" }, { id: "claude", kind: "agent", name: "Claude Code" }] });
    const hosted = boardContext({ dir, root, home: "/home/tester", now: () => new Date("2026-10-31T09:00:00Z"), sanitizer: stricter });
    expect(hosted.sanitizer).toBe(stricter);
    let refused: unknown;
    try {
      createCard(hosted, "robin", { type: "note", title: "The login", description: "the password is hunter2" });
    } catch (error) {
      refused = error;
    }
    expect(isBoardRefusal(refused) ? refused.code : refused).toBe("secret");
    expect(fs.readdirSync(path.join(dir, "items"))).toEqual([]);
    // The board's own sanitizer does not know the word: the same card is written.
    expect(createCard(plain, "robin", { type: "note", title: "The login", description: "the password is hunter2" }).card.id).toBe(1);
  });
});
