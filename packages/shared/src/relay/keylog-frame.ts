import { decodeBase64url, encodeBase64url } from '../auth/encoding';
import { type RelayEnvelope, openEnvelope, sealEnvelope } from './tenant-cipher';

/**
 * 中继密钥日志块的明文帧。plan 1.4 字面写的是 `recordBytes ‖ sig`，但 passkey 签名是变长的
 * Borsh 断言，拼接后无法切分；因此统一用与 hub `key.log.res` 同形的 `{bytes, sig}` b64url JSON。
 * 节点侧（`apps/gateway/src/mesh/relay-key-log-sync.ts`）与 CLI 侧
 * （`packages/app/src/lib/relay-keylog.ts`）共用本模块，两侧逐字节一致。
 */
export const RELAY_KEYLOG_ENVELOPE_KIND = 'keylog';
export const RELAY_KEYLOG_PLAINTEXT_MAX_BYTES = 256 * 1024;

export type RelayKeyLogEntry = { bytes: Uint8Array; sig: Uint8Array };

export function encodeRelayKeyLogPlaintext(entry: RelayKeyLogEntry): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      bytes: encodeBase64url(entry.bytes),
      sig: encodeBase64url(entry.sig),
    })
  );
}

export function decodeRelayKeyLogPlaintext(plaintext: Uint8Array): RelayKeyLogEntry {
  if (plaintext.byteLength > RELAY_KEYLOG_PLAINTEXT_MAX_BYTES) {
    throw new Error('relay key log record too large');
  }
  let parsed: { bytes?: unknown; sig?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext)) as typeof parsed;
  } catch {
    throw new Error('relay key log record is not valid JSON');
  }
  if (typeof parsed.bytes !== 'string' || typeof parsed.sig !== 'string') {
    throw new Error('relay key log record missing bytes/sig');
  }
  return { bytes: decodeBase64url(parsed.bytes), sig: decodeBase64url(parsed.sig) };
}

export function sealRelayKeyLogRecord(
  logKey: Uint8Array,
  entry: RelayKeyLogEntry
): Promise<RelayEnvelope> {
  return sealEnvelope(logKey, RELAY_KEYLOG_ENVELOPE_KIND, encodeRelayKeyLogPlaintext(entry));
}

export async function openRelayKeyLogRecord(
  logKey: Uint8Array,
  envelope: RelayEnvelope
): Promise<RelayKeyLogEntry> {
  return decodeRelayKeyLogPlaintext(
    await openEnvelope(logKey, RELAY_KEYLOG_ENVELOPE_KIND, envelope)
  );
}
