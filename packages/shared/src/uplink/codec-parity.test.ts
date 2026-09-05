import { describe, expect, test } from 'bun:test';
import { encodeBase64url } from '../auth/encoding';
import {
  KEY_LOG_PAGE_MAX_BYTES,
  UPLINK_CTL_MAX_BYTES,
  UPLINK_CTL_TYPES,
  UplinkCtlError,
  type UplinkCtlType,
  decodeHubUplinkCtl,
  decodeMeshUplinkCtl,
  encodeHubUplinkCtl,
  encodeMeshUplinkCtl,
} from './codec';

const td = new TextDecoder();
const te = new TextEncoder();

const NODE_A = 'aa'.repeat(16);
const NODE_B = 'bb'.repeat(16);
const HUB_A = 'cc'.repeat(16);
const HUB_B = 'dd'.repeat(16);
const B32 = encodeBase64url(new Uint8Array(32).fill(7));
const B64 = encodeBase64url(new Uint8Array(64).fill(9));
const PAYLOAD = encodeBase64url(te.encode('key-log-record'));

const SAMPLE_HUB = {
  nodeId: HUB_B,
  publicUrl: 'https://hub-b.example',
  name: 'hub-b',
  mode: 'standby',
  priority: 2,
  writerEpoch: 3,
};

/** 每种 ctl 类型一份线上样本，字段给满：两条线对缺省值的填法不同，只有显式给值才可比。 */
const SAMPLES: Record<UplinkCtlType, Record<string, unknown>> = {
  'auth.challenge': { t: 'auth.challenge', nonce: B32 },
  'auth.response': { t: 'auth.response', node_id: NODE_A, sig: B64 },
  'auth.ok': { t: 'auth.ok' },
  ping: { t: 'ping' },
  pong: { t: 'pong' },
  'node.status': {
    t: 'node.status',
    version: '1.1.31',
    tmux: true,
    direct_capable: true,
    inventory: { sessions: 2 },
    endpoints: [{ kind: 'lan', url: 'https://1.2.3.4' }],
    hub: {
      publicUrl: 'https://hub-a.example',
      mode: 'active',
      priority: 0,
      writerEpoch: 4,
      caFingerprint: 'fp',
    },
  },
  'node.list': {
    t: 'node.list',
    version: 12,
    key_log_head: { seq: 41, hash: B32 },
    rtc: {
      stun: ['stun:stun.example:3478'],
      turn: { url: 'turn:turn.example:3478', username: 'u', credential: 'c' },
    },
    nodes: [
      {
        id: NODE_A,
        name: 'alpha',
        online: true,
        endpoints: [],
        inventory: {},
        direct_capable: true,
        version: '1.1.31',
        attachedHubId: HUB_A,
      },
    ],
    hub: { nodeId: HUB_A, publicUrl: 'https://hub-a.example', name: 'hub-a' },
    hubs: [SAMPLE_HUB],
    writerHubId: HUB_A,
    writerEpoch: 3,
  },
  'key.log.req': { t: 'key.log.req', from_seq: 17, id: 'req-1', limit: 32 },
  'key.log.res': {
    t: 'key.log.res',
    records: [{ seq: 18, bytes: PAYLOAD, sig: B64 }],
    id: 'req-1',
    has_more: true,
    retry_after_ms: 250,
  },
  'key.log.append': { t: 'key.log.append', bytes: PAYLOAD, sig: B64, id: 'app-1', force: true },
  'key.log.ack': { t: 'key.log.ack', id: 'app-1', ok: true, seq: 19 },
  'rtc.signal': {
    t: 'rtc.signal',
    rtcSession: 'sess-1',
    from: 'browser',
    to: NODE_B,
    sdp: 'v=0',
    candidate: 'candidate:1',
  },
  'enroll.redeemed': {
    t: 'enroll.redeemed',
    certificate: PAYLOAD,
    cert_sig: B64,
    enroll_pk: B32,
    node_id: NODE_A,
    entry_sid: 'sid-1',
  },
  'hub.tokens': {
    t: 'hub.tokens',
    op: 'upsert',
    revision: { epoch: 2, seq: 7 },
    id: 'corr-1',
    ack: true,
    more: false,
    tokens: [
      {
        id: 'tok-1',
        user_id: 'user-1',
        enroll_public_key: B32,
        authorization_json: '{"v":1}',
        authorization_sig: B64,
        expires_at: 1234,
        used_at: null,
        node_id: null,
      },
    ],
  },
  'hub.attachments': {
    t: 'hub.attachments',
    revision: 9,
    entries: [{ nodeId: NODE_A, attached: true, hubId: HUB_A }],
    full: true,
    snapshotId: 'snap-1',
    page: 0,
    final: true,
  },
  'hub.forward': {
    t: 'hub.forward',
    kind: 'rtc.signal',
    originHubId: HUB_A,
    returnHubId: HUB_B,
    visitedHubIds: [HUB_A],
    signal: { rtcSession: 'sess-1', from: 'node', to: NODE_B, sdp: 'v=0', candidate: 'c' },
  },
  'hub.write-forward': {
    t: 'hub.write-forward',
    id: 'wf-1',
    method: 'POST',
    path: '/api/x',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    uid: 'user-1',
    writerHubId: HUB_A,
    writerEpoch: 3,
  },
};

