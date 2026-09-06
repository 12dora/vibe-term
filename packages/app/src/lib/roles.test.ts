import { describe, expect, test } from 'bun:test';
import { parseVibeTermRoles as parseGatewayVibeTermRoles } from '../../../../apps/gateway/src/config';
import { parseVibeTermRoleName, parseVibeTermRoles } from './roles';

const STANDALONE = { hub: false, node: false, relay: false };
const NODE = { hub: false, node: true, relay: false };
const HUB_NODE = { hub: true, node: true, relay: false };

describe('app parseVibeTermRoles wrapper', () => {
  test('undefined / empty / whitespace normalize to standalone', () => {
    expect(parseVibeTermRoles(undefined)).toEqual(STANDALONE);
    expect(parseVibeTermRoles('')).toEqual(STANDALONE);
    expect(parseVibeTermRoles('   ')).toEqual(STANDALONE);
  });

  test('accepts the three legal values', () => {
    expect(parseVibeTermRoles('standalone')).toEqual(STANDALONE);
    expect(parseVibeTermRoles('node')).toEqual(NODE);
    expect(parseVibeTermRoles('hub,node')).toEqual(HUB_NODE);
    expect(parseVibeTermRoles('  node  ')).toEqual(NODE);
  });

  test('rejects invalid role names', () => {
    expect(() => parseVibeTermRoles('hub')).toThrow('role must be one of standalone | node | hub,node');
    expect(() => parseVibeTermRoles('node,hub')).toThrow('role must be one of');
  });
});

describe('app parseVibeTermRoleName wrapper', () => {
  test('undefined defaults to standalone; empty/whitespace still fail', () => {
    expect(parseVibeTermRoleName(undefined)).toBe('standalone');
    expect(() => parseVibeTermRoleName('')).toThrow('role must be one of');
    expect(() => parseVibeTermRoleName('   ')).toThrow('role must be one of');
  });
});

describe('gateway vs app VIBETERM_ROLES wrappers', () => {
  test('undefined is standalone in both', () => {
    expect(parseGatewayVibeTermRoles(undefined)).toEqual(STANDALONE);
    expect(parseVibeTermRoles(undefined)).toEqual(STANDALONE);
  });

  test('empty and whitespace: gateway rejects, app normalizes', () => {
    expect(() => parseGatewayVibeTermRoles('')).toThrow('VIBETERM_ROLES');
    expect(() => parseGatewayVibeTermRoles('   ')).toThrow('VIBETERM_ROLES');
    expect(parseVibeTermRoles('')).toEqual(STANDALONE);
    expect(parseVibeTermRoles('   ')).toEqual(STANDALONE);
  });

  test('legal values agree', () => {
    for (const raw of ['standalone', 'node', 'hub,node', '  hub,node  '] as const) {
      expect(parseGatewayVibeTermRoles(raw)).toEqual(parseVibeTermRoles(raw));
    }
  });

  test('invalid values throw in both (distinct messages)', () => {
    for (const raw of ['hub', 'node,hub', 'HUB,NODE', 'standalone,node']) {
      expect(() => parseGatewayVibeTermRoles(raw)).toThrow('VIBETERM_ROLES must be one of');
      expect(() => parseVibeTermRoles(raw)).toThrow('role must be one of');
    }
  });
});
