import { eq } from 'drizzle-orm';
import type { AuthDb, NodeStatus } from '../auth/types';
import { enrollmentTokens, nodes } from '../db/schema';

export type NodePatch = {
  name?: string;
  status?: NodeStatus;
  lastSeenAt?: number | null;
  version?: string | null;
  directCapable?: boolean;
  inventoryJson?: string;
  inventoryVersion?: number;
  endpointsJson?: string;
};

export function patchNode(db: AuthDb, id: string, patch: NodePatch): void {
  const set: {
    name?: string;
    status?: NodeStatus;
    lastSeenAt?: number | null;
    version?: string | null;
    directCapable?: boolean;
    inventoryJson?: string;
    inventoryVersion?: number;
    endpointsJson?: string;
  } = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.lastSeenAt !== undefined) set.lastSeenAt = patch.lastSeenAt;
  if (patch.version !== undefined) set.version = patch.version;
  if (patch.directCapable !== undefined) set.directCapable = patch.directCapable;
  if (patch.inventoryJson !== undefined) set.inventoryJson = patch.inventoryJson;
  if (patch.inventoryVersion !== undefined) set.inventoryVersion = patch.inventoryVersion;
  if (patch.endpointsJson !== undefined) set.endpointsJson = patch.endpointsJson;
  if (Object.keys(set).length === 0) return;
  db.update(nodes).set(set).where(eq(nodes.id, id)).run();
}

export function detachEnrollmentTokensFromNode(db: AuthDb, nodeId: string): void {
  db.update(enrollmentTokens)
    .set({ nodeId: null })
    .where(eq(enrollmentTokens.nodeId, nodeId))
    .run();
}
