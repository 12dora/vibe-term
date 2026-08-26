import { describe, expect, test } from 'bun:test';
import { type StateSnapshotPayload, wsBorsh } from '@tmex/shared';

import { MetadataHierarchyBuilder } from './hierarchy-builder';
import { type PaneFieldHints, keyId } from './types';

const SERVER_EPOCH = Uint8Array.from({ length: 16 }, (_, index) => index);

function snapshot(): StateSnapshotPayload {
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
          customName: 'from-snapshot',
          panes: [
            {
              id: '%1',
              windowId: '@1',
              index: 0,
              title: 'shell',
              currentPath: '/work',
              currentCommand: 'zsh',
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

describe('MetadataHierarchyBuilder', () => {
  test('builds the device/server/session/window/pane tree and consumes unknown hints', () => {
    const unknown = new Map<string, PaneFieldHints>([['%1', { title: 'hinted' }]]);
    const taken: string[] = [];
    const builder = new MetadataHierarchyBuilder({
      deviceId: 'device-a',
      deviceName: 'Developer Mac',
      getServerEpoch: () => SERVER_EPOCH,
      getWindowCustomName: () => 'win-custom',
      getPaneCustomName: () => undefined,
      ensurePaneEpoch: () => new Uint8Array(16).fill(7),
      takeUnknownPaneHints: (paneId) => {
        taken.push(paneId);
        const hints = unknown.get(paneId);
        unknown.delete(paneId);
        return hints;
      },
    });

    const desired = builder.buildDesired(snapshot());
    expect([...desired.keys()]).toEqual([
      keyId({ entityKind: wsBorsh.SOURCE_ENTITY_DEVICE, nativeId: 'device-a' }),
      keyId({ entityKind: wsBorsh.SOURCE_ENTITY_SERVER, nativeId: 'server' }),
      keyId({ entityKind: wsBorsh.SOURCE_ENTITY_SESSION, nativeId: '$1' }),
      keyId({ entityKind: wsBorsh.SOURCE_ENTITY_WINDOW, nativeId: '@1' }),
      keyId({ entityKind: wsBorsh.SOURCE_ENTITY_PANE, nativeId: '%1' }),
    ]);
    expect(taken).toEqual(['%1']);
    expect(unknown.size).toBe(0);

    const window = desired.get(keyId({ entityKind: wsBorsh.SOURCE_ENTITY_WINDOW, nativeId: '@1' }));
    expect(window?.fields.get(wsBorsh.SOURCE_FIELD_CUSTOM_NAME)).toEqual({ String: 'win-custom' });
    const pane = desired.get(keyId({ entityKind: wsBorsh.SOURCE_ENTITY_PANE, nativeId: '%1' }));
    expect(pane?.fields.get(wsBorsh.SOURCE_FIELD_TITLE)).toEqual({ String: 'hinted' });
    expect(pane?.fields.get(wsBorsh.SOURCE_FIELD_PANE_EPOCH)).toEqual({
      Bytes16: new Uint8Array(16).fill(7),
    });
  });

  test('returns only device and server when the snapshot has no session', () => {
    const builder = new MetadataHierarchyBuilder({
      deviceId: 'device-a',
      deviceName: 'Developer Mac',
      getServerEpoch: () => SERVER_EPOCH,
      getWindowCustomName: () => undefined,
      getPaneCustomName: () => undefined,
      ensurePaneEpoch: () => null,
      takeUnknownPaneHints: () => undefined,
    });
    const desired = builder.buildDesired({ deviceId: 'device-a', session: null });
    expect(desired.size).toBe(2);
  });

  test('throws when creating a record before the server epoch is ready', () => {
    const builder = new MetadataHierarchyBuilder({
      deviceId: 'device-a',
      deviceName: 'Developer Mac',
      getServerEpoch: () => null,
      getWindowCustomName: () => undefined,
      getPaneCustomName: () => undefined,
      ensurePaneEpoch: () => null,
      takeUnknownPaneHints: () => undefined,
    });
    expect(() => builder.newRecord(wsBorsh.SOURCE_ENTITY_DEVICE, 'device-a', null)).toThrow(
      'server epoch is not ready'
    );
  });
});
