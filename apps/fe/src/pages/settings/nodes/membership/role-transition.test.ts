// 角色切换分类：三种角色的九种组合。

import { describe, expect, test } from 'bun:test';
import { classifyRoleChange, isMeshRole, setupPathForRole } from './role-transition';

describe('classifyRoleChange', () => {
  test('目标就是当前角色：什么都不做', () => {
    expect(classifyRoleChange('standalone', 'standalone')).toEqual({ kind: 'none' });
    expect(classifyRoleChange('node', 'node')).toEqual({ kind: 'none' });
    expect(classifyRoleChange('hub,node', 'hub,node')).toEqual({ kind: 'none' });
  });

  test('standalone → mesh：只展开对应向导，不调接口', () => {
    expect(classifyRoleChange('standalone', 'node')).toEqual({ kind: 'setup', path: 'join-hub' });
    expect(classifyRoleChange('standalone', 'hub,node')).toEqual({
      kind: 'setup',
      path: 'become-hub',
    });
  });

  test('mesh → standalone：退出，带上当前角色做 expectedRole', () => {
    expect(classifyRoleChange('node', 'standalone')).toEqual({ kind: 'leave', from: 'node' });
    expect(classifyRoleChange('hub,node', 'standalone')).toEqual({
      kind: 'leave',
      from: 'hub,node',
    });
  });

  test('mesh → 另一个 mesh 角色：先退出，重启后走 path', () => {
    expect(classifyRoleChange('node', 'hub,node')).toEqual({
      kind: 'switch',
      from: 'node',
      path: 'become-hub',
    });
    expect(classifyRoleChange('hub,node', 'node')).toEqual({
      kind: 'switch',
      from: 'hub,node',
      path: 'join-hub',
    });
  });
});

describe('角色判定', () => {
  test('isMeshRole', () => {
    expect(isMeshRole('standalone')).toBe(false);
    expect(isMeshRole('node')).toBe(true);
    expect(isMeshRole('hub,node')).toBe(true);
  });

  test('setupPathForRole', () => {
    expect(setupPathForRole('node')).toBe('join-hub');
    expect(setupPathForRole('hub,node')).toBe('become-hub');
  });
});
