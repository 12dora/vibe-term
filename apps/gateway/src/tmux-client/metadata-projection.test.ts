import { describe, expect, test } from 'bun:test';
import { type StateSnapshotPayload, wsBorsh } from '@tmex/shared';

import {
  MetadataProjection,
  type MetadataProjectionPatch,
  type MetadataProjectionSnapshot,
} from './metadata-projection';

const SERVER_EPOCH = Uint8Array.from({ length: 16 }, (_, index) => index);

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

function findRecord(
  value: MetadataProjectionSnapshot,
  kind: number,
  nativeId: string
): wsBorsh.SourceMetadataRecord {
  const record = value.records.find(
    (candidate) => candidate.key.entityKind === kind && candidate.key.nativeId === nativeId
  );
  if (!record) throw new Error(`record missing: ${kind}/${nativeId}`);
  return record;
}

function stringField(record: wsBorsh.SourceMetadataRecord, field: number): string | null {
  const value = record.fields.find((candidate) => candidate.field === field)?.value;
  return value && 'String' in value ? value.String : null;
}

function boolField(record: wsBorsh.SourceMetadataRecord, field: number): boolean | null {
  const value = record.fields.find((candidate) => candidate.field === field)?.value;
  return value && 'Bool' in value ? value.Bool : null;
}

function u16Field(record: wsBorsh.SourceMetadataRecord, field: number): number | null {
  const value = record.fields.find((candidate) => candidate.field === field)?.value;
  return value && 'U16' in value ? value.U16 : null;
}

