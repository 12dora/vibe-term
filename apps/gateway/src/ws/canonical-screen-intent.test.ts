// 首屏意图（canonical-screen-intent-v1）的服务端行为：attach 后解析 → 同一 burst 回首屏事务、
// pane/window 缺省时的回落、解析失败必须回 Error，以及同一 requestId 的幂等与重试边界。

import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@vibeterm/shared';

import type { DeviceSessionRuntimeListener } from '../tmux-client/device-session-runtime';
import type { PaneHistoryCursor, PaneHistoryPage } from '../tmux-client/pane-history-reader';
import {
  PaneRetention,
  type PaneRetentionConsumerCallbacks,
  type PaneScreenCheckpoint,
} from '../tmux-client/pane-retention';
import { type CanonicalFeedRuntime, CanonicalFeedSession } from './canonical-feed-session';

const SERVER_EPOCH = new Uint8Array(16).fill(0x11);
const PANE_EPOCH = new Uint8Array(16).fill(0x22);
const SECOND_PANE_EPOCH = new Uint8Array(16).fill(0x23);
const REQUEST_ID = new Uint8Array(16).fill(0x33);
const encoder = new TextEncoder();

function key(entityKind: number, nativeId: string): wsBorsh.SourceEntityKey {
  return { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, entityKind, nativeId };
}

class IntentRuntime implements CanonicalFeedRuntime {
  readonly retention = new PaneRetention({ scheduleTimers: false });
  captures = 0;
  /** 非 null 时抓屏挂起，由测试手工放行，用来制造「在途」窗口 */
  pendingCapture: (() => void) | null = null;
  captureFails = false;
  /** 置位后 metadata 里没有任何 window / pane，用来构造「什么都解析不出来」 */
  barren = false;

  constructor() {
    this.retention.reconcilePanes([
      { paneId: '%1', paneEpoch: PANE_EPOCH },
      { paneId: '%2', paneEpoch: SECOND_PANE_EPOCH },
    ]);
    this.retention.ingest('%1', PANE_EPOCH, encoder.encode('one'));
    this.retention.ingest('%2', SECOND_PANE_EPOCH, encoder.encode('two'));
  }

  getServerEpoch(): Uint8Array {
    return SERVER_EPOCH;
  }

  getMetadataSnapshot() {
    const active = (value: boolean) => ({
      field: wsBorsh.SOURCE_FIELD_ACTIVE,
      value: { Bool: value },
    });
    const session = key(wsBorsh.SOURCE_ENTITY_SESSION, '$1');
    if (this.barren) {
      return { metadataEpoch: new Uint8Array(16).fill(0x44), revision: 1n, records: [] };
    }
    const idle = key(wsBorsh.SOURCE_ENTITY_WINDOW, '@0');
    const window = key(wsBorsh.SOURCE_ENTITY_WINDOW, '@1');
    return {
      metadataEpoch: new Uint8Array(16).fill(0x44),
      revision: 1n,
      records: [
        { key: session, parent: null, fields: [] },
        { key: idle, parent: session, fields: [active(false)] },
        { key: window, parent: session, fields: [active(true)] },
        {
          key: key(wsBorsh.SOURCE_ENTITY_PANE, '%9'),
          parent: idle,
          fields: [active(true)],
        },
        {
          key: key(wsBorsh.SOURCE_ENTITY_PANE, '%2'),
          parent: window,
          fields: [
            active(false),
            { field: wsBorsh.SOURCE_FIELD_PANE_EPOCH, value: { Bytes16: SECOND_PANE_EPOCH } },
          ],
        },
        {
          key: key(wsBorsh.SOURCE_ENTITY_PANE, '%1'),
          parent: window,
          fields: [
            active(true),
            { field: wsBorsh.SOURCE_FIELD_PANE_EPOCH, value: { Bytes16: PANE_EPOCH } },
          ],
        },
      ],
    };
  }

  getPaneIdentity(paneId: string) {
    if (paneId === '%1') return { paneId, paneEpoch: PANE_EPOCH };
    if (paneId === '%2') return { paneId, paneEpoch: SECOND_PANE_EPOCH };
    return null;
  }

  attachPaneConsumer(callbacks: PaneRetentionConsumerCallbacks) {
    return this.retention.attachConsumer(callbacks);
  }

