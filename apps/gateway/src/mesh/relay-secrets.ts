import { createHash } from 'node:crypto';
import type { StoredRelayList } from '@vibeterm/shared/auth';
import { encodeBase64url } from '@vibeterm/shared/auth';
import { type WrapEntry, findWrapEntry, unwrapKeyForNode } from '@vibeterm/shared/relay';
import {
  MeshRelayStore,
  RELAY_LOG_KEY_EPOCH,
  type RelayKeyLogProjection,
  type StoredMeshRelayRow,
  type UplinkKind,
  projectRelayKeyLogState,
} from '../auth/mesh-relay-store';
import type { AuthDb } from '../auth/types';
import { stamp } from './mesh-log';
import {
  orderRelaysByPreferred,
  readPreferredRelayUrl,
  writePreferredRelayUrl,
} from './relay-preferred';

export const RELAY_PENDING_KEY_TTL_MS = 10 * 60 * 1000;
export const RELAY_PENDING_KEY_LIMIT = 8;

export type PendingRelayKeys = {
  /** 首次接入中继时新生成的 K_log；后续 rotate 只带 K_meta。 */
  logKey?: Uint8Array;
  metaKey: Uint8Array;
  epoch: number;
};

export type RelayReconcileResult = {
  kind: UplinkKind;
  /** 池会选中的那条主中继（url/tenantId/token）变了，或 hub↔relay 翻转，必须重建 uplink 池。 */
  primaryChanged: boolean;
  /** 只有 secondary 行增删或优先级重排，主链路不受影响。 */
  rowsChanged: boolean;
  /** `primaryChanged || rowsChanged`，保留给只关心「有无变化」的调用方。 */
  targetsChanged: boolean;
  metaEpoch: number;
};

type RelayTargetsFingerprint = {
  primary: string;
  rows: string;
  rowKeys: Set<string>;
};

function relayRowKey(relay: StoredRelayList['relays'][number], kind: UplinkKind): string {
  const token = createHash('sha256').update(relay.token).digest('base64url');
  return `${kind}|${relay.url}|${relay.tenantId}|${token}`;
}

export type RelaySecretsOptions = {
  db: AuthDb;
  store?: MeshRelayStore;
  identity: { nodeIdHex: string; x25519PrivateKey: Uint8Array };
  userIdOf: () => string;
  now?: () => number;
};

/**
 * 把密钥日志投影出的中继列表/租户密钥落到 `mesh_relays` 与 `mesh_secrets`，
 * 并在内存里缓存解出的 K_log / K_meta 供 uplink 使用。
 */
export class RelaySecrets {
  readonly store: MeshRelayStore;

  private readonly db: AuthDb;
  private readonly identity: { nodeIdHex: string; x25519PrivateKey: Uint8Array };
  private readonly userIdOf: () => string;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingRelayKeys & { createdAt: number }>();
  private readonly metaCache = new Map<number, Uint8Array>();
  private logKeyCache: Uint8Array | null = null;
  private metaEpoch = 0;
  private lastPrimaryKey = '';
  private lastRowsKey = '';

  constructor(opts: RelaySecretsOptions) {
    this.db = opts.db;
    this.store = opts.store ?? new MeshRelayStore(opts.db);
    this.identity = opts.identity;
    this.userIdOf = opts.userIdOf;
    this.now = opts.now ?? Date.now;
  }

  projection(): RelayKeyLogProjection {
    const userId = this.userIdOf();
    if (!userId) return { relays: null, metaKeyEpoch: 0, metaKeyEntries: [] };
    return projectRelayKeyLogState(this.db, userId);
  }

  currentMetaEpoch(): number {
    return this.metaEpoch;
  }

  uplinkKind(): UplinkKind {
    return this.store.uplinkKind();
  }

  relayRows(): StoredMeshRelayRow[] {
    return this.store.listRelayRows();
  }

  preferredRelayUrl(): string | null {
    return readPreferredRelayUrl(this.db);
  }

  setPreferredRelayUrl(url: string): void {
    writePreferredRelayUrl(this.db, url);
  }

  tenantId(): string | null {
    return this.store.listRelayRows()[0]?.tenantId ?? null;
  }

  userId(): string {
    return this.userIdOf();
  }

