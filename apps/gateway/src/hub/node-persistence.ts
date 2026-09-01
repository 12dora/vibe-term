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

export type UpsertEnrolledNodeInput = {
  id: string;
  userId: string;
  name: string;
  version: string | null;
  directCapable: boolean;
  inventoryJson?: string;
  endpointsJson?: string;
  lastSeenAt: number | null;
  now: number;
};

export function upsertEnrolledNode(db: AuthDb, input: UpsertEnrolledNodeInput): void {
  const existing = db.select().from(nodes).where(eq(nodes.id, input.id)).get();
  if (existing) {
    const patch: NodePatch = {
      name: input.name,
      status: 'enrolled',
      version: input.version,
      directCapable: input.directCapable,
      lastSeenAt: input.lastSeenAt,
    };
    if (input.inventoryJson !== undefined) {
      patch.inventoryJson = input.inventoryJson;
      patch.inventoryVersion = existing.inventoryVersion + 1;
    }
    if (input.endpointsJson !== undefined) patch.endpointsJson = input.endpointsJson;
    patchNode(db, input.id, patch);
    return;
  }
  db.insert(nodes)
    .values({
      id: input.id,
      userId: input.userId,
      name: input.name,
      status: 'enrolled',
      lastSeenAt: input.lastSeenAt,
      version: input.version,
      directCapable: input.directCapable,
      inventoryJson: input.inventoryJson ?? '{}',
      inventoryVersion: 0,
      endpointsJson: input.endpointsJson ?? '[]',
      createdAt: input.now,
    })
    .run();
}
