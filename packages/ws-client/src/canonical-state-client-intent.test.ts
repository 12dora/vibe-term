// 首屏意图的端到端时序：真实 CanonicalStateClient ↔ 真实网关 CanonicalFeedSession。
// 关注两件事——首个 ScreenCommit 之前客户端发了几批命令（能力开=1 批，关=2 批），
// 以及合并回包之后不会再补发一次首屏请求。

import { describe, expect, test } from 'bun:test';
import { GATEWAY_CAPABILITY_CANONICAL_SCREEN_INTENT_V1, wsBorsh } from '@vibeterm/shared';
import type { PaneHistoryCursor } from '../../../apps/gateway/src/tmux-client/pane-history-reader';
import { PaneRetention } from '../../../apps/gateway/src/tmux-client/pane-retention';
import {
  type CanonicalFeedRuntime,
  CanonicalFeedSession,
} from '../../../apps/gateway/src/ws/canonical-feed-session';
import { CanonicalStateClient } from './canonical-state-client';
import type { GatewayTransportEvent } from './transport-types';

const SERVER_EPOCH = new Uint8Array(16).fill(0x10);
const METADATA_EPOCH = new Uint8Array(16).fill(0x20);
const HISTORY_EPOCH = new Uint8Array(16).fill(0x30);
const PANE_EPOCH = new Uint8Array(16).fill(0x40);
const SCREEN_REQUEST = new Uint8Array(16).fill(0x50);

function key(entityKind: number, nativeId: string): wsBorsh.SourceEntityKey {
  return { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, entityKind, nativeId };
}

class Runtime implements CanonicalFeedRuntime {
  readonly retention = new PaneRetention({ scheduleTimers: false });
  captures = 0;

  constructor() {
    this.retention.reconcilePanes([{ paneId: '%1', paneEpoch: PANE_EPOCH }]);
  }

  getServerEpoch(): Uint8Array {
    return SERVER_EPOCH;
  }

  getPaneIdentity(paneId: string) {
    return paneId === '%1' ? { paneId, paneEpoch: PANE_EPOCH } : null;
  }

  getMetadataSnapshot() {
    const active = { field: wsBorsh.SOURCE_FIELD_ACTIVE, value: { Bool: true } as const };
    const session = key(wsBorsh.SOURCE_ENTITY_SESSION, '$1');
    const window = key(wsBorsh.SOURCE_ENTITY_WINDOW, '@1');
    return {
      metadataEpoch: METADATA_EPOCH,
      revision: 1n,
      records: [
        { key: session, parent: null, fields: [] },
        { key: window, parent: session, fields: [active] },
        {
          key: key(wsBorsh.SOURCE_ENTITY_PANE, '%1'),
          parent: window,
          fields: [
            active,
            { field: wsBorsh.SOURCE_FIELD_PANE_EPOCH, value: { Bytes16: PANE_EPOCH } },
          ],
        },
      ],
    };
  }

  attachPaneConsumer(callbacks: Parameters<PaneRetention['attachConsumer']>[0]) {
    return this.retention.attachConsumer(callbacks);
  }

  subscribe(): () => void {
    return () => {};
  }

  async readPaneHistory(_paneId: string, _cursor: PaneHistoryCursor | null, _bytes: number) {
    return null;
  }

  async captureCanonicalScreen(paneId: string) {
    this.captures += 1;
    const cursor = this.retention.getLatestCursor(paneId);
    if (!cursor) return null;
    return {
      paneId,
      paneEpoch: PANE_EPOCH,
      baseSeq: cursor.terminalSeq,
      rows: 24,
      cols: 80,
      modes: 0,
      data: new TextEncoder().encode('base'),
      historyCursor: { paneEpoch: PANE_EPOCH, historyEpoch: HISTORY_EPOCH, beforeLine: 100 },
      capturedAt: Date.now(),
    };
  }

  sendInputBytes(): void {}

