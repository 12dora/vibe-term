import { describe, expect, test } from 'bun:test';
import { encodeBase64url, randomBytes } from '../auth/encoding';
import {
  HUB_NOT_WRITER,
  type HubAdvertisement,
  type HubAttachmentsMessage,
  type HubEndpointInfo,
  type HubForwardMessage,
  type HubNotWriterError,
  type HubTokensMessage,
  type HubWriteForwardMessage,
  KEY_LOG_PAGE_MAX_BYTES,
  MIN_HUB_TOKENS_VERSION,
  type MeshUplinkNodeList,
  type NodeListMessage,
  type NodeStatusMessage,
  UPLINK_CTL_MAX_ATTACHMENT_ENTRIES,
  UPLINK_CTL_MAX_BYTES,
  UplinkCtlError,
  assertCtlBounds,
  b64urlToBytes,
  bytesToB64url,
  compareTokenRevision,
  decodeHubUplinkCtl,
  decodeMeshUplinkCtl,
  encodeHubUplinkCtl,
  encodeMeshUplinkCtl,
  seqFromWire,
  seqToWire,
} from './codec';

describe('uplink codec primitives', () => {
  test('seqToWire / seqFromWire 与 u64 边界', () => {
    expect(seqToWire(3n)).toBe(3);
    expect(seqFromWire(3)).toBe(3n);
    expect(seqFromWire('9')).toBe(9n);
    expect(() => seqFromWire(-1)).toThrow(UplinkCtlError);
    expect(() => seqFromWire(1.5)).toThrow(UplinkCtlError);
    expect(seqFromWire('18446744073709551615')).toBe(18446744073709551615n);
    expect(() => seqFromWire('18446744073709551616')).toThrow(UplinkCtlError);
  });

  test('b64url 往返与长度校验', () => {
    const bytes = randomBytes(32);
    expect(b64urlToBytes(bytesToB64url(bytes), 32)).toEqual(bytes);
    expect(() => b64urlToBytes('', 32)).toThrow(UplinkCtlError);
    expect(() => b64urlToBytes(encodeBase64url(randomBytes(16)), 32)).toThrow(/32 bytes/);
  });

  test('assertCtlBounds 拒绝过深 / 过长', () => {
    expect(() => assertCtlBounds('x'.repeat(4097))).toThrow(/string too long/);
    let deep: unknown = 1;
    for (let i = 0; i < 10; i++) deep = { k: deep };
    expect(() => assertCtlBounds(deep)).toThrow(/too deep/);
  });
});

describe('mesh vs hub large-page policy', () => {
  test('mesh 仅在 pending id 匹配时接受 1MiB key.log.res；hub 默认拒绝 key.log.res', () => {
    const id = 'pending-1';
    const empty = JSON.stringify({ t: 'key.log.res', records: [], id, pad: '' });
    const prefix = empty.slice(0, -2);
    const pad = 'x'.repeat(KEY_LOG_PAGE_MAX_BYTES - prefix.length - 2);
    const huge = new TextEncoder().encode(`${prefix}${pad}"}`);
    expect(huge.byteLength).toBe(KEY_LOG_PAGE_MAX_BYTES);
    expect(() => decodeMeshUplinkCtl(huge)).toThrow(/too large/);
    expect(decodeMeshUplinkCtl(huge, { pendingKeyLogId: id }).t).toBe('key.log.res');
    expect(() => decodeHubUplinkCtl(huge)).toThrow(UplinkCtlError);
    const small = JSON.stringify({ t: 'key.log.res', records: [] });
    expect(() => decodeHubUplinkCtl(small)).toThrow(UplinkCtlError);
    expect(decodeHubUplinkCtl(small, { allowKeyLogRes: true }).t).toBe('key.log.res');
  });

  test('两侧解码器都接受大写 node id 并归一化为小写', () => {
    const lower = 'ab'.repeat(16);
    const upper = lower.toUpperCase();
    const cert = randomBytes(16);
    const certSig = randomBytes(64);
    const enrollPk = randomBytes(32);
    const frame = new TextEncoder().encode(
      JSON.stringify({
        t: 'enroll.redeemed',
        certificate: encodeBase64url(cert),
        cert_sig: encodeBase64url(certSig),
        enroll_pk: encodeBase64url(enrollPk),
        node_id: upper,
      })
    );
    expect(decodeMeshUplinkCtl(frame)).toMatchObject({ t: 'enroll.redeemed', nodeId: lower });
    expect(decodeHubUplinkCtl(frame)).toMatchObject({ t: 'enroll.redeemed', node_id: lower });
    const authResponse = new TextEncoder().encode(
      JSON.stringify({ t: 'auth.response', node_id: upper, sig: encodeBase64url(certSig) })
    );
    expect(decodeHubUplinkCtl(authResponse)).toMatchObject({
      t: 'auth.response',
      node_id: lower,
    });
  });

  test('ping round-trip 两侧一致', () => {
    expect(decodeMeshUplinkCtl(encodeMeshUplinkCtl({ t: 'ping' }))).toEqual({ t: 'ping' });
    expect(decodeHubUplinkCtl(encodeHubUplinkCtl({ t: 'ping' }))).toEqual({ t: 'ping' });
    expect(() => decodeHubUplinkCtl(new Uint8Array(UPLINK_CTL_MAX_BYTES + 1))).toThrow(
      UplinkCtlError
    );
  });
});

