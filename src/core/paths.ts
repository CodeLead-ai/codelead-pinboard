import fs from "node:fs";
import path from "node:path";

/**
 * How a card cites a file of this machine without naming the machine. A path under the
 * repository is written as its path in the repository (`docs/plan.md`); a path under the
 * workspace, the folder that holds the repositories a card may cite (board.json's `workspace`,
 * the repository's parent when not given), as `<repository>:<path>` (`ledgerbook-rebuild:docs/x.md`),
 * the attachments' own form, which the page links to the editor when the file is here. Both are
 * lossless, so every write makes them. A path under the home folder outside the workspace has no
 * such form: written as the audit pack's sanitizer writes it (`<home>/…`), it loses the folder it
 * was in, so that rewrite is made only when the writer asks for it.
 */
export interface PathScope {
  /** The repository: a path under it is written as its path in the repository. */
  root: string;
  /** The workspace: a path under it is written as `<repository>:<path>`. */
  workspace: string;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A home-relative path, `~/…` (or `~\…`), where a path may begin: not inside a word or another path
 * (`a~/b`, `https://example.com/~/x` hold none). The groups: the slash, and the path's first part.
 */
const HOME_RELATIVE = /(?<![\p{L}\p{N}_~.\/\\-])~([\/\\])([^\s`'"()\[\]<>,;:\/\\]*)/gu;

/**
 * The text with each home-relative path of this machine written from the home folder itself
 * (`~/notes/log.txt` as `/home/robin/notes/log.txt`), so that the rules for a path of this machine
 * read it as the path it is: under the repository or the workspace it is then cited as a card
 * cites those, and under the home folder it is refused, or written as `<home>/…` when the writer
 * asks. A `~/` path is one of this machine when the file or folder its first part names is in the
 * home folder (`~/notes/…` when the home folder holds `notes`; `~/` alone is the home folder): an
 * application-relative path such as ASP.NET's `~/Views/Home/Index.cshtml` names nothing there, and
 * is left as it is.
 */
export function expandHomeRelative(text: string, home: string): string {
  if (!text.includes("~")) return text;
  return text.replace(HOME_RELATIVE, (whole, slash: string, first: string) => {
    const part = first.replace(/\.+$/, "");
    let here: boolean;
    try {
      here = fs.existsSync(path.join(home, part));
    } catch {
      here = false;
    }
    return here ? `${home}${slash}${first}` : whole;
  });
}

/**
 * Rewrites the paths of this machine that point into the repository or the workspace: under the
 * repository, the path in it; under the workspace, `<repository>:<path>` (the repository's name
 * alone for its own folder).
 */
export function rewriteMachinePaths(text: string, scope: PathScope): { text: string; rewritten: string[] } {
  const rewritten: string[] = [];
  const tail = "((?:/[^\\s`'\"()\\[\\]<>,;]*)?)";
  const rootPattern = new RegExp(`${escapeRegex(scope.root)}(?=[/\\s\`'"()\\[\\],;:]|$)${tail}`, "g");
  let result = text.replace(rootPattern, (_whole, rest: string) => {
    const relative = rest.replace(/^\/+/, "").replace(/\.+$/, "");
    const written = relative || ".";
    rewritten.push(written);
    return written + rest.slice(rest.replace(/\.+$/, "").length);
  });
  const workspacePattern = new RegExp(`${escapeRegex(scope.workspace)}/([^\\s\`'"()\\[\\]<>,;/]+)${tail}`, "g");
  result = result.replace(workspacePattern, (_whole, name: string, rest: string) => {
    const inner = rest.replace(/^\/+/, "").replace(/\.+$/, "");
    const written = inner ? `${name}:${inner}` : name.replace(/\.+$/, "");
    rewritten.push(written);
    return written + (inner ? rest.slice(rest.replace(/\.+$/, "").length) : name.slice(name.replace(/\.+$/, "").length));
  });
  return { text: result, rewritten };
}

/**
 * Rewrites every path under the home folder as the audit pack's sanitizer writes it: the home
 * folder becomes `<home>` and the rest of the path stays (`<home>/Downloads/notes.txt`). Every
 * spelling the sanitizer looks for is looked for here (as given, resolved, with either slash),
 * longest first, so that nothing it would still call a path of this machine is left behind.
 */
export function rewriteHomePaths(text: string, home: string): { text: string; rewritten: string[] } {
  const rewritten: string[] = [];
  const spellings = [...new Set([home, path.resolve(home), home.replaceAll("\\", "/"), home.replaceAll("/", "\\")])]
    .filter((spelling) => spelling.length > 1)
    .sort((left, right) => right.length - left.length);
  const tail = "((?:[/\\\\][^\\s`'\"()\\[\\]<>,;]*)?)";
  let result = text;
  for (const spelling of spellings) {
    result = result.replace(new RegExp(`${escapeRegex(spelling)}${tail}`, "g"), (_whole, rest: string) => {
      rewritten.push(`<home>${rest.replace(/\.+$/, "")}`);
      return `<home>${rest}`;
    });
  }
  return { text: result, rewritten };
}
