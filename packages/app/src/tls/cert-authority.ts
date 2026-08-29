import { isIP } from 'node:net';
import * as x509 from '@peculiar/x509';

x509.cryptoProvider.set(crypto);

const EC_ALG: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_ALG: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' };
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CA_DAYS = 3650;
export const CERT_NOT_BEFORE_SKEW_MS = 5 * 60 * 1000;
export const CA_MIN_REMAINING_MS = 30 * MS_PER_DAY;

export type CaMaterial = {
  certPem: string;
  keyPem: string;
};

export type LeafMaterial = {
  certPem: string;
  keyPem: string;
};

export type ParsedCertificate = {
  subject: string;
  issuer: string;
  sans: string[];
  notBefore: number;
  notAfter: number;
};

export async function createCa(input: {
  name: string;
  days?: number;
  now?: number;
}): Promise<CaMaterial> {
  const keys = await crypto.subtle.generateKey(EC_ALG, true, ['sign', 'verify']);
  const now = input.now ?? Date.now();
  const days = input.days ?? CA_DAYS;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomSerial(),
    name: `CN=${escapeCn(input.name)}`,
    notBefore: new Date(now - CERT_NOT_BEFORE_SKEW_MS),
    notAfter: new Date(now + days * MS_PER_DAY),
    signingAlgorithm: SIGN_ALG,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true
      ),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  return {
    certPem: cert.toString('pem'),
    keyPem: await exportPrivateKeyPem(keys.privateKey),
  };
}

export async function issueLeaf(input: {
  ca: CaMaterial;
  sans: string[];
  days: number;
  now?: number;
}): Promise<LeafMaterial> {
  if (input.sans.length < 1) {
    throw new Error('leaf certificate requires at least one SAN');
  }
  const keys = await crypto.subtle.generateKey(EC_ALG, true, ['sign', 'verify']);
  const caCert = new x509.X509Certificate(firstPemCertificate(input.ca.certPem));
  const caKey = await importPrivateKeyPem(input.ca.keyPem);
  const now = input.now ?? Date.now();
  const notBefore = now - CERT_NOT_BEFORE_SKEW_MS;
  const notAfter = Math.min(now + input.days * MS_PER_DAY, caCert.notAfter.getTime());
  if (notAfter <= notBefore) {
    throw new Error('CA is expired; cannot issue a leaf certificate');
  }
  const cn = escapeCn(input.sans[0] ?? 'localhost');
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: randomSerial(),
    subject: `CN=${cn}`,
    issuer: caCert.subject,
    notBefore: new Date(notBefore),
    notAfter: new Date(notAfter),
    signingAlgorithm: SIGN_ALG,
    publicKey: keys.publicKey,
    signingKey: caKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment,
        true
      ),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], true),
      new x509.SubjectAlternativeNameExtension(input.sans.map(toGeneralName), true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  return {
    certPem: cert.toString('pem'),
    keyPem: await exportPrivateKeyPem(keys.privateKey),
  };
}

export async function spkiFingerprint(certPem: string): Promise<string> {
  const cert = new x509.X509Certificate(firstPemCertificate(certPem));
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(cert.publicKey.rawData));
  return Buffer.from(digest).toString('hex');
}

export function parseCertificate(pem: string): ParsedCertificate {
  const cert = new x509.X509Certificate(firstPemCertificate(pem));
  const san = cert.getExtension(x509.SubjectAlternativeNameExtension);
  const sans = san ? san.names.toJSON().map((item) => item.value) : [];
  return {
    subject: cert.subject,
    issuer: cert.issuer,
    sans,
    notBefore: cert.notBefore.getTime(),
    notAfter: cert.notAfter.getTime(),
  };
}

export function firstPemCertificate(pem: string): string {
  const match = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/);
  if (!match) {
    throw new Error('PEM does not contain a certificate');
  }
  return match[0];
}

function toGeneralName(value: string): x509.JsonGeneralName {
  return isIP(value) !== 0 ? { type: 'ip', value } : { type: 'dns', value };
}

function escapeCn(value: string): string {
  return value.replaceAll(',', '\\,');
}

function randomSerial(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[0] = (bytes[0] ?? 0) & 0x7f;
  return Buffer.from(bytes).toString('hex');
}

async function exportPrivateKeyPem(key: CryptoKey): Promise<string> {
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', key);
  return x509.PemConverter.encode(pkcs8, 'PRIVATE KEY');
}

async function importPrivateKeyPem(pem: string): Promise<CryptoKey> {
  const pkcs8 = x509.PemConverter.decodeFirst(pem);
  return crypto.subtle.importKey('pkcs8', pkcs8, EC_ALG, false, ['sign']);
}
