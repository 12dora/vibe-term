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
//
// epoch 只是**会话级**的序号，分不清「哪一次直连 attempt」：attempt A 关闭后启动 attempt B，
// A 的旧 `to:'direct'` 帧若在 B 挂上之后才从拥塞的 primary 上到达，只看 epoch 会把它应用到 B，
// 于是 B 在 node 还没接受它的 nonce 时就被当成活跃载体（输入丢失 / bulk 被吞）。因此切换帧
// 携带 `rtcSession`，`attachDirect(carrier, {rtcSession})` 登记期望值，不匹配的一律忽略；
// ACK 原样回显该值。老 node 发空串时按「只有一次 attempt」宽容接受。
//
// 四个阶段（`active === 'primary'` 一个值分不清「还没切进去」和「已经切回来」）：
//   primary        —— 没有直连载体；
//   pending-direct —— 载体已挂上、还没收到 `to:'direct'`：**只有这个阶段缓冲**直连入站帧；
//   direct         —— 已切换：直连入站直接投递；
//   pending-primary—— 已切回 primary、载体还在：直连上迟到的帧一律**丢弃**，靠 resume 补。
// 缓冲只在收到匹配 epoch 的 `to:'direct'` 时排空；`to:'primary'` 与载体关闭一律丢弃缓冲
// 并触发 resume——关闭时排空会把直连帧插到 primary 上排在切换帧之前的旧帧后面，造成乱序，
// 切回后再排空还会在恢复结果之后重复写入终端。

import { wsBorsh } from '@tmex/shared';

export type ActiveCarrier = 'primary' | 'direct';

export type CarrierPhase = 'primary' | 'pending-direct' | 'direct' | 'pending-primary';

/** 屏障对直连载体的最小要求；`DirectDataChannelCarrier` 天然满足。 */
export interface DirectCarrierLike {
  send(bytes: Uint8Array): 'sent' | 'backpressure' | 'closed';
  onMessage(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

/** 出站结果：`backpressure` = 已被直连排队、暂停继续压帧（不是失败，也不能改走 primary）。 */
export type BarrierSendResult = 'sent' | 'backpressure';

/** 屏障缓冲上限：与协议的单帧上限一致，超限即放弃这次直连。 */
export const MAX_BUFFERED_BYTES = 1024 * 1024;
export const MAX_BUFFERED_FRAMES = 64;

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
  maxBufferedBytes?: number;
  maxBufferedFrames?: number;
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
  /** 发起本次切换的直连 attempt；空串 = 老 node 没带。 */
  rtcSession: string;
}

function decodeSwitch(bytes: Uint8Array): SwitchFrame | null {
  try {
    const envelope = wsBorsh.decodeEnvelope(bytes);
    const payload = wsBorsh.decodePayload(wsBorsh.schema.CarrierSwitchSchema, envelope.payload);
    return {
      epoch: payload.epoch,
      to: payload.to === wsBorsh.CARRIER_SWITCH_TO_PRIMARY ? 'primary' : 'direct',
      rtcSession: payload.rtcSession,
    };
  } catch {
    return null;
  }
}

/** 挂载直连时登记的 attempt 信息。 */
export interface AttachDirectOptions {
  /** 本次 attempt 的 `rtcSession`；登记后只接受携带同值（或空串兼容）的切换帧。 */
  rtcSession?: string;
}

export class CarrierSwitchBarrier {
  private readonly options: CarrierSwitchBarrierOptions;
  private readonly maxBufferedBytes: number;
  private readonly maxBufferedFrames: number;
  private direct: DirectCarrierLike | null = null;
  private phase: CarrierPhase = 'primary';
  private buffered: Uint8Array[] = [];
  private bufferedBytes = 0;
  private appliedEpoch = 0;
  /** 当前载体所属 attempt 的 rtcSession；null = 宿主没登记，不做绑定校验。 */
  private expectedRtcSession: string | null = null;
  /** 本次 primary 会话里挂过几次直连；>1 时不再接受不带 rtcSession 的老式切换帧。 */
  private attachSeq = 0;

  constructor(options: CarrierSwitchBarrierOptions) {
    this.options = options;
    this.maxBufferedBytes = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
    this.maxBufferedFrames = options.maxBufferedFrames ?? MAX_BUFFERED_FRAMES;
  }

  get activeCarrier(): ActiveCarrier {
    return this.phase === 'direct' ? 'direct' : 'primary';
  }

