// 回放终端适配层：把共享 ReadOnlyTerminal 的 handle / 生命周期接到播放机合同上。
// mock.module 是进程级的，本文件由仓库测试编排单独进程跑。

import { describe, expect, mock, test } from 'bun:test';
import type { ReadOnlyTerminalHandle, ReadOnlyTerminalProps } from '@vibeterm/terminal-ui';
import { type ReactElement, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as ReactI18nRuntime from 'react-i18next';

let latestProps: ReadOnlyTerminalProps | null = null;

mock.module('react-i18next', () => ({
  ...ReactI18nRuntime,
  useTranslation: () => ({ t: (key: string) => key, i18n: {}, ready: true }),
}));

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
    resize(cols, rows) {
      calls.push(`resize:${cols}x${rows}`);
    },
    reset() {
      calls.push('reset');
    },
    fit() {
      calls.push('fit');
    },
    scrollToOrigin() {
      calls.push('origin');
    },
  };
}

function mountHook(): { state: ReplayTerminalState; html: string } {
  latestProps = null;
  const slot: { state: ReplayTerminalState | null } = { state: null };
  function Probe() {
    slot.state = useReplayTerminal();
    return slot.state.widget;
  }
  const html = renderToStaticMarkup(<Probe />);
  if (!slot.state) throw new Error('probe did not render');
  return { state: slot.state, html };
}

describe('createReplayTerminalBinding', () => {
  test('未就绪时 write/resize/reset/fit 都是空操作', () => {
    const ready: boolean[] = [];
    const binding = createReplayTerminalBinding((next) => ready.push(next));
    const widget = fakeHandle();
    binding.handle.write(new Uint8Array([1]));
    binding.handle.resize(80, 24);
    binding.handle.reset();
    binding.handle.fit();
    expect(widget.calls).toEqual([]);
    expect(ready).toEqual([]);
  });

  test('onReady 之后转发四件事，onDispose 再变回空操作', () => {
    const ready: boolean[] = [];
    const binding = createReplayTerminalBinding((next) => ready.push(next));
    const widget = fakeHandle();
    binding.onReady(widget);
    expect(ready).toEqual([true]);
    binding.handle.write(new Uint8Array([65, 66]));
    binding.handle.resize(120, 40);
    binding.handle.reset();
    binding.handle.fit();
    expect(widget.calls).toEqual(['write:65,66', 'resize:120x40', 'reset', 'fit']);
    binding.onDispose();
    expect(ready).toEqual([true, false]);
    widget.calls.length = 0;
    binding.handle.write(new Uint8Array([9]));
    binding.handle.resize(1, 1);
    binding.handle.reset();
    binding.handle.fit();
    expect(widget.calls).toEqual([]);
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
    const { html, state } = mountHook();
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
  });

  test('把 widget 的 onReady/onDispose 接到 handle 转发', () => {
    const { state } = mountHook();
    const widget = fakeHandle();
    state.handle.write(new Uint8Array([1]));
    expect(widget.calls).toEqual([]);
    latestProps?.onReady?.(widget);
    state.handle.write(new Uint8Array([7]));
    state.handle.resize(200, 60);
    state.handle.reset();
    state.handle.fit();
    expect(widget.calls).toEqual(['write:7', 'resize:200x60', 'reset', 'fit']);
    latestProps?.onDispose?.();
    widget.calls.length = 0;
    state.handle.write(new Uint8Array([8]));
    expect(widget.calls).toEqual([]);
  });
});
