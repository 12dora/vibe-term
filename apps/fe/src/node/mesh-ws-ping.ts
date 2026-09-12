import { wsBorsh } from '@vibeterm/shared';

/** 前台 liveness：几秒内发现切网后的僵尸 `/mesh/ws`，不再干等 30 s 静默。 */
export const MESH_WS_PING_INTERVAL_MS = 2_500;
export const MESH_WS_PING_TIMEOUT_MS = 4_000;

export function encodeMeshPing(nonce: number, timeMs: number, seq: number): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.PingPongSchema, {
    nonce,
    timeMs: BigInt(timeMs),
  });
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_PING, payload, seq);
}

export function isMeshPong(data: Uint8Array): boolean {
  try {
    return wsBorsh.decodeEnvelope(data).kind === wsBorsh.KIND_PONG;
  } catch {
    return false;
  }
}

export interface MeshWsLivenessOptions {
  intervalMs: number;
  timeoutMs: number;
  now: () => number;
  visible: () => boolean;
  /** 距上次入站是否已超过 timeout（任意帧都算活着）。 */
  isSilent: () => boolean;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  send: (bytes: Uint8Array) => void;
  onZombie: () => void;
}

/** 前台周期性 PING；只有对端回过 PONG 之后，超时无活动才判僵尸。 */
export class MeshWsLiveness {
  private timer: unknown = null;
  private watch: unknown = null;
  private seq = 0;
  private sawPong = false;
  private started = false;

  constructor(private readonly options: MeshWsLivenessOptions) {}

  start(): void {
    this.started = true;
    this.sawPong = false;
    this.clear();
    this.arm();
  }

  stop(): void {
    this.started = false;
    this.sawPong = false;
    this.clear();
  }

  /** 转入后台：停 ping，保留「对端会回 PONG」的记忆。 */
  pause(): void {
    this.clear();
  }

  arm(): void {
    if (this.timer != null) {
      this.options.cancel(this.timer);
      this.timer = null;
    }
    if (!this.started || this.options.intervalMs <= 0 || !this.options.visible()) return;
    this.timer = this.options.schedule(() => {
      this.timer = null;
      this.sendNow();
      this.arm();
    }, this.options.intervalMs);
  }

  sendNow(): void {
    if (!this.started || this.options.intervalMs <= 0) return;
    this.seq += 1;
    try {
      this.options.send(encodeMeshPing(this.seq, this.options.now(), this.seq));
    } catch {
      this.options.onZombie();
      return;
    }
    if (!this.sawPong || this.watch != null) return;
    const sentAt = this.options.now();
    this.watch = this.options.schedule(() => {
      this.watch = null;
      if (!this.started || !this.sawPong) return;
      if (this.options.now() - sentAt < this.options.timeoutMs) return;
      if (!this.options.isSilent()) return;
      this.options.onZombie();
    }, this.options.timeoutMs);
  }

  notePong(): void {
    this.sawPong = true;
    if (this.watch == null) return;
    this.options.cancel(this.watch);
    this.watch = null;
  }

  private clear(): void {
    if (this.timer != null) {
      this.options.cancel(this.timer);
      this.timer = null;
    }
    if (this.watch != null) {
      this.options.cancel(this.watch);
      this.watch = null;
    }
  }
}
