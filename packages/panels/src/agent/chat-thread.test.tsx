// bun test 无 DOM，行重渲染数按 React.memo 的默认浅比较语义推算（type 相同 + props 浅相等即跳过）。

import { describe, expect, test } from 'bun:test';
import type { AgentMessageDto } from '@tmex/shared';
import { I18N_RESOURCES } from '@tmex/shared';
import type { SessionInProgress } from '@tmex/stores';
import i18next from 'i18next';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { buildBlocksWithConfirmations } from './agent-thread-blocks';
import {
  CHAT_ROW_SKIP_RENDER_THRESHOLD,
  ChatThread,
  bottomAnchor,
  createScrollCoalescer,
  isPinnedToBottom,
  restoreBottomAnchor,
  stickToBottom,
  threadRows,
  windowStartIndex,
} from './chat-thread';

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const NO_CONFIRMATIONS = new Map<string, string>();
const onDecide = (): void => undefined;

function history(count: number): AgentMessageDto[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    sessionId: 's1',
    seq: i,
    role: 'user',
    content: { role: 'user', content: `question ${i}` },
    createdAt: '2026-01-01T00:00:00.000Z',
  })) as AgentMessageDto[];
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.is(a[key], b[key]));
}

/** React.memo 语义下会真正重渲染的行数：新增的行，或 type/props 变了的行 */
function rerenderCount(prev: ReactElement[], next: ReactElement[]): number {
  const before = new Map(prev.map((row) => [row.key, row]));
  let count = 0;
  for (const row of next) {
    const old = before.get(row.key);
    if (
      !old ||
      old.type !== row.type ||
      !shallowEqual(old.props as Record<string, unknown>, row.props as Record<string, unknown>)
    ) {
      count++;
    }
  }
  return count;
}

describe('threadRows', () => {
  test('rows are memo components keyed by block id', () => {
    const rows = threadRows(
      buildBlocksWithConfirmations(history(3), undefined, undefined),
      NO_CONFIRMATIONS,
      onDecide
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.key)).toEqual(['m0', 'm1', 'm2']);
    for (const row of rows) {
      expect((row.type as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
    }
  });

  test('streaming 50 deltas re-renders only the tail row', () => {
    const messages = history(2000);
    let text = '';
    const flush = (): ReactElement[] => {
      text += 'token ';
      const inProgress: SessionInProgress = {
        texts: [{ messageId: 'live', text, stale: false }],
        reasonings: [],
        toolCalls: [],
        staleBarrier: false,
      };
      return threadRows(
        buildBlocksWithConfirmations(messages, inProgress, undefined),
        NO_CONFIRMATIONS,
        onDecide
      );
    };

    let prev = flush();
    let total = 0;
    for (let i = 0; i < 50; i++) {
      const next = flush();
      total += rerenderCount(prev, next);
      prev = next;
    }
    expect(prev).toHaveLength(2001);
    expect(total).toBe(50);
  });
});

describe('ChatThread', () => {
  function render(blocks: number): string {
    return renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ChatThread
          blocks={buildBlocksWithConfirmations(history(blocks), undefined, undefined)}
          running={false}
          emptyText="empty"
          confirmationByToolCallId={NO_CONFIRMATIONS}
          onDecide={onDecide}
        />
      </I18nextProvider>
    );
  }

  function count(html: string, testid: string): number {
    return html.split(`data-testid="${testid}"`).length - 1;
  }

  test('renders the whole thread when it fits in the window', () => {
    const html = render(10);
    expect(count(html, 'agent-user-message')).toBe(10);
    expect(count(html, 'agent-show-earlier')).toBe(0);
  });

  test('renders only the last 200 blocks and offers to show earlier ones', () => {
    const html = render(500);
    expect(count(html, 'agent-user-message')).toBe(200);
    expect(count(html, 'agent-show-earlier')).toBe(1);
    expect(html).toContain('显示更早的 300 条消息');
    expect(html).toContain('question 300');
    expect(html).not.toContain('question 299');
  });
});

describe('windowStartIndex', () => {
  test('吸底时跟着最新的窗口走，上滚冻结后起点不动', () => {
    expect(windowStartIndex(500, 200, null)).toBe(300);
    expect(windowStartIndex(700, 200, null)).toBe(500);
    // 用户在 500 条时上滚，起点冻在 300；再来 200 条也还是 300
    expect(windowStartIndex(500, 200, 300)).toBe(300);
    expect(windowStartIndex(700, 200, 300)).toBe(300);
    // 「显示更早」在冻结态下往前挪一个步长
    expect(windowStartIndex(700, 200, 100)).toBe(100);
    // 会话切换导致块数缩水时起点被夹回去
    expect(windowStartIndex(10, 200, 300)).toBe(9);
    expect(windowStartIndex(0, 200, 300)).toBe(0);
    expect(windowStartIndex(120, 200, null)).toBe(0);
  });
});

