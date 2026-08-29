import { describe, expect, test } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import {
  CERT_NOT_BEFORE_SKEW_MS,
  createCa,
  issueLeaf,
  parseCertificate,
  spkiFingerprint,
} from './cert-authority';

describe('cert-authority', () => {
  test('issues an EC P-256 CA and leaf that node:crypto can verify', async () => {
    const ca = await createCa({ name: 'tmex test CA' });
    const leaf = await issueLeaf({
      ca,
      sans: ['localhost', '127.0.0.1', '::1'],
      days: 398,
    });

    const caCert = new X509Certificate(ca.certPem);
    const leafCert = new X509Certificate(leaf.certPem);
    expect(leafCert.verify(caCert.publicKey)).toBe(true);
    expect(leafCert.checkHost('localhost')).toBe('localhost');

    const parsedCa = parseCertificate(ca.certPem);
    expect(parsedCa.subject.toLowerCase()).toContain('tmex test ca');
    expect(parsedCa.issuer).toBe(parsedCa.subject);
    const tenYearsMs = 10 * 365 * 24 * 60 * 60 * 1000;
    expect(parsedCa.notAfter - parsedCa.notBefore).toBeGreaterThan(
      tenYearsMs - 2 * 24 * 60 * 60 * 1000
    );

    const parsedLeaf = parseCertificate(leaf.certPem);
    expect(parsedLeaf.sans).toEqual(expect.arrayContaining(['localhost', '127.0.0.1', '::1']));
    expect(parsedLeaf.issuer.toLowerCase()).toContain('tmex test ca');
    const daysMs = 398 * 24 * 60 * 60 * 1000;
    expect(parsedLeaf.notAfter - parsedLeaf.notBefore).toBeGreaterThan(
      daysMs - 24 * 60 * 60 * 1000
    );
    expect(parsedLeaf.notAfter - parsedLeaf.notBefore).toBeLessThan(daysMs + 24 * 60 * 60 * 1000);

    const fingerprint = await spkiFingerprint(ca.certPem);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).not.toBe(await spkiFingerprint(leaf.certPem));
  });

  test('backdates notBefore by 5 minutes for CA and leaf', async () => {
    const now = Date.now();
    const ca = await createCa({ name: 'skew CA', now });
    const leaf = await issueLeaf({ ca, sans: ['localhost'], days: 398, now });
    const parsedCa = parseCertificate(ca.certPem);
    const parsedLeaf = parseCertificate(leaf.certPem);
    expect(now - parsedCa.notBefore).toBeGreaterThanOrEqual(CERT_NOT_BEFORE_SKEW_MS - 2000);
    expect(now - parsedCa.notBefore).toBeLessThan(CERT_NOT_BEFORE_SKEW_MS + 2000);
    expect(now - parsedLeaf.notBefore).toBeGreaterThanOrEqual(CERT_NOT_BEFORE_SKEW_MS - 2000);
    expect(now - parsedLeaf.notBefore).toBeLessThan(CERT_NOT_BEFORE_SKEW_MS + 2000);
  });

  test('caps leaf notAfter to the CA notAfter', async () => {
    const now = Date.now();
    const ca = await createCa({ name: 'short CA', days: 10, now });
    const leaf = await issueLeaf({ ca, sans: ['localhost'], days: 398, now });
    const parsedCa = parseCertificate(ca.certPem);
    const parsedLeaf = parseCertificate(leaf.certPem);
    expect(parsedLeaf.notAfter).toBeLessThanOrEqual(parsedCa.notAfter);
    const tenDaysMs = 10 * 24 * 60 * 60 * 1000;
    expect(parsedLeaf.notAfter - now).toBeLessThanOrEqual(tenDaysMs);
    expect(parsedLeaf.notAfter - now).toBeGreaterThan(tenDaysMs - 24 * 60 * 60 * 1000);
  });
});
