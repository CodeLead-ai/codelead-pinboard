/**
 * The YAML a card's front matter is written in, read and written by the board itself so that the
 * core needs no package. Read: block mappings and lists, flow lists `[a, b]` and mappings
 * `{ k: v }`, plain, single- and double-quoted scalars, literal (`|`) and folded (`>`) block
 * scalars, and comments. A plain scalar resolves as YAML 1.2's core schema says (null, true and
 * false, integers, floats), so a time such as 2026-10-03T00:40:00Z stays text. Anchors, aliases,
 * tags, complex keys, a second document and a plain value holding ": " are refused, each with
 * the line it is on, so that what the board accepts every other YAML reader accepts too.
 *
 * Written: a word of letters, digits and `. _ / : + -` stays plain when every reader (YAML 1.1
 * ones included) reads it back as the same text; anything else is double-quoted.
 */
export type YamlScalar = null | boolean | number | string;
export type YamlValue = YamlScalar | YamlValue[] | YamlMap;
export interface YamlMap {
  [key: string]: YamlValue;
}

export class YamlError extends Error {
  public readonly line: number;

  public constructor(message: string, line: number) {
    super(`line ${line}: ${message}`);
    this.name = "YamlError";
    this.line = line;
  }
}

const SEQUENCE_ITEM = /^-( |$)/;

function has(map: YamlMap, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, key);
}

/** Sets a key without ever touching the object's prototype, whatever the key is called. */
function setKey(map: YamlMap, key: string, value: YamlValue): void {
  Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
}

function indentOf(line: string, lineNo: number): number {
  let index = 0;
  while (index < line.length && line[index] === " ") index += 1;
  if (line[index] === "\t" && line.trim() !== "") {
    throw new YamlError("a tab in the indentation (YAML indents with spaces)", lineNo);
  }
  return index;
}

function spacesOf(line: string): number {
  let index = 0;
  while (index < line.length && line[index] === " ") index += 1;
  return index;
}

function isTrivia(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

/** What a plain scalar means, as YAML 1.2's core schema reads it. */
export function resolvePlain(text: string): YamlScalar {
  if (text === "" || /^(~|null|Null|NULL)$/.test(text)) return null;
  if (/^(true|True|TRUE)$/.test(text)) return true;
  if (/^(false|False|FALSE)$/.test(text)) return false;
  if (/^[-+]?[0-9]+$/.test(text)) {
    const number = Number(text);
    return Number.isSafeInteger(number) ? number : text;
  }
  if (/^0o[0-7]+$/.test(text)) return parseInt(text.slice(2), 8);
  if (/^0x[0-9a-fA-F]+$/.test(text)) return parseInt(text.slice(2), 16);
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(text)) return Number(text);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(text)) return text.startsWith("-") ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(text)) return NaN;
  return text;
}

/**
 * Reads a quoted scalar that starts at `start` (a `"` or a `'`), across line breaks when the
 * text holds them (a line break folds to a space, an empty line to a line break). Undefined when
 * the closing quote is not in the text.
 */
