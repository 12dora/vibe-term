import { describe, expect, it } from 'bun:test';
import { bytesToHex } from './encoding';
import { generateEd25519KeyPair, signEd25519, verifyEd25519 } from './root-key';
import {
  DOMAIN_UPLINK_AUTH,
  decodeUplinkAuth,
  hubHostFromUrl,
  uplinkAuthMessage,
} from './uplink-auth';

const VECTOR_HEX =
  '13000000746d65782f75706c696e6b2d617574682f763111111111111111111111111111111111111111111111111111111111111111110f0000006875622e6578616d706c652e636f6d';

describe('uplink-auth', () => {
  it('pins Borsh domain + nonce[32] + hub_host so hub and node agree', () => {
    const nonce = new Uint8Array(32).fill(0x11);
    const bytes = uplinkAuthMessage(nonce, 'hub.example.com');
    expect(bytesToHex(bytes)).toBe(VECTOR_HEX);
    const decoded = decodeUplinkAuth(bytes);
    expect(decoded.domain).toBe(DOMAIN_UPLINK_AUTH);
    expect(decoded.hub_host).toBe('hub.example.com');
    expect(Array.from(decoded.nonce)).toEqual(Array.from(nonce));
  });

  it('rejects a nonce that is not 32 bytes', () => {
    expect(() => uplinkAuthMessage(new Uint8Array(16), 'hub.example.com')).toThrow(
      'nonce must be 32 bytes'
    );
  });

  it('extracts hub_host from hubUrl including non-default port', () => {
    expect(hubHostFromUrl('https://hub.example.com')).toBe('hub.example.com');
    expect(hubHostFromUrl('http://127.0.0.1:9883/')).toBe('127.0.0.1:9883');
  });

  it('Ed25519 over uplinkAuthMessage is not a raw-nonce signature', () => {
    const keys = generateEd25519KeyPair();
    const nonce = new Uint8Array(32).fill(0x42);
    const message = uplinkAuthMessage(nonce, 'hub.example.com');
    const sig = signEd25519(keys.secretKey, message);
    expect(verifyEd25519(sig, message, keys.publicKey)).toBe(true);
    expect(verifyEd25519(sig, nonce, keys.publicKey)).toBe(false);
  });
});
