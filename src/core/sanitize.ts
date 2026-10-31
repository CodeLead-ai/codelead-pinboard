import os from "node:os";
import path from "node:path";

/**
 * What the guard (guard.ts) asks of a sanitizer: the text with every secret written as
 * `<redacted>`, and every path of the repository and of the home folder written as `<repo>` and
 * `<home>`. The guard refuses a text when the sanitizer would change it there, so these three
 * placeholders are the contract: a host's own sanitizer (its audit pack's, say) may find more, but
 * it writes what it finds with them.
 */
export interface TextSanitizer {
  text(text: string): string;
}

/** The paths a sanitizer is made for: the repository the board is in, and the home folder. */
export interface SanitizerPaths {
  root: string;
  home: string;
}

/** Makes the sanitizer for one repository and home folder: the guard's injection point (`sanitizer` in a board's options). */
export type SanitizerFactory = (paths: SanitizerPaths) => TextSanitizer;

/**
 * The secrets a text may hold: a connection-string password, a provider's key (OpenRouter's
 * `sk-or-…`, Anthropic's `sk-ant-…`) and a bearer token.
 */
const SECRET_PATTERNS = [
  /(Password|Pwd|pwd|password)=([^;"'\s]+)/g,
  /sk-or-[A-Za-z0-9\-_]+/g,
  /sk-ant-[A-Za-z0-9\-_]+/g,
  /\b(Bearer)\s+[A-Za-z0-9\-_.]{20,}/g
];

/**
 * The board's own sanitizer: the part of CodeLead's audit-pack sanitizer that the guard uses
 * (copied from it, with its tests for that part), so that the package depends on nothing of the
 * host's. The repository's path and the home folder become `<repo>` and `<home>`, in every
 * spelling a text may carry them (as given, resolved, with either slash, and with the backslashes
 * doubled as JSON writes them), the longest first so that the repository wins over the home
 * folder it is in; connection-string passwords, provider keys and bearer tokens become
 * `<redacted>`.
 */
export class BoardSanitizer implements TextSanitizer {
  private readonly replacements: Array<[string, string]>;

  public constructor(paths: { root: string; home?: string }) {
    const home = paths.home ?? os.homedir();
    // Every spelling a text may carry is a needle: as given, resolved, and with the other slash
    // (Windows texts mix `C:\src\x` and `C:/src/x`; `path.resolve` on Windows would turn a
    // POSIX-looking root into a drive path that never matches).
    const spellings = (value: string): string[] => [...new Set([value, path.resolve(value), value.replaceAll("\\", "/"), value.replaceAll("/", "\\")])];
    const pairs: Array<[string, string]> = [
      ...spellings(paths.root).map((needle): [string, string] => [needle, "<repo>"]),
      ...spellings(home).map((needle): [string, string] => [needle, "<home>"])
    ];
    this.replacements = pairs.filter(([needle]) => needle.length > 1).sort((left, right) => right[0].length - left[0].length);
  }

  public text(text: string): string {
    let result = text;
    for (const pattern of SECRET_PATTERNS) {
      result = result.replace(pattern, (whole, first: string | undefined) => (first && /^(Password|Pwd|pwd|password|Bearer)$/.test(first) ? `${first}${whole.includes("=") ? "=" : " "}<redacted>` : "<redacted>"));
    }
    for (const [needle, placeholder] of this.replacements) {
      for (const variant of new Set([needle, needle.replaceAll("\\", "\\\\"), needle.replaceAll("\\", "/")])) {
        if (variant && result.includes(variant)) {
          result = result.replaceAll(variant, placeholder);
        }
      }
    }
    return result;
  }
}

/** The sanitizer the guard uses when the host gives none. */
export const defaultSanitizer: SanitizerFactory = (paths) => new BoardSanitizer(paths);
