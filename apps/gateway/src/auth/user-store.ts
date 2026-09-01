import { and, eq, gt, isNull, lte } from 'drizzle-orm';
import {
  enrollmentTokens,
  nodeCerts,
  nodes,
  peerCache,
  userHubAuthorizations,
  userKeys,
  users,
} from '../db/schema';
import { toBuffer, toBytes } from './binary';
import type { AuthDb, NodeStatus } from './types';

export interface UserRecord {
  id: string;
  username: string;
  rootPublicKey: Uint8Array;
  rootEpoch: number;
  kdfParamsJson: string;
  totpRecordSeq: number | null;
  keyLogHeadSeq: number;
  keyLogHeadHash: Uint8Array;
  createdAt: number;
  updatedAt: number;
}

export interface CreateUserInput {
  id: string;
  username: string;
  rootPublicKey: Uint8Array;
  rootEpoch: number;
  kdfParamsJson: string;
  totpRecordSeq?: number | null;
  keyLogHeadSeq: number;
  keyLogHeadHash: Uint8Array;
  now: number;
}

export interface UserKeyRecord {
  id: string;
  userId: string;
  credentialId: Uint8Array;
  publicKey: Uint8Array;
  rpId: string;
  origin: string;
  counter: number;
  transports: string[];
  name: string | null;
  logSeq: number;
  createdAt: number;
}

export interface InsertUserKeyInput {
  id: string;
  userId: string;
  credentialId: Uint8Array;
  publicKey: Uint8Array;
  rpId: string;
  origin: string;
  counter: number;
  transports?: string[];
  name?: string | null;
  logSeq: number;
  now: number;
}

export interface NodeCertRecord {
  nodeId: string;
  userId: string;
  admitRecordSeq: number;
  certificateBytes: Uint8Array;
  certSig: Uint8Array;
  authorizationBytes: Uint8Array;
  authorizationSig: Uint8Array;
  revokedLogSeq: number | null;
}

export interface UpsertNodeCertInput {
  nodeId: string;
  userId: string;
  admitRecordSeq: number;
  certificateBytes: Uint8Array;
  certSig: Uint8Array;
  authorizationBytes: Uint8Array;
  authorizationSig: Uint8Array;
  revokedLogSeq?: number | null;
}

export type HubAuthorizationStatus = 'active' | 'retired';

export interface HubAuthorizationRecord {
  userId: string;
  hubNodeId: string;
  status: HubAuthorizationStatus;
  publicUrl: string | null;
  priority: number | null;
  admitSeq: number;
  retireSeq: number | null;
  updatedSeq: number;
}

export interface UpsertHubAuthorizationInput {
  userId: string;
  hubNodeId: string;
  status: HubAuthorizationStatus;
  publicUrl?: string | null;
  priority?: number | null;
  admitSeq: number;
  retireSeq?: number | null;
  updatedSeq: number;
}

export interface PeerCacheRecord {
  nodeId: string;
  name: string;
  endpointsJson: string;
  inventoryJson: string;
  directCapable: boolean;
  lastSeenAt: number | null;
  listVersion: number;
}

export interface UpsertPeerCacheInput {
  nodeId: string;
  name: string;
  endpointsJson: string;
  inventoryJson: string;
  directCapable: boolean;
  lastSeenAt: number | null;
  listVersion: number;
}

export interface NodeRecord {
  id: string;
  userId: string;
  name: string;
  status: NodeStatus;
  lastSeenAt: number | null;
  version: string | null;
  directCapable: boolean;
  inventoryJson: string;
  inventoryVersion: number;
  endpointsJson: string;
  createdAt: number;
}

export interface CreateNodeInput {
  id: string;
  userId: string;
  name: string;
  status?: NodeStatus;
  lastSeenAt?: number | null;
  version?: string | null;
  directCapable?: boolean;
  inventoryJson?: string;
  inventoryVersion?: number;
  endpointsJson?: string;
  now: number;
}

export interface EnrollmentTokenRecord {
  id: string;
  userId: string;
  enrollPublicKey: Uint8Array;
  authorizationJson: string;
  authorizationSig: Uint8Array;
  expiresAt: number;
  usedAt: number | null;
  nodeId: string | null;
}