  resizePane(): void {}
}

interface SentCommand {
  name: string;
  /** 这条命令属于第几批（同一批之间没有任何服务端回包，对应一个往返） */
  flush: number;
}

function createHarness(capabilities: readonly string[]) {
  const runtime = new Runtime();
  const events: GatewayTransportEvent[] = [];
  const sent: SentCommand[] = [];
  const outbox: wsBorsh.CanonicalCommand[] = [];
  // 已经开始处理的批次数：发送时记 flush + 1，即这条命令会跟着下一批出去
  let flush = 0;
  let screenFlush: number | null = null;
  let id = 0;
  const client = new CanonicalStateClient({
    emit: (event) => {
      events.push(event);
      if (event.type === 'screen-snapshot' && screenFlush === null) screenFlush = flush;
    },
    effectiveMaxFrameBytes: () => 32 * 1024,
    createId: () => new Uint8Array(16).fill(++id),
    send: (message) => {
      const command = wsBorsh.decodeCanonicalCommandPayload(message.payload).command;
      sent.push({ name: Object.keys(command)[0] as string, flush: flush + 1 });
      outbox.push(command);
      return 'sent';
    },
  });
  const server = new CanonicalFeedSession({
    maxFrameBytes: 32 * 1024,
    resolveRuntime: async () => runtime,
    sendEvent: (event) => {
      client.handleEventPayload(wsBorsh.encodeCanonicalEventPayload(event));
      return true;
    },
  });
  client.setServerCapabilities(capabilities);
  client.activate();
  return {
    runtime,
    client,
    server,
    events,
    sent,
    /** 首个 ScreenCommit 落地时已经走完的客户端批次数（HELLO 不计） */
    screenFlush: () => screenFlush,
    /** 按批次推进：一批命令全部送达后才让回包进来，模拟真实链路的往返 */
    async pump(): Promise<void> {
      for (let round = 0; round < 20; round += 1) {
        const batch = outbox.splice(0);
        if (batch.length === 0) {
          await Bun.sleep(0);
          if (outbox.length === 0) return;
          continue;
        }
        flush += 1;
        for (const command of batch) await server.handleCommand(command);
        await Bun.sleep(0);
      }
      throw new Error('canonical round trip did not settle');
    },
  };
}

/** 终端挂载那一刻会做的两件事：把 pane 计入订阅、请求首屏。 */
function mountPane(client: CanonicalStateClient): void {
  client.sendCommand({
    type: 'set-pane-subscriptions',
    deviceId: 'device-a',
    generation: 1n,
    paneIds: ['%1'],
  });
  client.sendCommand({
    type: 'request-pane-screen',
    requestId: SCREEN_REQUEST,
    deviceId: 'device-a',
    paneId: '%1',
    byteLimit: 4096,
  });
}

function screenText(events: GatewayTransportEvent[]): string | null {
  const snapshot = events.find((event) => event.type === 'screen-snapshot');
  return snapshot?.type === 'screen-snapshot'
    ? new TextDecoder().decode(snapshot.snapshot.data)
    : null;
}

