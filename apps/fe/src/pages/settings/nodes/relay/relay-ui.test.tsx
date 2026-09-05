// 中继 UI 的纯逻辑与链路行：行内文案、错误码查表、配额分档、提醒次序、次级菜单条目、
// 提交前校验、切换对话框的文案路由。

import { describe, expect, test } from 'bun:test';
import { RelayApiError } from '@tmex/api-client/relay/admin-api';
import type { RelayLinkStatus } from '@tmex/api-client/relay/tenant-api';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  kickedRelays,
  reauthTarget,
  relayActionMenu,
  uplinkBlockedHint,
} from '../uplink/relay-targets';
import { canSubmitRelayEnroll } from './relay-dialogs';
import { relayNotices } from './relay-notices';
import { relayQuotaRows } from './relay-quota';
import { RelayRows, relayFailing, relayLabel, relayLinkErrorKey } from './relay-rows';
import { relaySwitchDialogCopy } from './relay-switch-dialog';
import { relayErrorText } from './use-relay-actions';
import { readmitErrorText } from './use-relay-readmit';
import { relaySwitchErrorText } from './use-relay-switch';

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
    lastErrorCode: null,
    kicked: false,
    ...overrides,
  };
}

describe('relay 行的纯函数', () => {
  test('行首正文取主机名，畸形地址原样显示', () => {
    expect(relayLabel('https://relay.example.com:8443')).toBe('relay.example.com:8443');
    expect(relayLabel('not a url')).toBe('not a url');
  });

  test('被踢，或掉线且有错，才算需要提醒', () => {
    expect(relayFailing(link())).toBe(false);
    expect(relayFailing(link({ kicked: true }))).toBe(true);
    expect(relayFailing(link({ online: false, lastErrorCode: 'dns' }))).toBe(true);
    // 在线时后端已把错误清空；万一没清，行内也不报错
    expect(relayFailing(link({ online: true, lastError: 'ECONNRESET' }))).toBe(false);
  });
});

describe('链路错误的查表', () => {
  test('每个错误码各有一条文案', () => {
    const codes = [
      'connect-failed',
      'connect-timeout',
      'auth-timeout',
      'auth-rejected',
      'heartbeat-lost',
      'kicked',
      'dns',
      'refused',
      'tls',
      'protocol',
      'unknown',
    ] as const;
    for (const code of codes) {
      expect(relayLinkErrorKey(link({ online: false, lastErrorCode: code }))).toBe(
        `relay.tenant.linkErrors.${code}`
      );
    }
  });

  test('只有原始错误串（或不认得的码）时一律归到 unknown，绝不上屏', () => {
    expect(relayLinkErrorKey(link({ online: false, lastError: 'ECONNRESET' }))).toBe(
      'relay.tenant.linkErrors.unknown'
    );
    expect(
      relayLinkErrorKey(
        link({ online: false, lastErrorCode: 'whatever' as never, lastError: 'boom' })
      )
    ).toBe('relay.tenant.linkErrors.unknown');
  });

  test('在线，或掉线但没有错，都不出错误行', () => {
    expect(relayLinkErrorKey(link({ online: true, lastErrorCode: 'dns' }))).toBeNull();
    expect(relayLinkErrorKey(link({ online: false }))).toBeNull();
  });
});

