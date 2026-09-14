// 连接详情「接入密码」行：已知/未记录、揭示拉取、多中继选择。无 DOM，静态渲染。

import { describe, expect, test } from 'bun:test';
import type { UseMeshRelayResult } from '@/node/mesh-relay';
import { RelayApiError } from '@vibeterm/api-client/relay/admin-api';
import type { RelayLinkStatus, RelayTenantApi } from '@vibeterm/api-client/relay/tenant-api';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ENROLL_PASSWORD_MASK,
  RelayPasswordRow,
  RelayPasswordValue,
  enrollPasswordKnown,
  fetchEnrollPasswordReveal,
  loadEnrollPassword,
} from './relay-password-row';

const NO_RELAY = {
  mode: 'none',
  relayMode: false,
  quota: null,
  tenantId: null,
  relays: [],
  ordered: [],
  attached: null,
  metaEpoch: 0,
  nodesViaRelay: 0,
  reauthRequired: false,
  readmitPending: 0,
  metaKeyLagging: [],
  preferredUrl: null,
  autoSelect: { enabled: false, lastSwitchAt: null, switchReason: null, nextEvalAt: null },
  writable: true,
  kicked: false,
  loading: false,
  error: null,
  loadedAt: 1,
  unsupported: false,
  refresh: () => undefined,
  switchRelay: () => Promise.resolve(),
} satisfies UseMeshRelayResult;

function link(overrides: Partial<RelayLinkStatus> = {}): RelayLinkStatus {
  return {
    url: 'https://sh.example.com:8443',
    priority: 0,
    online: true,
    attached: true,
    role: 'primary',
    enrollPassword: { known: true },
    ...overrides,
  };
}

function relayOf(relays: RelayLinkStatus[]): UseMeshRelayResult {
  return {
    ...NO_RELAY,
    mode: 'relay',
    relayMode: true,
    tenantId: 'ab'.repeat(16),
    relays,
    ordered: relays,
    attached: relays.find((row) => row.attached) ?? null,
  };
}

describe('enrollPasswordKnown', () => {
  test('只有 known === true 才算本机已记录', () => {
    expect(enrollPasswordKnown(link({ enrollPassword: { known: true } }))).toBe(true);
    expect(enrollPasswordKnown(link({ enrollPassword: { known: false } }))).toBe(false);
    expect(enrollPasswordKnown(link({ enrollPassword: undefined }))).toBe(false);
    expect(enrollPasswordKnown(null)).toBe(false);
  });
});

describe('RelayPasswordValue', () => {
  const noop = (): void => undefined;

  test('已知：掩码 + 眼睛 + 修改', () => {
    const html = renderToStaticMarkup(
      <RelayPasswordValue
        known
        revealed={false}
        plaintext={null}
        loading={false}
        onReveal={noop}
        onChange={noop}
      />
    );
    expect(html).toContain('data-testid="nodes-relay-enroll-password"');
    expect(html).toContain(ENROLL_PASSWORD_MASK);
    expect(html).toContain('data-testid="nodes-relay-enroll-password-reveal"');
    expect(html).toContain('data-testid="nodes-relay-enroll-password-change"');
    expect(html).toContain('relay.tenant.strip.enrollPasswordChange');
    expect(html).not.toContain('relay.tenant.strip.enrollPasswordUnknown');
  });

  test('已知且已揭示：明文走 CopyableValue', () => {
    const html = renderToStaticMarkup(
      <RelayPasswordValue
        known
        revealed
        plaintext="s3cret"
        loading={false}
        onReveal={noop}
        onChange={noop}
      />
    );
    expect(html).toContain('s3cret');
    expect(html).toContain('data-testid="nodes-relay-enroll-password-copy"');
    expect(html).not.toContain(ENROLL_PASSWORD_MASK);
  });

  test('未记录：不显示眼睛，值为本机未记录', () => {
    const html = renderToStaticMarkup(
      <RelayPasswordValue
        known={false}
        revealed={false}
        plaintext={null}
        loading={false}
        onReveal={noop}
        onChange={noop}
      />
    );
    expect(html).toContain('relay.tenant.strip.enrollPasswordUnknown');
    expect(html).toContain('data-testid="nodes-relay-enroll-password-change"');
    expect(html).not.toContain('data-testid="nodes-relay-enroll-password-reveal"');
    expect(html).not.toContain(ENROLL_PASSWORD_MASK);
  });
});

