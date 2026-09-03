import { findByte } from './framing';
import {
  BYTE_PERCENT,
  BYTE_SPACE,
  type ControlModeBlock,
  type ControlModeParserCallbacks,
  KNOWN_NOTIFICATION_TYPES,
  MAX_BLOCK_BODY_LINES,
} from './types';
import { ControlModeUnescaper } from './unescape';

const decoder = new TextDecoder();
const MAX_INTERNED_PANE_IDS = 256;

export interface NotificationParseState {
  currentBlock: ControlModeBlock | null;
  literalBlock: boolean;
  warnedUnexpectedLine: boolean;
  warnedInvalidEscape: boolean;
  paneIds: Map<number, string>;
  unescaper: ControlModeUnescaper;
  onInvalidEscape: () => void;
}

export function createNotificationParseState(): NotificationParseState {
  const state: NotificationParseState = {
    currentBlock: null,
    literalBlock: false,
    warnedUnexpectedLine: false,
    warnedInvalidEscape: false,
    paneIds: new Map(),
    unescaper: new ControlModeUnescaper(),
    onInvalidEscape: () => warnInvalidEscape(state),
  };
  return state;
}

function warnInvalidEscape(state: NotificationParseState): void {
  if (!state.warnedInvalidEscape) {
    state.warnedInvalidEscape = true;
    console.warn('[tmex] control mode parser met invalid escape sequence, passing through');
  }
}

function decodeRange(line: Uint8Array, start: number, end: number): string {
  return decoder.decode(line.subarray(start, end));
}

function parseNumericPaneId(line: Uint8Array, start: number, end: number): number | null {
  if (line[start] !== BYTE_PERCENT || start + 1 >= end) return null;
  if (start + 2 < end && line[start + 1] === 0x30) return null;
  let value = 0;
  for (let index = start + 1; index < end; index += 1) {
    const byte = line[index] as number;
    if (byte < 0x30 || byte > 0x39) return null;
    value = value * 10 + byte - 0x30;
    if (!Number.isSafeInteger(value)) return null;
  }
  return value;
}

function decodePaneId(
  state: NotificationParseState,
  line: Uint8Array,
  start: number,
  end: number
): string {
  const numericId = parseNumericPaneId(line, start, end);
  if (numericId === null) return decodeRange(line, start, end);
  const cached = state.paneIds.get(numericId);
  if (cached) return cached;
  const paneId = decodeRange(line, start, end);
  if (state.paneIds.size >= MAX_INTERNED_PANE_IDS) state.paneIds.clear();
  state.paneIds.set(numericId, paneId);
  return paneId;
}

function pushBlockLine(state: NotificationParseState, text: string): void {
  const block = state.currentBlock;
  if (!block || block.lines.length >= MAX_BLOCK_BODY_LINES) {
    return;
  }
  block.lines.push(text);
}

function handleOutputLine(
  callbacks: ControlModeParserCallbacks,
  state: NotificationParseState,
  line: Uint8Array,
  payloadStart: number
): void {
  const paneEnd = findByte(line, BYTE_SPACE, payloadStart);
  if (paneEnd < 0) {
    return;
  }
  const paneId = decodePaneId(state, line, payloadStart, paneEnd);
  callbacks.onOutput(paneId, state.unescaper.unescape(line, paneEnd + 1, state.onInvalidEscape));
}

function handleExtendedOutputLine(
  callbacks: ControlModeParserCallbacks,
  state: NotificationParseState,
  line: Uint8Array,
  payloadStart: number
): void {
  const paneEnd = findByte(line, BYTE_SPACE, payloadStart);
  if (paneEnd < 0) {
    return;
  }
  const paneId = decodePaneId(state, line, payloadStart, paneEnd);
  for (let index = paneEnd; index + 2 < line.length; index += 1) {
    if (line[index] === BYTE_SPACE && line[index + 1] === 0x3a && line[index + 2] === BYTE_SPACE) {
      callbacks.onOutput(paneId, state.unescaper.unescape(line, index + 3, state.onInvalidEscape));
      return;
    }
  }
}

function handleBegin(
  callbacks: ControlModeParserCallbacks,
  state: NotificationParseState,
  line: Uint8Array,
  argsStart: number
): void {
  if (state.currentBlock) {
    callbacks.onBlockEnd?.(state.currentBlock);
  }
  state.currentBlock = {
    args: decodeRange(line, argsStart, line.length),
    isError: false,
    lines: [],
  };
  state.literalBlock = callbacks.onBlockBegin?.(state.currentBlock.args) ?? false;
}