describe('RelayRows 渲染', () => {
  const HOST = 'relay.example.com:8443';
  const OTHER = link({ url: 'https://b.example', priority: 2 });

  test('没有中继时只给一行「未接入」', () => {
    const html = renderToStaticMarkup(<RelayRows relays={[]} />);
    expect(html).toContain('data-testid="nodes-relay-empty"');
    expect(html).not.toContain('data-testid="nodes-relay-rows"');
  });

  test('一行只剩地址与一枚状态徽标：延迟进徽标，「当前挂载于此中继」整句删掉', () => {
    const html = renderToStaticMarkup(<RelayRows relays={[link({ attached: true, rttMs: 42 })]} />);
    expect(html).toContain(`data-testid="nodes-relay-row-${HOST}"`);
    expect(html).toContain('data-relay-attached="true"');
    expect(html).toContain('data-relay-online="true"');
    expect(html).toContain(`data-testid="nodes-relay-host-${HOST}"`);
    expect(html).toContain(`data-testid="nodes-relay-status-${HOST}"`);
    expect(html).toContain('relay.tenant.strip.rtt');
    expect(html).not.toContain('relay.tenant.strip.attached');
    // 外面那圈方框没有了
    expect(html).not.toContain('ring-border/60');
  });

  test('在线但延迟未知时徽标说「在线」', () => {
    const html = renderToStaticMarkup(<RelayRows relays={[link({ attached: true })]} />);
    expect(html).toContain('relay.tenant.strip.online');
    expect(html).not.toContain('relay.tenant.strip.rtt');
  });

  test('被踢与错误各占一行红字，错误只查表不印原串', () => {
    const html = renderToStaticMarkup(
      <RelayRows
        relays={[link({ kicked: true, online: false, lastErrorCode: 'kicked', lastError: 'boom' })]}
      />
    );
    expect(html).toContain(`data-testid="nodes-relay-kicked-${HOST}"`);
    expect(html).toContain(`data-testid="nodes-relay-error-${HOST}"`);
    expect(html).toContain('data-relay-failing="true"');
    expect(html).toContain('relay.tenant.strip.offline');
    expect(html).not.toContain('boom');
  });

  test('在线的那条不出错误行', () => {
    const html = renderToStaticMarkup(
      <RelayRows relays={[link({ online: true, lastError: 'ECONNRESET' })]} />
    );
    expect(html).not.toContain(`data-testid="nodes-relay-error-${HOST}"`);
  });

  test('只有一条中继：行不可选，没有按钮语义', () => {
    const html = renderToStaticMarkup(
      <RelayRows relays={[link({ attached: true })]} onSelect={() => undefined} />
    );
    expect(html).not.toContain('data-testid="nodes-relay-switch-');
    expect(html).not.toContain('aria-current');
    expect(html).not.toContain('<button');
  });

  test('两条以上：当前那条标 aria-current，其余是可点的按钮', () => {
    const html = renderToStaticMarkup(
      <RelayRows relays={[link({ attached: true }), OTHER]} onSelect={() => undefined} />
    );
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('data-testid="nodes-relay-switch-b.example"');
    expect(html).not.toContain(`data-testid="nodes-relay-switch-${HOST}"`);
    expect(html).toContain('ring-primary');
  });

  test('没传 onSelect 时哪条都不可选', () => {
    const html = renderToStaticMarkup(<RelayRows relays={[link({ attached: true }), OTHER]} />);
    expect(html).not.toContain('data-testid="nodes-relay-switch-b.example"');
    expect(html).not.toContain('aria-current');
  });
});

describe('切换中继的对话框文案', () => {
  test('主机名进标题，说明与确认是固定的一句', () => {
    const copy = relaySwitchDialogCopy('https://b.example:8443/');
    expect(copy.titleKey).toBe('relay.tenant.switch.title');
    expect(copy.params).toEqual({ host: 'b.example:8443' });
    expect(copy.descriptionKey).toBe('relay.tenant.switch.description');
    expect(copy.confirmKey).toBe('relay.tenant.switch.confirm');
  });

  test('失败文案：认得的 code 逐条翻译，其余归到「切换失败」', () => {
    const table = (key: string, options?: Record<string, unknown>) => {
      if (key === 'relay.tenant.errors.RELAY_KICKED') return '令牌已失效。';
      return String(options?.defaultValue ?? key);
    };
    expect(relaySwitchErrorText(table, new RelayApiError('RELAY_KICKED', 'kicked', 409))).toBe(
      '令牌已失效。'
    );
    expect(relaySwitchErrorText(table, new Error('boom'))).toBe('RELAY_SWITCH_FAILED');
  });
});

