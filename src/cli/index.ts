/**
 * The command tree of Pinboard, for a host's program (`createBoardCommand({ ... })`, added as its
 * `board` command) or the package's own bin (`pinboard`): the same commands, words and exit codes.
 */
export {
  createBoardCommand,
  DEFAULT_BOARD_PORT,
  runBoardCheck,
  runBoardImport,
  runBoardInit,
  runBoardList,
  runBoardMove,
  runBoardNew,
  runBoardReply,
  runBoardServe,
  runBoardSet,
  runBoardShow,
  runBoardTidy,
  runBoardValidate,
  type BoardCheckOptions,
  type BoardCliDependencies,
  type BoardHost,
  type BoardImportOptions,
  type BoardInitOptions,
  type BoardListOptions,
  type BoardMoveOptions,
  type BoardNewOptions,
  type BoardReplyOptions,
  type BoardServeDependencies,
  type BoardServeOptions,
  type BoardSetOptions,
  type BoardShowOptions,
  type BoardTidyOptions
} from "./board.js";
export { consoleLog, type BoardLog } from "./log.js";
