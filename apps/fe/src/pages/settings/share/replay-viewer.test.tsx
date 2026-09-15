// 回放窗静态结构：外框裁剪（窄屏 22rem、宽屏 44rem 且按视口封顶），内部是带平移和选区的共享只读终端。
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
    widget = useReplayTerminal(13, { cols: 52, rows: 47 }).widget;
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (!widget) throw new Error('probe did not render');
  return widget;
}

describe('ReplayTerminalFrame', () => {
  test('外框高度跟着视口走，挂上平移+选区的 widget', () => {
    const widget = hookWidget();
    const frame = ReplayTerminalFrame({
      children: widget,
      loading: true,
      empty: false,
      loadingLabel: 'loading',
      emptyLabel: 'empty',
    });
    // 高度由视口决定：标题 + 控制条 + 输入条留够位置，窄屏保底 18rem。
    expect(frame.props.className).toContain('h-[max(18rem,calc(100dvh-17rem))]');
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
    expect(html).toContain('h-[max(18rem,calc(100dvh-17rem))]');
    expect(html).toContain('overflow-hidden');
    expect(html).toContain('data-testid="share-replay-mount"');
    expect(html).not.toContain('touch-action');
    runtime.dispose();
  });
});

describe('ReplayBody', () => {
  // 首帧还没量到外框、也没拿到录像网格：这时开面的那一台必然要被适配后的替换掉，
  // 所以终端先不挂，遮罩一直盖着。
  test('外框与网格都没齐时不挂终端，遮罩仍盖着', () => {
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
    expect(html).not.toContain('data-testid="share-replay-mount"');
    expect(html).toContain('animate-spin');
    expect(html).toContain('h-[max(18rem,calc(100dvh-17rem))]');
    expect(html).toContain('overflow-hidden');
    expect(html).toContain('data-testid="share-replay-controls"');
    runtime.dispose();
  });
});