function scanQuoted(text: string, start: number, lineNo = 0): { value: string; end: number } | undefined {
  const quote = text[start];
  let out = "";
  let index = start + 1;
  const fold = (): void => {
    out = out.replace(/[ \t]+$/, "");
    let breaks = 0;
    while (index < text.length && /[ \t\n]/.test(text[index]!)) {
      if (text[index] === "\n") breaks += 1;
      index += 1;
    }
    out += breaks <= 1 ? " " : "\n".repeat(breaks - 1);
  };
  while (index < text.length) {
    const char = text[index]!;
    if (quote === "'") {
      if (char === "'") {
        if (text[index + 1] === "'") {
          out += "'";
          index += 2;
          continue;
        }
        return { value: out, end: index + 1 };
      }
      if (char === "\n") {
        fold();
        continue;
      }
      out += char;
      index += 1;
      continue;
    }
    if (char === '"') return { value: out, end: index + 1 };
    if (char === "\n") {
      fold();
      continue;
    }
    if (char !== "\\") {
      out += char;
      index += 1;
      continue;
    }
    const escape = text[index + 1];
    const simple: Record<string, string> = {
      "0": "\0", a: "\x07", b: "\b", t: "\t", "\t": "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b",
      " ": " ", '"': '"', "/": "/", "\\": "\\", N: "\x85", _: "\xa0", L: " ", P: " "
    };
    if (escape === undefined) return undefined;
    if (escape === "\n") {
      // An escaped line break joins the lines with nothing between them.
      index += 2;
      while (index < text.length && /[ \t]/.test(text[index]!)) index += 1;
      continue;
    }
    if (escape in simple) {
      out += simple[escape];
      index += 2;
      continue;
    }
    const width = escape === "x" ? 2 : escape === "u" ? 4 : escape === "U" ? 8 : 0;
    const hex = text.slice(index + 2, index + 2 + width);
    if (width === 0 || !/^[0-9a-fA-F]+$/.test(hex) || hex.length !== width) {
      throw new YamlError(`an escape "\\${escape}" that YAML does not have`, lineNo);
    }
    out += String.fromCodePoint(parseInt(hex, 16));
    index += 2 + width;
  }
  return undefined;
}

