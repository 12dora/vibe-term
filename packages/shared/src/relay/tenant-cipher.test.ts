import { describe, expect, it } from 'bun:test';
import { x25519 } from '@noble/curves/ed25519.js';
import { decodeBase64url, encodeBase64url } from '../auth/encoding';
import {
  RELAY_TENANT_KEY_LENGTH,
  RelayCipherError,
  type WrapEntry,
  findWrapEntry,
  generateTenantKey,
  openEnvelope,
  relayEnvelopeAad,
  sealEnvelope,
  unwrapKeyForNode,
  wrapKeyForNode,
  wrapKeyForNodes,
} from './tenant-cipher';

const td = new TextDecoder();

function fixedKey(): Uint8Array {
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = i + 1;
  return key;
}

function fixedNodeSk(): Uint8Array {
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sk[i] = 200 - i;
  return sk;
}

const NODE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

// 固定向量（由 tenant-cipher 自身生成一次后锁定）：解密方向确定，可回归 AAD/HKDF/nonce 布局。
const ENVELOPE_VECTOR = {
  v: 1,
  epoch: 7,
  n: 'tsFWfVbgybavZxTY',
  ct: 'Ll7mV9mQatx0XPvq34NT2xUVOFGiZEdQ3ywyfOFrxXWZ',
} as const;
const WRAP_VECTOR: WrapEntry = {
  node_id: NODE_ID,
  eph_pk: 'JA53NYDXcReYVagDEDB0Zl2XdG_TnEGazBkVe6JsUiA',
  nonce: 'I0zIEkD1QM1Wglgz',
  ct: '_fVVaONt92Reop3_ZlQUNWmz4HeexlKDk1eCPgQgm74n_iDwfbKc6hgawP-7zqBj',
};

describe('relayEnvelopeAad', () => {
  it('AAD 绑定用途', () => {
    expect(td.decode(relayEnvelopeAad('status'))).toBe('tmex-relay/status/v1');
    expect(td.decode(relayEnvelopeAad('keylog'))).toBe('tmex-relay/keylog/v1');
  });

  it('拒绝畸形 kind', () => {
    for (const kind of ['', 'Status', 'a/b', '../x', 'x'.repeat(33)]) {
      expect(() => relayEnvelopeAad(kind)).toThrow(RelayCipherError);
    }
  });
});

describe('generateTenantKey', () => {
  it('返回 32 字节且不重复', () => {
    const a = generateTenantKey();
    const b = generateTenantKey();
    expect(a.byteLength).toBe(RELAY_TENANT_KEY_LENGTH);
    expect(encodeBase64url(a)).not.toBe(encodeBase64url(b));
  });
});

describe('信封', () => {
  it('固定向量可解开', async () => {
    const plain = await openEnvelope(fixedKey(), 'status', { ...ENVELOPE_VECTOR });
    expect(td.decode(plain)).toBe('{"name":"vector"}');
  });

  it('round-trip 且带 epoch', async () => {
    const key = generateTenantKey();
    const payload = new TextEncoder().encode('hello relay');
    const env = await sealEnvelope(key, 'rtc', payload, 3);
    expect(env.v).toBe(1);
    expect(env.epoch).toBe(3);
    expect(decodeBase64url(env.n).byteLength).toBe(12);
    expect(td.decode(await openEnvelope(key, 'rtc', env))).toBe('hello relay');
  });

  it('不传 epoch 时不带该字段', async () => {
    const env = await sealEnvelope(generateTenantKey(), 'keylog', new Uint8Array([1, 2, 3]));
    expect('epoch' in env).toBe(false);
  });

  it('换密钥、换 kind、改密文都解不开', async () => {
    const key = generateTenantKey();
    const env = await sealEnvelope(key, 'status', new Uint8Array([9, 9, 9]));
    await expect(openEnvelope(generateTenantKey(), 'status', env)).rejects.toThrow(
      RelayCipherError
    );
    await expect(openEnvelope(key, 'rtc', env)).rejects.toThrow(RelayCipherError);
    const ct = decodeBase64url(env.ct);
    ct[0] ^= 0xff;
    await expect(openEnvelope(key, 'status', { ...env, ct: encodeBase64url(ct) })).rejects.toThrow(
      RelayCipherError
    );
  });

  it('拒绝非法版本 / nonce 长度 / 密钥长度', async () => {
    const key = generateTenantKey();
    const env = await sealEnvelope(key, 'status', new Uint8Array([1]));
    await expect(openEnvelope(key, 'status', { ...env, v: 2 as unknown as 1 })).rejects.toThrow(
      RelayCipherError
    );
    await expect(
      openEnvelope(key, 'status', { ...env, n: encodeBase64url(new Uint8Array(11)) })
    ).rejects.toThrow(RelayCipherError);
    await expect(sealEnvelope(new Uint8Array(31), 'status', new Uint8Array(1))).rejects.toThrow(
      RelayCipherError
    );
  });

  it('epoch 必须是非负整数', async () => {
    await expect(
      sealEnvelope(generateTenantKey(), 'status', new Uint8Array(1), -1)
    ).rejects.toThrow(RelayCipherError);
  });
});

