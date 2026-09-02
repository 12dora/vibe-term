import { afterEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createMigratedAuthDb } from '../auth/test-db';
import { DomainAccessStore, NODE_ACCESS_POLICY_ID } from './domain-access';
import { nodeAccessPolicy } from './schema';

const handles: Array<{ close: () => void }> = [];

function openStore(): DomainAccessStore {
  const { db, close } = createMigratedAuthDb();
  handles.push({ close });
  return new DomainAccessStore(db);
}

afterEach(() => {
  while (handles.length > 0) handles.pop()?.close();
});

describe('DomainAccessStore', () => {
  test('get lazily creates the default allowed row', () => {
    const { db, close } = createMigratedAuthDb();
    handles.push({ close });
    const before = db
      .select()
      .from(nodeAccessPolicy)
      .where(eq(nodeAccessPolicy.id, NODE_ACCESS_POLICY_ID))
      .get();
    expect(before).toBeUndefined();
    const store = new DomainAccessStore(db);
    expect(store.get()).toEqual({ allowDomainAccess: true });
    const after = db
      .select()
      .from(nodeAccessPolicy)
      .where(eq(nodeAccessPolicy.id, NODE_ACCESS_POLICY_ID))
      .get();
    expect(after?.allowDomainAccess).toBe(true);
    expect(typeof after?.updatedAt).toBe('number');
  });

  test('set persists, updates cache, and notifies listeners', () => {
    const store = openStore();
    const seen: boolean[] = [];
    const off = store.onChange((state) => seen.push(state.allowDomainAccess));
    expect(store.set(false)).toEqual({ allowDomainAccess: false });
    expect(store.get()).toEqual({ allowDomainAccess: false });
    expect(store.set(true)).toEqual({ allowDomainAccess: true });
    expect(seen).toEqual([false, true]);
    off();
    store.set(false);
    expect(seen).toEqual([false, true]);
  });

  test('get after set does not re-read a stale default', () => {
    const store = openStore();
    store.set(false);
    expect(store.get().allowDomainAccess).toBe(false);
  });
});
