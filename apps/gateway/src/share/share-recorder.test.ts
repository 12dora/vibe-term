import { describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload } from '@tmex/shared';
import type {
  PaneDataSegment,
  PaneRetentionConsumerCallbacks,
  PaneScreenCheckpoint,
} from '../tmux-client/pane-retention';
import { ShareRecorder, type ShareRecorderRuntime, hasWindow } from './share-recorder';
import type { ShareLogAppend } from './share-store';

const EPOCH = new Uint8Array(16).fill(7);

function snapshot(windows: Record<string, string[]>): StateSnapshotPayload {
  return {
    deviceId: 'dev-1',
    session: {
      id: '$0',
      name: 's',
      windows: Object.entries(windows).map(([id, panes], index) => ({
        id,
        name: `w${index}`,
        index,
        active: index === 0,
        panes: panes.map((paneId, paneIndex) => ({
          id: paneId,
          windowId: id,
          index: paneIndex,
          active: paneIndex === 0,
          width: 80,
          height: 24,
        })),
      })),
    },
  };
}

class FakeRuntime implements ShareRecorderRuntime {
  consumer: PaneRetentionConsumerCallbacks | null = null;
  leaseClosed = false;
  subscriptions: string[][] = [];
  captured: string[] = [];
  current: StateSnapshotPayload;
  baseSeq = 0n;
  missingIdentity = new Set<string>();

  constructor(initial: StateSnapshotPayload) {
    this.current = initial;
  }

  getPaneIdentity(paneId: string) {
    if (this.missingIdentity.has(paneId)) return null;
    return { paneId, paneEpoch: EPOCH };
  }

  attachPaneConsumer(callbacks: PaneRetentionConsumerCallbacks) {
    this.consumer = callbacks;
    return {
      applySubscriptions: (_gen: bigint, active: ReadonlyArray<{ paneId: string }>) => {
        this.subscriptions.push(active.map((item) => item.paneId));
        return {} as never;
      },
      close: () => {
        this.leaseClosed = true;
      },
    } as never;
  }

  gate: Promise<void> | null = null;

  async captureCanonicalScreen(paneId: string): Promise<PaneScreenCheckpoint | null> {
    if (this.gate) await this.gate;
    this.captured.push(paneId);
    return {
      paneId,
      paneEpoch: EPOCH,
      baseSeq: this.baseSeq,
      rows: 24,
      cols: 80,
      modes: 0,
      data: new TextEncoder().encode(`screen:${paneId}`),
      historyCursor: null,
      capturedAt: 1,
    };
  }

  getCurrentSnapshot(): StateSnapshotPayload | null {
    return this.current;
  }

  emit(paneId: string, text: string, seqStart: bigint): void {
    const data = new TextEncoder().encode(text);
    const segment: PaneDataSegment = {
      paneId,
      paneEpoch: EPOCH,
      seqStart,
      seqEnd: seqStart + BigInt(data.byteLength),
      data,
    };
    this.consumer?.onData(segment);
  }
}

type Harness = {
  runtime: FakeRuntime;
  recorder: ShareRecorder;
  entries: ShareLogAppend[];
  released: number;
  setTruncated(value: boolean): void;
};

function makeHarness(initial: StateSnapshotPayload, windowId = '@1'): Harness {
  const runtime = new FakeRuntime(initial);
  const entries: ShareLogAppend[] = [];
  const state = { released: 0, truncated: false, stopped: false };
  const recorder = new ShareRecorder('sh1', 'dev-1', windowId, {
    acquireRuntime: async () => runtime,
    releaseRuntime: async () => {
      state.released += 1;
    },
    appendLog: (_shareId, batch) => {
      if (state.truncated) return null;
      entries.push(...batch);
      return { truncated: false };
    },
    now: () => 5,
    flushIntervalMs: 5,
    pollIntervalMs: 5,
  });
  return {
    runtime,
    recorder,
    entries,
    get released() {
      return state.released;
    },
    setTruncated: (value) => {
      state.truncated = value;
    },
  } as Harness;
}

function decode(entry: ShareLogAppend | undefined): string {
  return entry ? new TextDecoder().decode(entry.data) : '';
}

describe('hasWindow', () => {
  test('按快照判断窗口是否还在', () => {
    const snap = snapshot({ '@1': ['%1'] });
    expect(hasWindow(snap, '@1')).toBe(true);
    expect(hasWindow(snap, '@2')).toBe(false);
    expect(hasWindow(null, '@1')).toBe(false);
  });
});

