export const MAX_LINE_BYTES = 4 * 1024 * 1024;
export const MAX_BLOCK_BODY_LINES = 4096;

export const BYTE_LF = 0x0a;
export const BYTE_SPACE = 0x20;
export const BYTE_PERCENT = 0x25;
export const BYTE_BACKSLASH = 0x5c;

export interface ControlModeNotification {
  type: string;
  args: string;
  raw: string;
}

export interface ControlModeBlock {
  args: string;
  isError: boolean;
  lines: string[];
}

export interface ControlModeParserCallbacks {
  onOutput: (paneId: string, data: Uint8Array) => void;
  onNotification: (notification: ControlModeNotification) => void;
  onExit: (reason: string | null) => void;
  onBlockBegin?: (args: string) => boolean;
  onBlockEnd?: (block: ControlModeBlock) => void;
}

export interface ControlModeParser {
  push(chunk: Uint8Array): void;
  end(): void;
}

export const KNOWN_NOTIFICATION_TYPES = new Set([
  'client-detached',
  'client-session-changed',
  'config-error',
  'continue',
  'layout-change',
  'message',
  'pane-mode-changed',
  'paste-buffer-changed',
  'paste-buffer-deleted',
  'pause',
  'session-changed',
  'session-renamed',
  'session-window-changed',
  'sessions-changed',
  'subscription-changed',
  'unlinked-window-add',
  'unlinked-window-close',
  'unlinked-window-renamed',
  'window-add',
  'window-close',
  'window-pane-changed',
  'window-renamed',
]);
