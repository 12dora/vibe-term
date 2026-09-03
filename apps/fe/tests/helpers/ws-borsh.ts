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

  CHUNK: 0x0501,

  CANONICAL_COMMAND: 0x0901,
  CANONICAL_EVENT: 0x0902,

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

export interface TmuxSelectPayload {
  deviceId: string;
  windowId: string | null;
  paneId: string | null;
  selectToken: Buffer;
  /** wire 字段保留，canonical 下恒 false（历史只走 canonical RequestHistory） */
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

export interface CanonicalScreenPhase {
  phase: 'begin' | 'commit';
  requestId: string;
}

export interface CanonicalSubscriptionApplied {
  generation: bigint;
  activePaneIds: string[];
}

export interface PaneFeedCollector {
  selectTokenByPane: Map<string, string>;
  canonicalScreenTextByPane: Map<string, string>;
  canonicalOutputTextByPane: Map<string, string>;
  /** 每个 pane 的 canonical 首屏事务相位序列，用来断言 Begin→Commit 的顺序 */
  screenPhasesByPane: Map<string, CanonicalScreenPhase[]>;
  /** SubscriptionApplied 按到达顺序：generation 必须单调递增 */
  subscriptions: CanonicalSubscriptionApplied[];
  sawCanonicalEvent: boolean;
  paneContent(paneId: string): string;
  screenCommitted(paneId: string): boolean;
  handleOutbound(kind: number, payloadBytes: Uint8Array): void;
  handleInbound(kind: number, payloadBytes: Uint8Array): void;
}

/** canonical 状态流的接收面：首屏事务、PaneData、订阅代。legacy 状态流已于 1.1.23 下线。 */
export function createPaneFeedCollector(): PaneFeedCollector {
  const selectTokenByPane = new Map<string, string>();
  const canonicalScreenTextByPane = new Map<string, string>();
  const canonicalOutputTextByPane = new Map<string, string>();
  const screenPhasesByPane = new Map<string, CanonicalScreenPhase[]>();
  const subscriptions: CanonicalSubscriptionApplied[] = [];
  const screenByRequest = new Map<string, { paneId: string; chunks: Uint8Array[] }>();
  const collector: PaneFeedCollector = {
    selectTokenByPane,
    canonicalScreenTextByPane,
    canonicalOutputTextByPane,
    screenPhasesByPane,
    subscriptions,
    sawCanonicalEvent: false,
    paneContent(paneId) {
      const screen = canonicalScreenTextByPane.get(paneId) ?? '';
      const output = canonicalOutputTextByPane.get(paneId) ?? '';
      return `${screen}${output}`;
    },
    screenCommitted(paneId) {
      return (screenPhasesByPane.get(paneId) ?? []).some((entry) => entry.phase === 'commit');
    },
    handleOutbound(kind, payloadBytes) {
      if (kind !== wsBorsh.KIND_TMUX_SELECT) return;
      const decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxSelectSchema, payloadBytes);
      if (!decoded.paneId) return;
      selectTokenByPane.set(decoded.paneId, bytesToHex(decoded.selectToken));
    },
    handleInbound(kind, payloadBytes) {
      if (kind !== wsBorsh.KIND_CANONICAL_EVENT) return;
      handleCanonicalEvent(payloadBytes);
    },
  };

