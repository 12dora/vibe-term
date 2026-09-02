import { decodeCertificate } from '@tmex/shared/auth';

export function decodeCertificateIdentityKeys(
  bytes: Uint8Array
): { edPk: Uint8Array; x25519Pk: Uint8Array } | null {
  try {
    const decoded = decodeCertificate(bytes);
    return { edPk: decoded.ed_pk, x25519Pk: decoded.x25519_pk };
  } catch {
    return null;
  }
}

export function parseKdfParams(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
