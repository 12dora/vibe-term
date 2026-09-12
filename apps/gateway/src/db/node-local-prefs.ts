import { eq } from 'drizzle-orm';
import { getDb as getOrmDb } from './client';
import { nodeLocalPrefs } from './schema';

export function listPausedNodeIds(): string[] {
  return getOrmDb()
    .select({ nodeId: nodeLocalPrefs.nodeId })
    .from(nodeLocalPrefs)
    .where(eq(nodeLocalPrefs.paused, true))
    .all()
    .map((row) => row.nodeId);
}

export function getNodeLocalPaused(nodeId: string): boolean {
  const row = getOrmDb()
    .select({ paused: nodeLocalPrefs.paused })
    .from(nodeLocalPrefs)
    .where(eq(nodeLocalPrefs.nodeId, nodeId))
    .get();
  return row?.paused === true;
}

export function setNodeLocalPaused(nodeId: string, paused: boolean): void {
  const now = Date.now();
  getOrmDb()
    .insert(nodeLocalPrefs)
    .values({ nodeId, paused, updatedAt: now })
    .onConflictDoUpdate({
      target: nodeLocalPrefs.nodeId,
      set: { paused, updatedAt: now },
    })
    .run();
}
