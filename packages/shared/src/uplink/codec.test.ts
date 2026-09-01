import { describe, expect, test } from 'bun:test';
import { encodeBase64url, randomBytes } from '../auth/encoding';
import {
  HUB_NOT_WRITER,
  type HubAdvertisement,
  type HubEndpointInfo,
  type HubNotWriterError,
  KEY_LOG_PAGE_MAX_BYTES,
  type MeshUplinkNodeList,
  type NodeListMessage,
  type NodeStatusMessage,
  UPLINK_CTL_MAX_BYTES,
  UplinkCtlError,
  assertCtlBounds,
  b64urlToBytes,
  bytesToB64url,
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
