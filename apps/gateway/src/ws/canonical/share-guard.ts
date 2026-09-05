import { wsBorsh } from '@tmex/shared';
import type { SharePaneOracle, ShareScope } from '../share-scope';
import type { CanonicalPaneSubscription, CanonicalPaneTarget } from './types';

export interface CanonicalShareGuardOptions {
  shareScope?: ShareScope | null;
  isPaneInShareScope?: SharePaneOracle;
}

export interface ScopedSubscriptions {
  activePanes: CanonicalPaneSubscription[];
  hotPanes: CanonicalPaneSubscription[];
  rejected: Array<{ pane: CanonicalPaneTarget; reason: number }>;
}

/** 非分享连接一律放行；分享连接只认 scope 设备与 scope window 内的 pane。 */
export class CanonicalShareGuard {
  constructor(private readonly options: CanonicalShareGuardOptions) {}

  allowsDevice(deviceId: string): boolean {
    const scope = this.options.shareScope;
    return !scope || scope.deviceId === deviceId;
  }

  allowsPane(deviceId: string, paneId: string): boolean {
    const scope = this.options.shareScope;
    if (!scope) return true;
    if (scope.deviceId !== deviceId) return false;
    return this.options.isPaneInShareScope?.(deviceId, paneId) ?? false;
  }

  /**
   * 越权 pane 按 NOT_FOUND 拒绝而不是整条命令报错：
   * 客户端的订阅集合里可能混着刚被移出 window 的 pane，那是正常的竞态。
   */
  partitionSubscriptions(
    activePanes: readonly CanonicalPaneSubscription[],
    hotPanes: readonly CanonicalPaneSubscription[]
  ): ScopedSubscriptions {
    if (!this.options.shareScope) {
      return { activePanes: [...activePanes], hotPanes: [...hotPanes], rejected: [] };
    }
    const rejected: ScopedSubscriptions['rejected'] = [];
    const keep = (list: readonly CanonicalPaneSubscription[]): CanonicalPaneSubscription[] =>
      list.filter((item) => {
        if (this.allowsPane(item.pane.deviceId, item.pane.paneId)) return true;
        rejected.push({ pane: item.pane, reason: wsBorsh.SUBSCRIPTION_REJECTED_NOT_FOUND });
        return false;
      });
    return { activePanes: keep(activePanes), hotPanes: keep(hotPanes), rejected };
  }
}