describe('首屏意图 ↔ 网关', () => {
  test('能力开：首屏意图在第一批里，metadata 与首屏事务在同一轮回包，首屏正常落地', async () => {
    const harness = createHarness([GATEWAY_CAPABILITY_CANONICAL_SCREEN_INTENT_V1]);
    mountPane(harness.client);
    await harness.pump();

    const screenRequest = harness.sent.find((item) => item.name.startsWith('RequestScreen'));
    expect(screenRequest?.name).toBe('RequestScreenIntent');
    // HELLO 之后的第一批就带上了首屏意图，首屏在这一批的回包里落地：
    // 首个 ScreenCommit 之前的交换次数 = HELLO + 1 次合并往返 = 2
    expect(screenRequest?.flush).toBe(1);
    expect(harness.screenFlush()).toBe(1);
    expect(screenText(harness.events)).toBe('base');
    expect(harness.runtime.captures).toBe(1);
    harness.server.close();
    harness.client.dispose();
  });

  test('合并回包之后不会再补发一次首屏（同一 pane 只抓一次屏）', async () => {
    const harness = createHarness([GATEWAY_CAPABILITY_CANONICAL_SCREEN_INTENT_V1]);
    mountPane(harness.client);
    await harness.pump();
    const screenCommands = harness.sent.filter((item) => item.name.startsWith('RequestScreen'));
    expect(screenCommands).toHaveLength(1);
    expect(harness.runtime.captures).toBe(1);
    harness.server.close();
    harness.client.dispose();
  });

  // 占位订阅带全零 serverEpoch：网关改写成当前 epoch 并在首屏同一批 apply。
  // metadata 落地后客户端仍可再发一代（兼容），但不需要靠那一代才有 live。
  test('占位订阅被网关改写，首屏同一批即可订阅成功', async () => {
    const harness = createHarness([GATEWAY_CAPABILITY_CANONICAL_SCREEN_INTENT_V1]);
    mountPane(harness.client);
    await harness.pump();

    const subscriptions = harness.sent.filter((item) => item.name === 'SetPaneSubscriptions');
    expect(subscriptions[0]?.flush).toBe(1);
    const applied = harness.events.filter((event) => event.type === 'subscription-applied');
    expect(applied.length).toBeGreaterThan(0);
    expect(
      applied.every(
        (event) => event.type === 'subscription-applied' && event.rejectedPaneIds.length === 0
      )
    ).toBe(true);
    const first = applied[0];
    expect(first?.type === 'subscription-applied' && first.paneIds).toEqual(['%1']);
    expect(harness.screenFlush()).toBe(1);
    harness.server.close();
    harness.client.dispose();
  });

  test('能力关：首屏请求要等 metadata 落地才发得出去，比意图多一轮', async () => {
    const harness = createHarness([]);
    mountPane(harness.client);
    await harness.pump();

    const screenRequest = harness.sent.find((item) => item.name.startsWith('RequestScreen'));
    expect(screenRequest?.name).toBe('RequestScreen');
    // 旧时序：首屏请求要等第一批的回包（metadata）才发得出去，首个 ScreenCommit 前共 3 次交换
    expect(screenRequest?.flush).toBe(2);
    expect(harness.screenFlush()).toBe(2);
    expect(screenText(harness.events)).toBe('base');
    harness.server.close();
    harness.client.dispose();
  });

  test('能力关时不发新命令：老网关只会收到 v1.1 就有的那几种', async () => {
    const harness = createHarness([]);
    mountPane(harness.client);
    await harness.pump();
    expect(harness.sent.some((item) => item.name === 'RequestScreenIntent')).toBe(false);
    harness.server.close();
    harness.client.dispose();
  });

  // 网关会为「占位 pane 已不在」的意图回落到活动 pane；客户端按 pane 身份守卫丢掉这一屏，
  // 并对请求的那个 pane 发 pane_gap（恢复信号），不会把别的 pane 的内容画到它上面
  test('占位 pane 已不在：网关回落的那一屏不会被错画，改成 pane_gap 触发恢复', async () => {
    const harness = createHarness([GATEWAY_CAPABILITY_CANONICAL_SCREEN_INTENT_V1]);
    harness.client.sendCommand({
      type: 'request-pane-screen',
      requestId: SCREEN_REQUEST,
      deviceId: 'device-a',
      paneId: '%404',
      byteLimit: 4096,
    });
    await harness.pump();
    expect(screenText(harness.events)).toBeNull();
    const rebase = harness.events.find(
      (event) => event.type === 'rebase-required' && event.paneId === '%404'
    );
    expect(rebase?.type === 'rebase-required' && rebase.reason).toBe('pane_gap');
    harness.server.close();
    harness.client.dispose();
  });
});
