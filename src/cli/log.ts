/**
 * The package's log: `say` for a command's words (its output), `warn` for what goes wrong outside
 * them (the bin's fatal error). A host gives its own (CodeLead gives its logger); the console's
 * when it does not.
 */
export interface BoardLog {
  say(line: string): void;
  warn(line: string): void;
}

export const consoleLog: BoardLog = {
  say: (line) => console.log(line),
  warn: (line) => console.warn(line)
};