describe('三档配额', () => {
  const quota = {
    maxNodes: 8,
    maxStreams: 16,
    bandwidthBytesPerSec: 1024 * 1024,
    currentNodes: 5,
  };

  test('有实时用量：节点取 usage、并发流与带宽都给出用量与进度', () => {
    const rows = relayQuotaRows({
      ...quota,
      usage: {
        currentNodes: 6,
        currentStreams: 4,
        bytesInPerSec: 2048,
        bytesOutPerSec: 4096,
        sampledAt: 1,
      },
    });
    expect(rows.map((row) => row.kind)).toEqual(['nodes', 'streams', 'bandwidth']);
    expect(rows[0]?.usedText).toBe('6');
    expect(rows[0]?.percent).toBe(75);
    expect(rows[1]?.usedText).toBe('4');
    expect(rows[2]?.usedText).toBe('4.00 KB/s');
    expect(rows[2]?.limitText).toBe('1.00 MB/s');
  });

  test('网关补上合计带宽时以它为准', () => {
    const rows = relayQuotaRows({
      ...quota,
      usage: {
        currentNodes: 1,
        currentStreams: 1,
        bytesInPerSec: 2048,
        bytesOutPerSec: 4096,
        bandwidthBytesPerSec: 6144,
        sampledAt: 1,
      } as never,
    });
    expect(rows[2]?.usedText).toBe('6.00 KB/s');
  });

  test('带宽用量是浮点时最多两位小数', () => {
    const rows = relayQuotaRows({
      ...quota,
      usage: {
        currentNodes: 1,
        currentStreams: 1,
        bytesInPerSec: 237.51937984496124,
        bytesOutPerSec: 0,
        sampledAt: 1,
      },
    });
    expect(rows[2]?.usedText).toBe('237.52 B/s');
  });

  test('旧中继不下发用量：只剩上限，也没有进度条', () => {
    const rows = relayQuotaRows({ ...quota, usage: null });
    expect(rows[0]?.usedText).toBe('5');
    expect(rows[1]?.usedText).toBeNull();
    expect(rows[1]?.percent).toBeNull();
    expect(rows[2]?.usedText).toBeNull();
    expect(rows[2]?.percent).toBeNull();
  });

  test('带宽无上限：给「不限」的 key，不摆进度条', () => {
    const rows = relayQuotaRows({ ...quota, bandwidthBytesPerSec: null, usage: null });
    expect(rows[2]?.limitKey).toBe('nodes.machine.details.quotaUnlimited');
    expect(rows[2]?.limitText).toBeNull();
    expect(rows[2]?.percent).toBeNull();
  });

  test('用量超过上限时进度封在 100%', () => {
    const rows = relayQuotaRows({
      ...quota,
      maxNodes: 2,
      usage: {
        currentNodes: 9,
        currentStreams: 0,
        bytesInPerSec: 0,
        bytesOutPerSec: 0,
        sampledAt: 1,
      },
    });
    expect(rows[0]?.percent).toBe(100);
  });
});

describe('中继提醒的次序与内容', () => {
  const idle = {
    kicked: false,
    readmitPending: 0,
    metaPending: 0,
    packPending: false,
    writable: true,
  };

  test('一切正常时一条都不出', () => {
    expect(relayNotices(idle)).toEqual([]);
  });

  test('五种情况按固定次序摆开，各带一个动作', () => {
    const notices = relayNotices({
      kicked: false,
      readmitPending: 2,
      metaPending: 1,
      packPending: true,
      writable: false,
    });
    expect(notices.map((notice) => notice.kind)).toEqual([
      'readmit',
      'metaPending',
      'packPending',
      'notAttached',
    ]);
    expect(notices[0]?.params).toEqual({ count: 2 });
    expect(notices[0]?.action?.testId).toBe('nodes-relay-readmit-action');
    // 未挂载那一条只陈述事实，处理办法在下面的操作区
    expect(notices[3]?.action).toBeUndefined();
  });

  test('令牌失效时不再补一条更笼统的「未挂载」', () => {
    const notices = relayNotices({ ...idle, kicked: true, writable: false });
    expect(notices.map((notice) => notice.kind)).toEqual(['kicked']);
    expect(notices[0]?.tone).toBe('danger');
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

describe('重新输入接入密码的目标', () => {
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

describe('次级菜单的条目', () => {
  test('只有一条中继：只给重新输入接入密码，不给「移除」', () => {
    const items = relayActionMenu([link({ url: 'https://a.example', attached: true })]);
    expect(items.map((item) => item.kind)).toEqual(['reauth']);
    expect(items[0]?.testId).toBe('nodes-relay-reauth-menu');
    expect(items[0]?.url).toBe('https://a.example');
  });

  test('多条中继：逐条给出移除入口', () => {
    const items = relayActionMenu([
      link({ url: 'https://a.example', attached: true }),
      link({ url: 'https://b.example', priority: 2 }),
    ]);
    expect(items.map((item) => item.testId)).toEqual([
      'nodes-relay-reauth-menu',
      'nodes-relay-remove-a.example',
      'nodes-relay-remove-b.example',
    ]);
  });

  test('多条被踢：逐条给出重新输入接入密码，不再合并成一个入口', () => {
    const items = relayActionMenu([
      link({ url: 'https://a.example', kicked: true }),
      link({ url: 'https://b.example', kicked: true, priority: 2 }),
    ]);
    expect(items.map((item) => item.testId)).toEqual([
      'nodes-relay-reauth-a.example',
      'nodes-relay-reauth-b.example',
      'nodes-relay-remove-a.example',
      'nodes-relay-remove-b.example',
    ]);
    expect(items[0]?.params).toEqual({ host: 'a.example' });
  });
});
