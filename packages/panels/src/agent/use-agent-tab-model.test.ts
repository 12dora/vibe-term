import { describe, expect, test } from 'bun:test';

import type { Device, StateSnapshotPayload } from '@tmex/shared';
import { resolveBinding } from './use-agent-tab-model';

const devices: Device[] = [{ id: 'd1', name: 'laptop' } as Device];

function snapshotWithPane(paneId: string): StateSnapshotPayload {
  return {
    session: {
      windows: [
        {
          id: '@1',
          name: 'shell',
          customName: null,
          panes: [{ id: paneId, title: 'vim', customName: null }],
        },
      ],
    },
  } as unknown as StateSnapshotPayload;
}

describe('resolveBinding', () => {
  test('returns null without a complete binding', () => {
    expect(resolveBinding({ deviceId: null, paneId: '%1' }, undefined, devices)).toBeNull();
    expect(resolveBinding({ deviceId: 'd1', paneId: null }, undefined, devices)).toBeNull();
  });

  test('marks the binding unknown while the device has no snapshot', () => {
    expect(resolveBinding({ deviceId: 'd1', paneId: '%1' }, undefined, devices)).toEqual({
      label: '%1@laptop',
      state: 'unknown',
      windowId: null,
    });
  });

  test('resolves a live pane to its window', () => {
    const binding = resolveBinding(
      { deviceId: 'd1', paneId: '%1' },
      snapshotWithPane('%1'),
      devices
    );
    expect(binding?.state).toBe('valid');
    expect(binding?.windowId).toBe('@1');
  });

  test('marks the binding invalid when the pane vanished from the snapshot', () => {
    const binding = resolveBinding(
      { deviceId: 'd1', paneId: '%1' },
      snapshotWithPane('%9'),
      devices
    );
    expect(binding).toEqual({ label: '%1@laptop', state: 'invalid', windowId: null });
  });
});
