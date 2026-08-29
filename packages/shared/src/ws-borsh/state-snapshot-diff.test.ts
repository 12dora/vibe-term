import { describe, expect, test } from 'bun:test';

import type { StateSnapshotPayload, TmuxPane, TmuxWindow } from '../index';
import {
  SOURCE_ENTITY_PANE,
  SOURCE_ENTITY_SESSION,
  SOURCE_ENTITY_WINDOW,
  SOURCE_FIELD_ACTIVE,
  SOURCE_FIELD_CURRENT_COMMAND,
  SOURCE_FIELD_CURRENT_PATH,
  SOURCE_FIELD_CUSTOM_NAME,
  SOURCE_FIELD_HEIGHT,
  SOURCE_FIELD_INDEX,
  SOURCE_FIELD_LAYOUT,
  SOURCE_FIELD_LEFT,
  SOURCE_FIELD_NAME,
  SOURCE_FIELD_TITLE,
  SOURCE_FIELD_TOP,
  SOURCE_FIELD_WIDTH,
} from './canonical-state';
import {
  type LegacyMetadataEntityDiff,
  type LegacyMetadataFieldValue,
  applyLegacyStateSnapshotDiff,
  decodeLegacyStateSnapshotDiff,
  encodeLegacyStateSnapshotDiff,
  sourceMetadataPatchToLegacyDiff,
} from './state-snapshot-diff';

const SERVER_EPOCH = new Uint8Array(16).fill(1);
const METADATA_EPOCH = new Uint8Array(16).fill(2);

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
          panes: [
            {
              id: '%1',
              windowId: '@1',
              index: 0,
              active: true,
              width: 80,
              height: 24,
              title: 'old',
            },
          ],
        },
      ],
    },
  };
}

describe('absolute legacy state snapshot diff', () => {
  test('maps canonical absolute fields without carrying epoch-only data', () => {
    const diff = sourceMetadataPatchToLegacyDiff({
      metadataEpoch: METADATA_EPOCH,
      fromRevision: 1n,
      throughRevision: 2n,
      upserts: [
        {
          key: {
            deviceId: 'device-a',
            serverEpoch: SERVER_EPOCH,
            entityKind: SOURCE_ENTITY_PANE,
            nativeId: '%1',
          },
          parent: {
            deviceId: 'device-a',
            serverEpoch: SERVER_EPOCH,
            entityKind: 3,
            nativeId: '@1',
          },
          fields: [
            { field: SOURCE_FIELD_TITLE, value: { String: 'new' } },
            { field: SOURCE_FIELD_CURRENT_PATH, value: { String: '/work' } },
          ],
        },
      ],
      removals: [],
    });
    const roundTrip = decodeLegacyStateSnapshotDiff(encodeLegacyStateSnapshotDiff(diff));
    const applied = applyLegacyStateSnapshotDiff(snapshot(), roundTrip);
    expect(applied.session?.windows[0]?.panes[0]?.title).toBe('new');
    expect(applied.session?.windows[0]?.panes[0]?.currentPath).toBe('/work');
  });

  test('moves and removes panes by stable native id', () => {
    const current = snapshot();
    current.session?.windows.push({
      id: '@2',
      name: 'other',
      index: 1,
      active: false,
      panes: [],
    });
    const moved = applyLegacyStateSnapshotDiff(current, {
      upserts: [
        {
          entityKind: SOURCE_ENTITY_PANE,
          nativeId: '%1',
          parentKind: 3,
          parentId: '@2',
          fields: [],
        },
      ],
      removals: [],
    });
    expect(moved.session?.windows[0]?.panes).toEqual([]);
    expect(moved.session?.windows[1]?.panes[0]?.windowId).toBe('@2');
    const removed = applyLegacyStateSnapshotDiff(moved, {
      upserts: [],
      removals: [{ entityKind: SOURCE_ENTITY_PANE, nativeId: '%1' }],
    });
    expect(removed.session?.windows[1]?.panes).toEqual([]);
  });
});

function paneOf(
  payload: StateSnapshotPayload,
  windowId = '@1',
  paneId = '%1'
): TmuxPane | undefined {
  const window = payload.session?.windows.find((candidate) => candidate.id === windowId);
  return window?.panes.find((candidate) => candidate.id === paneId);
}

