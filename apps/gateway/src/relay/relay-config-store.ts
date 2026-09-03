import type { RelayQuota } from '@tmex/shared/relay';
import { eq } from 'drizzle-orm';
import type { AuthDb } from '../auth/types';
import { relayConfig } from '../db/schema';
import { defaultRelayQuota, parseRelayQuotaJson, serializeRelayQuota } from './relay-quota';

export type RelayConfigRecord = {
  passwordHash: string | null;
  passwordEpoch: number;
  minTokenEpoch: number;
  adminTokenHash: string | null;
  defaultQuota: RelayQuota;
  updatedAt: number;
};

export class RelayConfigStore {
  constructor(private readonly db: AuthDb) {}

  /** 首次读取时补齐单例行；默认配额缺失或损坏时回落到内置默认值。 */
  ensure(now: number): RelayConfigRecord {
    const existing = this.read();
    if (existing) return existing;
    const quota = defaultRelayQuota();
    this.db
      .insert(relayConfig)
      .values({
        id: 1,
        passwordHash: null,
        passwordEpoch: 0,
        minTokenEpoch: 0,
        adminTokenHash: null,
        defaultQuotaJson: serializeRelayQuota(quota),
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
    return (
      this.read() ?? {
        passwordHash: null,
        passwordEpoch: 0,
        minTokenEpoch: 0,
        adminTokenHash: null,
        defaultQuota: quota,
        updatedAt: now,
      }
    );
  }

  read(): RelayConfigRecord | null {
    const row = this.db.select().from(relayConfig).where(eq(relayConfig.id, 1)).get();
    if (!row) return null;
    return {
      passwordHash: row.passwordHash,
      passwordEpoch: row.passwordEpoch,
      minTokenEpoch: row.minTokenEpoch,
      adminTokenHash: row.adminTokenHash,
      defaultQuota: parseRelayQuotaJson(row.defaultQuotaJson) ?? defaultRelayQuota(),
      updatedAt: row.updatedAt,
    };
  }

  setAdminTokenHash(hash: string | null, now: number): void {
    this.db
      .update(relayConfig)
      .set({ adminTokenHash: hash, updatedAt: now })
      .where(eq(relayConfig.id, 1))
      .run();
  }

  setDefaultQuota(quota: RelayQuota, now: number): void {
    this.db
      .update(relayConfig)
      .set({ defaultQuotaJson: serializeRelayQuota(quota), updatedAt: now })
      .where(eq(relayConfig.id, 1))
      .run();
  }

  /** 改口令：epoch 递增；`kick` 时同步把 min_token_epoch 抬到新 epoch。 */
  rotatePassword(input: {
    passwordHash: string | null;
    kick: boolean;
    now: number;
  }): RelayConfigRecord {
    const current = this.ensure(input.now);
    const passwordEpoch = current.passwordEpoch + 1;
    const minTokenEpoch = input.kick ? passwordEpoch : current.minTokenEpoch;
    this.db
      .update(relayConfig)
      .set({
        passwordHash: input.passwordHash,
        passwordEpoch,
        minTokenEpoch,
        updatedAt: input.now,
      })
      .where(eq(relayConfig.id, 1))
      .run();
    return { ...current, passwordHash: input.passwordHash, passwordEpoch, minTokenEpoch };
  }
}
