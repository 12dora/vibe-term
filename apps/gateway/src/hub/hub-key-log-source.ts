import { decodeKeyLogRecord } from '@tmex/shared/auth';
import type { KeyLogStore } from '../auth/key-log-store';
import type { UserKeyService } from '../auth/user-key-service';
import type { HubKeyLogAppendResult, HubKeyLogSource } from './types';

const ZERO_HASH = new Uint8Array(32);

export function createHubKeyLogSource(
  service: UserKeyService,
  keyLogStore: KeyLogStore
): HubKeyLogSource {
  return {
    async head(userId: string): Promise<{ seq: bigint; hash: Uint8Array }> {
      return keyLogStore.head(userId) ?? { seq: 0n, hash: ZERO_HASH };
    },
    async list(
      userId: string,
      fromSeq?: bigint,
      limit?: number
    ): Promise<{ seq: bigint; bytes: Uint8Array; sig: Uint8Array }[]> {
      const from = fromSeq === undefined ? undefined : Number(fromSeq);
      return keyLogStore.list(userId, from, limit).map((r) => ({
        seq: BigInt(r.seq),
        bytes: r.bytes,
        sig: r.sig,
      }));
    },
    async append(
      userId: string,
      record: { bytes: Uint8Array; sig: Uint8Array }
    ): Promise<HubKeyLogAppendResult> {
      const result = await service.apply(userId, record);
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      const decoded = decodeKeyLogRecord(record.bytes);
      return {
        ok: true,
        seq: decoded.seq,
        hash: result.hash,
        effects: result.effects,
        record: { type: decoded.type, payload: decoded.payload },
      };
    },
  };
}
