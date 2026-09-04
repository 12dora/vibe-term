// 「本机作为中继」的提交闸门：谁该先确认、确认 / 取消之后到底发不发请求。
//
// 无 DOM 测试环境点不了按钮，因此判定与状态迁移都在 `become-relay-gate.ts` 里，
// 这里按组件真实的调用顺序驱动它，`submit` 为真时就真的走一次 `submitBecomeRelay`，
// 用记账的 ApiClient 数请求条数。

import { describe, expect, test } from 'bun:test';
import { ApiClient } from '@tmex/api-client';
import {
  type BecomeRelayGateEvent,
  becomeRelayGate,
  pureRelaySubmitPlan,
} from './become-relay-gate';
import { submitBecomeRelay } from './submit';
import type { BecomeRelayValues } from './validation';

function values(overrides: Partial<BecomeRelayValues> = {}): BecomeRelayValues {
  return {
    relayPublicUrl: 'https://relay.example.com',
    relayPassword: 'relay-pass',
    alsoNode: false,
    username: '',
    password: '',
    confirmPassword: '',
    directEnable: true,
    ...overrides,
  };
}

/** 中继兼节点还要建账号，三件套齐了才算有效。 */
function alsoNodeValues(overrides: Partial<BecomeRelayValues> = {}): BecomeRelayValues {
  return values({
    alsoNode: true,
    username: 'alice',
    password: 'hunter2hunter2',
    confirmPassword: 'hunter2hunter2',
    ...overrides,
  });
}

interface Recorded {
  url: string;
  method: string | undefined;
  body: unknown;
}

/**
 * 按组件的真实顺序跑一遍：提交 →（可选）确认 / 取消。返回确认框状态与实际发出的请求。
 * `submit` 为真的每一步都真的调用 `submitBecomeRelay`，条数就是 POST 的条数。
 */
async function drive(
  draft: BecomeRelayValues,
  answer?: 'confirm' | 'cancel'
): Promise<{ confirming: boolean; calls: Recorded[] }> {
  const calls: Recorded[] = [];
  const client = new ApiClient('', (url, init) => {
    calls.push({
      url,
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const payload =
      url === '/healthz'
        ? { startedAt: 1 }
        : { ok: true, role: draft.alsoNode ? 'relay,node' : 'relay', restarting: true };
    return Promise.resolve(
      new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } })
    );
  });

  const run = async (event: BecomeRelayGateEvent): Promise<boolean> => {
    const step = becomeRelayGate(event);
    if (step.submit) await submitBecomeRelay(draft, client);
    return step.confirming;
  };

  let confirming = await run({
    kind: 'submit',
    plan: pureRelaySubmitPlan(draft, 'production'),
  });
  if (answer) confirming = await run({ kind: answer });
  return { confirming, calls: calls.filter((call) => call.url !== '/healthz') };
}

describe('pureRelaySubmitPlan', () => {
  test('草稿有错：只亮错误，既不确认也不提交', () => {
    expect(pureRelaySubmitPlan(values({ relayPublicUrl: '' }), 'production')).toBe('invalid');
    // 中继兼节点缺账号同样无效
    expect(pureRelaySubmitPlan(values({ alsoNode: true }), 'production')).toBe('invalid');
  });

  test('纯中继先确认，中继兼节点直接提交', () => {
    expect(pureRelaySubmitPlan(values(), 'production')).toBe('confirm');
    expect(pureRelaySubmitPlan(alsoNodeValues(), 'production')).toBe('submit');
  });
});

describe('becomeRelayGate', () => {
  test('提交事件按判定分派：无效什么都不做，纯中继开确认框，兼节点直接提交', () => {
    expect(becomeRelayGate({ kind: 'submit', plan: 'invalid' })).toEqual({
      confirming: false,
      submit: false,
    });
    expect(becomeRelayGate({ kind: 'submit', plan: 'confirm' })).toEqual({
      confirming: true,
      submit: false,
    });
    expect(becomeRelayGate({ kind: 'submit', plan: 'submit' })).toEqual({
      confirming: false,
      submit: true,
    });
  });

  test('确认即提交并关框；取消只关框', () => {
    expect(becomeRelayGate({ kind: 'confirm' })).toEqual({ confirming: false, submit: true });
    expect(becomeRelayGate({ kind: 'cancel' })).toEqual({ confirming: false, submit: false });
  });
});

describe('纯中继的提交流程', () => {
  test('草稿有错：不弹确认框，也不发请求', async () => {
    const outcome = await drive(values({ relayPublicUrl: 'http://relay.example.com' }));
    expect(outcome.confirming).toBe(false);
    expect(outcome.calls).toEqual([]);
  });

  test('字段齐全的纯中继：先弹确认框，此刻一条请求都没发', async () => {
    const outcome = await drive(values());
    expect(outcome.confirming).toBe(true);
    expect(outcome.calls).toEqual([]);
  });

  test('取消确认：框关掉，仍然一条请求都没发', async () => {
    const outcome = await drive(values(), 'cancel');
    expect(outcome.confirming).toBe(false);
    expect(outcome.calls).toEqual([]);
  });

  test('确认之后正好一次 POST /api/setup/relay，角色是纯中继', async () => {
    const outcome = await drive(values(), 'confirm');
    expect(outcome.confirming).toBe(false);
    expect(outcome.calls).toHaveLength(1);
    expect(outcome.calls[0]?.url).toBe('/api/setup/relay');
    expect(outcome.calls[0]?.method).toBe('POST');
    expect((outcome.calls[0]?.body as { role?: string })?.role).toBe('relay');
  });

  test('中继兼节点：不弹确认框，直接一次 POST，角色带上 node', async () => {
    const outcome = await drive(alsoNodeValues());
    expect(outcome.confirming).toBe(false);
    expect(outcome.calls).toHaveLength(1);
    expect(outcome.calls[0]?.url).toBe('/api/setup/relay');
    expect((outcome.calls[0]?.body as { role?: string })?.role).toBe('relay,node');
  });
});
