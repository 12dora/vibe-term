// primary 会话上挂的直连载体（设计 §3「载体切换屏障」）：屏障懒建，未挂载直连时 primary
// 的收发路径与之前完全一致。primary 会话结束时先通知订阅者、再关直连。

import {
  type ActiveCarrier,
  type AttachDirectOptions,
  CarrierSwitchBarrier,
  type DirectCarrierLike,
} from './carrier-switch';
import { HandlerSet } from './handler-fanout';

export interface PrimaryCarrierHost {
  /** 把一帧交给协议分发（等价于 primary 的 onmessage 路径）。 */
  deliver(bytes: Uint8Array): void;
  sendPrimary(bytes: Uint8Array): void;
  nextSeq(): number;
}

export class PrimaryCarrierLink {
  private barrier: CarrierSwitchBarrier | null = null;
  private readonly carrierChange = new HandlerSet<ActiveCarrier>('carrier change');
  private readonly sessionEnd = new HandlerSet('session end');
  private resumeSubscribedPanes: (() => void) | null = null;

  constructor(private readonly host: PrimaryCarrierHost) {}

  get active(): ActiveCarrier {
    return this.barrier?.activeCarrier ?? 'primary';
  }

  attach(carrier: DirectCarrierLike, options?: AttachDirectOptions): void {
    this.ensureBarrier().attachDirect(carrier, options);
  }

  detach(): void {
    this.barrier?.handleDirectClose();
  }

  onCarrierChange(handler: (active: ActiveCarrier) => void): () => void {
    return this.carrierChange.add(handler);
  }

  onSessionEnd(handler: () => void): () => void {
    return this.sessionEnd.add(handler);
  }

  setResumeSubscribedPanes(fn: (() => void) | null): void {
    this.resumeSubscribedPanes = fn;
  }

  /** primary 上到达的二进制帧：挂过直连就交给屏障分流，返回 true；否则由调用方照常分发。 */
  handlePrimaryInbound(data: unknown): boolean {
    if (!this.barrier || typeof data === 'string') return false;
    this.barrier.handlePrimaryInbound(new Uint8Array(data as ArrayBuffer));
    return true;
  }

  /** 挂过直连时按活跃载体发送（`false` = 已排进直连队列）；没挂过返回 `null`，调用方走 primary。 */
  send(data: Uint8Array): boolean | null {
    if (!this.barrier) return null;
    return this.barrier.send(data) === 'sent';
  }

  /** primary 会话结束：先通知订阅者，再关掉挂在这条会话上的直连。 */
  endSession(): void {
    this.sessionEnd.emit();
    this.barrier?.closeDirect();
  }

  /** 直连正在承载业务时摘掉它回落 primary（会触发补齐订阅）；返回是否摘了。 */
  dropActiveDirect(): boolean {
    if (this.barrier?.activeCarrier !== 'direct') return false;
    this.barrier.handleDirectClose();
    return true;
  }

  private ensureBarrier(): CarrierSwitchBarrier {
    if (this.barrier) return this.barrier;
    this.barrier = new CarrierSwitchBarrier({
      deliver: (bytes) => this.host.deliver(bytes),
      sendPrimary: (bytes) => this.host.sendPrimary(bytes),
      nextSeq: () => this.host.nextSeq(),
      onCarrierChange: (active) => this.carrierChange.emit(active),
      resumeSubscribedPanes: () => this.resumeSubscribedPanes?.(),
    });
    return this.barrier;
  }
}