const HUB_A = 'aa'.repeat(16);
const HUB_B = 'bb'.repeat(16);
const HASH32 = new Uint8Array(32).fill(7);
const HASH_B64 = bytesToB64url(HASH32);

function meshList(over: Partial<MeshUplinkNodeList> = {}): MeshUplinkNodeList {
  return {
    t: 'node.list',
    version: 1,
    key_log_head: { seq: 1n, hash: HASH32 },
    rtc: { stun: [], turn: null },
    nodes: [],
    ...over,
  };
}

function hubList(over: Partial<NodeListMessage> = {}): NodeListMessage {
  return {
    t: 'node.list',
    version: 1,
    key_log_head: { seq: 1, hash: HASH_B64 },
    rtc: { stun: [], turn: null },
    nodes: [],
    ...over,
  };
}

function statusMsg(over: Partial<NodeStatusMessage> = {}): NodeStatusMessage {
  return {
    t: 'node.status',
    version: '1.1.11',
    tmux: true,
    direct_capable: false,
    inventory: {},
    endpoints: [],
    ...over,
  };
}

const SAMPLE_HUB: HubEndpointInfo = {
  nodeId: HUB_A,
  publicUrl: 'https://hub.example',
  name: 'primary',
  mode: 'active',
  priority: 100,
  writerEpoch: 3,
  caFingerprint: 'ab'.repeat(32),
  online: true,
  lastSeenAt: 1_700_000_000_000,
};

const SAMPLE_STANDBY: HubEndpointInfo = {
  nodeId: HUB_B,
  publicUrl: 'https://standby.example',
  mode: 'standby',
  priority: 200,
  writerEpoch: 1,
};

const SAMPLE_AD: HubAdvertisement = {
  publicUrl: 'https://hub.example',
  mode: 'active',
  priority: 100,
  writerEpoch: 3,
  caFingerprint: 'ab'.repeat(32),
};

