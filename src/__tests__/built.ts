import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * For the tests that run the package in processes of their own (the lock across processes, the
 * dispatcher's parallel takes): the sources compiled with the package's own build settings into a
 * folder of the test's (never the dist/ of the checkout, which may be older than the sources), with
 * the package's node_modules beside it so that `commander` resolves.
 */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

export interface Built {
  /** The compiled sources (`<dist>/cli.js` is the bin, `<dist>/core/files.js` the lock). */
  dist: string;
  /** The bin, `pinboard`. */
  cli: string;
}

export function buildCode(base: string): Built {
  const out = path.join(base, "built");
  const dist = path.join(out, "dist");
  execFileSync(process.execPath, [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(ROOT, "tsconfig.build.json"), "--outDir", dist, "--declaration", "false", "--declarationMap", "false", "--sourceMap", "false"], {
    stdio: "pipe"
  });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(out, "node_modules"), "junction");
  return { dist, cli: path.join(dist, "cli.js") };
}

/** What one process wrote and how it ended. */
export interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs processes that all wait at one gate, then go at the same moment: each loads what it needs
 * first (`warm`, a module of the compiled code), says it is ready, and waits for the gate to open; the
 * gate opens once every one is ready. Each process is ended by its own pid if it runs longer than
 * `timeoutMs`; none is left running.
 */
export async function atOnce(dir: string, warm: string, runs: Array<{ args: string[] }>, timeoutMs = 30_000): Promise<Ran[]> {
  fs.mkdirSync(dir, { recursive: true });
  const gate = path.join(dir, "gate.mjs");
  fs.writeFileSync(
    gate,
    [
      'import fs from "node:fs";',
      "await import(process.env.GATE_WARM);",
      "fs.writeFileSync(process.env.GATE_READY, String(process.pid));",
      "const wait = new Int32Array(new SharedArrayBuffer(4));",
      "while (!fs.existsSync(process.env.GATE_OPEN)) Atomics.wait(wait, 0, 0, 1);",
      ""
    ].join("\n")
  );
  const open = path.join(dir, "open");
  fs.rmSync(open, { force: true });
  const children = runs.map((run, index) => {
    const ready = path.join(dir, `ready-${index}`);
    fs.rmSync(ready, { force: true });
    const child = spawn(process.execPath, ["--import", pathToFileURL(gate).href, ...run.args], {
      env: { ...process.env, GATE_WARM: pathToFileURL(warm).href, GATE_READY: ready, GATE_OPEN: open },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const done = new Promise<Ran>((resolve) =>
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      })
    );
    return { ready, done, child };
  });
  const deadline = Date.now() + timeoutMs;
  while (children.some((entry) => !fs.existsSync(entry.ready) && entry.child.exitCode === null)) {
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  fs.writeFileSync(open, "");
  return Promise.all(children.map((entry) => entry.done));
}
