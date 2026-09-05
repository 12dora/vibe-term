import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';

import type { TmuxSourceMetadataEvent } from '../events';
import { MetadataEventApplier, formatWindowCloseObserved } from './event-applier';
import {
  type MetadataValue,
  type PaneFieldHints,
  type ProjectedRecord,
  createRecord,
  keyId,
  stringValue,
} from './types';

const SERVER_EPOCH = new Uint8Array(16);

function paneRecord(nativeId: string, title = 'shell'): ProjectedRecord {
  return createRecord(
    {
      key: {
        deviceId: 'device-a',
        serverEpoch: SERVER_EPOCH,
        entityKind: wsBorsh.SOURCE_ENTITY_PANE,
        nativeId,
      },
      parent: {
        deviceId: 'device-a',
        serverEpoch: SERVER_EPOCH,
        entityKind: wsBorsh.SOURCE_ENTITY_WINDOW,
        nativeId: '@1',
      },
      fields: new Map([[wsBorsh.SOURCE_FIELD_TITLE, stringValue(title)]]),
    },
    1n
  );
}

function windowRecord(nativeId: string): ProjectedRecord {
  return createRecord(
    {
      key: {
        deviceId: 'device-a',
        serverEpoch: SERVER_EPOCH,
        entityKind: wsBorsh.SOURCE_ENTITY_WINDOW,
        nativeId,
      },
      parent: {
        deviceId: 'device-a',
        serverEpoch: SERVER_EPOCH,
        entityKind: wsBorsh.SOURCE_ENTITY_SESSION,
        nativeId: '$1',
      },
      fields: new Map([
        [wsBorsh.SOURCE_FIELD_NAME, stringValue(nativeId)],
        [wsBorsh.SOURCE_FIELD_ACTIVE, { Bool: nativeId === '@1' }],
      ]),
    },
    1n
  );
}

