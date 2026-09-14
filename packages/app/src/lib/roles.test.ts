import { describe, expect, test } from 'bun:test';
import { parseVibeTermRoles as parseGatewayVibeTermRoles } from '../../../../apps/gateway/src/config';
import { parseVibeTermRoleName, parseVibeTermRoles } from './roles';

const STANDALONE = { node: false, relay: false };
const NODE = { node: true, relay: false };
const RELAY = { node: false, relay: true };
const RELAY_NODE = { node: true, relay: true };
const ROLE_ERROR = 'VIBETERM_ROLES must be one of standalone | node | relay | relay,node';

describe('app parseVibeTermRoles wrapper', () => {
  test('undefined / empty / whitespace normalize to standalone', () => {
    expect(parseVibeTermRoles(undefined)).toEqual(STANDALONE);
    expect(parseVibeTermRoles('')).toEqual(STANDALONE);
    expect(parseVibeTermRoles('   ')).toEqual(STANDALONE);
  });

  test('accepts the four legal values', () => {
    expect(parseVibeTermRoles('standalone')).toEqual(STANDALONE);
    expect(parseVibeTermRoles('node')).toEqual(NODE);
    expect(parseVibeTermRoles('relay')).toEqual(RELAY);
    expect(parseVibeTermRoles('relay,node')).toEqual(RELAY_NODE);
    expect(parseVibeTermRoles('  node  ')).toEqual(NODE);
  });

  test('maps leftover hub,node to node', () => {
    expect(parseVibeTermRoles('hub,node')).toEqual(NODE);
    expect(parseVibeTermRoleName('  hub,node  ')).toBe('node');
  });

  test('rejects invalid role names', () => {
    expect(() => parseVibeTermRoles('hub')).toThrow(ROLE_ERROR);
    expect(() => parseVibeTermRoles('node,hub')).toThrow(ROLE_ERROR);
  });
});

describe('app parseVibeTermRoleName wrapper', () => {
  test('undefined defaults to standalone; empty/whitespace still fail', () => {
    expect(parseVibeTermRoleName(undefined)).toBe('standalone');
    expect(() => parseVibeTermRoleName('')).toThrow(ROLE_ERROR);
    expect(() => parseVibeTermRoleName('   ')).toThrow(ROLE_ERROR);
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
    for (const raw of ['standalone', 'node', 'relay', 'relay,node', '  hub,node  '] as const) {
      expect(parseGatewayVibeTermRoles(raw)).toEqual(parseVibeTermRoles(raw));
    }
  });

  test('invalid values throw in both', () => {
    for (const raw of ['hub', 'node,hub', 'HUB,NODE', 'standalone,node']) {
      expect(() => parseGatewayVibeTermRoles(raw)).toThrow(ROLE_ERROR);
      expect(() => parseVibeTermRoles(raw)).toThrow(ROLE_ERROR);
    }
  });
});