const asJson = (bytes: Uint8Array): unknown => JSON.parse(td.decode(bytes));
const wire = (sample: Record<string, unknown>): Uint8Array => te.encode(JSON.stringify(sample));

function reencode(sample: Record<string, unknown>, legacy: boolean): [unknown, unknown] {
  const bytes = wire(sample);
  const opts = legacy ? { legacy: true } : undefined;
  const hub = encodeHubUplinkCtl(decodeHubUplinkCtl(bytes, { allowKeyLogRes: true }), opts);
  const mesh = encodeMeshUplinkCtl(decodeMeshUplinkCtl(bytes), opts);
  return [asJson(hub), asJson(mesh)];
}

describe('hub / mesh ctl 编解码等价性', () => {
  test('样本覆盖全部 ctl 类型', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...UPLINK_CTL_TYPES].sort());
  });

  for (const t of UPLINK_CTL_TYPES) {
    test(`${t}：两条线解码后重新编码得到同一份线上表示`, () => {
      const [hub, mesh] = reencode(SAMPLES[t], false);
      expect(mesh).toEqual(hub);
    });

    test(`${t}：legacy 剥字段后两条线仍一致`, () => {
      const [hub, mesh] = reencode(SAMPLES[t], true);
      expect(mesh).toEqual(hub);
    });
  }

  test('key.log.ack 的 ok=false 分支', () => {
    const [hub, mesh] = reencode(
      { t: 'key.log.ack', id: 'app-1', ok: false, error: 'stale' },
      false
    );
    expect(mesh).toEqual(hub);
  });

  test('hub 线保留 already_admitted，mesh 线按设计丢弃', () => {
    const bytes = wire({ ...SAMPLES['enroll.redeemed'], already_admitted: true });
    expect(asJson(encodeHubUplinkCtl(decodeHubUplinkCtl(bytes)))).toMatchObject({
      already_admitted: true,
    });
    expect(asJson(encodeMeshUplinkCtl(decodeMeshUplinkCtl(bytes)))).not.toHaveProperty(
      'already_admitted'
    );
  });

  test('hub 线默认拒收 key.log.res，mesh 线始终放行', () => {
    const bytes = wire(SAMPLES['key.log.res']);
    expect(() => decodeHubUplinkCtl(bytes)).toThrow(/unexpected key\.log\.res/);
    expect(decodeMeshUplinkCtl(bytes).t).toBe('key.log.res');
  });

  test('两条线的 seq / 字节表示互为等价', () => {
    const bytes = wire(SAMPLES['key.log.res']);
    const hub = decodeHubUplinkCtl(bytes, { allowKeyLogRes: true });
    const mesh = decodeMeshUplinkCtl(bytes);
    if (hub.t !== 'key.log.res' || mesh.t !== 'key.log.res')
      throw new Error('expected key.log.res');
    expect(hub.records[0]?.seq).toBe(18);
    expect(mesh.records[0]?.seq).toBe(18n);
    expect(encodeBase64url(mesh.records[0]?.bytes as Uint8Array)).toBe(
      hub.records[0]?.bytes as string
    );
  });
});

/** 补白到指定字节长度，用来打信封的尺寸门槛。 */
function padTo(obj: Record<string, unknown>, target: number): Uint8Array {
  const base = JSON.stringify(obj).length + ',"_pad":""'.length;
  return te.encode(JSON.stringify({ ...obj, _pad: 'x'.repeat(Math.max(target - base, 0)) }));
}

const throwsWith = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('expected a throw');
};

/**
 * 信封层报错文案必须与合并前逐字一致：`apps/gateway/src/mesh/uplink-reconnect.ts`
 * 的 mapUplinkCtlError 按字面量把它们分到 ctl_too_large / ctl_too_long / unknown_type 等指标标签，
 * 文案漂移会静默改变重连行为。
 */
