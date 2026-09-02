import { encodeBase64url, encodeSetTotpPayload } from '@tmex/shared/auth';
import type { UserKeyService } from '../auth/user-key-service';
import type { UserStore } from '../auth/user-store';
import { jsonBody, jsonError } from './session-middleware';

export function handleTotpRecord(
  deps: { userStore: UserStore; keyLogService: UserKeyService },
  userId: string | null
): Response {
  if (!userId) return jsonError('UNAUTHORIZED', 401);
  const user = deps.userStore.getById(userId);
  if (!user) return jsonError('UNKNOWN_USER', 404);
  if (user.totpRecordSeq == null) return jsonError('TOTP_NOT_ENABLED', 404);
  try {
    const state = deps.keyLogService.currentState(userId);
    if (!state.totp) return jsonError('TOTP_NOT_ENABLED', 404);
    return jsonBody({
      record_seq: seqToJson(user.totpRecordSeq),
      root_epoch: state.rootEpoch,
      payload: encodeBase64url(encodeSetTotpPayload(state.totp)),
    });
  } catch {
    return jsonError('UNKNOWN_USER', 404);
  }
}

function seqToJson(seq: bigint | number): number | string {
  const value = typeof seq === 'bigint' ? seq : BigInt(seq);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}
