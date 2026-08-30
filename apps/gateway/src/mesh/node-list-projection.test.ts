import { describe, expect, test } from 'bun:test';
import {
  parseJson,
  pickMeshNodeName,
  projectNode,
  upsertById,
  versionFromInventory,
} from './node-list-projection';

describe('node-list-projection', () => {
  test('projectNode prefers live inventory, capability, and version', () => {
    expect(
      projectNode(
        'n1',
        'box',
        true,
        {
          endpoints: ['old'],
          inventory: { version: '1' },
          directCapable: false,
          version: '1',
        },
        {
          endpoints: ['new'],
          inventory: { version: '2' },
          directCapable: true,
          version: '2',
        }
      )
    ).toEqual({
      id: 'n1',
      name: 'box',
      online: true,
      endpoints: ['new'],
      inventory: { version: '2' },
      direct_capable: true,
      version: '2',
    });
  });

  test('upsertById overwrites an existing hub row in place', () => {
    const nodes = [{ id: 'hub', name: 'old', online: false }];
    upsertById(nodes, { id: 'hub', name: 'site', online: true });
    upsertById(nodes, { id: 'peer', name: 'p', online: true });
    expect(nodes).toEqual([
      { id: 'hub', name: 'site', online: true },
      { id: 'peer', name: 'p', online: true },
    ]);
  });

  test('parseJson and versionFromInventory fall back cleanly', () => {
    expect(parseJson('{"a":1}', null)).toEqual({ a: 1 });
    expect(parseJson('nope', { x: 1 })).toEqual({ x: 1 });
    expect(parseJson(null, [])).toEqual([]);
    expect(versionFromInventory({ version: '9' })).toBe('9');
    expect(versionFromInventory({})).toBeNull();
  });

  test('pickMeshNodeName prefers listed then registry then self fallback', () => {
    expect(
      pickMeshNodeName({
        id: 'aa',
        isSelf: true,
        listedName: 'self',
        registryName: 'aa',
        selfName: 'home',
      })
    ).toBe('home');
    expect(pickMeshNodeName({ id: 'bb', isSelf: false, listedName: 'studio' })).toBe('studio');
  });
});
