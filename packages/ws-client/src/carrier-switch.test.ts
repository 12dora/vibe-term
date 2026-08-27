import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import {
  CarrierSwitchBarrier,
  type CarrierSwitchBarrierOptions,
  type DirectCarrierLike,
  peekEnvelopeKind,
} from './carrier-switch';

function dataFrame(text: string, seq = 0): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.TermInputSchema, {
    deviceId: 'd',
    paneId: text,
    encoding: 0,
    data: new Uint8Array(0),
    isComposing: false,
  });
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_TERM_INPUT, payload, seq);
}

function frameLabel(bytes: Uint8Array): string {
  const envelope = wsBorsh.decodeEnvelope(bytes);
  return wsBorsh.decodePayload(wsBorsh.schema.TermInputSchema, envelope.payload).paneId;
}

/** `rtcSession` 缺省空串 = 老 node 不带 attempt 标识。 */
function switchFrame(epoch: number, to: 'direct' | 'primary', rtcSession = ''): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.CarrierSwitchSchema, {
    epoch,
    to: to === 'direct' ? wsBorsh.CARRIER_SWITCH_TO_DIRECT : wsBorsh.CARRIER_SWITCH_TO_PRIMARY,
    rtcSession,
  });
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_CARRIER_SWITCH, payload, 0);
}

class FakeCarrier implements DirectCarrierLike {
  readonly sent: Uint8Array[] = [];
  closed = false;
  private messageCb: ((bytes: Uint8Array) => void) | null = null;
  private closeCb: (() => void) | null = null;
  sendResult: 'sent' | 'backpressure' | 'closed' = 'sent';

  send(bytes: Uint8Array): 'sent' | 'backpressure' | 'closed' {
    if (this.sendResult === 'closed') return 'closed';
    this.sent.push(bytes);
    return this.sendResult;
  }

