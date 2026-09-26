// 「连接设备...」遮罩的期限：到期前只有一行，到期后补上现状与「重新连接」。
// bun test 无 DOM，用 react-dom/server 静态渲染；期限用 `deadlineMs=0` 表达「已到期」。

import { describe, expect, test } from 'bun:test';
import { I18N_RESOURCES } from '@vibeterm/shared';
import { createAppRuntime } from '@vibeterm/stores';
import { RuntimeProvider } from '@vibeterm/stores/react';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import i18next from 'i18next';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import {
  CONNECTING_OVERLAY_DEADLINE_MS,
  ConnectingOverlay,
  connectingStalledKey,
} from './terminal-stage-overlays';

installWindowStorage();

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

let storageSeq = 0;

function render(element: ReactElement): string {
  const runtime = createAppRuntime({
    nodeId: 'self',
    storagePrefix: `connecting-overlay-test-${storageSeq++}:`,
  });
  const html = renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <RuntimeProvider runtime={runtime}>{element}</RuntimeProvider>
    </I18nextProvider>
  );
  runtime.dispose();
  return html;
}

describe('ConnectingOverlay', () => {
  test('期限未到：只显示「连接设备...」，没有重试入口', () => {
    const html = render(<ConnectingOverlay />);
    expect(html).toContain('data-testid="terminal-connecting-overlay"');
    expect(html).toContain('连接设备...');
    expect(html).not.toContain('data-testid="terminal-connecting-stalled"');
    expect(CONNECTING_OVERLAY_DEADLINE_MS).toBe(8_000);
  });

  test('期限已过：补一行现状，并给可点的「重新连接」', () => {
    const html = render(<ConnectingOverlay deadlineMs={0} />);
    expect(html).toContain('连接设备...');
    expect(html).toContain('data-testid="terminal-connecting-stalled"');
    expect(html).toContain('仍在连接节点，链路较慢或暂时不通。');
    expect(html).toContain('data-testid="terminal-connecting-retry"');
    expect(html).toContain('重新连接');
    expect(html).toContain('pointer-events-auto');
  });
});

describe('connectingStalledKey', () => {
  test('按节点 WS 状态区分三种说法', () => {
    expect(connectingStalledKey('WS_CONNECTING')).toBe('terminal.connectingStalled.node');
    expect(connectingStalledKey('HELLO_NEGOTIATING')).toBe('terminal.connectingStalled.node');
    expect(connectingStalledKey('IDLE')).toBe('terminal.connectingStalled.node');
    expect(connectingStalledKey('RECONNECT_BACKOFF')).toBe(
      'terminal.connectingStalled.reconnecting'
    );
    expect(connectingStalledKey('CLOSED')).toBe('terminal.connectingStalled.reconnecting');
    expect(connectingStalledKey('READY')).toBe('terminal.connectingStalled.device');
  });

  test('上一次被入口以「到不了该节点」的 1011 关掉：明说入口连接不了该节点；READY 后回到常规说法', () => {
    expect(connectingStalledKey('RECONNECT_BACKOFF', 1011, 'failover-exhausted')).toBe(
      'terminal.connectingStalled.unreachable'
    );
    expect(connectingStalledKey('WS_CONNECTING', 1011, 'node-unreachable')).toBe(
      'terminal.connectingStalled.unreachable'
    );
    expect(connectingStalledKey('RECONNECT_BACKOFF', 1006, null)).toBe(
      'terminal.connectingStalled.reconnecting'
    );
    expect(connectingStalledKey('READY', 1011, 'node-unreachable')).toBe(
      'terminal.connectingStalled.device'
    );
  });

  test('浏览器这侧的 1011（转发队列溢出、写不进去）不说成入口到不了节点', () => {
    expect(connectingStalledKey('RECONNECT_BACKOFF', 1011, 'forward-queue-overflow')).toBe(
      'terminal.connectingStalled.reconnecting'
    );
    expect(connectingStalledKey('RECONNECT_BACKOFF', 1011, 'forward-ws-closed')).toBe(
      'terminal.connectingStalled.reconnecting'
    );
    expect(connectingStalledKey('WS_CONNECTING', 1011, null)).toBe(
      'terminal.connectingStalled.node'
    );
  });
});
