import * as x509 from '@peculiar/x509';

x509.cryptoProvider.set(crypto);

export const MAX_CA_RESPONSE_BYTES = 64 * 1024;

const BEGIN_CERTIFICATE = '-----BEGIN CERTIFICATE-----';
const END_CERTIFICATE = '-----END CERTIFICATE-----';

export function parseStrictSinglePemCertificate(text: string): string {
  if (typeof text !== 'string') {
    throw new Error('ca response is not a single PEM certificate');
  }
  const beginCount = text.split(BEGIN_CERTIFICATE).length - 1;
  const endCount = text.split(END_CERTIFICATE).length - 1;
  if (beginCount !== 1 || endCount !== 1) {
    throw new Error('ca response is not a single PEM certificate');
  }
  const begin = text.indexOf(BEGIN_CERTIFICATE);
  const end = text.indexOf(END_CERTIFICATE);
  if (begin < 0 || end < begin) {
    throw new Error('ca response is not a single PEM certificate');
  }
  const prefix = text.slice(0, begin);
  const suffix = text.slice(end + END_CERTIFICATE.length);
  if (prefix.trim() !== '' || suffix.trim() !== '') {
    throw new Error('ca response is not a single PEM certificate');
  }
  const body = text.slice(begin + BEGIN_CERTIFICATE.length, end);
  if (!/^[A-Za-z0-9+/=\s]+$/.test(body) || body.replace(/\s+/g, '').length === 0) {
    throw new Error('ca response is not a single PEM certificate');
  }
  return `${BEGIN_CERTIFICATE}\n${body.trim()}\n${END_CERTIFICATE}\n`;
}

export async function parseAndValidateCaPem(raw: string): Promise<{
  canonicalPem: string;
  fingerprint: string;
}> {
  const pem = parseStrictSinglePemCertificate(raw);
  let cert: x509.X509Certificate;
  try {
    cert = new x509.X509Certificate(pem);
  } catch {
    throw new Error('ca response is not a single PEM certificate');
  }
  const basicConstraints = cert.getExtension(x509.BasicConstraintsExtension);
  const keyUsages = cert.getExtension(x509.KeyUsagesExtension);
  const isCa = basicConstraints?.ca === true;
  const canSignCerts = Boolean(
    keyUsages && (keyUsages.usages & x509.KeyUsageFlags.keyCertSign) !== 0
  );
  if (!isCa || !canSignCerts) {
    throw new Error('certificate is not a CA');
  }
  const canonicalPem = cert.toString('pem');
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(cert.publicKey.rawData));
  return {
    canonicalPem,
    fingerprint: Buffer.from(digest).toString('hex'),
  };
}

export async function readBoundedResponseText(
  response: Response,
  maxBytes = MAX_CA_RESPONSE_BYTES
): Promise<string> {
  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader) {
    const length = Number(lengthHeader);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new Error('ca_response_too_large');
    }
  }
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new Error('ca_response_too_large');
    }
    return buffer.toString('utf8');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('ca_response_too_large');
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released after cancel
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf8').decode(out);
}
