// 切换中继的状态机：在途期间锁死目标与对话框，回来之后只关自己那一张。

import { describe, expect, test } from 'bun:test';
import type { RelayLinkStatus } from '@tmex/api-client/relay/tenant-api';
import { createRelaySwitchCore } from './use-relay-switch';

function link(url: string): RelayLinkStatus {
  return {
    url,
    priority: 1,
    online: true,
    attached: false,
    rttMs: null,
    lastError: null,
    lastErrorCode: null,
    kicked: false,
  };
}

const A = link('https://a.example');
const B = link('https://b.example');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness() {
  const gate = deferred<void>();
  const calls: string[] = [];
  const done: string[] = [];
  const errors: unknown[] = [];
  const core = createRelaySwitchCore({
    switchRelay: (url) => {
      calls.push(url);
      return gate.promise;
    },
    onDone: (relay) => done.push(relay.url),
    onError: (err) => errors.push(err),
  });
  return { core, gate, calls, done, errors };
}

describe('createRelaySwitchCore', () => {
  test('选中一条打开确认，取消关掉；没有目标时确认什么都不做', async () => {
    const { core, calls } = harness();
    await core.confirm();
    expect(calls).toEqual([]);

    core.request(A);
    expect(core.getState().target?.url).toBe('https://a.example');
    core.dismiss();
    expect(core.getState().target).toBeNull();
  });

  test('在途期间换目标、关框、再确认全部忽略；切成之后才解锁', async () => {
    const { core, gate, calls, done } = harness();
    core.request(A);
    const running = core.confirm();

    expect(core.getState().busy).toBe(true);
    core.request(B);
    core.dismiss();
    await core.confirm();
    expect(core.getState().target?.url).toBe('https://a.example');
    expect(calls).toEqual(['https://a.example']);

    gate.resolve();
    await running;

    expect(done).toEqual(['https://a.example']);
    expect(core.getState()).toEqual({ target: null, busy: false });

    core.request(B);
    expect(core.getState().target?.url).toBe('https://b.example');
  });

  test('订阅方在开始与结束各收到一次通知', async () => {
    const { core, gate } = harness();
    let notified = 0;
    const stop = core.subscribe(() => {
      notified += 1;
    });
    core.request(A);
    expect(notified).toBe(1);
    const running = core.confirm();
    expect(notified).toBe(2);

    gate.resolve();
    await running;
    const settled = notified;
    expect(settled).toBeGreaterThan(2);

    stop();
    core.request(B);
    expect(notified).toBe(settled);
  });

  test('失败时留着确认框，错误交给调用方，锁一并解开', async () => {
    const { core, gate, errors } = harness();
    core.request(A);
    const running = core.confirm();
    gate.reject(new Error('boom'));
    await running;

    expect(errors).toHaveLength(1);
    expect(core.getState().target?.url).toBe('https://a.example');
    expect(core.getState().busy).toBe(false);

    core.dismiss();
    expect(core.getState().target).toBeNull();
  });
});
