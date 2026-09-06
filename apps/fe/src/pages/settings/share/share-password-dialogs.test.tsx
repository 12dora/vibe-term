// 改密码的提交载荷与失败形态，以及两个对话框正文的静态渲染。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与设置页其余用例同一套做法）；
// 没有 i18next 实例时 `t` 原样返回 key，因此断言的是 key 与 testId。

import { afterEach, describe, expect, test } from 'bun:test';
import { ApiError } from '@tmex/api-client';
import { SHARE_PASSWORD_MIN_LENGTH } from '@tmex/shared/share';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const {
  ChangeSharePasswordBody,
  ViewSharePasswordBody,
  copyShareLinkWithPassword,
  submitSharePasswordChange,
  validateSharePasswordDraft,
} = await import('./share-password-dialogs');

const t = (key: string) => key;

function apiError(code: string, status = 409): ApiError {
  return new ApiError(status, code, { code });
}

describe('validateSharePasswordDraft', () => {
  test('短于下限即拒，错误带上下限供文案插值', () => {
    expect(validateSharePasswordDraft({ password: 'short', endSessions: false })).toEqual({
      key: 'share.error.passwordTooShort',
      params: { min: SHARE_PASSWORD_MIN_LENGTH },
    });
    // 纯空白等同于空
    expect(validateSharePasswordDraft({ password: '        ', endSessions: false })).not.toBeNull();
    expect(validateSharePasswordDraft({ password: 'Ab3dEf7h', endSessions: false })).toBeNull();
  });
});

describe('submitSharePasswordChange', () => {
  function recorder(ended = 0) {
    const calls: Array<[string, string, boolean]> = [];
    const change = (shareId: string, password: string, endSessions: boolean) => {
      calls.push([shareId, password, endSessions]);
      return Promise.resolve(ended);
    };
    return { calls, change };
  }

  test('不勾「断开观看者」时 endSessions 为 false，密码去掉首尾空白', async () => {
    const { calls, change } = recorder();
    const failure = await submitSharePasswordChange(
      'sh1',
      { password: '  Ab3dEf7h  ', endSessions: false },
      change,
      t
    );
    expect(failure).toBeNull();
    expect(calls).toEqual([['sh1', 'Ab3dEf7h', false]]);
  });

  test('勾了就把 endSessions 一并送上去', async () => {
    const { calls, change } = recorder(3);
    expect(
      await submitSharePasswordChange('sh1', { password: 'Ab3dEf7h', endSessions: true }, change, t)
    ).toBeNull();
    expect(calls).toEqual([['sh1', 'Ab3dEf7h', true]]);
  });

  test('密码太短就地拒掉，请求根本不发', async () => {
    const { calls, change } = recorder();
    expect(
      await submitSharePasswordChange('sh1', { password: 'ab', endSessions: false }, change, t)
    ).toEqual({
      key: 'share.error.passwordTooShort',
      params: { min: SHARE_PASSWORD_MIN_LENGTH },
    });
    expect(calls).toHaveLength(0);
  });

  test('服务端失败原样翻成 key 摆回对话框', async () => {
    const failure = await submitSharePasswordChange(
      'sh1',
      { password: 'Ab3dEf7h', endSessions: false },
      () => Promise.reject(apiError('SHARE_ENDED')),
      t
    );
    expect(failure).toEqual({ key: 'share.error.SHARE_ENDED' });
  });
});

describe('copyShareLinkWithPassword', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  function stubClipboard() {
    const written: string[] = [];
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        clipboard: {
          writeText: (text: string) => {
            written.push(text);
            return Promise.resolve();
          },
        },
      },
      configurable: true,
      writable: true,
    });
    return written;
  }

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });

  const share = {
    id: 'sh1',
    url: 'https://tmex.example.com/s/sh1',
  } as Parameters<typeof copyShareLinkWithPassword>[0];

  test('先取密码，再把带密码的链接写进剪贴板', async () => {
    const written = stubClipboard();
    await copyShareLinkWithPassword(share, (id) => Promise.resolve(`pw-${id}`), t);
    expect(written).toEqual(['https://tmex.example.com/s/sh1#p=pw-sh1']);
  });

  test('旧分享取不到密码时什么都不复制', async () => {
    const written = stubClipboard();
    await copyShareLinkWithPassword(
      share,
      () => Promise.reject(apiError('SHARE_PASSWORD_UNAVAILABLE')),
      t
    );
    expect(written).toEqual([]);
  });
});

describe('ViewSharePasswordBody', () => {
  test('缺省遮罩，明文只在点了「显示」之后才出现', () => {
    const html = renderToStaticMarkup(
      <ViewSharePasswordBody value={{ loading: false, password: 'Ab3dEf7h', errorKey: null }} />
    );
    expect(html).toContain('data-testid="share-password-value"');
    expect(html).toContain('••••••••');
    expect(html).not.toContain('Ab3dEf7h');
    expect(html).toContain('data-testid="share-password-reveal"');
    expect(html).toContain('data-testid="share-password-copy"');
  });

  test('旧分享给「只能改」的说明，而不是笼统的操作失败', () => {
    const html = renderToStaticMarkup(
      <ViewSharePasswordBody
        value={{
          loading: false,
          password: null,
          errorKey: 'settings.share.active.passwordHidden',
        }}
      />
    );
    expect(html).toContain('data-testid="share-password-unavailable"');
    expect(html).toContain('settings.share.active.passwordHidden');
  });

  test('取密码期间只出转圈', () => {
    const html = renderToStaticMarkup(
      <ViewSharePasswordBody value={{ loading: true, password: null, errorKey: null }} />
    );
    expect(html).toContain('data-testid="share-password-loading"');
    expect(html).not.toContain('data-testid="share-password-value"');
  });
});

describe('ChangeSharePasswordBody', () => {
  test('新密码输入、生成按钮与断开观看者的勾选各就各位', () => {
    const html = renderToStaticMarkup(
      <ChangeSharePasswordBody
        draft={{ password: 'Ab3dEf7h', endSessions: false }}
        error={null}
        onChange={() => undefined}
      />
    );
    expect(html).toContain('data-testid="share-change-password-input"');
    expect(html).toContain('value="Ab3dEf7h"');
    expect(html).toContain('data-testid="share-change-password-generate"');
    expect(html).toContain('data-testid="share-change-password-end-sessions"');
    expect(html).toContain('settings.share.active.endSessionsHint');
    expect(html).not.toContain('data-testid="share-change-password-error"');
  });

  test('校验失败就地摆出原因', () => {
    const html = renderToStaticMarkup(
      <ChangeSharePasswordBody
        draft={{ password: 'ab', endSessions: true }}
        error={{ key: 'share.error.passwordTooShort', params: { min: SHARE_PASSWORD_MIN_LENGTH } }}
        onChange={() => undefined}
      />
    );
    expect(html).toContain('data-testid="share-change-password-error"');
    expect(html).toContain('share.error.passwordTooShort');
  });
});
