import { describe, expect, test } from 'bun:test';
import { isStandaloneRoles, isTmexRoleName, roleNameFromFlags, rolesFromName } from './roles';

describe('isTmexRoleName', () => {
  test('accepts the three legal tokens', () => {
    expect(isTmexRoleName('standalone')).toBe(true);
    expect(isTmexRoleName('node')).toBe(true);
    expect(isTmexRoleName('hub,node')).toBe(true);
  });

  test('rejects empty, whitespace, case variants, and reordered tokens', () => {
    for (const raw of ['', '   ', 'hub', 'node,hub', 'HUB,NODE', 'standalone,node']) {
      expect(isTmexRoleName(raw)).toBe(false);
    }
  });
});

describe('rolesFromName / roleNameFromFlags', () => {
  test('maps each legal name to flags and back', () => {
    expect(rolesFromName('standalone')).toEqual({ hub: false, node: false });
    expect(rolesFromName('node')).toEqual({ hub: false, node: true });
    expect(rolesFromName('hub,node')).toEqual({ hub: true, node: true });

    expect(roleNameFromFlags({ hub: false, node: false })).toBe('standalone');
    expect(roleNameFromFlags({ hub: false, node: true })).toBe('node');
    expect(roleNameFromFlags({ hub: true, node: true })).toBe('hub,node');
  });

  test('hub-only flags are not a legal role and collapse to standalone', () => {
    expect(roleNameFromFlags({ hub: true, node: false })).toBe('standalone');
  });
});

describe('isStandaloneRoles', () => {
  test('true only when both hub and node are off', () => {
    expect(isStandaloneRoles({ hub: false, node: false })).toBe(true);
    expect(isStandaloneRoles({ hub: false, node: true })).toBe(false);
    expect(isStandaloneRoles({ hub: true, node: true })).toBe(false);
    expect(isStandaloneRoles({ hub: true, node: false })).toBe(false);
  });
});