describe('RelayPasswordRow', () => {
  test('非中继或不存在已挂上的中继时整行不出现', () => {
    expect(renderToStaticMarkup(<RelayPasswordRow relay={NO_RELAY} />)).toBe('');
    expect(
      renderToStaticMarkup(
        <RelayPasswordRow
          relay={relayOf([link({ attached: false, role: null, enrollPassword: { known: true } })])}
        />
      )
    ).toBe('');
  });

  test('已知：标签、掩码、修改按钮', () => {
    const html = renderToStaticMarkup(<RelayPasswordRow relay={relayOf([link()])} />);
    expect(html).toContain('data-testid="nodes-relay-enroll-password-row"');
    expect(html).toContain('relay.tenant.strip.enrollPassword');
    expect(html).toContain(ENROLL_PASSWORD_MASK);
    expect(html).toContain('data-testid="nodes-relay-enroll-password-change"');
    expect(html).not.toContain('data-testid="nodes-relay-enroll-password-relay"');
  });

  test('未记录：展示本机未记录', () => {
    const html = renderToStaticMarkup(
      <RelayPasswordRow relay={relayOf([link({ enrollPassword: { known: false } })])} />
    );
    expect(html).toContain('relay.tenant.strip.enrollPasswordUnknown');
  });

  test('多条已挂上时出现中继选择，默认主中继', () => {
    const html = renderToStaticMarkup(
      <RelayPasswordRow
        relay={relayOf([
          link({
            url: 'https://tokyo.example.com:8443',
            priority: 1,
            role: 'secondary',
            enrollPassword: { known: false },
          }),
          link({ url: 'https://sh.example.com:8443', role: 'primary' }),
        ])}
      />
    );
    expect(html).toContain('data-testid="nodes-relay-enroll-password-relay"');
    expect(html).toContain('sh.example.com:8443');
    expect(html).toContain('tokyo.example.com:8443');
    expect(html).toContain(ENROLL_PASSWORD_MASK);
  });
});

describe('loadEnrollPassword', () => {
  test('known 时返回明文，未知返回 null', async () => {
    const api = {
      enrollPassword: (url: string) => {
        expect(url).toBe('https://r.example');
        return Promise.resolve({ known: true, password: 'plain' });
      },
    } as unknown as RelayTenantApi;
    expect(await loadEnrollPassword('https://r.example', api)).toBe('plain');

    const unknown = {
      enrollPassword: () => Promise.resolve({ known: false, password: null }),
    } as unknown as RelayTenantApi;
    expect(await loadEnrollPassword('https://r.example', unknown)).toBeNull();
  });

  test('known 但 password 为 null 或空串视为未记录', async () => {
    const missing = {
      enrollPassword: () => Promise.resolve({ known: true, password: null }),
    } as unknown as RelayTenantApi;
    expect(await loadEnrollPassword('https://r.example', missing)).toBeNull();
    const empty = {
      enrollPassword: () => Promise.resolve({ known: true, password: '' }),
    } as unknown as RelayTenantApi;
    expect(await loadEnrollPassword('https://r.example', empty)).toBeNull();
  });

  test('失败原样抛出', async () => {
    const api = {
      enrollPassword: () => Promise.reject(new RelayApiError('relay_unreachable', 'down', 502)),
    } as unknown as RelayTenantApi;
    await expect(loadEnrollPassword('https://r.example', api)).rejects.toBeInstanceOf(
      RelayApiError
    );
  });
});

describe('fetchEnrollPasswordReveal', () => {
  test('明文 / 未记录 / 错误三态', async () => {
    const known = {
      enrollPassword: () => Promise.resolve({ known: true, password: 'plain' }),
    } as unknown as RelayTenantApi;
    expect(await fetchEnrollPasswordReveal('https://r.example', known)).toEqual({
      kind: 'value',
      password: 'plain',
    });
    const gone = {
      enrollPassword: () => Promise.resolve({ known: true, password: null }),
    } as unknown as RelayTenantApi;
    expect(await fetchEnrollPasswordReveal('https://r.example', gone)).toEqual({
      kind: 'missing',
    });
    const failed = {
      enrollPassword: () => Promise.reject(new RelayApiError('RELAY_UNAUTHORIZED', 'x', 401)),
    } as unknown as RelayTenantApi;
    expect(await fetchEnrollPasswordReveal('https://r.example', failed)).toEqual({
      kind: 'error',
      key: 'relay.tenant.enrollPassword.errors.unauthorized',
    });
  });
});
