/**
 * @codelead/pinboard: the board between a person and their coding agents, kept as files in a
 * repository (`docs/codelead/board`: board.json, AGENTS.md, items/, events.jsonl, cursors/).
 *
 * This entry is the core (every rule about the board's files) and the command tree's factory.
 * The page's process is `@codelead/pinboard/server`, the import `@codelead/pinboard/import`, the
 * whole command tree `@codelead/pinboard/cli`.
 */
export * from "./core/index.js";
export { createBoardCommand, consoleLog, type BoardHost, type BoardLog } from "./cli/index.js";
