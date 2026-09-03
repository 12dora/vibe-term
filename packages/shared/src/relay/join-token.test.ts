import { describe, expect, it } from 'bun:test';
import { bytesToHex, encodeBase64url } from '../auth/encoding';
import {
  RELAY_JOIN_TOKEN_MAX_URLS,
  RELAY_JOIN_TOKEN_PREFIX,
  RelayJoinTokenError,
  decodeRelayJoinToken,
  encodeRelayJoinToken,
  isRelayJoinToken,
  normalizeRelayUrl,
} from './join-token';

function bytes(seed: number, len = 32): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = (seed + i) & 0xff;
  return out;
}

const TENANT_ID = bytesToHex(bytes(9, 16));

function baseInput(overrides: Partial<Parameters<typeof encodeRelayJoinToken>[0]> = {}) {
  return {
    enrollSk: bytes(1),
    rootPublicKey: bytes(2),
    keyLogHeadHash: bytes(3),
    logKey: bytes(4),
    tenantId: TENANT_ID,
    token: bytes(5),
    relayUrls: ['https://relay.example.com'],
    ...overrides,
  };
}

describe('normalizeRelayUrl', () => {
  it('归一化 https 地址', () => {
    expect(normalizeRelayUrl('https://Relay.Example.com:443/')).toBe('https://relay.example.com');
    expect(normalizeRelayUrl('https://relay.example.com:8443/base/')).toBe(
      'https://relay.example.com:8443/base'
    );
  });

  it('回环允许 http', () => {
    expect(normalizeRelayUrl('http://127.0.0.1:19883')).toBe('http://127.0.0.1:19883');
    expect(normalizeRelayUrl('http://localhost:19883')).toBe('http://localhost:19883');
  });

  it('拒绝非 https 的公网地址与畸形地址', () => {
    for (const raw of ['http://relay.example.com', 'ws://relay.example.com', 'relay', '']) {
      expect(() => normalizeRelayUrl(raw)).toThrow(RelayJoinTokenError);
    }
    expect(() => normalizeRelayUrl(`https://relay.example.com/${'a'.repeat(600)}`)).toThrow(
      RelayJoinTokenError
    );
  });
});