function windowOf(payload: StateSnapshotPayload, windowId = '@1'): TmuxWindow | undefined {
  return payload.session?.windows.find((candidate) => candidate.id === windowId);
}

function applyFields(
  entity: Pick<LegacyMetadataEntityDiff, 'entityKind' | 'nativeId' | 'parentId'>,
  fields: Array<[number, LegacyMetadataFieldValue]>,
  base: StateSnapshotPayload = snapshot()
): StateSnapshotPayload {
  return applyLegacyStateSnapshotDiff(base, {
    upserts: [
      {
        entityKind: entity.entityKind,
        nativeId: entity.nativeId,
        parentKind: entity.entityKind === SOURCE_ENTITY_PANE ? SOURCE_ENTITY_WINDOW : null,
        parentId: entity.parentId,
        fields,
      },
    ],
    removals: [],
  });
}

const PANE_TARGET = {
  entityKind: SOURCE_ENTITY_PANE,
  nativeId: '%1',
  parentId: '@1',
};

const WINDOW_TARGET = {
  entityKind: SOURCE_ENTITY_WINDOW,
  nativeId: '@1',
  parentId: '$1',
};

describe('legacy snapshot field matrix', () => {
  const paneRequired: Array<{
    field: number;
    valid: LegacyMetadataFieldValue;
    invalid: LegacyMetadataFieldValue;
    read: (pane: TmuxPane) => unknown;
    unchanged: unknown;
  }> = [
    { field: SOURCE_FIELD_INDEX, valid: 7, invalid: '7', read: (pane) => pane.index, unchanged: 0 },
    {
      field: SOURCE_FIELD_ACTIVE,
      valid: false,
      invalid: 0,
      read: (pane) => pane.active,
      unchanged: true,
    },
    {
      field: SOURCE_FIELD_WIDTH,
      valid: 120,
      invalid: true,
      read: (pane) => pane.width,
      unchanged: 80,
    },
    {
      field: SOURCE_FIELD_HEIGHT,
      valid: 40,
      invalid: '24',
      read: (pane) => pane.height,
      unchanged: 24,
    },
  ];

  const paneOptional: Array<{
    field: number;
    valid: LegacyMetadataFieldValue;
    invalid: LegacyMetadataFieldValue;
    seed: (pane: TmuxPane) => void;
    read: (pane: TmuxPane) => unknown;
    seeded: unknown;
  }> = [
    {
      field: SOURCE_FIELD_LEFT,
      valid: 3,
      invalid: '3',
      seed: (pane) => {
        pane.left = 1;
      },
      read: (pane) => pane.left,
      seeded: 1,
    },
    {
      field: SOURCE_FIELD_TOP,
      valid: 4,
      invalid: false,
      seed: (pane) => {
        pane.top = 2;
      },
      read: (pane) => pane.top,
      seeded: 2,
    },
    {
      field: SOURCE_FIELD_TITLE,
      valid: 'next',
      invalid: 1,
      seed: (pane) => {
        pane.title = 'old';
      },
      read: (pane) => pane.title,
      seeded: 'old',
    },
    {
      field: SOURCE_FIELD_CURRENT_PATH,
      valid: '/tmp',
      invalid: 10,
      seed: (pane) => {
        pane.currentPath = '/seed';
      },
      read: (pane) => pane.currentPath,
      seeded: '/seed',
    },
    {
      field: SOURCE_FIELD_CURRENT_COMMAND,
      valid: 'zsh',
      invalid: true,
      seed: (pane) => {
        pane.currentCommand = 'bash';
      },
      read: (pane) => pane.currentCommand,
      seeded: 'bash',
    },
    {
      field: SOURCE_FIELD_CUSTOM_NAME,
      valid: 'alias',
      invalid: 14,
      seed: (pane) => {
        pane.customName = 'seeded';
      },
      read: (pane) => pane.customName,
      seeded: 'seeded',
    },
  ];

  const windowRequired: Array<{
    field: number;
    valid: LegacyMetadataFieldValue;
    invalid: LegacyMetadataFieldValue;
    read: (window: TmuxWindow) => unknown;
    unchanged: unknown;
  }> = [
    {
      field: SOURCE_FIELD_NAME,
      valid: 'renamed',
      invalid: 1,
      read: (window) => window.name,
      unchanged: 'main',
    },
    {
      field: SOURCE_FIELD_INDEX,
      valid: 9,
      invalid: false,
      read: (window) => window.index,
      unchanged: 0,
    },
    {
      field: SOURCE_FIELD_ACTIVE,
      valid: false,
      invalid: 'yes',
      read: (window) => window.active,
      unchanged: true,
    },
  ];

  const windowOptional: Array<{
    field: number;
    valid: LegacyMetadataFieldValue;
    invalid: LegacyMetadataFieldValue;
    seed: (window: TmuxWindow) => void;
    read: (window: TmuxWindow) => unknown;
    seeded: unknown;
  }> = [
    {
      field: SOURCE_FIELD_LAYOUT,
      valid: 'even-horizontal',
      invalid: 5,
      seed: (window) => {
        window.layout = 'tiled';
      },
      read: (window) => window.layout,
      seeded: 'tiled',
    },
    {
      field: SOURCE_FIELD_CUSTOM_NAME,
      valid: 'win-alias',
      invalid: true,
      seed: (window) => {
        window.customName = 'seeded';
      },
      read: (window) => window.customName,
      seeded: 'seeded',
    },
  ];

  for (const row of paneRequired) {
    test(`pane field ${row.field}: valid / wrong type / null`, () => {
      const validPane = paneOf(applyFields(PANE_TARGET, [[row.field, row.valid]]));
      const invalidPane = paneOf(applyFields(PANE_TARGET, [[row.field, row.invalid]]));
      const nullPane = paneOf(applyFields(PANE_TARGET, [[row.field, null]]));
      expect(validPane && row.read(validPane)).toBe(row.valid);
      expect(invalidPane && row.read(invalidPane)).toBe(row.unchanged);
      expect(nullPane && row.read(nullPane)).toBe(row.unchanged);
    });
  }

  for (const row of paneOptional) {
    test(`pane field ${row.field}: valid / wrong type / null`, () => {
      const seeded = snapshot();
      const seededPane = paneOf(seeded);
      if (!seededPane) throw new Error('missing pane');
      row.seed(seededPane);

      const validPane = paneOf(applyFields(PANE_TARGET, [[row.field, row.valid]], seeded));
      const invalidPane = paneOf(applyFields(PANE_TARGET, [[row.field, row.invalid]], seeded));
      const nullPane = paneOf(applyFields(PANE_TARGET, [[row.field, null]], seeded));
      expect(validPane && row.read(validPane)).toBe(row.valid);
      expect(invalidPane && row.read(invalidPane)).toBe(row.seeded);
      expect(nullPane && row.read(nullPane)).toBeUndefined();
    });
  }

  for (const row of windowRequired) {
    test(`window field ${row.field}: valid / wrong type / null`, () => {
      const validWindow = windowOf(applyFields(WINDOW_TARGET, [[row.field, row.valid]]));
      const invalidWindow = windowOf(applyFields(WINDOW_TARGET, [[row.field, row.invalid]]));
      const nullWindow = windowOf(applyFields(WINDOW_TARGET, [[row.field, null]]));
      expect(validWindow && row.read(validWindow)).toBe(row.valid);
      expect(invalidWindow && row.read(invalidWindow)).toBe(row.unchanged);
      expect(nullWindow && row.read(nullWindow)).toBe(row.unchanged);
    });
  }

  for (const row of windowOptional) {
    test(`window field ${row.field}: valid / wrong type / null`, () => {
      const seeded = snapshot();
      const seededWindow = windowOf(seeded);
      if (!seededWindow) throw new Error('missing window');
      row.seed(seededWindow);

      const validWindow = windowOf(applyFields(WINDOW_TARGET, [[row.field, row.valid]], seeded));
      const invalidWindow = windowOf(
        applyFields(WINDOW_TARGET, [[row.field, row.invalid]], seeded)
      );
      const nullWindow = windowOf(applyFields(WINDOW_TARGET, [[row.field, null]], seeded));
      expect(validWindow && row.read(validWindow)).toBe(row.valid);
      expect(invalidWindow && row.read(invalidWindow)).toBe(row.seeded);
      expect(nullWindow && row.read(nullWindow)).toBeUndefined();
    });
  }

  test('last valid field value wins and unknown ids are ignored', () => {
    const applied = applyFields(PANE_TARGET, [
      [SOURCE_FIELD_TITLE, 'first'],
      [999, 'ignored'],
      [SOURCE_FIELD_TITLE, 0],
      [SOURCE_FIELD_INDEX, 1],
      [SOURCE_FIELD_TITLE, 'second'],
      [SOURCE_FIELD_INDEX, 'skip'],
    ]);
    const pane = paneOf(applied);
    expect(pane?.title).toBe('second');
    expect(pane?.index).toBe(1);
  });
});

