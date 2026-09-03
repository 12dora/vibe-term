import { describe, expect, test } from 'bun:test';
import { encodeBase64url, randomBytes } from '../auth/encoding';
import {
  RELAY_KEYLOG_ENVELOPE_KIND,
  RELAY_KEYLOG_PLAINTEXT_MAX_BYTES,
  decodeRelayKeyLogPlaintext,
  encodeRelayKeyLogPlaintext,
  openRelayKeyLogRecord,
  sealRelayKeyLogRecord,
} from './keylog-frame';
import { generateTenantKey, sealEnvelope } from './tenant-cipher';

const KEY = generateTenantKey();

describe('relay key log frame', () => {
  test('明文是 {bytes,sig} 的 b64url JSON', () => {
    const bytes = randomBytes(48);
    const sig = randomBytes(64);
    const plaintext = encodeRelayKeyLogPlaintext({ bytes, sig });
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({
      bytes: encodeBase64url(bytes),
      sig: encodeBase64url(sig),
    });
  });

  test('变长签名（passkey 断言）也能往返', () => {
    for (const sigLength of [7, 64, 300]) {
      const source = { bytes: randomBytes(16), sig: randomBytes(sigLength) };
      expect(decodeRelayKeyLogPlaintext(encodeRelayKeyLogPlaintext(source))).toEqual(source);
    }
  });

  test('非 JSON / 缺字段 / 超长一律抛错', () => {
    expect(() => decodeRelayKeyLogPlaintext(new TextEncoder().encode('nope'))).toThrow(
      'not valid JSON'
    );
    expect(() => decodeRelayKeyLogPlaintext(new TextEncoder().encode('{"bytes":"AA"}'))).toThrow(
      'missing bytes/sig'
    );
    expect(() =>
      decodeRelayKeyLogPlaintext(new Uint8Array(RELAY_KEYLOG_PLAINTEXT_MAX_BYTES + 1))
    ).toThrow('too large');
  });

  test('信封 kind 固定为 keylog，密钥不对解不开', async () => {
    const record = { bytes: randomBytes(32), sig: randomBytes(64) };
    const sealed = await sealRelayKeyLogRecord(KEY, record);
    expect(await openRelayKeyLogRecord(KEY, sealed)).toEqual(record);
    await expect(openRelayKeyLogRecord(generateTenantKey(), sealed)).rejects.toThrow();
    const manual = await sealEnvelope(
      KEY,
      RELAY_KEYLOG_ENVELOPE_KIND,
      encodeRelayKeyLogPlaintext(record)
    );
    expect(await openRelayKeyLogRecord(KEY, manual)).toEqual(record);
  });
});