export interface CreateEnrollmentTokenInput {
  id: string;
  userId: string;
  enrollPublicKey: Uint8Array;
  authorizationJson: string;
  authorizationSig: Uint8Array;
  expiresAt: number;
}

export type EnrollmentTokenRevision = { epoch: number; seq: number };

export type ApplyEnrollmentTokenReplicationInput = {
  op: 'upsert' | 'tombstone';
  revision: EnrollmentTokenRevision;
  token?: EnrollmentTokenRecord;
  id?: string;
};

export type ApplyEnrollmentTokenReplicationResult = 'applied' | 'ignored';

export const HUB_META_PEER_ID = 'hub';

export class UserStore {
  constructor(private readonly db: AuthDb) {}

  getByUsername(username: string): UserRecord | null {
    const row = this.db.select().from(users).where(eq(users.username, username)).get();
    return row ? toUser(row) : null;
  }

  getById(id: string): UserRecord | null {
    const row = this.db.select().from(users).where(eq(users.id, id)).get();
    return row ? toUser(row) : null;
  }

  listUsers(): UserRecord[] {
    return this.db.select().from(users).all().map(toUser);
  }

  updateUsername(userId: string, username: string, now: number): void {
    this.db.update(users).set({ username, updatedAt: now }).where(eq(users.id, userId)).run();
  }

  deleteById(userId: string): void {
    this.db.delete(users).where(eq(users.id, userId)).run();
  }

  deleteNodesByUser(userId: string): void {
    this.db.delete(nodes).where(eq(nodes.userId, userId)).run();
  }

  deleteEnrollmentTokensByUser(userId: string): void {
    this.db.delete(enrollmentTokens).where(eq(enrollmentTokens.userId, userId)).run();
  }

  create(input: CreateUserInput): UserRecord {
    this.db
      .insert(users)
      .values({
        id: input.id,
        username: input.username,
        rootPublicKey: toBuffer(input.rootPublicKey),
        rootEpoch: input.rootEpoch,
        kdfParamsJson: input.kdfParamsJson,
        totpRecordSeq: input.totpRecordSeq ?? null,
        keyLogHeadSeq: input.keyLogHeadSeq,
        keyLogHeadHash: toBuffer(input.keyLogHeadHash),
        createdAt: input.now,
        updatedAt: input.now,
      })
      .run();
    const created = this.getById(input.id);
    if (!created) {
      throw new Error('failed to create user');
    }
    return created;
  }

  updateRoot(
    userId: string,
    input: { rootPublicKey: Uint8Array; rootEpoch: number; kdfParamsJson: string; now: number }
  ): void {
    this.db
      .update(users)
      .set({
        rootPublicKey: toBuffer(input.rootPublicKey),
        rootEpoch: input.rootEpoch,
        kdfParamsJson: input.kdfParamsJson,
        updatedAt: input.now,
      })
      .where(eq(users.id, userId))
      .run();
  }

  setKeyLogHead(userId: string, input: { seq: number; hash: Uint8Array; now: number }): void {
    this.db
      .update(users)
      .set({
        keyLogHeadSeq: input.seq,
        keyLogHeadHash: toBuffer(input.hash),
        updatedAt: input.now,
      })
      .where(eq(users.id, userId))
      .run();
  }

  setTotpRecordSeq(userId: string, seq: number | null, now: number): void {
    this.db
      .update(users)
      .set({ totpRecordSeq: seq, updatedAt: now })
      .where(eq(users.id, userId))
      .run();
  }

  listKeysByUser(userId: string): UserKeyRecord[] {
    return this.db.select().from(userKeys).where(eq(userKeys.userId, userId)).all().map(toUserKey);
  }

  getKeyByCredentialId(credentialId: Uint8Array): UserKeyRecord | null {
    const row = this.db
      .select()
      .from(userKeys)
      .where(eq(userKeys.credentialId, toBuffer(credentialId)))
      .get();
    return row ? toUserKey(row) : null;
  }

