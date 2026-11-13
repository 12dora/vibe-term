import { describe, expect, test } from 'bun:test';
import {
  encodeAdmitNodePayload,
  encodeRevokeNodePayload,
  encodeRotateRootKeepPayload,
  generateKdfParams,
  type rootKeyFromSeed,
} from '@vibeterm/shared/auth';
import { agentPaneGrants, shareAccessTokens } from '../db/schema';
import { PortMapExportStore, PortMapStore } from '../portmap/store';
import type { PortMapRow } from '../portmap/types';
import { createShareService } from '../share/share-service';
import { ShareStore } from '../share/share-store';
import type { ShareEndedEvent } from '../share/types';
import { AccessTokenService } from './access-tokens';
import { KeyLogStore } from './key-log-store';
import { ensureNodeIdentity, selfSignedNodeCertificate } from './node-identity-service';
import { NodeIdentityStore } from './node-identity-store';
import { NodeSessionStore } from './node-session-store';
import { createMigratedAuthDb } from './test-db';
import type { AuthDb } from './types';
import { UserKeyService } from './user-key-service';
import { UserStore } from './user-store';

const OTHER_NODE = 'c'.repeat(32);

type Boot = { userId: string; rootKey: ReturnType<typeof rootKeyFromSeed>; rootEpoch: number };

function setup() {
  const { db, close } = createMigratedAuthDb();
  const sessions = new NodeSessionStore(db);
  const service = new UserKeyService({
    db,
    userStore: new UserStore(db),
    keyLogStore: new KeyLogStore(db),
    nodeSessionStore: sessions,
  });
  const tokens = new AccessTokenService(db);
  const shareStore = new ShareStore(db);
  const shares = createShareService({
    store: shareStore,
    deviceExists: () => true,
    snapshotOf: () => null,
    autoStartRecorders: false,
    watchIntervalMs: 3_600_000,
    retentionSweepMs: 3_600_000,
  });
  const ended: ShareEndedEvent[] = [];
  shares.onEnded((event) => ended.push(event));
  shares.startSweeper();
  return {
    db,
    sessions,
    service,
    tokens,
    shareStore,
    ended,
    close: async () => {
      await shares.stop();
      close();
    },
  };
}

function seedSession(sessions: NodeSessionStore, userId: string, viaNodeId: string): string {
  return sessions.issue({
    userId,
    viaNodeId,
    sessPublicKey: crypto.getRandomValues(new Uint8Array(32)),
    delegationMethod: 'root',
    now: Date.now(),
  }).sid;
}

function sessionAlive(sessions: NodeSessionStore, sid: string, viaNodeId: string): boolean {
  return sessions.verify(sid, { viaNodeId, now: Date.now() }).ok;
}

function seedShare(store: ShareStore, id: string, issuedVia: string): void {
  const now = Date.now();
  store.insert({
    id,
    name: id,
    deviceId: 'dev-1',
    windowId: '@1',
    windowName: 'main',
    state: 'active',
    endReason: null,
    origin: 'https://example.com',
    url: `https://example.com/share/${id}`,
    recordLog: false,
    logBytes: 0,
    logTruncated: false,
    logSeq: 0,
    logPurgedAt: null,
    createdAt: now,
    expiresAt: null,
    endedAt: null,
    issuedVia,
    passwordHash: 'hash',
  });
  store.createAccessToken({
    id: `acc-${id}`,
    shareId: id,
    tokenHash: `token-${id}`,
    clientIp: null,
    createdAt: now,
    expiresAt: now + 3_600_000,
  });
}

function seedGrant(db: AuthDb, id: string, fromNodeId: string, issuedVia: string): void {
  db.insert(agentPaneGrants)
    .values({
      id,
      tokenHash: 'hash',
      fromNodeId,
      deviceId: 'dev-1',
      paneId: '%1',
      serverEpoch: 'e'.repeat(32),
      createdAt: 1,
      lastUsedAt: 1,
      expiresAt: Date.now() + 86_400_000,
      issuedVia,
    })
    .run();
}

function mapRow(id: string, issuedVia: string): PortMapRow {
  return {
    id,
    name: id,
    listenHost: '127.0.0.1',
    listenPort: 15_432,
    targetNodeId: OTHER_NODE,
    targetHost: '127.0.0.1',
    targetPort: 5432,
    paused: false,
    createdAt: 1,
    updatedAt: 1,
    issuedVia,
  };
}

function grantIds(db: AuthDb): string[] {
  return db
    .select({ id: agentPaneGrants.id })
    .from(agentPaneGrants)
    .all()
    .map((row) => row.id)
    .sort();
}

function shareAccessIds(db: AuthDb): string[] {
  return db
    .select({ id: shareAccessTokens.id })
    .from(shareAccessTokens)
    .all()
    .map((row) => row.id)
    .sort();
}

function mintToken(tokens: AccessTokenService, userId: string, issuedVia?: string) {
  return tokens.create(
    userId,
    { name: 'ci', scopes: ['exec', 'forward'], expiresInDays: null },
    null,
    issuedVia
  );
}

async function admitSelf(db: AuthDb, service: UserKeyService, boot: Boot) {
  const identity = await ensureNodeIdentity(new NodeIdentityStore(db));
  const admit = await selfSignedNodeCertificate(identity, boot.rootKey, {
    uid: boot.userId,
    rootEpoch: boot.rootEpoch,
    now: Date.now(),
  });
  const applied = await service.signAndApply(boot.userId, boot.rootKey, {
    type: 'admit-node',
    payload: encodeAdmitNodePayload(admit),
  });
  expect(applied.ok).toBe(true);
  return identity;
}

