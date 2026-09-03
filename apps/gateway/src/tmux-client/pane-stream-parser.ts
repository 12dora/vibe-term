import { handleCsi, maybeEmitThemeSubscription } from './pane-stream/csi-handler';
import { handleEsc } from './pane-stream/esc-handler';
import { handleNormal } from './pane-stream/normal-handler';
import { handleOsc, handleScreenTitle } from './pane-stream/osc-handlers';
import {
  EMPTY_UINT8,
  MAX_CSI_BYTES,
  type ParserContext,
  appendDcsRun,
  appendOscPayloadRun,
  appendTitleRun,
  createParserOutput,
  createParserState,
  takeOutput,
  writeByte,
  writeBytes,
  writeRun,
} from './pane-stream/parser-state';
import {
  handleDcsDetect,
  handleTmuxPassthrough,
  refillIncompleteCsi,
} from './pane-stream/tmux-passthrough-handler';

export type PaneStreamNotification = {
  source: 'osc9' | 'osc99' | 'osc777' | 'osc1337';
  title?: string;
  body: string;
};

// OSC 133 语义提示符标记（FinalTerm / shell 集成）：A 提示符开始 / B 命令开始 /
// C 输出开始 / D 命令结束（带退出码）。run_command 据此划分命令块。
export type PromptMarker = {
  kind: 'A' | 'B' | 'C' | 'D';
  exitCode: number | null;
  // kind 之后的分号分隔参数（如 D 的退出码、我们注入的 tmex=<nonce>）
  params: string[];
};

export interface PaneStreamParserOptions {
  onTitle: (title: string) => void;
  onCurrentPath?: (currentPath: string) => void;
  onBell: () => void;
  onNotification: (notification: PaneStreamNotification) => void;
  onPromptMarker?: (marker: PromptMarker) => void;
  onClipboardWrite?: (text: string) => void;
  now?: () => number;
  // pane 内程序声明/撤销 DEC private mode 2031（主题变化通知订阅，CSI ?2031h / ?2031l）
  onThemeSubscription?: (subscribed: boolean) => void;
}

export interface PaneStreamParser {
  push(data: Uint8Array, materializeOutput?: boolean): Uint8Array;
}

function dispatchPaneStreamByte(ctx: ParserContext, byte: number): void {
  switch (ctx.state.phase) {
    case 'normal':
      handleNormal(ctx, byte);
      return;
    case 'esc':
      handleEsc(ctx, byte);
      return;
    case 'csi':
      handleCsi(ctx, byte);
      return;
    case 'osc-params':
    case 'osc-body':
    case 'osc-body-ignore':
    case 'osc-st':
    case 'osc-st-ignore':
      handleOsc(ctx, byte);
      return;
    case 'screen-title':
    case 'screen-title-st':
    case 'screen-title-ignore':
    case 'screen-title-st-ignore':
      handleScreenTitle(ctx, byte);
      return;
    case 'dcs-detect':
      handleDcsDetect(ctx, byte);
      return;
    case 'dcs-tmux':
    case 'dcs-tmux-esc':
    case 'dcs-tmux-ignore':
    case 'dcs-tmux-ignore-esc':
      handleTmuxPassthrough(ctx, byte);
      return;
  }
}

function findFirstOf2(data: Uint8Array, start: number, a: number, b: number): number {
  const ia = data.indexOf(a, start);
  const limit = ia < 0 ? data.length : ia;
  for (let i = start; i < limit; i += 1) {
    if (data[i] === b) {
      return i;
    }
  }
  return limit;
}

function consumeNormal(ctx: ParserContext, data: Uint8Array, index: number): number {
  const next = findFirstOf2(data, index, 0x1b, 0x07);
  if (next > index) {
    writeRun(ctx.output, data, index, next);
    return next - index;
  }
  const byte = data[index];
  if (byte === undefined) {
    return 1;
  }
  if (byte === 0x1b && data[index + 1] === 0x5b) {
    ctx.state.csiLength = 0;
    ctx.state.phase = 'csi';
    return 2 + consumeCsi(ctx, data, index + 2, index);
  }
  handleNormal(ctx, byte);
  return 1;
}

function consumeDcsTmux(ctx: ParserContext, data: Uint8Array, index: number): number {
  const esc = data.indexOf(0x1b, index);
  const next = esc < 0 ? data.length : esc;
  if (next > index) {
    appendDcsRun(ctx, data, index, next);
    return next - index;
  }
  handleTmuxPassthrough(ctx, 0x1b);
  return 1;
}

function consumeDcsTmuxIgnore(ctx: ParserContext, data: Uint8Array, index: number): number {
  const esc = data.indexOf(0x1b, index);
  const next = esc < 0 ? data.length : esc;
  if (next > index) {
    return next - index;
  }
  handleTmuxPassthrough(ctx, 0x1b);
  return 1;
}

function consumeOscBody(ctx: ParserContext, data: Uint8Array, index: number): number {
  const next = findFirstOf2(data, index, 0x07, 0x1b);
  if (next > index) {
    appendOscPayloadRun(ctx, data, index, next);
    return next - index;
  }
  const byte = data[index];
  if (byte !== undefined) {
    handleOsc(ctx, byte);
  }
  return 1;
}

function consumeIgnoreUntilBelOrEsc(ctx: ParserContext, data: Uint8Array, index: number): number {
  const next = findFirstOf2(data, index, 0x07, 0x1b);
  if (next > index) {
    return next - index;
  }
  const byte = data[index];
  if (byte === undefined) {
    return 1;
  }
  if (ctx.state.phase === 'osc-body-ignore') {
    handleOsc(ctx, byte);
  } else {
    handleScreenTitle(ctx, byte);
  }
  return 1;
}

