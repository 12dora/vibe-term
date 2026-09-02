import { eq } from 'drizzle-orm';
import type { AuthDb } from '../auth/types';
import { getDb as getOrmDb } from './client';
import { nodeAccessPolicy } from './schema';

export const NODE_ACCESS_POLICY_ID = 1;

export type DomainAccessState = {
  allowDomainAccess: boolean;
};

type Listener = (state: DomainAccessState) => void;

export class DomainAccessStore {
  private cache: DomainAccessState | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly db: AuthDb = getOrmDb()) {}

  get(): DomainAccessState {
    if (this.cache) return this.cache;
    try {
      this.cache = this.loadOrCreate();
      return this.cache;
    } catch {
      return { allowDomainAccess: true };
    }
  }

  set(allow: boolean): DomainAccessState {
    const now = Date.now();
    this.db
      .insert(nodeAccessPolicy)
      .values({
        id: NODE_ACCESS_POLICY_ID,
        allowDomainAccess: allow,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: nodeAccessPolicy.id,
        set: { allowDomainAccess: allow, updatedAt: now },
      })
      .run();
    this.cache = { allowDomainAccess: allow };
    for (const listener of this.listeners) listener(this.cache);
    return this.cache;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private loadOrCreate(): DomainAccessState {
    const existing = this.readRow();
    if (existing) return existing;
    const now = Date.now();
    this.db
      .insert(nodeAccessPolicy)
      .values({
        id: NODE_ACCESS_POLICY_ID,
        allowDomainAccess: true,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: nodeAccessPolicy.id })
      .run();
    const created = this.readRow();
    if (!created) throw new Error('node_access_policy not initialized');
    return created;
  }

  private readRow(): DomainAccessState | null {
    const row = this.db
      .select()
      .from(nodeAccessPolicy)
      .where(eq(nodeAccessPolicy.id, NODE_ACCESS_POLICY_ID))
      .get();
    if (!row) return null;
    return { allowDomainAccess: Boolean(row.allowDomainAccess) };
  }
}

export const domainAccessStore = new DomainAccessStore();
