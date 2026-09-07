// 主密钥失配提示：`/healthz.degraded` 的判读与提示版式。
// 无 DOM 测试环境，用 react-dom/server 静态渲染；自带 effect 的壳在静态渲染下永远为空，
// 所以版式测的是不带请求的 `MasterKeyMismatchNotice`。

import { describe, expect, test } from 'bun:test';
import zhCN from '@vibeterm/shared/i18n/locales/zh_CN.json';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MASTER_KEY_MISMATCH,
  MESH_RESET_IDENTITY_COMMAND,
  MasterKeyMismatchNotice,
  fetchDegraded,
  readDegraded,
} from './master-key-notice';

function healthz(body: unknown, init: ResponseInit = {}): typeof fetch {
  return (() => Promise.resolve(Response.json(body, init))) as unknown as typeof fetch;
}

describe('readDegraded', () => {
  test('拿到降级标记原样返回', () => {
    expect(readDegraded({ status: 'ok', degraded: MASTER_KEY_MISMATCH })).toBe(MASTER_KEY_MISMATCH);
  });

  test('旧网关不下发该字段、或字段为空串时按「没有降级」处理', () => {
    expect(readDegraded({ status: 'ok' })).toBeNull();
    expect(readDegraded({ status: 'ok', degraded: '' })).toBeNull();
    expect(readDegraded({ status: 'ok', degraded: null })).toBeNull();
    expect(readDegraded(null)).toBeNull();
    expect(readDegraded('ok')).toBeNull();
  });
});

describe('fetchDegraded', () => {
  test('读到标记就返回', async () => {
    expect(await fetchDegraded(healthz({ status: 'ok', degraded: MASTER_KEY_MISMATCH }))).toBe(
      MASTER_KEY_MISMATCH
    );
  });

  test('网关正在重启（非 2xx / 连不上）不算降级：否则每次重启都弹一条严重提示', async () => {
    expect(await fetchDegraded(healthz({}, { status: 503 }))).toBeNull();
    const boom = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    expect(await fetchDegraded(boom)).toBeNull();
  });

  test('响应不是 JSON 时按「没有降级」处理', async () => {
    const text = (() => Promise.resolve(new Response('nope'))) as unknown as typeof fetch;
    expect(await fetchDegraded(text)).toBeNull();
  });
});

describe('MasterKeyMismatchNotice', () => {
  test('一句说清后果，再给一条可复制的恢复命令，且不带关闭按钮', () => {
    const html = renderToStaticMarkup(<MasterKeyMismatchNotice />);
    expect(html).toContain('data-testid="master-key-mismatch"');
    expect(html).toContain('app.masterKeyMismatch.title');
    expect(html).toContain('app.masterKeyMismatch.commandLabel');
    expect(html).toContain(MESH_RESET_IDENTITY_COMMAND);
    expect(html).toContain('data-testid="master-key-reset-identity-copy"');
    expect(html).not.toContain('nodes.actions.close');
  });
});

describe('文案', () => {
  test('中文文案点出「多节点已停用」与找回主密钥的位置', () => {
    const copy = zhCN.translation.app.masterKeyMismatch;
    expect(copy.title).toBe('主密钥无法解密节点身份，多节点功能已停用。');
    expect(copy.commandLabel).toContain('backups/app.env.*');
    expect(copy.commandLabel).toContain('VIBETERM_MASTER_KEY');
  });
});
