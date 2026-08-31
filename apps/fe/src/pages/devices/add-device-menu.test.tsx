// 「+」下拉的回归测试：Base UI 的 GroupLabel 离开 Group 会在渲染期抛错（线上表现为点「+」
// 整页崩溃，Base UI error #31）。无 DOM 环境里弹层内容不会被 SSR 渲染出来，所以这里
// 直接对内容组件的元素树做结构断言，并用 SSR 证明这条约束本身成立。

import { describe, expect, test } from 'bun:test';
import {
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@tmex/ui/dropdown-menu';
import { Children, type ReactElement, type ReactNode, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Link } from 'react-router';
import { ADD_REMOTE_NODE_PATH, AddDeviceMenuList } from './add-device-menu';
import type { AddDeviceTarget } from './add-device-targets';

const TARGETS: AddDeviceTarget[] = [
  { runtimeNodeId: 'self', name: 'entry', isSelf: true, open: () => {} },
  { runtimeNodeId: 'node-b', name: 'b', isSelf: false, open: () => {} },
];

function renderList(targets: AddDeviceTarget[] = TARGETS): ReactElement {
  return AddDeviceMenuList({
    targets,
    label: 'Add to',
    selfLabel: 'this node',
    remoteNodeLabel: 'Add remote node',
    remoteNodeHref: ADD_REMOTE_NODE_PATH,
    itemTitle: (target) => `add to ${target.name}`,
  }) as ReactElement;
}

function topLevel(targets?: AddDeviceTarget[]): ReactElement[] {
  const root = renderList(targets) as ReactElement<{ children?: ReactNode }>;
  return Children.toArray(root.props.children) as ReactElement[];
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

  test('remote-node entry comes first, separated from the node group', () => {
    const [remote, separator, group] = topLevel();
    const remoteProps = remote.props as {
      'data-testid'?: string;
      render?: ReactElement<{ to?: string }>;
    };
    expect(remoteProps['data-testid']).toBe('devices-add-remote-node');
    expect(remoteProps.render?.type).toBe(Link);
    expect(remoteProps.render?.props.to).toBe('/settings?tab=nodes');
    expect(separator.type).toBe(DropdownMenuSeparator);
    expect(group.type).toBe(DropdownMenuGroup);
  });

  test('remote-node entry stays available with a single target', () => {
    const [remote, , group] = topLevel([TARGETS[0]]);
    expect((remote.props as { 'data-testid'?: string })['data-testid']).toBe(
      'devices-add-remote-node'
    );
    const children = Children.toArray((group.props as { children?: ReactNode }).children);
    expect(children).toHaveLength(2);
  });

  test('renders one item per target', () => {
    const [, , group] = topLevel();
    const children = Children.toArray((group.props as { children?: ReactNode }).children);
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