describe('MetadataEventApplier', () => {
  test('caches unknown pane fields when the record is missing', () => {
    const remembered: Array<[string, PaneFieldHints]> = [];
    const applier = new MetadataEventApplier({
      records: new Map(),
      rememberUnknownPane: (paneId, fields) => remembered.push([paneId, fields]),
      setRecordField: () => {
        throw new Error('should not write');
      },
      removeRecord: () => {
        throw new Error('should not remove');
      },
    });

    expect(applier.collect({ type: 'pane-title', paneId: '%1', title: 'early' }, 2n)).toEqual([]);
    applier.cacheUnknown({ type: 'pane-current-path', paneId: '%1', currentPath: '/tmp' });
    expect(remembered).toEqual([
      ['%1', { title: 'early' }],
      ['%1', { currentPath: '/tmp' }],
    ]);
  });

  test('identical pane-title is a no-op', () => {
    const record = paneRecord('%1');
    const applier = new MetadataEventApplier({
      records: new Map([[keyId(record.key), record]]),
      rememberUnknownPane: () => {
        throw new Error('should not cache');
      },
      setRecordField: () => {
        throw new Error('should not write');
      },
      removeRecord: () => {
        throw new Error('should not remove');
      },
    });
    expect(applier.collect({ type: 'pane-title', paneId: '%1', title: 'shell' }, 2n)).toEqual([]);
  });

  test('layout-change queues window layout and existing pane geometry', () => {
    const window = windowRecord('@1');
    const pane = paneRecord('%1');
    const writes: Array<[string, number, MetadataValue]> = [];
    const applier = new MetadataEventApplier({
      records: new Map([
        [keyId(window.key), window],
        [keyId(pane.key), pane],
      ]),
      rememberUnknownPane: () => undefined,
      setRecordField: (record, field, value) => {
        writes.push([record.key.nativeId, field, value ?? { Unset: {} }]);
      },
      removeRecord: () => {
        throw new Error('should not remove');
      },
    });

    const actions = applier.collect(
      { type: 'layout-change', windowId: '@1', layout: 'aaaa,92x27,0,0,1' },
      2n
    );
    expect(actions).toHaveLength(5);
    for (const action of actions) action();
    expect(writes.map((entry) => entry[0])).toEqual(['@1', '%1', '%1', '%1', '%1']);
    expect(writes[0]?.[1]).toBe(wsBorsh.SOURCE_FIELD_LAYOUT);
    expect(writes.slice(1).map((entry) => entry[1])).toEqual([
      wsBorsh.SOURCE_FIELD_WIDTH,
      wsBorsh.SOURCE_FIELD_HEIGHT,
      wsBorsh.SOURCE_FIELD_LEFT,
      wsBorsh.SOURCE_FIELD_TOP,
    ]);
  });

  test('window-close queues a single remove of the window record', () => {
    const window = windowRecord('@1');
    const removed: string[] = [];
    const applier = new MetadataEventApplier({
      records: new Map([[keyId(window.key), window]]),
      rememberUnknownPane: () => undefined,
      setRecordField: () => {
        throw new Error('should not write');
      },
      removeRecord: (record) => {
        removed.push(record.key.nativeId);
      },
    });
    const actions = applier.collect({ type: 'window-close', windowId: '@1' }, 2n);
    expect(actions).toHaveLength(1);
    for (const action of actions) action();
    expect(removed).toEqual(['@1']);
  });

  test('session-window-changed queues active-flag updates for siblings', () => {
    const first = windowRecord('@1');
    const second = windowRecord('@2');
    const writes: string[] = [];
    const applier = new MetadataEventApplier({
      records: new Map([
        [keyId(first.key), first],
        [keyId(second.key), second],
      ]),
      rememberUnknownPane: () => undefined,
      setRecordField: (record) => {
        writes.push(record.key.nativeId);
      },
      removeRecord: () => {
        throw new Error('should not remove');
      },
    });
    const actions = applier.collect(
      { type: 'session-window-changed', sessionId: '$1', windowId: '@2' },
      2n
    );
    expect(actions).toHaveLength(2);
    for (const action of actions) action();
    expect(writes.sort()).toEqual(['@1', '@2']);
  });

  test('handler table accepts every source event type', () => {
    const applier = new MetadataEventApplier({
      records: new Map(),
      rememberUnknownPane: () => undefined,
      setRecordField: () => undefined,
      removeRecord: () => undefined,
    });
    const events: TmuxSourceMetadataEvent[] = [
      { type: 'pane-title', paneId: '%1', title: 'a' },
      { type: 'pane-current-path', paneId: '%1', currentPath: '/' },
      { type: 'pane-current-command', paneId: '%1', currentCommand: 'zsh' },
      { type: 'session-renamed', sessionId: '$1', name: 'work' },
      { type: 'window-renamed', windowId: '@1', name: 'main' },
      { type: 'session-window-changed', sessionId: '$1', windowId: '@1' },
      { type: 'window-pane-changed', windowId: '@1', paneId: '%1' },
      { type: 'layout-change', windowId: '@1', layout: 'aaaa,80x24,0,0,1' },
      { type: 'window-close', windowId: '@1' },
    ];
    for (const event of events) {
      expect(applier.collect(event, 2n)).toEqual([]);
    }
  });
});

describe('formatWindowCloseObserved', () => {
  test('records the last known window name and active pane command', () => {
    const records = new Map<string, ProjectedRecord>();
    const window = windowRecord('@1');
    const pane = createRecord(
      {
        key: {
          deviceId: 'device-a',
          serverEpoch: SERVER_EPOCH,
          entityKind: wsBorsh.SOURCE_ENTITY_PANE,
          nativeId: '%1',
        },
        parent: {
          deviceId: 'device-a',
          serverEpoch: SERVER_EPOCH,
          entityKind: wsBorsh.SOURCE_ENTITY_WINDOW,
          nativeId: '@1',
        },
        fields: new Map<number, MetadataValue>([
          [wsBorsh.SOURCE_FIELD_CURRENT_COMMAND, stringValue('claude')],
          [wsBorsh.SOURCE_FIELD_ACTIVE, { Bool: true }],
        ]),
      },
      1n
    );
    records.set(keyId(window.key), window);
    records.set(keyId(pane.key), pane);

    expect(formatWindowCloseObserved('@1', window, records)).toBe(
      '[tmux] window-close observed id=@1 name=@1 pane_current_command=claude exit_status=unavailable tracked=yes'
    );
  });

  test('renders a supplied exit status when one is available', () => {
    expect(formatWindowCloseObserved('@9', undefined, new Map(), '137')).toContain(
      'exit_status=137'
    );
  });

  test('falls back to unknown for a window the projection never saw', () => {
    expect(formatWindowCloseObserved('@9', undefined, new Map())).toBe(
      '[tmux] window-close observed id=@9 name=unknown pane_current_command=unknown exit_status=unavailable tracked=no'
    );
  });
});
