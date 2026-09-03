import { describe, expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import {
  OverlayTrigger,
  createOverlayLoader,
  overlayClosedChildren,
  recoverFromOverlayLoadFailure,
  resetOverlayReloadGuardForTests,
  stripTriggerProps,
} from './lazy-overlay';

describe('createOverlayLoader', () => {
  test('成功后缓存模块，同一实例不再重复 import', async () => {
    let calls = 0;
    const loader = createOverlayLoader(async () => {
      calls += 1;
      return { value: calls };
    });

    expect(loader.peek()).toBeNull();
    expect(await loader.load()).toEqual({ value: 1 });
    expect(await loader.load()).toEqual({ value: 1 });
    expect(loader.peek()).toEqual({ value: 1 });
    expect(calls).toBe(1);
  });

  test('并发 load 共用同一次 import', async () => {
    let calls = 0;
    const loader = createOverlayLoader(async () => {
      calls += 1;
      return { value: calls };
    });

    const [first, second] = await Promise.all([loader.load(), loader.load()]);

    expect(first).toBe(second);
    expect(calls).toBe(1);
  });

  test('失败不缓存：重试会重新发起 import', async () => {
    let calls = 0;
    const loader = createOverlayLoader(async () => {
      calls += 1;
      if (calls === 1) throw new Error('chunk 404');
      return { value: calls };
    });

    await expect(loader.load()).rejects.toThrow('chunk 404');
    expect(loader.peek()).toBeNull();
    expect(await loader.load()).toEqual({ value: 2 });
    expect(calls).toBe(2);
  });
});

describe('recoverFromOverlayLoadFailure', () => {
  test('每会话至多刷新一次，避免新版也 404 时无限刷新', () => {
    resetOverlayReloadGuardForTests();
    let reloads = 0;
    const reload = () => {
      reloads += 1;
    };

    expect(recoverFromOverlayLoadFailure(reload)).toBe(true);
    expect(recoverFromOverlayLoadFailure(reload)).toBe(false);
    expect(reloads).toBe(1);
    resetOverlayReloadGuardForTests();
  });
});

describe('overlayClosedChildren', () => {
  test('普通子节点原样透出', () => {
    expect(overlayClosedChildren('文本')).toBe('文本');
  });

  test('payload 渲染函数没有可传的 payload，先不渲染', () => {
    expect(overlayClosedChildren(() => null)).toBeNull();
  });
});

describe('stripTriggerProps', () => {
  test('丢掉 base-ui 触发器的非 DOM 属性', () => {
    const rest = stripTriggerProps({
      className: 'x',
      delay: 400,
      closeDelay: 0,
      handle: {},
      payload: 1,
      nativeButton: true,
      openOnHover: false,
      render: <span />,
      children: 'y',
    });

    expect(rest).toEqual({ className: 'x', children: 'y' });
  });

  test('默认 button 时保留 disabled，自定义 render 时不写到元素上', () => {
    expect(stripTriggerProps({ disabled: true })).toEqual({ disabled: true });
    expect(stripTriggerProps({ disabled: true, render: <span /> })).toEqual({});
  });
});

describe('OverlayTrigger 占位', () => {
  const html = (element: React.ReactElement) => renderToStaticMarkup(element);

  test('闭合态与实现侧同标签同 data-slot 同 className', () => {
    const markup = html(
      <OverlayTrigger
        slot="tooltip-trigger"
        render={<span />}
        props={{ className: 'block truncate', title: '书房', children: '书房' }}
        onActivate={() => undefined}
      />
    );

    expect(markup.startsWith('<span')).toBe(true);
    expect(markup).toContain('data-slot="tooltip-trigger"');
    expect(markup).toContain('class="block truncate"');
    expect(markup).toContain('title="书房"');
    expect(markup).toContain('书房');
  });

  test('调用方自带的 data-slot 覆盖默认值（与实现侧的 props 覆盖顺序一致）', () => {
    const markup = html(
      <OverlayTrigger
        slot="tooltip-trigger"
        props={{ 'data-slot': 'sidebar-menu-button', children: '设置' }}
        onActivate={() => undefined}
      />
    );

    expect(markup).toContain('data-slot="sidebar-menu-button"');
    expect(markup).not.toContain('data-slot="tooltip-trigger"');
  });

  test('未给 render 时落到 button', () => {
    const markup = html(
      <OverlayTrigger
        slot="dropdown-menu-trigger"
        props={{ children: '更多' }}
        onActivate={() => undefined}
        onOpen={() => undefined}
      />
    );

    expect(markup.startsWith('<button')).toBe(true);
    expect(markup).toContain('data-slot="dropdown-menu-trigger"');
  });
});
