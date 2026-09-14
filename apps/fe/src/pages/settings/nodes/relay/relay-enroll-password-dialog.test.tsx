// 租户侧修改接入密码：草稿校验、提交成功/失败、正文已知/未知。无 DOM，静态渲染。

import { describe, expect, test } from 'bun:test';
import { RelayApiError } from '@vibeterm/api-client/relay/admin-api';
import type { RelayTenantApi } from '@vibeterm/api-client/relay/tenant-api';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  type EnrollPasswordDraft,
  RelayEnrollPasswordDialogBody,
  emptyEnrollPasswordDraft,
  enrollPasswordError,
  enrollPasswordErrorKey,
  parseEnrollPasswordDraft,
  rotateEnrollPasswordDraft,
} from './relay-enroll-password-dialog';

const noop = (): void => undefined;

function draft(patch: Partial<EnrollPasswordDraft> = {}): EnrollPasswordDraft {
  return { ...emptyEnrollPasswordDraft(), ...patch };
}

describe('parseEnrollPasswordDraft', () => {
  test('已知：空 next 且未勾选清除是校验错误', () => {
    expect(parseEnrollPasswordDraft(draft(), true)).toEqual({
      ok: false,
      errorKey: 'relay.tenant.enrollPassword.errors.next_required',
    });
  });

  test('已知：勾选清除后空 next 才是清除', () => {
    expect(parseEnrollPasswordDraft(draft({ clear: true }), true)).toEqual({
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

  test('未知：当前密码必填', () => {
    expect(parseEnrollPasswordDraft(draft({ current: '', next: 'newpassw' }), false)).toEqual({
      ok: false,
      errorKey: 'relay.tenant.enrollPassword.errors.current_required',
    });
    expect(parseEnrollPasswordDraft(draft({ current: 'old', next: 'newpassw' }), false)).toEqual({
      ok: true,
      current: 'old',
      next: 'newpassw',
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
    expect(enrollPasswordErrorKey(new RelayApiError('RELAY_RATE_LIMITED', 'x', 429))).toBe(
      'relay.tenant.enrollPassword.errors.relay_rate_limited'
    );
    expect(enrollPasswordErrorKey(new RelayApiError('UNAUTHORIZED', 'x', 401))).toBe(
      'relay.tenant.enrollPassword.errors.unauthorized'
    );
    expect(enrollPasswordErrorKey(new RelayApiError('RELAY_UNAUTHORIZED', 'x', 401))).toBe(
      'relay.tenant.enrollPassword.errors.unauthorized'
    );
    expect(enrollPasswordErrorKey(new RelayApiError('MALFORMED', 'x', 400))).toBe(
      'relay.tenant.enrollPassword.errors.malformed'
    );
    expect(enrollPasswordErrorKey(new RelayApiError('INVALID_URL', 'x', 400))).toBe(
      'relay.tenant.enrollPassword.errors.malformed'
    );
    expect(enrollPasswordErrorKey(new RelayApiError('whatever', 'x', 500))).toBe(
      'relay.tenant.enrollPassword.errors.relay_unreachable'
    );
    expect(enrollPasswordError(new RelayApiError('whatever', 'x', 400))).toEqual({
      key: 'relay.tenant.enrollPassword.errors.unknown',
      params: { code: 'whatever' },
    });
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

  test('未勾选清除的空 next 不发请求', async () => {
    let called = 0;
    const api = {
      rotateEnrollPassword: () => {
        called += 1;
        return Promise.resolve({ ok: true, passwordEpoch: 1 });
      },
    } as unknown as RelayTenantApi;
    const result = await rotateEnrollPasswordDraft('https://r.example', draft(), true, api);
    expect(result).toEqual({
      ok: false,
      key: 'relay.tenant.enrollPassword.errors.next_required',
    });
    expect(called).toBe(0);
  });

  test('未知时带 current；勾选清除后空 next 为清除', async () => {
    const calls: unknown[] = [];
    const api = {
      rotateEnrollPassword: (body: unknown) => {
        calls.push(body);
        return Promise.resolve({ ok: true, passwordEpoch: 4 });
      },
    } as unknown as RelayTenantApi;
    const result = await rotateEnrollPasswordDraft(
      'https://r.example',
      draft({ current: 'old', clear: true }),
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
      key: 'relay.tenant.enrollPassword.errors.relay_password_too_short',
    });
    expect(called).toBe(0);
  });

  test('服务端错误映射到 errors.*；用本机副本改密被拒时标记 storedRejected', async () => {
    const api = {
      rotateEnrollPassword: () =>
        Promise.reject(new RelayApiError('relay_password_invalid', 'bad', 401)),
    } as unknown as RelayTenantApi;
    expect(
      await rotateEnrollPasswordDraft('https://r.example', draft({ next: 'abcdefgh' }), true, api)
    ).toEqual({
      ok: false,
      key: 'relay.tenant.enrollPassword.errors.relay_password_invalid',
      storedRejected: true,
    });
    expect(
      await rotateEnrollPasswordDraft(
        'https://r.example',
        draft({ current: 'oldpass', next: 'abcdefgh' }),
        false,
        api
      )
    ).toEqual({
      ok: false,
      key: 'relay.tenant.enrollPassword.errors.relay_password_invalid',
      storedRejected: false,
    });
  });

  test('relay_password_unset 与带人数的 relay_members_offline', async () => {
    const unset = {
      rotateEnrollPassword: () =>
        Promise.reject(new RelayApiError('relay_password_unset', 'unset', 409)),
    } as unknown as RelayTenantApi;
    expect(
      await rotateEnrollPasswordDraft('https://r.example', draft({ next: 'abcdefgh' }), true, unset)
    ).toMatchObject({ ok: false, key: 'relay.tenant.enrollPassword.errors.relay_password_unset' });
    const offline = {
      rotateEnrollPassword: () =>
        Promise.reject(
          new RelayApiError('relay_members_offline', 'offline', 409, { online: 2, admitted: 5 })
        ),
    } as unknown as RelayTenantApi;
    expect(
      await rotateEnrollPasswordDraft(
        'https://r.example',
        draft({ next: 'abcdefgh', kick: true }),
        true,
        offline
      )
    ).toMatchObject({
      ok: false,
      key: 'relay.tenant.enrollPassword.errors.relay_members_offline_counted',
      params: { online: '2', admitted: '5' },
    });
  });
});

describe('RelayEnrollPasswordDialogBody', () => {
  test('未知：当前密码字段出现', () => {
    const html = renderToStaticMarkup(
      <RelayEnrollPasswordDialogBody
        draft={draft()}
        known={false}
        error={null}
        busy={false}
        onChange={noop}
      />
    );
    expect(html).toContain('data-testid="nodes-relay-enroll-password-body"');
    expect(html).toContain('data-testid="nodes-relay-enroll-password-current"');
    expect(html).toContain('data-testid="nodes-relay-enroll-password-next"');
    expect(html).toContain('data-testid="nodes-relay-enroll-password-clear"');
    expect(html).toContain('data-testid="nodes-relay-enroll-password-kick"');
    expect(html).not.toContain('data-testid="nodes-relay-enroll-password-error"');
  });

  test('已知：隐藏当前密码字段', () => {
    const html = renderToStaticMarkup(
      <RelayEnrollPasswordDialogBody
        draft={draft()}
        known
        error={null}
        busy={false}
        onChange={noop}
      />
    );
    expect(html).not.toContain('data-testid="nodes-relay-enroll-password-current"');
    expect(html).toContain('data-testid="nodes-relay-enroll-password-next"');
    expect(html).toContain('data-testid="nodes-relay-enroll-password-next-generate"');
    expect(html).toContain('data-testid="nodes-relay-enroll-password-clear"');
  });

  test('提交失败时正文摆错误', () => {
    const html = renderToStaticMarkup(
      <RelayEnrollPasswordDialogBody
        draft={draft()}
        known
        error={{ key: 'relay.tenant.enrollPassword.errors.relay_password_invalid' }}
        busy={false}
        onChange={noop}
      />
    );
    expect(html).toContain('data-testid="nodes-relay-enroll-password-error"');
    expect(html).toContain('relay.tenant.enrollPassword.errors.relay_password_invalid');
  });
});
