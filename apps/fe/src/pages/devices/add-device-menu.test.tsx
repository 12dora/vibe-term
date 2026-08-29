// 「+」下拉的回归测试：Base UI 的 GroupLabel 离开 Group 会在渲染期抛错（线上表现为点「+」
// 整页崩溃，Base UI error #31）。无 DOM 环境里弹层内容不会被 SSR 渲染出来，所以这里
// 直接对内容组件的元素树做结构断言，并用 SSR 证明这条约束本身成立。

import { describe, expect, test } from 'bun:test';
import { DropdownMenuGroup, DropdownMenuLabel } from '@tmex/ui/dropdown-menu';
import { Children, type ReactElement, type ReactNode, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AddDeviceMenuList } from './add-device-menu';
import type { AddDeviceTarget } from './add-device-targets';

const TARGETS: AddDeviceTarget[] = [
  { runtimeNodeId: 'self', name: 'entry', isSelf: true, open: () => {} },
  { runtimeNodeId: 'node-b', name: 'b', isSelf: false, open: () => {} },
];

function renderList(): ReactElement {
  return AddDeviceMenuList({
    targets: TARGETS,
    label: 'Add to',
    selfLabel: 'this node',
    itemTitle: (target) => `add to ${target.name}`,
  }) as ReactElement;
}

/** 遍历元素树，收集每个 `type === needle` 节点的祖先 type 列表。 */
function ancestorsOf(node: ReactNode, needle: unknown, path: unknown[] = []): unknown[][] {
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  const found: unknown[][] = element.type === needle ? [path] : [];
  const next = [...path, element.type];
  for (const child of Children.toArray(element.props.children)) {
    found.push(...ancestorsOf(child, needle, next));
  }
  return found;
}

describe('AddDeviceMenuList', () => {
  test('group label is nested inside a menu group', () => {
    const labels = ancestorsOf(renderList(), DropdownMenuLabel);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toContain(DropdownMenuGroup);
  });

  test('renders one item per target', () => {
    const group = renderList() as ReactElement<{ children?: ReactNode }>;
    const children = Children.toArray(group.props.children);
    expect(children).toHaveLength(1 + TARGETS.length);
  });
});

describe('DropdownMenuLabel contract', () => {
  test('throws outside DropdownMenuGroup and renders inside it', () => {
    expect(() => renderToStaticMarkup(<DropdownMenuLabel>x</DropdownMenuLabel>)).toThrow();
    expect(
      renderToStaticMarkup(
        <DropdownMenuGroup>
          <DropdownMenuLabel>x</DropdownMenuLabel>
        </DropdownMenuGroup>
      )
    ).toContain('dropdown-menu-label');
  });
});
