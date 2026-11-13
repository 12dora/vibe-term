import { concatBytes, sha256 } from '../auth/encoding';
import { signEd25519, verifyEd25519 } from '../auth/root-key';
import type { RelayEnvelope } from './tenant-cipher';

/** 新增域：HTTP 追加密钥日志时由已准入节点签名，中继据此归属写入者。 */
export const DOMAIN_RELAY_KEYLOG_APPEND = 'tmex/relay-keylog-append/v1';

const te = new TextEncoder();

function lengthPrefixed(value: string): Uint8Array {
  const bytes = te.encode(value);
  const out = new Uint8Array(4 + bytes.byteLength);
  new DataView(out.buffer).setUint32(0, bytes.byteLength, true);
  out.set(bytes, 4);
  return out;
}

function u64le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

/** 与 `parseRelayEnvelopeJson` 的输出同字段顺序：两端对同一信封算出同一摘要。 */
export function relayEnvelopeDigest(envelope: RelayEnvelope): Uint8Array {
  const canonical = {
    v: envelope.v,
    ...(envelope.epoch === undefined ? {} : { epoch: envelope.epoch }),
    n: envelope.n,
    ct: envelope.ct,
  };
  return sha256(te.encode(JSON.stringify(canonical)));
}

export function relayKeyLogAppendMessage(input: {
  relayHost: string;
  tenantId: string;
  seq: bigint;
  envelope: RelayEnvelope;
}): Uint8Array {
  return concatBytes(
    lengthPrefixed(DOMAIN_RELAY_KEYLOG_APPEND),
    lengthPrefixed(input.relayHost),
    lengthPrefixed(input.tenantId),
    u64le(input.seq),
    relayEnvelopeDigest(input.envelope)
  );
}

export function signRelayKeyLogAppend(
  edSecretKey: Uint8Array,
  input: Parameters<typeof relayKeyLogAppendMessage>[0]
): Uint8Array {
  return signEd25519(edSecretKey, relayKeyLogAppendMessage(input));
}

export function verifyRelayKeyLogAppend(
  sig: Uint8Array,
  edPk: Uint8Array,
  input: Parameters<typeof relayKeyLogAppendMessage>[0]
): boolean {
  if (sig.byteLength !== 64) return false;
  try {
    return verifyEd25519(sig, relayKeyLogAppendMessage(input), edPk);
  } catch {
    return false;
  }
}
