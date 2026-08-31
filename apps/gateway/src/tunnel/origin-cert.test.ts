import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultOriginCertPath,
  ensureManagedOriginCert,
  isOriginCertPresent,
  parseArgoTunnelCert,
} from './origin-cert';

function argoPem(payload: Record<string, unknown>, wrap = false): string {
  const raw = Buffer.from(JSON.stringify(payload)).toString('base64');
  const body = wrap ? raw.replace(/(.{64})/g, '$1\n') : raw;
  return `${'-----BEGIN ARGO TUNNEL TOKEN-----\n'}${body}\n-----END ARGO TUNNEL TOKEN-----\n`;
}

describe('parseArgoTunnelCert', () => {
  test('parses modern cloudflared ARGO TUNNEL TOKEN JSON', () => {
    const pem = argoPem(
      { zoneID: 'zone-1', accountID: 'acct-from-cert', apiToken: 'cert-api-token' },
      true
    );
    expect(parseArgoTunnelCert(pem)).toEqual({
      accountId: 'acct-from-cert',
      apiToken: 'cert-api-token',
      zoneId: 'zone-1',
    });
  });

  test('returns null for classic origin cert or garbage', () => {
    expect(
      parseArgoTunnelCert('-----BEGIN CERTIFICATE-----\nMII\n-----END CERTIFICATE-----\n')
    ).toBeNull();
    expect(parseArgoTunnelCert('')).toBeNull();
    expect(parseArgoTunnelCert(null)).toBeNull();
  });
});

describe('ensureManagedOriginCert', () => {
  test('copies default-path cert into tunnelDir at 0600 and never deletes the original', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmex-cert-'));
    try {
      const homeDir = join(root, 'home');
      const tunnelDir = join(root, 'tunnel');
      mkdirSync(join(homeDir, '.cloudflared'), { recursive: true });
      const fallback = defaultOriginCertPath(homeDir);
      writeFileSync(fallback, 'DEFAULT-CERT', { mode: 0o600 });
      chmodSync(fallback, 0o600);
      expect(isOriginCertPresent(tunnelDir, homeDir)).toBe(true);
      expect(ensureManagedOriginCert(tunnelDir, homeDir)).toBe(true);
      const managed = join(tunnelDir, 'cert.pem');
      expect(readFileSync(managed, 'utf8')).toBe('DEFAULT-CERT');
      expect(statSync(managed).mode & 0o777).toBe(0o600);
      expect(existsSync(fallback)).toBe(true);
      expect(readFileSync(fallback, 'utf8')).toBe('DEFAULT-CERT');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('returns false when neither path exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmex-cert-empty-'));
    try {
      expect(ensureManagedOriginCert(join(root, 't'), join(root, 'h'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
