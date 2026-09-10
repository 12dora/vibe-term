import { describe, expect, test } from 'bun:test';

import {
  HOST_LATENCY_IDLE_PROBE_MS,
  HOST_LATENCY_MAX_SAMPLE_MS,
  type HostLatencySample,
  HostLatencyTracker,
} from './host-latency-tracker';
import { TestClock } from './pane-input-test-helpers';

const HOP_LOCAL = 0;

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function setup(options: { probe?: () => Promise<unknown> } = {}) {
  const clock = new TestClock();
  const wall = 1_700_000_000_000;
  const probes: number[] = [];
  const tracker = new HostLatencyTracker({
    clock,
    wallClock: () => wall,
    probe: () => {
      probes.push(clock.now());
      return options.probe?.();
    },
  });
  const samples: HostLatencySample[] = [];
  tracker.subscribe((sample) => samples.push(sample));
  return { clock, tracker, probes, samples };
}

describe('HostLatencyTracker estimate', () => {
  test('first sample seeds the estimate, later samples follow EWMA α=0.25', () => {
    const { tracker, samples } = setup();
    tracker.record(100, HOP_LOCAL);
    expect(tracker.current()).toEqual({
      rttMs: 100,
      rawMs: 100,
      hop: HOP_LOCAL,
      sampledAt: 1_700_000_000_000,
    });
    tracker.record(200, HOP_LOCAL);
    expect(tracker.current()?.rttMs).toBe(125);
    expect(tracker.current()?.rawMs).toBe(200);
    tracker.record(200, HOP_LOCAL);
    expect(tracker.current()?.rttMs).toBe(144);
    expect(samples).toHaveLength(3);
  });

  test('keeps the raw sample separate and rounds both to non-negative integers', () => {
    const { tracker } = setup();
    tracker.record(3.4, HOP_LOCAL);
    tracker.record(0.2, HOP_LOCAL);
    expect(tracker.current()).toMatchObject({ rttMs: 2, rawMs: 0 });
  });

  test('rejects bogus samples without touching the estimate', () => {
    const { tracker, samples } = setup();
    tracker.record(40, HOP_LOCAL);
    for (const bogus of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      HOST_LATENCY_MAX_SAMPLE_MS + 1,
    ]) {
      tracker.record(bogus, HOP_LOCAL);
    }
    expect(tracker.current()).toMatchObject({ rttMs: 40, rawMs: 40 });
    expect(samples).toHaveLength(1);
  });

  test('carries the hop of the reporting connection', () => {
    const { tracker } = setup();
    tracker.record(12, 1);
    expect(tracker.current()?.hop).toBe(1);
  });

  test('unsubscribe stops delivery, dispose clears listeners', () => {
    const { tracker } = setup();
    const seen: number[] = [];
    const off = tracker.subscribe((sample) => seen.push(sample.rttMs));
    tracker.record(10, HOP_LOCAL);
    off();
    tracker.record(10, HOP_LOCAL);
    expect(seen).toEqual([10]);
    tracker.dispose();
    tracker.record(10, HOP_LOCAL);
    expect(tracker.current()?.rawMs).toBe(10);
  });
});

describe('HostLatencyTracker idle probe', () => {
  test('never probes without a gate', () => {
    const { clock, probes } = setup();
    clock.tick(HOST_LATENCY_IDLE_PROBE_MS * 4);
    expect(probes).toEqual([]);
  });

  test('never probes while no session is connected', () => {
    const { clock, tracker, probes } = setup();
    tracker.setProbeGate(() => false);
    clock.tick(HOST_LATENCY_IDLE_PROBE_MS * 4);
    expect(probes).toEqual([]);
  });

  test('probes once per idle window while sessions are connected', async () => {
    const { clock, tracker, probes } = setup();
    tracker.setProbeGate(() => true);
    clock.tick(HOST_LATENCY_IDLE_PROBE_MS - 1);
    expect(probes).toEqual([]);
    clock.tick(1);
    await flush();
    expect(probes).toEqual([HOST_LATENCY_IDLE_PROBE_MS]);
    clock.tick(HOST_LATENCY_IDLE_PROBE_MS);
    await flush();
    expect(probes).toHaveLength(2);
  });

  test('a fresh sample pushes the next probe out by a full window', async () => {
    const { clock, tracker, probes } = setup();
    tracker.setProbeGate(() => true);
    clock.tick(10_000);
    tracker.record(5, HOP_LOCAL);
    clock.tick(HOST_LATENCY_IDLE_PROBE_MS - 1);
    expect(probes).toEqual([]);
    clock.tick(1);
    await flush();
    expect(probes).toEqual([25_000]);
  });

  test('keeps a single probe in flight', async () => {
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { clock, tracker, probes } = setup({ probe: () => pending });
    tracker.setProbeGate(() => true);
    clock.tick(HOST_LATENCY_IDLE_PROBE_MS);
    await flush();
    clock.tick(HOST_LATENCY_IDLE_PROBE_MS * 3);
    await flush();
    expect(probes).toHaveLength(1);
    release();
    await flush();
    clock.tick(HOST_LATENCY_IDLE_PROBE_MS);
    await flush();
    expect(probes).toHaveLength(2);
  });

  test('a failed probe waits a full window instead of spinning', async () => {
    const { clock, tracker, probes } = setup({ probe: () => Promise.reject(new Error('dead')) });
    tracker.setProbeGate(() => true);
    clock.tick(HOST_LATENCY_IDLE_PROBE_MS);
    await flush();
    clock.tick(HOST_LATENCY_IDLE_PROBE_MS - 1);
    await flush();
    expect(probes).toHaveLength(1);
    clock.tick(1);
    await flush();
    expect(probes).toHaveLength(2);
  });

  test('clearing the gate stops the schedule', async () => {
    const { clock, tracker, probes } = setup();
    tracker.setProbeGate(() => true);
    tracker.setProbeGate(null);
    clock.tick(HOST_LATENCY_IDLE_PROBE_MS * 3);
    await flush();
    expect(probes).toEqual([]);
    expect(clock.timers.size).toBe(0);
  });

  test('dispose stops the schedule', async () => {
    const { clock, tracker, probes } = setup();
    tracker.setProbeGate(() => true);
    tracker.dispose();
    clock.tick(HOST_LATENCY_IDLE_PROBE_MS * 3);
    await flush();
    expect(probes).toEqual([]);
  });
});