  onMessage(cb: (bytes: Uint8Array) => void): void {
    this.messageCb = cb;
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  close(): void {
    this.closed = true;
  }

  deliver(bytes: Uint8Array): void {
    this.messageCb?.(bytes);
  }

  simulateClose(): void {
    this.closed = true;
    this.closeCb?.();
  }
}

interface Harness {
  barrier: CarrierSwitchBarrier;
  delivered: string[];
  primary: Uint8Array[];
  changes: string[];
  resumes: number;
}

function harness(options: Partial<CarrierSwitchBarrierOptions> = {}): Harness {
  const delivered: string[] = [];
  const primary: Uint8Array[] = [];
  const changes: string[] = [];
  let resumes = 0;
  const barrier = new CarrierSwitchBarrier({
    deliver: (bytes) => delivered.push(frameLabel(bytes)),
    sendPrimary: (bytes) => primary.push(bytes),
    onCarrierChange: (active) => changes.push(active),
    resumeSubscribedPanes: () => {
      resumes += 1;
    },
    ...options,
  });
  return {
    barrier,
    delivered,
    primary,
    changes,
    get resumes() {
      return resumes;
    },
  } as Harness;
}

function acks(frames: Uint8Array[]): Array<{ epoch: number; rtcSession: string }> {
  return frames
    .filter((f) => peekEnvelopeKind(f) === wsBorsh.KIND_CARRIER_SWITCH_ACK)
    .map((f) => {
      const envelope = wsBorsh.decodeEnvelope(f);
      const payload = wsBorsh.decodePayload(
        wsBorsh.schema.CarrierSwitchAckSchema,
        envelope.payload
      );
      return { epoch: payload.epoch, rtcSession: payload.rtcSession };
    });
}

function ackEpochs(frames: Uint8Array[]): number[] {
  return acks(frames).map((a) => a.epoch);
}

describe('peekEnvelopeKind', () => {
  test('从头 6 字节读出 kind，magic 不对或过短返回 null', () => {
    expect(peekEnvelopeKind(switchFrame(1, 'direct'))).toBe(wsBorsh.KIND_CARRIER_SWITCH);
    expect(peekEnvelopeKind(dataFrame('a'))).toBe(wsBorsh.KIND_TERM_INPUT);
    expect(peekEnvelopeKind(new Uint8Array(4))).toBeNull();
    expect(peekEnvelopeKind(new Uint8Array(20))).toBeNull();
  });
});

describe('CarrierSwitchBarrier', () => {
  test('挂载直连后仍走 primary，直到切换帧到达', () => {
    const h = harness();
    const direct = new FakeCarrier();
    h.barrier.attachDirect(direct);
    expect(h.barrier.activeCarrier).toBe('primary');

    h.barrier.send(dataFrame('out-1'));
    expect(direct.sent.length).toBe(0);
    expect(h.primary.length).toBe(1);
  });

  test('跨切换不乱序：直连上先到的帧缓冲，收到 CARRIER_SWITCH 后先排空再改活跃源', () => {
    const h = harness();
    const direct = new FakeCarrier();
    h.barrier.attachDirect(direct);

    h.barrier.handlePrimaryInbound(dataFrame('p1'));
    direct.deliver(dataFrame('d1'));
    direct.deliver(dataFrame('d2'));
    expect(h.delivered).toEqual(['p1']);
    expect(h.barrier.bufferedCount).toBe(2);

    h.barrier.handlePrimaryInbound(dataFrame('p2'));
    h.barrier.handlePrimaryInbound(switchFrame(1, 'direct'));

    expect(h.delivered).toEqual(['p1', 'p2', 'd1', 'd2']);
    expect(h.barrier.activeCarrier).toBe('direct');
    expect(h.changes).toEqual(['direct']);

    direct.deliver(dataFrame('d3'));
    expect(h.delivered[h.delivered.length - 1]).toBe('d3');
  });

  test('ACK 走旧载体（primary），epoch 与切换帧一致；之后出站改走直连', () => {
    const h = harness();
    const direct = new FakeCarrier();
    h.barrier.attachDirect(direct);
    h.barrier.handlePrimaryInbound(switchFrame(3, 'direct'));

    expect(ackEpochs(h.primary)).toEqual([3]);
    h.barrier.send(dataFrame('out'));
    expect(direct.sent.length).toBe(1);
  });

  test('陈旧 epoch 的切换帧被忽略，也不回 ACK', () => {
    const h = harness();
    const direct = new FakeCarrier();
    h.barrier.attachDirect(direct);
    h.barrier.handlePrimaryInbound(switchFrame(5, 'direct'));
    expect(ackEpochs(h.primary)).toEqual([5]);

    h.barrier.handlePrimaryInbound(switchFrame(5, 'primary'));
    h.barrier.handlePrimaryInbound(switchFrame(4, 'primary'));
    expect(h.barrier.activeCarrier).toBe('direct');
    expect(ackEpochs(h.primary)).toEqual([5]);
    expect(h.resumes).toBe(0);
  });

  test('未挂载直连时收到 CARRIER_SWITCH{to:direct} 不切换、不回 ACK', () => {
    const h = harness();
    h.barrier.handlePrimaryInbound(switchFrame(1, 'direct'));
    expect(h.barrier.activeCarrier).toBe('primary');
    expect(ackEpochs(h.primary)).toEqual([]);
  });

  test('CARRIER_SWITCH{epoch+1,to:primary} 切回并触发一次 resume', () => {
    const h = harness();
    const direct = new FakeCarrier();
    h.barrier.attachDirect(direct);
    h.barrier.handlePrimaryInbound(switchFrame(1, 'direct'));
    h.barrier.handlePrimaryInbound(switchFrame(2, 'primary'));

    expect(h.barrier.activeCarrier).toBe('primary');
    expect(h.changes).toEqual(['direct', 'primary']);
    expect(h.resumes).toBe(1);

    h.barrier.send(dataFrame('out'));
    expect(direct.sent.length).toBe(0);
  });

  test('直连自行关闭：回落 primary 并 resume，随后到达的切回帧不再重复 resume', () => {
    const h = harness();
    const direct = new FakeCarrier();
    h.barrier.attachDirect(direct);
    h.barrier.handlePrimaryInbound(switchFrame(1, 'direct'));

    direct.simulateClose();
    expect(h.barrier.activeCarrier).toBe('primary');
    expect(h.resumes).toBe(1);

    h.barrier.handlePrimaryInbound(switchFrame(2, 'primary'));
    expect(h.resumes).toBe(1);
  });

  test('出站时直连返回 closed → 就地回落 primary 并重发该帧', () => {
    const h = harness();
    const direct = new FakeCarrier();
    h.barrier.attachDirect(direct);
    h.barrier.handlePrimaryInbound(switchFrame(1, 'direct'));
    const acks = h.primary.length;

    direct.sendResult = 'closed';
    h.barrier.send(dataFrame('out'));
    expect(h.barrier.activeCarrier).toBe('primary');
    expect(h.primary.length).toBe(acks + 1);
  });

  test('primary 断开 → closeDirect 关掉直连、epoch 归零，重连后新 epoch 1 可再切', () => {
    const h = harness();
    const direct = new FakeCarrier();
    h.barrier.attachDirect(direct);
    h.barrier.handlePrimaryInbound(switchFrame(1, 'direct'));

    h.barrier.closeDirect();
    expect(direct.closed).toBe(true);
    expect(h.barrier.activeCarrier).toBe('primary');
    expect(h.barrier.hasDirect).toBe(false);

    const next = new FakeCarrier();
    h.barrier.attachDirect(next);
    h.barrier.handlePrimaryInbound(switchFrame(1, 'direct'));
    expect(h.barrier.activeCarrier).toBe('direct');
  });

  test('重复 attachDirect 关掉旧载体', () => {
    const h = harness();
    const first = new FakeCarrier();
    const second = new FakeCarrier();
    h.barrier.attachDirect(first);
    h.barrier.handlePrimaryInbound(switchFrame(1, 'direct'));
    h.barrier.attachDirect(second);
    expect(first.closed).toBe(true);
    expect(h.barrier.activeCarrier).toBe('primary');
  });

  test('四阶段：primary → pending-direct → direct → pending-primary', () => {
    const h = harness();
    expect(h.barrier.currentPhase).toBe('primary');

    const direct = new FakeCarrier();
    h.barrier.attachDirect(direct);
    expect(h.barrier.currentPhase).toBe('pending-direct');

    h.barrier.handlePrimaryInbound(switchFrame(1, 'direct'));
    expect(h.barrier.currentPhase).toBe('direct');

    h.barrier.handlePrimaryInbound(switchFrame(2, 'primary'));
    // 载体还在，但已经切回 primary：迟到的直连帧要丢，不能再缓冲也不能投递
    expect(h.barrier.currentPhase).toBe('pending-primary');
    expect(h.barrier.activeCarrier).toBe('primary');
  });

  test('切回 primary 后迟到的直连帧被丢弃（不投递、不缓冲、不重复排空）', () => {
    const h = harness();
    const direct = new FakeCarrier();
    h.barrier.attachDirect(direct);
    h.barrier.handlePrimaryInbound(switchFrame(1, 'direct'));
    h.barrier.handlePrimaryInbound(switchFrame(2, 'primary'));
    const before = [...h.delivered];

    direct.deliver(dataFrame('late-1'));
    direct.deliver(dataFrame('late-2'));
    expect(h.delivered).toEqual(before);
    expect(h.barrier.bufferedCount).toBe(0);

    // 之后即使载体关闭也不会把它们排空出来
    direct.simulateClose();
    expect(h.delivered).toEqual(before);
  });

  test('通道关闭时**不**排空缓冲：缓冲帧排在 primary 旧帧之后会乱序，改由 resume 补齐', () => {
    const h = harness();
    const direct = new FakeCarrier();
    h.barrier.attachDirect(direct);

    direct.deliver(dataFrame('d1'));
    expect(h.barrier.bufferedCount).toBe(1);

    direct.simulateClose();
    expect(h.delivered).toEqual([]);
    expect(h.barrier.bufferedCount).toBe(0);
    // 缓冲里的帧丢了 = node→浏览器方向有缺口，必须触发一次 resume
    expect(h.resumes).toBe(1);

    // 关闭后 primary 上排在切换帧之前的旧帧照常按序投递
    h.barrier.handlePrimaryInbound(dataFrame('p1'));
    expect(h.delivered).toEqual(['p1']);
  });

  test('to:primary 到达时丢弃缓冲并 resume（不排空）', () => {
    const h = harness();
    const direct = new FakeCarrier();
    h.barrier.attachDirect(direct);
    direct.deliver(dataFrame('d1'));

    h.barrier.handlePrimaryInbound(switchFrame(1, 'primary'));
    expect(h.delivered).toEqual([]);
    expect(h.barrier.bufferedCount).toBe(0);
    expect(h.resumes).toBe(1);
  });

  test('缓冲字节超限：放弃这次直连、保住 primary 并 resume', () => {
    const h = harness({ maxBufferedBytes: 200 });
    const direct = new FakeCarrier();
    h.barrier.attachDirect(direct);

    direct.deliver(dataFrame('a'.repeat(60)));
    expect(h.barrier.bufferedCount).toBe(1);
    direct.deliver(dataFrame('b'.repeat(200)));

    expect(direct.closed).toBe(true);
    expect(h.barrier.hasDirect).toBe(false);
    expect(h.barrier.activeCarrier).toBe('primary');
    expect(h.barrier.bufferedCount).toBe(0);
    expect(h.delivered).toEqual([]);
    expect(h.resumes).toBe(1);
  });

  test('缓冲帧数超限同样放弃直连', () => {
    const h = harness({ maxBufferedFrames: 2 });
    const direct = new FakeCarrier();
    h.barrier.attachDirect(direct);
    direct.deliver(dataFrame('d1'));
    direct.deliver(dataFrame('d2'));
    expect(h.barrier.bufferedCount).toBe(2);
    direct.deliver(dataFrame('d3'));
    expect(direct.closed).toBe(true);
    expect(h.barrier.bufferedCount).toBe(0);
  });

  test('出站背压：整帧已排进直连队列，不再往 primary 补发一份', () => {
    const h = harness();
    const direct = new FakeCarrier();
    h.barrier.attachDirect(direct);
    h.barrier.handlePrimaryInbound(switchFrame(1, 'direct'));
    const acks = h.primary.length;

    direct.sendResult = 'backpressure';
    expect(h.barrier.send(dataFrame('out'))).toBe('backpressure');
    expect(direct.sent.length).toBe(1);
    expect(h.primary.length).toBe(acks); // primary 上没有重复的一份
    expect(h.barrier.activeCarrier).toBe('direct');
  });

  test('CARRIER_SWITCH_ACK 是浏览器出站帧，入站收到一律丢弃不上抛', () => {
    const h = harness();
    const ack = wsBorsh.encodeEnvelope(
      wsBorsh.KIND_CARRIER_SWITCH_ACK,
      wsBorsh.encodePayload(wsBorsh.schema.CarrierSwitchAckSchema, {
        epoch: 1,
        rtcSession: 'br:a',
      }),
      0
    );
    h.barrier.handlePrimaryInbound(ack);
    expect(h.delivered).toEqual([]);
  });
});

describe('CarrierSwitchBarrier —— 切换帧绑定 attempt（rtcSession）', () => {
  test('匹配当前 attempt 才切换，ACK 回显 rtcSession', () => {
    const h = harness();
    const direct = new FakeCarrier();
    h.barrier.attachDirect(direct, { rtcSession: 'br:a' });

    h.barrier.handlePrimaryInbound(switchFrame(1, 'direct', 'br:a'));
    expect(h.barrier.activeCarrier).toBe('direct');
    expect(acks(h.primary)).toEqual([{ epoch: 1, rtcSession: 'br:a' }]);
  });

  test('attempt A 的迟到切换帧在 B 挂上之后被忽略（不切换、不回 ACK）', () => {
    const h = harness();
    const a = new FakeCarrier();
    h.barrier.attachDirect(a, { rtcSession: 'br:a' });

    // A 的通道先没了，控制器换 attempt B 重来
    a.simulateClose();
    const b = new FakeCarrier();
    h.barrier.attachDirect(b, { rtcSession: 'br:b' });

    // primary 拥塞：A 的 to:'direct' 现在才到
    h.barrier.handlePrimaryInbound(switchFrame(1, 'direct', 'br:a'));
    expect(h.barrier.activeCarrier).toBe('primary');
    expect(h.barrier.currentPhase).toBe('pending-direct');
    expect(acks(h.primary)).toEqual([]);

    // B 自己的切换帧照常生效
    h.barrier.handlePrimaryInbound(switchFrame(2, 'direct', 'br:b'));
    expect(h.barrier.activeCarrier).toBe('direct');
    expect(acks(h.primary)).toEqual([{ epoch: 2, rtcSession: 'br:b' }]);
  });

  test('直连缓冲的帧不会被上一次 attempt 的迟到帧排空', () => {
    const h = harness();
    const a = new FakeCarrier();
    h.barrier.attachDirect(a, { rtcSession: 'br:a' });
    a.simulateClose();

    const b = new FakeCarrier();
    h.barrier.attachDirect(b, { rtcSession: 'br:b' });
    b.deliver(dataFrame('d1'));
    expect(h.barrier.bufferedCount).toBe(1);

    h.barrier.handlePrimaryInbound(switchFrame(1, 'direct', 'br:a'));
    expect(h.delivered).toEqual([]);
    expect(h.barrier.bufferedCount).toBe(1);

    h.barrier.handlePrimaryInbound(switchFrame(2, 'direct', 'br:b'));
    expect(h.delivered).toEqual(['d1']);
  });

  test('别的 attempt 的 to:primary 也不生效', () => {
    const h = harness();
    const direct = new FakeCarrier();
    h.barrier.attachDirect(direct, { rtcSession: 'br:a' });
    h.barrier.handlePrimaryInbound(switchFrame(1, 'direct', 'br:a'));

    h.barrier.handlePrimaryInbound(switchFrame(2, 'primary', 'br:other'));
    expect(h.barrier.activeCarrier).toBe('direct');
    expect(h.resumes).toBe(0);

    h.barrier.handlePrimaryInbound(switchFrame(2, 'primary', 'br:a'));
    expect(h.barrier.activeCarrier).toBe('primary');
    expect(h.resumes).toBe(1);
  });

  test('老 node 不带 rtcSession：只有一次 attempt 时接受，重挂之后拒绝', () => {
    const h = harness();
    const first = new FakeCarrier();
    h.barrier.attachDirect(first, { rtcSession: 'br:a' });
    h.barrier.handlePrimaryInbound(switchFrame(1, 'direct'));
    expect(h.barrier.activeCarrier).toBe('direct');
    expect(acks(h.primary)).toEqual([{ epoch: 1, rtcSession: '' }]);

    first.simulateClose();
    const second = new FakeCarrier();
    h.barrier.attachDirect(second, { rtcSession: 'br:b' });
    h.barrier.handlePrimaryInbound(switchFrame(2, 'direct'));
    expect(h.barrier.activeCarrier).toBe('primary');
  });

  test('宿主没登记 rtcSession 时不做绑定校验（兼容老宿主）', () => {
    const h = harness();
    const direct = new FakeCarrier();
    h.barrier.attachDirect(direct);
    h.barrier.handlePrimaryInbound(switchFrame(1, 'direct', 'br:whatever'));
    expect(h.barrier.activeCarrier).toBe('direct');
  });
});
