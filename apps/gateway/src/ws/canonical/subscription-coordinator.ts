import { wsBorsh } from '@tmex/shared';

import type {
  PaneReplayPlan,
  PaneSubscriptionApplyResult,
  PaneSubscriptionRequest,
} from '../../tmux-client/pane-retention';
import { bytesEqual, copyBytes, paneKey } from './bytes';
import type { AttachedDevice, CanonicalPaneSubscription, CanonicalPaneTarget } from './types';

function rejectionReason(reason: string): number {
  if (reason === 'resource_exhausted') return wsBorsh.SUBSCRIPTION_REJECTED_RESOURCE_EXHAUSTED;
  if (reason === 'epoch_changed') return wsBorsh.SUBSCRIPTION_REJECTED_EPOCH_CHANGED;
  return wsBorsh.SUBSCRIPTION_REJECTED_NOT_FOUND;
}

export interface CanonicalSubscriptionApplyResult {
  generation: bigint;
  activePanes: CanonicalPaneTarget[];
  hotPanes: CanonicalPaneTarget[];
  rejected: Array<{ pane: CanonicalPaneTarget; reason: number }>;
  retainedKeys: Set<string>;
  replay: Array<{ deviceId: string; plans: PaneReplayPlan[] }>;
}

export class CanonicalSubscriptionCoordinator {
  /**
   * 服务端强制改写订阅（pane 移出分享 scope）时需要一个比客户端 generation 更大的代次，
   * 否则租约会判定「同代次不同内容」而抛冲突；bias 单调递增，客户端下一次请求仍然更大。
   */
  private bias = 0n;
  private last: {
    generation: bigint;
    activePanes: CanonicalPaneSubscription[];
    hotPanes: CanonicalPaneSubscription[];
  } | null = null;

  apply(
    generation: bigint,
    activePanes: CanonicalPaneSubscription[],
    hotPanes: CanonicalPaneSubscription[],
    devices: Iterable<AttachedDevice>
  ): CanonicalSubscriptionApplyResult {
    this.last = { generation, activePanes: [...activePanes], hotPanes: [...hotPanes] };
    return this.commit(generation, activePanes, hotPanes, devices);
  }

  /**
   * 按最新 scope 重放订阅集合，返回被撤销的 pane key。
   * 撤销不回放 replay：保留下来的 pane 游标是旧的，重放会向客户端重复推送已收到的数据。
   */
  revokeOutOfScope(
    allowsPane: (deviceId: string, paneId: string) => boolean,
    devices: Iterable<AttachedDevice>
  ): string[] {
    const last = this.last;
    if (!last) return [];
    const revoked: string[] = [];
    const keep = (list: CanonicalPaneSubscription[]): CanonicalPaneSubscription[] =>
      list.filter((item) => {
        if (allowsPane(item.pane.deviceId, item.pane.paneId)) return true;
        revoked.push(paneKey(item.pane.deviceId, item.pane.paneId));
        return false;
      });
    const activePanes = keep(last.activePanes);
    const hotPanes = keep(last.hotPanes);
    if (revoked.length === 0) return [];
    this.bias += 1n;
    this.last = { generation: last.generation, activePanes, hotPanes };
    try {
      this.commit(last.generation, activePanes, hotPanes, devices);
    } catch (error) {
      console.error('[ws] share subscription revoke failed:', error);
    }
    return revoked;
  }

  private commit(
    clientGeneration: bigint,
    activePanes: CanonicalPaneSubscription[],
    hotPanes: CanonicalPaneSubscription[],
    devices: Iterable<AttachedDevice>
  ): CanonicalSubscriptionApplyResult {
    const generation = clientGeneration + this.bias;
    const deviceList = Array.from(devices);
    const deviceMap = new Map(deviceList.map((device) => [device.deviceId, device]));
    const activeByDevice = new Map<string, PaneSubscriptionRequest[]>();
    const hotByDevice = new Map<string, PaneSubscriptionRequest[]>();
    const rejected: Array<{ pane: CanonicalPaneTarget; reason: number }> = [];

    const collect = (
      subscriptions: CanonicalPaneSubscription[],
      destination: Map<string, PaneSubscriptionRequest[]>
    ) => {
      for (const subscription of subscriptions) {
        const target = subscription.pane;
        const device = deviceMap.get(target.deviceId);
        const serverEpoch = device?.runtime.getServerEpoch();
        const pane = device?.runtime.getPaneIdentity(target.paneId);
        if (!device || !serverEpoch || !pane) {
          rejected.push({ pane: target, reason: wsBorsh.SUBSCRIPTION_REJECTED_NOT_FOUND });
          continue;
        }
        if (
          !bytesEqual(serverEpoch, target.serverEpoch) ||
          !bytesEqual(pane.paneEpoch, subscription.cursor?.paneEpoch ?? pane.paneEpoch)
        ) {
          rejected.push({ pane: target, reason: wsBorsh.SUBSCRIPTION_REJECTED_EPOCH_CHANGED });
          continue;
        }
        const requests = destination.get(target.deviceId) ?? [];
        requests.push({
          paneId: target.paneId,
          paneEpoch: pane.paneEpoch,
          cursor: subscription.cursor
            ? {
                paneEpoch: copyBytes(subscription.cursor.paneEpoch),
                terminalSeq: subscription.cursor.terminalSeq,
              }
            : null,
        });
        destination.set(target.deviceId, requests);
      }
    };
    collect(activePanes, activeByDevice);
    collect(hotPanes, hotByDevice);

    const applyResults: Array<{ device: AttachedDevice; result: PaneSubscriptionApplyResult }> = [];
    for (const device of deviceList) {
      const result = device.lease.applySubscriptions(
        generation,
        activeByDevice.get(device.deviceId) ?? [],
        hotByDevice.get(device.deviceId) ?? []
      );
      applyResults.push({ device, result });
      const serverEpoch = device.runtime.getServerEpoch();
      if (!serverEpoch) continue;
      for (const item of result.rejected) {
        rejected.push({
          pane: { deviceId: device.deviceId, serverEpoch, paneId: item.paneId },
          reason: rejectionReason(item.reason),
        });
      }
    }

    const appliedGeneration = applyResults.reduce(
      (latest, item) => (item.result.generation > latest ? item.result.generation : latest),
      generation
    );
    const appliedActive: CanonicalPaneTarget[] = [];
    const appliedHot: CanonicalPaneTarget[] = [];
    const retainedKeys = new Set<string>();
    for (const { device, result } of applyResults) {
      for (const pane of result.activePanes) {
        retainedKeys.add(paneKey(device.deviceId, pane.paneId));
      }
      for (const pane of result.hotPanes) {
        retainedKeys.add(paneKey(device.deviceId, pane.paneId));
      }
      const serverEpoch = device.runtime.getServerEpoch();
      if (!serverEpoch) continue;
      appliedActive.push(
        ...result.activePanes.map((pane) => ({
          deviceId: device.deviceId,
          serverEpoch,
          paneId: pane.paneId,
        }))
      );
      appliedHot.push(
        ...result.hotPanes.map((pane) => ({
          deviceId: device.deviceId,
          serverEpoch,
          paneId: pane.paneId,
        }))
      );
    }

    return {
      generation: appliedGeneration - this.bias,
      activePanes: appliedActive,
      hotPanes: appliedHot,
      rejected,
      retainedKeys,
      replay: applyResults.map(({ device, result }) => ({
        deviceId: device.deviceId,
        plans: result.replay,
      })),
    };
  }
}
