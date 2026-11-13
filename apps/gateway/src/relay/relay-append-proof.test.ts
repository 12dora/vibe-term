import { describe, expect, test } from 'bun:test';
import { generateEd25519KeyPair } from '@vibeterm/shared/auth';
import {
  DOMAIN_RELAY_KEYLOG_APPEND,
  relayKeyLogAppendMessage,
  signRelayKeyLogAppend,
  verifyRelayKeyLogAppend,
} from './relay-append-proof';

const envelope = { v: 1 as const, epoch: 2, n: 'AAAAAAAAAAAAAAAA', ct: 'Y2lwaGVy' };
const input = { relayHost: 'relay.example.com', tenantId: 'a'.repeat(32), seq: 7n, envelope };

describe('relay key-log append proof', () => {
  test('新域常量，不复用已有的冻结域', () => {
    expect(DOMAIN_RELAY_KEYLOG_APPEND).toBe('tmex/relay-keylog-append/v1');
    const text = new TextDecoder().decode(relayKeyLogAppendMessage(input));
    expect(text).toContain(DOMAIN_RELAY_KEYLOG_APPEND);
  });

  test('签名绑定中继、租户、seq 与信封', () => {
    const key = generateEd25519KeyPair();
    const sig = signRelayKeyLogAppend(key.secretKey, input);
    expect(verifyRelayKeyLogAppend(sig, key.publicKey, input)).toBe(true);
    expect(verifyRelayKeyLogAppend(sig, key.publicKey, { ...input, seq: 8n })).toBe(false);
    expect(
      verifyRelayKeyLogAppend(sig, key.publicKey, { ...input, tenantId: 'b'.repeat(32) })
    ).toBe(false);
    expect(
      verifyRelayKeyLogAppend(sig, key.publicKey, { ...input, relayHost: 'relay.example.net' })
    ).toBe(false);
    expect(
      verifyRelayKeyLogAppend(sig, key.publicKey, { ...input, envelope: { ...envelope, ct: 'eA' } })
    ).toBe(false);
    expect(verifyRelayKeyLogAppend(sig, generateEd25519KeyPair().publicKey, input)).toBe(false);
    expect(verifyRelayKeyLogAppend(sig.slice(0, 63), key.publicKey, input)).toBe(false);
  });
});
