import { describe, expect, test } from 'bun:test';
import { createLoginRedirect } from './login-redirect';

interface Harness {
  navigated: string[];
  kept: number[];
  redirect: (to: string) => void;
  settle: () => void;
  setSession: (present: boolean) => void;
  setTransition: (active: boolean) => void;
}

function harness(init: { pending?: boolean; session?: boolean } = {}): Harness {
  const navigated: string[] = [];
  const kept: number[] = [];
  let pending = init.pending ?? false;
  let session = init.session ?? true;
  let transition = false;
  let release: (() => void) | null = null;
  const settled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const redirect = createLoginRedirect({
    navigate: (to) => navigated.push(to),
    authTransitionActive: () => transition,
    onSessionKept: () => kept.push(1),
    replacementPending: () => pending,
    replacementSettled: () => settled,
    sessionPresent: () => session,
  });
  return {
    navigated,
    kept,
    redirect,
    settle: () => {
      pending = false;
      release?.();
    },
    setSession: (value) => {
      session = value;
    },
    setTransition: (value) => {
      transition = value;
    },
  };
}

describe('createLoginRedirect', () => {
  test('平时直接跳登录页', () => {
    const h = harness();
    h.redirect('/login?next=%2Fdevices');
    expect(h.navigated).toEqual(['/login?next=%2Fdevices']);
  });

  test('退出 mesh 期间压住不跳', () => {
    const h = harness();
    h.setTransition(true);
    h.redirect('/login');
    expect(h.navigated).toEqual([]);
  });

  test('两阶段会话替换期间不跳；替换成功后仍然不跳', async () => {
    const h = harness({ pending: true });
    h.redirect('/login?next=%2Fsettings');
    expect(h.navigated).toEqual([]);

    h.settle();
    await Promise.resolve();
    await Promise.resolve();
    // 新会话被接受（或旧会话原样装回）：用户手上还有会话，不该被踢去登录页，
    // 但被那次 401 / 4401 拆掉的连接要重新拉起来。
    expect(h.navigated).toEqual([]);
    expect(h.kept).toEqual([1]);
  });

  test('替换落定后手上真没会话了，才补这一跳', async () => {
    const h = harness({ pending: true });
    h.redirect('/login?next=%2Fsettings');
    h.setSession(false);
    h.settle();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.navigated).toEqual(['/login?next=%2Fsettings']);
    expect(h.kept).toEqual([]);
  });

  test('挂起期间用户已进入退出 mesh 流程：补跳也要压住', async () => {
    const h = harness({ pending: true });
    h.redirect('/login');
    h.setSession(false);
    h.setTransition(true);
    h.settle();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.navigated).toEqual([]);
  });
});