  subscribe(_listener: DeviceSessionRuntimeListener): () => void {
    return () => {};
  }

  async readPaneHistory(
    _paneId: string,
    _cursor: PaneHistoryCursor | null,
    _byteLimit: number
  ): Promise<PaneHistoryPage | null> {
    return null;
  }

  async captureCanonicalScreen(paneId: string): Promise<PaneScreenCheckpoint | null> {
    this.captures += 1;
    if (this.pendingCapture) {
      await new Promise<void>((resolve) => {
        this.pendingCapture = resolve;
      });
    }
    if (this.captureFails) return null;
    const cursor = this.retention.getLatestCursor(paneId);
    if (!cursor) return null;
    return {
      paneId,
      paneEpoch: paneId === '%1' ? PANE_EPOCH : SECOND_PANE_EPOCH,
      baseSeq: cursor.terminalSeq,
      rows: 24,
      cols: 80,
      modes: 0,
      data: encoder.encode(paneId),
      historyCursor: null,
      capturedAt: Date.now(),
    };
  }

  sendInputBytes(): void {}

  resizePane(): void {}
}

function createSession(runtime: CanonicalFeedRuntime) {
  const events: wsBorsh.CanonicalEvent[] = [];
  const session = new CanonicalFeedSession({
    maxFrameBytes: 32 * 1024,
    resolveRuntime: async () => runtime,
    sendEvent: (event) => {
      events.push(event);
      return true;
    },
  });
  return { session, events };
}

function names(events: wsBorsh.CanonicalEvent[]): string[] {
  return events.map((event) => Object.keys(event)[0] as string);
}

function screenBegin(events: wsBorsh.CanonicalEvent[]) {
  const found = events.find((event) => 'ScreenBegin' in event);
  return found && 'ScreenBegin' in found ? found.ScreenBegin : null;
}

function intent(overrides: Partial<{ windowId: string | null; paneId: string | null }> = {}) {
  return {
    RequestScreenIntent: {
      requestId: REQUEST_ID,
      deviceId: 'device-a',
      windowId: null,
      paneId: '%1' as string | null,
      byteLimit: 4096,
      ...overrides,
    },
  };
}