describe('按节点封装租户密钥', () => {
  it('固定向量可解封', async () => {
    const key = await unwrapKeyForNode({ entry: WRAP_VECTOR, nodeX25519Sk: fixedNodeSk() });
    expect(encodeBase64url(key)).toBe(encodeBase64url(fixedKey()));
  });

  it('round-trip', async () => {
    const node = x25519.keygen();
    const key = generateTenantKey();
    const entry = await wrapKeyForNode({
      key,
      nodeId: NODE_ID,
      nodeX25519Pk: node.publicKey,
    });
    expect(entry.node_id).toBe(NODE_ID);
    expect(decodeBase64url(entry.eph_pk).byteLength).toBe(32);
    expect(decodeBase64url(entry.nonce).byteLength).toBe(12);
    expect(decodeBase64url(entry.ct).byteLength).toBe(48);
    const opened = await unwrapKeyForNode({ entry, nodeX25519Sk: node.secretKey });
    expect(encodeBase64url(opened)).toBe(encodeBase64url(key));
  });

  it('换节点私钥、改 node_id、改密文都解不开', async () => {
    const node = x25519.keygen();
    const other = x25519.keygen();
    const entry = await wrapKeyForNode({
      key: generateTenantKey(),
      nodeId: NODE_ID,
      nodeX25519Pk: node.publicKey,
    });
    await expect(unwrapKeyForNode({ entry, nodeX25519Sk: other.secretKey })).rejects.toThrow(
      RelayCipherError
    );
    await expect(
      unwrapKeyForNode({
        entry: { ...entry, node_id: '00000000000000000000000000000000' },
        nodeX25519Sk: node.secretKey,
      })
    ).rejects.toThrow(RelayCipherError);
    const ct = decodeBase64url(entry.ct);
    ct[47] ^= 0x01;
    await expect(
      unwrapKeyForNode({
        entry: { ...entry, ct: encodeBase64url(ct) },
        nodeX25519Sk: node.secretKey,
      })
    ).rejects.toThrow(RelayCipherError);
  });

  it('拒绝非法 node_id 与公钥长度', async () => {
    await expect(
      wrapKeyForNode({
        key: generateTenantKey(),
        nodeId: 'ZZ',
        nodeX25519Pk: new Uint8Array(32),
      })
    ).rejects.toThrow(RelayCipherError);
    await expect(
      wrapKeyForNode({
        key: generateTenantKey(),
        nodeId: NODE_ID,
        nodeX25519Pk: new Uint8Array(31),
      })
    ).rejects.toThrow(RelayCipherError);
  });

  it('批量封装并按 node_id 检索', async () => {
    const nodes = [x25519.keygen(), x25519.keygen()];
    const ids = ['1'.repeat(32), '2'.repeat(32)];
    const key = generateTenantKey();
    const entries = await wrapKeyForNodes({
      key,
      nodes: nodes.map((node, i) => ({ nodeId: ids[i], x25519Pk: node.publicKey })),
    });
    expect(entries.map((entry) => entry.node_id)).toEqual(ids);
    const mine = findWrapEntry(entries, ids[1]);
    expect(mine).toBeDefined();
    if (!mine) return;
    const opened = await unwrapKeyForNode({ entry: mine, nodeX25519Sk: nodes[1].secretKey });
    expect(encodeBase64url(opened)).toBe(encodeBase64url(key));
    expect(findWrapEntry(entries, '3'.repeat(32))).toBeUndefined();
  });
});