describe('legacy snapshot editor order and replacement', () => {
  test('does not mutate the input snapshot', () => {
    const current = snapshot();
    applyLegacyStateSnapshotDiff(current, {
      upserts: [
        {
          entityKind: SOURCE_ENTITY_PANE,
          nativeId: '%1',
          parentKind: SOURCE_ENTITY_WINDOW,
          parentId: '@1',
          fields: [[SOURCE_FIELD_TITLE, 'mutated']],
        },
      ],
      removals: [],
    });
    expect(paneOf(current)?.title).toBe('old');
  });

  test('same-window pane upsert keeps object identity and sibling order', () => {
    const current = snapshot();
    current.session?.windows[0]?.panes.push({
      id: '%2',
      windowId: '@1',
      index: 1,
      active: false,
      width: 40,
      height: 24,
    });
    const applied = applyLegacyStateSnapshotDiff(current, {
      upserts: [
        {
          entityKind: SOURCE_ENTITY_PANE,
          nativeId: '%1',
          parentKind: SOURCE_ENTITY_WINDOW,
          parentId: '@1',
          fields: [[SOURCE_FIELD_WIDTH, 90]],
        },
      ],
      removals: [],
    });
    expect(applied.session?.windows[0]?.panes.map((pane) => pane.id)).toEqual(['%1', '%2']);
    expect(paneOf(applied)?.width).toBe(90);
    expect(paneOf(applied)?.title).toBe('old');
  });

  test('pane move appends to destination and preserves remaining fields', () => {
    const current = snapshot();
    current.session?.windows.push({
      id: '@2',
      name: 'other',
      index: 1,
      active: false,
      panes: [
        {
          id: '%9',
          windowId: '@2',
          index: 0,
          active: true,
          width: 10,
          height: 10,
        },
      ],
    });
    const applied = applyLegacyStateSnapshotDiff(current, {
      upserts: [
        {
          entityKind: SOURCE_ENTITY_PANE,
          nativeId: '%1',
          parentKind: SOURCE_ENTITY_WINDOW,
          parentId: '@2',
          fields: [[SOURCE_FIELD_INDEX, 2]],
        },
      ],
      removals: [],
    });
    expect(windowOf(applied, '@1')?.panes.map((pane) => pane.id)).toEqual([]);
    expect(windowOf(applied, '@2')?.panes.map((pane) => pane.id)).toEqual(['%9', '%1']);
    expect(paneOf(applied, '@2')?.windowId).toBe('@2');
    expect(paneOf(applied, '@2')?.title).toBe('old');
    expect(paneOf(applied, '@2')?.index).toBe(2);
  });

  test('new panes append in upsert order', () => {
    const applied = applyLegacyStateSnapshotDiff(snapshot(), {
      upserts: [
        {
          entityKind: SOURCE_ENTITY_PANE,
          nativeId: '%2',
          parentKind: SOURCE_ENTITY_WINDOW,
          parentId: '@1',
          fields: [[SOURCE_FIELD_INDEX, 1]],
        },
        {
          entityKind: SOURCE_ENTITY_PANE,
          nativeId: '%3',
          parentKind: SOURCE_ENTITY_WINDOW,
          parentId: '@1',
          fields: [[SOURCE_FIELD_INDEX, 2]],
        },
      ],
      removals: [],
    });
    expect(applied.session?.windows[0]?.panes.map((pane) => pane.id)).toEqual(['%1', '%2', '%3']);
    expect(paneOf(applied, '@1', '%2')).toMatchObject({
      windowId: '@1',
      index: 1,
      active: false,
      width: 1,
      height: 1,
    });
  });

  test('session replacement drops windows; same-id upsert keeps them', () => {
    const replaced = applyLegacyStateSnapshotDiff(snapshot(), {
      upserts: [
        {
          entityKind: SOURCE_ENTITY_SESSION,
          nativeId: '$2',
          parentKind: null,
          parentId: null,
          fields: [[SOURCE_FIELD_NAME, 'other']],
        },
      ],
      removals: [],
    });
    expect(replaced.session).toEqual({ id: '$2', name: 'other', windows: [] });

    const renamed = applyLegacyStateSnapshotDiff(snapshot(), {
      upserts: [
        {
          entityKind: SOURCE_ENTITY_SESSION,
          nativeId: '$1',
          parentKind: null,
          parentId: null,
          fields: [[SOURCE_FIELD_NAME, 'renamed']],
        },
      ],
      removals: [],
    });
    expect(renamed.session?.name).toBe('renamed');
    expect(renamed.session?.windows).toHaveLength(1);
  });

  test('window upsert creates then later replaces fields on the same id', () => {
    const created = applyLegacyStateSnapshotDiff(snapshot(), {
      upserts: [
        {
          entityKind: SOURCE_ENTITY_WINDOW,
          nativeId: '@2',
          parentKind: SOURCE_ENTITY_SESSION,
          parentId: '$1',
          fields: [
            [SOURCE_FIELD_NAME, 'second'],
            [SOURCE_FIELD_INDEX, 1],
          ],
        },
      ],
      removals: [],
    });
    expect(created.session?.windows.map((window) => window.id)).toEqual(['@1', '@2']);
    expect(windowOf(created, '@2')).toMatchObject({
      name: 'second',
      index: 1,
      active: false,
      panes: [],
    });

    const updated = applyLegacyStateSnapshotDiff(created, {
      upserts: [
        {
          entityKind: SOURCE_ENTITY_WINDOW,
          nativeId: '@2',
          parentKind: SOURCE_ENTITY_SESSION,
          parentId: '$1',
          fields: [[SOURCE_FIELD_ACTIVE, true]],
        },
      ],
      removals: [],
    });
    expect(windowOf(updated, '@2')?.active).toBe(true);
    expect(windowOf(updated, '@2')?.name).toBe('second');
  });

  test('removals run before upserts so a removed pane can be recreated', () => {
    const applied = applyLegacyStateSnapshotDiff(snapshot(), {
      upserts: [
        {
          entityKind: SOURCE_ENTITY_PANE,
          nativeId: '%1',
          parentKind: SOURCE_ENTITY_WINDOW,
          parentId: '@1',
          fields: [[SOURCE_FIELD_TITLE, 'fresh']],
        },
      ],
      removals: [{ entityKind: SOURCE_ENTITY_PANE, nativeId: '%1' }],
    });
    const pane = paneOf(applied);
    expect(applied.session?.windows[0]?.panes.map((candidate) => candidate.id)).toEqual(['%1']);
    expect(pane).toMatchObject({
      title: 'fresh',
      index: 0,
      active: false,
      width: 1,
      height: 1,
    });
  });

  test('skips window and pane upserts without a session, and pane upserts without a destination', () => {
    const noSession = applyLegacyStateSnapshotDiff(
      { deviceId: 'device-a', session: null },
      {
        upserts: [
          {
            entityKind: SOURCE_ENTITY_WINDOW,
            nativeId: '@1',
            parentKind: SOURCE_ENTITY_SESSION,
            parentId: '$1',
            fields: [[SOURCE_FIELD_NAME, 'ghost']],
          },
          {
            entityKind: SOURCE_ENTITY_PANE,
            nativeId: '%1',
            parentKind: SOURCE_ENTITY_WINDOW,
            parentId: '@1',
            fields: [[SOURCE_FIELD_TITLE, 'ghost']],
          },
        ],
        removals: [],
      }
    );
    expect(noSession.session).toBeNull();

    const missingParent = applyLegacyStateSnapshotDiff(snapshot(), {
      upserts: [
        {
          entityKind: SOURCE_ENTITY_PANE,
          nativeId: '%8',
          parentKind: SOURCE_ENTITY_WINDOW,
          parentId: null,
          fields: [[SOURCE_FIELD_TITLE, 'no-parent']],
        },
        {
          entityKind: SOURCE_ENTITY_PANE,
          nativeId: '%9',
          parentKind: SOURCE_ENTITY_WINDOW,
          parentId: '@missing',
          fields: [[SOURCE_FIELD_TITLE, 'missing']],
        },
      ],
      removals: [],
    });
    expect(missingParent.session?.windows[0]?.panes.map((pane) => pane.id)).toEqual(['%1']);
  });
});
