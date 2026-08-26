import { describe, expect, test } from 'bun:test';
import { ReconnectController } from './reconnect-controller';

describe('ReconnectController', () => {
  test('退避按 2 的幂增长并封顶', () => {
    const delays: number[] = [];
    const controller = new ReconnectController({
      delayMs: 100,
      maxAttempts: 5,
      maxDelayMs: 300,
      onReconnect: () => {},
      onSchedule: ({ delayMs }) => delays.push(delayMs),
    });

    for (let i = 0; i < 5; i += 1) {
      expect(controller.schedule()).toBe(true);
      controller.cancel();
    }

    expect(delays).toEqual([100, 200, 300, 300, 300]);
    expect(controller.getAttempts()).toBe(5);
    expect(controller.canRetry()).toBe(false);
  });

  test('缺省封顶为 30s', () => {
    const delays: number[] = [];
    const controller = new ReconnectController({
      delayMs: 1000,
      maxAttempts: 10,
      onReconnect: () => {},
      onSchedule: ({ delayMs }) => delays.push(delayMs),
    });

    for (let i = 0; i < 7; i += 1) {
      controller.schedule();
      controller.cancel();
    }

    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
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
