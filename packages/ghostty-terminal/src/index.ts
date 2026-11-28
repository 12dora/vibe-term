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
export { classifyExplicitUri, MAX_EXPLICIT_URI_LENGTH } from './explicit-links';
export { classifyLinkModifiers, NO_LINK_MODIFIERS, shouldOpenLink } from './link-open-policy';
export type { LinkModifiers, LinkOpenInput, LinkOpenTrigger } from './link-open-policy';
export type { TerminalLinkHit, TerminalLinkTarget } from './terminal-pointer-shared';
export type {
  CompatibleTerminalBuffer,
  CompatibleTerminalLike,
  GhosttyCellDimensions,
  GhosttyCursorViewportRect,
  GhosttySelectionViewportRect,
  GhosttyPanDelta,
  GhosttyPanMetrics,
  GhosttyTerminalModeSnapshot,
  GhosttyTerminalInitOptions,
  GhosttyTerminalSize,
  GhosttyTheme,
  PredictionCell,
  PredictionFrame,
  PredictionOverlay,
  PredictionOverlayCell,
  TerminalDisposable,
  TerminalPredictionHost,
} from './types';
