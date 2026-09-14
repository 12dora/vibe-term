// 卡头的操作菜单。菜单内容走 portal，SSR 什么都不输出：把 `LocalMachineMenuList`
// 当普通函数调用，再对元素树断言（同 `BulkActionsMenuList`）。

import { describe, expect, test } from 'bun:test';
import type { LocalRole } from '@vibeterm/api-client/local/types';
import { DropdownMenuGroup, DropdownMenuLabel } from '@vibeterm/ui/dropdown-menu';
import { Children, type ReactElement, type ReactNode } from 'react';
import { LocalMachineMenuList } from './local-machine-header';
import { roleMenuTargets } from './machine-status';
import type { ConnectMenuItem } from './uplink/connect-menu';

type ItemProps = {
  'data-testid'?: string;
  disabled?: boolean;
  onClick?: () => void;
  render?: ReactElement<{ to?: string }>;
  children?: ReactNode;
};

function renderList(role: LocalRole, roleLocked = false, connect: ConnectMenuItem[] = []) {
  const picked: LocalRole[] = [];
  let left = 0;
  const list = LocalMachineMenuList({
    roles: roleMenuTargets(role),
    roleLabel: (target) => `role:${target}`,
    connect,
    labels: {
      connect: '连接',
      changeRole: '更改角色',
      leave: '退出多节点互联…',
      security: '账号安全',
    },
    securityHref: '/?panel=security',
    roleLocked,
    onSelectRole: (target) => {
      picked.push(target);
    },
    onLeave: () => {
      left += 1;
    },
  }) as ReactElement<{ children?: ReactNode }>;
  // 「连接」组带着自己的分隔线包在一个 Fragment 里，展平一层才拿得到分组本身。
  const top = (
    Children.toArray(list.props.children) as ReactElement<{ children?: ReactNode }>[]
  ).flatMap((node) =>
    typeof node.type === 'symbol'
      ? (Children.toArray(node.props.children) as ReactElement<{ children?: ReactNode }>[])
      : [node]
  );
  const items = top.flatMap((node) =>
    node.type === DropdownMenuGroup
      ? (Children.toArray(node.props.children) as ReactElement<ItemProps>[])
      : [node as ReactElement<ItemProps>]
  );
  return { top, items, picked, leftCount: () => left };
}

function connectItem(overrides: Partial<ConnectMenuItem> = {}): ConnectMenuItem {
  return {
    key: 'relay-add',
    label: '追加中继',
    testId: 'nodes-relay-add',
    onSelect: () => undefined,
    ...overrides,
  };
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
      'local-machine-role-relay',
      'local-machine-role-relay,node',
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
    items[4]?.props.onClick?.();
    expect(picked).toEqual(['relay']);
    expect(leftCount()).toBe(1);
  });

  test('退出 / 设置在途时角色与离开都锁上，账号安全照旧可点', () => {
    const { items } = renderList('node', true);
    expect(items[1]?.props.disabled).toBe(true);
    expect(items[4]?.props.disabled).toBe(true);
    expect(items[5]?.props.disabled).toBeUndefined();
  });

  test('没有上级动作时「连接」组整组不出', () => {
    const { items } = renderList('node');
    expect(items.map((item) => item.props['data-testid'])).not.toContain('nodes-relay-add');
  });

  test('「连接」组排在最前，标题也包在 DropdownMenuGroup 里', () => {
    const { top, items } = renderList('node', false, [
      connectItem(),
      connectItem({ key: 'relay-leave', testId: 'nodes-relay-leave', destructive: true }),
    ]);
    expect(top[0]?.type).toBe(DropdownMenuGroup);
    const inner = Children.toArray(top[0]?.props.children) as ReactElement[];
    expect(inner[0]?.type).toBe(DropdownMenuLabel);
    expect(items.map((item) => item.props['data-testid']).slice(0, 3)).toEqual([
      undefined, // 「连接」小标题
      'nodes-relay-add',
      'nodes-relay-leave',
    ]);
  });

  test('上级动作各带自己的回调、危险档与禁用态', () => {
    let picked = '';
    const { items } = renderList('node', false, [
      connectItem({
        key: 'relay-add',
        testId: 'nodes-relay-add',
        disabled: true,
        onSelect: () => {
          picked = 'relay-add';
        },
      }),
      connectItem({ key: 'relay-leave', testId: 'nodes-relay-leave', destructive: true }),
    ]);
    const add = items.find((item) => item.props['data-testid'] === 'nodes-relay-add');
    expect(add?.props.disabled).toBe(true);
    add?.props.onClick?.();
    expect(picked).toBe('relay-add');
    const leave = items.find((item) => item.props['data-testid'] === 'nodes-relay-leave');
    expect((leave?.props as { variant?: string }).variant).toBe('destructive');
  });

  // 禁用项在 Base UI 里不收指针事件，原生 title 永远不出；理由得有一份读屏拿得到的文本。
  test('带理由的项挂 aria-describedby，并在项内渲染同一段 sr-only 文本', () => {
    const { items } = renderList('node', false, [
      connectItem({ reason: '已达 16 条上限' }),
      connectItem({ key: 'relay-leave', testId: 'nodes-relay-leave', destructive: true }),
    ]);
    const add = items.find((item) => item.props['data-testid'] === 'nodes-relay-add');
    const props = add?.props as ItemProps & { 'aria-describedby'?: string; title?: string };
    expect(props['aria-describedby']).toBe('nodes-relay-add-reason');
    expect(props.title).toBe('已达 16 条上限');
    expect(props.disabled).toBe(false);
    const reason = (Children.toArray(props.children) as ReactElement<{ id?: string }>[]).find(
      (node) => typeof node === 'object' && node.props?.id === 'nodes-relay-add-reason'
    );
    expect(reason).toBeTruthy();
    const leaveProps = items.find((item) => item.props['data-testid'] === 'nodes-relay-leave')
      ?.props as { 'aria-describedby'?: string };
    expect(leaveProps['aria-describedby']).toBeUndefined();
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
