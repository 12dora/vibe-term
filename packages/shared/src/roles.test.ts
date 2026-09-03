import { describe, expect, it } from 'bun:test';
import {
  isStandaloneRoles,
  isTmexRoleName,
  roleNameFromFlags,
  rolesFromName,
  validateRoles,
} from './roles';

const STANDALONE = { hub: false, node: false, relay: false };
const NODE = { hub: false, node: true, relay: false };
const HUB_NODE = { hub: true, node: true, relay: false };
const RELAY = { hub: false, node: false, relay: true };
const RELAY_NODE = { hub: false, node: true, relay: true };

describe('isTmexRoleName', () => {
  it('接受受支持的角色名', () => {
    expect(isTmexRoleName('standalone')).toBe(true);
    expect(isTmexRoleName('node')).toBe(true);
    expect(isTmexRoleName('hub,node')).toBe(true);
    expect(isTmexRoleName('relay')).toBe(true);
    expect(isTmexRoleName('relay,node')).toBe(true);
  });

  it('拒绝其它写法', () => {
    for (const raw of ['', 'hub', 'node,hub', 'HUB,NODE', 'hub,node,extra', 'node,relay']) {
      expect(isTmexRoleName(raw)).toBe(false);
    }
  });
});

describe('rolesFromName / roleNameFromFlags', () => {
  it('名称与标志位互转', () => {
    expect(rolesFromName('standalone')).toEqual(STANDALONE);
    expect(rolesFromName('node')).toEqual(NODE);
    expect(rolesFromName('hub,node')).toEqual(HUB_NODE);
    expect(rolesFromName('relay')).toEqual(RELAY);
    expect(rolesFromName('relay,node')).toEqual(RELAY_NODE);

    expect(roleNameFromFlags(STANDALONE)).toBe('standalone');
    expect(roleNameFromFlags(NODE)).toBe('node');
    expect(roleNameFromFlags(HUB_NODE)).toBe('hub,node');
    expect(roleNameFromFlags(RELAY)).toBe('relay');
    expect(roleNameFromFlags(RELAY_NODE)).toBe('relay,node');
  });

  it('hub 单独存在不是合法组合，按 standalone 处理', () => {
    expect(roleNameFromFlags({ hub: true, node: false, relay: false })).toBe('standalone');
  });

  it('relay 优先于 hub（非法组合由 validateRoles 拦截）', () => {
    expect(roleNameFromFlags({ hub: true, node: false, relay: true })).toBe('relay');
  });
});

describe('isStandaloneRoles', () => {
  it('只有三个标志位全 false 才是 standalone', () => {
    expect(isStandaloneRoles(STANDALONE)).toBe(true);
    expect(isStandaloneRoles(NODE)).toBe(false);
    expect(isStandaloneRoles(HUB_NODE)).toBe(false);
    expect(isStandaloneRoles(RELAY)).toBe(false);
    expect(isStandaloneRoles(RELAY_NODE)).toBe(false);
    expect(isStandaloneRoles({ hub: true, node: false, relay: false })).toBe(false);
  });
});

describe('validateRoles', () => {
  it('合法组合返回 null', () => {
    for (const roles of [STANDALONE, NODE, HUB_NODE, RELAY, RELAY_NODE]) {
      expect(validateRoles(roles)).toBeNull();
    }
  });

  it('hub 与 relay 同机被拒绝', () => {
    expect(validateRoles({ hub: true, node: true, relay: true })).toBe(
      'relay cannot be combined with hub'
    );
    expect(validateRoles({ hub: true, node: false, relay: true })).toBe(
      'relay cannot be combined with hub'
    );
  });
});
