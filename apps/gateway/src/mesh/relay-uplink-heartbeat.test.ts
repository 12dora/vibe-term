import { describe, expect, test } from 'bun:test';
import type { LinkSession } from '@tmex/shared/link';
import { RelayUplinkHeartbeat } from './relay-uplink-heartbeat';
import type { MeshScheduler } from './types';

function fakeScheduler(nowMs: { value: number }): MeshScheduler & { ticks: Array<() => void> } {
  const ticks: Array<() => void> = [];
  return {
    ticks,
    now: () => nowMs.value,
    sleep: () => Promise.resolve(),
    interval(fn) {
      ticks.push(fn);
      return {
        clear() {
          ticks.length = 0;
        },
      };
    },
  };
}

describe('RelayUplinkHeartbeat', () => {
  test('pong 用最新 ping 时间算 RTT，重连清零', () => {
    const nowMs = { value: 1_000 };
    const scheduler = fakeScheduler(nowMs);
    const pings: number[] = [];
    const timeouts: string[] = [];
    const hb = new RelayUplinkHeartbeat({
      scheduler,
      intervalMs: 15_000,
      missedLimit: 3,
      sendPing: () => {
        pings.push(nowMs.value);
      },
      onTimeout: (reason) => {
        timeouts.push(reason);
      },
    });
    hb.start({} as LinkSession, () => true);
    scheduler.ticks[0]?.();
    expect(pings).toEqual([1_000]);
    nowMs.value = 1_042;
    hb.onPong();
    expect(hb.rttMs).toBe(42);

    nowMs.value = 2_000;
    scheduler.ticks[0]?.();
    nowMs.value = 2_005;
    hb.onPong();
    expect(hb.rttMs).toBe(5);

    hb.start({} as LinkSession, () => true);
    expect(hb.rttMs).toBeNull();
    expect(timeouts).toEqual([]);
  });

  test('连丢达到上限触发 missed-pong', () => {
    const nowMs = { value: 0 };
    const scheduler = fakeScheduler(nowMs);
    const timeouts: string[] = [];
    const hb = new RelayUplinkHeartbeat({
      scheduler,
      intervalMs: 1,
      missedLimit: 2,
      sendPing: () => {},
      onTimeout: (reason) => {
        timeouts.push(reason);
      },
    });
    hb.start({} as LinkSession, () => true);
    scheduler.ticks[0]?.();
    scheduler.ticks[0]?.();
    scheduler.ticks[0]?.();
    expect(timeouts).toEqual(['missed-pong']);
  });
});
