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
