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

function setup(waiters: Array<Promise<void>> = [], maxReplayBytes?: number) {
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
});
