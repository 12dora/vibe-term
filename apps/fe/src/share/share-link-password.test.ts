// 链接里的密码：拼进去与读出来必须严格互逆，否则被分享人拿到的是一个填错密码的表单。

import { describe, expect, test } from 'bun:test';
import {
  EMPTY_SHARE_LINK_PREFILL,
  type ShareLinkPrefill,
  advanceShareLinkPrefill,
  buildShareLinkWithPassword,
  consumeHashPassword,
  consumeShareLinkFragment,
  readPasswordFromHash,
} from './share-link-password';

describe('buildShareLinkWithPassword', () => {
  test('密码拼在 fragment 里', () => {
    expect(buildShareLinkWithPassword('https://a.example/s/s1', 'Ab3dEf7h')).toBe(
      'https://a.example/s/s1#p=Ab3dEf7h'
    );
  });

  test('转义 fragment 与 query 分隔符，密码里的 & # + 空格不会拼坏链接', () => {
    expect(buildShareLinkWithPassword('https://a.example/s/s1', 'a&b#c d+e')).toBe(
      'https://a.example/s/s1#p=a%26b%23c%20d%2Be'
    );
  });

  test('覆盖原有 fragment，不叠加', () => {
    expect(buildShareLinkWithPassword('https://a.example/s/s1#p=old', 'new')).toBe(
      'https://a.example/s/s1#p=new'
    );
  });

  test('空密码原样返回', () => {
    expect(buildShareLinkWithPassword('https://a.example/s/s1', '')).toBe('https://a.example/s/s1');
  });
});

describe('readPasswordFromHash', () => {
  test('读出 #p=，带不带 # 前缀都认', () => {
    expect(readPasswordFromHash('#p=Ab3dEf7h')).toBe('Ab3dEf7h');
    expect(readPasswordFromHash('p=Ab3dEf7h')).toBe('Ab3dEf7h');
  });

  test('与其它 fragment 参数共存时仍能取到', () => {
    expect(readPasswordFromHash('#x=1&p=Ab3dEf7h')).toBe('Ab3dEf7h');
    expect(readPasswordFromHash('#p=Ab3dEf7h&x=1')).toBe('Ab3dEf7h');
  });

  test('解码回原文，`+` 不被当成空格', () => {
    expect(readPasswordFromHash('#p=a%26b%23c%20d%2Be')).toBe('a&b#c d+e');
  });

  test('没有密码、空值或坏转义都返回 null', () => {
    expect(readPasswordFromHash('')).toBeNull();
    expect(readPasswordFromHash('#')).toBeNull();
    expect(readPasswordFromHash('#x=1')).toBeNull();
    expect(readPasswordFromHash('#p=')).toBeNull();
    expect(readPasswordFromHash('#p=%E0%A4%A')).toBeNull();
    // 前缀相同但不是 `p` 的参数不能误命中
    expect(readPasswordFromHash('#pw=secret')).toBeNull();
  });

  test('与拼装严格互逆', () => {
    for (const password of ['Ab3dEf7h', 'a b', '中文密码', '%%%', 'a&b=c#d']) {
      const url = buildShareLinkWithPassword('https://a.example/s/s1', password);
      expect(readPasswordFromHash(url.slice(url.indexOf('#')))).toBe(password);
    }
  });
});

describe('consumeHashPassword', () => {
  test('读出密码，并给出抹掉 fragment 之后的地址（query 保留）', () => {
    expect(
      consumeHashPassword({ pathname: '/s/sh1', search: '?from=mail', hash: '#p=Ab3dEf7h' })
    ).toEqual({ password: 'Ab3dEf7h', cleanedUrl: '/s/sh1?from=mail' });
  });

  test('没有 fragment 就不必动 history', () => {
    expect(consumeHashPassword({ pathname: '/s/sh1', search: '', hash: '' })).toEqual({
      password: null,
      cleanedUrl: null,
    });
  });

  test('fragment 不是密码（或坏转义）也照样抹掉', () => {
    expect(consumeHashPassword({ pathname: '/s/sh1', search: '', hash: '#x=1' })).toEqual({
      password: null,
      cleanedUrl: '/s/sh1',
    });
    expect(consumeHashPassword({ pathname: '/s/sh1', search: '', hash: '#p=%E0%A4%A' })).toEqual({
      password: null,
      cleanedUrl: '/s/sh1',
    });
  });
});

describe('consumeShareLinkFragment', () => {
  function fakeHistory(state: unknown = { idx: 3 }) {
    const calls: Array<[unknown, string]> = [];
    return {
      calls,
      history: {
        state,
        replaceState: (next: unknown, _unused: string, url: string) => {
          calls.push([next, url]);
        },
      },
    };
  }

  test('抹地址栏时原样带回 history.state', () => {
    const { calls, history } = fakeHistory();
    expect(
      consumeShareLinkFragment({ pathname: '/n/n1/s/sh1', search: '', hash: '#p=pw1' }, history)
    ).toBe('pw1');
    expect(calls).toEqual([[{ idx: 3 }, '/n/n1/s/sh1']]);
  });

  test('没有 fragment 时一次 replaceState 都不发', () => {
    const { calls, history } = fakeHistory();
    expect(
      consumeShareLinkFragment({ pathname: '/s/sh1', search: '', hash: '' }, history)
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  test('同文档内换到下一条带密码的链接：新密码照样读走并抹掉', () => {
    const { calls, history } = fakeHistory(null);
    consumeShareLinkFragment({ pathname: '/s/sh1', search: '', hash: '#p=first' }, history);
    expect(
      consumeShareLinkFragment({ pathname: '/s/sh2', search: '', hash: '#p=second' }, history)
    ).toBe('second');
    expect(calls.map(([, url]) => url)).toEqual(['/s/sh1', '/s/sh2']);
  });
});

describe('advanceShareLinkPrefill', () => {
  function drive(hashes: string[]): ShareLinkPrefill {
    let prefill = EMPTY_SHARE_LINK_PREFILL;
    for (const hash of hashes) {
      prefill = advanceShareLinkPrefill(prefill, readPasswordFromHash(hash));
    }
    return prefill;
  }

  test('没有密码可填、原本也没填过时原样返回，表单不白重挂', () => {
    expect(advanceShareLinkPrefill(EMPTY_SHARE_LINK_PREFILL, null)).toBe(EMPTY_SHARE_LINK_PREFILL);
    expect(drive(['', '#x=1'])).toEqual(EMPTY_SHARE_LINK_PREFILL);
  });

  test('每读到一次新密码就换一次 seq，让表单带着新预填重挂', () => {
    expect(drive(['#p=first'])).toEqual({ password: 'first', seq: 1 });
    expect(drive(['#p=first', '#p=second'])).toEqual({ password: 'second', seq: 2 });
  });

  test('换到没有密码的链接时清掉旧预填，旧密码不会留在下一条分享的表单里', () => {
    expect(drive(['#p=first', ''])).toEqual({ password: undefined, seq: 2 });
  });
});
