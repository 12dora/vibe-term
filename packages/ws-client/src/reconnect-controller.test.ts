import { describe, expect, test } from 'bun:test';
import { ReconnectController, reconnectDelayMs } from './reconnect-controller';

describe('reconnectDelayMs', () => {
  test('抖动落在 [0.5, 1) 倍指数退避区间内', () => {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const exp = Math.min(30_000, 1000 * 2 ** (attempt - 1));
      for (const random of [() => 0, () => 0.5, () => 0.999999]) {
        const delay = reconnectDelayMs(attempt, 1000, 30_000, random);
        expect(delay).toBeGreaterThanOrEqual(Math.floor(exp * 0.5));
        expect(delay).toBeLessThanOrEqual(exp);
      }
    }
  });

  test('真随机源同样不越界，且不会恒定', () => {
    const samples = new Set<number>();
    for (let i = 0; i < 64; i += 1) {
      const delay = reconnectDelayMs(3, 1000, 30_000);
      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThanOrEqual(4000);
      samples.add(delay);
    }
    expect(samples.size).toBeGreaterThan(1);
  });
});

describe('ReconnectController', () => {
  test('退避按 2 的幂增长并封顶（抖动固定为上界）', () => {
    const delays: number[] = [];
    const controller = new ReconnectController({
      delayMs: 100,
      maxAttempts: 5,
      maxDelayMs: 300,
      random: () => 0.999999,
      onReconnect: () => {},
      onSchedule: ({ delayMs }) => delays.push(delayMs),
    });

    for (let i = 0; i < 5; i += 1) {
      expect(controller.schedule()).toBe(true);
      controller.cancel();
    }

    expect(delays).toEqual([99, 199, 299, 299, 299]);
    expect(controller.getAttempts()).toBe(5);
    expect(controller.canRetry()).toBe(false);
  });

  test('缺省封顶为 30s', () => {
    const delays: number[] = [];
    const controller = new ReconnectController({
      delayMs: 1000,
      random: () => 0,
      onReconnect: () => {},
      onSchedule: ({ delayMs }) => delays.push(delayMs),
    });

    for (let i = 0; i < 7; i += 1) {
      controller.schedule();
      controller.cancel();
    }

    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 15000, 15000]);
  });

  test('缺省无尝试上限：第 5 次失败之后仍继续排程', () => {
    const controller = new ReconnectController({
      delayMs: 1,
      maxDelayMs: 1,
      onReconnect: () => {},
    });

    for (let i = 0; i < 200; i += 1) {
      expect(controller.canRetry()).toBe(true);
      expect(controller.schedule()).toBe(true);
      controller.cancel();
    }

    expect(controller.getAttempts()).toBe(200);
    expect(controller.canRetry()).toBe(true);
  });

  test('已有在途重连时不叠加定时器', () => {
    const controller = new ReconnectController({
      delayMs: 1000,
      maxAttempts: 3,
      onReconnect: () => {},
    });

    expect(controller.schedule()).toBe(true);
    expect(controller.isPending()).toBe(true);
    expect(controller.schedule()).toBe(false);
    expect(controller.getAttempts()).toBe(1);
    controller.cancel();
    expect(controller.isPending()).toBe(false);
  });

  test('到点触发 onReconnect 并释放在途标记', async () => {
    let fired = 0;
    const controller = new ReconnectController({
      delayMs: 1,
      maxAttempts: 3,
      onReconnect: () => {
        fired += 1;
      },
    });

    controller.schedule();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fired).toBe(1);
    expect(controller.isPending()).toBe(false);
    expect(controller.getAttempts()).toBe(1);
  });

  test('reset 清零尝试次数并取消在途重连', async () => {
    let fired = 0;
    const controller = new ReconnectController({
      delayMs: 5,
      maxAttempts: 1,
      onReconnect: () => {
        fired += 1;
      },
    });

    controller.schedule();
    expect(controller.canRetry()).toBe(false);
    controller.reset();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fired).toBe(0);
    expect(controller.getAttempts()).toBe(0);
    expect(controller.canRetry()).toBe(true);
  });
});