  /** 供 `/api/mesh/relay/enroll` 与 `meta-key/prepare` 暂存尚未签名落账的新密钥。 */
  stashPendingKeys(payloadHash: Uint8Array, keys: PendingRelayKeys): string {
    const id = encodeBase64url(payloadHash);
    this.sweepPending();
    if (this.pending.size >= RELAY_PENDING_KEY_LIMIT) {
      const oldest = [...this.pending.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (oldest) this.pending.delete(oldest[0]);
    }
    this.pending.set(id, { ...keys, createdAt: this.now() });
    return id;
  }

  async logKey(): Promise<Uint8Array | null> {
    if (this.logKeyCache) return this.logKeyCache;
    const stored = await this.store.getSecret('log', RELAY_LOG_KEY_EPOCH);
    if (stored) this.logKeyCache = stored;
    return stored;
  }

  async metaKey(epoch: number): Promise<Uint8Array | null> {
    const cached = this.metaCache.get(epoch);
    if (cached) return cached;
    const stored = await this.store.getSecret('meta', epoch);
    if (stored) this.metaCache.set(epoch, stored);
    return stored;
  }

  async currentMetaKey(): Promise<{ key: Uint8Array; epoch: number } | null> {
    if (this.metaEpoch <= 0) return null;
    const key = await this.metaKey(this.metaEpoch);
    return key ? { key, epoch: this.metaEpoch } : null;
  }

  /**
   * 重放密钥日志投影 → 写 `mesh_relays` / `mesh_secrets` / `node_identity.uplink_kind`。
   * 记录应用后与进程启动时各调用一次；返回是否需要重建 uplink 池。
   */
  async reconcile(): Promise<RelayReconcileResult> {
    const projection = this.projection();
    const now = this.now();
    await this.absorbKeys(projection, now);
    const kind: UplinkKind = projection.relays ? 'relay' : 'hub';
    await this.writeTargets(projection.relays, now);
    if (this.store.uplinkKind() !== kind) this.store.setUplinkKind(kind);
    const print = this.targetsFingerprint(projection.relays, kind);
    // 主中继行原样还在（只是被新的 preferred / priority 挤下第一位）时不算主链路变化：
    // 池此刻连的就是它，重启只会白白排空在途流，让 nearest-switch 自己决定要不要 promote。
    const primaryChanged =
      print.primary !== this.lastPrimaryKey && !print.rowKeys.has(this.lastPrimaryKey);
    const rowsChanged = print.rows !== this.lastRowsKey;
    this.lastPrimaryKey = print.primary;
    this.lastRowsKey = print.rows;
    return {
      kind,
      primaryChanged,
      rowsChanged,
      targetsChanged: primaryChanged || rowsChanged,
      metaEpoch: this.metaEpoch,
    };
  }

  private targetsFingerprint(
    list: StoredRelayList | null,
    kind: UplinkKind
  ): RelayTargetsFingerprint {
    const relays = list ? [...list.relays].sort((a, b) => a.priority - b.priority) : [];
    const keyed = relays.map((relay) => ({ url: relay.url, key: relayRowKey(relay, kind) }));
    const preferredFirst = orderRelaysByPreferred(keyed, this.preferredRelayUrl());
    return {
      primary: preferredFirst[0]?.key ?? `${kind}|`,
      rows: `${kind}|${relays.map((relay, i) => `${relay.priority}:${keyed[i]?.key ?? ''}`).join(',')}`,
      rowKeys: new Set(keyed.map((row) => row.key)),
    };
  }

  private async writeTargets(list: StoredRelayList | null, now: number): Promise<void> {
    if (!list || list.relays.length === 0) {
      this.store.clearRelays();
      return;
    }
    await this.store.replaceRelays(
      [...list.relays]
        .sort((a, b) => a.priority - b.priority)
        .map((relay) => ({
          url: relay.url,
          tenantId: relay.tenantId,
          token: relay.token,
          priority: relay.priority,
        })),
      now
    );
  }

  private async absorbKeys(projection: RelayKeyLogProjection, now: number): Promise<void> {
    const logEntries = projection.relays?.logKeyEntries ?? [];
    if (projection.relays && !(await this.logKey())) {
      const key = await this.openEntry(logEntries, projection.metaKeyEpoch, 'log');
      if (key) {
        this.logKeyCache = key;
        await this.store.putSecret('log', RELAY_LOG_KEY_EPOCH, key, now);
      }
    }
    const epoch = projection.metaKeyEpoch;
    if (epoch > 0) {
      if (!(await this.metaKey(epoch))) {
        const key = await this.openEntry(projection.metaKeyEntries, epoch, 'meta');
        if (key) {
          this.metaCache.set(epoch, key);
          await this.store.putSecret('meta', epoch, key, now);
        } else {
          console.warn(
            stamp(`[relay] meta key epoch=${epoch} not addressed to this node; staying read-only`)
          );
        }
      }
      if (await this.metaKey(epoch)) this.metaEpoch = epoch;
    }
  }

  private async openEntry(
    entries: readonly WrapEntry[],
    epoch: number,
    kind: 'log' | 'meta'
  ): Promise<Uint8Array | null> {
    const entry = findWrapEntry(entries, this.identity.nodeIdHex);
    if (entry) {
      try {
        return await unwrapKeyForNode({
          entry,
          nodeX25519Sk: this.identity.x25519PrivateKey,
        });
      } catch {
        console.warn(stamp(`[relay] ${kind} key unwrap failed epoch=${epoch}`));
      }
    }
    return this.takePending(kind, epoch);
  }

  private takePending(kind: 'log' | 'meta', epoch: number): Uint8Array | null {
    this.sweepPending();
    for (const held of this.pending.values()) {
      if (kind === 'meta' && held.epoch !== epoch) continue;
      const key = kind === 'log' ? held.logKey : held.metaKey;
      if (key) return key;
    }
    return null;
  }

  private sweepPending(): void {
    const cutoff = this.now() - RELAY_PENDING_KEY_TTL_MS;
    for (const [id, held] of this.pending) {
      if (held.createdAt < cutoff) this.pending.delete(id);
    }
  }
}
