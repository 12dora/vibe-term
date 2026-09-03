import { wsBorsh } from '@tmex/shared';

// gateway 的 WS 端点。URL 带 per-socket 的 `?cid=` nonce（多 node 下服务端靠它认连接），
// 因此不能用 endsWith('/ws') 判断。
export function isGatewayWsUrl(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith('/ws');
  } catch {
    return false;
  }
}

export interface WsBorshEnvelope {
  version: number;
  kind: number;
  flags: number;
  seq: number;
  payload: Buffer;
}

export const KIND = {
  HELLO_C2S: 0x0001,
  HELLO_S2C: 0x0002,
  PING: 0x0003,
  PONG: 0x0004,
  ERROR: 0x0005,

  DEVICE_CONNECT: 0x0101,
  DEVICE_CONNECTED: 0x0102,
  DEVICE_DISCONNECT: 0x0103,
  DEVICE_DISCONNECTED: 0x0104,
  DEVICE_EVENT: 0x0105,

  TMUX_SELECT: 0x0201,
  TMUX_CREATE_WINDOW: 0x0203,
  TMUX_EVENT: 0x0207,
  STATE_SNAPSHOT: 0x0208,

  TERM_INPUT: 0x0301,
  TERM_PASTE: 0x0302,
  TERM_RESIZE: 0x0303,
  TERM_SYNC_SIZE: 0x0304,
  TERM_OUTPUT: 0x0305,
  TERM_HISTORY: 0x0306,

  SWITCH_ACK: 0x0401,
  LIVE_RESUME: 0x0402,

  CHUNK: 0x0501,

  TMUX_SET_WINDOW_STYLE: 0x020a,
  SITE_THEME_UPDATE: 0x0801,
} as const;

function isMagicTX(data: Buffer): boolean {
  return data.length >= 2 && data[0] === 0x54 && data[1] === 0x58;
}

export function decodeEnvelope(payload: string | Buffer): WsBorshEnvelope | null {
  if (typeof payload === 'string') return null;
  if (!isMagicTX(payload)) return null;
  if (payload.length < 16) return null;

  const version = payload.readUInt16LE(2);
  const kind = payload.readUInt16LE(4);
  const flags = payload.readUInt16LE(6);
  const seq = payload.readUInt32LE(8);
  const payloadLen = payload.readUInt32LE(12);
  const payloadStart = 16;
  const payloadEnd = payloadStart + payloadLen;
  if (payloadEnd > payload.length) return null;

  return {
    version,
    kind,
    flags,
    seq,
    payload: payload.subarray(payloadStart, payloadEnd),
  };
}

class BorshCursor {
  private buf: Buffer;
  offset = 0;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  private ensure(bytes: number): void {
    if (this.offset + bytes > this.buf.length) {
      throw new Error('Borsh decode overflow');
    }
  }

  readU8(): number {
    this.ensure(1);
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }

  readBool(): boolean {
    return this.readU8() !== 0;
  }

