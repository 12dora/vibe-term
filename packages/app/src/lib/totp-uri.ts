import { bytesToHex, encodeBase32, sha256 } from '../../../shared/src/auth';

export { encodeBase32 };

export function totpOtpauthUri(username: string, secret: Uint8Array, issuer = 'tmex'): string {
  const encodedSecret = encodeBase32(secret);
  const label = encodeURIComponent(`${issuer}:${username}`);
  return `otpauth://totp/${label}?secret=${encodedSecret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export function fingerprintPublicKey(publicKey: Uint8Array): string {
  return bytesToHex(sha256(publicKey));
}