describe('multi-hub wire contract', () => {
  test('node.list 新字段往返（mesh + hub）', () => {
    const mesh = meshList({
      hub: { nodeId: HUB_A, publicUrl: 'https://hub.example', name: 'primary' },
      hubs: [SAMPLE_HUB, SAMPLE_STANDBY],
      writerHubId: HUB_A,
      writerEpoch: 3,
    });
    const meshDecoded = decodeMeshUplinkCtl(encodeMeshUplinkCtl(mesh));
    expect(meshDecoded).toMatchObject({
      t: 'node.list',
      hub: { nodeId: HUB_A, publicUrl: 'https://hub.example', name: 'primary' },
      hubs: [SAMPLE_HUB, SAMPLE_STANDBY],
      writerHubId: HUB_A,
      writerEpoch: 3,
    });

    const hub = hubList({
      hub: { nodeId: HUB_A, publicUrl: 'https://hub.example', name: 'primary' },
      hubs: [SAMPLE_HUB, SAMPLE_STANDBY],
      writerHubId: HUB_A,
      writerEpoch: 3,
    });
    const hubDecoded = decodeHubUplinkCtl(encodeHubUplinkCtl(hub));
    expect(hubDecoded).toMatchObject({
      t: 'node.list',
      hubs: [SAMPLE_HUB, SAMPLE_STANDBY],
      writerHubId: HUB_A,
      writerEpoch: 3,
    });
  });

  test('node.status hub 广告往返', () => {
    const msg = statusMsg({ hub: SAMPLE_AD });
    expect(decodeMeshUplinkCtl(encodeMeshUplinkCtl(msg))).toMatchObject({
      t: 'node.status',
      hub: SAMPLE_AD,
    });
    expect(decodeHubUplinkCtl(encodeHubUplinkCtl(msg))).toMatchObject({
      t: 'node.status',
      hub: SAMPLE_AD,
    });
  });

  test('缺省新字段解码为 undefined，未知键被忽略', () => {
    const listBytes = encodeMeshUplinkCtl(
      meshList({ hub: { nodeId: HUB_A, publicUrl: 'https://h' } })
    );
    const list = decodeMeshUplinkCtl(listBytes) as MeshUplinkNodeList;
    expect(list.hubs).toBeUndefined();
    expect(list.writerHubId).toBeUndefined();
    expect(list.writerEpoch).toBeUndefined();

    const extra = {
      t: 'node.list',
      version: 1,
      key_log_head: { seq: 1, hash: HASH_B64 },
      rtc: { stun: [], turn: null },
      nodes: [],
      hub: { nodeId: HUB_A, publicUrl: 'https://h', extra: true },
      hubs: [
        {
          ...SAMPLE_HUB,
          unknown: 'skip-me',
        },
      ],
      writerHubId: HUB_A,
      writerEpoch: 2,
      futureField: { nested: 1 },
    };
    const decoded = decodeMeshUplinkCtl(
      new TextEncoder().encode(JSON.stringify(extra))
    ) as MeshUplinkNodeList;
    expect(decoded.hubs).toHaveLength(1);
    expect(decoded.hubs?.[0]).toMatchObject({
      nodeId: HUB_A,
      publicUrl: 'https://hub.example',
      mode: 'active',
    });
    expect((decoded.hubs?.[0] as { unknown?: string }).unknown).toBeUndefined();
    expect((decoded as { futureField?: unknown }).futureField).toBeUndefined();

    const status = decodeMeshUplinkCtl(
      new TextEncoder().encode(
        JSON.stringify({
          t: 'node.status',
          version: '1',
          tmux: false,
          direct_capable: false,
          extraStatus: 1,
        })
      )
    );
    expect(status).toEqual({
      t: 'node.status',
      version: '1',
      tmux: false,
      direct_capable: false,
      inventory: {},
      endpoints: [],
    });
  });

  test('legacy:true 剥掉新字段，旧形状可解码，新形状仍往返', () => {
    const mesh = meshList({
      hub: { nodeId: HUB_A, publicUrl: 'https://hub.example' },
      hubs: [SAMPLE_HUB],
      writerHubId: HUB_A,
      writerEpoch: 3,
    });
    const legacyBytes = encodeMeshUplinkCtl(mesh, { legacy: true });
    const legacyJson = JSON.parse(new TextDecoder().decode(legacyBytes)) as Record<string, unknown>;
    expect(legacyJson.hubs).toBeUndefined();
    expect(legacyJson.writerHubId).toBeUndefined();
    expect(legacyJson.writerEpoch).toBeUndefined();
    expect(legacyJson.hub).toEqual({ nodeId: HUB_A, publicUrl: 'https://hub.example' });
    const legacyDecoded = decodeMeshUplinkCtl(legacyBytes) as MeshUplinkNodeList;
    expect(legacyDecoded.hubs).toBeUndefined();
    expect(legacyDecoded.hub?.nodeId).toBe(HUB_A);

    const hubLegacy = encodeHubUplinkCtl(
      hubList({
        hub: { nodeId: HUB_A, publicUrl: 'https://hub.example' },
        hubs: [SAMPLE_HUB],
        writerHubId: HUB_A,
        writerEpoch: 3,
      }),
      { legacy: true }
    );
    const hubLegacyJson = JSON.parse(new TextDecoder().decode(hubLegacy)) as Record<
      string,
      unknown
    >;
    expect(hubLegacyJson.hubs).toBeUndefined();
    expect(decodeHubUplinkCtl(hubLegacy).t).toBe('node.list');

    const statusLegacy = encodeMeshUplinkCtl(statusMsg({ hub: SAMPLE_AD }), { legacy: true });
    const statusJson = JSON.parse(new TextDecoder().decode(statusLegacy)) as Record<
      string,
      unknown
    >;
    expect(statusJson.hub).toBeUndefined();
    expect(decodeMeshUplinkCtl(statusLegacy)).toMatchObject({
      t: 'node.status',
      version: '1.1.11',
    });

    const roundTrip = decodeMeshUplinkCtl(encodeMeshUplinkCtl(mesh)) as MeshUplinkNodeList;
    expect(roundTrip.hubs).toEqual([SAMPLE_HUB]);
    expect(roundTrip.writerHubId).toBe(HUB_A);
    expect(roundTrip.writerEpoch).toBe(3);
  });

  test('拒绝非法 mode / 非负整数 / publicUrl / hubs 数量', () => {
    const base = {
      t: 'node.list',
      version: 1,
      key_log_head: { seq: 1, hash: HASH_B64 },
      rtc: { stun: [], turn: null },
      nodes: [],
    };
    const encodeJson = (hubs: unknown) =>
      new TextEncoder().encode(JSON.stringify({ ...base, hubs }));

    expect(() => decodeMeshUplinkCtl(encodeJson([{ ...SAMPLE_HUB, mode: 'primary' }]))).toThrow(
      /mode/
    );
    expect(() => decodeMeshUplinkCtl(encodeJson([{ ...SAMPLE_HUB, priority: -1 }]))).toThrow(
      /priority/
    );
    expect(() => decodeMeshUplinkCtl(encodeJson([{ ...SAMPLE_HUB, writerEpoch: 1.5 }]))).toThrow(
      /writerEpoch/
    );
    expect(() =>
      decodeMeshUplinkCtl(encodeJson([{ ...SAMPLE_HUB, publicUrl: 'ftp://hub.example' }]))
    ).toThrow(/publicUrl/);
    expect(() =>
      decodeMeshUplinkCtl(encodeJson([{ ...SAMPLE_HUB, publicUrl: `https://${'a'.repeat(510)}` }]))
    ).toThrow(/publicUrl/);
    expect(() =>
      decodeMeshUplinkCtl(encodeJson(Array.from({ length: 17 }, () => SAMPLE_HUB)))
    ).toThrow(/hubs/);

    expect(() =>
      decodeMeshUplinkCtl(
        new TextEncoder().encode(
          JSON.stringify({
            t: 'node.status',
            version: '1',
            tmux: false,
            direct_capable: false,
            hub: { ...SAMPLE_AD, mode: 'writer' },
          })
        )
      )
    ).toThrow(/mode/);
  });

  test('HUB_NOT_WRITER 常量与错误体形状', () => {
    expect(HUB_NOT_WRITER).toBe('HUB_NOT_WRITER');
    const body: HubNotWriterError = {
      code: HUB_NOT_WRITER,
      writerHubId: HUB_A,
      writerPublicUrl: 'https://hub.example',
      writerEpoch: 3,
    };
    expect(body.code).toBe('HUB_NOT_WRITER');
    const empty: HubNotWriterError = {
      code: 'HUB_NOT_WRITER',
      writerHubId: null,
      writerPublicUrl: null,
      writerEpoch: null,
    };
    expect(empty.writerEpoch).toBeNull();
  });
});

