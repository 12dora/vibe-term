// 载体切换屏障（浏览器侧），设计 §3「载体切换屏障」。
//
// 四步协议里浏览器负责的是第 2、3 步：
//  2. 收到 `CARRIER_SWITCH{epoch, to:'direct'}` **之前**，直连上到达的帧一律缓冲；收到之后
//     先排空缓冲，再把直连设为活跃接收源，然后在**旧载体（primary）**上回
//     `CARRIER_SWITCH_ACK{epoch}`，此后出站帧才改走直连。
//  3. 收到 `CARRIER_SWITCH{epoch+1, to:'primary'}` 切回 primary，并触发一次已订阅 pane 的
//     resume（切回瞬间浏览器→node 方向可能丢帧，node→浏览器方向靠 resume 补齐）。
// primary 断开则会话整体结束，直连随之关闭（`closeDirect()`）。
//
// epoch 单调递增：`epoch <= applied` 的切换帧一律当作陈旧丢弃，也不回 ACK。

import { wsBorsh } from '@tmex/shared';

export type ActiveCarrier = 'primary' | 'direct';

/** 屏障对直连载体的最小要求；`DirectDataChannelCarrier` 天然满足。 */
export interface DirectCarrierLike {
  send(bytes: Uint8Array): 'sent' | 'backpressure' | 'closed';
  onMessage(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export interface CarrierSwitchBarrierOptions {
  /** 把一帧交给协议分发（等价于 primary 的 onmessage 路径）。 */
  deliver: (bytes: Uint8Array) => void;
  /** 在 primary 上发一帧原始字节。 */
  sendPrimary: (bytes: Uint8Array) => void;
  /** envelope 的 seq 分配器；缺省恒为 0（seq 不参与去重，仅诊断用）。 */
  nextSeq?: () => number;
  /** 活跃载体变化通知。 */
  onCarrierChange?: (active: ActiveCarrier) => void;
  /** 切回 primary 时触发已订阅 pane 的 resume。 */
  resumeSubscribedPanes?: () => void;
}

/** 从 envelope 头部第 4、5 字节直接读 kind（LE u16），避免为每帧做完整反序列化。 */
export function peekEnvelopeKind(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 12) return null;
  if (bytes[0] !== 0x54 || bytes[1] !== 0x58) return null;
  const lo = bytes[4];
  const hi = bytes[5];
  if (lo === undefined || hi === undefined) return null;
  return lo | (hi << 8);
}

interface SwitchFrame {
  epoch: number;
  to: ActiveCarrier;
}

function decodeSwitch(bytes: Uint8Array): SwitchFrame | null {
  try {
    const envelope = wsBorsh.decodeEnvelope(bytes);
    const payload = wsBorsh.decodePayload(wsBorsh.schema.CarrierSwitchSchema, envelope.payload);
    return {
      epoch: payload.epoch,
      to: payload.to === wsBorsh.CARRIER_SWITCH_TO_PRIMARY ? 'primary' : 'direct',
    };
  } catch {
    return null;
  }
}

export class CarrierSwitchBarrier {
  private readonly options: CarrierSwitchBarrierOptions;
  private direct: DirectCarrierLike | null = null;
  private active: ActiveCarrier = 'primary';
  private buffered: Uint8Array[] = [];
  private appliedEpoch = 0;

  constructor(options: CarrierSwitchBarrierOptions) {
    this.options = options;
  }

  get activeCarrier(): ActiveCarrier {
    return this.active;
  }

  get hasDirect(): boolean {
    return this.direct !== null;
  }

  /** 仅测试与诊断：尚未排空的直连帧数。 */
  get bufferedCount(): number {
    return this.buffered.length;
  }

  /**
   * 挂载直连载体。此刻**还不切换**：要等 node 在 primary 上发来 `CARRIER_SWITCH{to:'direct'}`。
   * 已有直连则先关掉旧的。
   */
  attachDirect(carrier: DirectCarrierLike): void {
    const previous = this.direct;
    this.direct = carrier;
    this.buffered = [];
    if (previous && previous !== carrier) {
      if (this.active === 'direct') this.setActive('primary');
      try {
        previous.close();
      } catch {
        // 旧载体可能已在关闭中
      }
    }
    carrier.onMessage((bytes) => this.handleDirectInbound(bytes));
    carrier.onClose(() => this.handleDirectClose(carrier));
  }

