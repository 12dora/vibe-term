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
import { ChatThread, isPinnedToBottom, threadRows } from './chat-thread';

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

describe('isPinnedToBottom', () => {
  test('stays pinned within the threshold and unpins once scrolled up', () => {
    expect(isPinnedToBottom({ scrollHeight: 1000, scrollTop: 953, clientHeight: 0 })).toBe(true);
    expect(isPinnedToBottom({ scrollHeight: 1000, scrollTop: 900, clientHeight: 53 })).toBe(true);
    expect(isPinnedToBottom({ scrollHeight: 1000, scrollTop: 800, clientHeight: 100 })).toBe(false);
  });
});
