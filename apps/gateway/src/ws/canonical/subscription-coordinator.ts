import { wsBorsh } from '@tmex/shared';

import type {
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
}

export class CanonicalSubscriptionCoordinator {
  apply(
    generation: bigint,
    activePanes: CanonicalPaneSubscription[],
    hotPanes: CanonicalPaneSubscription[],
    devices: Iterable<AttachedDevice>
  ): CanonicalSubscriptionApplyResult {
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
      generation: appliedGeneration,
      activePanes: appliedActive,
      hotPanes: appliedHot,
      rejected,
      retainedKeys,
    };
  }
}
