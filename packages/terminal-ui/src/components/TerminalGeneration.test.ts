import { describe, expect, test } from 'bun:test';
import type {
  GatewayPaneHistoryPage,
  GatewayPaneScreenSnapshot,
  GatewayRebaseReason,
  GatewayTerminalData,
} from '@tmex/ws-client';
import { TerminalGeneration } from './TerminalGeneration';

interface FakeTarget {
  id: number;
  writes: string[];
  disposed: boolean;
  dispose(): void;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const paneEpoch = new Uint8Array(16).fill(1);
const historyEpoch = new Uint8Array(16).fill(2);

function screen(overrides: Partial<GatewayPaneScreenSnapshot> = {}): GatewayPaneScreenSnapshot {
  return {
    deviceId: 'device-a',
    paneId: '%1',
    paneEpoch,
    baseSeq: 0n,
    rows: 24,
    cols: 80,
    modes: 0,
    data: new TextEncoder().encode('screen'),
    historyCursor: null,
    ...overrides,
  };
}

function frame(seqStart: bigint, data: string): GatewayTerminalData {
  const bytes = new TextEncoder().encode(data);
  return {
    deviceId: 'device-a',
    paneId: '%1',
    paneEpoch,
    seqStart,
    seqEnd: seqStart + BigInt(bytes.length),
    data: bytes,
  };
}

function setup(
  waiters: Array<Promise<void>> = [],
  maxReplayBytes?: number,
  maxRebaseAttempts?: number,
) {
  const targets: FakeTarget[] = [];
  const activated: number[] = [];
  const recoveries: GatewayRebaseReason[] = [];
  const manager = new TerminalGeneration<FakeTarget>({
    async createTarget() {
      const target: FakeTarget = {
        id: targets.length + 1,
        writes: [],
        disposed: false,
        dispose() {
          this.disposed = true;
        },
      };
      targets.push(target);
      return target;
    },
    writeSnapshot(target, snapshot, pages) {
      target.writes.push(...pages.map((page) => `history:${new TextDecoder().decode(page.data)}`));
      target.writes.push(`snapshot:${new TextDecoder().decode(snapshot.data)}`);
    },
    writeLive(target, data) {
      target.writes.push(`live:${new TextDecoder().decode(data)}`);
    },
    waitForFirstRender(target) {
      return waiters[target.id - 1] ?? Promise.resolve();
    },
    captureScrollDistance: () => 0,
    activate(target) {
      activated.push(target.id);
    },
    onRecoveryRequired(reason) {
      recoveries.push(reason);
    },
    maxReplayBytes,
    maxRebaseAttempts,
  });
  return { manager, targets, activated, recoveries };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('TerminalGeneration', () => {
  test('assembles snapshot and live interleave offscreen before atomic activation', async () => {
    const firstRender = deferred();
    const { manager, targets, activated } = setup([Promise.resolve(), firstRender.promise]);
    await manager.initialize();

    manager.replace(screen());
    await flush();
    manager.write(frame(0n, 'live'));

    expect(activated).toEqual([1]);
    expect(targets[0]?.writes).toEqual([]);
    expect(targets[0]?.disposed).toBe(false);
    expect(targets[1]?.writes).toEqual(['snapshot:screen', 'live:live']);

    firstRender.resolve();
    await flush();
    expect(activated).toEqual([1, 2]);
    expect(targets[0]?.disposed).toBe(true);
    expect(manager.getVisibleTarget()?.id).toBe(2);
    expect(manager.getDiagnosticState()).toMatchObject({
      terminalSeq: 4n,
      recoveryState: 'live',
      recoveryReason: null,
      replayBytes: 4,
      replayBytesLimit: 2 * 1024 * 1024,
    });
  });

  test('rebase keeps the last rendered generation visible', async () => {
    const { manager, targets, recoveries } = setup();
    await manager.initialize();
    manager.replace(screen());
    await flush();

    const visible = manager.getVisibleTarget();
    manager.rebase('pane_gap');

    expect(manager.getVisibleTarget()).toBe(visible);
    expect(visible?.disposed).toBe(false);
    expect(targets[0]?.disposed).toBe(true);
    expect(recoveries).toEqual(['pane_gap']);
    expect(manager.getDiagnosticState()).toMatchObject({
      recoveryState: 'recovering',
      recoveryReason: 'pane_gap',
    });
  });

  test('replay overflow rejects the replacement and preserves the visible target', async () => {
    const { manager, targets, recoveries } = setup([], 3);
    await manager.initialize();
    const visible = manager.getVisibleTarget();
    manager.write(frame(0n, 'overflow'));
    manager.replace(screen());
    await flush();

    expect(manager.getVisibleTarget()).toBe(visible);
    expect(targets[0]?.disposed).toBe(false);
    expect(recoveries).toContain('resource_exhausted');
  });

  test('bounded cache_evicted rebase eventually accepts the snapshot as a fresh base', async () => {
    // 小 replay 窗 + 带缺口的缓冲，让 collectReplay(baseSeq=0) 反复无法连续拼接（cache_evicted）。
    const { manager, activated, recoveries } = setup([], 8, 2);
    await manager.initialize();
    manager.write(frame(0n, '12345678'));
    manager.write(frame(8n, '9')); // 挤掉 seq0 帧：observedEnd=9，最早 replay 帧起点为 8
    await flush();

    const gapped = screen({ baseSeq: 0n });
    // 模拟持续满速输出的 pane：每次收到新 snapshot 都因 replay 缺口 cache_evicted。
    // 消费者据 onRecoveryRequired 重取——前两次 cache_evicted，第三次达到上限后
    // 接受 snapshot 作 base 并激活收敛，而非无限重取。
    for (let i = 0; i < 3; i++) {
      manager.replace(gapped);
      await flush();
    }

    const evicted = recoveries.filter((reason) => reason === 'cache_evicted').length;
    expect(evicted).toBe(2); // 达到 maxRebaseAttempts 后停止重取
    expect(activated.length).toBe(2); // 接受 snapshot 作 base，成功激活新一代
    expect(manager.getDiagnosticState().recoveryState).toBe('live');
  });

  test('validates history cursor separately and rebuilds with ordered pages', async () => {
    const { manager, targets } = setup();
    await manager.initialize();
    manager.replace(
      screen({
        historyCursor: { paneEpoch, historyEpoch, beforeLine: 10 },
      })
    );
    await flush();

    const page: GatewayPaneHistoryPage = {
      deviceId: 'device-a',
      paneId: '%1',
      paneEpoch,
      historyEpoch,
      lineStart: 5,
      lineEnd: 10,
      truncated: false,
      data: new TextEncoder().encode('older'),
      nextCursor: { paneEpoch, historyEpoch, beforeLine: 5 },
    };
    expect(manager.applyHistoryPage(page)).toBe(true);
    await flush();

    expect(targets.at(-1)?.writes).toEqual(['history:older', 'snapshot:screen']);
    expect(manager.getNextHistoryCursor()?.beforeLine).toBe(5);
  });

  test('large replay is chunked with yields and catches up live that arrives mid-build', async () => {
    const targets: FakeTarget[] = [];
    const activated: number[] = [];
    const recoveries: GatewayRebaseReason[] = [];
    const firstRender = deferred();
    let yieldCount = 0;
    let injected = false;
    let manager!: TerminalGeneration<FakeTarget>;

    manager = new TerminalGeneration<FakeTarget>({
      async createTarget() {
        const target: FakeTarget = {
          id: targets.length + 1,
          writes: [],
          disposed: false,
          dispose() {
            this.disposed = true;
          },
        };
        targets.push(target);
        return target;
      },
      writeSnapshot(target, snapshot) {
        target.writes.push(`snapshot:${new TextDecoder().decode(snapshot.data)}`);
      },
      writeLive(target, data) {
        target.writes.push(`live:${new TextDecoder().decode(data)}`);
      },
      waitForFirstRender() {
        return firstRender.promise;
      },
      captureScrollDistance: () => 0,
      activate(target) {
        activated.push(target.id);
      },
      onRecoveryRequired(reason) {
        recoveries.push(reason);
      },
      replayYieldBytes: 4,
      async scheduleYield() {
        yieldCount += 1;
        if (!injected) {
          injected = true;
          // 让渡期间新到的 live 帧（seq 10，接在初始 replay 末尾）
          manager.write(frame(10n, 'MID'));
        }
        await Promise.resolve();
      },
    });

    await manager.initialize();
    manager.write(frame(0n, 'aaaaa'));
    manager.write(frame(5n, 'bbbbb'));
    manager.replace(screen({ baseSeq: 0n }));
    await flush();
    await flush();
    firstRender.resolve();
    await flush();

    const built = targets.at(-1);
    expect(built).toBeDefined();
    expect(yieldCount).toBeGreaterThan(0);
    expect(activated).toContain(built!.id);
    expect(recoveries).toEqual([]);
    // 初始 replay 分片写入 + 让渡期间到达的 MID 被同步补齐进离屏 target
    expect(built?.writes).toEqual(['snapshot:screen', 'live:aaaaa', 'live:bbbbb', 'live:MID']);
    // 激活后 cursor 已对齐到含 MID 的 observedEnd(13)，后续 live 无缺口、不触发 recovery
    manager.write(frame(13n, 'zzz'));
    expect(recoveries).toEqual([]);
    expect(built?.writes).toContain('live:zzz');
  });
});
