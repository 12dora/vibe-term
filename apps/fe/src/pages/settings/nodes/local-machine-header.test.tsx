// 卡头的操作菜单。菜单内容走 portal，SSR 什么都不输出：把 `LocalMachineMenuList`
// 当普通函数调用，再对元素树断言（同 `BulkActionsMenuList`）。

import { describe, expect, test } from 'bun:test';
import type { LocalRole } from '@tmex/api-client/local/types';
import { DropdownMenuGroup, DropdownMenuLabel } from '@tmex/ui/dropdown-menu';
import { Children, type ReactElement, type ReactNode } from 'react';
import { LocalMachineMenuList } from './local-machine-header';
import { roleMenuTargets } from './machine-status';

type ItemProps = {
  'data-testid'?: string;
  disabled?: boolean;
  onClick?: () => void;
  render?: ReactElement<{ to?: string }>;
  children?: ReactNode;
};

function renderList(role: LocalRole, roleLocked = false) {
  const picked: LocalRole[] = [];
  let left = 0;
  const list = LocalMachineMenuList({
    roles: roleMenuTargets(role),
    roleLabel: (target) => `role:${target}`,
    labels: { changeRole: '更改角色', leave: '离开…', security: '账号安全' },
    securityHref: '/?panel=security',
    roleLocked,
    onSelectRole: (target) => {
      picked.push(target);
    },
    onLeave: () => {
      left += 1;
    },
  }) as ReactElement<{ children?: ReactNode }>;
  const top = Children.toArray(list.props.children) as ReactElement<{ children?: ReactNode }>[];
  const items = top.flatMap((node) =>
    node.type === DropdownMenuGroup
      ? (Children.toArray(node.props.children) as ReactElement<ItemProps>[])
      : [node as ReactElement<ItemProps>]
  );
  return { top, items, picked, leftCount: () => left };
}

describe('LocalMachineMenuList', () => {
  // Base UI 的 Menu.GroupLabel 必须挂在 Menu.Group 里，否则打开菜单即抛错整页崩溃（1.1.28 事故）。
  test('「更改角色」小标题与角色项一起包在 DropdownMenuGroup 里', () => {
    const { top } = renderList('node');
    const group = top[0];
    expect(group?.type).toBe(DropdownMenuGroup);
    const inner = Children.toArray(group?.props.children) as ReactElement[];
    expect(inner[0]?.type).toBe(DropdownMenuLabel);
    expect(top.some((node) => node.type === DropdownMenuLabel)).toBe(false);
  });

  test('先是角色分组，再是离开与账号安全', () => {
    const { items } = renderList('node');
    const testIds = items.map((item) => item.props['data-testid']);
    expect(testIds).toEqual([
      undefined, // 「更改角色」小标题
      'local-machine-role-hub,node',
      'local-machine-role-relay,node',
      'local-machine-role-relay',
      undefined, // 分隔线
      'local-machine-leave',
      'local-machine-account-security',
    ]);
  });

  test('账号安全指向右侧滑出面板，而不是已删除的整页', () => {
    const { items } = renderList('node');
    const security = items.find(
      (item) => item.props['data-testid'] === 'local-machine-account-security'
    );
    expect(security?.props.render?.props.to).toBe('/?panel=security');
  });

  test('点角色项与离开各自走对应回调', () => {
    const { items, picked, leftCount } = renderList('node');
    items[1]?.props.onClick?.();
    items[5]?.props.onClick?.();
    expect(picked).toEqual(['hub,node']);
    expect(leftCount()).toBe(1);
  });

  test('退出 / 设置在途时角色与离开都锁上，账号安全照旧可点', () => {
    const { items } = renderList('node', true);
    expect(items[1]?.props.disabled).toBe(true);
    expect(items[5]?.props.disabled).toBe(true);
    expect(items[6]?.props.disabled).toBeUndefined();
  });

  test('中继兼节点：可以切回普通节点，也可以切成纯中继', () => {
    const { items } = renderList('relay,node');
    expect(items.map((item) => item.props['data-testid'])).toContain('local-machine-role-relay');
    expect(items.map((item) => item.props['data-testid'])).toContain('local-machine-role-node');
    expect(items.map((item) => item.props['data-testid'])).not.toContain(
      'local-machine-role-relay,node'
    );
  });
});
