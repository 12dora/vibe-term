import { describe, expect, it } from 'bun:test';
import { bytesToHex, encodeBase64url, hexToBytes } from '../auth/encoding';
import {
  RELAY_JOIN_TOKEN_FIXED_BYTES,
  RELAY_JOIN_TOKEN_MAX_URLS,
  RELAY_JOIN_TOKEN_PREFIX,
  type RelayJoinTokenEntry,
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

const TENANT_A = bytesToHex(bytes(9, 16));
const TENANT_B = bytesToHex(bytes(90, 16));

function entry(url: string, tenantId = TENANT_A, seed = 5): RelayJoinTokenEntry {
  return { url, tenantId, token: bytes(seed) };
}

function baseInput(overrides: Partial<Parameters<typeof encodeRelayJoinToken>[0]> = {}) {
  return {
    enrollSk: bytes(1),
    rootPublicKey: bytes(2),
    keyLogHeadHash: bytes(3),
    logKey: bytes(4),
    relays: [entry('https://relay.example.com')],
    ...overrides,
  };
}

/** 手工拼一个 body，用来构造解码侧的畸形输入。 */
function rawToken(entries: Array<{ url: string; tenantId?: string; token?: Uint8Array }>): string {
  const encoded = entries.map((item) => ({
    url: new TextEncoder().encode(item.url),
    tenantId: hexToBytes(item.tenantId ?? TENANT_A),
    token: item.token ?? bytes(5),
  }));
  const size =
    RELAY_JOIN_TOKEN_FIXED_BYTES +
    1 +
    encoded.reduce((sum, item) => sum + 2 + item.url.byteLength + 48, 0);
  const raw = new Uint8Array(size);
  raw[RELAY_JOIN_TOKEN_FIXED_BYTES] = entries.length;
  const view = new DataView(raw.buffer);
  let offset = RELAY_JOIN_TOKEN_FIXED_BYTES + 1;
  for (const item of encoded) {
    view.setUint16(offset, item.url.byteLength, true);
    raw.set(item.url, offset + 2);
    raw.set(item.tenantId, offset + 2 + item.url.byteLength);
    raw.set(item.token, offset + 18 + item.url.byteLength);
    offset += 2 + item.url.byteLength + 48;
  }
  return RELAY_JOIN_TOKEN_PREFIX + encodeBase64url(raw);
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
    expect(decoded.relays).toHaveLength(1);
    expect(decoded.relays[0]?.url).toBe('https://relay.example.com');
    expect(decoded.relays[0]?.tenantId).toBe(TENANT_A);
    expect(encodeBase64url(decoded.relays[0]?.token ?? new Uint8Array())).toBe(
      encodeBase64url(bytes(5))
    );
    expect(decoded.caFingerprint).toBeUndefined();
  });

  it('每条中继带自己的租户编号与令牌', () => {
    const relays = [
      entry('https://a.example.com', TENANT_A, 5),
      entry('https://b.example.com:8443', TENANT_B, 7),
    ];
    const decoded = decodeRelayJoinToken(encodeRelayJoinToken(baseInput({ relays })));
    expect(decoded.relays.map((item) => item.url)).toEqual([
      'https://a.example.com',
      'https://b.example.com:8443',
    ]);
    expect(decoded.relays.map((item) => item.tenantId)).toEqual([TENANT_A, TENANT_B]);
    expect(encodeBase64url(decoded.relays[1]?.token ?? new Uint8Array())).toBe(
      encodeBase64url(bytes(7))
    );
  });

  it('round-trip 多中继 + CA 指纹', () => {
    const fingerprint = 'ab'.repeat(32);
    const relays = [
      entry('https://a.example.com'),
      entry('https://b.example.com:8443', TENANT_B),
      entry('http://127.0.0.1:19883'),
    ];
    const token = encodeRelayJoinToken(
      baseInput({ relays, caFingerprint: fingerprint.toUpperCase() })
    );
    const decoded = decodeRelayJoinToken(token);
    expect(decoded.relays.map((item) => item.url)).toEqual([
      'https://a.example.com',
      'https://b.example.com:8443',
      'http://127.0.0.1:19883',
    ]);
    expect(decoded.caFingerprint).toBe(fingerprint);
  });

  it('地址顺序即 failover 顺序', () => {
    const relays = [entry('https://b.example.com'), entry('https://a.example.com')];
    expect(
      decodeRelayJoinToken(encodeRelayJoinToken(baseInput({ relays }))).relays.map(
        (item) => item.url
      )
    ).toEqual(['https://b.example.com', 'https://a.example.com']);
  });

  it('拒绝空地址表与超量地址', () => {
    expect(() => encodeRelayJoinToken(baseInput({ relays: [] }))).toThrow(RelayJoinTokenError);
    const many = Array.from({ length: RELAY_JOIN_TOKEN_MAX_URLS + 1 }, (_, i) =>
      entry(`https://r${i}.example.com`)
    );
    expect(() => encodeRelayJoinToken(baseInput({ relays: many }))).toThrow(RelayJoinTokenError);
  });

  it('拒绝非法字段长度', () => {
    expect(() => encodeRelayJoinToken(baseInput({ enrollSk: bytes(1, 31) }))).toThrow(
      RelayJoinTokenError
    );
    expect(() =>
      encodeRelayJoinToken(
        baseInput({
          relays: [{ url: 'https://relay.example.com', tenantId: TENANT_A, token: bytes(5, 33) }],
        })
      )
    ).toThrow(RelayJoinTokenError);
    expect(() =>
      encodeRelayJoinToken(
        baseInput({
          relays: [{ url: 'https://relay.example.com', tenantId: 'zz', token: bytes(5) }],
        })
      )
    ).toThrow(RelayJoinTokenError);
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

  it('拒绝 n=0 与截断的凭据', () => {
    const empty = new Uint8Array(RELAY_JOIN_TOKEN_FIXED_BYTES + 1);
    expect(() => decodeRelayJoinToken(RELAY_JOIN_TOKEN_PREFIX + encodeBase64url(empty))).toThrow(
      RelayJoinTokenError
    );
    // 地址长度写对但后面的 tenant_id/token 被截掉。
    const full = rawToken([{ url: 'https://relay.example.com' }]);
    const raw = Buffer.from(
      full.slice(RELAY_JOIN_TOKEN_PREFIX.length).replaceAll('-', '+').replaceAll('_', '/'),
      'base64'
    );
    const cut = new Uint8Array(raw.subarray(0, raw.byteLength - 1));
    expect(() => decodeRelayJoinToken(RELAY_JOIN_TOKEN_PREFIX + encodeBase64url(cut))).toThrow(
      RelayJoinTokenError
    );
  });

  it('拒绝表内的非 https 地址与尾部多余字节', () => {
    expect(() => decodeRelayJoinToken(rawToken([{ url: 'http://relay.example.com' }]))).toThrow(
      RelayJoinTokenError
    );
    const good = rawToken([{ url: 'https://relay.example.com' }]);
    const raw = Buffer.from(
      good.slice(RELAY_JOIN_TOKEN_PREFIX.length).replaceAll('-', '+').replaceAll('_', '/'),
      'base64'
    );
    const trailing = new Uint8Array(raw.byteLength + 1);
    trailing.set(raw, 0);
    expect(() => decodeRelayJoinToken(RELAY_JOIN_TOKEN_PREFIX + encodeBase64url(trailing))).toThrow(
      RelayJoinTokenError
    );
  });
});
