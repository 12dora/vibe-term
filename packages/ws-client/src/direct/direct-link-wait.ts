// 等宿主的「打不通」退避（与 REST、primary 重连共用一份账）。退避期间一律不起协商，等多久由宿主
// 的账决定（会翻倍到 10 分钟）；它被清掉时（primary 稳定、REST 成功、节点转在线、页面恢复）不会
// 通知直连控制器——所以按短步长复查，清掉后最多一个步长就能起 attempt。

/** 复查步长：退避被清掉后最多这么久就能起 attempt。 */
export const LINK_BACKOFF_RECHECK_MS = 5000;

export class LinkBackoffWait {
  private waiting = false;

  constructor(private readonly remaining: () => number) {}

  /** 这次还要等多久再复查；0 表示不在退避里，并结束本轮等待。 */
  next(): number {
    const remaining = this.remaining();
    this.waiting = remaining > 0;
    return this.waiting ? Math.min(remaining, LINK_BACKOFF_RECHECK_MS) : 0;
  }

  /** 正在等、而宿主的退避已被清掉：可以提前结束。 */
  get cleared(): boolean {
    return this.waiting && this.remaining() <= 0;
  }

  reset(): void {
    this.waiting = false;
  }
}
