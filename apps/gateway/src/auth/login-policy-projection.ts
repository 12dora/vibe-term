import {
  type LoginPolicy,
  decodeKeyLogRecord,
  decodeLoginPolicyPayload,
  validateLoginPolicy,
} from '@vibeterm/shared/auth';
import type { KeyLogStore } from './key-log-store';

/** 后写的 `login-policy` 覆盖前一条。读路径不回放整条链。 */
export function projectLoginPolicy(store: KeyLogStore, userId: string): LoginPolicy | null {
  const entry = store.latestByType(userId, 'login-policy');
  if (!entry) return null;
  try {
    const payload = decodeLoginPolicyPayload(decodeKeyLogRecord(entry.bytes).payload);
    const validated = validateLoginPolicy({
      preset: payload.preset,
      ipFailThreshold: payload.ip_fail_threshold,
      ipLockBaseMs: payload.ip_lock_base_ms,
      ipLockMaxMs: payload.ip_lock_max_ms,
      accountFailPerHour: payload.account_fail_per_hour,
      accountLockMs: payload.account_lock_ms,
      exemptLocal: payload.exempt_local,
    });
    return validated.ok ? validated.policy : null;
  } catch {
    return null;
  }
}
