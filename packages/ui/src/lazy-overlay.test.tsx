import { describe, expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import {
  DIALOG_TRIGGER_SEMANTICS,
  MENU_TRIGGER_SEMANTICS,
  OverlayLoadFallback,
  OverlayTrigger,
  TOOLTIP_TRIGGER_SEMANTICS,
  type TriggerActivity,
  type TriggerHandoff,
  type TriggerHandoffEffects,
  applyTriggerHandoff,
  createOverlayLoader,
  overlayClosedChildren,
  planOverlayLoad,
  planTriggerHandoff,
  recoverFromOverlayLoadFailure,
  resetOverlayReloadGuardForTests,
  stripTriggerProps,
} from './lazy-overlay';

interface FakeHandoff extends TriggerHandoff {
  activity: TriggerActivity;
}

function fakeHandoff(id = 'trigger-1'): FakeHandoff {
  const activity: TriggerActivity = { placeholder: false, focused: false, hovered: false };
  return {
    id,
    activity,
    markPlaceholder: () => {
      activity.placeholder = true;
    },
    record: (patch) => Object.assign(activity, patch),
    adopt: () => undefined,
  };
}

/** 用 useRender 的渲染函数把合并后的 elementProps 捞出来（没有 DOM 环境，只能这样拿到 handler） */
function captureTriggerProps(
  element: (capture: (props: Record<string, unknown>) => void) => React.ReactElement
): Record<string, unknown> {
  let captured: Record<string, unknown> = {};
  renderToStaticMarkup(
    element((props) => {
      captured = props;
    })
  );
  return captured;
}

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

describe('planOverlayLoad', () => {
  test('重试上限内继续就地重试', () => {
    expect(planOverlayLoad(0, false)).toBe('load');
    expect(planOverlayLoad(2, true)).toBe('load');
  });

  test('重试用尽但没人在等：不刷新也不报错', () => {
    expect(planOverlayLoad(3, false)).toBe('wait');
  });

  test('重试用尽且用户在等：升级（刷新兜底 / 兜底面板）', () => {
    expect(planOverlayLoad(3, true)).toBe('escalate');
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

describe('OverlayLoadFallback', () => {
  test('刷新兜底也用尽时给出重试/刷新出口，且不依赖弹层 chunk', () => {
    const markup = renderToStaticMarkup(
      <OverlayLoadFallback onRetry={() => undefined} onReload={() => undefined} />
    );

    expect(markup.startsWith('<dialog')).toBe(true);
    expect(markup).toContain('data-slot="overlay-load-fallback"');
    expect(markup).toContain('Retry');
    expect(markup).toContain('Reload page');
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

describe('planTriggerHandoff', () => {
  test('没经历替换（一上来就是实现）时什么都不补', () => {
    expect(
      planTriggerHandoff(
        { placeholder: false, focused: true, hovered: true },
        { focusLoose: true, pointerInside: true }
      )
    ).toEqual({ focus: false, hover: false });
  });

  test('占位持有焦点且焦点被替换弄丢：抢回来', () => {
    expect(
      planTriggerHandoff(
        { placeholder: true, focused: true, hovered: false },
        { focusLoose: true, pointerInside: false }
      )
    ).toEqual({ focus: true, hover: false });
  });

  test('焦点已被用户移到别处：不抢', () => {
    expect(
      planTriggerHandoff(
        { placeholder: true, focused: true, hovered: false },
        { focusLoose: false, pointerInside: false }
      )
    ).toEqual({ focus: false, hover: false });
  });

  test('占位记录到 hover：补发悬停', () => {
    expect(
      planTriggerHandoff(
        { placeholder: true, focused: false, hovered: true },
        { focusLoose: true, pointerInside: false }
      ).hover
    ).toBe(true);
  });

  test('指针此刻仍停在新节点上：即使没记录到也补发', () => {
    expect(
      planTriggerHandoff(
        { placeholder: true, focused: false, hovered: false },
        { focusLoose: true, pointerInside: true }
      ).hover
    ).toBe(true);
  });

  test('既没记录也没停留：不补', () => {
    expect(
      planTriggerHandoff(
        { placeholder: true, focused: false, hovered: false },
        { focusLoose: true, pointerInside: false }
      )
    ).toEqual({ focus: false, hover: false });
  });
});

describe('applyTriggerHandoff', () => {
  function spyEffects() {
    const calls: string[] = [];
    const tasks: Array<() => void> = [];
    const effects: TriggerHandoffEffects = {
      focus: () => calls.push('focus'),
      replayHover: () => calls.push('hover'),
      schedule: (task) => {
        tasks.push(task);
      },
    };
    return { calls, tasks, effects };
  }

  const connected = { isConnected: true } as HTMLElement;

  test('focus 同步执行（在 ref 回调里，早于绘制）', () => {
    const { calls, effects } = spyEffects();
    applyTriggerHandoff(connected, { focus: true, hover: false }, effects);
    expect(calls).toEqual(['focus']);
  });

  test('hover 补发推迟到下一帧', () => {
    const { calls, tasks, effects } = spyEffects();
    applyTriggerHandoff(connected, { focus: false, hover: true }, effects);

    expect(calls).toEqual([]);
    for (const task of tasks) task();
    expect(calls).toEqual(['hover']);
  });

  test('节点已经离开文档时不再补发', () => {
    const { calls, tasks, effects } = spyEffects();
    applyTriggerHandoff(
      { isConnected: false } as HTMLElement,
      { focus: false, hover: true },
      effects
    );
    for (const task of tasks) task();
    expect(calls).toEqual([]);
  });

  test('什么都不用补时不排任何任务', () => {
    const { tasks, effects } = spyEffects();
    applyTriggerHandoff(connected, { focus: false, hover: false }, effects);
    expect(tasks).toHaveLength(0);
  });
});

describe('OverlayTrigger 占位', () => {
  const html = (element: React.ReactElement) => renderToStaticMarkup(element);

  test('闭合态与实现侧同标签同 data-slot 同 className', () => {
    const markup = html(
      <OverlayTrigger
        slot="tooltip-trigger"
        semantics={TOOLTIP_TRIGGER_SEMANTICS}
        handoff={fakeHandoff()}
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
        semantics={TOOLTIP_TRIGGER_SEMANTICS}
        handoff={fakeHandoff()}
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
        semantics={MENU_TRIGGER_SEMANTICS}
        handoff={fakeHandoff()}
        props={{ children: '更多' }}
        onActivate={() => undefined}
        onOpen={() => undefined}
      />
    );

    expect(markup.startsWith('<button')).toBe(true);
    expect(markup).toContain('data-slot="dropdown-menu-trigger"');
  });

  test('补齐 base-ui 在客户端注入的触发器语义', () => {
    const dialog = html(
      <OverlayTrigger
        slot="dialog-trigger"
        semantics={DIALOG_TRIGGER_SEMANTICS}
        handoff={fakeHandoff('dlg-1')}
        props={{ children: '打开' }}
        onActivate={() => undefined}
        onOpen={() => undefined}
      />
    );

    expect(dialog).toContain('aria-haspopup="dialog"');
    expect(dialog).toContain('aria-expanded="false"');
    expect(dialog).toContain('tabindex="0"');
    expect(dialog).toContain('id="dlg-1"');

    const menu = html(
      <OverlayTrigger
        slot="dropdown-menu-trigger"
        semantics={MENU_TRIGGER_SEMANTICS}
        handoff={fakeHandoff()}
        props={{ children: '更多' }}
        onActivate={() => undefined}
        onOpen={() => undefined}
      />
    );

    expect(menu).toContain('aria-haspopup="menu"');
  });

  test('tooltip 触发器没有 popup 语义，也不走 useButton 的 tabIndex', () => {
    const markup = html(
      <OverlayTrigger
        slot="tooltip-trigger"
        semantics={TOOLTIP_TRIGGER_SEMANTICS}
        handoff={fakeHandoff()}
        props={{ children: '书房' }}
        onActivate={() => undefined}
      />
    );

    expect(markup).not.toContain('aria-haspopup');
    expect(markup).not.toContain('tabindex');
  });

  test('nativeButton=false / disabled 与实现侧对齐', () => {
    const markup = html(
      <OverlayTrigger
        slot="dialog-trigger"
        semantics={DIALOG_TRIGGER_SEMANTICS}
        handoff={fakeHandoff()}
        render={<div />}
        props={{ nativeButton: false, disabled: true, children: '打开' }}
        onActivate={() => undefined}
        onOpen={() => undefined}
      />
    );

    expect(markup).toContain('role="button"');
    expect(markup).toContain('data-disabled=""');
  });

  test('dialog / sheet / alert-dialog 只认 Enter 与 Space', () => {
    let opens = 0;
    const captured = captureTriggerProps((capture) => (
      <OverlayTrigger
        slot="dialog-trigger"
        semantics={DIALOG_TRIGGER_SEMANTICS}
        handoff={fakeHandoff()}
        render={(props: Record<string, unknown>) => {
          capture(props);
          return <button type="button" />;
        }}
        props={{}}
        onActivate={() => undefined}
        onOpen={() => {
          opens += 1;
        }}
      />
    ));
    const onKeyDown = captured.onKeyDown as (event: { key: string }) => void;

    onKeyDown({ key: 'ArrowDown' });
    onKeyDown({ key: 'ArrowUp' });
    expect(opens).toBe(0);

    onKeyDown({ key: 'Enter' });
    onKeyDown({ key: ' ' });
    expect(opens).toBe(2);
  });

  test('menu 触发器额外接受上下方向键', () => {
    let opens = 0;
    const captured = captureTriggerProps((capture) => (
      <OverlayTrigger
        slot="dropdown-menu-trigger"
        semantics={MENU_TRIGGER_SEMANTICS}
        handoff={fakeHandoff()}
        render={(props: Record<string, unknown>) => {
          capture(props);
          return <button type="button" />;
        }}
        props={{}}
        onActivate={() => undefined}
        onOpen={() => {
          opens += 1;
        }}
      />
    ));
    const onKeyDown = captured.onKeyDown as (event: { key: string }) => void;

    onKeyDown({ key: 'ArrowDown' });
    onKeyDown({ key: 'ArrowUp' });
    onKeyDown({ key: 'Enter' });
    expect(opens).toBe(3);

    onKeyDown({ key: 'Escape' });
    expect(opens).toBe(3);
  });

  test('调用方自己的 keydown 仍会收到事件', () => {
    const seen: string[] = [];
    const captured = captureTriggerProps((capture) => (
      <OverlayTrigger
        slot="dialog-trigger"
        semantics={DIALOG_TRIGGER_SEMANTICS}
        handoff={fakeHandoff()}
        render={(props: Record<string, unknown>) => {
          capture(props);
          return <button type="button" />;
        }}
        props={{ onKeyDown: (event: { key: string }) => seen.push(event.key) }}
        onActivate={() => undefined}
        onOpen={() => undefined}
      />
    ));
    (captured.onKeyDown as (event: { key: string }) => void)({ key: 'Escape' });

    expect(seen).toEqual(['Escape']);
  });

  test('占位记录焦点与悬停，并把事件透传给调用方', () => {
    const handoff = fakeHandoff();
    const seen: string[] = [];
    const captured = captureTriggerProps((capture) => (
      <OverlayTrigger
        slot="dialog-trigger"
        semantics={DIALOG_TRIGGER_SEMANTICS}
        handoff={handoff}
        render={(props: Record<string, unknown>) => {
          capture(props);
          return <button type="button" />;
        }}
        props={{
          onFocus: () => seen.push('focus'),
          onPointerEnter: () => seen.push('enter'),
        }}
        onActivate={() => undefined}
        onOpen={() => undefined}
      />
    ));
    const call = (name: string) => (captured[name] as (event: unknown) => void)({});

    expect(handoff.activity.placeholder).toBe(true);

    call('onFocus');
    call('onPointerEnter');
    expect(handoff.activity).toEqual({ placeholder: true, focused: true, hovered: true });
    expect(seen).toEqual(['focus', 'enter']);

    call('onBlur');
    call('onPointerLeave');
    expect(handoff.activity).toEqual({ placeholder: true, focused: false, hovered: false });
  });
});
