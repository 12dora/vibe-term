import type { PaneStreamParserOptions } from '../pane-stream-parser';
import type { ParserContext, ParserState } from './parser-state';
import {
  MAX_KITTY_PENDING_IDS,
  MAX_OSC_KIND_BYTES,
  MAX_TITLE_BYTES,
  appendOscPayloadByte,
  resetOscState,
  utf8Decoder,
  warnTitleOverflow,
} from './parser-state';

const HANDLED_OSC_KINDS = new Set(['0', '1', '2', '7', '9', '52', '99', '133', '777', '1337']);

export function emitTitle(titleBytes: number[], onTitle: (title: string) => void): void {
  const title = utf8Decoder.decode(new Uint8Array(titleBytes)).trim();
  if (!title) {
    return;
  }
  onTitle(title);
}

// OSC 52 的 Pc 是选区集合：c=clipboard、p=primary、q=secondary、s=select、0-7=cut buffer。
// 浏览器里只有系统剪贴板一个去处，primary/secondary/cut buffer 没有对应物。编辑器（如
// nvim 内置 OSC 52 provider：`*`→p、`+`→c）在 `clipboard=unnamed,unnamedplus` 下一次复制
// 会连发 p 与 c 两条，全都当剪贴板写就是「一次复制、两次写入 + 两条提示」。
// 空 Pc（tmux 自身复制、大量脚本的 `\e]52;;<b64>`）沿用旧行为按剪贴板处理。
function targetsSystemClipboard(targets: string): boolean {
  return targets.length === 0 || targets.includes('c') || targets.includes('s');
}

export function emitOsc(state: ParserState, options: PaneStreamParserOptions): void {
  const payload = utf8Decoder.decode(new Uint8Array(state.oscPayloadBytes));
  switch (state.oscKind) {
    case '0':
    case '1':
    case '2':
      emitTitle(state.oscPayloadBytes, options.onTitle);
      return;
    case '7': {
      try {
        const value = new URL(payload);
        if (value.protocol === 'file:' && value.pathname) {
          options.onCurrentPath?.(decodeURIComponent(value.pathname));
        }
      } catch {}
      return;
    }
    case '9':
      if (/^4(;|$)/.test(payload)) {
        return;
      }
      options.onNotification({ source: 'osc9', body: payload });
      return;
    case '99': {
      const metadataSeparatorIndex = payload.indexOf(';');
      const metadata =
        metadataSeparatorIndex >= 0 ? payload.slice(0, metadataSeparatorIndex) : payload;
      const content = metadataSeparatorIndex >= 0 ? payload.slice(metadataSeparatorIndex + 1) : '';
      const fields = new Map<string, string>();
      for (const part of metadata.split(':')) {
        const equalsIndex = part.indexOf('=');
        if (equalsIndex > 0) {
          fields.set(part.slice(0, equalsIndex), part.slice(equalsIndex + 1));
        }
      }
      const id = fields.get('i') ?? '0';
      const done = fields.get('d') !== '0';
      const part = fields.get('p') ?? 'body';
      const pending = state.kittyPending.get(id) ?? { title: '', body: '' };
      if (part === 'title') {
        pending.title += content;
      } else if (part === 'body') {
        pending.body += content;
      }
      if (!done) {
        if (!state.kittyPending.has(id) && state.kittyPending.size >= MAX_KITTY_PENDING_IDS) {
          const oldestId = state.kittyPending.keys().next().value;
          if (oldestId !== undefined) {
            state.kittyPending.delete(oldestId);
          }
        }
        state.kittyPending.set(id, pending);
        return;
      }
      state.kittyPending.delete(id);
      if (pending.title || pending.body) {
        options.onNotification({
          source: 'osc99',
          title: pending.title || undefined,
          body: pending.body,
        });
      }
      return;
    }
    case '777': {
      const verbSeparatorIndex = payload.indexOf(';');
      const verb = verbSeparatorIndex >= 0 ? payload.slice(0, verbSeparatorIndex) : payload;
      if (verb !== 'notify') {
        return;
      }
      const rest = verbSeparatorIndex >= 0 ? payload.slice(verbSeparatorIndex + 1) : '';
      const titleSeparatorIndex = rest.indexOf(';');
      const title = titleSeparatorIndex >= 0 ? rest.slice(0, titleSeparatorIndex) : rest;
      const body = titleSeparatorIndex >= 0 ? rest.slice(titleSeparatorIndex + 1) : '';
      options.onNotification({
        source: 'osc777',
        title: title || undefined,
        body,
      });
      return;
    }
    case '1337':
      if (/^RequestAttention=(yes|once|fireworks|true)$/i.test(payload)) {
        options.onNotification({ source: 'osc1337', body: 'RequestAttention' });
      }
      return;
    case '52': {
      const separatorIndex = payload.indexOf(';');
      if (separatorIndex < 0) {
        return;
      }
      if (!targetsSystemClipboard(payload.slice(0, separatorIndex))) {
        return;
      }
      const base64Data = payload.slice(separatorIndex + 1);
      if (!base64Data || base64Data === '?') {
        return;
      }
      try {
        const binaryString = atob(base64Data);
        const decoded = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          decoded[i] = binaryString.charCodeAt(i);
        }
        const text = new TextDecoder('utf-8', { fatal: false }).decode(decoded);
        if (text) {
          options.onClipboardWrite?.(text);
        }
      } catch {
        // invalid base64 — silently discard
      }
      return;
    }
    case '133': {
      const parts = payload.split(';');
      const kind = parts[0];
      if (kind !== 'A' && kind !== 'B' && kind !== 'C' && kind !== 'D') {
        return;
      }
      let exitCode: number | null = null;
      if (kind === 'D' && parts[1] !== undefined && parts[1] !== '') {
        const parsed = Number.parseInt(parts[1], 10);
        exitCode = Number.isNaN(parsed) ? null : parsed;
      }
      options.onPromptMarker?.({ kind, exitCode, params: parts.slice(1) });
      return;
    }
    default:
      return;
  }
}