describe('relay join 串 v3', () => {
  it('识别前缀', () => {
    expect(isRelayJoinToken(encodeRelayJoinToken(baseInput()))).toBe(true);
    expect(isRelayJoinToken('AAAA')).toBe(false);
  });

  it('round-trip 单个中继', () => {
    const token = encodeRelayJoinToken(baseInput());
    expect(token.startsWith(RELAY_JOIN_TOKEN_PREFIX)).toBe(true);
    const decoded = decodeRelayJoinToken(token);
    expect(encodeBase64url(decoded.enrollSk)).toBe(encodeBase64url(bytes(1)));
    expect(encodeBase64url(decoded.rootPublicKey)).toBe(encodeBase64url(bytes(2)));
    expect(encodeBase64url(decoded.keyLogHeadHash)).toBe(encodeBase64url(bytes(3)));
    expect(encodeBase64url(decoded.logKey)).toBe(encodeBase64url(bytes(4)));
    expect(decoded.tenantId).toBe(TENANT_ID);
    expect(encodeBase64url(decoded.token)).toBe(encodeBase64url(bytes(5)));
    expect(decoded.relayUrls).toEqual(['https://relay.example.com']);
    expect(decoded.caFingerprint).toBeUndefined();
  });

  it('round-trip 多中继 + CA 指纹', () => {
    const fingerprint = 'ab'.repeat(32);
    const urls = ['https://a.example.com', 'https://b.example.com:8443', 'http://127.0.0.1:19883'];
    const token = encodeRelayJoinToken(
      baseInput({ relayUrls: urls, caFingerprint: fingerprint.toUpperCase() })
    );
    const decoded = decodeRelayJoinToken(token);
    expect(decoded.relayUrls).toEqual(urls);
    expect(decoded.caFingerprint).toBe(fingerprint);
  });

  it('地址顺序即 failover 顺序', () => {
    const urls = ['https://b.example.com', 'https://a.example.com'];
    expect(
      decodeRelayJoinToken(encodeRelayJoinToken(baseInput({ relayUrls: urls }))).relayUrls
    ).toEqual(urls);
  });

  it('拒绝空地址表与超量地址', () => {
    expect(() => encodeRelayJoinToken(baseInput({ relayUrls: [] }))).toThrow(RelayJoinTokenError);
    const many = Array.from(
      { length: RELAY_JOIN_TOKEN_MAX_URLS + 1 },
      (_, i) => `https://r${i}.example.com`
    );
    expect(() => encodeRelayJoinToken(baseInput({ relayUrls: many }))).toThrow(RelayJoinTokenError);
  });

  it('拒绝非法字段长度', () => {
    expect(() => encodeRelayJoinToken(baseInput({ enrollSk: bytes(1, 31) }))).toThrow(
      RelayJoinTokenError
    );
    expect(() => encodeRelayJoinToken(baseInput({ token: bytes(5, 33) }))).toThrow(
      RelayJoinTokenError
    );
    expect(() => encodeRelayJoinToken(baseInput({ tenantId: 'zz' }))).toThrow(RelayJoinTokenError);
    expect(() => encodeRelayJoinToken(baseInput({ caFingerprint: 'nope' }))).toThrow(
      RelayJoinTokenError
    );
  });

  it('拒绝错误前缀 / 畸形 body / 过短 / 多余指纹段', () => {
    const token = encodeRelayJoinToken(baseInput());
    const body = token.slice(RELAY_JOIN_TOKEN_PREFIX.length);
    expect(() => decodeRelayJoinToken(body)).toThrow(RelayJoinTokenError);
    expect(() => decodeRelayJoinToken('r2.AAAA')).toThrow(RelayJoinTokenError);
    expect(() => decodeRelayJoinToken(`${RELAY_JOIN_TOKEN_PREFIX}AAAA`)).toThrow(
      RelayJoinTokenError
    );
    expect(() => decodeRelayJoinToken(`${token}.${'ab'.repeat(32)}.${'cd'.repeat(32)}`)).toThrow(
      RelayJoinTokenError
    );
  });

  it('拒绝 n=0 与截断的地址表', () => {
    const raw = new Uint8Array(177);
    raw[176] = 0;
    expect(() => decodeRelayJoinToken(RELAY_JOIN_TOKEN_PREFIX + encodeBase64url(raw))).toThrow(
      RelayJoinTokenError
    );
    const truncated = new Uint8Array(179);
    truncated[176] = 1;
    truncated[177] = 40;
    truncated[178] = 0;
    expect(() =>
      decodeRelayJoinToken(RELAY_JOIN_TOKEN_PREFIX + encodeBase64url(truncated))
    ).toThrow(RelayJoinTokenError);
  });

  it('拒绝表内的非 https 地址与尾部多余字节', () => {
    const url = new TextEncoder().encode('http://relay.example.com');
    const raw = new Uint8Array(177 + 2 + url.length);
    raw[176] = 1;
    new DataView(raw.buffer).setUint16(177, url.length, true);
    raw.set(url, 179);
    expect(() => decodeRelayJoinToken(RELAY_JOIN_TOKEN_PREFIX + encodeBase64url(raw))).toThrow(
      RelayJoinTokenError
    );

    const good = new TextEncoder().encode('https://relay.example.com');
    const trailing = new Uint8Array(177 + 2 + good.length + 1);
    trailing[176] = 1;
    new DataView(trailing.buffer).setUint16(177, good.length, true);
    trailing.set(good, 179);
    expect(() => decodeRelayJoinToken(RELAY_JOIN_TOKEN_PREFIX + encodeBase64url(trailing))).toThrow(
      RelayJoinTokenError
    );
  });
});
