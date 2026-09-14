// 租户侧修改接入密码：草稿校验、提交成功/失败、正文已知/未知。无 DOM，静态渲染。

import { describe, expect, test } from 'bun:test';
import { RelayApiError } from '@vibeterm/api-client/relay/admin-api';
import type { RelayTenantApi } from '@vibeterm/api-client/relay/tenant-api';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  type EnrollPasswordDraft,
  RelayEnrollPasswordDialogBody,
  emptyEnrollPasswordDraft,
  enrollPasswordErrorKey,
  parseEnrollPasswordDraft,
  rotateEnrollPasswordDraft,
} from './relay-enroll-password-dialog';

const noop = (): void => undefined;

function draft(patch: Partial<EnrollPasswordDraft> = {}): EnrollPasswordDraft {
  return { ...emptyEnrollPasswordDraft(), ...patch };
}

describe('parseEnrollPasswordDraft', () => {
  test('已知：省略 current；空 next 即清除；默认 keep', () => {
    expect(parseEnrollPasswordDraft(draft(), true)).toEqual({
      ok: true,
      next: null,
      mode: 'keep',
    });
    expect(parseEnrollPasswordDraft(draft({ next: 'abcdefgh', kick: true }), true)).toEqual({
      ok: true,
      next: 'abcdefgh',
      mode: 'kick',
    });
  });

  test('未知：带上 current（可空）', () => {
    expect(parseEnrollPasswordDraft(draft({ current: 'old', next: 'newpassw' }), false)).toEqual({
      ok: true,
      current: 'old',
      next: 'newpassw',
      mode: 'keep',
    });
    expect(parseEnrollPasswordDraft(draft({ current: '' }), false)).toEqual({
      ok: true,
      current: '',
      next: null,
      mode: 'keep',
    });
  });

  test('非空新密码短于 8 位拒绝', () => {
    expect(parseEnrollPasswordDraft(draft({ next: 'short' }), true)).toEqual({
      ok: false,
      errorKey: 'relay.tenant.enrollPassword.errors.relay_password_too_short',
    });
  });
});

describe('enrollPasswordErrorKey', () => {
  test('契约错误码映射到 enrollPassword.errors.*，大小写不敏感', () => {
    expect(enrollPasswordErrorKey(new RelayApiError('relay_password_invalid', 'x', 401))).toBe(
      'relay.tenant.enrollPassword.errors.relay_password_invalid'
    );
    expect(enrollPasswordErrorKey(new RelayApiError('RELAY_PASSWORD_INVALID', 'x', 401))).toBe(
      'relay.tenant.enrollPassword.errors.relay_password_invalid'
    );
    expect(enrollPasswordErrorKey(new RelayApiError('relay_password_too_short', 'x', 400))).toBe(
      'relay.tenant.enrollPassword.errors.relay_password_too_short'
    );
    expect(enrollPasswordErrorKey(new RelayApiError('relay_members_offline', 'x', 409))).toBe(
      'relay.tenant.enrollPassword.errors.relay_members_offline'
    );
    expect(enrollPasswordErrorKey(new RelayApiError('relay_not_attached', 'x', 409))).toBe(
      'relay.tenant.enrollPassword.errors.relay_not_attached'
    );
    expect(enrollPasswordErrorKey(new RelayApiError('whatever', 'x', 500))).toBe(
      'relay.tenant.enrollPassword.errors.relay_unreachable'
    );
  });
});

describe('rotateEnrollPasswordDraft', () => {
  test('成功：把 url / next / mode 交给 rotateEnrollPassword', async () => {
    const calls: unknown[] = [];
    const api = {
      rotateEnrollPassword: (body: unknown) => {
        calls.push(body);
        return Promise.resolve({ ok: true, passwordEpoch: 3 });
      },
    } as unknown as RelayTenantApi;
    const result = await rotateEnrollPasswordDraft(
      'https://r.example',
      draft({ next: 'newpassw', kick: true }),
      true,
      api
    );
    expect(result).toEqual({ ok: true, cleared: false });
    expect(calls).toEqual([{ url: 'https://r.example', next: 'newpassw', mode: 'kick' }]);
  });

  test('未知时带 current；空 next 为清除', async () => {
    const calls: unknown[] = [];
    const api = {
      rotateEnrollPassword: (body: unknown) => {
        calls.push(body);
        return Promise.resolve({ ok: true, passwordEpoch: 4 });
      },
    } as unknown as RelayTenantApi;
    const result = await rotateEnrollPasswordDraft(
      'https://r.example',
      draft({ current: 'old' }),
      false,
      api
    );
    expect(result).toEqual({ ok: true, cleared: true });
    expect(calls).toEqual([{ url: 'https://r.example', current: 'old', next: null, mode: 'keep' }]);
  });

  test('提交前校验失败不发请求', async () => {
    let called = 0;
    const api = {
      rotateEnrollPassword: () => {
        called += 1;
        return Promise.resolve({ ok: true, passwordEpoch: 1 });
      },
    } as unknown as RelayTenantApi;
    const result = await rotateEnrollPasswordDraft(
      'https://r.example',
      draft({ next: 'short' }),
      true,
      api
    );
    expect(result).toEqual({
      ok: false,
      errorKey: 'relay.tenant.enrollPassword.errors.relay_password_too_short',
    });
    expect(called).toBe(0);
  });

  test('服务端错误映射到 errors.*', async () => {
    const api = {
      rotateEnrollPassword: () =>
        Promise.reject(new RelayApiError('relay_password_invalid', 'bad', 401)),
    } as unknown as RelayTenantApi;
    expect(
      await rotateEnrollPasswordDraft('https://r.example', draft({ next: 'abcdefgh' }), true, api)
    ).toEqual({
      ok: false,
      errorKey: 'relay.tenant.enrollPassword.errors.relay_password_invalid',
    });
  });
});

describe('RelayEnrollPasswordDialogBody', () => {
  test('未知：当前密码字段出现', () => {
    const html = renderToStaticMarkup(
      <RelayEnrollPasswordDialogBody
        draft={draft()}
        known={false}
        errorKey={null}
        busy={false}
        onChange={noop}
      />
    );
    expect(html).toContain('data-testid="nodes-relay-enroll-password-body"');
    expect(html).toContain('data-testid="nodes-relay-enroll-password-current"');
    expect(html).toContain('data-testid="nodes-relay-enroll-password-next"');
    expect(html).toContain('data-testid="nodes-relay-enroll-password-kick"');
    expect(html).not.toContain('data-testid="nodes-relay-enroll-password-error"');
  });

  test('已知：隐藏当前密码字段', () => {
    const html = renderToStaticMarkup(
      <RelayEnrollPasswordDialogBody
        draft={draft()}
        known
        errorKey={null}
        busy={false}
        onChange={noop}
      />
    );
    expect(html).not.toContain('data-testid="nodes-relay-enroll-password-current"');
    expect(html).toContain('data-testid="nodes-relay-enroll-password-next"');
    expect(html).toContain('data-testid="nodes-relay-enroll-password-next-generate"');
  });

  test('提交失败时正文摆错误', () => {
    const html = renderToStaticMarkup(
      <RelayEnrollPasswordDialogBody
        draft={draft()}
        known
        errorKey="relay.tenant.enrollPassword.errors.relay_password_invalid"
        busy={false}
        onChange={noop}
      />
    );
    expect(html).toContain('data-testid="nodes-relay-enroll-password-error"');
    expect(html).toContain('relay.tenant.enrollPassword.errors.relay_password_invalid');
  });
});