  insertKey(input: InsertUserKeyInput): UserKeyRecord {
    this.db
      .insert(userKeys)
      .values({
        id: input.id,
        userId: input.userId,
        credentialId: toBuffer(input.credentialId),
        publicKey: toBuffer(input.publicKey),
        rpId: input.rpId,
        origin: input.origin,
        counter: input.counter,
        transports: input.transports ?? [],
        name: input.name ?? null,
        logSeq: input.logSeq,
        createdAt: input.now,
      })
      .run();
    const created = this.getKeyByCredentialId(input.credentialId);
    if (!created) {
      throw new Error('failed to insert user key');
    }
    return created;
  }

  updateKeyCounter(credentialId: Uint8Array, counter: number): void {
    this.db
      .update(userKeys)
      .set({ counter })
      .where(eq(userKeys.credentialId, toBuffer(credentialId)))
      .run();
  }

  deleteKey(id: string): void {
    this.db.delete(userKeys).where(eq(userKeys.id, id)).run();
  }

  deleteKeysByUser(userId: string): void {
    this.db.delete(userKeys).where(eq(userKeys.userId, userId)).run();
  }

  listCerts(): NodeCertRecord[] {
    return this.db.select().from(nodeCerts).all().map(toNodeCert);
  }

  listCertsByUser(userId: string): NodeCertRecord[] {
    return this.db
      .select()
      .from(nodeCerts)
      .where(eq(nodeCerts.userId, userId))
      .all()
      .map(toNodeCert);
  }

  deleteCertsByUser(userId: string): void {
    this.db.delete(nodeCerts).where(eq(nodeCerts.userId, userId)).run();
  }

  listHubAuthorizationsByUser(userId: string): HubAuthorizationRecord[] {
    return this.db
      .select()
      .from(userHubAuthorizations)
      .where(eq(userHubAuthorizations.userId, userId))
      .all()
      .map(toHubAuthorization);
  }

  getHubAuthorization(userId: string, hubNodeId: string): HubAuthorizationRecord | null {
    const row = this.db
      .select()
      .from(userHubAuthorizations)
      .where(
        and(
          eq(userHubAuthorizations.userId, userId),
          eq(userHubAuthorizations.hubNodeId, hubNodeId)
        )
      )
      .get();
    return row ? toHubAuthorization(row) : null;
  }

  upsertHubAuthorization(input: UpsertHubAuthorizationInput): void {
    this.db
      .insert(userHubAuthorizations)
      .values({
        userId: input.userId,
        hubNodeId: input.hubNodeId,
        status: input.status,
        publicUrl: input.publicUrl ?? null,
        priority: input.priority ?? null,
        admitSeq: input.admitSeq,
        retireSeq: input.retireSeq ?? null,
        updatedSeq: input.updatedSeq,
      })
      .onConflictDoUpdate({
        target: [userHubAuthorizations.userId, userHubAuthorizations.hubNodeId],
        set: {
          status: input.status,
          publicUrl: input.publicUrl ?? null,
          priority: input.priority ?? null,
          admitSeq: input.admitSeq,
          retireSeq: input.retireSeq ?? null,
          updatedSeq: input.updatedSeq,
        },
      })
      .run();
  }

  deleteHubAuthorizationsByUser(userId: string): void {
    this.db.delete(userHubAuthorizations).where(eq(userHubAuthorizations.userId, userId)).run();
  }

  deleteAllPeers(): void {
    this.db.delete(peerCache).run();
  }

  getCert(nodeId: string): NodeCertRecord | null {
    const row = this.db.select().from(nodeCerts).where(eq(nodeCerts.nodeId, nodeId)).get();
    return row ? toNodeCert(row) : null;
  }