function consumeScreenTitle(ctx: ParserContext, data: Uint8Array, index: number): number {
  const next = findFirstOf2(data, index, 0x07, 0x1b);
  if (next > index) {
    appendTitleRun(ctx, data, index, next);
    return next - index;
  }
  const byte = data[index];
  if (byte !== undefined) {
    handleScreenTitle(ctx, byte);
  }
  return 1;
}

function writeCsiPrefix(ctx: ParserContext): void {
  writeByte(ctx.output, 0x1b);
  writeByte(ctx.output, 0x5b);
  writeBytes(ctx.output, ctx.state.csiBytes, ctx.state.csiLength);
}

function consumeCsi(ctx: ParserContext, data: Uint8Array, index: number, seqStart = -1): number {
  const { state } = ctx;
  let i = index;
  while (i < data.length) {
    const byte = data[i];
    if (byte === undefined) {
      break;
    }
    if (byte >= 0x20 && byte <= 0x3f && state.csiLength < MAX_CSI_BYTES) {
      state.csiBytes[state.csiLength] = byte;
      state.csiLength += 1;
      i += 1;
      continue;
    }
    if (byte >= 0x40 && byte <= 0x7e) {
      if (seqStart >= 0) {
        writeRun(ctx.output, data, seqStart, i + 1);
      } else {
        writeCsiPrefix(ctx);
        writeByte(ctx.output, byte);
      }
      maybeEmitThemeSubscription(
        state.csiBytes,
        state.csiLength,
        byte,
        state.inTmuxPassthrough,
        ctx.options.onThemeSubscription
      );
      state.csiLength = 0;
      state.phase = 'normal';
      return i - index + 1;
    }
    if (seqStart >= 0) {
      writeRun(ctx.output, data, seqStart, i);
    } else {
      writeCsiPrefix(ctx);
    }
    state.csiLength = 0;
    state.phase = 'normal';
    ctx.processByte(byte);
    return i - index + 1;
  }
  return i - index;
}

function consumeBulkPhase(ctx: ParserContext, data: Uint8Array, index: number): number | null {
  switch (ctx.state.phase) {
    case 'csi':
      return consumeCsi(ctx, data, index);
    case 'normal':
      return consumeNormal(ctx, data, index);
    case 'dcs-tmux':
      return consumeDcsTmux(ctx, data, index);
    case 'dcs-tmux-ignore':
      return consumeDcsTmuxIgnore(ctx, data, index);
    case 'osc-body':
      return consumeOscBody(ctx, data, index);
    case 'osc-body-ignore':
    case 'screen-title-ignore':
      return consumeIgnoreUntilBelOrEsc(ctx, data, index);
    case 'screen-title':
      return consumeScreenTitle(ctx, data, index);
    default:
      return null;
  }
}

function consumeSome(ctx: ParserContext, data: Uint8Array, index: number): number {
  const bulk = consumeBulkPhase(ctx, data, index);
  if (bulk !== null) {
    return bulk;
  }
  const byte = data[index];
  if (byte === undefined) {
    return 1;
  }
  dispatchPaneStreamByte(ctx, byte);
  return 1;
}

type ScanWork = {
  data: Uint8Array;
  index: number;
  passthrough: boolean;
};

type ParserFrame = {
  ctx: ParserContext;
  scanStack: ScanWork[];
};

function setScanWork(
  stack: ScanWork[],
  depth: number,
  data: Uint8Array,
  passthrough: boolean
): void {
  const existing = stack[depth];
  if (existing) {
    existing.data = data;
    existing.index = 0;
    existing.passthrough = passthrough;
    return;
  }
  stack[depth] = { data, index: 0, passthrough };
}

function processInput(ctx: ParserContext, data: Uint8Array, stack: ScanWork[]): void {
  setScanWork(stack, 0, data, false);
  let depth = 1;
  while (depth > 0) {
    const top = stack[depth - 1] as ScanWork;
    if (top.index >= top.data.length) {
      depth -= 1;
      if (top.passthrough) {
        ctx.state.inTmuxPassthrough = false;
        refillIncompleteCsi(ctx);
      }
      continue;
    }
    top.index += consumeSome(ctx, top.data, top.index);
    const inner = ctx.pendingPassthrough.pop();
    if (!inner) {
      continue;
    }
    ctx.state.inTmuxPassthrough = true;
    setScanWork(stack, depth, inner, true);
    depth += 1;
  }
}

function createParserFrame(
  state: ReturnType<typeof createParserState>,
  options: PaneStreamParserOptions
): ParserFrame {
  return {
    ctx: {
      state,
      options,
      output: null,
      processByte(byte) {
        dispatchPaneStreamByte(this, byte);
      },
      pendingPassthrough: [],
    },
    scanStack: [{ data: EMPTY_UINT8, index: 0, passthrough: false }],
  };
}

export function createPaneStreamParser(options: PaneStreamParserOptions): PaneStreamParser {
  const state = createParserState();
  const frames: ParserFrame[] = [createParserFrame(state, options)];
  let activePushes = 0;
  return {
    push(data, materializeOutput = true) {
      const frame = frames[activePushes] ?? createParserFrame(state, options);
      frames[activePushes] = frame;
      activePushes += 1;
      try {
        frame.ctx.output = materializeOutput ? createParserOutput(data.length) : null;
        processInput(frame.ctx, data, frame.scanStack);
        return takeOutput(frame.ctx.output);
      } finally {
        frame.ctx.output = null;
        frame.ctx.pendingPassthrough.length = 0;
        for (let index = 0; index < frame.scanStack.length; index += 1) {
          const work = frame.scanStack[index];
          if (work) work.data = EMPTY_UINT8;
        }
        activePushes -= 1;
      }
    },
  };
}
