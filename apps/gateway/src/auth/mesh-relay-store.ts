import type { UserKeyState } from '@vibeterm/shared/auth';
import {
  applyRelayKeyLogRecord,
  decodeKeyLogRecord,
  emptyUserKeyState,
} from '@vibeterm/shared/auth';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { decryptWithContext, encrypt } from '../crypto';
import { meshRelays, meshSecrets, nodeIdentity, userKeyLog } from '../db/schema';
import type { AuthDb } from './types';

const IDENTITY_ROW_ID = 1;
export const RELAY_LOG_KEY_EPOCH = 0;
const RELAY_RECORD_TYPES = ['set-relays', 'meta-key'] as const;

export type UplinkKind = 'hub' | 'relay';
export type MeshSecretKind = 'log' | 'meta';

export type StoredMeshRelayRow = {
  url: string;
  tenantId: string;
  priority: number;
  kicked: boolean;
  /** 中继给出的踢出原因；`password_rotated` 表示只是令牌换代，等新的 `set-relays` 即可。 */
  kickedReason: string | null;
};

export type StoredMeshRelay = StoredMeshRelayRow & { token: Uint8Array };

export type ReplaceMeshRelayInput = {
  url: string;
  tenantId: string;
  token: Uint8Array;
  priority: number;
};

/**
 * 节点侧中继目标与租户密钥的落库层。token / 密钥都用主密钥加密后存储，
 * 与 `node_identity` 的私钥同一套 `crypto` 助手。
 */
export class MeshRelayStore {
  constructor(private readonly db: AuthDb) {}

  /** 同步读；`UplinkPool.candidates()` 是同步接口，只需要 url/priority。 */
  listRelayRows(): StoredMeshRelayRow[] {
    return this.db
      .select()
      .from(meshRelays)
      .orderBy(asc(meshRelays.priority))
      .all()
      .map((row) => ({
        url: row.url,
        tenantId: row.tenantId,
        priority: row.priority,
        kicked: row.kicked,
        kickedReason: row.kickedReason,
      }));
  }

  async getRelay(url: string): Promise<StoredMeshRelay | null> {
    const row = this.db.select().from(meshRelays).where(eq(meshRelays.url, url)).get();
    if (!row) return null;
    return {
      url: row.url,
      tenantId: row.tenantId,
      priority: row.priority,
      kicked: row.kicked,
      kickedReason: row.kickedReason,
      token: await decryptBytes(row.tokenEnc, 'relay_token', row.url),
    };
  }

  async replaceRelays(relays: readonly ReplaceMeshRelayInput[], now: number): Promise<void> {
    const rows = await Promise.all(
      relays.map(async (relay) => ({
        url: relay.url,
        tenantId: relay.tenantId,
        tokenEnc: await encryptBytes(relay.token),
        priority: relay.priority,
        kicked: false,
        kickedReason: null,
        updatedAt: now,
      }))
    );
    // 整表替换：新的 set-relays 意味着令牌重新签发，被踢标记随之清零
    this.db.delete(meshRelays).run();
    for (const row of rows) this.db.insert(meshRelays).values(row).run();
  }

  /**
   * 只换某一条中继的租户令牌，其余行不动（令牌换发后给成员补发的场景）。
   * 行不存在时补一条排在最后——成员可能因为一直连不上而没收到过任何 `set-relays`。
   */
  async setRelayToken(input: {
    url: string;
    tenantId: string;
    token: Uint8Array;
    now: number;
  }): Promise<void> {
    const tokenEnc = await encryptBytes(input.token);
    const existing = this.db.select().from(meshRelays).where(eq(meshRelays.url, input.url)).get();
    if (!existing) {
      const priority = this.listRelayRows().length;
      this.db
        .insert(meshRelays)
        .values({
          url: input.url,
          tenantId: input.tenantId,
          tokenEnc,
          priority,
          kicked: false,
          kickedReason: null,
          updatedAt: input.now,
        })
        .run();
      return;
    }
    this.db
      .update(meshRelays)
      .set({
        tenantId: input.tenantId,
        tokenEnc,
        kicked: false,
        kickedReason: null,
        updatedAt: input.now,
      })
      .where(eq(meshRelays.url, input.url))
      .run();
  }

  markKicked(url: string, kicked: boolean, reason?: string | null): void {
    this.db
      .update(meshRelays)
      .set({ kicked, kickedReason: kicked ? (reason ?? null) : null })
      .where(eq(meshRelays.url, url))
      .run();
  }

