import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import type { DeviceSessionRuntimeListener } from '../tmux-client/device-session-runtime';
import type { PaneHistoryPage } from '../tmux-client/pane-history-reader';
import {
  PaneRetention,
  type PaneRetentionConsumerCallbacks,
  type PaneScreenCheckpoint,
} from '../tmux-client/pane-retention';
import { CanonicalFeedSession } from './canonical-feed-session';
import type { CanonicalFeedRuntime, CanonicalSendResult } from './canonical/types';
import type { ShareScope } from './share-scope';

const SCOPE: ShareScope = { shareId: 'sh1', deviceId: 'device-a', windowId: '@1' };
const SERVER_EPOCH = new Uint8Array(16).fill(0x11);
const PANE_EPOCH = new Uint8Array(16).fill(0x22);
const REQUEST_ID = new Uint8Array(16).fill(0x33);
/** %1 属于 scope window @1，%9 属于另一个 window。 */
const IN_SCOPE_PANE = '%1';
const OUT_OF_SCOPE_PANE = '%9';

class ShareFakeRuntime implements CanonicalFeedRuntime {
  readonly retention = new PaneRetention({ scheduleTimers: false });
  readonly input: Array<[string, string]> = [];

  constructor(readonly deviceId = SCOPE.deviceId) {
    this.retention.reconcilePanes([
      { paneId: IN_SCOPE_PANE, paneEpoch: PANE_EPOCH },
      { paneId: OUT_OF_SCOPE_PANE, paneEpoch: PANE_EPOCH },
    ]);
  }

  getServerEpoch(): Uint8Array {
    return SERVER_EPOCH;
  }

  getMetadataSnapshot() {
    return { metadataEpoch: new Uint8Array(16).fill(0x44), revision: 1n, records: [] };
  }

  getPaneIdentity(paneId: string) {
    return paneId === IN_SCOPE_PANE || paneId === OUT_OF_SCOPE_PANE
      ? { paneId, paneEpoch: PANE_EPOCH }
      : null;
  }

  attachPaneConsumer(callbacks: PaneRetentionConsumerCallbacks) {
    return this.retention.attachConsumer(callbacks);
  }

  subscribe(listener: DeviceSessionRuntimeListener): () => void {
    void listener;
    return () => {};
  }

  async readPaneHistory(): Promise<PaneHistoryPage | null> {
    return null;
  }

  async captureCanonicalScreen(): Promise<PaneScreenCheckpoint | null> {
    return null;
  }

  sendInputBytes(paneId: string, data: Uint8Array): void {
    this.input.push([paneId, new TextDecoder().decode(data)]);
  }

  resizePane(): void {}
}

function createSession(runtime: ShareFakeRuntime): {
  session: CanonicalFeedSession;
  events: wsBorsh.CanonicalEvent[];
} {
  const events: wsBorsh.CanonicalEvent[] = [];
  const session = new CanonicalFeedSession({
    maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
    shareScope: SCOPE,
    isPaneInShareScope: (deviceId, paneId) =>
      deviceId === SCOPE.deviceId && paneId === IN_SCOPE_PANE,
    sendEvent: (event): CanonicalSendResult => {
      events.push(event);
      return true;
    },
    resolveRuntime: async (deviceId) => (deviceId === runtime.deviceId ? runtime : null),
  });
  return { session, events };
}

function paneTarget(paneId: string, deviceId = SCOPE.deviceId) {
  return { deviceId, serverEpoch: SERVER_EPOCH, paneId };
}

function subscriptionApplied(events: wsBorsh.CanonicalEvent[]) {
  const event = events.find((item) => 'SubscriptionApplied' in item);
  if (!event || !('SubscriptionApplied' in event)) throw new Error('no SubscriptionApplied');
  return event.SubscriptionApplied;
}

describe('canonical feed session share scope', () => {
  test('scope window 内的 pane 订阅生效，window 外的 pane 回 NOT_FOUND', async () => {
    const runtime = new ShareFakeRuntime();
    const { session, events } = createSession(runtime);
    await session.handleCommand({
      SetPaneSubscriptions: {
        generation: 1n,
        activePanes: [
          { pane: paneTarget(IN_SCOPE_PANE), cursor: null },
          { pane: paneTarget(OUT_OF_SCOPE_PANE), cursor: null },
        ],
        hotPanes: [],
      },
    });

    const applied = subscriptionApplied(events);
    expect(applied.activePanes.map((pane) => pane.paneId)).toEqual([IN_SCOPE_PANE]);
    expect(applied.rejected).toEqual([
      {
        pane: paneTarget(OUT_OF_SCOPE_PANE),
        reason: wsBorsh.SUBSCRIPTION_REJECTED_NOT_FOUND,
      },
    ]);
    session.close();
  });

  test('scope 外 pane 的输入按 pane not found 拒绝', async () => {
    const runtime = new ShareFakeRuntime();
    const { session, events } = createSession(runtime);
    const input = (paneId: string): wsBorsh.CanonicalCommand => ({
      TerminalInput: {
        requestId: REQUEST_ID,
        pane: paneTarget(paneId),
        paneEpoch: PANE_EPOCH,
        inputId: new Uint8Array(16).fill(paneId === IN_SCOPE_PANE ? 0x55 : 0x66),
        data: new TextEncoder().encode('ls'),
      },
    });

    await session.handleCommand(input(OUT_OF_SCOPE_PANE));
    expect(runtime.input).toEqual([]);
    const error = events.find((item) => 'Error' in item);
    if (!error || !('Error' in error)) throw new Error('expected error event');
    expect(error.Error.code).toBe(wsBorsh.ERROR_TMUX_TARGET_NOT_FOUND);

    await session.handleCommand(input(IN_SCOPE_PANE));
    expect(runtime.input).toEqual([[IN_SCOPE_PANE, 'ls']]);
    session.close();
  });

  test('scope 之外的设备无法挂载', async () => {
    const runtime = new ShareFakeRuntime();
    const { session } = createSession(runtime);
    expect(await session.attachDevice('device-b')).toBe(false);
    expect(await session.attachDevice(SCOPE.deviceId, runtime)).toBe(true);
    session.close();
  });

  test('非分享连接不受 scope 限制', async () => {
    const runtime = new ShareFakeRuntime();
    const events: wsBorsh.CanonicalEvent[] = [];
    const session = new CanonicalFeedSession({
      maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
      sendEvent: (event): CanonicalSendResult => {
        events.push(event);
        return true;
      },
      resolveRuntime: async () => runtime,
    });
    await session.handleCommand({
      SetPaneSubscriptions: {
        generation: 1n,
        activePanes: [{ pane: paneTarget(OUT_OF_SCOPE_PANE), cursor: null }],
        hotPanes: [],
      },
    });
    const applied = subscriptionApplied(events);
    expect(applied.activePanes.map((pane) => pane.paneId)).toEqual([OUT_OF_SCOPE_PANE]);
    expect(applied.rejected).toEqual([]);
    session.close();
  });
});