  upsertCert(input: UpsertNodeCertInput): void {
    this.db
      .insert(nodeCerts)
      .values({
        nodeId: input.nodeId,
        userId: input.userId,
        admitRecordSeq: input.admitRecordSeq,
        certificateBytes: toBuffer(input.certificateBytes),
        certSig: toBuffer(input.certSig),
        authorizationBytes: toBuffer(input.authorizationBytes),
        authorizationSig: toBuffer(input.authorizationSig),
        revokedLogSeq: input.revokedLogSeq ?? null,
      })
      .onConflictDoUpdate({
        target: nodeCerts.nodeId,
        set: {
          userId: input.userId,
          admitRecordSeq: input.admitRecordSeq,
          certificateBytes: toBuffer(input.certificateBytes),
          certSig: toBuffer(input.certSig),
          authorizationBytes: toBuffer(input.authorizationBytes),
          authorizationSig: toBuffer(input.authorizationSig),
          revokedLogSeq: input.revokedLogSeq ?? null,
        },
      })
      .run();
  }

  markCertRevoked(nodeId: string, revokedLogSeq: number): void {
    this.db.update(nodeCerts).set({ revokedLogSeq }).where(eq(nodeCerts.nodeId, nodeId)).run();
  }

  listPeers(): PeerCacheRecord[] {
    return this.db.select().from(peerCache).all().map(toPeer);
  }

  getPeer(nodeId: string): PeerCacheRecord | null {
    const row = this.db.select().from(peerCache).where(eq(peerCache.nodeId, nodeId)).get();
    return row ? toPeer(row) : null;
  }

  touchPeerLastSeenAt(nodeId: string, lastSeenAt: number): void {
    this.db.update(peerCache).set({ lastSeenAt }).where(eq(peerCache.nodeId, nodeId)).run();
  }

  upsertPeer(input: UpsertPeerCacheInput): void {
    this.db
      .insert(peerCache)
      .values({
        nodeId: input.nodeId,
        name: input.name,
        endpointsJson: input.endpointsJson,
        inventoryJson: input.inventoryJson,
        directCapable: input.directCapable,
        lastSeenAt: input.lastSeenAt,
        listVersion: input.listVersion,
      })
      .onConflictDoUpdate({
        target: peerCache.nodeId,
        set: {
          name: input.name,
          endpointsJson: input.endpointsJson,
          inventoryJson: input.inventoryJson,
          directCapable: input.directCapable,
          lastSeenAt: input.lastSeenAt,
          listVersion: input.listVersion,
        },
      })
      .run();
  }

  deletePeer(nodeId: string): void {
    this.db.delete(peerCache).where(eq(peerCache.nodeId, nodeId)).run();
  }

  getHubMeta(): { nodeId: string; publicUrl: string } | null {
    const row = this.db
      .select()
      .from(peerCache)
      .where(eq(peerCache.nodeId, HUB_META_PEER_ID))
      .get();
    if (!row) return null;
    try {
      const parsed: unknown = JSON.parse(row.inventoryJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.nodeId !== 'string' || obj.nodeId.length === 0) return null;
      if (typeof obj.publicUrl !== 'string' || obj.publicUrl.length === 0) return null;
      return { nodeId: obj.nodeId, publicUrl: obj.publicUrl };
    } catch {
      return null;
    }
  }

  upsertHubMeta(input: {
    nodeId: string;
    publicUrl: string;
    now: number;
    listVersion?: number;
  }): void {
    this.upsertPeer({
      nodeId: HUB_META_PEER_ID,
      name: input.nodeId,
      endpointsJson: JSON.stringify([input.publicUrl]),
      inventoryJson: JSON.stringify({ nodeId: input.nodeId, publicUrl: input.publicUrl }),
      directCapable: false,
      lastSeenAt: input.now,
      listVersion: input.listVersion ?? 0,
    });
  }

  createNode(input: CreateNodeInput): NodeRecord {
    this.db
      .insert(nodes)
      .values({
        id: input.id,
        userId: input.userId,
        name: input.name,
        status: input.status ?? 'enrolled',
        lastSeenAt: input.lastSeenAt ?? null,
        version: input.version ?? null,
        directCapable: input.directCapable ?? false,
        inventoryJson: input.inventoryJson ?? '{}',
        inventoryVersion: input.inventoryVersion ?? 0,
        endpointsJson: input.endpointsJson ?? '[]',
        createdAt: input.now,
      })
      .run();
    const created = this.getNode(input.id);
    if (!created) {
      throw new Error('failed to create node');
    }
    return created;
  }

