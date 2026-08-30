import { describe, expect, test } from 'bun:test';
import { parseTmexRoles as parseGatewayTmexRoles } from '../../../../apps/gateway/src/config';
import { parseTmexRoleName, parseTmexRoles } from './roles';

const STANDALONE = { hub: false, node: false };
const NODE = { hub: false, node: true };
const HUB_NODE = { hub: true, node: true };

describe('app parseTmexRoles wrapper', () => {
  test('undefined / empty / whitespace normalize to standalone', () => {
    expect(parseTmexRoles(undefined)).toEqual(STANDALONE);
    expect(parseTmexRoles('')).toEqual(STANDALONE);
    expect(parseTmexRoles('   ')).toEqual(STANDALONE);
  });

  test('accepts the three legal values', () => {
    expect(parseTmexRoles('standalone')).toEqual(STANDALONE);
    expect(parseTmexRoles('node')).toEqual(NODE);
    expect(parseTmexRoles('hub,node')).toEqual(HUB_NODE);
    expect(parseTmexRoles('  node  ')).toEqual(NODE);
  });

  test('rejects invalid role names', () => {
    expect(() => parseTmexRoles('hub')).toThrow('role must be one of standalone | node | hub,node');
    expect(() => parseTmexRoles('node,hub')).toThrow('role must be one of');
  });
});

describe('app parseTmexRoleName wrapper', () => {
  test('undefined defaults to standalone; empty/whitespace still fail', () => {
    expect(parseTmexRoleName(undefined)).toBe('standalone');
    expect(() => parseTmexRoleName('')).toThrow('role must be one of');
    expect(() => parseTmexRoleName('   ')).toThrow('role must be one of');
  });
});

describe('gateway vs app TMEX_ROLES wrappers', () => {
  test('undefined is standalone in both', () => {
    expect(parseGatewayTmexRoles(undefined)).toEqual(STANDALONE);
    expect(parseTmexRoles(undefined)).toEqual(STANDALONE);
  });

  test('empty and whitespace: gateway rejects, app normalizes', () => {
    expect(() => parseGatewayTmexRoles('')).toThrow('TMEX_ROLES');
    expect(() => parseGatewayTmexRoles('   ')).toThrow('TMEX_ROLES');
    expect(parseTmexRoles('')).toEqual(STANDALONE);
    expect(parseTmexRoles('   ')).toEqual(STANDALONE);
  });

  test('legal values agree', () => {
    for (const raw of ['standalone', 'node', 'hub,node', '  hub,node  '] as const) {
      expect(parseGatewayTmexRoles(raw)).toEqual(parseTmexRoles(raw));
    }
  });

  test('invalid values throw in both (distinct messages)', () => {
    for (const raw of ['hub', 'node,hub', 'HUB,NODE', 'standalone,node']) {
      expect(() => parseGatewayTmexRoles(raw)).toThrow('TMEX_ROLES must be one of');
      expect(() => parseTmexRoles(raw)).toThrow('role must be one of');
    }
  });
});
