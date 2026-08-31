import { afterEach, describe, expect, it } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import type { Carrier, CarrierSendResult } from '../carrier';
import { createGatewaySession } from '../test-helpers';
import { sessionStateStore } from './session-state';
import { switchBarrier } from './switch-barrier';

const DEVICE_ID = 'device-g2';

function sentKinds(session: { sent: Uint8Array[] }): number[] {
  return session.sent.map((frame) => wsBorsh.decodeEnvelope(frame).kind);
}

function startSelect(
  session: ReturnType<typeof createGatewaySession>,
  options: {
    paneId?: string;
    wantHistory?: boolean;
    token?: Uint8Array;
    onLiveResumed?: () => void;
  } = {}
) {
  const selectToken = options.token ?? crypto.getRandomValues(new Uint8Array(16));
  const started = switchBarrier.startTransaction(
    session,
    {
      deviceId: DEVICE_ID,
      windowId: '@1',
      paneId: options.paneId ?? '%1',
      selectToken,
      wantHistory: options.wantHistory ?? true,
      cols: null,
      rows: null,
    },
    { onLiveResumed: options.onLiveResumed }
  );
  expect(started).toBe(true);
  return selectToken;
}

describe('SwitchBarrier LIVE_RESUME timing', () => {
  const sessions: Array<ReturnType<typeof createGatewaySession>> = [];

  afterEach(() => {
    for (const session of sessions) {
      switchBarrier.cleanupClient(session);
      sessionStateStore.delete(session);
    }
    sessions.length = 0;
  });

  function session() {
    const created = createGatewaySession({ session: true });
    sessions.push(created);
    return created;
  }

  it('最后一个 TERM_HISTORY 分块交给 socket 后立即发 LIVE_RESUME', () => {
    const ws = session();
    let resumed = 0;
    startSelect(ws, {
      onLiveResumed: () => {
        resumed += 1;
      },
    });

    switchBarrier.sendSwitchAck(ws, DEVICE_ID);
    expect(sentKinds(ws)).toEqual([wsBorsh.KIND_SWITCH_ACK]);
    expect(sessionStateStore.isBuffering(ws, DEVICE_ID)).toBe(true);

    switchBarrier.sendTermHistory(
      ws,
      DEVICE_ID,
      '%1',
      new TextEncoder().encode('READY_MARKER\n'),
      false,
      0
    );

    expect(sentKinds(ws)).toEqual([
      wsBorsh.KIND_SWITCH_ACK,
      wsBorsh.KIND_TERM_HISTORY,
      wsBorsh.KIND_LIVE_RESUME,
    ]);
    expect(resumed).toBe(1);
    expect(sessionStateStore.isBuffering(ws, DEVICE_ID)).toBe(false);
    expect(sessionStateStore.getOrCreateSelectTransaction(ws, DEVICE_ID)?.state).toBe('STABLE');
  });

  it('history 分块时 LIVE_RESUME 排在最后一个 chunk 之后', () => {
    const ws = session();
    ws.borshState.maxFrameBytes = 128;
    startSelect(ws);
    switchBarrier.sendSwitchAck(ws, DEVICE_ID);

    const history = new Uint8Array(800);
    history.fill(0x41);
    switchBarrier.sendTermHistory(ws, DEVICE_ID, '%1', history, false, 0);

    const kinds = sentKinds(ws);
    expect(kinds[0]).toBe(wsBorsh.KIND_SWITCH_ACK);
    expect(kinds.slice(1, -1).every((kind) => kind === wsBorsh.KIND_CHUNK)).toBe(true);
    expect(kinds.slice(1, -1).length).toBeGreaterThan(1);
    expect(kinds.at(-1)).toBe(wsBorsh.KIND_LIVE_RESUME);
    expect(sessionStateStore.isBuffering(ws, DEVICE_ID)).toBe(false);
  });

  it('过期 token 不能解除当前事务的屏障', () => {
    const ws = session();
    const stale = startSelect(ws);
    switchBarrier.sendSwitchAck(ws, DEVICE_ID);

    const fresh = startSelect(ws, { token: crypto.getRandomValues(new Uint8Array(16)) });
    switchBarrier.sendSwitchAck(ws, DEVICE_ID);
    const afterAck = ws.sent.length;

    switchBarrier.sendLiveResume(ws, DEVICE_ID, stale);

    expect(ws.sent.length).toBe(afterAck);
    expect(switchBarrier.validateToken(ws, DEVICE_ID, fresh)).toBe(true);
    expect(sessionStateStore.getOrCreateSelectTransaction(ws, DEVICE_ID)?.state).toBe('ACKED');
    expect(sessionStateStore.isBuffering(ws, DEVICE_ID)).toBe(true);
  });

  it('history 失败/超时时仍发送 LIVE_RESUME 以免卡死', () => {
    const ws = session();
    const token = startSelect(ws);
    switchBarrier.sendSwitchAck(ws, DEVICE_ID);
    expect(sessionStateStore.isBuffering(ws, DEVICE_ID)).toBe(true);

    (
      switchBarrier as unknown as {
        handleTimeout: (
          target: typeof ws,
          id: string,
          stage: 'ack' | 'history',
          expectedToken: Uint8Array
        ) => void;
      }
    ).handleTimeout(ws, DEVICE_ID, 'history', token);

    expect(sentKinds(ws)).toEqual([wsBorsh.KIND_SWITCH_ACK, wsBorsh.KIND_LIVE_RESUME]);
    expect(sessionStateStore.isBuffering(ws, DEVICE_ID)).toBe(false);
  });

  it('TERM_HISTORY 发送失败时仍解除屏障', () => {
    let sends = 0;
    const ws = createGatewaySession({
      session: true,
      send(bytes) {
        sends += 1;
        if (sends === 1) {
          this.sent.push(bytes);
          return 'sent';
        }
        return 'closed';
      },
    });
    sessions.push(ws);
    startSelect(ws);
    switchBarrier.sendSwitchAck(ws, DEVICE_ID);
    expect(sessionStateStore.isBuffering(ws, DEVICE_ID)).toBe(true);

    switchBarrier.sendTermHistory(
      ws,
      DEVICE_ID,
      '%1',
      new TextEncoder().encode('READY_MARKER\n'),
      false,
      0
    );

    expect(sessionStateStore.isBuffering(ws, DEVICE_ID)).toBe(false);
    expect(sessionStateStore.getOrCreateSelectTransaction(ws, DEVICE_ID)?.state).toBe('STABLE');
  });

  it('wantHistory:false 在 ACK 后立即 LIVE_RESUME，不经过 history 等待', () => {
    const ws = session();
    startSelect(ws, { wantHistory: false });
    switchBarrier.bufferOutput(ws, DEVICE_ID, new Uint8Array([7, 8]));

    switchBarrier.sendSwitchAck(ws, DEVICE_ID);

    expect(sentKinds(ws)).toEqual([
      wsBorsh.KIND_SWITCH_ACK,
      wsBorsh.KIND_LIVE_RESUME,
      wsBorsh.KIND_TERM_OUTPUT,
    ]);
    expect(sessionStateStore.isBuffering(ws, DEVICE_ID)).toBe(false);
    expect(sessionStateStore.getOrCreateSelectTransaction(ws, DEVICE_ID)?.state).toBe('STABLE');
  });

  it('wantHistory:true 的 ACK 不会提前 LIVE_RESUME', () => {
    const ws = session();
    startSelect(ws, { wantHistory: true });
    switchBarrier.sendSwitchAck(ws, DEVICE_ID);

    expect(sentKinds(ws)).toEqual([wsBorsh.KIND_SWITCH_ACK]);
    expect(sessionStateStore.isBuffering(ws, DEVICE_ID)).toBe(true);
    expect(sessionStateStore.getOrCreateSelectTransaction(ws, DEVICE_ID)?.state).toBe('ACKED');
  });

  it('hasPendingWrites 前几次为真时推迟 LIVE_RESUME，变假后再发', async () => {
    let checks = 0;
    const target = createPendingWritesCarrier(() => {
      checks += 1;
      return checks <= 2;
    });
    const ws = createGatewaySession({ session: true, carrier: target });
    sessions.push(ws);
    let resumed = 0;
    startSelect(ws, {
      onLiveResumed: () => {
        resumed += 1;
      },
    });
    switchBarrier.sendSwitchAck(ws, DEVICE_ID);
    switchBarrier.bufferOutput(ws, DEVICE_ID, new Uint8Array([9, 9]));

    switchBarrier.sendTermHistory(
      ws,
      DEVICE_ID,
      '%1',
      new TextEncoder().encode('READY_MARKER\n'),
      false,
      0
    );

    expect(sentKinds(ws)).toEqual([wsBorsh.KIND_SWITCH_ACK, wsBorsh.KIND_TERM_HISTORY]);
    expect(resumed).toBe(0);
    expect(sessionStateStore.isBuffering(ws, DEVICE_ID)).toBe(true);
    expect(sessionStateStore.getOrCreateSelectTransaction(ws, DEVICE_ID)?.state).toBe(
      'HISTORY_APPLIED'
    );

    await waitMs(100);

    expect(sentKinds(ws)).toEqual([
      wsBorsh.KIND_SWITCH_ACK,
      wsBorsh.KIND_TERM_HISTORY,
      wsBorsh.KIND_LIVE_RESUME,
      wsBorsh.KIND_TERM_OUTPUT,
    ]);
    expect(resumed).toBe(1);
    expect(sessionStateStore.isBuffering(ws, DEVICE_ID)).toBe(false);
    expect(sessionStateStore.getOrCreateSelectTransaction(ws, DEVICE_ID)?.state).toBe('STABLE');
  });

  it('wantHistory:false 在 hasPendingWrites 时同样推迟 LIVE_RESUME', async () => {
    let checks = 0;
    const target = createPendingWritesCarrier(() => {
      checks += 1;
      return checks <= 1;
    });
    const ws = createGatewaySession({ session: true, carrier: target });
    sessions.push(ws);
    startSelect(ws, { wantHistory: false });
    switchBarrier.bufferOutput(ws, DEVICE_ID, new Uint8Array([7, 8]));

    switchBarrier.sendSwitchAck(ws, DEVICE_ID);

    expect(sentKinds(ws)).toEqual([wsBorsh.KIND_SWITCH_ACK]);
    expect(sessionStateStore.isBuffering(ws, DEVICE_ID)).toBe(true);
    expect(sessionStateStore.getOrCreateSelectTransaction(ws, DEVICE_ID)?.state).toBe('ACKED');

    await waitMs(80);

    expect(sentKinds(ws)).toEqual([
      wsBorsh.KIND_SWITCH_ACK,
      wsBorsh.KIND_LIVE_RESUME,
      wsBorsh.KIND_TERM_OUTPUT,
    ]);
    expect(sessionStateStore.isBuffering(ws, DEVICE_ID)).toBe(false);
    expect(sessionStateStore.getOrCreateSelectTransaction(ws, DEVICE_ID)?.state).toBe('STABLE');
  });

  it('等待 pending writes 期间 token 变化则旧 token 不再发 LIVE_RESUME', async () => {
    const target = createPendingWritesCarrier(() => true);
    const ws = createGatewaySession({ session: true, carrier: target });
    sessions.push(ws);
    const stale = startSelect(ws);
    switchBarrier.sendSwitchAck(ws, DEVICE_ID);
    switchBarrier.sendTermHistory(
      ws,
      DEVICE_ID,
      '%1',
      new TextEncoder().encode('READY_MARKER\n'),
      false,
      0
    );
    expect(sentKinds(ws)).toEqual([wsBorsh.KIND_SWITCH_ACK, wsBorsh.KIND_TERM_HISTORY]);

    const fresh = startSelect(ws, { token: crypto.getRandomValues(new Uint8Array(16)) });
    switchBarrier.sendSwitchAck(ws, DEVICE_ID);
    const afterAck = ws.sent.length;

    await waitMs(80);

    expect(ws.sent.length).toBe(afterAck);
    expect(sentKinds(ws).includes(wsBorsh.KIND_LIVE_RESUME)).toBe(false);
    expect(switchBarrier.validateToken(ws, DEVICE_ID, fresh)).toBe(true);
    expect(switchBarrier.validateToken(ws, DEVICE_ID, stale)).toBe(false);
    expect(sessionStateStore.getOrCreateSelectTransaction(ws, DEVICE_ID)?.state).toBe('ACKED');
    expect(sessionStateStore.isBuffering(ws, DEVICE_ID)).toBe(true);
  });

  it('pending writes 等到 deadline 仍发出 LIVE_RESUME', async () => {
    const target = createPendingWritesCarrier(() => true);
    const ws = createGatewaySession({ session: true, carrier: target });
    sessions.push(ws);
    startSelect(ws);
    switchBarrier.sendSwitchAck(ws, DEVICE_ID);
    switchBarrier.sendTermHistory(
      ws,
      DEVICE_ID,
      '%1',
      new TextEncoder().encode('READY_MARKER\n'),
      false,
      0
    );
    expect(sentKinds(ws)).toEqual([wsBorsh.KIND_SWITCH_ACK, wsBorsh.KIND_TERM_HISTORY]);
    expect(sessionStateStore.isBuffering(ws, DEVICE_ID)).toBe(true);

    await waitMs(1600);

    expect(sentKinds(ws)).toEqual([
      wsBorsh.KIND_SWITCH_ACK,
      wsBorsh.KIND_TERM_HISTORY,
      wsBorsh.KIND_LIVE_RESUME,
    ]);
    expect(sessionStateStore.isBuffering(ws, DEVICE_ID)).toBe(false);
    expect(sessionStateStore.getOrCreateSelectTransaction(ws, DEVICE_ID)?.state).toBe('STABLE');
  });

  it('cancelTransaction 清除 pending-writes 等待，不会迟到发送', async () => {
    const target = createPendingWritesCarrier(() => true);
    const ws = createGatewaySession({ session: true, carrier: target });
    sessions.push(ws);
    startSelect(ws);
    switchBarrier.sendSwitchAck(ws, DEVICE_ID);
    switchBarrier.sendTermHistory(
      ws,
      DEVICE_ID,
      '%1',
      new TextEncoder().encode('READY_MARKER\n'),
      false,
      0
    );
    expect(sentKinds(ws)).toEqual([wsBorsh.KIND_SWITCH_ACK, wsBorsh.KIND_TERM_HISTORY]);

    switchBarrier.cancelTransaction(ws, DEVICE_ID);
    const afterCancel = ws.sent.length;

    await waitMs(80);

    expect(ws.sent.length).toBe(afterCancel);
    expect(sentKinds(ws).includes(wsBorsh.KIND_LIVE_RESUME)).toBe(false);
  });

  it('无 hasPendingWrites 的 WebSocket 载体立即 LIVE_RESUME', () => {
    const target = createPendingWritesCarrier();
    const ws = createGatewaySession({ session: true, carrier: target });
    sessions.push(ws);
    startSelect(ws);
    switchBarrier.sendSwitchAck(ws, DEVICE_ID);
    switchBarrier.sendTermHistory(
      ws,
      DEVICE_ID,
      '%1',
      new TextEncoder().encode('READY_MARKER\n'),
      false,
      0
    );

    expect(sentKinds(ws)).toEqual([
      wsBorsh.KIND_SWITCH_ACK,
      wsBorsh.KIND_TERM_HISTORY,
      wsBorsh.KIND_LIVE_RESUME,
    ]);
    expect(sessionStateStore.isBuffering(ws, DEVICE_ID)).toBe(false);
    expect(sessionStateStore.getOrCreateSelectTransaction(ws, DEVICE_ID)?.state).toBe('STABLE');
  });

  it('ACKED 下 LIVE_RESUME 发送失败经 SELECT_FAILED 到 STABLE', () => {
    const target = createPendingWritesCarrier();
    const originalSend = target.send.bind(target);
    target.send = (bytes: Uint8Array) => {
      const kind = wsBorsh.decodeEnvelope(bytes).kind;
      if (kind === wsBorsh.KIND_LIVE_RESUME) return 'backpressure';
      return originalSend(bytes);
    };
    const ws = createGatewaySession({ session: true, carrier: target });
    sessions.push(ws);
    startSelect(ws, { wantHistory: false });
    switchBarrier.sendSwitchAck(ws, DEVICE_ID);

    expect(sentKinds(ws)).toEqual([wsBorsh.KIND_SWITCH_ACK]);
    expect(sessionStateStore.isBuffering(ws, DEVICE_ID)).toBe(false);
    expect(sessionStateStore.getOrCreateSelectTransaction(ws, DEVICE_ID)?.state).toBe('STABLE');
  });
});

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type PendingWritesCarrier = Carrier & {
  sent: Uint8Array[];
  hasPendingWrites?: () => boolean;
};

function createPendingWritesCarrier(isPending?: () => boolean): PendingWritesCarrier {
  const carrier: PendingWritesCarrier = {
    sent: [],
    send(bytes: Uint8Array): CarrierSendResult {
      carrier.sent.push(bytes);
      return 'sent';
    },
    bufferedAmount() {
      return 0;
    },
    onDrain() {},
    close() {},
    terminate() {},
  };
  if (isPending) {
    carrier.hasPendingWrites = isPending;
  }
  return carrier;
}