  getNode(id: string): NodeRecord | null {
    const row = this.db.select().from(nodes).where(eq(nodes.id, id)).get();
    return row ? toNode(row) : null;
  }

  listNodes(): NodeRecord[] {
    return this.db.select().from(nodes).all().map(toNode);
  }

  createEnrollmentToken(input: CreateEnrollmentTokenInput): EnrollmentTokenRecord {
    this.db
      .insert(enrollmentTokens)
      .values({
        id: input.id,
        userId: input.userId,
        enrollPublicKey: toBuffer(input.enrollPublicKey),
        authorizationJson: input.authorizationJson,
        authorizationSig: toBuffer(input.authorizationSig),
        expiresAt: input.expiresAt,
        usedAt: null,
        nodeId: null,
      })
      .run();
    const created = this.getEnrollmentTokenByEnrollPublicKey(input.enrollPublicKey);
    if (!created) {
      throw new Error('failed to create enrollment token');
    }
    return created;
  }

  getEnrollmentTokenByEnrollPublicKey(enrollPublicKey: Uint8Array): EnrollmentTokenRecord | null {
    const row = this.db
      .select()
      .from(enrollmentTokens)
      .where(eq(enrollmentTokens.enrollPublicKey, toBuffer(enrollPublicKey)))
      .get();
    return row ? toEnrollment(row) : null;
  }

  getEnrollmentTokenById(id: string): EnrollmentTokenRecord | null {
    const row = this.db.select().from(enrollmentTokens).where(eq(enrollmentTokens.id, id)).get();
    return row ? toEnrollment(row) : null;
  }

  getEnrollmentTokenByNodeId(nodeId: string): EnrollmentTokenRecord | null {
    const row = this.db
      .select()
      .from(enrollmentTokens)
      .where(eq(enrollmentTokens.nodeId, nodeId))
      .get();
    return row ? toEnrollment(row) : null;
  }

  consumeEnrollmentToken(
    enrollPublicKey: Uint8Array,
    input: { nodeId: string; now: number; authorizationJson?: string }
  ): EnrollmentTokenRecord | null {
    const row = this.db
      .update(enrollmentTokens)
      .set({
        usedAt: input.now,
        nodeId: input.nodeId,
        ...(input.authorizationJson !== undefined
          ? { authorizationJson: input.authorizationJson }
          : {}),
      })
      .where(
        and(
          eq(enrollmentTokens.enrollPublicKey, toBuffer(enrollPublicKey)),
          isNull(enrollmentTokens.usedAt),
          gt(enrollmentTokens.expiresAt, input.now)
        )
      )
      .returning()
      .get();
    return row ? toEnrollment(row) : null;
  }

  markEnrollmentUsed(id: string, input: { nodeId: string; now: number }): void {
    this.db
      .update(enrollmentTokens)
      .set({ usedAt: input.now, nodeId: input.nodeId })
      .where(eq(enrollmentTokens.id, id))
      .run();
  }

  sweepExpiredEnrollmentTokens(now: number): number {
    return this.db
      .delete(enrollmentTokens)
      .where(and(lte(enrollmentTokens.expiresAt, now), isNull(enrollmentTokens.usedAt)))
      .returning({ id: enrollmentTokens.id })
      .all().length;
  }

  invalidateUnusedEnrollmentTokens(userId: string, now: number): number {
    return this.db
      .update(enrollmentTokens)
      .set({ expiresAt: now })
      .where(
        and(
          eq(enrollmentTokens.userId, userId),
          isNull(enrollmentTokens.usedAt),
          gt(enrollmentTokens.expiresAt, now)
        )
      )
      .returning({ id: enrollmentTokens.id })
      .all().length;
  }

  listEnrollmentTokens(): EnrollmentTokenRecord[] {
    return this.db.select().from(enrollmentTokens).all().map(toEnrollment);
  }

