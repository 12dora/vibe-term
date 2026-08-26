import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';

import { PaneRetention } from '../../tmux-client/pane-retention';
import { CanonicalSubscriptionCoordinator } from './subscription-coordinator';
import type { AttachedDevice, CanonicalFeedRuntime } from './types';

const SERVER_EPOCH = new Uint8Array(16).fill(0x11);
const PANE_EPOCH = new Uint8Array(16).fill(0x22);

function device(deviceId: string, paneIds: string[]): AttachedDevice {
  const retention = new PaneRetention({ scheduleTimers: false });
  retention.reconcilePanes(paneIds.map((paneId) => ({ paneId, paneEpoch: PANE_EPOCH })));
  const runtime = {
    getServerEpoch: () => SERVER_EPOCH,
    getPaneIdentity: (paneId: string) =>
      paneIds.includes(paneId) ? { paneId, paneEpoch: PANE_EPOCH } : null,
    attachPaneConsumer: (callbacks: Parameters<PaneRetention['attachConsumer']>[0]) =>
      retention.attachConsumer(callbacks),
  } as unknown as CanonicalFeedRuntime;
  return {
    deviceId,
    runtime,
    lease: retention.attachConsumer({ onData: () => {} }),
    detachListener: () => {},
    metadataNeedsRebase: false,
  };
}

describe('canonical subscription coordinator', () => {
  test('validates missing panes, applies generation, and clears unmentioned devices', () => {
    const coordinator = new CanonicalSubscriptionCoordinator();
    const first = device('device-a', ['%1']);
    const second = device('device-b', ['%1']);
    second.lease.applySubscriptions(
      1n,
      [{ paneId: '%1', paneEpoch: PANE_EPOCH, cursor: null }],
      []
    );

    const applied = coordinator.apply(
      2n,
      [
        {
          pane: { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%missing' },
          cursor: null,
        },
        {
          pane: { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' },
          cursor: null,
        },
      ],
      [],
      [first, second]
    );

    expect(applied.generation).toBe(2n);
    expect(applied.activePanes).toEqual([
      { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' },
    ]);
    expect(applied.hotPanes).toEqual([]);
    expect(applied.rejected).toEqual([
      {
        pane: { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%missing' },
        reason: wsBorsh.SUBSCRIPTION_REJECTED_NOT_FOUND,
      },
    ]);
    expect(applied.retainedKeys.has('device-a\0%1')).toBe(true);
    expect(applied.retainedKeys.has('device-b\0%1')).toBe(false);
  });
});
