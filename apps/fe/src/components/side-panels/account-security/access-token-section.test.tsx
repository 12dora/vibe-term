// 「访问令牌」：表单解析、行内文案与列表 / 表单 / 密钥的静态渲染。

import { describe, expect, test } from 'bun:test';
import { ApiError } from '@vibeterm/api-client';
import type { AccessTokenDto } from '@vibeterm/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccessTokenForm, AccessTokenSecret } from './access-token-create-dialog';
import {
  emptyTokenDraft,
  expiresText,
  lastUsedText,
  lastUsedTitle,
  parseTokenDraft,
  toggleScope,
  tokenErrorText,
} from './access-token-format';
import { AccessTokenSectionView } from './access-token-section';
import type { AccessTokensState } from './use-access-tokens';

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}${JSON.stringify(options)}` : key;

/** 带指定 testid 的那一个开标签。 */
function tagOf(html: string, testId: string): string {
  const at = html.indexOf(`data-testid="${testId}"`);
  expect(at).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
}

const NOW = Date.UTC(2026, 9, 14, 12);
const DAY = 86_400_000;

function token(patch: Partial<AccessTokenDto> = {}): AccessTokenDto {
  return {
    id: 'tok-1',
    name: 'CI deploy',
    scopes: ['exec'],
    createdAt: NOW - 10 * DAY,
    expiresAt: null,
    lastUsedAt: null,
    lastUsedIp: null,
    ...patch,
  };
}

function state(patch: Partial<AccessTokensState> = {}): AccessTokensState {
  return {
    tokens: [],
    loadError: null,
    revokingId: null,
    revokeError: null,
    create: () => Promise.reject(new Error('unexpected')),
    revoke: () => Promise.resolve(),
    ...patch,
  };
}

describe('parseTokenDraft', () => {
  test('默认草稿：仅执行权限、90 天', () => {
    const parsed = parseTokenDraft(t, { ...emptyTokenDraft(), name: '  build  ' });
    expect(parsed).toEqual({
      ok: true,
      body: { name: 'build', scopes: ['exec'], expiresInDays: 90 },
    });
  });

  test('永不过期映射为 null，权限按固定顺序去重', () => {
    const parsed = parseTokenDraft(t, {
      name: 'x',
      scopes: ['forward', 'exec', 'forward'],
      expiry: 'never',
    });
    expect(parsed).toEqual({
      ok: true,
      body: { name: 'x', scopes: ['exec', 'forward'], expiresInDays: null },
    });
  });

  test('缺名称、超长名称、空权限都给字段错误', () => {
    const empty = parseTokenDraft(t, { name: ' ', scopes: [], expiry: '30' });
    expect(empty).toEqual({
      ok: false,
      errors: {
        name: 'auth.security.tokens.form.nameRequired',
        scopes: 'auth.security.tokens.form.scopeRequired',
      },
    });
    const long = parseTokenDraft(t, { name: 'a'.repeat(65), scopes: ['exec'], expiry: '365' });
    expect(long.ok).toBe(false);
  });

  test('toggleScope 保持 exec / files / forward 顺序', () => {
    expect(toggleScope(['forward'], 'exec', true)).toEqual(['exec', 'forward']);
    expect(toggleScope(['exec', 'files'], 'exec', false)).toEqual(['files']);
  });
});

describe('行内文案', () => {
  test('最近使用：从未 / 相对时间，悬停带 IP', () => {
    expect(lastUsedText(t, token(), NOW)).toBe('auth.security.tokens.neverUsed');
    expect(lastUsedText(t, token({ lastUsedAt: NOW - 3 * DAY }), NOW)).toContain(
      'auth.security.tokens.lastUsed'
    );
    expect(lastUsedTitle(token())).toBe('');
    expect(lastUsedTitle(token({ lastUsedAt: NOW, lastUsedIp: '203.0.113.7' }))).toContain(
      '203.0.113.7'
    );
  });

  test('过期：永不 / 已过期 / 日期', () => {
    expect(expiresText(t, token(), NOW)).toBe('auth.security.tokens.neverExpires');
    expect(expiresText(t, token({ expiresAt: NOW - 1 }), NOW)).toBe('auth.security.tokens.expired');
    expect(expiresText(t, token({ expiresAt: NOW + DAY }), NOW)).toContain(
      'auth.security.tokens.expiresAt'
    );
  });

  test('token_limit 映射为上限文案，其余透出原始错误', () => {
    const limit = new ApiError(409, 'token_limit', { code: 'token_limit' });
    expect(tokenErrorText(t, limit)).toBe('auth.security.tokens.errors.limit{"max":50}');
    expect(tokenErrorText(t, new Error('boom'))).toBe('boom');
  });
});

describe('AccessTokenSectionView', () => {
  test('加载中只有 spinner，创建按钮禁用', () => {
    const html = renderToStaticMarkup(
      <AccessTokenSectionView state={state({ tokens: null })} now={NOW} />
    );
    expect(html).not.toContain('security-tokens-empty');
    expect(tagOf(html, 'security-token-create')).toContain('disabled=""');
  });

  test('空列表一行提示', () => {
    const html = renderToStaticMarkup(<AccessTokenSectionView state={state()} now={NOW} />);
    expect(html).toContain('data-testid="security-tokens-empty"');
  });

  test('行内渲染权限标签、IP 与撤销按钮', () => {
    const html = renderToStaticMarkup(
      <AccessTokenSectionView
        state={state({
          tokens: [
            token({
              scopes: ['exec', 'files', 'forward'],
              lastUsedAt: NOW - DAY,
              lastUsedIp: '203.0.113.7',
            }),
          ],
        })}
        now={NOW}
      />
    );
    expect(html).toContain('data-testid="security-token-row-tok-1"');
    for (const scope of ['exec', 'files', 'forward']) {
      expect(html).toContain(`data-testid="security-token-tag-${scope}"`);
    }
    expect(html).toContain('203.0.113.7');
    expect(html).toContain('data-testid="security-token-revoke-tok-1"');
  });

  test('加载失败显示错误', () => {
    const html = renderToStaticMarkup(
      <AccessTokenSectionView state={state({ tokens: null, loadError: 'offline' })} now={NOW} />
    );
    expect(html).toContain('auth.security.tokens.loadFailed');
  });
});

describe('AccessTokenForm / AccessTokenSecret', () => {
  test('表单默认勾选执行权限，名称限长 64', () => {
    const html = renderToStaticMarkup(
      <AccessTokenForm
        draft={emptyTokenDraft()}
        errors={{}}
        busy={false}
        onChange={() => undefined}
        onSubmit={() => undefined}
      />
    );
    expect(html).toContain('maxLength="64"');
    expect(tagOf(html, 'security-token-scope-exec')).toContain('data-checked');
    expect(tagOf(html, 'security-token-scope-files')).toContain('data-unchecked');
    expect(html).toContain('data-testid="security-token-expiry"');
  });

  test('密钥只读并带复制按钮', () => {
    const html = renderToStaticMarkup(<AccessTokenSecret secret="vtk_abc" />);
    expect(html).toContain('readOnly=""');
    expect(html).toContain('value="vtk_abc"');
    expect(html).toContain('data-testid="security-token-secret-copy"');
  });
});
