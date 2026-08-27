// fetch-history 门控：非焦点 pane 主动拉取首屏时先缓冲 live 帧，
// history 应用后再按原样回放，保证内容顺序（带超时兜底放行）。
//
// 缓冲的是完整的 GatewayTerminalData 帧而不是裸字节：paneEpoch / seqStart / seqEnd
// 是渲染面判定缺口与 rebase 的依据，丢掉元数据的回放等价于伪造了一段无序号数据。
import type { GatewayTerminalData } from './transport-types';

export interface PaneHistoryGateHandlers {
  // 超时/主动放行时逐帧回放（帧元数据原样保留）
  flushFrame(frame: GatewayTerminalData): void;
  // 缓冲超限：缓冲已被丢弃，需要走既有的 rebase 通道重建画面
  requestRebase(deviceId: string, paneId: string): void;
}

export interface PaneHistoryGateOptions {
  timeoutMs?: number;
  maxBufferedBytes?: number;
}

export const DEFAULT_HISTORY_GATE_TIMEOUT_MS = 3000;
export const DEFAULT_HISTORY_GATE_MAX_BYTES = 2 * 1024 * 1024;

interface Gate {
  deviceId: string;
  paneId: string;
  token: Uint8Array;
  frames: GatewayTerminalData[];
  bufferedBytes: number;
  timer: ReturnType<typeof setTimeout>;
}

function gateKey(deviceId: string, paneId: string): string {
  return `${deviceId}:${paneId}`;
}

function tokensEqual(expected: Uint8Array, received: Uint8Array): boolean {
  if (expected.length !== received.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== received[i]) return false;
  }
  return true;
}

export class PaneHistoryGates {
  private gates = new Map<string, Gate>();
  private readonly timeoutMs: number;
  private readonly maxBufferedBytes: number;

  constructor(
    private readonly handlers: PaneHistoryGateHandlers,
    options: PaneHistoryGateOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HISTORY_GATE_TIMEOUT_MS;
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_HISTORY_GATE_MAX_BYTES;
  }

  begin(deviceId: string, paneId: string, token: Uint8Array): void {
    const key = gateKey(deviceId, paneId);
    this.close(deviceId, paneId, { flush: true });

    const timer = setTimeout(() => {
      console.warn(`[pane-sink] history gate timeout on ${key}, releasing buffered output`);
      this.close(deviceId, paneId, { flush: true });
    }, this.timeoutMs);

    this.gates.set(key, {
      deviceId,
      paneId,
      token: new Uint8Array(token),
      frames: [],
      bufferedBytes: 0,
      timer,
    });
  }

  // 帧被门控吃掉（缓冲或因超限丢弃）返回 true，调用方不再继续分发
  capture(frame: GatewayTerminalData): boolean {
    const { deviceId, paneId } = frame;
    const gate = this.gates.get(gateKey(deviceId, paneId));
    if (!gate) return false;

    if (gate.bufferedBytes + frame.data.byteLength > this.maxBufferedBytes) {
      this.close(deviceId, paneId, { flush: false });
      this.handlers.requestRebase(deviceId, paneId);
      return true;
    }

    // 帧来自单次 WS 消息的解码结果，解码器不复用底层 buffer，无需拷贝
    gate.frames.push(frame);
    gate.bufferedBytes += frame.data.byteLength;
    return true;
  }

  // token 命中则摘下门控并交还缓冲帧，由调用方在写入 history 基线之后自行回放；
  // 未命中返回 null（交由 select 状态机处理）
  take(deviceId: string, paneId: string, token: Uint8Array): GatewayTerminalData[] | null {
    const key = gateKey(deviceId, paneId);
    const gate = this.gates.get(key);
    if (!gate || !tokensEqual(gate.token, token)) return null;

    clearTimeout(gate.timer);
    this.gates.delete(key);
    return gate.frames;
  }

  close(deviceId: string, paneId: string, opts: { flush: boolean }): void {
    const key = gateKey(deviceId, paneId);
    const gate = this.gates.get(key);
    if (!gate) return;
    clearTimeout(gate.timer);
    this.gates.delete(key);
    if (!opts.flush) return;
    for (const frame of gate.frames) {
      this.handlers.flushFrame(frame);
    }
  }

  closeDevice(deviceId: string, opts: { flush: boolean }): void {
    for (const gate of [...this.gates.values()]) {
      if (gate.deviceId === deviceId) {
        this.close(gate.deviceId, gate.paneId, opts);
      }
    }
  }

  closeAll(opts: { flush: boolean }): void {
    for (const gate of [...this.gates.values()]) {
      this.close(gate.deviceId, gate.paneId, opts);
    }
  }
}
