import { describe, expect, test } from 'bun:test';
import { ApiClient } from '@tmex/api-client';
import type { Device } from '@tmex/shared';

import {
  type FileRootDeviceGroup,
  canSubmitFileRootForm,
  collectFileRootClients,
  deriveFileRootDeviceOptions,
  isFileRootPathValid,
  resolveFileRootClient,
} from './file-root-form-model';

const local = new ApiClient('http://local');
const hubA = new ApiClient('http://hub-a');
const hubB = new ApiClient('http://hub-b');

const groups: FileRootDeviceGroup[] = [
  { label: 'A', devices: [{ id: 'a1', name: 'A1' }], apiClient: hubA },
  { label: 'B', devices: [{ id: 'b1', name: 'B1', type: 'ssh' }], apiClient: hubB },
  { label: 'local', devices: [{ id: 'l1', name: 'L1', type: 'local' }] },
];

describe('collectFileRootClients', () => {
  test('without groups only reads the fallback client', () => {
    expect(collectFileRootClients(local)).toEqual([local]);
  });

  test('maps each group to its client and falls back when unset', () => {
    expect(collectFileRootClients(local, groups)).toEqual([hubA, hubB, local]);
  });

  test('deduplicates repeated clients while preserving first-seen order', () => {
    const duplicated: FileRootDeviceGroup[] = [
      { label: 'A', devices: [], apiClient: hubA },
      { label: 'A2', devices: [], apiClient: hubA },
      { label: 'fallback-1', devices: [] },
      { label: 'B', devices: [], apiClient: hubB },
      { label: 'fallback-2', devices: [] },
    ];
    expect(collectFileRootClients(local, duplicated)).toEqual([hubA, local, hubB]);
  });

  test('empty groups yields no clients', () => {
    expect(collectFileRootClients(local, [])).toEqual([]);
  });
});

describe('resolveFileRootClient', () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof resolveFileRootClient>[0];
    expected: ApiClient;
  }> = [
    {
      name: 'edit uses the source client of the root',
      input: {
        isEdit: true,
        deviceId: 'a1',
        editClient: hubB,
        fallbackClient: local,
        deviceGroups: groups,
      },
      expected: hubB,
    },
    {
      name: 'edit without a source client falls back',
      input: { isEdit: true, deviceId: 'a1', fallbackClient: local, deviceGroups: groups },
      expected: local,
    },
    {
      name: 'create ignores editClient and routes by device group',
      input: {
        isEdit: false,
        deviceId: 'b1',
        editClient: hubA,
        fallbackClient: local,
        deviceGroups: groups,
      },
      expected: hubB,
    },
    {
      name: 'create for a group without a client falls back',
      input: { isEdit: false, deviceId: 'l1', fallbackClient: local, deviceGroups: groups },
      expected: local,
    },
    {
      name: 'create for an unknown device falls back',
      input: { isEdit: false, deviceId: 'zz', fallbackClient: local, deviceGroups: groups },
      expected: local,
    },
    {
      name: 'create without groups always uses the fallback',
      input: { isEdit: false, deviceId: 'a1', fallbackClient: local },
      expected: local,
    },
  ];

  for (const { name, input, expected } of cases) {
    test(name, () => {
      expect(resolveFileRootClient(input)).toBe(expected);
    });
  }
});

describe('deriveFileRootDeviceOptions', () => {
  const makeDevice = (id: string, type: Device['type']): Device => ({
    id,
    name: id.toUpperCase(),
    type,
    authMode: 'auto',
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  const devices: Device[] = [makeDevice('d1', 'local'), makeDevice('d2', 'ssh')];

  test('without groups uses the queried devices', () => {
    expect(deriveFileRootDeviceOptions(devices)).toEqual(devices);
  });

  test('with groups flattens group devices and ignores queried devices', () => {
    expect(deriveFileRootDeviceOptions(devices, groups)).toEqual([
      { id: 'a1', name: 'A1' },
      { id: 'b1', name: 'B1', type: 'ssh' },
      { id: 'l1', name: 'L1', type: 'local' },
    ]);
  });

  test('empty groups yields no options', () => {
    expect(deriveFileRootDeviceOptions(devices, [])).toEqual([]);
  });
});

describe('isFileRootPathValid', () => {
  const cases: Array<[string, boolean]> = [
    ['/srv/data', true],
    ['  /srv/data  ', true],
    ['/', true],
    ['srv/data', false],
    ['~/data', false],
    ['', false],
    ['   ', false],
  ];

  for (const [path, expected] of cases) {
    test(`${JSON.stringify(path)} -> ${expected}`, () => {
      expect(isFileRootPathValid(path)).toBe(expected);
    });
  }
});

describe('canSubmitFileRootForm', () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof canSubmitFileRootForm>[0];
    expected: boolean;
  }> = [
    {
      name: 'create needs both a device and an absolute path',
      input: { isEdit: false, deviceId: 'a1', path: '/srv' },
      expected: true,
    },
    {
      name: 'create without a device is blocked',
      input: { isEdit: false, deviceId: '', path: '/srv' },
      expected: false,
    },
    {
      name: 'create with a relative path is blocked',
      input: { isEdit: false, deviceId: 'a1', path: 'srv' },
      expected: false,
    },
    {
      name: 'edit only needs an absolute path',
      input: { isEdit: true, deviceId: '', path: '/srv' },
      expected: true,
    },
    {
      name: 'edit with a relative path is blocked',
      input: { isEdit: true, deviceId: '', path: 'srv' },
      expected: false,
    },
  ];

  for (const { name, input, expected } of cases) {
    test(name, () => {
      expect(canSubmitFileRootForm(input)).toBe(expected);
    });
  }
});