describe('hub.tokens codec', () => {
  const enrollPk = encodeBase64url(randomBytes(32));
  const authSig = encodeBase64url(randomBytes(64));
  const row = {
    id: 'tok-1',
    user_id: 'user-1',
    enroll_public_key: enrollPk,
    authorization_json: '{"authorization_b64":"x"}',
    authorization_sig: authSig,
    expires_at: 9_000,
    used_at: null as number | null,
    node_id: null as string | null,
  };
  const msg: HubTokensMessage = {
    t: 'hub.tokens',
    op: 'upsert',
    revision: { epoch: 2, seq: 7 },
    id: 'corr-1',
    tokens: [row],
  };

  test('mesh/hub 往返', () => {
    const mesh = decodeMeshUplinkCtl(encodeMeshUplinkCtl(msg));
    expect(mesh).toEqual(msg);
    const hub = decodeHubUplinkCtl(encodeHubUplinkCtl(msg));
    expect(hub).toEqual(msg);
    const tomb: HubTokensMessage = {
      t: 'hub.tokens',
      op: 'tombstone',
      revision: { epoch: 2, seq: 8 },
      id: 'corr-2',
      tokens: [{ ...row, id: 'tok-1' }],
    };
    expect(decodeHubUplinkCtl(encodeHubUplinkCtl(tomb))).toEqual(tomb);
    const ack: HubTokensMessage = {
      t: 'hub.tokens',
      op: 'upsert',
      revision: { epoch: 2, seq: 7 },
      id: 'corr-1',
      ack: true,
    };
    expect(decodeMeshUplinkCtl(encodeMeshUplinkCtl(ack))).toEqual(ack);
  });

  test('legacy:true 剥掉 payload，旧 TYPE_SET 视为 unknown', () => {
    const stripped = JSON.parse(
      new TextDecoder().decode(encodeMeshUplinkCtl(msg, { legacy: true }))
    );
    expect(stripped).toEqual({ t: 'hub.tokens' });
    const hubStripped = JSON.parse(
      new TextDecoder().decode(encodeHubUplinkCtl(msg, { legacy: true }))
    );
    expect(hubStripped).toEqual({ t: 'hub.tokens' });
    const oldTypes = new Set([
      'auth.challenge',
      'auth.response',
      'auth.ok',
      'ping',
      'pong',
      'node.status',
      'node.list',
      'key.log.req',
      'key.log.res',
      'key.log.append',
      'key.log.ack',
      'rtc.signal',
      'enroll.redeemed',
    ]);
    expect(oldTypes.has('hub.tokens')).toBe(false);
    expect(MIN_HUB_TOKENS_VERSION).toBe('1.1.13');
  });

  test('revision 比较与非法 op', () => {
    expect(compareTokenRevision({ epoch: 2, seq: 1 }, { epoch: 1, seq: 99 })).toBe(1);
    expect(compareTokenRevision({ epoch: 1, seq: 2 }, { epoch: 1, seq: 2 })).toBe(0);
    expect(compareTokenRevision({ epoch: 1, seq: 1 }, { epoch: 1, seq: 2 })).toBe(-1);
    expect(() =>
      decodeMeshUplinkCtl(
        new TextEncoder().encode(
          JSON.stringify({ t: 'hub.tokens', op: 'merge', revision: { epoch: 1, seq: 1 } })
        )
      )
    ).toThrow(/op/);
  });
});

