// canonical v1.1 的 sizeEpoch 账本。
//
// 网关按 (会话, pane) 记住最后一次 epoch 并丢弃更旧的尺寸，所以客户端这边必须单调递增：
// 计数器按连接（而非按 pane）自增，pane 条目被清掉后新的一次真实变化仍拿到更大的值。
// 0 是保留值（编码侧拒绝），补发在该 pane 没有过真实变化时用 1。

import { paneKey } from './canonical-state-helpers';

export class CanonicalSizeEpochs {
  private readonly epochs = new Map<string, bigint>();
  private next = 0n;

  /** 真实尺寸变化：自增并记到该 pane 名下 */
  change(deviceId: string, paneId: string): bigint {
    this.next += 1n;
    this.epochs.set(paneKey(deviceId, paneId), this.next);
    return this.next;
  }

  /** 补发：复用该 pane 上一次变化的 epoch */
  resend(deviceId: string, paneId: string): bigint {
    return this.epochs.get(paneKey(deviceId, paneId)) ?? (this.next > 0n ? this.next : 1n);
  }

  /** 按命令类型取值：真实变化自增，补发复用。 */
  forGeometry(deviceId: string, paneId: string, change: boolean): bigint {
    return change ? this.change(deviceId, paneId) : this.resend(deviceId, paneId);
  }

  /** pane 被移除：丢掉它的条目；`next` 不回退，重新出现的同名 pane 仍拿更大的 epoch。 */
  dropPane(deviceId: string, paneId: string): boolean {
    return this.epochs.delete(paneKey(deviceId, paneId));
  }

  keys(): IterableIterator<string> {
    return this.epochs.keys();
  }

  delete(key: string): boolean {
    return this.epochs.delete(key);
  }

  clear(): void {
    this.epochs.clear();
  }
}
