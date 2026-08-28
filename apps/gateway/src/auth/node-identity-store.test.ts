import { describe, expect, test } from 'bun:test';
import { bytesEqual } from '../bytes';
import { NodeIdentityStore } from './node-identity-store';
import { createMigratedAuthDb } from './test-db';

const ED = crypto.getRandomValues(new Uint8Array(32));
const X25519 = crypto.getRandomValues(new Uint8Array(32));
const CERT_SIG = crypto.getRandomValues(new Uint8Array(64));

describe('NodeIdentityStore', () => {
  test('load returns null when empty and after clear', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new NodeIdentityStore(db);
      expect(await store.load()).toBeNull();
      await store.save({
        nodeId: 'node-1',
        hubUrl: 'https://hub.example',
        edPrivateKey: ED,
        x25519PrivateKey: X25519,
        certificateJson: '{"domain":"tmex/nodecert/v1"}',
        certSig: CERT_SIG,
      });
      store.clear();
      expect(await store.load()).toBeNull();
    } finally {
      close();
    }
  });

  test('save/load round-trips keys through encryption at rest', async () => {
    const { db, sqlite, close } = createMigratedAuthDb();
    try {
      const store = new NodeIdentityStore(db);
      await store.save({
        nodeId: 'node-1',
        hubUrl: 'https://hub.example',
        edPrivateKey: ED,
        x25519PrivateKey: X25519,
        certificateJson: '{"node_id":"node-1"}',
        certSig: CERT_SIG,
      });

      const row = sqlite
        .query('SELECT private_key, x25519_private_key FROM node_identity')
        .get() as {
        private_key: string;
        x25519_private_key: string;
      };
      expect(row.private_key).not.toBe(Buffer.from(ED).toString('base64'));
      expect(row.x25519_private_key).not.toBe(Buffer.from(X25519).toString('base64'));

      const loaded = await store.load();
      expect(loaded).not.toBeNull();
      expect(loaded?.nodeId).toBe('node-1');
      expect(loaded?.hubUrl).toBe('https://hub.example');
      expect(loaded?.certificateJson).toBe('{"node_id":"node-1"}');
      expect(bytesEqual(loaded?.edPrivateKey ?? new Uint8Array(), ED)).toBe(true);
      expect(bytesEqual(loaded?.x25519PrivateKey ?? new Uint8Array(), X25519)).toBe(true);
      expect(bytesEqual(loaded?.certSig ?? new Uint8Array(), CERT_SIG)).toBe(true);
      expect(loaded?.userId).toBeNull();

      const nextEd = crypto.getRandomValues(new Uint8Array(32));
      await store.save({
        nodeId: 'node-1',
        hubUrl: null,
        edPrivateKey: nextEd,
        x25519PrivateKey: X25519,
        certificateJson: '{}',
        certSig: CERT_SIG,
        userId: 'user-42',
      });
      const updated = await store.load();
      expect(updated?.hubUrl).toBeNull();
      expect(updated?.userId).toBe('user-42');
      expect(bytesEqual(updated?.edPrivateKey ?? new Uint8Array(), nextEd)).toBe(true);
    } finally {
      close();
    }
  });

  test('save/load round-trips userId and preserves it across hubUrl-only updates', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new NodeIdentityStore(db);
      await store.save({
        nodeId: 'node-1',
        hubUrl: 'https://hub.example',
        edPrivateKey: ED,
        x25519PrivateKey: X25519,
        certificateJson: '{}',
        certSig: CERT_SIG,
        userId: 'uid-join',
      });
      const loaded = await store.load();
      expect(loaded).not.toBeNull();
      if (!loaded) return;
      expect(loaded.userId).toBe('uid-join');
      await store.save({ ...loaded, hubUrl: null });
      expect((await store.load())?.userId).toBe('uid-join');
    } finally {
      close();
    }
  });
});