  /** 仅测试与诊断。 */
  get currentPhase(): CarrierPhase {
    return this.phase;
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
  attachDirect(carrier: DirectCarrierLike, options: AttachDirectOptions = {}): void {
    const previous = this.direct;
    this.direct = carrier;
    this.expectedRtcSession = options.rtcSession || null;
    this.attachSeq += 1;
    this.dropBuffer();
    this.setPhase('pending-direct');
    if (previous && previous !== carrier) {
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
    if (this.phase === 'direct') {
      this.options.deliver(bytes);
      return;
    }
    if (this.phase !== 'pending-direct') {
      // 已切回 primary（或还没挂载）：迟到的直连帧丢弃，缺口由 resume 补齐。
      return;
    }
    // 屏障：切换通知还没到，先缓冲，保证跨切换不乱序。
    if (
      this.buffered.length + 1 > this.maxBufferedFrames ||
      this.bufferedBytes + bytes.byteLength > this.maxBufferedBytes
    ) {
      // primary 上的切换通知迟迟不到而直连在猛灌数据：放弃这次直连，保住 primary。
      this.abortDirect();
      return;
    }
    this.buffered.push(bytes);
    this.bufferedBytes += bytes.byteLength;
  }

  /** 出站：按活跃载体路由；直连已关则就地回落 primary。 */
  send(bytes: Uint8Array): BarrierSendResult {
    const direct = this.direct;
    if (this.phase === 'direct' && direct) {
      const result = direct.send(bytes);
      if (result === 'sent') return 'sent';
      // 已排进直连的整帧队列：不能再往 primary 发一份，否则重复且乱序。
      if (result === 'backpressure') return 'backpressure';
      this.handleDirectClose(direct);
    }
    this.options.sendPrimary(bytes);
    return 'sent';
  }

  /** 直连关闭：回落 primary 并触发 resume（node 的切回通知可能永远到不了）。 */
  handleDirectClose(carrier?: DirectCarrierLike): void {
    if (carrier && this.direct && carrier !== this.direct) return;
    this.direct = null;
    this.expectedRtcSession = null;
    // 关闭时**不排空**：缓冲里的帧排在 primary 队尾会乱序，缺口交给 resume。
    const lostBuffered = this.dropBuffer();
    const wasDirect = this.phase === 'direct';
    this.setPhase('primary');
    if (wasDirect || lostBuffered) this.options.resumeSubscribedPanes?.();
  }

  /** primary 断开 → 会话整体结束，直连随之关闭。 */
  closeDirect(): void {
    const direct = this.direct;
    this.direct = null;
    this.expectedRtcSession = null;
    this.attachSeq = 0;
    this.dropBuffer();
    this.setPhase('primary');
    this.appliedEpoch = 0;
    if (!direct) return;
    try {
      direct.close();
    } catch {
      // 已在关闭中
    }
  }

  /** 重连后 node 侧是全新会话，epoch 从 0 重新计。 */
  reset(): void {
    this.dropBuffer();
    this.appliedEpoch = 0;
    this.setPhase(this.direct ? 'pending-direct' : 'primary');
  }

  private applySwitch(bytes: Uint8Array): void {
    const frame = decodeSwitch(bytes);
    if (!frame) return;
    if (frame.epoch <= this.appliedEpoch) return; // 陈旧 epoch：忽略，且不回 ACK
    if (!this.matchesAttempt(frame)) {
      // 上一次 attempt 的迟到帧：不能拿它激活当前载体，也不回 ACK。
      console.warn(
        `[carrier-switch] drop switch from stale attempt: got "${frame.rtcSession}", expected "${this.expectedRtcSession ?? ''}"`
      );
      return;
    }

    if (frame.to === 'direct') {
      if (!this.direct) return; // 还没挂上载体，不认这次切换（node 会在下个 epoch 重来）
      if (this.phase === 'direct') return; // 已经在直连上，不重复切
      this.appliedEpoch = frame.epoch;
      this.flushBuffered();
      this.setPhase('direct');
      // ACK 必须走**旧载体**（primary），否则 node 在收到 ACK 前不认直连入站。
      this.options.sendPrimary(this.encodeAck(frame.epoch, frame.rtcSession));
      return;
    }

    this.appliedEpoch = frame.epoch;
    const lostBuffered = this.dropBuffer();
    const wasDirect = this.phase === 'direct';
    if (wasDirect || this.phase === 'pending-direct') {
      this.setPhase(this.direct ? 'pending-primary' : 'primary');
    }
    if (wasDirect || lostBuffered) this.options.resumeSubscribedPanes?.();
  }

  /**
   * 切换帧是否属于当前 attempt：
   * 宿主没登记期望值时不校验；老 node 不带 `rtcSession`（空串）只在唯一一次 attempt 时接受。
   */
  private matchesAttempt(frame: SwitchFrame): boolean {
    const expected = this.expectedRtcSession;
    if (!expected) return true;
    if (frame.rtcSession === expected) return true;
    if (frame.rtcSession === '') return this.attachSeq === 1;
    return false;
  }

  /** 缓冲超限：关掉直连（控制器会退避重连），保住 primary 并触发一次 resume。 */
  private abortDirect(): void {
    const direct = this.direct;
    this.direct = null;
    this.expectedRtcSession = null;
    this.dropBuffer();
    this.setPhase('primary');
    if (direct) {
      try {
        direct.close();
      } catch {
        // 已在关闭中
      }
    }
    this.options.resumeSubscribedPanes?.();
  }

  private encodeAck(epoch: number, rtcSession: string): Uint8Array {
    const payload = wsBorsh.encodePayload(wsBorsh.schema.CarrierSwitchAckSchema, {
      epoch,
      rtcSession,
    });
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
    this.bufferedBytes = 0;
    for (const frame of pending) this.options.deliver(frame);
  }

  /** 丢弃缓冲；返回是否真的丢掉了帧（据此决定要不要 resume）。 */
  private dropBuffer(): boolean {
    if (this.buffered.length === 0) return false;
    this.buffered = [];
    this.bufferedBytes = 0;
    return true;
  }

  private setPhase(next: CarrierPhase): void {
    if (this.phase === next) return;
    const before = this.activeCarrier;
    this.phase = next;
    const after = this.activeCarrier;
    if (before !== after) this.options.onCarrierChange?.(after);
  }
}