function twoWindowSnapshot(): StateSnapshotPayload {
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
              title: 'shell',
              active: true,
              width: 80,
              height: 24,
              left: 0,
              top: 0,
            },
          ],
        },
        {
          id: '@2',
          name: 'logs',
          index: 1,
          active: false,
          layout: 'aaaa,80x24,0,0,2',
          panes: [
            {
              id: '%2',
              windowId: '@2',
              index: 0,
              title: 'tail',
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

function createProjection() {
  const patches: MetadataProjectionPatch[] = [];
  const rebases: MetadataProjectionSnapshot[] = [];
  let epoch = 10;
  const projection = new MetadataProjection('device-a', {
    deviceName: 'Developer Mac',
    createEpoch: () => new Uint8Array(16).fill(epoch++),
    onPatch: (patch) => patches.push(patch),
    onRebaseRequired: (value) => rebases.push(value),
  });
  projection.setServerEpoch(SERVER_EPOCH);
  return { projection, patches, rebases };
}

describe('runtime metadata projection', () => {
  test('establishes a full hierarchy once and identical reconciliation is a no-op', () => {
    const { projection, patches } = createProjection();
    projection.reconcile(snapshot());

    const current = projection.currentSnapshot();
    expect(current.revision).toBe(1n);
    expect(current.records.map((record) => record.key.entityKind)).toEqual([0, 1, 2, 3, 4]);
    expect(
      stringField(
        findRecord(current, wsBorsh.SOURCE_ENTITY_DEVICE, 'device-a'),
        wsBorsh.SOURCE_FIELD_NAME
      )
    ).toBe('Developer Mac');
    expect(
      stringField(findRecord(current, wsBorsh.SOURCE_ENTITY_PANE, '%1'), wsBorsh.SOURCE_FIELD_TITLE)
    ).toBe('shell');

    projection.reconcile(snapshot(), projection.revision);
    projection.flushPending();
    expect(projection.revision).toBe(1n);
    expect(patches).toEqual([]);
  });

  test('coalesces rapid titles into one latest-wins absolute patch', () => {
    const { projection, patches } = createProjection();
    projection.reconcile(snapshot());
    for (let index = 0; index < 100; index += 1) {
      projection.applySourceEvent({ type: 'pane-title', paneId: '%1', title: `title-${index}` });
    }
    projection.flushPending();

    expect(patches).toHaveLength(1);
    expect(patches[0]?.fromRevision).toBe(1n);
    expect(patches[0]?.throughRevision).toBe(101n);
    expect(patches[0]?.upserts).toHaveLength(1);
    const patch = patches[0];
    const upsert = patch?.upserts[0];
    if (!upsert) throw new Error('expected one metadata upsert');
    expect(stringField(upsert, wsBorsh.SOURCE_FIELD_TITLE)).toBe('title-99');
    expect(patches[0]?.removals).toEqual([]);
  });

  test('does not let a stale reconciliation overwrite newer output metadata', () => {
    const { projection, patches } = createProjection();
    projection.reconcile(snapshot('old'));
    const queryBase = projection.revision;
    projection.applySourceEvent({ type: 'pane-title', paneId: '%1', title: 'new' });
    projection.reconcile(snapshot('old'), queryBase);
    projection.flushPending();

    expect(projection.revision).toBe(2n);
    expect(patches).toHaveLength(1);
    expect(
      stringField(
        findRecord(projection.currentSnapshot(), wsBorsh.SOURCE_ENTITY_PANE, '%1'),
        wsBorsh.SOURCE_FIELD_TITLE
      )
    ).toBe('new');
  });

  test('buffers metadata for a pane observed before its structural snapshot', () => {
    const { projection } = createProjection();
    projection.applySourceEvent({ type: 'pane-title', paneId: '%1', title: 'early' });
    projection.reconcile(snapshot('stale'));

    expect(
      stringField(
        findRecord(projection.currentSnapshot(), wsBorsh.SOURCE_ENTITY_PANE, '%1'),
        wsBorsh.SOURCE_FIELD_TITLE
      )
    ).toBe('early');
  });

  test('removes a window subtree atomically and cancels tombstones when it reappears', () => {
    const { projection, patches } = createProjection();
    projection.reconcile(snapshot());
    projection.applySourceEvent({ type: 'window-close', windowId: '@1' });
    projection.reconcile(snapshot(), projection.revision);
    projection.flushPending();

    expect(patches).toHaveLength(1);
    expect(patches[0]?.removals).toEqual([]);
    expect(patches[0]?.upserts.map((record) => record.key.nativeId).sort()).toEqual(['%1', '@1']);
    expect(projection.currentSnapshot().records).toHaveLength(5);
  });

  test('emits Unset for removed optional fields and custom names stay projection-owned', () => {
    const { projection, patches } = createProjection();
    projection.reconcile(snapshot());
    projection.setCustomName('pane', '%1', 'mine');
    projection.setCustomName('pane', '%1', null);
    projection.flushPending();

    expect(patches).toHaveLength(1);
    const field = patches[0]?.upserts[0]?.fields.find(
      (candidate) => candidate.field === wsBorsh.SOURCE_FIELD_CUSTOM_NAME
    );
    expect(field?.value).toEqual({ Unset: {} });
  });

  test('layout-change updates window and pane geometry in one revision', () => {
    const { projection, patches } = createProjection();
    projection.reconcile(snapshot());
    projection.applySourceEvent({
      type: 'layout-change',
      windowId: '@1',
      layout: 'aaaa,92x27,0,0,1',
    });

    expect(projection.revision).toBe(2n);
    const current = projection.currentSnapshot();
    expect(
      stringField(
        findRecord(current, wsBorsh.SOURCE_ENTITY_WINDOW, '@1'),
        wsBorsh.SOURCE_FIELD_LAYOUT
      )
    ).toBe('aaaa,92x27,0,0,1');
    const pane = findRecord(current, wsBorsh.SOURCE_ENTITY_PANE, '%1');
    expect(u16Field(pane, wsBorsh.SOURCE_FIELD_WIDTH)).toBe(92);
    expect(u16Field(pane, wsBorsh.SOURCE_FIELD_HEIGHT)).toBe(27);
    expect(u16Field(pane, wsBorsh.SOURCE_FIELD_LEFT)).toBe(0);
    expect(u16Field(pane, wsBorsh.SOURCE_FIELD_TOP)).toBe(0);

    projection.flushPending();
    expect(patches).toHaveLength(1);
    expect(patches[0]?.fromRevision).toBe(1n);
    expect(patches[0]?.throughRevision).toBe(2n);
  });

  test('no-op source events do not bump revision', () => {
    const { projection, patches } = createProjection();
    projection.reconcile(snapshot());
    projection.applySourceEvent({ type: 'pane-title', paneId: '%1', title: 'shell' });
    projection.applySourceEvent({ type: 'window-renamed', windowId: '@missing', name: 'gone' });
    projection.applySourceEvent({ type: 'window-close', windowId: '@missing' });
    projection.flushPending();

    expect(projection.revision).toBe(1n);
    expect(patches).toEqual([]);
  });

  test('stale reconcile cannot resurrect a tombstoned window subtree', () => {
    const { projection, patches } = createProjection();
    projection.reconcile(snapshot());
    const queryBase = projection.revision;
    projection.applySourceEvent({ type: 'window-close', windowId: '@1' });
    expect(projection.revision).toBe(2n);
    expect(
      projection
        .currentSnapshot()
        .records.map((record) => record.key.nativeId)
        .sort()
    ).toEqual(['device-a', '$1', 'server'].sort());

    projection.reconcile(snapshot(), queryBase);
    projection.flushPending();

    expect(projection.revision).toBe(2n);
    expect(projection.hasPane('%1')).toBe(false);
    expect(projection.currentSnapshot().records).toHaveLength(3);
    expect(patches[0]?.fromRevision).toBe(1n);
    expect(patches[0]?.throughRevision).toBe(2n);
    expect(patches[0]?.removals.map((key) => key.nativeId).sort()).toEqual(['%1', '@1']);
  });

  test('session-window-changed flips sibling active flags in one revision', () => {
    const { projection, patches } = createProjection();
    projection.reconcile(twoWindowSnapshot());
    projection.applySourceEvent({
      type: 'session-window-changed',
      sessionId: '$1',
      windowId: '@2',
    });

    expect(projection.revision).toBe(2n);
    const current = projection.currentSnapshot();
    expect(
      boolField(
        findRecord(current, wsBorsh.SOURCE_ENTITY_WINDOW, '@1'),
        wsBorsh.SOURCE_FIELD_ACTIVE
      )
    ).toBe(false);
    expect(
      boolField(
        findRecord(current, wsBorsh.SOURCE_ENTITY_WINDOW, '@2'),
        wsBorsh.SOURCE_FIELD_ACTIVE
      )
    ).toBe(true);

    projection.flushPending();
    expect(patches).toHaveLength(1);
    expect(patches[0]?.fromRevision).toBe(1n);
    expect(patches[0]?.throughRevision).toBe(2n);
    expect(patches[0]?.upserts.map((record) => record.key.nativeId).sort()).toEqual(['@1', '@2']);
  });

  test('window-pane-changed flips sibling pane active flags in one revision', () => {
    const { projection } = createProjection();
    projection.reconcile({
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
            layout: 'aaaa,80x24,0,0{40x24,0,0,1,39x24,41,0,2}',
            panes: [
              {
                id: '%1',
                windowId: '@1',
                index: 0,
                title: 'left',
                active: true,
                width: 40,
                height: 24,
                left: 0,
                top: 0,
              },
              {
                id: '%2',
                windowId: '@1',
                index: 1,
                title: 'right',
                active: false,
                width: 39,
                height: 24,
                left: 41,
                top: 0,
              },
            ],
          },
        ],
      },
    });
    projection.applySourceEvent({
      type: 'window-pane-changed',
      windowId: '@1',
      paneId: '%2',
    });

    expect(projection.revision).toBe(2n);
    const current = projection.currentSnapshot();
    expect(
      boolField(findRecord(current, wsBorsh.SOURCE_ENTITY_PANE, '%1'), wsBorsh.SOURCE_FIELD_ACTIVE)
    ).toBe(false);
    expect(
      boolField(findRecord(current, wsBorsh.SOURCE_ENTITY_PANE, '%2'), wsBorsh.SOURCE_FIELD_ACTIVE)
    ).toBe(true);
  });

  test('first establish does not emit a patch and later no-op reconcile keeps revision', () => {
    const { projection, patches } = createProjection();
    projection.reconcile(snapshot());
    expect(projection.revision).toBe(1n);
    expect(patches).toEqual([]);
    projection.reconcile(snapshot(), 1n);
    projection.flushPending();
    expect(projection.revision).toBe(1n);
    expect(patches).toEqual([]);
  });

  test('dispose ignores later source events and does not emit rebase on a new epoch', () => {
    const { projection, patches, rebases } = createProjection();
    projection.reconcile(snapshot());
    projection.dispose();
    projection.applySourceEvent({ type: 'pane-title', paneId: '%1', title: 'late' });
    projection.applySourceEvent({ type: 'pane-title', paneId: '%missing', title: 'cached?' });
    projection.setServerEpoch(new Uint8Array(16).fill(9));
    projection.setCustomName('pane', '%1', 'nope');
    projection.flushPending();

    expect(projection.revision).toBe(1n);
    expect(patches).toEqual([]);
    expect(rebases).toEqual([]);
    expect(projection.currentSnapshot().records).toEqual([]);
  });
});
