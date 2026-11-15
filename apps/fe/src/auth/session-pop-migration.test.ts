import { describe, expect, test } from 'bun:test';
import { generateWebCryptoEd25519KeyPair } from '@vibeterm/shared/auth';
import { normalizePopRecord } from './session-key-persistence';
import { popKeyId } from './session-pop-login';

describe('normalizePopRecord', () => {
  test('v1（单钥 + nodeId→过期时刻）搬成 v2：同一把钥绑到它名下的每个 node', async () => {
    const pair = await generateWebCryptoEd25519KeyPair();
    const record = await normalizePopRecord({
      version: 1,
      privateKey: pair.privateKey,
      sessPk: pair.publicKey,
      nodes: { self: 111, b: 222 },
    });
    const id = popKeyId(pair.publicKey);
    expect(record?.version).toBe(2);
    expect(Object.keys(record?.keys ?? {})).toEqual([id]);
    expect(record?.nodes).toEqual({
      self: { pk: id, expiresAt: 111 },
      b: { pk: id, expiresAt: 222 },
    });
  });

  test('v1 记录里钥可导出 / 缺字段：当作没有', async () => {
    const pair = await generateWebCryptoEd25519KeyPair();
    const bad = {
      version: 1,
      privateKey: { extractable: true },
      sessPk: pair.publicKey,
      nodes: {},
    };
    expect(await normalizePopRecord(bad)).toBeNull();
    expect(await normalizePopRecord({ version: 1, nodes: {} })).toBeNull();
  });

  test('v2 原样通过；引用了不存在的钥、可导出钥、未知版本一律当作没有', async () => {
    const pair = await generateWebCryptoEd25519KeyPair();
    const id = popKeyId(pair.publicKey);
    const good = {
      version: 2,
      keys: { [id]: { privateKey: pair.privateKey, sessPk: pair.publicKey } },
      nodes: { self: { pk: id, expiresAt: 1 } },
    };
    expect(await normalizePopRecord(good)).toEqual(good);
    expect(
      await normalizePopRecord({ ...good, nodes: { self: { pk: 'missing', expiresAt: 1 } } })
    ).toBeNull();
    expect(
      await normalizePopRecord({
        ...good,
        keys: { [id]: { privateKey: { extractable: true }, sessPk: pair.publicKey } },
      })
    ).toBeNull();
    expect(await normalizePopRecord({ ...good, version: 3 })).toBeNull();
    expect(await normalizePopRecord(null)).toBeNull();
  });
});
