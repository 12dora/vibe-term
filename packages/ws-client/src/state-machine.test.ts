import { describe, expect, test } from 'bun:test';
import { DeferredSelectEffects } from './deferred-select-effects';
import { SelectStateMachine } from './state-machine';

class ManualScheduler {
  private now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { at: number; callback: () => void }>();

  schedule(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + delayMs, callback });
    return id;
  }

  cancel(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  advance(delayMs: number): void {
    const target = this.now + delayMs;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) break;
      const [id, task] = next;
      this.tasks.delete(id);
      this.now = task.at;
      task.callback();
    }
    this.now = target;
  }
}

class LeakyScheduler {
  private nextId = 1;
  private readonly pending = new Map<number, () => void>();
  private readonly cancelled = new Map<number, () => void>();

  schedule(callback: () => void, _delayMs: number): number {
    const id = this.nextId++;
    this.pending.set(id, callback);
    return id;
  }

  // 模拟"已取消但回调早已排队"的定时器：cancel 不会阻止回调执行
  cancel(handle: unknown): void {
    const id = handle as number;
    const callback = this.pending.get(id);
    if (!callback) return;
    this.pending.delete(id);
    this.cancelled.set(id, callback);
  }

  fireCancelled(): void {
    const queued = [...this.cancelled.values()];
    this.cancelled.clear();
    for (const callback of queued) {
      callback();
    }
  }

  firePending(): void {
    const queued = [...this.pending.values()];
    this.pending.clear();
    for (const callback of queued) {
      callback();
    }
  }
}

