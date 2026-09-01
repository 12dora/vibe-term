import { describe, expect, test } from 'bun:test';
import {
  type MeshHubRecord,
  MeshHubStore,
  hubListToRecords,
  pickWriterHub,
} from './mesh-hub-store';
import { createMigratedAuthDb } from './test-db';

const A = 'aa'.repeat(16);
const B = 'bb'.repeat(16);
const C = 'cc'.repeat(16);

function rec(
  over: Partial<Omit<MeshHubRecord, 'updatedAt'>> & Pick<MeshHubRecord, 'hubNodeId'>
): Omit<MeshHubRecord, 'updatedAt'> {
  return {
    publicUrl: `https://${over.hubNodeId.slice(0, 4)}.example`,
    name: null,
    mode: 'standby',
    priority: 200,
    writerEpoch: 1,
    caFingerprint: null,
    online: false,
    lastSeenAt: null,
    ...over,
  };
}

describe('MeshHubStore', () => {
  test('0032 creates mesh_hubs table', () => {
    const { sqlite, close } = createMigratedAuthDb();
    try {
      const tables = sqlite
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mesh_hubs'")
        .get();
      expect(tables).not.toBeNull();
      const columns = sqlite.query('PRAGMA table_info(mesh_hubs)').all() as Array<{
        name: string;
      }>;
      expect(columns.map((column) => column.name)).toEqual([
        'hub_node_id',
        'public_url',
        'name',
        'mode',
        'priority',
        'writer_epoch',
        'ca_fingerprint',
        'online',
        'last_seen_at',
        'updated_at',
      ]);
    } finally {
      close();
    }
  });

  test('upsert/get/remove 与 list 排序：active 按 epoch desc/priority asc，再 standby', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new MeshHubStore(db);
      expect(store.list()).toEqual([]);
      expect(store.get(A)).toBeNull();

      store.upsert(
        rec({
          hubNodeId: A,
          publicUrl: 'https://a.example',
          mode: 'active',
          priority: 50,
          writerEpoch: 2,
          online: true,
        }),
        1000
      );
      store.upsert(
        rec({
          hubNodeId: B,
          publicUrl: 'https://b.example',
          mode: 'active',
          priority: 10,
          writerEpoch: 2,
          name: 'b',
        }),
        1001
      );
      store.upsert(
        rec({
          hubNodeId: C,
          publicUrl: 'https://c.example',
          mode: 'standby',
          priority: 1,
          writerEpoch: 9,
        }),
        1002
      );

      const listed = store.list();
      expect(listed.map((row) => row.hubNodeId)).toEqual([B, A, C]);
      expect(listed[0]?.name).toBe('b');
      expect(listed[0]?.updatedAt).toBe(1001);
      expect(store.get(A)?.online).toBe(true);
      expect(store.orderedEndpoints().map((row) => row.hubNodeId)).toEqual([B, A, C]);
      expect(store.orderedEndpoints()[0]).toEqual({
        hubNodeId: B,
        publicUrl: 'https://b.example',
        mode: 'active',
        writerEpoch: 2,
        priority: 10,
        caFingerprint: null,
      });

      store.remove(B);
      expect(store.get(B)).toBeNull();
      expect(store.list().map((row) => row.hubNodeId)).toEqual([A, C]);
    } finally {
      close();
    }
  });

  test('replaceAll 事务性：删掉未出现的行并 upsert 其余', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new MeshHubStore(db);
      store.upsert(rec({ hubNodeId: A, mode: 'active', writerEpoch: 1 }), 1);
      store.upsert(rec({ hubNodeId: B, mode: 'standby' }), 1);
      store.replaceAll(
        [
          rec({
            hubNodeId: A,
            mode: 'active',
            writerEpoch: 4,
            publicUrl: 'https://a-new.example',
            online: true,
          }),
          rec({ hubNodeId: C, mode: 'standby', priority: 5 }),
        ],
        50
      );
      expect(store.get(B)).toBeNull();
      expect(store.get(A)?.writerEpoch).toBe(4);
      expect(store.get(A)?.publicUrl).toBe('https://a-new.example');
      expect(store.get(A)?.updatedAt).toBe(50);
      expect(store.get(C)?.priority).toBe(5);
      store.replaceAll([], 51);
      expect(store.list()).toEqual([]);
    } finally {
      close();
    }
  });
});

describe('hubListToRecords / pickWriterHub', () => {
  test('hubListToRecords 填默认 null/false', () => {
    const rows = hubListToRecords([
      {
        nodeId: A,
        publicUrl: 'https://a.example',
        mode: 'active',
        priority: 1,
        writerEpoch: 2,
      },
      {
        nodeId: B,
        publicUrl: 'https://b.example',
        name: 'standby',
        mode: 'standby',
        priority: 2,
        writerEpoch: 1,
        caFingerprint: 'ff'.repeat(32),
        online: true,
        lastSeenAt: 9,
      },
    ]);
    expect(rows[0]).toEqual({
      hubNodeId: A,
      publicUrl: 'https://a.example',
      name: null,
      mode: 'active',
      priority: 1,
      writerEpoch: 2,
      caFingerprint: null,
      online: false,
      lastSeenAt: null,
    });
    expect(rows[1]?.name).toBe('standby');
    expect(rows[1]?.online).toBe(true);
    expect(rows[1]?.caFingerprint).toBe('ff'.repeat(32));
    expect(rows[1]?.lastSeenAt).toBe(9);
  });

  test('pickWriterHub：最高 epoch 的 active，平手看 priority 再看 id', () => {
    expect(pickWriterHub([])).toBeNull();
    expect(
      pickWriterHub([
        { hubNodeId: A, mode: 'standby', writerEpoch: 99, priority: 0 },
        { hubNodeId: B, mode: 'standby', writerEpoch: 1, priority: 0 },
      ])
    ).toBeNull();
    expect(
      pickWriterHub([
        { hubNodeId: A, mode: 'active', writerEpoch: 1, priority: 1 },
        { hubNodeId: B, mode: 'active', writerEpoch: 3, priority: 9 },
        { hubNodeId: C, mode: 'standby', writerEpoch: 9, priority: 0 },
      ])
    ).toBe(B);
    expect(
      pickWriterHub([
        { hubNodeId: A, mode: 'active', writerEpoch: 2, priority: 5 },
        { hubNodeId: B, mode: 'active', writerEpoch: 2, priority: 1 },
      ])
    ).toBe(B);
    expect(
      pickWriterHub([
        { hubNodeId: C, mode: 'active', writerEpoch: 1, priority: 1 },
        { hubNodeId: A, mode: 'active', writerEpoch: 1, priority: 1 },
      ])
    ).toBe(A);
  });
});