function handleBlockClose(
  callbacks: ControlModeParserCallbacks,
  state: NotificationParseState,
  line: Uint8Array,
  argsStart: number,
  isError: boolean
): void {
  if (!state.currentBlock) {
    return;
  }
  const args = decodeRange(line, argsStart, line.length);
  if (args !== state.currentBlock.args) {
    const kind = isError ? 'error' : 'end';
    console.warn(
      `[tmex] control mode block guard mismatch: begin "${state.currentBlock.args}" vs ${kind} "${args}"`
    );
  }
  state.currentBlock.isError = isError;
  callbacks.onBlockEnd?.(state.currentBlock);
  state.currentBlock = null;
  state.literalBlock = false;
}

function handleExit(
  callbacks: ControlModeParserCallbacks,
  line: Uint8Array,
  argsStart: number
): void {
  const reason = argsStart < line.length ? decodeRange(line, argsStart, line.length) : null;
  callbacks.onExit(reason);
}

function handleGenericNotification(
  callbacks: ControlModeParserCallbacks,
  state: NotificationParseState,
  line: Uint8Array,
  type: string,
  argsStart: number
): void {
  if (state.currentBlock && !KNOWN_NOTIFICATION_TYPES.has(type)) {
    pushBlockLine(state, decoder.decode(line));
    return;
  }
  callbacks.onNotification({
    type,
    args: decodeRange(line, argsStart, line.length),
    raw: decoder.decode(line),
  });
}

type LineKindHandler = (
  callbacks: ControlModeParserCallbacks,
  state: NotificationParseState,
  line: Uint8Array,
  type: string,
  argsStart: number
) => void;

export const LINE_KIND_HANDLERS: Record<string, LineKindHandler> = {
  output: (callbacks, state, line, _type, argsStart) => {
    handleOutputLine(callbacks, state, line, argsStart);
  },
  'extended-output': (callbacks, state, line, _type, argsStart) => {
    handleExtendedOutputLine(callbacks, state, line, argsStart);
  },
  begin: (callbacks, state, line, _type, argsStart) => {
    handleBegin(callbacks, state, line, argsStart);
  },
  end: (callbacks, state, line, _type, argsStart) => {
    handleBlockClose(callbacks, state, line, argsStart, false);
  },
  error: (callbacks, state, line, _type, argsStart) => {
    handleBlockClose(callbacks, state, line, argsStart, true);
  },
  exit: (callbacks, _state, line, _type, argsStart) => {
    handleExit(callbacks, line, argsStart);
  },
};

export function dispatchControlModeLine(
  callbacks: ControlModeParserCallbacks,
  state: NotificationParseState,
  line: Uint8Array
): void {
  state.unescaper.withScratchLease(() => dispatchControlModeLineLeased(callbacks, state, line));
}

function dispatchControlModeLineLeased(
  callbacks: ControlModeParserCallbacks,
  state: NotificationParseState,
  line: Uint8Array
): void {
  if (line.length === 0) {
    if (state.currentBlock && state.literalBlock) {
      pushBlockLine(state, '');
    }
    return;
  }

  if (line[0] !== BYTE_PERCENT) {
    if (state.currentBlock) {
      pushBlockLine(state, decoder.decode(line));
      return;
    }
    if (!state.warnedUnexpectedLine) {
      state.warnedUnexpectedLine = true;
      console.warn(
        `[tmex] control mode parser ignored unexpected line: ${decoder.decode(line.subarray(0, 80))}`
      );
    }
    return;
  }

  const typeEnd = findByte(line, BYTE_SPACE, 0);
  const type = typeEnd < 0 ? decodeRange(line, 1, line.length) : decodeRange(line, 1, typeEnd);
  const argsStart = typeEnd < 0 ? line.length : typeEnd + 1;

  if (state.currentBlock && state.literalBlock && type !== 'end' && type !== 'error') {
    pushBlockLine(state, decoder.decode(line));
    return;
  }

  const handler = LINE_KIND_HANDLERS[type];
  if (handler) {
    handler(callbacks, state, line, type, argsStart);
    return;
  }
  handleGenericNotification(callbacks, state, line, type, argsStart);
}