describe('SelectStateMachine', () => {
  test('replays deferred history with alternateScreen preserved', () => {
    const sm = new SelectStateMachine();
    const token = new Uint8Array(16).fill(1);

    sm.dispatch({
      type: 'SELECT_START',
      deviceId: 'device-1',
      windowId: '@1',
      paneId: '%1',
      selectToken: token,
      wantHistory: true,
    });
    sm.dispatch({
      type: 'SWITCH_ACK',
      deviceId: 'device-1',
      selectToken: token,
    });
    sm.dispatch({
      type: 'HISTORY',
      deviceId: 'device-1',
      selectToken: token,
      data: 'alt-history',
      alternateScreen: true,
      modes: 0,
    });

    const received: Array<{ paneId: string; data: string; alternateScreen: boolean }> = [];
    const events: string[] = [];
    sm.setCallbacks({
      onResetTerminal: () => events.push('reset'),
      onApplyHistory: (_deviceId, paneId, data, alternateScreen) => {
        events.push('history');
        received.push({ paneId, data, alternateScreen });
      },
    });

    expect(received).toEqual([{ paneId: '%1', data: 'alt-history', alternateScreen: true }]);
    expect(events).toEqual(['reset', 'history']);
  });

  test('routes non-transaction pane output instead of dropping it (split view siblings)', () => {
    const sm = new SelectStateMachine();
    const token = new Uint8Array(16).fill(2);
    const outputs: Array<{ paneId: string; text: string }> = [];

    sm.setCallbacks({
      onOutput: (_deviceId, paneId, data) => {
        outputs.push({ paneId, text: new TextDecoder().decode(data) });
      },
    });

    sm.dispatch({
      type: 'SELECT_START',
      deviceId: 'device-1',
      windowId: '@1',
      paneId: '%1',
      selectToken: token,
      wantHistory: true,
    });

    // 事务期间：事务 pane 输出被门控缓冲，兄弟 pane 输出直接路由
    sm.dispatch({
      type: 'OUTPUT',
      deviceId: 'device-1',
      paneId: '%1',
      data: new TextEncoder().encode('focused'),
    });
    sm.dispatch({
      type: 'OUTPUT',
      deviceId: 'device-1',
      paneId: '%2',
      data: new TextEncoder().encode('sibling'),
    });

    expect(outputs).toEqual([{ paneId: '%2', text: 'sibling' }]);

    sm.dispatch({ type: 'SWITCH_ACK', deviceId: 'device-1', selectToken: token });
    sm.dispatch({ type: 'LIVE_RESUME', deviceId: 'device-1', selectToken: token });

    // LIVE 后缓冲的事务 pane 输出经 onFlushBuffer 释放；此处只验证兄弟输出未丢
    expect(outputs.some((o) => o.paneId === '%2')).toBe(true);
  });

  test('flush buffer carries the transaction paneId', () => {
    const sm = new SelectStateMachine();
    const token = new Uint8Array(16).fill(3);
    const flushes: Array<{ paneId: string; chunks: number }> = [];

    sm.setCallbacks({
      onResetTerminal: () => {},
      onFlushBuffer: (_deviceId, paneId, buffer) => {
        flushes.push({ paneId, chunks: buffer.length });
      },
    });

    sm.dispatch({
      type: 'SELECT_START',
      deviceId: 'device-1',
      windowId: '@1',
      paneId: '%7',
      selectToken: token,
      wantHistory: false,
    });
    sm.dispatch({
      type: 'OUTPUT',
      deviceId: 'device-1',
      paneId: '%7',
      data: new TextEncoder().encode('buffered'),
    });
    sm.dispatch({ type: 'SWITCH_ACK', deviceId: 'device-1', selectToken: token });
    sm.dispatch({ type: 'LIVE_RESUME', deviceId: 'device-1', selectToken: token });

    expect(flushes).toEqual([{ paneId: '%7', chunks: 1 }]);
  });

  test('ACK 和低速分片进展不会清空旧画面；停止进展后可重入新事务', () => {
    const scheduler = new ManualScheduler();
    const firstToken = new Uint8Array(16).fill(4);
    const retryToken = new Uint8Array(16).fill(5);
    const events: string[] = [];
    const sm: SelectStateMachine = new SelectStateMachine(
      {
        onResetTerminal: () => events.push('reset'),
        onApplyHistory: () => events.push('history'),
        onSelectFailed: (_deviceId, reason) => {
          events.push(reason);
          sm.dispatch({
            type: 'SELECT_START',
            deviceId: 'device-slow',
            windowId: '@1',
            paneId: '%1',
            selectToken: retryToken,
            wantHistory: true,
          });
        },
      },
      { ackTimeoutMs: 100, progressTimeoutMs: 100, scheduler }
    );

    sm.dispatch({
      type: 'SELECT_START',
      deviceId: 'device-slow',
      windowId: '@1',
      paneId: '%1',
      selectToken: firstToken,
      wantHistory: true,
    });
    sm.dispatch({ type: 'SWITCH_ACK', deviceId: 'device-slow', selectToken: firstToken });
    expect(events).toEqual([]);

    scheduler.advance(90);
    sm.reportTerminalProgress('device-slow');
    scheduler.advance(90);
    sm.reportTerminalProgress('device-slow');
    scheduler.advance(99);
    expect(sm.getState('device-slow')).toBe('ACKED');
    expect(events).toEqual([]);

    scheduler.advance(2);
    expect(events).toEqual(['progress_timeout']);
    expect(sm.getState('device-slow')).toBe('SELECTING');
    expect(sm.getTransaction('device-slow')?.selectToken).toEqual(retryToken);
  });

  test('请求 history 却只收到 LIVE_RESUME 时保留旧画面并进入可恢复失败', () => {
    const token = new Uint8Array(16).fill(6);
    const events: string[] = [];
    const sm = new SelectStateMachine({
      onResetTerminal: () => events.push('reset'),
      onSelectFailed: (_deviceId, reason) => events.push(reason),
    });

    sm.dispatch({
      type: 'SELECT_START',
      deviceId: 'device-1',
      windowId: '@1',
      paneId: '%1',
      selectToken: token,
      wantHistory: true,
    });
    sm.dispatch({ type: 'SWITCH_ACK', deviceId: 'device-1', selectToken: token });
    sm.dispatch({ type: 'LIVE_RESUME', deviceId: 'device-1', selectToken: token });

    expect(events).toEqual(['history_missing']);
    expect(sm.getState('device-1')).toBe('STABLE');
  });
  test('已排队的过期 ACK 超时回调不会击杀同设备的新事务', () => {
    const scheduler = new LeakyScheduler();
    const firstToken = new Uint8Array(16).fill(7);
    const secondToken = new Uint8Array(16).fill(8);
    const failures: string[] = [];
    const sm = new SelectStateMachine(
      { onSelectFailed: (_deviceId, reason) => failures.push(reason) },
      { ackTimeoutMs: 100, progressTimeoutMs: 100, scheduler }
    );

    sm.dispatch({
      type: 'SELECT_START',
      deviceId: 'device-race',
      windowId: '@1',
      paneId: '%1',
      selectToken: firstToken,
      wantHistory: true,
    });
    sm.dispatch({
      type: 'SELECT_START',
      deviceId: 'device-race',
      windowId: '@1',
      paneId: '%2',
      selectToken: secondToken,
      wantHistory: true,
    });
    sm.dispatch({ type: 'SWITCH_ACK', deviceId: 'device-race', selectToken: secondToken });

    scheduler.fireCancelled();

    expect(failures).toEqual([]);
    expect(sm.getState('device-race')).toBe('ACKED');
    expect(sm.getTransaction('device-race')?.selectToken).toEqual(secondToken);

    scheduler.firePending();
    expect(failures).toEqual(['progress_timeout']);
  });

  test('已排队的过期进展超时回调不会击杀重新续期的同一事务', () => {
    const scheduler = new LeakyScheduler();
    const token = new Uint8Array(16).fill(9);
    const failures: string[] = [];
    const sm = new SelectStateMachine(
      { onSelectFailed: (_deviceId, reason) => failures.push(reason) },
      { ackTimeoutMs: 100, progressTimeoutMs: 100, scheduler }
    );

    sm.dispatch({
      type: 'SELECT_START',
      deviceId: 'device-renew',
      windowId: '@1',
      paneId: '%1',
      selectToken: token,
      wantHistory: true,
    });
    sm.dispatch({ type: 'SWITCH_ACK', deviceId: 'device-renew', selectToken: token });
    sm.reportTerminalProgress('device-renew');
    sm.reportTerminalProgress('device-renew');

    scheduler.fireCancelled();

    expect(failures).toEqual([]);
    expect(sm.getState('device-renew')).toBe('ACKED');

    scheduler.firePending();
    expect(failures).toEqual(['progress_timeout']);
    expect(sm.getState('device-renew')).toBe('STABLE');
  });

  test('replays reset, history, flush, and output in that order for one device', () => {
    const effects = new DeferredSelectEffects();
    const events: string[] = [];

    effects.deferReset('device-1', '%reset');
    effects.deferHistory('device-1', {
      paneId: '%history',
      data: 'hist',
      alternateScreen: true,
      modes: 7,
    });
    effects.deferFlush('device-1', '%flush', [new Uint8Array([1])]);
    effects.deferOutput('device-1', '%out', new Uint8Array([2]));

    effects.replay('device-1', {
      onResetTerminal: (_deviceId, paneId) => events.push(`reset:${paneId}`),
      onApplyHistory: (_deviceId, paneId, data, alternateScreen, modes) => {
        events.push(`history:${paneId}:${data}:${alternateScreen}:${modes}`);
      },
      onFlushBuffer: (_deviceId, paneId, buffer) => {
        events.push(`flush:${paneId}:${buffer.length}`);
      },
      onOutput: (_deviceId, paneId, data) => {
        events.push(`output:${paneId}:${data[0]}`);
      },
    });

    expect(events).toEqual([
      'reset:%reset',
      'reset:%history',
      'history:%history:hist:true:7',
      'flush:%flush:1',
      'output:%out:2',
    ]);
  });

  test('setCallbacks replays devices in SELECT_START order, not deferred-history arrival order', () => {
    const sm = new SelectStateMachine();
    const tokenA = new Uint8Array(16).fill(10);
    const tokenB = new Uint8Array(16).fill(11);
    const events: string[] = [];

    sm.dispatch({
      type: 'SELECT_START',
      deviceId: 'A',
      windowId: '@1',
      paneId: '%A',
      selectToken: tokenA,
      wantHistory: true,
    });
    sm.dispatch({
      type: 'SELECT_START',
      deviceId: 'B',
      windowId: '@2',
      paneId: '%B',
      selectToken: tokenB,
      wantHistory: true,
    });
    sm.dispatch({ type: 'SWITCH_ACK', deviceId: 'A', selectToken: tokenA });
    sm.dispatch({ type: 'SWITCH_ACK', deviceId: 'B', selectToken: tokenB });
    sm.dispatch({
      type: 'HISTORY',
      deviceId: 'B',
      selectToken: tokenB,
      data: 'hist-B',
      alternateScreen: false,
      modes: 0,
    });
    sm.dispatch({
      type: 'HISTORY',
      deviceId: 'A',
      selectToken: tokenA,
      data: 'hist-A',
      alternateScreen: false,
      modes: 0,
    });

    sm.setCallbacks({
      onResetTerminal: (deviceId) => events.push(`reset:${deviceId}`),
      onApplyHistory: (deviceId) => events.push(`history:${deviceId}`),
    });

    expect(events).toEqual(['reset:A', 'history:A', 'reset:B', 'history:B']);
  });
});