  clearRelays(): void {
    this.db.delete(meshRelays).run();
  }

  async putSecret(
    kind: MeshSecretKind,
    epoch: number,
    key: Uint8Array,
    now: number
  ): Promise<void> {
    const keyEnc = await encryptBytes(key);
    this.db
      .insert(meshSecrets)
      .values({ kind, epoch, keyEnc, createdAt: now })
      .onConflictDoUpdate({
        target: [meshSecrets.kind, meshSecrets.epoch],
        set: { keyEnc, createdAt: now },
      })
      .run();
  }

  async getSecret(kind: MeshSecretKind, epoch: number): Promise<Uint8Array | null> {
    const row = this.db
      .select()
      .from(meshSecrets)
      .where(and(eq(meshSecrets.kind, kind), eq(meshSecrets.epoch, epoch)))
      .get();
    if (!row) return null;
    return decryptBytes(row.keyEnc, 'mesh_secret', `${kind}:${epoch}`);
  }

  listSecretEpochs(kind: MeshSecretKind): number[] {
    return this.db
      .select()
      .from(meshSecrets)
      .where(eq(meshSecrets.kind, kind))
      .orderBy(asc(meshSecrets.epoch))
      .all()
      .map((row) => row.epoch);
  }

  clearSecrets(): void {
    this.db.delete(meshSecrets).run();
  }

  uplinkKind(): UplinkKind {
    const row = this.db
      .select()
      .from(nodeIdentity)
      .where(eq(nodeIdentity.id, IDENTITY_ROW_ID))
      .get();
    return row?.uplinkKind === 'relay' ? 'relay' : 'hub';
  }

  setUplinkKind(kind: UplinkKind): void {
    this.db
      .update(nodeIdentity)
      .set({ uplinkKind: kind })
      .where(eq(nodeIdentity.id, IDENTITY_ROW_ID))
      .run();
  }

  localName(): string | null {
    const row = this.db
      .select()
      .from(nodeIdentity)
      .where(eq(nodeIdentity.id, IDENTITY_ROW_ID))
      .get();
    const name = row?.name?.trim() ?? '';
    return name || null;
  }

  setLocalName(name: string | null): void {
    const next = name?.trim() ?? '';
    this.db
      .update(nodeIdentity)
      .set({ name: next || null })
      .where(eq(nodeIdentity.id, IDENTITY_ROW_ID))
      .run();
  }
}

export type RelayKeyLogProjection = Pick<
  UserKeyState,
  'relays' | 'metaKeyEpoch' | 'metaKeyEntries'
>;

/**
 * `UserKeyService.currentState()` 从落库结果重建状态，中继三个字段没有单独的投影表，
 * 直接重放密钥日志里的 `set-relays` / `meta-key`（两类记录极少，按 type 过滤后按 seq 回放）。
 */
export function applyRelayRecordsFromKeyLog(db: AuthDb, userId: string, state: UserKeyState): void {
  const rows = db
    .select()
    .from(userKeyLog)
    .where(and(eq(userKeyLog.userId, userId), inArray(userKeyLog.type, [...RELAY_RECORD_TYPES])))
    .orderBy(asc(userKeyLog.seq))
    .all();
  for (const row of rows) {
    try {
      const record = decodeKeyLogRecord(new Uint8Array(row.recordBytes));
      applyRelayKeyLogRecord(state, record);
    } catch {
      // 损坏的历史记录不应让整个状态读取失败
    }
  }
}

/** 只要中继三个字段时的轻量投影，不读用户表。 */
export function projectRelayKeyLogState(db: AuthDb, userId: string): RelayKeyLogProjection {
  const state = emptyUserKeyState(new Uint8Array(32));
  applyRelayRecordsFromKeyLog(db, userId, state);
  return {
    relays: state.relays,
    metaKeyEpoch: state.metaKeyEpoch,
    metaKeyEntries: state.metaKeyEntries,
  };
}

async function encryptBytes(bytes: Uint8Array): Promise<string> {
  return encrypt(Buffer.from(bytes).toString('base64'));
}

async function decryptBytes(
  ciphertext: string,
  field: 'relay_token' | 'mesh_secret',
  entityId: string
): Promise<Uint8Array> {
  const encoded = await decryptWithContext(ciphertext, {
    scope: 'mesh_relay',
    entityId,
    field,
  });
  return Uint8Array.from(Buffer.from(encoded, 'base64'));
}
