// follow 循环的收敛判据：连续帧测量不变且过了静置窗口才允许退到低频探测，
// 任何外部事件（输入 / 焦点 / viewport / 转屏）都必须把它拉回逐帧。
import { describe, expect, test } from 'bun:test';
import {
  FOLLOW_IDLE_PROBE_MS,
  FOLLOW_SETTLE_MS,
  FOLLOW_STABLE_FRAMES,
  FollowLoopGate,
  FollowLoopScheduler,
} from './follow-loop';

describe('FollowLoopGate', () => {
  test('测量还在变时始终逐帧', () => {
    const gate = new FollowLoopGate();
    expect(gate.observe('a', 0)).toBe('frame');
    expect(gate.observe('b', 16)).toBe('frame');
    expect(gate.observe('c', 32)).toBe('frame');
  });

  test('连续帧不变但静置窗口未到仍逐帧', () => {
    const gate = new FollowLoopGate();
    gate.observe('a', 0);
    for (let frame = 1; frame <= FOLLOW_STABLE_FRAMES + 2; frame += 1) {
      expect(gate.observe('a', frame * 16)).toBe('frame');
    }
  });

  test('帧数与静置窗口都满足后收敛', () => {
    const gate = new FollowLoopGate();
    gate.observe('a', 0);
    for (let frame = 1; frame < FOLLOW_STABLE_FRAMES; frame += 1) {
      expect(gate.observe('a', frame)).toBe('frame');
    }
    expect(gate.observe('a', FOLLOW_SETTLE_MS)).toBe('idle');
  });

  test('收敛后测量再变化立刻回到逐帧', () => {
    const gate = new FollowLoopGate();
    gate.observe('a', 0);
    for (let frame = 1; frame < FOLLOW_STABLE_FRAMES; frame += 1) gate.observe('a', frame);
    expect(gate.observe('a', FOLLOW_SETTLE_MS)).toBe('idle');

    expect(gate.observe('b', FOLLOW_SETTLE_MS + 16)).toBe('frame');
  });

  test('invalidate 让已收敛的测量重新走完整静置窗口', () => {
    const gate = new FollowLoopGate();
    gate.observe('a', 0);
    for (let frame = 1; frame < FOLLOW_STABLE_FRAMES; frame += 1) gate.observe('a', frame);
    expect(gate.observe('a', FOLLOW_SETTLE_MS)).toBe('idle');

    gate.invalidate(FOLLOW_SETTLE_MS);
    for (let frame = 1; frame <= FOLLOW_STABLE_FRAMES; frame += 1) {
      expect(gate.observe('a', FOLLOW_SETTLE_MS + frame)).toBe('frame');
    }
    expect(gate.observe('a', FOLLOW_SETTLE_MS * 2)).toBe('idle');
  });

  test('reset 后同一签名视为新测量', () => {
    const gate = new FollowLoopGate();
    gate.observe('a', 0);
    for (let frame = 1; frame < FOLLOW_STABLE_FRAMES; frame += 1) gate.observe('a', frame);
    expect(gate.observe('a', FOLLOW_SETTLE_MS)).toBe('idle');

    gate.reset();
    expect(gate.observe('a', FOLLOW_SETTLE_MS + 1)).toBe('frame');
  });
});

// 调度器：逐帧 → 收敛 → 低频探测 → 探测到变化再回到逐帧。
class TestHost {
  time = 0;
  signature = 'a';
  probeValue = 'p0';
  measures = 0;
  scheduler!: FollowLoopScheduler;
  private frame: (() => void) | null = null;
  private idle: (() => void) | null = null;
  idleDelays: number[] = [];

