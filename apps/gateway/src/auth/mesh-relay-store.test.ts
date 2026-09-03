import { describe, expect, test } from 'bun:test';
import { MeshRelayStore } from './mesh-relay-store';
import { ensureNodeIdentity } from './node-identity-service';
import { NodeIdentityStore } from './node-identity-store';
import { createMigratedAuthDb } from './test-db';

async function open() {
  const fixture = createMigratedAuthDb();
  await ensureNodeIdentity(new NodeIdentityStore(fixture.db));
  return { ...fixture, store: new MeshRelayStore(fixture.db) };
}

describe('MeshRelayStore', () => {
  test('中继目标按 priority 排序，token 加密后可解回', async () => {
    const f = await open();
    try {
      await f.store.replaceRelays(
        [
          {
            url: 'https://b.example',
            tenantId: 'bb'.repeat(16),
            token: new Uint8Array(32).fill(2),
            priority: 1,
          },
          {
            url: 'https://a.example',
            tenantId: 'aa'.repeat(16),
            token: new Uint8Array(32).fill(1),
            priority: 0,
          },
        ],
        1_000
      );
      expect(f.store.listRelayRows().map((row) => row.url)).toEqual([
        'https://a.example',
        'https://b.example',
      ]);
      const first = await f.store.getRelay('https://a.example');
      expect(first?.token).toEqual(new Uint8Array(32).fill(1));
      expect(first?.tenantId).toBe('aa'.repeat(16));
      expect(await f.store.getRelay('https://missing.example')).toBeNull();

      f.store.markKicked('https://a.example', true);
      expect(f.store.listRelayRows()[0]?.kicked).toBe(true);

      // 重新签发的 set-relays 整表替换，kicked 归零
      await f.store.replaceRelays(
        [
          {
            url: 'https://a.example',
            tenantId: 'aa'.repeat(16),
            token: new Uint8Array(32).fill(3),
            priority: 0,
          },
        ],
        2_000
      );
      expect(f.store.listRelayRows()).toEqual([
        { url: 'https://a.example', tenantId: 'aa'.repeat(16), priority: 0, kicked: false },
      ]);
    } finally {
      f.close();
    }
  });

  test('mesh_secrets 按 (kind, epoch) 存取，可列出已知世代', async () => {
    const f = await open();
    try {
      await f.store.putSecret('log', 0, new Uint8Array(32).fill(7), 1);
      await f.store.putSecret('meta', 1, new Uint8Array(32).fill(8), 1);
      await f.store.putSecret('meta', 2, new Uint8Array(32).fill(9), 2);
      expect(await f.store.getSecret('log', 0)).toEqual(new Uint8Array(32).fill(7));
      expect(await f.store.getSecret('meta', 2)).toEqual(new Uint8Array(32).fill(9));
      expect(await f.store.getSecret('meta', 3)).toBeNull();
      expect(f.store.listSecretEpochs('meta')).toEqual([1, 2]);
      f.store.clearSecrets();
      expect(f.store.listSecretEpochs('meta')).toEqual([]);
    } finally {
      f.close();
    }
  });

  test('node_identity 的 uplink_kind 与 name 缺省与写入', async () => {
    const f = await open();
    try {
      expect(f.store.uplinkKind()).toBe('hub');
      expect(f.store.localName()).toBeNull();
      f.store.setUplinkKind('relay');
      f.store.setLocalName('  node-a  ');
      expect(f.store.uplinkKind()).toBe('relay');
      expect(f.store.localName()).toBe('node-a');
      f.store.setLocalName('   ');
      expect(f.store.localName()).toBeNull();
    } finally {
      f.close();
    }
  });
});