  function pushPhase(paneId: string, phase: 'begin' | 'commit', requestId: string): void {
    const list = screenPhasesByPane.get(paneId) ?? [];
    list.push({ phase, requestId });
    screenPhasesByPane.set(paneId, list);
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
      const requestId = bytesToHex(begin.requestId);
      screenByRequest.set(requestId, { paneId: begin.pane.paneId, chunks: [] });
      pushPhase(begin.pane.paneId, 'begin', requestId);
      return;
    }
    if ('ScreenChunk' in event) {
      const chunk = event.ScreenChunk;
      screenByRequest.get(bytesToHex(chunk.requestId))?.chunks.push(chunk.data);
      return;
    }
    if ('ScreenCommit' in event) {
      const commit = event.ScreenCommit;
      const requestId = bytesToHex(commit.requestId);
      const pending = screenByRequest.get(requestId);
      if (!pending) return;
      canonicalScreenTextByPane.set(
        pending.paneId,
        pending.chunks.map((chunk) => decodeUtf8(chunk)).join('')
      );
      pushPhase(pending.paneId, 'commit', requestId);
      return;
    }
    if ('SubscriptionApplied' in event) {
      const applied = event.SubscriptionApplied;
      subscriptions.push({
        generation: applied.generation,
        activePaneIds: applied.activePanes.map((pane) => pane.paneId),
      });
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

/** 帧解码 + CHUNK 重组：canonical 载荷（首屏、粘贴）会分片，逐帧解码会漏。 */
function createFrameDecoder(): (payload: unknown) => { kind: number; payload: Uint8Array } | null {
  const reassembler = new wsBorsh.ChunkReassembler();
  return (payload) => {
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
}

export function attachPaneFeedCollector(page: import('@playwright/test').Page): PaneFeedCollector {
  const collector = createPaneFeedCollector();
  const decodeFrame = createFrameDecoder();

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

/** canonical v1.1 的 geometryReason：0 = 真实视口变化，1 = 焦点恢复/暖切换补发。 */
export const CANONICAL_GEOMETRY_REASON_CHANGE = 0;
export const CANONICAL_GEOMETRY_REASON_RESEND = 1;

export interface CanonicalResizeCommand {
  deviceId: string;
  paneId: string;
  cols: number;
  rows: number;
  reason: number;
  sizeEpoch: bigint;
}

export interface CanonicalInputCommand {
  deviceId: string;
  paneId: string;
  data: Buffer;
}

export interface CanonicalCommandCollector {
  resizes: CanonicalResizeCommand[];
  inputs: CanonicalInputCommand[];
  /** 按 geometryReason 分类的尺寸命令计数（替代 legacy 的 TERM_RESIZE / TERM_SYNC_SIZE 计数） */
  counts(): { change: number; resend: number };
  reset(): void;
  handleOutbound(kind: number, payloadBytes: Uint8Array): void;
}

/** 浏览器发出的 canonical 命令：尺寸（ResizePaneV11）与终端输入（TerminalInput）。 */
export function createCanonicalCommandCollector(): CanonicalCommandCollector {
  const collector: CanonicalCommandCollector = {
    resizes: [],
    inputs: [],
    counts() {
      return {
        change: collector.resizes.filter((r) => r.reason === CANONICAL_GEOMETRY_REASON_CHANGE)
          .length,
        resend: collector.resizes.filter((r) => r.reason === CANONICAL_GEOMETRY_REASON_RESEND)
          .length,
      };
    },
    reset() {
      collector.resizes.length = 0;
      collector.inputs.length = 0;
    },
    handleOutbound(kind, payloadBytes) {
      if (kind !== wsBorsh.KIND_CANONICAL_COMMAND) return;
      let command: ReturnType<typeof wsBorsh.decodeCanonicalCommandPayload>['command'];
      try {
        command = wsBorsh.decodeCanonicalCommandPayload(payloadBytes).command;
      } catch {
        return;
      }
      if ('ResizePaneV11' in command) {
        const resize = command.ResizePaneV11;
        collector.resizes.push({
          deviceId: resize.pane.deviceId,
          paneId: resize.pane.paneId,
          cols: resize.cols,
          rows: resize.rows,
          reason: resize.geometryReason,
          sizeEpoch: resize.sizeEpoch,
        });
        return;
      }
      if ('TerminalInput' in command) {
        const input = command.TerminalInput;
        collector.inputs.push({
          deviceId: input.pane.deviceId,
          paneId: input.pane.paneId,
          data: Buffer.from(input.data),
        });
      }
    },
  };
  return collector;
}

export function attachCanonicalCommandCollector(
  page: import('@playwright/test').Page
): CanonicalCommandCollector {
  const collector = createCanonicalCommandCollector();
  const decodeFrame = createFrameDecoder();

  page.on('websocket', (socket) => {
    if (!isGatewayWsUrl(socket.url())) return;
    socket.on('framesent', (frame) => {
      const decoded = decodeFrame(frame.payload);
      if (decoded) collector.handleOutbound(decoded.kind, decoded.payload);
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
