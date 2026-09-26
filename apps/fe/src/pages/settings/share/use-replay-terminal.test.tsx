// 回放终端适配层：把共享 ReadOnlyTerminal 的 handle / 生命周期接到播放机合同上。
// mock.module 是进程级的，本文件由仓库测试编排单独进程跑。

import { describe, expect, mock, test } from 'bun:test';
import type { ReadOnlyTerminalHandle, ReadOnlyTerminalProps } from '@vibeterm/terminal-ui';
import i18next from 'i18next';
import { type ReactElement, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';

let latestProps: ReadOnlyTerminalProps | null = null;

// 独立空实例注入而不 mock react-i18next：进程级 mock 会泄漏给同进程后续文件。
const i18n = i18next.createInstance();
await i18n.init({ lng: 'en_US', resources: {}, react: { useSuspense: false } });

mock.module('@vibeterm/terminal-ui', () => ({
  ReadOnlyTerminal: (props: ReadOnlyTerminalProps) => {
    latestProps = props;
    return createElement('div', { 'data-testid': props.testId });
  },
}));

const { createReplayTerminalBinding, useReplayTerminal } = await import('./use-replay-terminal');
type ReplayTerminalState = ReturnType<typeof useReplayTerminal>;

function fakeHandle(): ReadOnlyTerminalHandle & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    write(data) {
      calls.push(`write:${typeof data === 'string' ? data : Array.from(data).join(',')}`);
    },
    writeCheckpoint(data, grid) {
      calls.push(
        `ckpt:${grid.cols}x${grid.rows}:${typeof data === 'string' ? data : Array.from(data).join(',')}`
      );
    },
    reset() {
      calls.push('reset');
    },
  };
}

function mountHook(
  fontSize: number | null,
  minGrid: { cols: number; rows: number } | null = null
): { state: ReplayTerminalState; html: string } {
  latestProps = null;
  const slot: { state: ReplayTerminalState | null } = { state: null };
  function Probe() {
    slot.state = useReplayTerminal(fontSize, minGrid);
    return slot.state.widget;
  }
  const html = renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <Probe />
    </I18nextProvider>
  );
  if (!slot.state) throw new Error('probe did not render');
  return { state: slot.state, html };
}

describe('createReplayTerminalBinding', () => {
  test('未就绪时 write/reset 都是空操作', () => {
    const ready: boolean[] = [];
    const binding = createReplayTerminalBinding((next) => ready.push(next));
    const widget = fakeHandle();
    binding.handle.write(new Uint8Array([1]));
    binding.handle.reset();
    expect(widget.calls).toEqual([]);
    expect(ready).toEqual([]);
  });

  test('onReady 之后转发写入与清屏，onDispose 再变回空操作', () => {
    const ready: boolean[] = [];
    const binding = createReplayTerminalBinding((next) => ready.push(next));
    const widget = fakeHandle();
    binding.onReady(widget);
    expect(ready).toEqual([true]);
    binding.handle.write(new Uint8Array([65, 66]));
    binding.handle.reset();
    expect(widget.calls).toEqual(['write:65,66', 'reset']);
    binding.onDispose();
    expect(ready).toEqual([true, false]);
    widget.calls.length = 0;
    binding.handle.write(new Uint8Array([9]));
    binding.handle.reset();
    expect(widget.calls).toEqual([]);
  });

  // 网格变了也要清屏重放：ghostty 在 resize 时会 reflow，TUI 画面不重放会留残渣。
  test('就绪与网格变化各上报一次新画面，未就绪时网格变化不上报', () => {
    const frames: string[] = [];
    const binding = createReplayTerminalBinding(
      () => undefined,
      () => frames.push('frame')
    );
    binding.onGridChange();
    expect(frames).toEqual([]);
    binding.onReady(fakeHandle());
    expect(frames).toEqual(['frame']);
    binding.onGridChange();
    expect(frames).toEqual(['frame', 'frame']);
    binding.onDispose();
    binding.onGridChange();
    expect(frames).toEqual(['frame', 'frame']);
  });

  test('空 write 不往 widget 送', () => {
    const binding = createReplayTerminalBinding(() => undefined);
    const widget = fakeHandle();
    binding.onReady(widget);
    binding.handle.write(new Uint8Array());
    expect(widget.calls).toEqual([]);
  });
});

describe('useReplayTerminal', () => {
  test('渲染带平移和选区的共享 widget，testid 打在根上', () => {
    const { html, state } = mountHook(13);
    expect(html).toContain('data-testid="share-replay-mount"');
    expect(latestProps?.viewportPan).toBe(true);
    expect(latestProps?.selection).toBe(true);
    expect(latestProps?.testId).toBe('share-replay-mount');
    expect(typeof latestProps?.ariaLabel).toBe('string');
    expect(latestProps?.ariaLabel).toBeTruthy();
    const widget = state.widget as ReactElement<ReadOnlyTerminalProps>;
    expect(widget.props.viewportPan).toBe(true);
    expect(widget.props.selection).toBe(true);
    expect(widget.props.testId).toBe('share-replay-mount');
    expect(state.ready).toBe(false);
    expect(state.booted).toBe(false);
    expect(state.generation).toBe(0);
    expect(latestProps?.fontSize).toBe(13);
  });

  test('自适应字号与录像包络透传给 widget', () => {
    const { state } = mountHook(21, { cols: 52, rows: 47 });
    expect(latestProps?.fontSize).toBe(21);
    expect(latestProps?.minGrid).toEqual({ cols: 52, rows: 47 });
    expect(typeof latestProps?.onGridChange).toBe('function');
    const widget = state.widget as ReactElement<ReadOnlyTerminalProps>;
    expect(widget.props.fontSize).toBe(21);
    expect(widget.props.minGrid).toEqual({ cols: 52, rows: 47 });
  });

  // 字号没定下来就开面的话，那一台必然要被适配后的替换掉：画面跳一下，选区也没了。
  test('字号为 null 时根本不挂 widget', () => {
    const { state, html } = mountHook(null);
    expect(state.widget).toBeNull();
    expect(html).toBe('');
    expect(latestProps).toBeNull();
  });

  test('把 widget 的 onReady/onDispose 接到 handle 转发', () => {
    const { state } = mountHook(13);
    const widget = fakeHandle();
    state.handle.write(new Uint8Array([1]));
    expect(widget.calls).toEqual([]);
    latestProps?.onReady?.(widget);
    state.handle.write(new Uint8Array([7]));
    state.handle.reset();
    expect(widget.calls).toEqual(['write:7', 'reset']);
    latestProps?.onDispose?.();
    widget.calls.length = 0;
    state.handle.write(new Uint8Array([8]));
    expect(widget.calls).toEqual([]);
  });
});