  nextEnrollmentTokenRevision(epoch: number): EnrollmentTokenRevision {
    this.ensureTokenReplSchema();
    const sqlite = sqliteOf(this.db);
    const meta = sqlite
      .query('SELECT epoch, seq FROM enrollment_token_repl_meta WHERE id = 1')
      .get() as { epoch: number; seq: number } | null;
    let nextEpoch = epoch;
    let nextSeq = 1;
    if (meta) {
      if (epoch > meta.epoch) {
        nextEpoch = epoch;
        nextSeq = 1;
      } else {
        nextEpoch = meta.epoch;
        nextSeq = meta.seq + 1;
      }
    }
    sqlite.run(
      'INSERT INTO enrollment_token_repl_meta (id, epoch, seq) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET epoch = excluded.epoch, seq = excluded.seq',
      [nextEpoch, nextSeq]
    );
    return { epoch: nextEpoch, seq: nextSeq };
  }

  getEnrollmentTokenRevision(id: string): EnrollmentTokenRevision | null {
    this.ensureTokenReplSchema();
    const row = sqliteOf(this.db)
      .query('SELECT epoch, seq FROM enrollment_token_repl WHERE id = ?')
      .get(id) as { epoch: number; seq: number } | null;
    return row ? { epoch: row.epoch, seq: row.seq } : null;
  }

  applyEnrollmentTokenReplication(
    input: ApplyEnrollmentTokenReplicationInput
  ): ApplyEnrollmentTokenReplicationResult {
    this.ensureTokenReplSchema();
    const id = input.token?.id ?? input.id;
    if (!id) return 'ignored';
    const sqlite = sqliteOf(this.db);
    const existing = sqlite
      .query('SELECT epoch, seq, tombstoned FROM enrollment_token_repl WHERE id = ?')
      .get(id) as { epoch: number; seq: number; tombstoned: number } | null;
    if (existing && compareRepl(input.revision, existing) < 0) return 'ignored';
    if (existing && compareRepl(input.revision, existing) === 0 && existing.tombstoned === 1) {
      return 'ignored';
    }
    if (input.op === 'tombstone') {
      this.db.delete(enrollmentTokens).where(eq(enrollmentTokens.id, id)).run();
      sqlite.run(
        'INSERT INTO enrollment_token_repl (id, epoch, seq, tombstoned) VALUES (?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET epoch = excluded.epoch, seq = excluded.seq, tombstoned = 1',
        [id, input.revision.epoch, input.revision.seq]
      );
      return 'applied';
    }
    const token = input.token;
    if (!token) return 'ignored';
    const current = this.getEnrollmentTokenById(id);
    const usedAt =
      current?.usedAt != null && token.usedAt == null ? current.usedAt : (token.usedAt ?? null);
    const nodeId =
      current?.usedAt != null && token.usedAt == null ? current.nodeId : (token.nodeId ?? null);
    if (current) {
      this.db
        .update(enrollmentTokens)
        .set({
          userId: token.userId,
          enrollPublicKey: toBuffer(token.enrollPublicKey),
          authorizationJson: token.authorizationJson,
          authorizationSig: toBuffer(token.authorizationSig),
          expiresAt: token.expiresAt,
          usedAt,
          nodeId,
        })
        .where(eq(enrollmentTokens.id, id))
        .run();
    } else {
      this.db
        .insert(enrollmentTokens)
        .values({
          id: token.id,
          userId: token.userId,
          enrollPublicKey: toBuffer(token.enrollPublicKey),
          authorizationJson: token.authorizationJson,
          authorizationSig: toBuffer(token.authorizationSig),
          expiresAt: token.expiresAt,
          usedAt,
          nodeId,
        })
        .run();
    }
    sqlite.run(
      'INSERT INTO enrollment_token_repl (id, epoch, seq, tombstoned) VALUES (?, ?, ?, 0) ON CONFLICT(id) DO UPDATE SET epoch = excluded.epoch, seq = excluded.seq, tombstoned = 0',
      [id, input.revision.epoch, input.revision.seq]
    );
    return 'applied';
  }

