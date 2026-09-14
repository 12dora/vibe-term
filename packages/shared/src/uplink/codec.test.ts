import { describe, expect, test } from 'bun:test';
import { encodeBase64url, randomBytes } from '../auth/encoding';
import {
  KEY_LOG_PAGE_MAX_BYTES,
  type MeshUplinkNodeList,
  type NodeListMessage,
  type NodeStatusMessage,
  UPLINK_CTL_MAX_BYTES,
  UplinkCtlError,
  assertCtlBounds,
  b64urlToBytes,
  bytesToB64url,
  decodeMeshUplinkCtl,
  decodePeerUplinkCtl,
  encodeMeshUplinkCtl,
  encodePeerUplinkCtl,
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

describe('mesh vs peer large-page policy', () => {
  test('mesh 仅在 pending id 匹配时接受 1MiB key.log.res；peer 默认拒绝 key.log.res', () => {
    const id = 'pending-1';
    const empty = JSON.stringify({ t: 'key.log.res', records: [], id, pad: '' });
    const prefix = empty.slice(0, -2);
    const pad = 'x'.repeat(KEY_LOG_PAGE_MAX_BYTES - prefix.length - 2);
    const huge = new TextEncoder().encode(`${prefix}${pad}"}`);
    expect(huge.byteLength).toBe(KEY_LOG_PAGE_MAX_BYTES);
    expect(() => decodeMeshUplinkCtl(huge)).toThrow(/too large/);
    expect(decodeMeshUplinkCtl(huge, { pendingKeyLogId: id }).t).toBe('key.log.res');
    expect(() => decodePeerUplinkCtl(huge)).toThrow(UplinkCtlError);
    const small = JSON.stringify({ t: 'key.log.res', records: [] });
    expect(() => decodePeerUplinkCtl(small)).toThrow(UplinkCtlError);
    expect(decodePeerUplinkCtl(small, { allowKeyLogRes: true }).t).toBe('key.log.res');
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
    expect(decodePeerUplinkCtl(frame)).toMatchObject({ t: 'enroll.redeemed', node_id: lower });
    const authResponse = new TextEncoder().encode(
      JSON.stringify({ t: 'auth.response', node_id: upper, sig: encodeBase64url(certSig) })
    );
    expect(decodePeerUplinkCtl(authResponse)).toMatchObject({
      t: 'auth.response',
      node_id: lower,
    });
  });

  test('ping round-trip 两侧一致', () => {
    expect(decodeMeshUplinkCtl(encodeMeshUplinkCtl({ t: 'ping' }))).toEqual({ t: 'ping' });
    expect(decodePeerUplinkCtl(encodePeerUplinkCtl({ t: 'ping' }))).toEqual({ t: 'ping' });
    expect(() => decodePeerUplinkCtl(new Uint8Array(UPLINK_CTL_MAX_BYTES + 1))).toThrow(
      UplinkCtlError
    );
  });
});

const NODE_A = 'aa'.repeat(16);
const HUB_A = 'cc'.repeat(16);
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

function peerList(over: Partial<NodeListMessage> = {}): NodeListMessage {
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

describe('node.status / node.list wire', () => {
  test('node.list 核心字段往返（mesh + peer）', () => {
    const mesh = meshList({
      version: 12,
      nodes: [
        {
          id: NODE_A,
          name: 'alpha',
          online: true,
          endpoints: [],
          inventory: {},
          direct_capable: true,
          version: '2.4.4',
        },
      ],
    });
    const meshDecoded = decodeMeshUplinkCtl(encodeMeshUplinkCtl(mesh)) as MeshUplinkNodeList;
    expect(meshDecoded).toMatchObject({
      t: 'node.list',
      version: 12,
      nodes: [{ id: NODE_A, name: 'alpha', online: true, direct_capable: true, version: '2.4.4' }],
    });
    expect(meshDecoded.key_log_head.hash).toEqual(HASH32);

    const peer = peerList({
      version: 12,
      nodes: [
        {
          id: NODE_A,
          name: 'alpha',
          online: true,
          endpoints: [],
          inventory: {},
          direct_capable: true,
          version: '2.4.4',
        },
      ],
    });
    const peerDecoded = decodePeerUplinkCtl(encodePeerUplinkCtl(peer)) as NodeListMessage;
    expect(peerDecoded).toMatchObject({
      t: 'node.list',
      version: 12,
      nodes: [{ id: NODE_A, name: 'alpha' }],
    });
    expect(peerDecoded.key_log_head.hash).toBe(HASH_B64);
  });

  test('node.status 可选 peer_reach 往返；未知键忽略', () => {
    const msg = statusMsg({
      peer_reach: { abcdabcd: 'ok', deadbeef: 'timeout' },
      peer_reach_epoch: 4,
    });
    const round = decodePeerUplinkCtl(encodePeerUplinkCtl(msg));
    expect(round.t).toBe('node.status');
    if (round.t === 'node.status') {
      expect(round.peer_reach).toEqual({ abcdabcd: 'ok', deadbeef: 'timeout' });
      expect(round.peer_reach_epoch).toBe(4);
    }
    const extra = new TextEncoder().encode(
      JSON.stringify({
        t: 'node.status',
        version: '1',
        tmux: true,
        direct_capable: false,
        inventory: {},
        endpoints: [],
        mystery: true,
      })
    );
    const decoded = decodePeerUplinkCtl(extra);
    expect(decoded.t).toBe('node.status');
    if (decoded.t === 'node.status') {
      expect((decoded as { mystery?: unknown }).mystery).toBeUndefined();
      expect(decoded.peer_reach).toBeUndefined();
    }
  });

  test('2.4.x node.list 含 hub/hubs/writerHubId 时忽略未知键且不抛', () => {
    const extra = {
      t: 'node.list',
      version: 1,
      key_log_head: { seq: 1, hash: HASH_B64 },
      rtc: { stun: [], turn: null },
      nodes: [
        {
          id: NODE_A,
          name: 'alpha',
          online: true,
          endpoints: [],
          inventory: {},
          direct_capable: false,
          version: '2.4.4',
          attachedHubId: HUB_A,
        },
      ],
      hub: { nodeId: HUB_A, publicUrl: 'https://hub.example', name: 'primary' },
      hubs: [
        {
          nodeId: HUB_A,
          publicUrl: 'https://hub.example',
          mode: 'active',
          priority: 0,
          writerEpoch: 1,
        },
      ],
      writerHubId: HUB_A,
      writerEpoch: 3,
      futureField: { nested: 1 },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(extra));

    const mesh = decodeMeshUplinkCtl(bytes) as MeshUplinkNodeList;
    expect(mesh.t).toBe('node.list');
    expect(mesh.version).toBe(1);
    expect(mesh.nodes[0]?.id).toBe(NODE_A);
    expect((mesh as { hub?: unknown }).hub).toBeUndefined();
    expect((mesh as { hubs?: unknown }).hubs).toBeUndefined();
    expect((mesh as { writerHubId?: unknown }).writerHubId).toBeUndefined();
    expect((mesh as { writerEpoch?: unknown }).writerEpoch).toBeUndefined();
    expect((mesh.nodes[0] as { attachedHubId?: unknown }).attachedHubId).toBeUndefined();
    expect((mesh as { futureField?: unknown }).futureField).toBeUndefined();

    const peer = decodePeerUplinkCtl(bytes) as NodeListMessage;
    expect(peer.t).toBe('node.list');
    expect(peer.nodes[0]?.id).toBe(NODE_A);
    expect((peer as { hub?: unknown }).hub).toBeUndefined();
    expect((peer as { hubs?: unknown }).hubs).toBeUndefined();
    expect((peer as { writerHubId?: unknown }).writerHubId).toBeUndefined();
    expect((peer as { writerEpoch?: unknown }).writerEpoch).toBeUndefined();
    expect((peer.nodes[0] as { attachedHubId?: unknown }).attachedHubId).toBeUndefined();
  });

  test('node.status 上的 2.4.x hub 广告键被忽略', () => {
    const decoded = decodeMeshUplinkCtl(
      new TextEncoder().encode(
        JSON.stringify({
          t: 'node.status',
          version: '1',
          tmux: false,
          direct_capable: false,
          extraStatus: 1,
          hub: {
            publicUrl: 'https://hub.example',
            mode: 'active',
            priority: 0,
            writerEpoch: 1,
          },
        })
      )
    );
    expect(decoded).toEqual({
      t: 'node.status',
      version: '1',
      tmux: false,
      direct_capable: false,
      inventory: {},
      endpoints: [],
    });
    expect((decoded as { hub?: unknown }).hub).toBeUndefined();
  });

  test('hub 联邦 ctl 类型不再识别', () => {
    const enc = (t: string) => new TextEncoder().encode(JSON.stringify({ t }));
    expect(() => decodeMeshUplinkCtl(enc('hub.tokens'))).toThrow(
      /unknown uplink ctl t: hub\.tokens/
    );
    expect(() => decodeMeshUplinkCtl(enc('hub.attachments'))).toThrow(
      /unknown uplink ctl t: hub\.attachments/
    );
    expect(() => decodeMeshUplinkCtl(enc('hub.forward'))).toThrow(
      /unknown uplink ctl t: hub\.forward/
    );
    expect(() => decodeMeshUplinkCtl(enc('hub.write-forward'))).toThrow(
      /unknown uplink ctl t: hub\.write-forward/
    );
    expect(() => decodePeerUplinkCtl(enc('hub.tokens'))).toThrow(/unknown t: hub\.tokens/);
  });
});

describe('key.log.append force', () => {
  test('key.log.append force 往返，legacy 剥离', () => {
    const bytes = randomBytes(8);
    const sig = randomBytes(64);
    const mesh = decodeMeshUplinkCtl(
      encodeMeshUplinkCtl({ t: 'key.log.append', bytes, sig, id: 'a1', force: true })
    );
    expect(mesh).toMatchObject({ t: 'key.log.append', id: 'a1', force: true });
    const peer = decodePeerUplinkCtl(
      encodePeerUplinkCtl({
        t: 'key.log.append',
        bytes: bytesToB64url(bytes),
        sig: bytesToB64url(sig),
        id: 'a1',
        force: true,
      })
    );
    expect(peer).toMatchObject({ t: 'key.log.append', id: 'a1', force: true });
    const legacyMesh = JSON.parse(
      new TextDecoder().decode(
        encodeMeshUplinkCtl({ t: 'key.log.append', bytes, sig, force: true }, { legacy: true })
      )
    ) as { force?: boolean };
    expect(legacyMesh.force).toBeUndefined();
    const legacyPeer = JSON.parse(
      new TextDecoder().decode(
        encodePeerUplinkCtl(
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
    expect(legacyPeer.force).toBeUndefined();
    const old = decodeMeshUplinkCtl(
      encodeMeshUplinkCtl({ t: 'key.log.append', bytes, sig, id: 'old' })
    );
    expect(old).toMatchObject({ t: 'key.log.append', id: 'old' });
    expect('force' in old ? (old as { force?: boolean }).force : undefined).toBeUndefined();
  });
});
