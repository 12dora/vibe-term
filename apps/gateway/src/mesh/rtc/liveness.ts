import { FRAGMENT_HEADER_SIZE, fragmentFrame } from './fragmenter';
import { rtcLog } from './rtc-log';

export const DEFAULT_RTC_LIVENESS_INTERVAL_MS = 3_000;
export const DEFAULT_RTC_LIVENESS_TIMEOUT_MS = 10_000;
export const RTC_LIVENESS_INTERVAL_MS = DEFAULT_RTC_LIVENESS_INTERVAL_MS;
export const RTC_LIVENESS_TIMEOUT_MS = DEFAULT_RTC_LIVENESS_TIMEOUT_MS;

export const LIVENESS_FRAME_ID = 0;
export const LIVENESS_KIND_PING = 1;
export const LIVENESS_KIND_PONG = 2;

export type RtcLivenessClock = {
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
};

export type ChannelLivenessOptions = RtcLivenessClock & {
  peer?: string;
  intervalMs?: number;
  timeoutMs?: number;
  sendPing: () => void;
  onTimeout: (idleMs: number) => void;
};

function envPositiveMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export function readRtcLivenessConfig(): { intervalMs: number; timeoutMs: number } {
  return {
    intervalMs: envPositiveMs('RTC_LIVENESS_INTERVAL_MS', DEFAULT_RTC_LIVENESS_INTERVAL_MS),
    timeoutMs: envPositiveMs('RTC_LIVENESS_TIMEOUT_MS', DEFAULT_RTC_LIVENESS_TIMEOUT_MS),
  };
}

function readU16LE(buf: Uint8Array, offset: number): number {
  const lo = buf[offset];
  const hi = buf[offset + 1];
  if (lo === undefined || hi === undefined) return 0;
  return lo | (hi << 8);
}

function readU32LE(buf: Uint8Array, offset: number): number {
  const b0 = buf[offset];
  const b1 = buf[offset + 1];
  const b2 = buf[offset + 2];
  const b3 = buf[offset + 3];
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) return 0;
  return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
}

export function encodeLivenessChunk(kind: 'ping' | 'pong'): Uint8Array {
  const payload = new Uint8Array([kind === 'ping' ? LIVENESS_KIND_PING : LIVENESS_KIND_PONG]);
  const parts = fragmentFrame(LIVENESS_FRAME_ID, payload);
  const chunk = parts[0];
  if (!chunk) throw new Error('liveness chunk missing');
  return chunk;
}

export function parseLivenessChunk(chunk: Uint8Array): 'ping' | 'pong' | null {
  if (chunk.byteLength !== FRAGMENT_HEADER_SIZE + 1) return null;
  if (readU32LE(chunk, 0) !== LIVENESS_FRAME_ID) return null;
  if (readU16LE(chunk, 4) !== 0) return null;
  if (readU16LE(chunk, 6) !== 1) return null;
  const kind = chunk[FRAGMENT_HEADER_SIZE];
  if (kind === LIVENESS_KIND_PING) return 'ping';
  if (kind === LIVENESS_KIND_PONG) return 'pong';
  return null;
}

export function isLivenessFrameId(chunk: Uint8Array): boolean {
  if (chunk.byteLength < 4) return false;
  return readU32LE(chunk, 0) === LIVENESS_FRAME_ID;
}

function defaultSetTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return handle;
}

export class ChannelLiveness {
  private readonly peer: string | undefined;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly sendPing: () => void;
  private readonly onTimeout: (idleMs: number) => void;
  private lastInboundAt = 0;
  private intervalHandle: unknown = null;
  private timeoutHandle: unknown = null;
  private running = false;

  constructor(opts: ChannelLivenessOptions) {
    const cfg = readRtcLivenessConfig();
    this.peer = opts.peer;
    this.intervalMs = opts.intervalMs ?? cfg.intervalMs;
    this.timeoutMs = opts.timeoutMs ?? cfg.timeoutMs;
    this.now = opts.now ?? Date.now;
    this.setTimeoutFn = opts.setTimeoutFn ?? defaultSetTimeout;
    this.clearTimeoutFn =
      opts.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.sendPing = opts.sendPing;
    this.onTimeout = opts.onTimeout;
  }

  start(): void {
    this.stop();
    this.running = true;
    this.lastInboundAt = this.now();
    this.armInterval();
    this.armTimeout();
  }

  stop(): void {
    this.running = false;
    this.clearIntervalTimer();
    this.clearTimeoutTimer();
  }

  noteInbound(): void {
    if (!this.running) return;
    this.lastInboundAt = this.now();
    this.armTimeout();
    this.armInterval();
  }

  private armInterval(): void {
    this.clearIntervalTimer();
    if (!this.running || this.intervalMs <= 0) return;
    this.intervalHandle = this.setTimeoutFn(() => {
      this.intervalHandle = null;
      if (!this.running) return;
      try {
        if (this.now() - this.lastInboundAt >= this.intervalMs) this.sendPing();
      } catch {
        // sendPing errors must not stop the interval
      }
      this.armInterval();
    }, this.intervalMs);
  }

  private armTimeout(): void {
    this.clearTimeoutTimer();
    if (!this.running || this.timeoutMs <= 0) return;
    this.timeoutHandle = this.setTimeoutFn(() => {
      this.timeoutHandle = null;
      if (!this.running) return;
      const idle = this.now() - this.lastInboundAt;
      if (idle < this.timeoutMs) {
        this.armTimeout();
        return;
      }
      rtcLog('liveness timeout', {
        ...(this.peer ? { peer: this.peer } : {}),
        idle_ms: idle,
      });
      this.stop();
      this.onTimeout(idle);
    }, this.timeoutMs);
  }

  private clearIntervalTimer(): void {
    if (this.intervalHandle == null) return;
    this.clearTimeoutFn(this.intervalHandle);
    this.intervalHandle = null;
  }

  private clearTimeoutTimer(): void {
    if (this.timeoutHandle == null) return;
    this.clearTimeoutFn(this.timeoutHandle);
    this.timeoutHandle = null;
  }
}