  private ensureTokenReplSchema(): void {
    const sqlite = sqliteOf(this.db);
    sqlite.run(`
      CREATE TABLE IF NOT EXISTS enrollment_token_repl (
        id TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        tombstoned INTEGER NOT NULL DEFAULT 0
      )
    `);
    sqlite.run(`
      CREATE TABLE IF NOT EXISTS enrollment_token_repl_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        epoch INTEGER NOT NULL,
        seq INTEGER NOT NULL
      )
    `);
  }
}

function compareRepl(
  incoming: EnrollmentTokenRevision,
  stored: { epoch: number; seq: number }
): number {
  if (incoming.epoch !== stored.epoch) return incoming.epoch > stored.epoch ? 1 : -1;
  if (incoming.seq !== stored.seq) return incoming.seq > stored.seq ? 1 : -1;
  return 0;
}

function sqliteOf(db: AuthDb): import('bun:sqlite').Database {
  const client = (db as AuthDb & { $client?: import('bun:sqlite').Database }).$client;
  if (!client) throw new Error('auth db missing sqlite client');
  return client;
}

function toUser(row: typeof users.$inferSelect): UserRecord {
  return {
    id: row.id,
    username: row.username,
    rootPublicKey: toBytes(row.rootPublicKey),
    rootEpoch: row.rootEpoch,
    kdfParamsJson: row.kdfParamsJson,
    totpRecordSeq: row.totpRecordSeq,
    keyLogHeadSeq: row.keyLogHeadSeq,
    keyLogHeadHash: toBytes(row.keyLogHeadHash),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toUserKey(row: typeof userKeys.$inferSelect): UserKeyRecord {
  return {
    id: row.id,
    userId: row.userId,
    credentialId: toBytes(row.credentialId),
    publicKey: toBytes(row.publicKey),
    rpId: row.rpId,
    origin: row.origin,
    counter: row.counter,
    transports: row.transports,
    name: row.name,
    logSeq: row.logSeq,
    createdAt: row.createdAt,
  };
}

function toNodeCert(row: typeof nodeCerts.$inferSelect): NodeCertRecord {
  return {
    nodeId: row.nodeId,
    userId: row.userId,
    admitRecordSeq: row.admitRecordSeq,
    certificateBytes: toBytes(row.certificateBytes),
    certSig: toBytes(row.certSig),
    authorizationBytes: toBytes(row.authorizationBytes),
    authorizationSig: toBytes(row.authorizationSig),
    revokedLogSeq: row.revokedLogSeq,
  };
}

function toHubAuthorization(
  row: typeof userHubAuthorizations.$inferSelect
): HubAuthorizationRecord {
  return {
    userId: row.userId,
    hubNodeId: row.hubNodeId,
    status: row.status === 'retired' ? 'retired' : 'active',
    publicUrl: row.publicUrl,
    priority: row.priority,
    admitSeq: row.admitSeq,
    retireSeq: row.retireSeq,
    updatedSeq: row.updatedSeq,
  };
}

function toPeer(row: typeof peerCache.$inferSelect): PeerCacheRecord {
  return {
    nodeId: row.nodeId,
    name: row.name,
    endpointsJson: row.endpointsJson,
    inventoryJson: row.inventoryJson,
    directCapable: row.directCapable,
    lastSeenAt: row.lastSeenAt,
    listVersion: row.listVersion,
  };
}

function toNode(row: typeof nodes.$inferSelect): NodeRecord {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    status: row.status as NodeStatus,
    lastSeenAt: row.lastSeenAt,
    version: row.version,
    directCapable: row.directCapable,
    inventoryJson: row.inventoryJson,
    inventoryVersion: row.inventoryVersion,
    endpointsJson: row.endpointsJson,
    createdAt: row.createdAt,
  };
}

function toEnrollment(row: typeof enrollmentTokens.$inferSelect): EnrollmentTokenRecord {
  return {
    id: row.id,
    userId: row.userId,
    enrollPublicKey: toBytes(row.enrollPublicKey),
    authorizationJson: row.authorizationJson,
    authorizationSig: toBytes(row.authorizationSig),
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    nodeId: row.nodeId,
  };
}
