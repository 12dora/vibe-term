import { describe, expect, test } from 'bun:test';
import { createCa, issueLeaf, spkiFingerprint } from '../tls/cert-authority';
import {
  MAX_CA_RESPONSE_BYTES,
  parseAndValidateCaPem,
  parseStrictSinglePemCertificate,
  readBoundedResponseText,
} from './pem';

describe('parseStrictSinglePemCertificate', () => {
  test('accepts one certificate with surrounding whitespace', () => {
    const pem = '  -----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n  ';
    expect(parseStrictSinglePemCertificate(pem)).toContain('BEGIN CERTIFICATE');
  });

  test('rejects concatenated certificates', () => {
    const pem =
      '-----BEGIN CERTIFICATE-----\nAAA=\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nBBB=\n-----END CERTIFICATE-----\n';
    expect(() => parseStrictSinglePemCertificate(pem)).toThrow(/single PEM certificate/);
  });

  test('rejects trailing garbage', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nAAA=\n-----END CERTIFICATE-----\nnot-a-cert\n';
    expect(() => parseStrictSinglePemCertificate(pem)).toThrow(/single PEM certificate/);
  });

  test('rejects non-base64 bodies', () => {
    const pem = '-----BEGIN CERTIFICATE-----\n***not-base64***\n-----END CERTIFICATE-----\n';
    expect(() => parseStrictSinglePemCertificate(pem)).toThrow(/single PEM certificate/);
  });
});

describe('parseAndValidateCaPem', () => {
  test('accepts a real CA and returns canonical PEM plus SPKI fingerprint', async () => {
    const ca = await createCa({ name: 'tmex-test' });
    const parsed = await parseAndValidateCaPem(`\n${ca.certPem}\n`);
    expect(parsed.canonicalPem).toContain('BEGIN CERTIFICATE');
    expect(parsed.fingerprint).toBe(await spkiFingerprint(ca.certPem));
    expect(parsed.fingerprint).toBe(await spkiFingerprint(parsed.canonicalPem));
  });

  test('rejects a non-CA leaf even when the PEM is well-formed', async () => {
    const ca = await createCa({ name: 'tmex-test' });
    const leaf = await issueLeaf({ ca, sans: ['127.0.0.1'], days: 1 });
    await expect(parseAndValidateCaPem(leaf.certPem)).rejects.toThrow(/not a CA/);
  });

  test('rejects real CA concatenated with an attacker CA', async () => {
    const ca = await createCa({ name: 'real' });
    const attacker = await createCa({ name: 'attacker' });
    await expect(parseAndValidateCaPem(`${ca.certPem}\n${attacker.certPem}`)).rejects.toThrow(
      /single PEM certificate/
    );
  });
});

describe('readBoundedResponseText', () => {
  test('rejects bodies larger than 64 KiB', async () => {
    const response = new Response('x'.repeat(MAX_CA_RESPONSE_BYTES + 1));
    await expect(readBoundedResponseText(response)).rejects.toThrow('ca_response_too_large');
  });

  test('rejects Content-Length above the cap without reading the body', async () => {
    const response = new Response(
      new ReadableStream({
        start() {
          // never enqueues; the header cap must reject first
        },
      }),
      { headers: { 'content-length': String(MAX_CA_RESPONSE_BYTES + 1) } }
    );
    await expect(readBoundedResponseText(response)).rejects.toThrow('ca_response_too_large');
  });

  test('reads a small body', async () => {
    const response = new Response('hello');
    expect(await readBoundedResponseText(response)).toBe('hello');
  });
});