describe('canonical RequestScreenIntent', () => {
  test('attach 后解析出 pane，并在同一 burst 里回 metadata 与首屏事务', async () => {
    const runtime = new IntentRuntime();
    const { session, events } = createSession(runtime);
    await session.handleCommand(intent());
    expect(names(events)).toEqual([
      'FeedReady',
      'SourceMetadataSnapshot',
      'ScreenBegin',
      'ScreenChunk',
      'ScreenCommit',
    ]);
    const begin = screenBegin(events);
    expect(begin?.pane.paneId).toBe('%1');
    expect(begin?.pane.serverEpoch).toEqual(SERVER_EPOCH);
    expect(begin?.requestId).toEqual(REQUEST_ID);
    session.close();
  });

  test('pane 未指定时落到设备活动窗口的活动 pane', async () => {
    const runtime = new IntentRuntime();
    const { session, events } = createSession(runtime);
    await session.handleCommand(intent({ paneId: null }));
    expect(screenBegin(events)?.pane.paneId).toBe('%1');
    session.close();
  });

  test('window 指定、pane 未指定时落到该窗口的活动 pane', async () => {
    const runtime = new IntentRuntime();
    const { session, events } = createSession(runtime);
    await session.handleCommand(intent({ paneId: null, windowId: '@0' }));
    // @0 的活动 pane 是 %9，运行时不认识它 → 明确报错而不是换一个 pane 糊弄
    const error = events.find((event) => 'Error' in event);
    expect(error && 'Error' in error && error.Error.code).toBe(wsBorsh.ERROR_TMUX_TARGET_NOT_FOUND);
    session.close();
  });

  // 本地拓扑给的占位 pane 在 attach 之前就关掉了：回落到当前活动 pane，仍然一轮回完
  test('占位 pane 已经不在时回落到设备活动 pane，照样一轮给出首屏', async () => {
    const runtime = new IntentRuntime();
    const { session, events } = createSession(runtime);
    await session.handleCommand(intent({ paneId: '%404' }));
    expect(names(events)).toEqual([
      'FeedReady',
      'SourceMetadataSnapshot',
      'ScreenBegin',
      'ScreenChunk',
      'ScreenCommit',
    ]);
    expect(screenBegin(events)?.pane.paneId).toBe('%1');
    session.close();
  });

  test('一个 pane 都解析不出来时回 Error，不静默丢弃（客户端才不会一直等）', async () => {
    const runtime = new IntentRuntime();
    runtime.barren = true;
    const { session, events } = createSession(runtime);
    await session.handleCommand(intent({ paneId: '%404' }));
    const error = events.find((event) => 'Error' in event);
    expect(error && 'Error' in error && error.Error.requestId).toEqual(REQUEST_ID);
    expect(error && 'Error' in error && error.Error.retryable).toBe(false);
    expect(names(events)).not.toContain('ScreenBegin');
    session.close();
  });

  test('迟到的旧式 RequestScreen 带同一 requestId 时不再抓第二次屏', async () => {
    const runtime = new IntentRuntime();
    runtime.pendingCapture = () => {};
    const { session, events } = createSession(runtime);
    const inflight = session.handleCommand(intent());
    await Bun.sleep(0);
    expect(runtime.captures).toBe(1);
    await session.handleCommand({
      RequestScreen: {
        requestId: REQUEST_ID,
        pane: { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' },
        byteLimit: 4096,
      },
    });
    expect(runtime.captures).toBe(1);
    runtime.pendingCapture?.();
    runtime.pendingCapture = null;
    await inflight;
    await Bun.sleep(0);
    expect(names(events).filter((name) => name === 'ScreenCommit')).toHaveLength(1);
    session.close();
  });

  test('同一 requestId 在首屏失败之后仍然可以重试（幂等只挡在途的那一笔）', async () => {
    const runtime = new IntentRuntime();
    runtime.captureFails = true;
    const { session, events } = createSession(runtime);
    await session.handleCommand(intent());
    expect(runtime.captures).toBe(1);
    const failed = events.find((event) => 'Error' in event);
    expect(failed && 'Error' in failed && failed.Error.retryable).toBe(true);
    runtime.captureFails = false;
    await session.handleCommand({
      RequestScreen: {
        requestId: REQUEST_ID,
        pane: { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' },
        byteLimit: 4096,
      },
    });
    expect(runtime.captures).toBe(2);
    expect(names(events)).toContain('ScreenCommit');
    session.close();
  });

  // 客户端在 metadata 未到达时只能用全零 serverEpoch 占位订阅：网关按 epoch 不匹配拒掉，
  // 首屏不受影响（意图自带解析），实时输出要等客户端拿到 metadata 后补发的那一次订阅。
  test('占位订阅（零 serverEpoch）按 epoch_changed 拒绝，不会误当成当前 epoch', async () => {
    const runtime = new IntentRuntime();
    const { session, events } = createSession(runtime);
    await session.handleCommand({
      SetPaneSubscriptions: {
        generation: 1n,
        activePanes: [
          {
            pane: { deviceId: 'device-a', serverEpoch: new Uint8Array(16), paneId: '%1' },
            cursor: null,
          },
        ],
        hotPanes: [],
      },
    });
    const applied = events.find((event) => 'SubscriptionApplied' in event);
    const payload =
      applied && 'SubscriptionApplied' in applied ? applied.SubscriptionApplied : null;
    expect(payload?.activePanes).toEqual([]);
    expect(payload?.rejected[0]?.reason).toBe(wsBorsh.SUBSCRIPTION_REJECTED_EPOCH_CHANGED);
    session.close();
  });

  test('老客户端（不发意图）的时序一字不改', async () => {
    const runtime = new IntentRuntime();
    const { session, events } = createSession(runtime);
    await session.handleCommand({
      SetPaneSubscriptions: {
        generation: 1n,
        activePanes: [
          { pane: { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' }, cursor: null },
        ],
        hotPanes: [],
      },
    });
    await session.handleCommand({
      RequestScreen: {
        requestId: REQUEST_ID,
        pane: { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' },
        byteLimit: 4096,
      },
    });
    expect(names(events)).toEqual([
      'FeedReady',
      'SourceMetadataSnapshot',
      'SubscriptionApplied',
      'ScreenBegin',
      'ScreenChunk',
      'ScreenCommit',
    ]);
    session.close();
  });
});
