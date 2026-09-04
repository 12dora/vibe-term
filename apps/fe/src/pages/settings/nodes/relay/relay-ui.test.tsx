// 中继 UI 的纯逻辑：chip 文案、提交前校验、错误查表、不可写提示、静态渲染下的链路条。

import { describe, expect, test } from 'bun:test';
import type { RelayLinkStatus } from '@tmex/api-client/relay/tenant-api';
import { renderToStaticMarkup } from 'react-dom/server';
import { kickedRelays, reauthTarget, uplinkBlockedHint } from '../uplink/relay-targets';
import { RelayPackPendingNotice, canSubmitRelayEnroll } from './relay-dialogs';
import { RelayStrip, relayChipTitle, relayFailing, relayLabel } from './relay-strip';
import type { RelayActionsController } from './use-relay-actions';
import { relayErrorText } from './use-relay-actions';
import { readmitErrorText } from './use-relay-readmit';

const t = (key: string, options?: Record<string, unknown>) => {
  if (options && 'defaultValue' in options) return String(options.defaultValue);
  return options ? `${key}(${JSON.stringify(options)})` : key;
};

function link(overrides: Partial<RelayLinkStatus> = {}): RelayLinkStatus {
  return {
    url: 'https://relay.example.com:8443',
    priority: 1,
    online: true,
    attached: false,
    rttMs: null,
    lastError: null,
    kicked: false,
    ...overrides,
  };
}

describe('relay-strip 纯函数', () => {
  test('chip 正文取主机名，畸形地址原样显示', () => {
    expect(relayLabel('https://relay.example.com:8443')).toBe('relay.example.com:8443');
    expect(relayLabel('not a url')).toBe('not a url');
  });

  test('被踢或最近有错都算需要提醒', () => {
    expect(relayFailing(link())).toBe(false);
    expect(relayFailing(link({ kicked: true }))).toBe(true);
    expect(relayFailing(link({ lastError: 'ECONNRESET' }))).toBe(true);
  });

  test('悬浮详情按需补挂载 / 延迟 / 被踢 / 最近错误四行', () => {
    const title = relayChipTitle(
      t,
      link({ attached: true, rttMs: 42, kicked: true, lastError: 'boom' })
    );
    const lines = title.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toBe('relay.tenant.strip.attached');
    expect(lines[2]).toContain('42');
    expect(lines[3]).toBe('relay.tenant.strip.kicked');
    expect(lines[4]).toContain('boom');
  });
});

describe('RelayStrip 渲染', () => {
  test('没有中继时给一行「未接入」，有配额时多一格', () => {
    const empty = renderToStaticMarkup(
      <RelayStrip relays={[]} metaEpoch={0} nodesViaRelay={0} quota={null} />
    );
    expect(empty).toContain('nodes-relay-empty');
    expect(empty).not.toContain('nodes-relay-quota');

    const full = renderToStaticMarkup(
      <RelayStrip
        relays={[link({ attached: true })]}
        metaEpoch={3}
        nodesViaRelay={2}
        quota={{ maxNodes: 8, maxStreams: 16, bandwidthBytesPerSec: null }}
      />
    );
    expect(full).toContain('nodes-relay-quota');
    expect(full).toContain('relay.example.com:8443');
    expect(full).toContain('data-relay-attached="true"');
  });

  test('租户编号可复制并配一句说明；未接入时整格不出现', () => {
    const withTenant = renderToStaticMarkup(
      <RelayStrip
        relays={[link({ attached: true })]}
        metaEpoch={1}
        nodesViaRelay={1}
        tenantId="aabbccddeeff00112233445566778899"
      />
    );
    expect(withTenant).toContain('data-testid="nodes-relay-tenant-id"');
    expect(withTenant).toContain('aabbccddeeff00112233445566778899');
    expect(withTenant).toContain('data-testid="nodes-relay-tenant-id-copy"');
    expect(withTenant).toContain('relay.tenant.strip.tenantIdHint');

    const without = renderToStaticMarkup(
      <RelayStrip relays={[link()]} metaEpoch={1} nodesViaRelay={1} tenantId={null} />
    );
    expect(without).not.toContain('data-testid="nodes-relay-tenant-id"');
  });
});

describe('接入表单校验', () => {
  test('地址须是可信 https（回环允许 http），根密码不能空', () => {
    expect(canSubmitRelayEnroll({ url: 'https://r.example', rootPassword: 'pw' })).toBe(true);
    expect(canSubmitRelayEnroll({ url: ' https://r.example ', rootPassword: 'pw' })).toBe(true);
    expect(canSubmitRelayEnroll({ url: 'http://r.example', rootPassword: 'pw' })).toBe(false);
    expect(canSubmitRelayEnroll({ url: 'http://127.0.0.1:9883', rootPassword: 'pw' })).toBe(true);
    expect(canSubmitRelayEnroll({ url: 'https://r.example', rootPassword: '' })).toBe(false);
  });
});