describe('isPinnedToBottom', () => {
  test('stays pinned within the threshold and unpins once scrolled up', () => {
    expect(isPinnedToBottom({ scrollHeight: 1000, scrollTop: 953, clientHeight: 0 })).toBe(true);
    expect(isPinnedToBottom({ scrollHeight: 1000, scrollTop: 900, clientHeight: 53 })).toBe(true);
    expect(isPinnedToBottom({ scrollHeight: 1000, scrollTop: 800, clientHeight: 100 })).toBe(false);
  });
});

/** 手控的帧调度：`run()` 走一帧，用来断言合帧确实只测一次。 */
function fakeFrames() {
  const queue = new Map<number, () => void>();
  let next = 1;
  return {
    host: {
      requestAnimationFrame: (callback: () => void) => {
        const handle = next++;
        queue.set(handle, callback);
        return handle;
      },
      cancelAnimationFrame: (handle: number) => void queue.delete(handle),
    },
    pending: () => queue.size,
    run: () => {
      const callbacks = [...queue.values()];
      queue.clear();
      for (const callback of callbacks) callback();
    },
  };
}

describe('createScrollCoalescer', () => {
  test('一帧里来多少次 scroll 都只测量一次', () => {
    const frames = fakeFrames();
    let measured = 0;
    const coalescer = createScrollCoalescer(() => {
      measured += 1;
    }, frames.host);

    for (let i = 0; i < 12; i++) coalescer.onScroll();
    expect(measured).toBe(0);
    expect(frames.pending()).toBe(1);

    frames.run();
    expect(measured).toBe(1);

    // 下一帧再滚，还能再测一次
    coalescer.onScroll();
    frames.run();
    expect(measured).toBe(2);
  });

  test('flush 立刻结算压着的那次测量，并且不会重复测', () => {
    const frames = fakeFrames();
    let measured = 0;
    const coalescer = createScrollCoalescer(() => {
      measured += 1;
    }, frames.host);

    coalescer.onScroll();
    coalescer.flush();
    expect(measured).toBe(1);
    frames.run();
    expect(measured).toBe(1);

    // 没有压着的测量时 flush 是空操作
    coalescer.flush();
    expect(measured).toBe(1);
  });

  test('dispose 之后压着的那一帧不再测量', () => {
    const frames = fakeFrames();
    let measured = 0;
    const coalescer = createScrollCoalescer(() => {
      measured += 1;
    }, frames.host);

    coalescer.onScroll();
    coalescer.dispose();
    frames.run();
    expect(measured).toBe(0);
  });
});

describe('吸底与锚点回写', () => {
  test('流式追加内容后吸底仍然贴着底部', () => {
    const el = { scrollHeight: 1000, scrollTop: 1000, clientHeight: 400 };
    expect(isPinnedToBottom(el)).toBe(true);

    // 追加一段流式文本：内容变高，吸底把 scrollTop 补上去
    el.scrollHeight = 1240;
    stickToBottom(el);
    expect(el.scrollTop).toBe(1240);
    expect(isPinnedToBottom(el)).toBe(true);
  });

  test('用户上滚后不再吸底（超过 48px 阈值）', () => {
    const el = { scrollHeight: 1000, scrollTop: 500, clientHeight: 400 };
    expect(isPinnedToBottom(el)).toBe(false);
  });

  test('显示更早：视口按高度增量原地钉住', () => {
    const el = { scrollHeight: 2000, scrollTop: 1200 };
    const anchor = bottomAnchor(el);
    expect(anchor).toBe(800);

    // 往前补 200 条，内容整体长高 5000px
    el.scrollHeight = 7000;
    restoreBottomAnchor(el, anchor);
    // scrollTop 恰好按高度增量上移，视口里看到的还是原来那一段
    expect(el.scrollTop).toBe(1200 + 5000);
    expect(bottomAnchor(el)).toBe(anchor);
  });
});

describe('行级 content-visibility', () => {
  function renderRows(blocks: number): string {
    return renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ChatThread
          blocks={buildBlocksWithConfirmations(history(blocks), undefined, undefined)}
          running={false}
          emptyText="empty"
          confirmationByToolCallId={NO_CONFIRMATIONS}
          onDecide={onDecide}
        />
      </I18nextProvider>
    );
  }

  test('长会话给每个块的外层加跳渲样式', () => {
    const rows = CHAT_ROW_SKIP_RENDER_THRESHOLD + 5;
    const html = renderRows(rows);
    expect(html.split('content-visibility:auto').length - 1).toBe(rows);
    expect(html).toContain('contain-intrinsic-size:auto 64px');
  });

  test('短会话不加', () => {
    const html = renderRows(CHAT_ROW_SKIP_RENDER_THRESHOLD);
    expect(html).not.toContain('content-visibility:auto');
  });

  test('外层包一层 flex 列，块自己的 self-end 对齐不受影响', () => {
    const html = renderRows(1);
    expect(html).toContain('<div class="flex flex-col">');
    expect(html).toContain('self-end');
  });
});
