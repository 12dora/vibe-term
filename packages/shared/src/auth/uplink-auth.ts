import { b } from '@zorsh/zorsh';

export const DOMAIN_UPLINK_AUTH = 'tmex/uplink-auth/v1';

export const UplinkAuthSchema = b.struct({
  domain: b.string(),
  nonce: b.bytes(32),
  hub_host: b.string(),
});

export type UplinkAuth = b.infer<typeof UplinkAuthSchema>;

export function uplinkAuthMessage(nonce: Uint8Array, hubHost: string): Uint8Array {
  if (nonce.byteLength !== 32) {
    throw new Error('nonce must be 32 bytes');
  }
  return UplinkAuthSchema.serialize({
    domain: DOMAIN_UPLINK_AUTH,
    nonce: new Uint8Array(nonce),
    hub_host: hubHost,
  });
}

export function decodeUplinkAuth(bytes: Uint8Array): UplinkAuth {
  const value = UplinkAuthSchema.deserialize(bytes);
  if (value.domain !== DOMAIN_UPLINK_AUTH) {
    throw new Error(`domain mismatch: expected ${DOMAIN_UPLINK_AUTH}, got ${value.domain}`);
  }
  if (value.nonce.byteLength !== 32) {
    throw new Error('nonce must be 32 bytes');
  }
  return value;
}

export function hubHostFromUrl(hubUrl: string): string {
  return new URL(hubUrl).host;
}
