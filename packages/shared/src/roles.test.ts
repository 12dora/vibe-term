import { describe, expect, it } from 'bun:test';
import {
  isStandaloneRoles,
  isVibeTermRoleName,
  normalizeLegacyRoleName,
  roleNameFromFlags,
  rolesFromName,
} from './roles';

const STANDALONE = { node: false, relay: false };
const NODE = { node: true, relay: false };
const RELAY = { node: false, relay: true };
const RELAY_NODE = { node: true, relay: true };

describe('isVibeTermRoleName', () => {
  it('接受受支持的角色名', () => {
    expect(isVibeTermRoleName('standalone')).toBe(true);
    expect(isVibeTermRoleName('node')).toBe(true);
    expect(isVibeTermRoleName('relay')).toBe(true);
    expect(isVibeTermRoleName('relay,node')).toBe(true);
  });

  it('拒绝其它写法', () => {
    for (const raw of [
      '',
      'hub',
      'hub,node',
      'node,hub',
      'HUB,NODE',
      'hub,node,extra',
      'node,relay',
    ]) {
      expect(isVibeTermRoleName(raw)).toBe(false);
    }
  });
});

describe('normalizeLegacyRoleName', () => {
  it('把 leftover hub,node 映射为 node', () => {
    expect(normalizeLegacyRoleName('hub,node')).toEqual({ name: 'node', legacy: true });
    expect(normalizeLegacyRoleName('  hub,node  ')).toEqual({ name: 'node', legacy: true });
  });

  it('其余字符串 trim 后原样返回', () => {
    expect(normalizeLegacyRoleName('node')).toEqual({ name: 'node', legacy: false });
    expect(normalizeLegacyRoleName(' relay,node ')).toEqual({ name: 'relay,node', legacy: false });
    expect(normalizeLegacyRoleName('hub')).toEqual({ name: 'hub', legacy: false });
    expect(normalizeLegacyRoleName('HUB,NODE')).toEqual({ name: 'HUB,NODE', legacy: false });
    expect(normalizeLegacyRoleName('hub, node')).toEqual({ name: 'hub, node', legacy: false });
    expect(normalizeLegacyRoleName('')).toEqual({ name: '', legacy: false });
  });
});

describe('rolesFromName / roleNameFromFlags', () => {
  it('名称与标志位互转', () => {
    expect(rolesFromName('standalone')).toEqual(STANDALONE);
    expect(rolesFromName('node')).toEqual(NODE);
    expect(rolesFromName('relay')).toEqual(RELAY);
    expect(rolesFromName('relay,node')).toEqual(RELAY_NODE);

    expect(roleNameFromFlags(STANDALONE)).toBe('standalone');
    expect(roleNameFromFlags(NODE)).toBe('node');
    expect(roleNameFromFlags(RELAY)).toBe('relay');
    expect(roleNameFromFlags(RELAY_NODE)).toBe('relay,node');
  });
});

describe('isStandaloneRoles', () => {
  it('只有两个标志位全 false 才是 standalone', () => {
    expect(isStandaloneRoles(STANDALONE)).toBe(true);
    expect(isStandaloneRoles(NODE)).toBe(false);
    expect(isStandaloneRoles(RELAY)).toBe(false);
    expect(isStandaloneRoles(RELAY_NODE)).toBe(false);
  });
});
