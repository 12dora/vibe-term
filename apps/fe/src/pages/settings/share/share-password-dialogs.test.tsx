// 改密码的提交载荷与失败形态、「复制带密码的链接」的两条剪贴板路径，以及两个对话框正文的静态渲染。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与设置页其余用例同一套做法）。
// 渲染结果一概只断言结构（testId 与自带常量）：同进程里别的用例会初始化 react-i18next，
// `t` 的产出因此单跑与合跑并不一致，断言 key 会在合跑时崩（与 site-url-candidates.test.tsx 同因）。

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
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalItem = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');

  function setNavigator(clipboard: unknown) {
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard },
      configurable: true,
      writable: true,
    });
  }

  /** Safari 那条路：`clipboard.write` + `ClipboardItem`，收 `Promise<Blob>`。 */
  function stubAsyncClipboard() {
    const state = { writes: 0, written: [] as string[] };
    class FakeClipboardItem {
      constructor(readonly items: Record<string, Blob | PromiseLike<Blob>>) {}
    }
    Object.defineProperty(globalThis, 'ClipboardItem', {
      value: FakeClipboardItem,
      configurable: true,
      writable: true,
    });
    setNavigator({
      write: async (items: FakeClipboardItem[]) => {
        state.writes += 1;
        const blob = await items[0]?.items['text/plain'];
        if (blob) state.written.push(await blob.text());
      },
      writeText: () => Promise.reject(new Error('should not be used')),
    });
    return state;
  }

  /** 老浏览器那条路：只有 `writeText`。 */
  function stubTextClipboard() {
    const written: string[] = [];
    Reflect.deleteProperty(globalThis, 'ClipboardItem');
    setNavigator({
      writeText: (text: string) => {
        written.push(text);
        return Promise.resolve();
      },
    });
    return written;
  }

  afterEach(() => {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    if (originalItem) Object.defineProperty(globalThis, 'ClipboardItem', originalItem);
    else Reflect.deleteProperty(globalThis, 'ClipboardItem');
  });

  const share = {
    id: 'sh1',
    url: 'https://tmex.example.com/s/sh1',
  } as Parameters<typeof copyShareLinkWithPassword>[0];

  test('有 ClipboardItem 时点下去就发起写入，不等取密码——手势不能丢在 await 里', async () => {
    const state = stubAsyncClipboard();
    let release!: (password: string) => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const done = copyShareLinkWithPassword(share, () => pending, t);
    // 同步这一刻写入就已经发起：密码还没回来。
    expect(state.writes).toBe(1);
    expect(state.written).toEqual([]);
    release('pw-sh1');
    await done;
    expect(state.written).toEqual(['https://tmex.example.com/s/sh1#p=pw-sh1']);
  });

  test('没有 ClipboardItem 时退回「取完再写」', async () => {
    const written = stubTextClipboard();
    await copyShareLinkWithPassword(share, (id) => Promise.resolve(`pw-${id}`), t);
    expect(written).toEqual(['https://tmex.example.com/s/sh1#p=pw-sh1']);
  });

  test('旧分享取不到密码时什么都不复制，也不去开「查看密码」（那儿同样看不到）', async () => {
    const written = stubTextClipboard();
    let manual = 0;
    await copyShareLinkWithPassword(
      share,
      () => Promise.reject(apiError('SHARE_PASSWORD_UNAVAILABLE')),
      t,
      {
        onManualCopy: () => {
          manual += 1;
        },
      }
    );
    expect(written).toEqual([]);
    expect(manual).toBe(0);
  });

  test('密码到手但剪贴板拒了：打开「查看密码」让人自己抄', async () => {
    Reflect.deleteProperty(globalThis, 'ClipboardItem');
    setNavigator({ writeText: () => Promise.reject(new Error('denied')) });
    let manual = 0;
    await copyShareLinkWithPassword(share, (id) => Promise.resolve(`pw-${id}`), t, {
      onManualCopy: () => {
        manual += 1;
      },
    });
    expect(manual).toBe(1);
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
    expect(html).not.toContain('data-testid="share-password-value"');
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
  });
});