describe('hub.attachments / hub.forward / attachedHubId codec', () => {
  const NODE_C = 'cc'.repeat(16);
  const attachments: HubAttachmentsMessage = {
    t: 'hub.attachments',
    revision: 4,
    full: true,
    entries: [
      { nodeId: NODE_C, attached: true, hubId: HUB_B },
      { nodeId: HUB_A, attached: false },
    ],
  };
  const forward: HubForwardMessage = {
    t: 'hub.forward',
    kind: 'rtc.signal',
    originHubId: HUB_A,
    returnHubId: HUB_A,
    visitedHubIds: [HUB_A],
    signal: {
      rtcSession: 'sess-1',
      from: 'browser',
      to: NODE_C,
      sdp: 'offer',
    },
  };

  test('hub.attachments mesh/hub 往返', () => {
    expect(decodeMeshUplinkCtl(encodeMeshUplinkCtl(attachments))).toEqual(attachments);
    expect(decodeHubUplinkCtl(encodeHubUplinkCtl(attachments))).toEqual(attachments);
    const delta: HubAttachmentsMessage = {
      t: 'hub.attachments',
      revision: 5,
      entries: [{ nodeId: NODE_C, attached: false }],
    };
    expect(decodeHubUplinkCtl(encodeHubUplinkCtl(delta))).toEqual(delta);
  });

  test('hub.attachments 分页字段往返，单帧条目上限收紧', () => {
    const page: HubAttachmentsMessage = {
      t: 'hub.attachments',
      revision: 9,
      full: true,
      snapshotId: 'snap-1',
      page: 0,
      final: false,
      entries: [{ nodeId: NODE_C, attached: true, hubId: HUB_B }],
    };
    expect(decodeMeshUplinkCtl(encodeMeshUplinkCtl(page))).toEqual(page);
    expect(decodeHubUplinkCtl(encodeHubUplinkCtl(page))).toEqual(page);
    expect(UPLINK_CTL_MAX_ATTACHMENT_ENTRIES).toBe(256);
    expect(() =>
      decodeHubUplinkCtl(
        new TextEncoder().encode(
          JSON.stringify({
            t: 'hub.attachments',
            revision: 1,
            entries: Array.from({ length: UPLINK_CTL_MAX_ATTACHMENT_ENTRIES + 1 }, (_, i) => ({
              nodeId: i.toString(16).padStart(32, '0'),
              attached: true,
            })),
          })
        )
      )
    ).toThrow(/too many/);
  });

  test('hub.forward mesh/hub 往返', () => {
    expect(decodeMeshUplinkCtl(encodeMeshUplinkCtl(forward))).toEqual(forward);
    expect(decodeHubUplinkCtl(encodeHubUplinkCtl(forward))).toEqual(forward);
  });

  test('legacy:true 剥掉 payload，旧 TYPE_SET 视为 unknown', () => {
    expect(
      JSON.parse(new TextDecoder().decode(encodeMeshUplinkCtl(attachments, { legacy: true })))
    ).toEqual({
      t: 'hub.attachments',
    });
    expect(
      JSON.parse(new TextDecoder().decode(encodeHubUplinkCtl(forward, { legacy: true })))
    ).toEqual({
      t: 'hub.forward',
    });
    const oldTypes = new Set([
      'auth.challenge',
      'auth.response',
      'auth.ok',
      'ping',
      'pong',
      'node.status',
      'node.list',
      'key.log.req',
      'key.log.res',
      'key.log.append',
      'key.log.ack',
      'rtc.signal',
      'enroll.redeemed',
      'hub.tokens',
    ]);
    expect(oldTypes.has('hub.attachments')).toBe(false);
    expect(oldTypes.has('hub.forward')).toBe(false);
    expect(oldTypes.has('hub.write-forward')).toBe(false);
  });

  describe('hub.write-forward / key.log.append force / hub.tokens more', () => {
    test('hub.write-forward 请求与 ack 往返，legacy 剥离，cookie/authorization 不入帧', () => {
      const req: HubWriteForwardMessage = {
        t: 'hub.write-forward',
        id: 'fwd-1',
        method: 'POST',
        path: '/api/hub/nodes/n1/rename',
        headers: { 'content-type': 'application/json', 'x-tmex-force-keylog': '1' },
        body: JSON.stringify({ name: 'x' }),
        uid: 'user-1',
      };
      expect(decodeMeshUplinkCtl(encodeMeshUplinkCtl(req))).toEqual(req);
      expect(decodeHubUplinkCtl(encodeHubUplinkCtl(req))).toEqual(req);
      const ack: HubWriteForwardMessage = {
        t: 'hub.write-forward',
        id: 'fwd-1',
        ack: true,
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
      };
      expect(decodeMeshUplinkCtl(encodeMeshUplinkCtl(ack))).toEqual(ack);
      expect(
        JSON.parse(new TextDecoder().decode(encodeMeshUplinkCtl(req, { legacy: true })))
      ).toEqual({ t: 'hub.write-forward' });
      const stripped = decodeMeshUplinkCtl(
        new TextEncoder().encode(
          JSON.stringify({
            t: 'hub.write-forward',
            id: 'fwd-2',
            method: 'POST',
            path: '/api/hub/enrollments',
            headers: {
              'content-type': 'application/json',
              cookie: 'tmex_s_self=secret',
              authorization: 'Bearer x',
              'x-tmex-force-keylog': '1',
            },
            body: '{}',
          })
        )
      );
      expect(stripped).toEqual({
        t: 'hub.write-forward',
        id: 'fwd-2',
        method: 'POST',
        path: '/api/hub/enrollments',
        headers: { 'content-type': 'application/json', 'x-tmex-force-keylog': '1' },
        body: '{}',
      });
    });

    test('hub.write-forward 请求携带 writerHubId/writerEpoch，legacy 剥离', () => {
      const req: HubWriteForwardMessage = {
        t: 'hub.write-forward',
        id: 'fwd-w',
        method: 'POST',
        path: '/api/hub/enrollments',
        body: '{}',
        writerHubId: HUB_A,
        writerEpoch: 7,
      };
      expect(decodeMeshUplinkCtl(encodeMeshUplinkCtl(req))).toEqual(req);
      expect(decodeHubUplinkCtl(encodeHubUplinkCtl(req))).toEqual(req);
      expect(
        JSON.parse(new TextDecoder().decode(encodeMeshUplinkCtl(req, { legacy: true })))
      ).toEqual({ t: 'hub.write-forward' });
    });

    test('hub.write-forward 分片 ACK 往返', () => {
      const part: HubWriteForwardMessage = {
        t: 'hub.write-forward',
        id: 'fwd-c',
        ack: true,
        status: 200,
        headers: { 'content-type': 'application/json' },
        part: 0,
        final: false,
        bytes: '{"ok":true,',
      };
      const last: HubWriteForwardMessage = {
        t: 'hub.write-forward',
        id: 'fwd-c',
        ack: true,
        part: 1,
        final: true,
        bytes: '"n":1}',
      };
      expect(decodeMeshUplinkCtl(encodeMeshUplinkCtl(part))).toEqual(part);
      expect(decodeHubUplinkCtl(encodeHubUplinkCtl(last))).toEqual(last);
    });

    test('key.log.append force 往返，legacy 剥离', () => {
      const bytes = randomBytes(8);
      const sig = randomBytes(64);
      const mesh = decodeMeshUplinkCtl(
        encodeMeshUplinkCtl({ t: 'key.log.append', bytes, sig, id: 'a1', force: true })
      );
      expect(mesh).toMatchObject({ t: 'key.log.append', id: 'a1', force: true });
      const hub = decodeHubUplinkCtl(
        encodeHubUplinkCtl({
          t: 'key.log.append',
          bytes: bytesToB64url(bytes),
          sig: bytesToB64url(sig),
          id: 'a1',
          force: true,
        })
      );
      expect(hub).toMatchObject({ t: 'key.log.append', id: 'a1', force: true });
      const legacyMesh = JSON.parse(
        new TextDecoder().decode(
          encodeMeshUplinkCtl({ t: 'key.log.append', bytes, sig, force: true }, { legacy: true })
        )
      ) as { force?: boolean };
      expect(legacyMesh.force).toBeUndefined();
      const legacyHub = JSON.parse(
        new TextDecoder().decode(
          encodeHubUplinkCtl(
            {
              t: 'key.log.append',
              bytes: bytesToB64url(bytes),
              sig: bytesToB64url(sig),
              force: true,
            },
            { legacy: true }
          )
        )
      ) as { force?: boolean };
      expect(legacyHub.force).toBeUndefined();
      const old = decodeMeshUplinkCtl(
        encodeMeshUplinkCtl({ t: 'key.log.append', bytes, sig, id: 'old' })
      );
      expect(old).toMatchObject({ t: 'key.log.append', id: 'old' });
      expect('force' in old ? (old as { force?: boolean }).force : undefined).toBeUndefined();
    });

    test('hub.tokens more 往返', () => {
      const msg: HubTokensMessage = {
        t: 'hub.tokens',
        op: 'upsert',
        revision: { epoch: 1, seq: 1 },
        id: 'page-1',
        tokens: [],
        more: true,
      };
      expect(decodeMeshUplinkCtl(encodeMeshUplinkCtl(msg))).toEqual(msg);
      expect(decodeHubUplinkCtl(encodeHubUplinkCtl(msg))).toEqual(msg);
    });
  });

  test('node.list attachedHubId 往返，legacy 剥离', () => {
    const mesh = meshList({
      nodes: [
        {
          id: NODE_C,
          name: 'c',
          online: true,
          endpoints: [],
          inventory: {},
          direct_capable: false,
          version: '1.1.13',
          attachedHubId: HUB_B,
        },
      ],
    });
    const round = decodeMeshUplinkCtl(encodeMeshUplinkCtl(mesh)) as MeshUplinkNodeList;
    expect(round.nodes[0]?.attachedHubId).toBe(HUB_B);
    const hubRound = decodeHubUplinkCtl(
      encodeHubUplinkCtl(
        hubList({
          nodes: [
            {
              id: NODE_C,
              name: 'c',
              online: true,
              endpoints: [],
              inventory: {},
              direct_capable: false,
              version: '1.1.13',
              attachedHubId: HUB_B,
            },
          ],
        })
      )
    ) as NodeListMessage;
    expect(hubRound.nodes[0]?.attachedHubId).toBe(HUB_B);

    const legacyJson = JSON.parse(
      new TextDecoder().decode(encodeMeshUplinkCtl(mesh, { legacy: true }))
    ) as { nodes: Array<{ attachedHubId?: string }> };
    expect(legacyJson.nodes[0]?.attachedHubId).toBeUndefined();
    const hubLegacy = JSON.parse(
      new TextDecoder().decode(
        encodeHubUplinkCtl(
          hubList({
            nodes: [
              {
                id: NODE_C,
                name: 'c',
                online: true,
                endpoints: [],
                inventory: {},
                direct_capable: false,
                version: '1.1.13',
                attachedHubId: HUB_B,
              },
            ],
          }),
          { legacy: true }
        )
      )
    ) as { nodes: Array<{ attachedHubId?: string }> };
    expect(hubLegacy.nodes[0]?.attachedHubId).toBeUndefined();
  });

  test('拒绝过多 attachments 与非法 hub.forward kind', () => {
    const tooMany = {
      t: 'hub.attachments',
      revision: 1,
      entries: Array.from({ length: 4097 }, () => ({ nodeId: NODE_C, attached: true })),
    };
    expect(() => decodeMeshUplinkCtl(new TextEncoder().encode(JSON.stringify(tooMany)))).toThrow(
      /too large|entries/
    );
    expect(() =>
      decodeMeshUplinkCtl(
        new TextEncoder().encode(
          JSON.stringify({ ...forward, kind: 'key.log.append', t: 'hub.forward' })
        )
      )
    ).toThrow(/kind/);
  });
});
