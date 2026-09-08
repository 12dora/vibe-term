export { createTerminalController, GhosttyTerminalController, TERMINAL_ENGINE } from './terminal';
export { FitAddon } from './terminal-fit-addon';
export { isMacPlatform, writeTextToClipboard } from './selection-clipboard';
export {
  detectLinksInLine,
  detectLinksInWrappedLines,
  detectMatchesInWrappedLines,
} from './link-detector';
export type { DetectedLink, WrappedLink, WrappedMatch, WrappedMatchKind } from './link-detector';
export {
  isWithinRoots,
  normalizePosixPath,
  resolvePathCandidate,
  resolveValidFilePath,
} from './file-path';
export type { FileLinkContext } from './file-path';
export type {
  CompatibleTerminalBuffer,
  CompatibleTerminalLike,
  GhosttyCellDimensions,
  GhosttyCursorViewportRect,
  GhosttyPanDelta,
  GhosttyPanMetrics,
  GhosttyTerminalModeSnapshot,
  GhosttyTerminalInitOptions,
  GhosttyTerminalSize,
  GhosttyTheme,
  TerminalDisposable,
} from './types';
