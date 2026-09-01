import type { HubEndpointInfo, HubMode } from '@tmex/shared/uplink';
import { eq, notInArray } from 'drizzle-orm';
import { meshHubs } from '../db/schema';
import type { AuthDb } from './types';

export interface MeshHubRecord {
  hubNodeId: string;
  publicUrl: string;
  name: string | null;
  mode: HubMode;
  priority: number;
  writerEpoch: number;
  caFingerprint: string | null;
  online: boolean;
  lastSeenAt: number | null;
  updatedAt: number;
}

type MeshHubWrite = Omit<MeshHubRecord, 'updatedAt'>;

function toRecord(row: {
  hubNodeId: string;
  publicUrl: string;
  name: string | null;
  mode: string;
  priority: number;
  writerEpoch: number;
  caFingerprint: string | null;
  online: boolean;
  lastSeenAt: number | null;
  updatedAt: number;
}): MeshHubRecord {
  return {
    hubNodeId: row.hubNodeId,
    publicUrl: row.publicUrl,
    name: row.name,
    mode: row.mode === 'standby' ? 'standby' : 'active',
    priority: row.priority,
    writerEpoch: row.writerEpoch,
    caFingerprint: row.caFingerprint,
    online: row.online,
    lastSeenAt: row.lastSeenAt,
    updatedAt: row.updatedAt,
  };
}

function compareMeshHubs(a: MeshHubRecord, b: MeshHubRecord): number {
  const aActive = a.mode === 'active' ? 0 : 1;
  const bActive = b.mode === 'active' ? 0 : 1;
  if (aActive !== bActive) return aActive - bActive;
  if (a.mode === 'active' && a.writerEpoch !== b.writerEpoch) {
    return b.writerEpoch - a.writerEpoch;
  }
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.publicUrl !== b.publicUrl) return a.publicUrl < b.publicUrl ? -1 : 1;
  return a.hubNodeId < b.hubNodeId ? -1 : a.hubNodeId > b.hubNodeId ? 1 : 0;
}

function upsertRow(db: AuthDb, rec: MeshHubWrite, now: number): void {
  db.insert(meshHubs)
    .values({
      hubNodeId: rec.hubNodeId,
      publicUrl: rec.publicUrl,
      name: rec.name,
      mode: rec.mode,
      priority: rec.priority,
      writerEpoch: rec.writerEpoch,
      caFingerprint: rec.caFingerprint,
      online: rec.online,
      lastSeenAt: rec.lastSeenAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: meshHubs.hubNodeId,
      set: {
        publicUrl: rec.publicUrl,
        name: rec.name,
        mode: rec.mode,
        priority: rec.priority,
        writerEpoch: rec.writerEpoch,
        caFingerprint: rec.caFingerprint,
        online: rec.online,
        lastSeenAt: rec.lastSeenAt,
        updatedAt: now,
      },
    })
    .run();
}

export class MeshHubStore {
  constructor(private readonly db: AuthDb) {}

  list(): MeshHubRecord[] {
    return this.db.select().from(meshHubs).all().map(toRecord).sort(compareMeshHubs);
  }

  get(hubNodeId: string): MeshHubRecord | null {
    const row = this.db.select().from(meshHubs).where(eq(meshHubs.hubNodeId, hubNodeId)).get();
    return row ? toRecord(row) : null;
  }

  upsert(rec: Omit<MeshHubRecord, 'updatedAt'>, now: number): void {
    upsertRow(this.db, rec, now);
  }

  replaceAll(recs: Array<Omit<MeshHubRecord, 'updatedAt'>>, now: number): void {
    this.db.transaction((tx) => {
      const ids = recs.map((row) => row.hubNodeId);
      if (ids.length === 0) {
        tx.delete(meshHubs).run();
      } else {
        tx.delete(meshHubs).where(notInArray(meshHubs.hubNodeId, ids)).run();
      }
      for (const rec of recs) upsertRow(tx as AuthDb, rec, now);
    });
  }

  remove(hubNodeId: string): void {
    this.db.delete(meshHubs).where(eq(meshHubs.hubNodeId, hubNodeId)).run();
  }

  /** Ordered failover candidates: same order as list(). */
  orderedEndpoints(): Array<{
    hubNodeId: string;
    publicUrl: string;
    mode: HubMode;
    writerEpoch: number;
    priority: number;
    caFingerprint: string | null;
  }> {
    return this.list().map((row) => ({
      hubNodeId: row.hubNodeId,
      publicUrl: row.publicUrl,
      mode: row.mode,
      writerEpoch: row.writerEpoch,
      priority: row.priority,
      caFingerprint: row.caFingerprint,
    }));
  }
}

export function hubListToRecords(hubs: HubEndpointInfo[]): Array<Omit<MeshHubRecord, 'updatedAt'>> {
  return hubs.map((hub) => ({
    hubNodeId: hub.nodeId,
    publicUrl: hub.publicUrl,
    name: hub.name ?? null,
    mode: hub.mode,
    priority: hub.priority,
    writerEpoch: hub.writerEpoch,
    caFingerprint: hub.caFingerprint ?? null,
    online: hub.online ?? false,
    lastSeenAt: hub.lastSeenAt ?? null,
  }));
}

export function pickWriterHub(
  hubs: Pick<MeshHubRecord, 'hubNodeId' | 'mode' | 'writerEpoch' | 'priority'>[]
): string | null {
  const actives = hubs.filter((hub) => hub.mode === 'active');
  if (actives.length === 0) return null;
  actives.sort((a, b) => {
    if (a.writerEpoch !== b.writerEpoch) return b.writerEpoch - a.writerEpoch;
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.hubNodeId < b.hubNodeId) return -1;
    if (a.hubNodeId > b.hubNodeId) return 1;
    return 0;
  });
  return actives[0]?.hubNodeId ?? null;
}