  /** primary 上到达的一帧。 */
  handlePrimaryInbound(bytes: Uint8Array): void {
    const kind = peekEnvelopeKind(bytes);
    if (kind === wsBorsh.KIND_CARRIER_SWITCH) {
      this.applySwitch(bytes);
      return;
    }
    if (kind === wsBorsh.KIND_CARRIER_SWITCH_ACK) return;
    this.options.deliver(bytes);
  }

  /** 直连上到达的一帧。 */
  handleDirectInbound(bytes: Uint8Array): void {
    const kind = peekEnvelopeKind(bytes);
    if (kind === wsBorsh.KIND_CARRIER_SWITCH) {
      this.applySwitch(bytes);
      return;
    }
    if (kind === wsBorsh.KIND_CARRIER_SWITCH_ACK) return;
    if (this.active === 'primary') {
      // 屏障：切换通知还没到，先缓冲，保证跨切换不乱序。
      this.buffered.push(bytes);
      return;
    }
    this.options.deliver(bytes);
  }

  /** 出站：按活跃载体路由；直连已关则就地回落 primary。 */
  send(bytes: Uint8Array): void {
    const direct = this.direct;
    if (this.active === 'direct' && direct) {
      const result = direct.send(bytes);
      if (result !== 'closed') return;
      this.handleDirectClose(direct);
    }
    this.options.sendPrimary(bytes);
  }

  /** 直连关闭：回落 primary 并触发 resume（node 的切回通知可能永远到不了）。 */
  handleDirectClose(carrier?: DirectCarrierLike): void {
    if (carrier && this.direct && carrier !== this.direct) return;
    this.direct = null;
    this.flushBuffered();
    if (this.active === 'direct') {
      this.setActive('primary');
      this.options.resumeSubscribedPanes?.();
    }
  }

  /** primary 断开 → 会话整体结束，直连随之关闭。 */
  closeDirect(): void {
    const direct = this.direct;
    if (!direct) {
      this.reset();
      return;
    }
    this.direct = null;
    try {
      direct.close();
    } catch {
      // 已在关闭中
    }
    if (this.active === 'direct') this.setActive('primary');
    this.buffered = [];
    this.appliedEpoch = 0;
  }

  /** 重连后 node 侧是全新会话，epoch 从 0 重新计。 */
  reset(): void {
    this.buffered = [];
    this.appliedEpoch = 0;
    if (this.active === 'direct') this.setActive('primary');
  }

  private applySwitch(bytes: Uint8Array): void {
    const frame = decodeSwitch(bytes);
    if (!frame) return;
    if (frame.epoch <= this.appliedEpoch) return; // 陈旧 epoch：忽略，且不回 ACK

    if (frame.to === 'direct') {
      if (!this.direct) return; // 还没挂上载体，不认这次切换（node 会在下个 epoch 重来）
      this.appliedEpoch = frame.epoch;
      this.flushBuffered();
      this.setActive('direct');
      // ACK 必须走**旧载体**（primary），否则 node 在收到 ACK 前不认直连入站。
      this.options.sendPrimary(this.encodeAck(frame.epoch));
      return;
    }

    this.appliedEpoch = frame.epoch;
    this.flushBuffered();
    if (this.active === 'direct') {
      this.setActive('primary');
      this.options.resumeSubscribedPanes?.();
    }
  }

  private encodeAck(epoch: number): Uint8Array {
    const payload = wsBorsh.encodePayload(wsBorsh.schema.CarrierSwitchAckSchema, { epoch });
    return wsBorsh.encodeEnvelope(
      wsBorsh.KIND_CARRIER_SWITCH_ACK,
      payload,
      this.options.nextSeq?.() ?? 0
    );
  }

  private flushBuffered(): void {
    if (this.buffered.length === 0) return;
    const pending = this.buffered;
    this.buffered = [];
    for (const frame of pending) this.options.deliver(frame);
  }

  private setActive(next: ActiveCarrier): void {
    if (this.active === next) return;
    this.active = next;
    this.options.onCarrierChange?.(next);
  }
}
