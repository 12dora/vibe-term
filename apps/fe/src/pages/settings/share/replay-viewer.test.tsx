// 回放窗静态结构：22rem 外框裁剪，内部是带平移和选区的共享只读终端。
// 无 DOM 测试环境：框组件无 hook，按 share-tables 的做法当函数调用再走元素树；
// 整页正文走 react-dom/server。`t` 单跑/合跑不一致，不断言译文字符串。

import { describe, expect, test } from 'bun:test';
import { createAppRuntime } from '@vibeterm/stores';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import { Children, type ReactElement, type ReactNode, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

installWindowStorage();

const { RuntimeProvider } = await import('@vibeterm/stores/react');
const { ReplayBody, ReplayTerminalFrame } = await import('./replay-viewer');
const { useReplayTerminal } = await import('./use-replay-terminal');

function findByTestId(node: ReactNode, testId: string): ReactElement | null {
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<{
    children?: ReactNode;
    testId?: string;
    'data-testid'?: string;
  }>;
  if (element.props.testId === testId || element.props['data-testid'] === testId) return element;
  for (const child of Children.toArray(element.props.children)) {
    const found = findByTestId(child, testId);
    if (found) return found;
  }
  return null;
}

function hookWidget(): ReactElement {
  let widget: ReactElement | null = null;
  function Probe() {
    widget = useReplayTerminal().widget;
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (!widget) throw new Error('probe did not render');
  return widget;
}

describe('ReplayTerminalFrame', () => {
  test('外框 22rem overflow-hidden，挂上平移+选区的 widget', () => {
    const widget = hookWidget();
    const frame = ReplayTerminalFrame({
      children: widget,
      loading: true,
      empty: false,
      loadingLabel: 'loading',
      emptyLabel: 'empty',
    });
    expect(frame.props.className).toContain('h-[22rem]');
    expect(frame.props.className).toContain('overflow-hidden');
    expect(frame.props.style).toBeUndefined();
    const mount = findByTestId(frame, 'share-replay-mount');
    expect(mount).not.toBeNull();
    const props = mount?.props as {
      viewportPan?: boolean;
      selection?: boolean;
      testId?: string;
    };
    expect(props.viewportPan).toBe(true);
    expect(props.selection).toBe(true);
    expect(props.testId).toBe('share-replay-mount');

    const runtime = createAppRuntime({
      nodeId: 'self',
      storagePrefix: `share-replay-frame-${Date.now()}:`,
    });
    const html = renderToStaticMarkup(<RuntimeProvider runtime={runtime}>{frame}</RuntimeProvider>);
    expect(html).toContain('h-[22rem]');
    expect(html).toContain('overflow-hidden');
    expect(html).toContain('data-testid="share-replay-mount"');
    expect(html).not.toContain('touch-action');
    runtime.dispose();
  });
});

describe('ReplayBody', () => {
  test('正文带 share-replay-body，框里是共享 widget', () => {
    const runtime = createAppRuntime({
      nodeId: 'self',
      storagePrefix: `share-replay-viewer-${Date.now()}:`,
    });
    const html = renderToStaticMarkup(
      <RuntimeProvider runtime={runtime}>
        <ReplayBody shareId="sh1" />
      </RuntimeProvider>
    );
    expect(html).toContain('data-testid="share-replay-body"');
    expect(html).toContain('data-testid="share-replay-mount"');
    expect(html).toContain('h-[22rem]');
    expect(html).toContain('overflow-hidden');
    expect(html).toContain('data-testid="share-replay-controls"');
    runtime.dispose();
  });
});