  readU16(): number {
    this.ensure(2);
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  readU32(): number {
    this.ensure(4);
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  readFixedBytes(length: number): Buffer {
    this.ensure(length);
    const out = this.buf.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  readVecBytes(): Buffer {
    const len = this.readU32();
    return this.readFixedBytes(len);
  }

  readString(): string {
    const bytes = this.readVecBytes();
    return bytes.toString('utf8');
  }

  readOptionString(): string | null {
    const disc = this.readU8();
    if (disc === 0) return null;
    return this.readString();
  }

  readOptionU16(): number | null {
    const disc = this.readU8();
    if (disc === 0) return null;
    return this.readU16();
  }
}

export interface TermInputPayload {
  deviceId: string;
  paneId: string;
  encoding: number;
  data: Buffer;
  isComposing: boolean;
}

export function decodeTermInput(payload: Buffer): TermInputPayload {
  const c = new BorshCursor(payload);
  const deviceId = c.readString();
  const paneId = c.readString();
  const encoding = c.readU8();
  const data = c.readVecBytes();
  const isComposing = c.readBool();
  return { deviceId, paneId, encoding, data, isComposing };
}

export interface TmuxSelectPayload {
  deviceId: string;
  windowId: string | null;
  paneId: string | null;
  selectToken: Buffer;
  wantHistory: boolean;
  cols: number | null;
  rows: number | null;
}

export function decodeTmuxSelect(payload: Buffer): TmuxSelectPayload {
  const c = new BorshCursor(payload);
  const deviceId = c.readString();
  const windowId = c.readOptionString();
  const paneId = c.readOptionString();
  const selectToken = c.readFixedBytes(16);
  const wantHistory = c.readBool();
  const cols = c.readOptionU16();
  const rows = c.readOptionU16();
  return { deviceId, windowId, paneId, selectToken, wantHistory, cols, rows };
}

export interface SwitchAckPayload {
  deviceId: string;
  windowId: string;
  paneId: string;
  selectToken: Buffer;
}

export function decodeSwitchAck(payload: Buffer): SwitchAckPayload {
  const c = new BorshCursor(payload);
  const deviceId = c.readString();
  const windowId = c.readString();
  const paneId = c.readString();
  const selectToken = c.readFixedBytes(16);
  return { deviceId, windowId, paneId, selectToken };
}

export interface LiveResumePayload {
  deviceId: string;
  paneId: string;
  selectToken: Buffer;
}

export function decodeLiveResume(payload: Buffer): LiveResumePayload {
  const c = new BorshCursor(payload);
  const deviceId = c.readString();
  const paneId = c.readString();
  const selectToken = c.readFixedBytes(16);
  return { deviceId, paneId, selectToken };
}

export interface TermHistoryPayload {
  deviceId: string;
  paneId: string;
  selectToken: Buffer;
  encoding: number;
  alternateScreen: boolean;
  modes: number;
  data: Buffer;
}

export function decodeTermHistory(payload: Buffer): TermHistoryPayload {
  const c = new BorshCursor(payload);
  const deviceId = c.readString();
  const paneId = c.readString();
  const selectToken = c.readFixedBytes(16);
  const encoding = c.readU8();
  const alternateScreen = c.readBool();
  const modes = c.readU8();
  const data = c.readVecBytes();
  return { deviceId, paneId, selectToken, encoding, alternateScreen, modes, data };
}

export interface SiteThemeUpdateS2CPayload {
  theme: number;
  serverTimestamp: bigint;
}

export function decodeSiteThemeUpdateS2C(payload: Buffer): SiteThemeUpdateS2CPayload {
  const c = new BorshCursor(payload);
  const theme = c.readU8();
  const low = BigInt(c.readU32());
  const high = BigInt(c.readU32());
  return { theme, serverTimestamp: (high << 32n) | low };
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export interface PaneFeedCollector {
  selectTokenByPane: Map<string, string>;
  barrierKindsByToken: Map<string, number[]>;
  historyTextByToken: Map<string, string>;
  canonicalScreenTextByPane: Map<string, string>;
  canonicalOutputTextByPane: Map<string, string>;
  sawCanonicalEvent: boolean;
  paneContent(paneId: string): string;
  handleOutbound(kind: number, payloadBytes: Uint8Array): void;
  handleInbound(kind: number, payloadBytes: Uint8Array): void;
}

/** 同时收 legacy TERM_HISTORY / 屏障帧和 canonical Screen/PaneData，按当前生效 feed 断言。 */
export function createPaneFeedCollector(): PaneFeedCollector {
  const selectTokenByPane = new Map<string, string>();
  const barrierKindsByToken = new Map<string, number[]>();
  const historyTextByToken = new Map<string, string>();
  const canonicalScreenTextByPane = new Map<string, string>();
  const canonicalOutputTextByPane = new Map<string, string>();
  const screenByRequest = new Map<string, { paneId: string; chunks: Uint8Array[] }>();
  const collector: PaneFeedCollector = {
    selectTokenByPane,
    barrierKindsByToken,
    historyTextByToken,
    canonicalScreenTextByPane,
    canonicalOutputTextByPane,
    sawCanonicalEvent: false,
    paneContent(paneId) {
      const token = selectTokenByPane.get(paneId);
      const history = token ? (historyTextByToken.get(token) ?? '') : '';
      const screen = canonicalScreenTextByPane.get(paneId) ?? '';
      const output = canonicalOutputTextByPane.get(paneId) ?? '';
      return `${history}${screen}${output}`;
    },
    handleOutbound(kind, payloadBytes) {
      if (kind !== wsBorsh.KIND_TMUX_SELECT) return;
      const decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxSelectSchema, payloadBytes);
      if (!decoded.paneId) return;
      selectTokenByPane.set(decoded.paneId, bytesToHex(decoded.selectToken));
    },
    handleInbound(kind, payloadBytes) {
      if (kind === wsBorsh.KIND_CANONICAL_EVENT) {
        handleCanonicalEvent(payloadBytes);
        return;
      }
      if (kind === wsBorsh.KIND_SWITCH_ACK) {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.SwitchAckSchema, payloadBytes);
        pushBarrier(bytesToHex(decoded.selectToken), kind);
        return;
      }
      if (kind === wsBorsh.KIND_LIVE_RESUME) {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.LiveResumeSchema, payloadBytes);
        pushBarrier(bytesToHex(decoded.selectToken), kind);
        return;
      }
      if (kind !== wsBorsh.KIND_TERM_HISTORY) return;
      const decoded = wsBorsh.decodePayload(wsBorsh.schema.TermHistorySchema, payloadBytes);
      const tokenHex = bytesToHex(decoded.selectToken);
      historyTextByToken.set(tokenHex, decodeUtf8(decoded.data));
      pushBarrier(tokenHex, kind);
    },
  };

  function pushBarrier(tokenHex: string, kind: number): void {
    const list = barrierKindsByToken.get(tokenHex) ?? [];
    list.push(kind);
    barrierKindsByToken.set(tokenHex, list);
  }

  function handleCanonicalEvent(payload: Uint8Array): void {
    let event: ReturnType<typeof wsBorsh.decodeCanonicalEventPayload>['event'];
    try {
      event = wsBorsh.decodeCanonicalEventPayload(payload).event;
    } catch {
      return;
    }
    collector.sawCanonicalEvent = true;
    if ('ScreenBegin' in event) {
      const begin = event.ScreenBegin;
      screenByRequest.set(bytesToHex(begin.requestId), { paneId: begin.pane.paneId, chunks: [] });
      return;
    }
    if ('ScreenChunk' in event) {
      const chunk = event.ScreenChunk;
      screenByRequest.get(bytesToHex(chunk.requestId))?.chunks.push(chunk.data);
      return;
    }
    if ('ScreenCommit' in event) {
      const commit = event.ScreenCommit;
      const pending = screenByRequest.get(bytesToHex(commit.requestId));
      if (!pending) return;
      canonicalScreenTextByPane.set(
        pending.paneId,
        pending.chunks.map((chunk) => decodeUtf8(chunk)).join('')
      );
      return;
    }
    if ('PaneData' in event) {
      const frame = event.PaneData;
      const previous = canonicalOutputTextByPane.get(frame.pane.paneId) ?? '';
      canonicalOutputTextByPane.set(frame.pane.paneId, previous + decodeUtf8(frame.data));
    }
  }

  return collector;
}

export function attachPaneFeedCollector(page: import('@playwright/test').Page): PaneFeedCollector {
  const collector = createPaneFeedCollector();
  const reassembler = new wsBorsh.ChunkReassembler();

  const decodeFrame = (payload: unknown): { kind: number; payload: Uint8Array } | null => {
    if (typeof payload === 'string') return null;
    const bytes =
      payload instanceof Buffer ? new Uint8Array(payload) : new Uint8Array(payload as ArrayBuffer);
    if (!wsBorsh.checkMagic(bytes)) return null;
    try {
      const envelope = wsBorsh.decodeEnvelope(bytes);
      if (envelope.kind !== wsBorsh.KIND_CHUNK) {
        return { kind: envelope.kind, payload: envelope.payload };
      }
      return reassembler.addChunk(wsBorsh.decodeChunk(envelope.payload));
    } catch {
      return null;
    }
  };

  page.on('websocket', (socket) => {
    if (!isGatewayWsUrl(socket.url())) return;
    socket.on('framesent', (frame) => {
      const decoded = decodeFrame(frame.payload);
      if (decoded) collector.handleOutbound(decoded.kind, decoded.payload);
    });
    socket.on('framereceived', (frame) => {
      const decoded = decodeFrame(frame.payload);
      if (decoded) collector.handleInbound(decoded.kind, decoded.payload);
    });
  });

  return collector;
}

export async function readVisibleTerminalText(
  page: import('@playwright/test').Page
): Promise<string> {
  return page.evaluate(() => {
    const term = (window as any).__tmexE2eXterm;
    if (!term) return '';
    const buffer = term.buffer.active;
    const start = buffer.viewportY;
    const end = Math.min(buffer.length, start + term.rows);
    const lines: string[] = [];
    for (let y = start; y < end; y++) {
      const line = buffer.getLine(y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines.join('\n');
  });
}