describe('key log 吊销级联', () => {
  test('revoke-node X：经 X 签发的令牌、分享、窗格授权、端口映射一并作废，本机签发的不动', async () => {
    const env = setup();
    try {
      const boot = await env.service.bootstrapUser({ username: 'cascade-node', password: 'pw' });
      const identity = await admitSelf(env.db, env.service, boot);
      const entry = identity.nodeIdHex;

      const sidVia = seedSession(env.sessions, boot.userId, entry);
      const sidSelf = seedSession(env.sessions, boot.userId, 'self');
      const tokenVia = mintToken(env.tokens, boot.userId, entry);
      const tokenSelf = mintToken(env.tokens, boot.userId);
      seedShare(env.shareStore, 'share-via', entry);
      seedShare(env.shareStore, 'share-self', 'self');
      seedGrant(env.db, 'g-held', entry, 'self');
      seedGrant(env.db, 'g-issued', OTHER_NODE, entry);
      seedGrant(env.db, 'g-keep', OTHER_NODE, 'self');
      const maps = new PortMapStore(env.db);
      const exports = new PortMapExportStore(env.db);
      maps.insert(mapRow('map-via', entry));
      maps.insert(mapRow('map-self', 'self'));
      const exportBase = { host: '10.0.0.5', port: 22, enabled: true, createdAt: 1 };
      exports.insert({ ...exportBase, mapId: 'exp-via', fromNodeId: OTHER_NODE, issuedVia: entry });
      exports.insert({ ...exportBase, mapId: 'exp-from', fromNodeId: entry });
      exports.insert({ ...exportBase, mapId: 'exp-self', fromNodeId: OTHER_NODE });

      const revoked = await env.service.signAndApply(boot.userId, boot.rootKey, {
        type: 'revoke-node',
        payload: encodeRevokeNodePayload({ node_id: identity.nodeId, reason: 'lost' }),
      });
      expect(revoked.ok).toBe(true);

      expect(sessionAlive(env.sessions, sidVia, entry)).toBe(false);
      expect(sessionAlive(env.sessions, sidSelf, 'self')).toBe(true);
      expect(env.tokens.verify(tokenVia.secret)).toEqual({ ok: false, reason: 'revoked' });
      expect(env.tokens.verify(tokenSelf.secret).ok).toBe(true);
      expect(env.shareStore.get('share-via')).toMatchObject({
        state: 'ended',
        endReason: 'revoked',
      });
      expect(env.shareStore.get('share-self')?.state).toBe('active');
      expect(env.ended).toEqual([{ shareId: 'share-via', reason: 'revoked' }]);
      expect(shareAccessIds(env.db)).toEqual(['acc-share-self']);
      expect(grantIds(env.db)).toEqual(['g-keep']);
      expect(maps.list().map((row) => row.id)).toEqual(['map-self']);
      expect(exports.list().map((row) => row.mapId)).toEqual(['exp-self']);
    } finally {
      await env.close();
    }
  });

  test('rotate-root-keep（默认改密）：全部会话、令牌、窗格授权、分享作废', async () => {
    const env = setup();
    try {
      const boot = await env.service.bootstrapUser({ username: 'cascade-keep', password: 'pw' });
      const sidSelf = seedSession(env.sessions, boot.userId, 'self');
      const sidVia = seedSession(env.sessions, boot.userId, OTHER_NODE);
      const tokenSelf = mintToken(env.tokens, boot.userId);
      const tokenVia = mintToken(env.tokens, boot.userId, OTHER_NODE);
      seedShare(env.shareStore, 'share-a', 'self');
      seedShare(env.shareStore, 'share-b', OTHER_NODE);
      seedGrant(env.db, 'g-a', OTHER_NODE, 'self');
      seedGrant(env.db, 'g-b', OTHER_NODE, OTHER_NODE);
      const maps = new PortMapStore(env.db);
      maps.insert(mapRow('map-session', 'self'));

      const nextRoot = crypto.getRandomValues(new Uint8Array(32));
      const rotated = await env.service.signAndApply(boot.userId, boot.rootKey, {
        type: 'rotate-root-keep',
        payload: encodeRotateRootKeepPayload({
          root_public_key: nextRoot,
          kdf_params: generateKdfParams(),
          totp: null,
        }),
      });
      expect(rotated.ok).toBe(true);
      if (rotated.ok) expect(rotated.effects).toEqual([{ type: 'revokeAllSessions' }]);

      expect(sessionAlive(env.sessions, sidSelf, 'self')).toBe(false);
      expect(sessionAlive(env.sessions, sidVia, OTHER_NODE)).toBe(false);
      expect(env.tokens.verify(tokenSelf.secret)).toEqual({ ok: false, reason: 'revoked' });
      expect(env.tokens.verify(tokenVia.secret)).toEqual({ ok: false, reason: 'revoked' });
      expect(env.shareStore.listActive()).toEqual([]);
      expect(env.ended.map((event) => event.shareId).sort()).toEqual(['share-a', 'share-b']);
      expect(shareAccessIds(env.db)).toEqual([]);
      expect(grantIds(env.db)).toEqual([]);
      expect(maps.list().map((row) => row.id)).toEqual(['map-session']);
    } finally {
      await env.close();
    }
  });
});
