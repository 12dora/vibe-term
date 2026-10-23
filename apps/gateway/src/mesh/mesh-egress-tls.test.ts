import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PeerCertificate } from 'node:tls';
import { meshFetch, setMeshProxyPolicyForTests } from './mesh-egress';
import { resetMeshProxyStoreForTests } from './mesh-proxy-store';

afterEach(() => {
  setMeshProxyPolicyForTests(null);
  resetMeshProxyStoreForTests();
});

async function selfSigned(): Promise<{ key: string; cert: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-egress-tls-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  const proc = Bun.spawn(
    [
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-nodes',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdout: 'ignore', stderr: 'pipe' }
  );
  const code = await proc.exited;
  if (code !== 0) throw new Error(await new Response(proc.stderr).text());
  return {
    dir,
    key: await Bun.file(keyPath).text(),
    cert: await Bun.file(certPath).text(),
  };
}

function sha256Raw(cert: PeerCertificate): string {
  return createHash('sha256').update(cert.raw).digest('hex');
}

describe('meshFetch TLS mapping', () => {
  test('自签目标用 ca 与 pinned checkServerIdentity 能通', async () => {
    setMeshProxyPolicyForTests('direct');
    const pem = await selfSigned();
    const seen: { host: string; pin: string }[] = [];
    const target = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      tls: { cert: pem.cert, key: pem.key },
      fetch() {
        return new Response('tls-ok');
      },
    });
    try {
      const res = await meshFetch(`https://127.0.0.1:${target.port}/healthz`, {
        method: 'GET',
        tls: {
          ca: [pem.cert],
          rejectUnauthorized: true,
          serverName: 'localhost',
          checkServerIdentity(hostname, peer) {
            seen.push({ host: hostname, pin: sha256Raw(peer) });
            return undefined;
          },
        },
      });
      expect(await res.text()).toBe('tls-ok');
      expect(seen).toHaveLength(1);
      expect(seen[0]?.host).toBe('localhost');
      expect(seen[0]?.pin).toHaveLength(64);
    } finally {
      target.stop(true);
      await rm(pem.dir, { recursive: true, force: true });
    }
  });

  test('未给 ca 时自签目标失败', async () => {
    setMeshProxyPolicyForTests('direct');
    const pem = await selfSigned();
    const target = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      tls: { cert: pem.cert, key: pem.key },
      fetch() {
        return new Response('tls-ok');
      },
    });
    try {
      await expect(meshFetch(`https://127.0.0.1:${target.port}/`)).rejects.toBeTruthy();
    } finally {
      target.stop(true);
      await rm(pem.dir, { recursive: true, force: true });
    }
  });

  test('checkServerIdentity 钉错指纹则失败', async () => {
    setMeshProxyPolicyForTests('direct');
    const pem = await selfSigned();
    const target = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      tls: { cert: pem.cert, key: pem.key },
      fetch() {
        return new Response('tls-ok');
      },
    });
    try {
      await expect(
        meshFetch(`https://127.0.0.1:${target.port}/`, {
          tls: {
            ca: [pem.cert],
            serverName: 'localhost',
            checkServerIdentity() {
              return new Error('pin mismatch');
            },
          },
        })
      ).rejects.toMatchObject({ message: expect.stringContaining('pin mismatch') });
    } finally {
      target.stop(true);
      await rm(pem.dir, { recursive: true, force: true });
    }
  });
});
