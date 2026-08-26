import { describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload } from '@tmex/shared';

import type { DeviceSessionRuntimeListener } from '../device-session-runtime';
import { MetadataProjection } from '../metadata-projection';
import { PaneHistoryReader } from '../pane-history-reader';
import { PaneRetention } from '../pane-retention';
import { RuntimeEventBridge } from './event-bridge';

const SERVER_EPOCH = new Uint8Array(16).fill(1);

function snapshotPaneTitle(payload: StateSnapshotPayload | null): string | undefined {
  return payload?.session?.windows[0]?.panes[0]?.title;
}

function snapshot(title = 'shell'): StateSnapshotPayload {
  return {
    deviceId: 'device-a',
    session: {
      id: '$1',
      name: 'work',
      windows: [
        {
          id: '@1',
          name: 'main',
          index: 0,
          active: true,
          layout: 'b25d,80x24,0,0,1',
          panes: [
            {
              id: '%1',
              windowId: '@1',
              index: 0,
              title,
              active: true,
              width: 80,
              height: 24,
              left: 0,
              top: 0,
            },
          ],
        },
      ],
    },
  };
}

describe('RuntimeEventBridge', () => {
  test('wires snapshot, metadata, output and close callbacks onto the runtime host', () => {
    const metadata = new MetadataProjection('device-a', { deviceName: 'Mac' });
    const paneRetention = new PaneRetention();
    const historyReader = new PaneHistoryReader({
      getPaneHistoryCaptureInfo: async () => ({ historySize: 0, cols: 80 }),
      capturePaneHistoryRange: async () => '',
    });
    let lastSnapshot: StateSnapshotPayload | null = null;
    const events: string[] = [];
    const listeners: DeviceSessionRuntimeListener[] = [
      {
        onEvent: (event) => events.push(`event:${event.type}`),
        onTerminalOutput: (paneId) => events.push(`out:${paneId}`),
        onSnapshot: (payload) => events.push(`snap:${payload.deviceId}`),
        onClose: () => events.push('close'),
      },
    ];
    let unexpectedCloses = 0;

    const bridge = new RuntimeEventBridge({
      metadata,
      paneRetention,
      getHistoryReader: () => historyReader,
      getLastSnapshot: () => lastSnapshot,
      setLastSnapshot: (payload) => {
        lastSnapshot = payload;
      },
      broadcast: (action) => {
        for (const listener of listeners) action(listener);
      },
      handleUnexpectedClose: () => {
        unexpectedCloses += 1;
        for (const listener of listeners) listener.onClose?.();
      },
    });

    const options = bridge.connectionOptions({ deviceId: 'device-a' });
    options.onSourceReady?.(SERVER_EPOCH);
    options.onEvent({ type: 'bell', data: { paneId: '%1' } });
    options.onSnapshot(snapshot());
    options.onSnapshot(snapshot());
    options.onTerminalOutput('%1', new Uint8Array([0x41]));
    options.onSourceMetadata?.({ type: 'pane-title', paneId: '%1', title: 'new' });
    options.onClose();

    expect(events).toEqual(['event:bell', 'snap:device-a', 'out:%1', 'close']);
    expect(unexpectedCloses).toBe(1);
    expect(snapshotPaneTitle(lastSnapshot)).toBe('shell');
    expect(metadata.revision).toBe(2n);
    expect(paneRetention.getLatestCursor('%1')?.terminalSeq).toBe(1n);
  });

  test('metadata patch callback applies a legacy snapshot diff', () => {
    const paneRetention = new PaneRetention();
    const historyReader = new PaneHistoryReader({
      getPaneHistoryCaptureInfo: async () => ({ historySize: 0, cols: 80 }),
      capturePaneHistoryRange: async () => '',
    });
    let lastSnapshot: StateSnapshotPayload | null = null;
    const patches: number[] = [];
    const host = {
      metadata: null as unknown as MetadataProjection,
      paneRetention,
      getHistoryReader: () => historyReader,
      getLastSnapshot: () => lastSnapshot,
      setLastSnapshot: (payload: StateSnapshotPayload) => {
        lastSnapshot = payload;
      },
      broadcast: (action: (listener: DeviceSessionRuntimeListener) => void) => {
        action({
          onMetadataPatch: () => {
            patches.push(1);
          },
        });
      },
      handleUnexpectedClose: () => undefined,
    };
    const bridge = new RuntimeEventBridge(host);
    host.metadata = new MetadataProjection('device-a', {
      deviceName: 'Mac',
      ...bridge.metadataCallbacks(),
    });
    const options = bridge.connectionOptions({ deviceId: 'device-a' });
    options.onSourceReady?.(SERVER_EPOCH);
    options.onSnapshot(snapshot());
    options.onSourceMetadata?.({ type: 'pane-title', paneId: '%1', title: 'patched' });
    host.metadata.flushPending();
    expect(snapshotPaneTitle(lastSnapshot)).toBe('patched');
    expect(patches).toEqual([1]);
  });
});
