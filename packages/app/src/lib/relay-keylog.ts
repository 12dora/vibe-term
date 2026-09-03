import { decodeBase64url, encodeBase64url } from '../../../shared/src/auth';
import { type RelayEnvelope, openEnvelope } from '../../../shared/src/relay';

/**
 * 中继密钥日志块的明文帧。plan 1.4 只写了 `recordBytes ‖ sig`；sig 在 passkey 签名下是变长的
 * Borsh 断言，必须有长度界定，这里统一用与 hub `key.log.res` 一致的 `{bytes, sig}` b64url JSON。
 */
export type RelayKeyLogEntry = { bytes: Uint8Array; sig: Uint8Array };

export const RELAY_KEYLOG_ENVELOPE_KIND = 'keylog';
export const RELAY_KEYLOG_PLAINTEXT_MAX_BYTES = 256 * 1024;

export function encodeRelayKeyLogPlaintext(entry: RelayKeyLogEntry): Uint8Array {
  const json = JSON.stringify({
    bytes: encodeBase64url(entry.bytes),
    sig: encodeBase64url(entry.sig),
  });
  return new TextEncoder().encode(json);
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

export type RelayKeyLogPageItem = { seq: number | string; blob: RelayEnvelope };

function seqOf(item: RelayKeyLogPageItem): bigint {
  return BigInt(item.seq);
}

/** 打开一页密钥日志块，按 seq 升序返回；seq 必须从 1 起连续，否则拒绝整页。 */
export async function openRelayKeyLogPage(
  logKey: Uint8Array,
  items: readonly RelayKeyLogPageItem[]
): Promise<RelayKeyLogEntry[]> {
  const sorted = [...items].sort((a, b) =>
    seqOf(a) < seqOf(b) ? -1 : seqOf(a) > seqOf(b) ? 1 : 0
  );
  const out: RelayKeyLogEntry[] = [];
  let expected = 1n;
  for (const item of sorted) {
    if (seqOf(item) !== expected) {
      throw new Error(`relay key log is not contiguous at seq ${String(item.seq)}`);
    }
    expected += 1n;
    const plaintext = await openEnvelope(logKey, RELAY_KEYLOG_ENVELOPE_KIND, item.blob);
    out.push(decodeRelayKeyLogPlaintext(plaintext));
  }
  return out;
}

export function parseRelayKeyLogPage(value: unknown): RelayKeyLogPageItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const seq = item.seq;
    if (typeof seq !== 'number' && typeof seq !== 'string') {
      throw new Error('relay key log entry missing seq');
    }
    if (!item.blob || typeof item.blob !== 'object') {
      throw new Error('relay key log entry missing blob');
    }
    return { seq, blob: item.blob as RelayEnvelope };
  });
}
