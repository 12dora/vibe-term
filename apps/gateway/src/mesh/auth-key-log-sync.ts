import {
  applyKeyLogRecord,
  bytesEqual,
  computeRecordHash,
  decodeKeyLogRecord,
  verifyKeyLogRecord,
} from '@vibeterm/shared/auth';
import { makeDeferredVerifyPasskeyAssertion } from '../auth/passkey';
import type { AuthRoutesDeps } from './auth-routes';
import type { KeyLogHubAck } from './mesh-deps';

export class AuthKeyLogSync {
  constructor(private readonly deps: AuthRoutesDeps) {}

  identicalAppliedRecord(
    userId: string,
    bytes: Uint8Array,
    sig: Uint8Array
  ): { seq: number; hash: Uint8Array } | null {
    try {
      const record = decodeKeyLogRecord(bytes);
      const state = this.deps.keyLogService.currentState(userId);
      const hash = computeRecordHash(bytes, sig);
      if (state.head.seq === record.seq && bytesEqual(state.head.hash, hash)) {
        return { seq: Number(record.seq), hash };
      }
    } catch {
      return null;
    }
    return null;
  }

  async previewKeyLog(
    userId: string,
    bytes: Uint8Array,
    sig: Uint8Array
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.identicalAppliedRecord(userId, bytes, sig)) {
      return { ok: true };
    }
    try {
      const state = this.deps.keyLogService.currentState(userId);
      // 预演必须无副作用：计数器只在记录真正落库那一次推进（见 makeDeferredVerifyPasskeyAssertion），
      // 否则计数器会自增的认证器上，紧随其后的本地落账验签必然失败。
      const { verify: verifyPasskeyAssertion } = makeDeferredVerifyPasskeyAssertion(
        this.deps.userStore
      );
      const verified = await verifyKeyLogRecord(bytes, sig, {
        head: state.head,
        rootEpoch: state.rootEpoch,
        rootPublicKey: state.rootPublicKey,
        resolvePasskey: (id) => state.passkeys.get(id)?.public_key ?? null,
        verifyPasskeyAssertion,
      });
      if (!verified.ok) {
        return verified;
      }
      const applied = await applyKeyLogRecord(state, verified.record, verified.hash, {
        verifyPasskeyAssertion,
      });
      if (!applied.ok) {
        return { ok: false, error: applied.error };
      }
      return { ok: true };
    } catch {
      return { ok: false, error: 'malformed_payload' };
    }
  }

  async syncToHub(record: {
    bytes: Uint8Array;
    sig: Uint8Array;
    force?: boolean;
  }): Promise<KeyLogHubAck> {
    if (!this.deps.publisher.publishAndAck) {
      return { ok: false, error: 'unavailable' };
    }
    const first = await this.safePublishAndAck(record);
    if (first.ok) return first;
    if (first.error !== 'timeout') return first;
    const retry = await this.safePublishAndAck(record);
    if (retry.ok) return retry;
    if (retry.error !== 'timeout') return retry;
    if (await this.hubAlreadyHasRecord(record)) {
      let seq: bigint | number = 0;
      try {
        seq = decodeKeyLogRecord(record.bytes).seq;
      } catch {
        seq = 0;
      }
      return { ok: true, seq };
    }
    return { ok: false, error: 'HUB_TIMEOUT' };
  }

  async safePublishAndAck(record: {
    bytes: Uint8Array;
    sig: Uint8Array;
    force?: boolean;
  }): Promise<KeyLogHubAck> {
    const publishAndAck = this.deps.publisher.publishAndAck;
    if (!publishAndAck) {
      return { ok: false, error: 'unavailable' };
    }
    try {
      return await publishAndAck(record);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'hub_error';
      return { ok: false, error: message === 'timeout' ? 'timeout' : message };
    }
  }

  async publishToRelay(record: {
    bytes: Uint8Array;
    sig: Uint8Array;
  }): Promise<KeyLogHubAck> {
    const ack = await this.safePublishAndAck(record);
    if (ack.ok || (ack.error !== 'timeout' && ack.error !== 'SEQ_MISMATCH')) return ack;
    try {
      const seq = decodeKeyLogRecord(record.bytes).seq;
      const remote = await this.deps.publisher.queryKeyLogAt?.(seq);
      if (remote && bytesEqual(remote.bytes, record.bytes) && bytesEqual(remote.sig, record.sig)) {
        return { ok: true, seq };
      }
    } catch {
      return ack;
    }
    return ack;
  }

  async hubAlreadyHasRecord(record: { bytes: Uint8Array; sig: Uint8Array }): Promise<boolean> {
    try {
      const seq = decodeKeyLogRecord(record.bytes).seq;
      const remote = await this.deps.publisher.queryKeyLogAt?.(seq);
      if (remote && bytesEqual(remote.bytes, record.bytes) && bytesEqual(remote.sig, record.sig)) {
        return true;
      }
    } catch {
      // fall through to head hash
    }
    const head = await this.deps.publisher.queryHubHead?.();
    if (!head) return false;
    return bytesEqual(head.hash, computeRecordHash(record.bytes, record.sig));
  }
}
