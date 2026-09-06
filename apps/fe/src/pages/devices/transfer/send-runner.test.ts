// 提交的单飞与令牌：另一侧不能趁在飞时插队，迟到的回调不能写状态。

import { describe, expect, test } from 'bun:test';
import { ApiError } from '@tmex/api-client';
import { createSendRunner } from './send-runner';
import type { SendSide } from './send-side';

function harness() {
  const sending: Array<SendSide | null> = [];
  const errors: Array<string | null> = [];
  const runner = createSendRunner({
    setSending: (side) => sending.push(side),
    setErrorKey: (key) => errors.push(key),
  });
  return { runner, sending, errors };
}

/** 让 then / catch / finally 这几层微任务都跑完。 */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('createSendRunner', () => {
  test('在飞时另一侧的提交被拒绝，不产生第二次请求', async () => {
    const { runner, sending } = harness();
    const first = deferred();
    let runs = 0;
    let sent = 0;

    expect(
      runner.start({
        side: 'left',
        run: () => {
          runs += 1;
          return first.promise;
        },
        onSent: () => {
          sent += 1;
        },
      })
    ).toBe(true);

    expect(
      runner.start({
        side: 'right',
        run: () => {
          runs += 1;
          return Promise.resolve();
        },
        onSent: () => {
          sent += 1;
        },
      })
    ).toBe(false);

    expect(runs).toBe(1);
    expect(sending).toEqual(['left']);

    first.resolve();
    await flush();
    expect(sent).toBe(1);
    expect(sending).toEqual(['left', null]);

    // 上一次收工后才允许下一次
    expect(
      runner.start({ side: 'right', run: () => Promise.resolve(), onSent: () => undefined })
    ).toBe(true);
  });

  test('失败落到错误文案 key', async () => {
    const { runner, errors } = harness();
    const failing = Promise.reject(new ApiError(409, 'busy', { code: 'dest_exists' }));
    runner.start({ side: 'left', run: () => failing, onSent: () => undefined });
    await failing.catch(() => undefined);
    await flush();
    expect(errors).toEqual([null, 'devices.transfer.errors.dest_exists']);
  });

  test('discard 之后迟到的回调不再写状态', async () => {
    const { runner, sending, errors } = harness();
    const pending = deferred();
    let sent = 0;
    runner.start({
      side: 'left',
      run: () => pending.promise,
      onSent: () => {
        sent += 1;
      },
    });

    runner.discard();
    pending.resolve();
    await flush();

    expect(sent).toBe(0);
    expect(sending).toEqual(['left']);
    expect(errors).toEqual([null]);
  });

  test('discard 之后可以立刻再提交', () => {
    const { runner } = harness();
    runner.start({
      side: 'left',
      run: () => new Promise(() => undefined),
      onSent: () => undefined,
    });
    runner.discard();
    expect(
      runner.start({ side: 'left', run: () => Promise.resolve(), onSent: () => undefined })
    ).toBe(true);
  });
});
