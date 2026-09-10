// 宿主一跳的取数口径：按字段读 + 逐字段装配。网关每 15 s 重发一帧读数相同的样本，
// store 里换的是新对象；这两个纯函数保证「值没变」时读出来的每一项都还是同一个值，
// `useNodeLatency` 的 `useMemo` 才不会给徽标换出一个新对象。

import { describe, expect, test } from 'bun:test';
import type { DeviceLatencySample, TmuxState } from '@vibeterm/stores/tmux-state';
import { composeHostHop, selectDeviceLatencyField } from './direct-diagnostics';

const SAMPLE: DeviceLatencySample = {
  rttMs: 3,
  rawMs: 5,
  hop: 'ssh',
  sampledAt: 1_700_000_000_000,
  receivedAt: 1_700_000_000_100,
};

function stateWith(sample: DeviceLatencySample | undefined): TmuxState {
  return { deviceLatency: sample ? { 'dev-1': sample } : {} } as unknown as TmuxState;
}

describe('selectDeviceLatencyField', () => {
  test('逐字段取值，缺席（无设备 / 无读数）一律 null', () => {
    const state = stateWith(SAMPLE);
    expect(selectDeviceLatencyField(state, 'dev-1', 'rttMs')).toBe(3);
    expect(selectDeviceLatencyField(state, 'dev-1', 'hop')).toBe('ssh');
    expect(selectDeviceLatencyField(state, 'dev-1', 'receivedAt')).toBe(1_700_000_000_100);
    expect(selectDeviceLatencyField(state, 'dev-2', 'rttMs')).toBeNull();
    expect(selectDeviceLatencyField(state, undefined, 'rttMs')).toBeNull();
    expect(selectDeviceLatencyField(stateWith(undefined), 'dev-1', 'rttMs')).toBeNull();
  });

  test('0ms 是有效读数，不能被当作缺席', () => {
    expect(selectDeviceLatencyField(stateWith({ ...SAMPLE, rttMs: 0 }), 'dev-1', 'rttMs')).toBe(0);
  });

  test('store 换了样本对象但读数相同时，逐字段读出来的值不变', () => {
    const before = stateWith(SAMPLE);
    // 15 s 后的刷新帧：新对象，只有 receivedAt 前进
    const after = stateWith({ ...SAMPLE, receivedAt: SAMPLE.receivedAt + 15_000 });
    expect(before.deviceLatency['dev-1']).not.toBe(after.deviceLatency['dev-1']);
    for (const field of ['rttMs', 'rawMs', 'hop', 'sampledAt'] as const) {
      expect(selectDeviceLatencyField(after, 'dev-1', field)).toBe(
        selectDeviceLatencyField(before, 'dev-1', field) as never
      );
    }
  });
});

describe('composeHostHop', () => {
  test('五项齐全才装配得出样本', () => {
    expect(composeHostHop({ rttMs: 3, rawMs: 5, hop: 'ssh', sampledAt: 1, receivedAt: 2 })).toEqual(
      { rttMs: 3, rawMs: 5, hop: 'ssh', sampledAt: 1, receivedAt: 2 }
    );
    expect(
      composeHostHop({ rttMs: 0, rawMs: 0, hop: 'local', sampledAt: 1, receivedAt: 2 })
    ).toEqual({ rttMs: 0, rawMs: 0, hop: 'local', sampledAt: 1, receivedAt: 2 });
  });

  test('任一项缺席即视作没有宿主一跳读数', () => {
    const full = { rttMs: 3, rawMs: 5, hop: 'ssh' as const, sampledAt: 1, receivedAt: 2 };
    expect(composeHostHop({ ...full, rttMs: null })).toBeNull();
    expect(composeHostHop({ ...full, rawMs: null })).toBeNull();
    expect(composeHostHop({ ...full, hop: null })).toBeNull();
    expect(composeHostHop({ ...full, sampledAt: null })).toBeNull();
    expect(composeHostHop({ ...full, receivedAt: null })).toBeNull();
  });
});