  now(): number {
    return this.time;
  }
  requestFrame(fn: () => void): number {
    this.frame = fn;
    return 1;
  }
  cancelFrame(): void {
    this.frame = null;
  }
  requestIdle(fn: () => void, ms: number): unknown {
    this.idle = fn;
    this.idleDelays.push(ms);
    return 1;
  }
  cancelIdle(): void {
    this.idle = null;
  }
  measure(): void {
    this.measures += 1;
    this.scheduler.pace(this.signature, this.probeValue);
  }
  probe(): string {
    return this.probeValue;
  }

  runFrame(stepMs = 16): void {
    const fn = this.frame;
    this.frame = null;
    this.time += stepMs;
    fn?.();
  }
  runIdle(): void {
    const fn = this.idle;
    this.idle = null;
    this.time += this.idleDelays[this.idleDelays.length - 1] ?? 0;
    fn?.();
  }
}

function startedScheduler() {
  const host = new TestHost();
  const scheduler = new FollowLoopScheduler(host);
  host.scheduler = scheduler;
  host.measure(); // 首次测量（compute 末尾 pace）
  return { host, scheduler };
}

/** 一直跑帧直到调度器判定收敛（或超过上限，说明没收敛）。 */
function runUntilIdle(host: TestHost, scheduler: FollowLoopScheduler, limit = 200): number {
  let frames = 0;
  while (scheduler.state === 'frame' && frames < limit) {
    host.runFrame();
    frames += 1;
  }
  return frames;
}

describe('FollowLoopScheduler', () => {
  test('测量收敛后停掉逐帧，退到低频探测', () => {
    const { host, scheduler } = startedScheduler();
    expect(scheduler.state).toBe('frame');

    const frames = runUntilIdle(host, scheduler);
    expect(scheduler.state).toBe('idle');
    expect(frames).toBeGreaterThanOrEqual(FOLLOW_STABLE_FRAMES);
    expect(host.idleDelays).toEqual([FOLLOW_IDLE_PROBE_MS]);

    // 收敛后不再有任何 RAF
    const measures = host.measures;
    host.runFrame();
    expect(host.measures).toBe(measures);
  });

  test('探测不到变化时周期指数放缓到上限', () => {
    const { host, scheduler } = startedScheduler();
    runUntilIdle(host, scheduler);
    const measures = host.measures;

    for (let i = 0; i < 5; i += 1) {
      host.runIdle();
    }

    expect(host.measures).toBe(measures); // 探测本身不做整套测量
    expect(host.idleDelays).toEqual([250, 500, 1000, 1000, 1000, 1000]);
    expect(scheduler.state).toBe('idle');
  });

  test('探测到光标移动（终端输出）立刻回到逐帧', () => {
    const { host, scheduler } = startedScheduler();
    runUntilIdle(host, scheduler);

    host.probeValue = 'p1';
    host.signature = 'b';
    host.runIdle();

    expect(scheduler.state).toBe('frame');
    // 变化后周期复位，下一轮收敛重新从最短周期起步
    runUntilIdle(host, scheduler);
    expect(host.idleDelays[host.idleDelays.length - 1]).toBe(FOLLOW_IDLE_PROBE_MS);
  });

  test('invalidate（按键 / 焦点 / viewport）让已收敛的循环重新跑满静置窗口', () => {
    const { host, scheduler } = startedScheduler();
    runUntilIdle(host, scheduler);
    expect(scheduler.state).toBe('idle');

    scheduler.invalidate();
    host.measure(); // 事件驱动的那次 compute

    expect(scheduler.state).toBe('frame');
    expect(runUntilIdle(host, scheduler)).toBeGreaterThanOrEqual(FOLLOW_STABLE_FRAMES);
    expect(scheduler.state).toBe('idle');
  });

  test('stop 后既无逐帧也无探测', () => {
    const { host, scheduler } = startedScheduler();
    runUntilIdle(host, scheduler);
    scheduler.stop();
    const measures = host.measures;

    expect(scheduler.state).toBe('stopped');
    host.runFrame();
    host.runIdle();
    expect(host.measures).toBe(measures);
    expect(scheduler.state).toBe('stopped');
  });
});
