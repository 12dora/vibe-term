import { describe, expect, test } from 'bun:test';
import { HeartbeatController } from './heartbeat-controller';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('HeartbeatController', () => {
  test('按间隔发 PING', async () => {
    let pings = 0;
    const controller = new HeartbeatController({
      intervalMs: 5,
      pongTimeoutMs: 10_000,
      sendPing: () => {
        pings += 1;
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

    controller.ping();
    expect(controller.hasPendingPong()).toBe(false);
    await wait(20);
    expect(timeouts).toBe(0);
    expect(controller.notePong()).toBeNull();
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

    controller.ping();
    await wait(5);
    const rtt = controller.notePong();

    expect(rtt).not.toBeNull();
    expect(rtt as number).toBeGreaterThanOrEqual(0);
    expect(controller.hasPendingPong()).toBe(false);

    await wait(25);
    expect(timeouts).toBe(0);
    controller.stop();
  });

  test('setCadence 重排间隔定时器且不补发 PING', async () => {
    let pings = 0;
    const controller = new HeartbeatController({
      intervalMs: 5,
      pongTimeoutMs: 10_000,
      sendPing: () => {
        pings += 1;
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
    expect(controller.notePong()).toBeNull();
  });
});
