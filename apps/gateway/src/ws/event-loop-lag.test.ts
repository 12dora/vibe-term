import { afterEach, describe, expect, test } from 'bun:test';
import { EventLoopLagSampler } from './event-loop-lag';

describe('EventLoopLagSampler', () => {
  const samplers: EventLoopLagSampler[] = [];
  afterEach(() => {
    for (const sampler of samplers) sampler.stop();
    samplers.length = 0;
  });

  const noopSchedule = {
    schedule: () => 1 as unknown as ReturnType<typeof setTimeout>,
    unschedule: () => {},
  };

  test('records current lag and a 30s max, and rate-limits warn lines', () => {
    const warns: string[] = [];
    let now = 1_000;
    const sampler = new EventLoopLagSampler({
      now: () => now,
      tickMs: 1_000,
      windowMs: 30_000,
      warnMs: 250,
      warnIntervalMs: 10_000,
      warn: (line) => warns.push(line),
      ...noopSchedule,
    });
    samplers.push(sampler);
    sampler.start();
    now = 2_400;
    sampler.tick();
    expect(sampler.snapshot()).toEqual({ lagMs: 400, maxLagMs: 400 });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('event_loop_lag');
    expect(warns[0]).toContain('lag_ms=400');
    expect(warns[0]).toContain('max_lag_ms=400');
    expect(warns[0]).toContain('warn_ms=250');

    now = 3_400;
    sampler.tick();
    now = 4_500;
    sampler.tick();
    expect(sampler.snapshot().lagMs).toBe(100);
    expect(sampler.snapshot().maxLagMs).toBe(400);
    expect(warns).toHaveLength(1);

    now = 14_500;
    sampler.tick();
    expect(warns).toHaveLength(2);
    expect(sampler.snapshot().maxLagMs).toBeGreaterThanOrEqual(400);
  });

  test('drops samples older than the 30s window from max lag', () => {
    let now = 0;
    const sampler = new EventLoopLagSampler({
      now: () => now,
      tickMs: 1_000,
      windowMs: 30_000,
      warnMs: 10_000,
      warn: () => {},
      ...noopSchedule,
    });
    samplers.push(sampler);
    sampler.start();
    now = 1_400;
    sampler.tick();
    expect(sampler.snapshot().maxLagMs).toBe(400);
    for (let t = 2_400; t <= 32_400; t += 1_000) {
      now = t;
      sampler.tick();
    }
    expect(sampler.snapshot().lagMs).toBe(0);
    expect(sampler.snapshot().maxLagMs).toBe(0);
  });
});
