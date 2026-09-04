// 角色切换分类：五个角色的 5×5 组合。

import { describe, expect, test } from 'bun:test';
import type { LocalRole } from '@tmex/api-client/local/types';
import {
  type RoleTransition,
  classifyRoleChange,
  isMeshRole,
  isRelayRole,
  setupIntentForRole,
} from './role-transition';

const ROLES: LocalRole[] = ['standalone', 'node', 'hub,node', 'relay', 'relay,node'];

describe('classifyRoleChange', () => {
  test('目标就是当前角色：什么都不做', () => {
    for (const role of ROLES) {
      expect(classifyRoleChange(role, role)).toEqual({ kind: 'none' });
    }
  });

  test('standalone → 任意角色：只展开对应向导，不调接口', () => {
    expect(classifyRoleChange('standalone', 'node')).toEqual({
      kind: 'setup',
      intent: { path: 'join-hub' },
    });
    expect(classifyRoleChange('standalone', 'hub,node')).toEqual({
      kind: 'setup',
      intent: { path: 'become-hub' },
    });
    expect(classifyRoleChange('standalone', 'relay,node')).toEqual({
      kind: 'setup',
      intent: { path: 'become-relay', role: 'relay,node' },
    });
    expect(classifyRoleChange('standalone', 'relay')).toEqual({
      kind: 'setup',
      intent: { path: 'become-relay', role: 'relay' },
    });
  });

  test('mesh → standalone：退出，带上当前角色做 expectedRole', () => {
    expect(classifyRoleChange('node', 'standalone')).toEqual({
      kind: 'leave',
      from: 'node',
      targetRole: 'standalone',
    });
    expect(classifyRoleChange('hub,node', 'standalone')).toEqual({
      kind: 'leave',
      from: 'hub,node',
      targetRole: 'standalone',
    });
    expect(classifyRoleChange('relay,node', 'standalone')).toEqual({
      kind: 'leave',
      from: 'relay,node',
      targetRole: 'standalone',
    });
  });

  test('mesh → 另一个 hub 角色：先退出，重启后走向导', () => {
    expect(classifyRoleChange('node', 'hub,node')).toEqual({
      kind: 'switch',
      from: 'node',
      targetRole: 'standalone',
      intent: { path: 'become-hub' },
    });
    expect(classifyRoleChange('hub,node', 'node')).toEqual({
      kind: 'switch',
      from: 'hub,node',
      targetRole: 'standalone',
      intent: { path: 'join-hub' },
    });
  });

  test('node / hub,node → 中继两档：退出后重启走中继表单，角色一并带过去', () => {
    expect(classifyRoleChange('node', 'relay,node')).toEqual({
      kind: 'switch',
      from: 'node',
      targetRole: 'standalone',
      intent: { path: 'become-relay', role: 'relay,node' },
    });
    expect(classifyRoleChange('hub,node', 'relay')).toEqual({
      kind: 'switch',
      from: 'hub,node',
      targetRole: 'standalone',
      intent: { path: 'become-relay', role: 'relay' },
    });
  });

  test('relay,node → relay：就地退出 mesh，中继运营状态保留', () => {
    expect(classifyRoleChange('relay,node', 'relay')).toEqual({
      kind: 'leave',
      from: 'relay,node',
      targetRole: 'relay',
    });
  });

  test('relay,node → node / hub,node：退到 standalone 再走 hub 向导', () => {
    expect(classifyRoleChange('relay,node', 'node')).toEqual({
      kind: 'switch',
      from: 'relay,node',
      targetRole: 'standalone',
      intent: { path: 'join-hub' },
    });
    expect(classifyRoleChange('relay,node', 'hub,node')).toEqual({
      kind: 'switch',
      from: 'relay,node',
      targetRole: 'standalone',
      intent: { path: 'become-hub' },
    });
  });

  test('纯 relay 没有网页：切出去一律 unsupported', () => {
    for (const to of ROLES) {
      const expected: RoleTransition = to === 'relay' ? { kind: 'none' } : { kind: 'unsupported' };
      expect(classifyRoleChange('relay', to)).toEqual(expected);
    }
  });

  test('5×5 全覆盖：没有一格落空', () => {
    for (const from of ROLES) {
      for (const to of ROLES) {
        expect(typeof classifyRoleChange(from, to).kind).toBe('string');
      }
    }
  });
});

describe('角色判定', () => {
  test('isMeshRole', () => {
    expect(isMeshRole('standalone')).toBe(false);
    expect(isMeshRole('relay')).toBe(false);
    expect(isMeshRole('node')).toBe(true);
    expect(isMeshRole('hub,node')).toBe(true);
    expect(isMeshRole('relay,node')).toBe(true);
  });

  test('isRelayRole', () => {
    expect(isRelayRole('relay')).toBe(true);
    expect(isRelayRole('relay,node')).toBe(true);
    expect(isRelayRole('node')).toBe(false);
    expect(isRelayRole('standalone')).toBe(false);
  });

  test('setupIntentForRole', () => {
    expect(setupIntentForRole('node')).toEqual({ path: 'join-hub' });
    expect(setupIntentForRole('hub,node')).toEqual({ path: 'become-hub' });
    expect(setupIntentForRole('relay')).toEqual({ path: 'become-relay', role: 'relay' });
    expect(setupIntentForRole('relay,node')).toEqual({ path: 'become-relay', role: 'relay,node' });
  });
});