function finishOsc(ctx: ParserContext): void {
  emitOsc(ctx.state, ctx.options);
  resetOscState(ctx.state);
  ctx.state.phase = 'normal';
}

function handleOscParams(ctx: ParserContext, byte: number): void {
  const { state } = ctx;
  if (byte === 0x3b) {
    state.phase = HANDLED_OSC_KINDS.has(state.oscKind) ? 'osc-body' : 'osc-body-ignore';
    return;
  }
  if (byte === 0x07) {
    finishOsc(ctx);
    return;
  }
  if (byte === 0x1b) {
    state.phase = 'osc-st';
    return;
  }
  if (state.oscKind.length >= MAX_OSC_KIND_BYTES) {
    resetOscState(state);
    state.phase = 'osc-body-ignore';
    return;
  }
  state.oscKind += String.fromCharCode(byte);
}

function handleOscBody(ctx: ParserContext, byte: number): void {
  if (byte === 0x07) {
    finishOsc(ctx);
    return;
  }
  if (byte === 0x1b) {
    ctx.state.phase = 'osc-st';
    return;
  }
  appendOscPayloadByte(ctx, byte);
}

function handleOscBodyIgnore(ctx: ParserContext, byte: number): void {
  if (byte === 0x07) {
    resetOscState(ctx.state);
    ctx.state.phase = 'normal';
    return;
  }
  if (byte === 0x1b) {
    ctx.state.phase = 'osc-st-ignore';
  }
}

function handleOscSt(ctx: ParserContext, byte: number): void {
  if (byte === 0x5c) {
    finishOsc(ctx);
    return;
  }
  ctx.state.phase = 'osc-body';
  if (appendOscPayloadByte(ctx, 0x1b)) {
    appendOscPayloadByte(ctx, byte);
  }
}

function handleOscStIgnore(ctx: ParserContext, byte: number): void {
  if (byte === 0x5c) {
    resetOscState(ctx.state);
    ctx.state.phase = 'normal';
    return;
  }
  ctx.state.phase = 'osc-body-ignore';
}

export function handleOsc(ctx: ParserContext, byte: number): void {
  switch (ctx.state.phase) {
    case 'osc-params':
      handleOscParams(ctx, byte);
      return;
    case 'osc-body':
      handleOscBody(ctx, byte);
      return;
    case 'osc-body-ignore':
      handleOscBodyIgnore(ctx, byte);
      return;
    case 'osc-st':
      handleOscSt(ctx, byte);
      return;
    case 'osc-st-ignore':
      handleOscStIgnore(ctx, byte);
      return;
    default:
      return;
  }
}

function handleScreenTitleBody(ctx: ParserContext, byte: number): void {
  const { state } = ctx;
  if (byte === 0x07) {
    emitTitle(state.titleBytes, ctx.options.onTitle);
    state.titleBytes = [];
    state.phase = 'normal';
    return;
  }
  if (byte === 0x1b) {
    state.phase = 'screen-title-st';
    return;
  }
  if (state.titleBytes.length >= MAX_TITLE_BYTES) {
    warnTitleOverflow(state);
    state.titleBytes = [];
    state.phase = 'screen-title-ignore';
    return;
  }
  state.titleBytes.push(byte);
}

function handleScreenTitleSt(ctx: ParserContext, byte: number): void {
  const { state } = ctx;
  if (byte === 0x5c) {
    emitTitle(state.titleBytes, ctx.options.onTitle);
    state.titleBytes = [];
    state.phase = 'normal';
    return;
  }
  if (state.titleBytes.length + 2 > MAX_TITLE_BYTES) {
    warnTitleOverflow(state);
    state.titleBytes = [];
    state.phase = 'screen-title-ignore';
    return;
  }
  state.titleBytes.push(0x1b, byte);
  state.phase = 'screen-title';
}

function handleScreenTitleIgnore(ctx: ParserContext, byte: number): void {
  if (byte === 0x07) {
    ctx.state.phase = 'normal';
  } else if (byte === 0x1b) {
    ctx.state.phase = 'screen-title-st-ignore';
  }
}

export function handleScreenTitle(ctx: ParserContext, byte: number): void {
  switch (ctx.state.phase) {
    case 'screen-title':
      handleScreenTitleBody(ctx, byte);
      return;
    case 'screen-title-st':
      handleScreenTitleSt(ctx, byte);
      return;
    case 'screen-title-ignore':
      handleScreenTitleIgnore(ctx, byte);
      return;
    case 'screen-title-st-ignore':
      ctx.state.phase = byte === 0x5c ? 'normal' : 'screen-title-ignore';
      return;
    default:
      return;
  }
}