describe('文案查表', () => {
  test('先查中继错误表，缺了退回通用表，再缺就显示 code', () => {
    const table = (key: string, options?: Record<string, unknown>) => {
      if (key === 'relay.tenant.errors.RELAY_PASSWORD_INVALID') return '中继口令不正确。';
      if (key === 'auth.errors.KEY_LOG_FORK') return '密钥日志分叉。';
      return String(options?.defaultValue ?? key);
    };
    expect(relayErrorText(table, 'RELAY_PASSWORD_INVALID')).toBe('中继口令不正确。');
    expect(relayErrorText(table, 'KEY_LOG_FORK')).toBe('密钥日志分叉。');
    expect(relayErrorText(table, 'WHATEVER')).toBe('WHATEVER');
  });

  test('重新确认成员：本族的 key 优先，再退回中继与通用表', () => {
    const table = (key: string, options?: Record<string, unknown>) => {
      if (key === 'nodes.readmit.errors.READMIT_ROOT_REQUIRED') return '只能用当前密码。';
      if (key === 'relay.tenant.errors.RELAY_OFFLINE') return '中继连接已断开。';
      if (key === 'auth.errors.KEY_LOG_FORK') return '密钥日志分叉。';
      return String(options?.defaultValue ?? key);
    };
    expect(readmitErrorText(table, 'READMIT_ROOT_REQUIRED')).toBe('只能用当前密码。');
    expect(readmitErrorText(table, 'RELAY_OFFLINE')).toBe('中继连接已断开。');
    expect(readmitErrorText(table, 'KEY_LOG_FORK')).toBe('密钥日志分叉。');
    expect(readmitErrorText(table, 'WHATEVER')).toBe('WHATEVER');
  });

  test('不可写提示按上级形态分档', () => {
    expect(uplinkBlockedHint(t, true, false)).toBe('relay.tenant.notAttached');
    expect(uplinkBlockedHint(t, false, true)).toBe('nodes.hubs.standbyNotice');
    expect(uplinkBlockedHint(t, false, false)).toBe('nodes.hubOffline');
  });
});

describe('重新输入口令的目标', () => {
  test('优先挑被踢的那一条，而不是列表第一条', () => {
    const relays = [
      link({ url: 'https://a.example', attached: true }),
      link({ url: 'https://b.example', kicked: true }),
    ];
    expect(reauthTarget(relays)).toBe('https://b.example');
    expect(kickedRelays(relays).map((row) => row.url)).toEqual(['https://b.example']);
  });

  test('多条被踢时按顺序给出全部，交给菜单逐条列', () => {
    const relays = [
      link({ url: 'https://a.example', kicked: true }),
      link({ url: 'https://b.example' }),
      link({ url: 'https://c.example', kicked: true }),
    ];
    expect(kickedRelays(relays).map((row) => row.url)).toEqual([
      'https://a.example',
      'https://c.example',
    ]);
    expect(reauthTarget(relays)).toBe('https://a.example');
  });

  test('一条都没被踢时退回当前挂载的那条', () => {
    const relays = [
      link({ url: 'https://a.example' }),
      link({ url: 'https://b.example', attached: true }),
    ];
    expect(reauthTarget(relays)).toBe('https://b.example');
    expect(reauthTarget([])).toBeNull();
  });
});

describe('密封包欠账告警', () => {
  function actions(overrides: Partial<RelayActionsController> = {}): RelayActionsController {
    return {
      enroll: null,
      confirm: null,
      busy: false,
      error: null,
      openEnroll: () => undefined,
      closeEnroll: () => undefined,
      requestConfirm: () => undefined,
      dismissConfirm: () => undefined,
      submitEnroll: () => Promise.resolve(),
      runConfirm: () => Promise.resolve(),
      readmitMembers: () => Promise.resolve(),
      metaPending: [],
      retryMetaKey: () => Promise.resolve(),
      packPending: false,
      retryPack: () => Promise.resolve(),
      ...overrides,
    };
  }

  test('没欠账时什么都不渲染，欠着时给一行告警加重试按钮', () => {
    expect(renderToStaticMarkup(<RelayPackPendingNotice actions={actions()} />)).toBe('');
    const html = renderToStaticMarkup(
      <RelayPackPendingNotice actions={actions({ packPending: true })} />
    );
    expect(html).toContain('data-testid="nodes-relay-pack-pending"');
    expect(html).toContain('relay.tenant.pack.pending');
    expect(html).toContain('data-testid="nodes-relay-pack-retry"');
  });
});
