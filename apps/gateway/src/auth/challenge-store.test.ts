import { describe, expect, test } from 'bun:test';
import { ChallengeStore } from './challenge-store';

describe('ChallengeStore', () => {
  test('create returns a 32-byte nonce and records the entry node', () => {
    const store = new ChallengeStore({ now: () => 1_000 });
    const created = store.create({
      uid: 'user-1',
      entryNodeId: 'entry-a',
      kind: 'login',
      ttlMs: 60_000,
      payload: { origin: 'https://tmex.example' },
    });

    expect(created.nonce.byteLength).toBe(32);
    expect(created.challengeId.length).toBeGreaterThan(0);

    const entry = store.consume(created.challengeId);
    expect(entry).not.toBeNull();
    expect(entry?.uid).toBe('user-1');
    expect(entry?.entryNodeId).toBe('entry-a');
    expect(entry?.kind).toBe('login');
    expect(entry?.payload).toEqual({ origin: 'https://tmex.example' });
    expect(entry?.nonce).toEqual(created.nonce);
    expect(entry?.expiresAt).toBe(61_000);
  });

  test('consume is atomic: second call returns null', () => {
    const store = new ChallengeStore();
    const { challengeId } = store.create({
      uid: 'user-1',
      entryNodeId: 'self',
      kind: 'passkey-login',
      ttlMs: 60_000,
    });
    expect(store.consume(challengeId)).not.toBeNull();
    expect(store.consume(challengeId)).toBeNull();
  });

  test('expired challenges cannot be consumed', () => {
    let now = 1_000;
    const store = new ChallengeStore({ now: () => now });
    const { challengeId } = store.create({
      uid: 'user-1',
      entryNodeId: 'self',
      kind: 'passkey-register',
      ttlMs: 60_000,
    });
    now = 61_000;
    expect(store.consume(challengeId)).toBeNull();
  });

  test('sweepExpired drops stale entries so the map cannot grow without bound', () => {
    let now = 0;
    const store = new ChallengeStore({ now: () => now });
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(
        store.create({
          uid: 'user-1',
          entryNodeId: 'self',
          kind: 'rtc-authorize',
          ttlMs: 10,
        }).challengeId
      );
    }
    now = 11;
    expect(store.sweepExpired()).toBe(5);
    for (const id of ids) {
      expect(store.consume(id)).toBeNull();
    }

    const first = store.create({
      uid: 'user-1',
      entryNodeId: 'self',
      kind: 'login',
      ttlMs: 1_000,
    });
    now = 2_000;
    store.create({
      uid: 'user-2',
      entryNodeId: 'self',
      kind: 'login',
      ttlMs: 1_000,
    });
    expect(store.consume(first.challengeId)).toBeNull();
  });

  test('unknown challenge id returns null', () => {
    const store = new ChallengeStore();
    expect(store.consume('missing')).toBeNull();
  });
});
