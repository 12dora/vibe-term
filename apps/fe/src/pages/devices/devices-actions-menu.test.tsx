// 「更多」下拉的结构断言：Base UI 的弹层内容在无 DOM 环境不会被 SSR 渲染出来，
// 所以这里直接对内容组件的元素树取属性（与 add-device-menu.test.tsx 同一套做法）。

import { describe, expect, test } from 'bun:test';
import { Children, type ReactElement, type ReactNode } from 'react';
import { DevicesActionsMenuList } from './devices-actions-menu';

function topLevel(resetDisabled: boolean): ReactElement[] {
  const root = DevicesActionsMenuList({
    transferLabel: '文件传输',
    portmapLabel: '端口映射',
    resetLabel: '恢复默认布局',
    resetDisabled,
    onTransfer: () => undefined,
    onPortmap: () => undefined,
    onReset: () => undefined,
  }) as ReactElement<{ children?: ReactNode }>;
  return Children.toArray(root.props.children) as ReactElement[];
}

function testIds(items: ReactElement[]): Array<string | undefined> {
  return items.map((item) => (item.props as { 'data-testid'?: string })['data-testid']);
}

describe('DevicesActionsMenuList', () => {
  test('三项按「文件传输 → 端口映射 → 恢复默认布局」排列，恢复项前有分隔线', () => {
    const items = topLevel(false);
    expect(testIds(items)).toEqual([
      'devices-open-transfer',
      'devices-open-portmap',
      undefined,
      'devices-reset-layout',
    ]);
  });

  test('两个弹窗入口不受页面命令影响，恢复默认布局按传入的禁用位', () => {
    const enabled = topLevel(false);
    const disabled = topLevel(true);
    const resetOf = (items: ReactElement[]) =>
      items.find(
        (item) =>
          (item.props as { 'data-testid'?: string })['data-testid'] === 'devices-reset-layout'
      )?.props as { disabled?: boolean };

    expect(resetOf(enabled)?.disabled).toBe(false);
    expect(resetOf(disabled)?.disabled).toBe(true);
    // 传输 / 端口映射任何时候都不带 disabled
    for (const items of [enabled, disabled]) {
      for (const id of ['devices-open-transfer', 'devices-open-portmap']) {
        const item = items.find(
          (candidate) => (candidate.props as { 'data-testid'?: string })['data-testid'] === id
        );
        expect((item?.props as { disabled?: boolean }).disabled).toBeUndefined();
      }
    }
  });

  test('三项各自触发对应回调', () => {
    const calls: string[] = [];
    const root = DevicesActionsMenuList({
      transferLabel: 't',
      portmapLabel: 'p',
      resetLabel: 'r',
      resetDisabled: false,
      onTransfer: () => calls.push('transfer'),
      onPortmap: () => calls.push('portmap'),
      onReset: () => calls.push('reset'),
    }) as ReactElement<{ children?: ReactNode }>;
    for (const item of Children.toArray(root.props.children) as ReactElement[]) {
      (item.props as { onClick?: () => void }).onClick?.();
    }
    expect(calls).toEqual(['transfer', 'portmap', 'reset']);
  });
});
