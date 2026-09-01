import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getRemoteUpgradeJob,
  resetRemoteUpgradeJobsForTests,
  startRemoteUpgradeJob,
  waitForRemoteUpgradeJob,
} from './remote-upgrade-job';
import type { AuthorizedUpgradeForward } from './upgrade-service';

const tempDirs: string[] = [];

afterEach(() => {
  resetRemoteUpgradeJobsForTests();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempFile(bytes: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmex-job-pkg-'));
  tempDirs.push(dir);
  const path = join(dir, 'tmex-cli-9.9.9.tgz');
  writeFileSync(path, bytes);
  return path;
}

function authed(nodeId: string): Request {
  return new Request('http://localhost/api/mesh/nodes/x/upgrade', {
    method: 'POST',
    headers: { cookie: `tmex_s_${nodeId}=remote-sid` },
  });
}

describe('RemoteUpgradeJob', () => {
  test('downloads, PUTs the tarball, POSTs staged, and hands off', async () => {
    const nodeId = 'aa'.repeat(16);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const path = tempFile(bytes);
    const sha256 = 'ab'.repeat(32);
    const calls: Array<{
      method: string;
      path: string;
      body?: unknown;
      headers?: Record<string, string>;
    }> = [];
    const forward: AuthorizedUpgradeForward = {
      async forwardAuthorizedHttp(_req, input) {
        const raw = input.rawBody ? await new Response(input.rawBody).bytes() : null;
        calls.push({
          method: input.method,
          path: input.path,
          body: input.body,
          headers: input.headers,
        });
        if (input.method === 'PUT') {
          expect(raw).toEqual(bytes);
          expect(input.headers?.['content-type']).toBe('application/octet-stream');
          expect(input.headers?.['content-length']).toBe(String(bytes.byteLength));
          expect(input.query).toContain('version=9.9.9');
          expect(input.query).toContain(`sha256=${sha256}`);
          return new Response(
            JSON.stringify({ version: '9.9.9', sha256, bytes: bytes.byteLength }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }
          );
        }
        return new Response(
          JSON.stringify({
            state: 'downloading',
            targetVersion: '9.9.9',
            error: null,
            startedAt: '2026-09-01T00:00:00.000Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      },
    };

    const started = startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward,
      download: async () => ({ path, sha256, bytes: bytes.byteLength }),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('expected start');
    expect(started.snapshot.state).toBe('running');
    expect(getRemoteUpgradeJob(nodeId)?.state).toBe('running');

    const done = await waitForRemoteUpgradeJob(nodeId);
    expect(done.state).toBe('handed-off');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'PUT /api/system/upgrade/package',
      'POST /api/system/upgrade',
    ]);
    expect(calls[1]?.body).toEqual({ version: '9.9.9', source: 'staged', sha256 });
  });

  test('two nodes share one download', async () => {
    const a = '11'.repeat(16);
    const b = '22'.repeat(16);
    const bytes = new Uint8Array([9]);
    const path = tempFile(bytes);
    let downloads = 0;
    const download = async () => {
      downloads += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { path, sha256: 'cd'.repeat(32), bytes: 1 };
    };
    const forward: AuthorizedUpgradeForward = {
      async forwardAuthorizedHttp() {
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    };
    startRemoteUpgradeJob({
      nodeId: a,
      version: '1.0.0',
      req: authed(a),
      forward,
      download,
    });
    startRemoteUpgradeJob({
      nodeId: b,
      version: '1.0.0',
      req: authed(b),
      forward,
      download,
    });
    await Promise.all([waitForRemoteUpgradeJob(a), waitForRemoteUpgradeJob(b)]);
    expect(downloads).toBe(1);
  });

  test('download failure records which step failed', async () => {
    const nodeId = 'bb'.repeat(16);
    const started = startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward: {
        async forwardAuthorizedHttp() {
          throw new Error('should not forward');
        },
      },
      download: async () => {
        throw new Error('GitHub release tarball HTTP 403');
      },
    });
    expect(started.ok).toBe(true);
    const done = await waitForRemoteUpgradeJob(nodeId);
    expect(done.state).toBe('failed');
    expect(done.error).toMatch(/download failed/i);
    expect(done.error).toContain('HTTP 403');
  });

  test('push failure records status and upstream code', async () => {
    const nodeId = 'cc'.repeat(16);
    const path = tempFile(new Uint8Array([1]));
    const started = startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward: {
        async forwardAuthorizedHttp(_req, input) {
          if (input.method === 'PUT') {
            return new Response(JSON.stringify({ code: 'PACKAGE_SHA256_MISMATCH' }), {
              status: 400,
              headers: { 'content-type': 'application/json' },
            });
          }
          throw new Error(`unexpected ${input.method}`);
        },
      },
      download: async () => ({ path, sha256: 'ee'.repeat(32), bytes: 1 }),
    });
    expect(started.ok).toBe(true);
    const done = await waitForRemoteUpgradeJob(nodeId);
    expect(done.state).toBe('failed');
    expect(done.error).toMatch(/push failed/i);
    expect(done.error).toContain('400');
    expect(done.error).toContain('PACKAGE_SHA256_MISMATCH');
  });

  test('a second start while a job is running is UPGRADE_IN_PROGRESS', async () => {
    const nodeId = 'dd'.repeat(16);
    const path = tempFile(new Uint8Array([1]));
    let releaseDownload!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const forward: AuthorizedUpgradeForward = {
      async forwardAuthorizedHttp() {
        return new Response('{}', { status: 200 });
      },
    };
    const first = startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward,
      download: async () => {
        await gate;
        return { path, sha256: 'ff'.repeat(32), bytes: 1 };
      },
    });
    expect(first.ok).toBe(true);
    const second = startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward,
      download: async () => ({ path, sha256: 'ff'.repeat(32), bytes: 1 }),
    });
    expect(second).toEqual({ ok: false, code: 'UPGRADE_IN_PROGRESS' });
    releaseDownload();
    await waitForRemoteUpgradeJob(nodeId);
  });
});
