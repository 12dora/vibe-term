import { describe, expect, test } from 'bun:test';
import { HeartbeatController } from './heartbeat-controller';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('HeartbeatController', () => {
  test('按间隔发 PING', async () => {
    let pings = 0;
    const controller = new HeartbeatController({
      intervalMs: 5,
      pongTimeoutMs: 10_000,
      sendPing: (nonce) => {
        pings += 1;
        queueMicrotask(() => {
          controller.notePong(nonce);
        });
        return true;
      },
      onPongTimeout: () => {},
    });

    controller.start();
    expect(controller.isRunning()).toBe(true);
    await wait(30);
    controller.stop();
    const observed = pings;
    expect(observed).toBeGreaterThanOrEqual(2);

    await wait(20);
    expect(pings).toBe(observed);
    expect(controller.isRunning()).toBe(false);
  });

  test('在途 PONG 时跳过本轮 PING', () => {
    let pings = 0;
    const controller = new HeartbeatController({
      intervalMs: 10_000,
      pongTimeoutMs: 10_000,
      sendPing: () => {
        pings += 1;
        return true;
      },
      onPongTimeout: () => {},
    });

    expect(controller.ping()).not.toBeNull();
    expect(controller.ping()).toBeNull();
    expect(pings).toBe(1);
    expect(controller.hasPendingPong()).toBe(true);
    controller.stop();
  });

  test('PING 发出后武装 PONG 超时', async () => {
    let timeouts = 0;
    const controller = new HeartbeatController({
      intervalMs: 10_000,
      pongTimeoutMs: 5,
      sendPing: () => true,
      onPongTimeout: () => {
        timeouts += 1;
      },
    });

    controller.ping();
    expect(controller.hasPendingPong()).toBe(true);
    await wait(25);
    expect(timeouts).toBe(1);
    expect(controller.hasPendingPong()).toBe(false);
    controller.stop();
  });

  test('sendPing 返回 false 时不武装超时', async () => {
    let timeouts = 0;
    const controller = new HeartbeatController({
      intervalMs: 10_000,
      pongTimeoutMs: 5,
      sendPing: () => false,
      onPongTimeout: () => {
        timeouts += 1;
      },
    });

    expect(controller.ping()).toBeNull();
    expect(controller.hasPendingPong()).toBe(false);
    await wait(20);
    expect(timeouts).toBe(0);
    expect(controller.notePong(1)).toBeNull();
  });

  test('notePong 解除超时并返回 RTT', async () => {
    let timeouts = 0;
    const controller = new HeartbeatController({
      intervalMs: 10_000,
      pongTimeoutMs: 10,
      sendPing: () => true,
      onPongTimeout: () => {
        timeouts += 1;
      },
    });

    const nonce = controller.ping();
    expect(nonce).not.toBeNull();
    await wait(5);
    const sample = controller.notePong(nonce as number);

    expect(sample).not.toBeNull();
    expect(sample?.rawMs).toBeGreaterThanOrEqual(0);
    expect(sample?.latencyMs).toBe(sample?.rawMs);
    expect(controller.hasPendingPong()).toBe(false);

    await wait(25);
    expect(timeouts).toBe(0);
    controller.stop();
  });

  test('nonce 不匹配的 PONG 不清理在途探测、不算延迟', async () => {
    let timeouts = 0;
    const controller = new HeartbeatController({
      intervalMs: 10_000,
      pongTimeoutMs: 10_000,
      sendPing: () => true,
      onPongTimeout: () => {
        timeouts += 1;
      },
    });

    const nonce = controller.ping() as number;
    expect(controller.notePong(nonce ^ 0xffff)).toBeNull();
    expect(controller.hasPendingPong()).toBe(true);

    const sample = controller.notePong(nonce);
    expect(sample).not.toBeNull();
    expect(controller.hasPendingPong()).toBe(false);
    expect(timeouts).toBe(0);
    controller.stop();
  });

  test('迟到的 PONG 在超时后忽略', async () => {
    const controller = new HeartbeatController({
      intervalMs: 10_000,
      pongTimeoutMs: 5,
      sendPing: () => true,
      onPongTimeout: () => {},
    });

    const nonce = controller.ping() as number;
    await wait(25);
    expect(controller.hasPendingPong()).toBe(false);
    expect(controller.notePong(nonce)).toBeNull();
    controller.stop();
  });

  test('latencyMs 为最近 5 个有效样本的中位数', () => {
    let t = 0;
    const controller = new HeartbeatController({
      intervalMs: 10_000,
      pongTimeoutMs: 10_000,
      now: () => t,
      sendPing: () => true,
      onPongTimeout: () => {},
    });

    const sample = (rtt: number) => {
      t += 1;
      const nonce = controller.ping() as number;
      t += rtt;
      return controller.notePong(nonce);
    };

    expect(sample(10)).toEqual({ rawMs: 10, latencyMs: 10 });
    expect(sample(30)).toEqual({ rawMs: 30, latencyMs: 20 });
    expect(sample(20)).toEqual({ rawMs: 20, latencyMs: 20 });
    expect(sample(100)).toEqual({ rawMs: 100, latencyMs: 25 });
    expect(sample(5)).toEqual({ rawMs: 5, latencyMs: 20 });
    expect(sample(7)).toEqual({ rawMs: 7, latencyMs: 20 });
    controller.stop();
  });

  test('stop 清空平滑窗口', () => {
    let t = 0;
    const controller = new HeartbeatController({
      intervalMs: 10_000,
      pongTimeoutMs: 10_000,
      now: () => t,
      sendPing: () => true,
      onPongTimeout: () => {},
    });

    t = 1;
    const first = controller.ping() as number;
    t = 41;
    expect(controller.notePong(first)).toEqual({ rawMs: 40, latencyMs: 40 });

    controller.stop();
    t = 42;
    const second = controller.ping() as number;
    t = 52;
    expect(controller.notePong(second)).toEqual({ rawMs: 10, latencyMs: 10 });
    controller.stop();
  });

  test('setCadence 重排间隔定时器且不补发 PING', async () => {
    let pings = 0;
    const controller = new HeartbeatController({
      intervalMs: 5,
      pongTimeoutMs: 10_000,
      sendPing: (nonce) => {
        pings += 1;
        queueMicrotask(() => {
          controller.notePong(nonce);
        });
        return true;
      },
      onPongTimeout: () => {},
    });

    controller.start();
    await wait(30);
    controller.setCadence(10_000, 20_000);
    expect(controller.cadence).toEqual({ intervalMs: 10_000, pongTimeoutMs: 20_000 });

    const observed = pings;
    expect(observed).toBeGreaterThanOrEqual(2);
    await wait(40);
    expect(pings).toBe(observed);
    controller.stop();
  });

  test('setCadence 不影响在途 PONG 超时的截止时间', async () => {
    let timeouts = 0;
    const controller = new HeartbeatController({
      intervalMs: 10_000,
      pongTimeoutMs: 10,
      sendPing: () => true,
      onPongTimeout: () => {
        timeouts += 1;
      },
    });

    controller.ping();
    controller.setCadence(30_000, 60_000);
    expect(controller.hasPendingPong()).toBe(true);

    await wait(30);
    expect(timeouts).toBe(1);
    controller.stop();
  });

  test('setCadence 后新的 PONG 超时按新节奏武装', async () => {
    let timeouts = 0;
    const controller = new HeartbeatController({
      intervalMs: 10_000,
      pongTimeoutMs: 10_000,
      sendPing: () => true,
      onPongTimeout: () => {
        timeouts += 1;
      },
    });

    controller.setCadence(10_000, 5);
    controller.ping();
    await wait(25);
    expect(timeouts).toBe(1);
    controller.stop();
  });

  test('未运行时 setCadence 只改参数，不会启动心跳', async () => {
    let pings = 0;
    const controller = new HeartbeatController({
      intervalMs: 10_000,
      pongTimeoutMs: 10_000,
      sendPing: () => {
        pings += 1;
        return true;
      },
      onPongTimeout: () => {},
    });

    controller.setCadence(5, 10);
    expect(controller.isRunning()).toBe(false);
    await wait(30);
    expect(pings).toBe(0);
  });

  test('stop 同时解除在途 PONG 超时，避免误关新连接', async () => {
    let timeouts = 0;
    const controller = new HeartbeatController({
      intervalMs: 10_000,
      pongTimeoutMs: 5,
      sendPing: () => true,
      onPongTimeout: () => {
        timeouts += 1;
      },
    });

    controller.ping();
    controller.stop();

    await wait(25);
    expect(timeouts).toBe(0);
    expect(controller.notePong(1)).toBeNull();
  });
});