/** Splits `key: rest` (a line without its indentation); undefined when the line holds no key. */
function splitKey(content: string): { key: string; rest: string } | undefined {
  if (content.startsWith('"') || content.startsWith("'")) {
    const quoted = scanQuoted(content.split("\n")[0]!, 0);
    if (!quoted) return undefined;
    const after = content.slice(quoted.end);
    if (!/^\s*:(\s|$)/.test(after)) return undefined;
    return { key: quoted.value, rest: after.slice(after.indexOf(":") + 1) };
  }
  if (/^[[\]{}#&*!|>%@`,]/.test(content)) return undefined;
  const colon = content.search(/:(\s|$)/);
  if (colon <= 0) return undefined;
  const key = content.slice(0, colon).trimEnd();
  if (key === "" || /\s#/.test(key)) return undefined;
  return { key, rest: content.slice(colon + 1) };
}

/** Cuts a comment (`#` after a space) off a plain scalar. */
function stripPlainComment(text: string): string {
  const at = text.search(/\s#/);
  return at === -1 ? text : text.slice(0, at);
}

/** True once the first bracket of the text is closed, quotes taken into account. */
function flowClosed(text: string, lineNo: number): boolean {
  let depth = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"' || char === "'") {
      const quoted = scanQuoted(text, index, lineNo);
      if (!quoted) return false;
      index = quoted.end;
      continue;
    }
    if (char === "[" || char === "{") depth += 1;
    if (char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return true;
    }
    index += 1;
  }
  return false;
}

function fold(lines: string[]): string {
  let out = "";
  let blanks = 0;
  let previous: "none" | "text" | "more" = "none";
  for (const line of lines) {
    if (line === "") {
      blanks += 1;
      continue;
    }
    const more = /^\s/.test(line);
    if (previous === "none") out += "\n".repeat(blanks) + line;
    else if (blanks > 0) out += "\n".repeat(more || previous === "more" ? blanks + 1 : blanks) + line;
    else if (more || previous === "more") out += `\n${line}`;
    else out += ` ${line}`;
    blanks = 0;
    previous = more ? "more" : "text";
  }
  return out;
}

class FlowReader {
  private index = 0;

  public constructor(private readonly text: string, private readonly lineNo: number) {}

  public readAll(): YamlValue {
    const value = this.readNode();
    this.space();
    const rest = this.text.slice(this.index).trim();
    if (rest !== "" && !rest.startsWith("#")) throw new YamlError(`text after the closing bracket: ${rest}`, this.lineNo);
    return value;
  }

  private space(): void {
    while (this.index < this.text.length && /\s/.test(this.text[this.index]!)) this.index += 1;
  }

  private readNode(): YamlValue {
    this.space();
    const char = this.text[this.index];
    if (char === "[") return this.readList();
    if (char === "{") return this.readMap();
    if (char === '"' || char === "'") return this.readQuoted();
    if (char === undefined) throw new YamlError("a value is missing", this.lineNo);
    if (char === "&" || char === "*" || char === "!") throw new YamlError("anchors, aliases and tags are not read here", this.lineNo);
    return resolvePlain(this.readPlain());
  }

  private readQuoted(): string {
    const quoted = scanQuoted(this.text, this.index, this.lineNo);
    if (!quoted) throw new YamlError("a quoted text that is never closed", this.lineNo);
    this.index = quoted.end;
    return quoted.value;
  }

  private readPlain(): string {
    const start = this.index;
    while (this.index < this.text.length) {
      const char = this.text[this.index]!;
      if (char === "," || char === "[" || char === "]" || char === "{" || char === "}") break;
      if (char === ":" && /[\s,[\]{}]/.test(this.text[this.index + 1] ?? " ")) break;
      if (char === "#" && this.index > start && /\s/.test(this.text[this.index - 1]!)) break;
      this.index += 1;
    }
    return this.text.slice(start, this.index).trim();
  }

  private readList(): YamlValue[] {
    this.index += 1;
    const items: YamlValue[] = [];
    for (;;) {
      this.space();
      if (this.text[this.index] === "]") {
        this.index += 1;
        return items;
      }
      items.push(this.readNode());
      this.space();
      const char = this.text[this.index];
      if (char === ",") {
        this.index += 1;
        continue;
      }
      if (char === "]") {
        this.index += 1;
        return items;
      }
      if (char === ":") throw new YamlError("a key: value pair inside [ ] is not read here (write it inside { })", this.lineNo);
      throw new YamlError("a , or a ] was expected in the list", this.lineNo);
    }
  }

  private readMap(): YamlMap {
    this.index += 1;
    const map: YamlMap = {};
    for (;;) {
      this.space();
      if (this.text[this.index] === "}") {
        this.index += 1;
        return map;
      }
      const char = this.text[this.index];
      const key = char === '"' || char === "'" ? this.readQuoted() : this.readPlain();
      if (key === "") throw new YamlError("a key is missing inside { }", this.lineNo);
      this.space();
      let value: YamlValue = null;
      if (this.text[this.index] === ":") {
        this.index += 1;
        this.space();
        const next = this.text[this.index];
        value = next === "," || next === "}" ? null : this.readNode();
      }
      if (has(map, key)) throw new YamlError(`the key "${key}" appears twice`, this.lineNo);
      setKey(map, key, value);
      this.space();
      const after = this.text[this.index];
      if (after === ",") {
        this.index += 1;
        continue;
      }
      if (after === "}") {
        this.index += 1;
        return map;
      }
      throw new YamlError("a , or a } was expected in the mapping", this.lineNo);
    }
  }
}

class BlockReader {
  private pos = 0;
  private readonly lines: string[];

  public constructor(lines: string[], private readonly firstLineNo: number) {
    this.lines = [...lines];
  }

  private lineNo(index: number): number {
    return this.firstLineNo + index;
  }

  private skipTrivia(): void {
    while (this.pos < this.lines.length && isTrivia(this.lines[this.pos]!)) this.pos += 1;
  }

  public readDocument(): YamlMap {
    this.skipTrivia();
    if (this.pos >= this.lines.length) return {};
    const line = this.lines[this.pos]!;
    if (indentOf(line, this.lineNo(this.pos)) !== 0) throw new YamlError("the first key is indented", this.lineNo(this.pos));
    if (SEQUENCE_ITEM.test(line)) throw new YamlError("a list where keys were expected", this.lineNo(this.pos));
    const map = this.readMapping(0);
    this.skipTrivia();
    if (this.pos < this.lines.length) throw new YamlError("a line that belongs to no key", this.lineNo(this.pos));
    return map;
  }

  private readNested(parentIndent: number, listAtParent: boolean): YamlValue {
    this.skipTrivia();
    if (this.pos >= this.lines.length) return null;
    const line = this.lines[this.pos]!;
    const indent = indentOf(line, this.lineNo(this.pos));
    const content = line.slice(indent);
    const list = SEQUENCE_ITEM.test(content);
    if (indent > parentIndent) {
      if (list) return this.readList(indent);
      // A value may begin on the line after its key: a quoted text, a [ ] or { }, or plain words.
      if (!splitKey(content)) {
        const at = this.pos;
        this.pos += 1;
        if (/^["']/.test(content)) return this.readQuotedValue(content, at);
        if (/^[[{]/.test(content)) return this.readFlow(content, parentIndent, at);
        return this.readPlain(content, parentIndent, at);
      }
      return this.readMapping(indent);
    }
    if (indent === parentIndent && list && listAtParent) return this.readList(indent);
    return null;
  }

  private readMapping(indent: number): YamlMap {
    const map: YamlMap = {};
    for (;;) {
      this.skipTrivia();
      if (this.pos >= this.lines.length) break;
      const line = this.lines[this.pos]!;
      const lineIndent = indentOf(line, this.lineNo(this.pos));
      if (lineIndent < indent) break;
      if (lineIndent > indent) throw new YamlError("a line indented deeper than the keys around it", this.lineNo(this.pos));
      const content = line.slice(lineIndent);
      if (SEQUENCE_ITEM.test(content)) break;
      if (content.startsWith("? ") || content === "?") throw new YamlError("complex keys are not read here", this.lineNo(this.pos));
      if (content === "---" || content === "...") throw new YamlError("a second document is not read here", this.lineNo(this.pos));
      const split = splitKey(content);
      if (!split) throw new YamlError(`"${content.trim()}" is neither a key nor a list item`, this.lineNo(this.pos));
      if (has(map, split.key)) throw new YamlError(`the key "${split.key}" appears twice`, this.lineNo(this.pos));
      const at = this.pos;
      this.pos += 1;
      setKey(map, split.key, this.readValue(split.rest, indent, at, true));
    }
    return map;
  }

  private readList(indent: number): YamlValue[] {
    const items: YamlValue[] = [];
    for (;;) {
      this.skipTrivia();
      if (this.pos >= this.lines.length) break;
      const line = this.lines[this.pos]!;
      const lineIndent = indentOf(line, this.lineNo(this.pos));
      if (lineIndent < indent) break;
      if (lineIndent > indent) throw new YamlError("a line indented deeper than the list items around it", this.lineNo(this.pos));
      const content = line.slice(lineIndent);
      if (!SEQUENCE_ITEM.test(content)) break;
      const after = content.slice(1);
      const text = after.trimStart();
      const column = lineIndent + 1 + (after.length - text.length);
      const at = this.pos;
      if (text === "" || text.startsWith("#")) {
        this.pos += 1;
        items.push(this.readNested(lineIndent, false));
        continue;
      }
      const nestedList = SEQUENCE_ITEM.test(text);
      if (nestedList || (!/^[[{"'|>]/.test(text) && splitKey(text))) {
        // "- key: value" or "- - item": the item's own block begins at its column on this line.
        this.lines[at] = " ".repeat(column) + text;
        items.push(nestedList ? this.readList(column) : this.readMapping(column));
        continue;
      }
      this.pos += 1;
      items.push(this.readValue(text, lineIndent, at, false));
    }
    return items;
  }

  private readValue(rest: string, indent: number, at: number, mappingValue: boolean): YamlValue {
    const text = rest.trim();
    if (text === "" || text.startsWith("#")) return this.readNested(indent, mappingValue);
    const first = text[0]!;
    if (first === "&" || first === "*" || first === "!") throw new YamlError("anchors, aliases and tags are not read here", this.lineNo(at));
    if (first === "|" || first === ">") return this.readBlockScalar(text, indent, at);
    if (first === "[" || first === "{") return this.readFlow(text, indent, at);
    if (first === '"' || first === "'") return this.readQuotedValue(text, at);
    return this.readPlain(text, indent, at);
  }

  private readFlow(text: string, indent: number, at: number): YamlValue {
    let source = text;
    while (!flowClosed(source, this.lineNo(at))) {
      const next = this.lines[this.pos];
      if (next === undefined || (next.trim() !== "" && spacesOf(next) <= indent)) {
        throw new YamlError("a [ or a { that is never closed", this.lineNo(at));
      }
      source += ` ${next.trim()}`;
      this.pos += 1;
    }
    return new FlowReader(source, this.lineNo(at)).readAll();
  }

  private readQuotedValue(text: string, at: number): string {
    let source = text;
    let quoted = scanQuoted(source, 0, this.lineNo(at));
    while (!quoted) {
      const next = this.lines[this.pos];
      if (next === undefined) throw new YamlError("a quoted text that is never closed", this.lineNo(at));
      source += `\n${next}`;
      this.pos += 1;
      quoted = scanQuoted(source, 0, this.lineNo(at));
    }
    const rest = source.slice(quoted.end).trim();
    if (rest !== "" && !rest.startsWith("#")) throw new YamlError(`text after the closing quote: ${rest}`, this.lineNo(at));
    return quoted.value;
  }

  private readPlain(text: string, indent: number, at: number): YamlScalar {
    const parts = [stripPlainComment(text).trim()];
    while (this.pos < this.lines.length) {
      const next = this.lines[this.pos]!;
      if (next.trim() === "" || next.trim().startsWith("#") || indentOf(next, this.lineNo(this.pos)) <= indent) break;
      parts.push(stripPlainComment(next).trim());
      this.pos += 1;
    }
    for (const part of parts) {
      if (/:(\s|$)/.test(part)) {
        throw new YamlError(`a plain value holds ": " (write it in double quotes): ${part}`, this.lineNo(at));
      }
    }
    return parts.length === 1 ? resolvePlain(parts[0]!) : parts.join(" ");
  }

  private readBlockScalar(header: string, indent: number, at: number): string {
    const match = /^([|>])([1-9]?)([+-]?)([1-9]?)\s*(#.*)?$/.exec(header);
    if (!match) throw new YamlError(`"${header}" is not a block scalar header this reader knows`, this.lineNo(at));
    const literal = match[1] === "|";
    const explicit = Number(match[2] || match[4] || 0);
    const chomp = match[3] ?? "";
    let contentIndent = explicit ? indent + explicit : 0;
    const content: string[] = [];
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos]!;
      if (line.trim() === "") {
        content.push("");
        this.pos += 1;
        continue;
      }
      const lineIndent = spacesOf(line);
      if (lineIndent <= indent) break;
      if (contentIndent === 0) contentIndent = lineIndent;
      if (lineIndent < contentIndent) break;
      content.push(line.slice(contentIndent));
      this.pos += 1;
    }
    let end = content.length;
    while (end > 0 && content[end - 1] === "") end -= 1;
    const body = content.slice(0, end);
    const trailing = content.length - end;
    if (body.length === 0) return chomp === "+" ? "\n".repeat(trailing) : "";
    const text = literal ? body.join("\n") : fold(body);
    if (chomp === "-") return text;
    if (chomp === "+") return `${text}\n${"\n".repeat(trailing)}`;
    return `${text}\n`;
  }
}

/**
 * Reads YAML text that is one mapping (a card's front matter). `firstLineNo` is the number of the
 * text's first line in its file, so that an error names the file's line.
 */
export function parseYamlMapping(text: string, firstLineNo = 1): YamlMap {
  return new BlockReader(text.split("\n"), firstLineNo).readDocument();
}

/** A top-level key of a mapping with the exact lines it was written in. */
export interface YamlEntry {
  key: string;
  /** The key's line and every line of its value. */
  lines: string[];
  /** Blank and comment lines between this value and the next key: kept when the entry is rewritten. */
  trailing: string[];
}

const BLOCK_HEADER = /(?:^|\s)[|>][1-9]?[+-]?[1-9]?\s*(?:#.*)?$/;
const KEEP_HEADER = /(?:^|\s)[|>](?:[1-9]?\+|\+[1-9]?)\s*(?:#.*)?$/;

/**
 * Splits a mapping's text into its top-level entries, each with its own lines, so that a writer
 * can replace one entry and leave every other byte as it was. Joining `leading` and each entry's
 * `lines` and `trailing` gives the text back.
 */
export function splitEntries(text: string): { leading: string[]; entries: YamlEntry[] } {
  const leading: string[] = [];
  const entries: YamlEntry[] = [];
  let current: YamlEntry | undefined;
  for (const line of text.split("\n")) {
    const starts = line !== "" && !/^[\s#]/.test(line) && !SEQUENCE_ITEM.test(line);
    if (starts) {
      current = { key: splitKey(line)?.key ?? line, lines: [line], trailing: [] };
      entries.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      leading.push(line);
    }
  }
  for (const entry of entries) {
    const blockScalar = entry.lines.some((line) => BLOCK_HEADER.test(line));
    // A block that keeps its trailing line breaks (`|+`) owns the blank lines after it.
    if (entry.lines.some((line) => KEEP_HEADER.test(line))) continue;
    while (entry.lines.length > 1) {
      const last = entry.lines[entry.lines.length - 1]!;
      const blank = last.trim() === "";
      const comment = !blockScalar && last.trimStart().startsWith("#");
      if (!blank && !comment) break;
      entry.trailing.unshift(entry.lines.pop()!);
    }
  }
  return { leading, entries };
}

export function joinEntries(leading: string[], entries: YamlEntry[]): string {
  return [...leading, ...entries.flatMap((entry) => [...entry.lines, ...entry.trailing])].join("\n");
}

const PLAIN_WORD = /^[A-Za-z0-9][A-Za-z0-9._/:+-]*$/;

/** True when the text can be written without quotes and every YAML reader reads it back as this same text. */
export function isPlainWord(text: string): boolean {
  if (!PLAIN_WORD.test(text) || text.endsWith(":")) return false;
  if (typeof resolvePlain(text) !== "string") return false;
  // What YAML 1.1 readers take for something else: yes and no, on and off, 1_000, 1:20.
  if (/^(y|n|yes|no|on|off)$/i.test(text)) return false;
  if (/^[-+]?[0-9][0-9_]*(\.[0-9_]*)?$/.test(text) || /^[0-9]+(:[0-5]?[0-9])+(\.[0-9]*)?$/.test(text)) return false;
  return true;
}

function formatNumber(value: number): string {
  if (Number.isNaN(value)) return ".nan";
  if (value === Infinity) return ".inf";
  if (value === -Infinity) return "-.inf";
  return String(value);
}

/** A scalar as the board writes it: a plain word when it is one, else double-quoted (`quote` forces quotes). */
export function formatScalar(value: YamlScalar, quote = false): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return formatNumber(value);
  return !quote && isPlainWord(value) ? value : JSON.stringify(value);
}

export function formatKey(key: string): string {
  return isPlainWord(key) ? key : JSON.stringify(key);
}

function isScalar(value: YamlValue): value is YamlScalar {
  return value === null || typeof value !== "object";
}

/** The value written on one line (`[a, b]`, `{ k: v }`), or undefined when a value in it cannot be. */
export function formatFlow(value: YamlValue, quotedKeys: ReadonlySet<string> = new Set()): string | undefined {
  if (isScalar(value)) return formatScalar(value);
  if (Array.isArray(value)) {
    const parts = value.map((item) => formatFlow(item));
    return parts.some((part) => part === undefined) ? undefined : `[${parts.join(", ")}]`;
  }
  const parts: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const written = isScalar(child) ? formatScalar(child, quotedKeys.has(key)) : formatFlow(child);
    if (written === undefined) return undefined;
    parts.push(`${formatKey(key)}: ${written}`);
  }
  return parts.length === 0 ? "{}" : `{ ${parts.join(", ")} }`;
}

/** True when a text with line breaks can be written as a literal block (`|`) and read back the same. */
function literalSafe(text: string): boolean {
  if (!text.includes("\n") || text.includes("\r")) return false;
  const lines = text.replace(/\n+$/, "").split("\n");
  if (lines[0] === "" || /^\s/.test(lines[0]!)) return false;
  return lines.every((line) => line === "" || line.trim() !== "");
}

function literalLines(text: string, indent: number): { header: string; lines: string[] } {
  const trailing = /\n*$/.exec(text)![0].length;
  const header = trailing === 0 ? "|-" : trailing === 1 ? "|" : "|+";
  const pad = " ".repeat(indent);
  const lines = text.replace(/\n+$/, "").split("\n").map((line) => (line === "" ? "" : pad + line));
  for (let extra = 1; extra < trailing; extra += 1) lines.push("");
  return { header, lines };
}

function formatListItem(item: YamlValue, indent: number, width: number): string[] {
  const pad = " ".repeat(indent);
  if (typeof item === "string" && literalSafe(item)) {
    const literal = literalLines(item, indent + 2);
    return [`${pad}- ${literal.header}`, ...literal.lines];
  }
  if (isScalar(item)) return [`${pad}- ${formatScalar(item)}`];
  const inline = formatFlow(item);
  if (inline !== undefined && `${pad}- ${inline}`.length <= width) return [`${pad}- ${inline}`];
  if (Array.isArray(item)) {
    return item.length === 0 ? [`${pad}- []`] : [`${pad}-`, ...item.flatMap((child) => formatListItem(child, indent + 2, width))];
  }
  const keys = Object.keys(item);
  if (keys.length === 0) return [`${pad}- {}`];
  const lines = keys.flatMap((key) => formatEntry(key, item[key]!, indent + 2, width));
  lines[0] = `${pad}- ${lines[0]!.slice(indent + 2)}`;
  return lines;
}

/**
 * One `key: value` of a block mapping, at `indent`, as lines: scalars on the key's line, text with
 * line breaks as a literal block, small lists and mappings on one line when they fit in `width`,
 * larger ones as blocks.
 */
export function formatEntry(key: string, value: YamlValue, indent = 0, width = 120): string[] {
  const pad = " ".repeat(indent);
  const name = formatKey(key);
  if (typeof value === "string" && literalSafe(value)) {
    const literal = literalLines(value, indent + 2);
    return [`${pad}${name}: ${literal.header}`, ...literal.lines];
  }
  if (isScalar(value)) return [`${pad}${name}: ${formatScalar(value)}`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}${name}: []`];
    const inline = formatFlow(value);
    if (inline !== undefined && `${pad}${name}: ${inline}`.length <= width) return [`${pad}${name}: ${inline}`];
    return [`${pad}${name}:`, ...value.flatMap((item) => formatListItem(item, indent + 2, width))];
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return [`${pad}${name}: {}`];
  return [`${pad}${name}:`, ...keys.flatMap((child) => formatEntry(child, value[child]!, indent + 2, width))];
}

/** Deep equality of two YAML values (key order ignored, NaN equal to NaN). */
export function sameValue(left: YamlValue | undefined, right: YamlValue | undefined): boolean {
  if (left === right) return true;
  if (typeof left === "number" && typeof right === "number") return Number.isNaN(left) && Number.isNaN(right);
  if (left === null || right === null || left === undefined || right === undefined) return false;
  if (typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
  }
  const leftMap = left as YamlMap;
  const rightMap = right as YamlMap;
  const leftKeys = Object.keys(leftMap);
  const rightKeys = Object.keys(rightMap);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => has(rightMap, key) && sameValue(leftMap[key], rightMap[key]));
}
