// 「链接中包含密码」的作废语义：关窗/换分享必须真的丢掉状态，在途请求必须认领失败。
// 无 DOM 测试环境，这里测的是 hook 用的那台状态机本身。

import { describe, expect, test } from 'bun:test';
import {
  type LinkPasswordState,
  claimLinkPassword,
  claimOf,
  idleLinkPassword,
  linkPasswordKey,
  projectLinkPassword,
} from './share-link-password-state';

const OPEN_A = linkPasswordKey(true, 'sh-a');
const CLOSED_A = linkPasswordKey(false, 'sh-a');
const OPEN_B = linkPasswordKey(true, 'sh-b');

function included(key: string, gen = 0, fetched = 'pw-a'): LinkPasswordState {
  return { ...idleLinkPassword(key, gen), include: true, fetched };
}

describe('projectLinkPassword', () => {
  test('key 相同时原样返回（同一次弹窗里的勾选要保住）', () => {
    const state = included(OPEN_A);
    expect(projectLinkPassword(state, OPEN_A)).toBe(state);
  });

  test('关掉再打开同一条分享：勾选与已取回的明文都不复活', () => {
    const opened = included(OPEN_A);
    const closed = projectLinkPassword(opened, CLOSED_A);
    expect(closed).toEqual(idleLinkPassword(CLOSED_A, 1));
    // 关窗那一步已经把状态换掉了，重开时拿到的是 closed 而不是 opened
    const reopened = projectLinkPassword(closed, OPEN_A);
    expect(reopened.include).toBe(false);
    expect(reopened.fetched).toBeNull();
    expect(reopened.gen).toBe(2);
  });

  test('A → B → A：每次换分享都推进代号，key 相等也不会认回旧状态', () => {
    const a1 = included(OPEN_A);
    const b = projectLinkPassword(a1, OPEN_B);
    const a2 = projectLinkPassword(b, OPEN_A);
    expect(b.gen).toBe(1);
    expect(a2.gen).toBe(2);
    expect(a2.key).toBe(OPEN_A);
    expect(a2.fetched).toBeNull();
    expect(a2.include).toBe(false);
  });
});

describe('claimLinkPassword', () => {
  test('key 与代号都对上才落地', () => {
    const state = idleLinkPassword(OPEN_A);
    const claim = claimOf(state);
    const next = claimLinkPassword({ ...state, loading: true }, claim, {
      fetched: 'pw-a',
      loading: false,
    });
    expect(next.fetched).toBe('pw-a');
    expect(next.loading).toBe(false);
  });

  test('关窗之后到达的响应被丢掉（key 与代号都不对）', () => {
    const opened = { ...idleLinkPassword(OPEN_A), include: true, loading: true };
    const claim = claimOf(opened);
    const closed = projectLinkPassword(opened, CLOSED_A);
    const after = claimLinkPassword(closed, claim, { fetched: 'pw-a', loading: false });
    expect(after).toBe(closed);
    expect(after.fetched).toBeNull();
  });

  test('A → B → A 之后，第一轮 A 的响应不会落到第三轮 A 上', () => {
    const a1 = { ...idleLinkPassword(OPEN_A), include: true, loading: true };
    const claim = claimOf(a1);
    const a2 = projectLinkPassword(projectLinkPassword(a1, OPEN_B), OPEN_A);
    expect(claim.key).toBe(a2.key);
    expect(claimLinkPassword(a2, claim, { fetched: 'pw-a', loading: false })).toBe(a2);
  });

  test('失败的响应同样按代号认领，过期的不许把 include 掰回去', () => {
    const a1 = { ...idleLinkPassword(OPEN_A), include: true, loading: true };
    const claim = claimOf(a1);
    const live = claimLinkPassword(a1, claim, {
      include: false,
      loading: false,
      error: 'share.error.SHARE_NOT_FOUND',
    });
    expect(live.error).toBe('share.error.SHARE_NOT_FOUND');
    expect(live.include).toBe(false);

    const b = projectLinkPassword(a1, OPEN_B);
    const stale = claimLinkPassword(b, claim, {
      include: false,
      loading: false,
      error: 'share.error.SHARE_NOT_FOUND',
    });
    expect(stale).toBe(b);
    expect(stale.error).toBeNull();
  });
});