describe('ShareRecorder', () => {
  test('启动即为 window 内每个 pane 写 checkpoint 并订阅', async () => {
    const harness = makeHarness(snapshot({ '@1': ['%1', '%2'], '@2': ['%9'] }));
    await harness.recorder.start();
    harness.recorder.flush();
    expect(harness.runtime.captured.sort()).toEqual(['%1', '%2']);
    expect(harness.runtime.subscriptions.at(-1)?.sort()).toEqual(['%1', '%2']);
    expect(harness.entries.map((entry) => entry.kind)).toEqual(['checkpoint', 'checkpoint']);
    expect(harness.entries[0]).toMatchObject({ paneId: '%1', cols: 80, rows: 24 });
    expect(decode(harness.entries[0])).toBe('screen:%1');
    await harness.recorder.stop();
  });

  test('checkpoint 之后的输出记为 out；checkpoint 之前的字节按 baseSeq 裁掉', async () => {
    const harness = makeHarness(snapshot({ '@1': ['%1'] }));
    harness.runtime.baseSeq = 4n;
    await harness.recorder.start();
    harness.runtime.emit('%1', 'hello', 8n);
    harness.recorder.flush();
    const out = harness.entries.filter((entry) => entry.kind === 'out');
    expect(out).toHaveLength(1);
    expect(decode(out[0])).toBe('hello');

    harness.runtime.emit('%1', 'xy', 0n);
    harness.recorder.flush();
    expect(harness.entries.filter((entry) => entry.kind === 'out')).toHaveLength(1);
    await harness.recorder.stop();
  });

  test('订阅期间到达但早于 checkpoint 的段按 baseSeq 部分保留', async () => {
    const runtime = new FakeRuntime(snapshot({ '@1': ['%1'] }));
    runtime.baseSeq = 2n;
    let openGate = () => {};
    runtime.gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const entries: ShareLogAppend[] = [];
    const recorder = new ShareRecorder('sh1', 'dev-1', '@1', {
      acquireRuntime: async () => runtime,
      releaseRuntime: async () => {},
      appendLog: (_id, batch) => {
        entries.push(...batch);
        return { truncated: false };
      },
      now: () => 1,
      flushIntervalMs: 1_000,
      pollIntervalMs: 1_000,
    });
    const started = recorder.start();
    await Bun.sleep(1);
    runtime.consumer?.onData({
      paneId: '%1',
      paneEpoch: EPOCH,
      seqStart: 0n,
      seqEnd: 5n,
      data: new TextEncoder().encode('abcde'),
    });
    openGate();
    await started;
    recorder.flush();
    expect(entries.map((entry) => entry.kind)).toEqual(['checkpoint', 'out']);
    expect(decode(entries[1])).toBe('cde');
    await recorder.stop();
  });

  test('pane 加入 / 离开 window 由快照动态跟随', async () => {
    const harness = makeHarness(snapshot({ '@1': ['%1'] }));
    await harness.recorder.start();
    harness.runtime.current = snapshot({ '@1': ['%1', '%3'] });
    await harness.recorder.sync();
    harness.recorder.flush();
    expect(harness.runtime.captured).toEqual(['%1', '%3']);

    harness.runtime.current = snapshot({ '@1': ['%3'] });
    await harness.recorder.sync();
    harness.runtime.emit('%1', 'gone', 100n);
    harness.recorder.flush();
    const outs = harness.entries.filter((entry) => entry.kind === 'out');
    expect(outs).toHaveLength(0);
    expect(harness.runtime.subscriptions.at(-1)).toEqual(['%3']);
    await harness.recorder.stop();
  });

  test('recordInput / recordResize 不因 pane 尚未同步而丢失（作用域由 ws 层保证）', async () => {
    const harness = makeHarness(snapshot({ '@1': ['%1'] }));
    await harness.recorder.start();
    harness.recorder.recordInput('%1', new TextEncoder().encode('ls\r'));
    harness.recorder.recordInput('%1', new Uint8Array(0));
    harness.recorder.recordInput('%9', new TextEncoder().encode('late'));
    harness.recorder.recordResize('%1', 120, 40);
    harness.recorder.flush();
    const kinds = harness.entries.map((entry) => entry.kind);
    expect(kinds).toEqual(['checkpoint', 'in', 'in', 'resize']);
    expect(decode(harness.entries[1])).toBe('ls\r');
    expect(harness.entries[2]).toMatchObject({ paneId: '%9' });
    expect(harness.entries[3]).toMatchObject({ cols: 120, rows: 40 });
    await harness.recorder.stop();
  });

  test('日志写入被拒（超上限）即停止录制并释放租约', async () => {
    const harness = makeHarness(snapshot({ '@1': ['%1'] }));
    await harness.recorder.start();
    harness.setTruncated(true);
    harness.recorder.recordInput('%1', new TextEncoder().encode('x'));
    harness.recorder.flush();
    await Bun.sleep(0);
    expect(harness.recorder.active).toBe(false);
    expect(harness.runtime.leaseClosed).toBe(true);
  });

  test('pane 没有 identity 时跳过，下次 sync 再补', async () => {
    const harness = makeHarness(snapshot({ '@1': ['%1'] }));
    harness.runtime.missingIdentity.add('%1');
    await harness.recorder.start();
    expect(harness.runtime.captured).toEqual([]);
    harness.runtime.missingIdentity.clear();
    await harness.recorder.sync();
    expect(harness.runtime.captured).toEqual(['%1']);
    await harness.recorder.stop();
  });

  test('stop 关闭租约并释放 runtime，之后不再记录', async () => {
    const harness = makeHarness(snapshot({ '@1': ['%1'] }));
    await harness.recorder.start();
    await harness.recorder.stop();
    expect(harness.runtime.leaseClosed).toBe(true);
    expect(harness.released).toBe(1);
    const before = harness.entries.length;
    harness.recorder.recordInput('%1', new TextEncoder().encode('x'));
    harness.recorder.flush();
    expect(harness.entries).toHaveLength(before);
    await harness.recorder.stop();
    expect(harness.released).toBe(1);
  });
});