describe('ctl 信封报错文案（对齐合并前实现）', () => {
  const RES_ID = 'req-1';

  test('mesh：尺寸门槛一律 "ctl too large"', () => {
    expect(throwsWith(() => decodeMeshUplinkCtl(new Uint8Array(KEY_LOG_PAGE_MAX_BYTES + 1)))).toBe(
      'ctl too large'
    );
    expect(
      throwsWith(() => decodeMeshUplinkCtl(padTo({ t: 'ping' }, UPLINK_CTL_MAX_BYTES + 1)))
    ).toBe('ctl too large');
    // 超尺寸但不是 key.log.res：即便带着 pending id 也必须是 too large，不能落到 assertCtlBounds
    expect(
      throwsWith(() =>
        decodeMeshUplinkCtl(padTo({ t: 'ping' }, KEY_LOG_PAGE_MAX_BYTES), {
          pendingKeyLogId: RES_ID,
        })
      )
    ).toBe('ctl too large');
    const huge = padTo({ t: 'key.log.res', records: [], id: RES_ID }, KEY_LOG_PAGE_MAX_BYTES);
    expect(throwsWith(() => decodeMeshUplinkCtl(huge))).toBe('ctl too large');
    expect(throwsWith(() => decodeMeshUplinkCtl(huge, { pendingKeyLogId: 'other' }))).toBe(
      'ctl too large'
    );
    expect(decodeMeshUplinkCtl(huge, { pendingKeyLogId: RES_ID }).t).toBe('key.log.res');
  });

  test('mesh：非对象 / 非法 t / 未知 t / 越界文案', () => {
    const enc = (raw: string) => te.encode(raw);
    const NOT_OBJECT = 'uplink ctl must be a JSON object with t';
    expect(throwsWith(() => decodeMeshUplinkCtl(enc('"hello"')))).toBe(NOT_OBJECT);
    expect(throwsWith(() => decodeMeshUplinkCtl(enc('[1,2]')))).toBe(NOT_OBJECT);
    expect(throwsWith(() => decodeMeshUplinkCtl(enc('{}')))).toBe(NOT_OBJECT);
    expect(throwsWith(() => decodeMeshUplinkCtl(enc('{"t":42}')))).toBe(NOT_OBJECT);
    expect(throwsWith(() => decodeMeshUplinkCtl(enc('{"t":"nope"}')))).toBe(
      'unknown uplink ctl t: nope'
    );
    expect(throwsWith(() => decodeMeshUplinkCtl(wire({ t: 'ping', pad: 'x'.repeat(5000) })))).toBe(
      'ctl string too long'
    );
    expect(
      throwsWith(() =>
        decodeMeshUplinkCtl(wire({ t: 'ping', pad: Array.from({ length: 2000 }, (_, i) => i) }))
      )
    ).toBe('ctl array too long');
    expect(
      throwsWith(() =>
        decodeMeshUplinkCtl(wire({ t: 'ping', pad: JSON.parse('[[[[[[[[[["x"]]]]]]]]]]') }))
      )
    ).toBe('ctl too deep');
  });

  test('mesh：字段层文案保持 "ctl field …" 前缀（映射到 invalid_field）', () => {
    expect(
      throwsWith(() =>
        decodeMeshUplinkCtl(wire({ t: 'rtc.signal', rtcSession: 's', from: 0, to: 'n' }))
      )
    ).toBe('ctl field from must be a string');
    expect(
      throwsWith(() =>
        decodeMeshUplinkCtl(wire({ t: 'rtc.signal', rtcSession: 's', from: 'peer', to: 'n' }))
      )
    ).toBe('rtc.signal from must be browser|node');
    expect(throwsWith(() => decodeMeshUplinkCtl(wire({ t: 'key.log.res' })))).toBe(
      'key.log.res records must be an array'
    );
    expect(throwsWith(() => decodeMeshUplinkCtl(wire({ t: 'key.log.res', records: [null] })))).toBe(
      'key.log.res records[0] must be an object'
    );
  });

  test('hub：信封与字段文案保持 UplinkCtlError 原样', () => {
    const enc = (raw: string) => te.encode(raw);
    expect(throwsWith(() => decodeHubUplinkCtl(new Uint8Array(UPLINK_CTL_MAX_BYTES + 1)))).toBe(
      'ctl too large'
    );
    expect(throwsWith(() => decodeHubUplinkCtl(enc('not json')))).toBe('invalid json');
    expect(throwsWith(() => decodeHubUplinkCtl(enc('"hello"')))).toBe('invalid ctl');
    expect(throwsWith(() => decodeHubUplinkCtl(enc('{"t":42}')))).toBe('unknown t: 42');
    expect(throwsWith(() => decodeHubUplinkCtl(enc('{"t":"nope"}')))).toBe('unknown t: nope');
    expect(throwsWith(() => decodeHubUplinkCtl(wire({ t: 'key.log.res', records: [] })))).toBe(
      'unexpected key.log.res'
    );
    expect(
      throwsWith(() => decodeHubUplinkCtl(wire({ t: 'key.log.res' }), { allowKeyLogRes: true }))
    ).toBe('invalid records');
    expect(
      throwsWith(() =>
        decodeHubUplinkCtl(wire({ t: 'key.log.res', records: [null] }), { allowKeyLogRes: true })
      )
    ).toBe('invalid record');
    expect(
      throwsWith(() =>
        decodeHubUplinkCtl(wire({ t: 'rtc.signal', rtcSession: 's', from: 'peer', to: 'n' }))
      )
    ).toBe('invalid rtc.from');
    expect(
      throwsWith(() =>
        decodeHubUplinkCtl(
          wire({ t: 'rtc.signal', rtcSession: 's', from: 'node', to: 'n', sdp: 0 })
        )
      )
    ).toBe('invalid rtc.sdp');
    expect(() => decodeHubUplinkCtl(te.encode('{"t":42}'))).toThrow(UplinkCtlError);
  });
});
