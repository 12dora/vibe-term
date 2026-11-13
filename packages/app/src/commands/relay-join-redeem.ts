import {
  decodeAuthorization,
  decodeBase64url,
  decodeKeyLogRecord,
  encodeBase64url,
} from '../../../shared/src/auth';
import { RELAY_TOKEN_HEADER, assignHeaderPair } from '../../../shared/src/http/mesh-headers';
import type { RelayJoinToken, RelayJoinTokenEntry } from '../../../shared/src/relay';
import type { FetchLike } from '../lib/fetch-like';
import { fetchRelayKeyLog, openRelayKeyLogPage, parseRelayKeyLogPage } from '../lib/relay-keylog';
import { JoinError } from './join-error';
import { RELAY_ENROLLMENT_LOOKUP_MISSING, isBareNotFound } from './relay-join-failover';
import { RELAY_REDEEM_RESPONSE_MAX_BYTES, joinRelayUrl, requestRelayJson } from './relay-shared';

/** 每台中继的租户令牌都是它自己签发的，跨中继复用只会被拒。 */
export function relayHeaders(entry: RelayJoinTokenEntry): Record<string, string> {
  return assignHeaderPair({}, RELAY_TOKEN_HEADER, encodeBase64url(entry.token));
}

/**
 * 证书里的 uid 必须与租户 genesis 一致（`applyAdmitNode` 会比对），而 redeem 之前节点只有
 * join 串，所以先按 enroll_pk 取回中继保存的 authorization，从中读出 uid。
 */
export async function fetchEnrollmentUid(input: {
  entry: RelayJoinTokenEntry;
  enrollPk: Uint8Array;
  fetcher?: FetchLike;
  timeoutMs?: number;
}): Promise<string> {
  let body: Record<string, unknown>;
  try {
    body = await requestRelayJson({
      fetcher: input.fetcher,
      url: joinRelayUrl(
        input.entry.url,
        `/api/relay/tenants/${input.entry.tenantId}/enrollments/${encodeURIComponent(
          encodeBase64url(input.enrollPk)
        )}`
      ),
      headers: relayHeaders(input.entry),
      label: 'relay enrollment lookup',
      timeoutMs: input.timeoutMs,
    });
  } catch (error) {
    if (isBareNotFound(error)) {
      throw new JoinError('join_failed', RELAY_ENROLLMENT_LOOKUP_MISSING);
    }
    throw error;
  }
  const authorization = body.authorization;
  if (typeof authorization !== 'string') {
    throw new JoinError('join_failed', 'relay enrollment lookup returned no authorization');
  }
  return decodeAuthorization(decodeBase64url(authorization)).uid;
}

export type RelayRedeemResponse = {
  keyLog: Awaited<ReturnType<typeof openRelayKeyLogPage>>;
  relays: string[];
  tenantId: string;
};

export async function redeemAtRelay(input: {
  entry: RelayJoinTokenEntry;
  decoded: RelayJoinToken;
  certificate: Uint8Array;
  certSig: Uint8Array;
  pop: string;
  fetcher?: FetchLike;
  timeoutMs?: number;
}): Promise<RelayRedeemResponse> {
  const body = await requestRelayJson({
    fetcher: input.fetcher,
    url: joinRelayUrl(
      input.entry.url,
      `/api/relay/tenants/${input.entry.tenantId}/enrollments/redeem`
    ),
    method: 'POST',
    headers: relayHeaders(input.entry),
    body: {
      certificate: encodeBase64url(input.certificate),
      cert_sig: encodeBase64url(input.certSig),
      pop: input.pop,
    },
    label: 'relay redeem',
    maxBytes: RELAY_REDEEM_RESPONSE_MAX_BYTES,
    timeoutMs: input.timeoutMs,
  });
  const prefix = parseRelayKeyLogPage(body.key_log);
  let keyLog = await openRelayKeyLogPage(input.decoded.logKey, prefix);
  if (body.has_more === true) {
    const last = keyLog[keyLog.length - 1];
    const lastSeq = last ? decodeKeyLogRecord(last.bytes).seq : 0n;
    const rest = await fetchRelayKeyLog({
      relayUrl: input.entry.url,
      tenantId: input.entry.tenantId,
      headers: relayHeaders(input.entry),
      logKey: input.decoded.logKey,
      fromSeq: Number(lastSeq) + 1,
      fetcher: input.fetcher,
      timeoutMs: input.timeoutMs,
    });
    keyLog = [...keyLog, ...rest];
  }
  const relays = Array.isArray(body.relays)
    ? body.relays.filter((url): url is string => typeof url === 'string')
    : [];
  return {
    keyLog,
    relays,
    tenantId: typeof body.tenant_id === 'string' ? body.tenant_id : input.entry.tenantId,
  };
}
