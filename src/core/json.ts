/**
 * JSON as the board writes it (`board.json`, the cursors): a value goes on one line when that
 * line fits in `width` characters, as `{ "k": v }` and `["a", "b"]`; otherwise it is broken one
 * member per line, two spaces deeper, and each member is tried on one line again. That is the
 * layout of the design's own examples. No trailing line break: the caller adds the file's own.
 */
export function formatJson(value: unknown, width = 120): string {
  return format(value, 0, "", false, width);
}

function members(value: object): Array<[string, unknown]> {
  return Object.entries(value).filter(([, member]) => member !== undefined);
}

function inline(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => inline(item === undefined ? null : item)).join(", ")}]`;
  const entries = members(value);
  return entries.length === 0 ? "{}" : `{ ${entries.map(([key, member]) => `${JSON.stringify(key)}: ${inline(member)}`).join(", ")} }`;
}

function format(value: unknown, indent: number, prefix: string, comma: boolean, width: number): string {
  const pad = " ".repeat(indent);
  const end = comma ? "," : "";
  const one = `${pad}${prefix}${inline(value)}${end}`;
  if (value === null || typeof value !== "object" || one.length <= width) return one;
  if (Array.isArray(value)) {
    if (value.length === 0) return one;
    const items = value.map((item, index) => format(item === undefined ? null : item, indent + 2, "", index < value.length - 1, width));
    return `${pad}${prefix}[\n${items.join("\n")}\n${pad}]${end}`;
  }
  const entries = members(value);
  if (entries.length === 0) return one;
  const items = entries.map(([key, member], index) => format(member, indent + 2, `${JSON.stringify(key)}: `, index < entries.length - 1, width));
  return `${pad}${prefix}{\n${items.join("\n")}\n${pad}}${end}`;
}
