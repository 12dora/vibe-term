import { describe, expect, spyOn, test } from 'bun:test';
import { handleApiRequest } from './index';
import { handleSystemApiRequest } from './system';
import { collectSystemFacts } from './system-facts';
import * as tmuxHealth from './tmux-health';

describe('GET /api/system/facts', () => {
  test('returns a host snapshot with required fields', async () => {
    const res = await handleSystemApiRequest(
      new Request('http://localhost/api/system/facts'),
      '/api/system/facts'
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(typeof body.hostname).toBe('string');
    expect(body.os).toBe(process.platform);
    expect(body.arch).toBe(process.arch);
    expect(typeof body.kernel).toBe('string');
    expect(typeof body.uptimeSec).toBe('number');
    const cpu = body.cpu as { count: number; load1: number; load5: number; load15: number };
    expect(cpu.count).toBeGreaterThan(0);
    expect(typeof cpu.load1).toBe('number');
    const mem = body.mem as { totalBytes: number; freeBytes: number; availableBytes?: number };
    expect(mem.totalBytes).toBeGreaterThan(0);
    expect(mem.freeBytes).toBeGreaterThanOrEqual(0);
    const disk = body.disk as {
      root: { path: string; totalBytes: number; freeBytes: number } | null;
      home: { path: string; totalBytes: number; freeBytes: number } | null;
    };
    expect(disk.root === null || disk.root.path === '/').toBe(true);
    if (disk.root) {
      expect(disk.root.totalBytes).toBeGreaterThan(0);
      expect(disk.root.freeBytes).toBeGreaterThanOrEqual(0);
    }
    if (disk.home) {
      expect(disk.home.path.length).toBeGreaterThan(0);
      expect(disk.home.totalBytes).toBeGreaterThan(0);
    }
    const tmux = body.tmux as { healthy: boolean; reason?: string };
    expect(typeof tmux.healthy).toBe('boolean');
    const docker = body.docker as { present: boolean; socket: boolean };
    expect(typeof docker.present).toBe('boolean');
    expect(typeof docker.socket).toBe('boolean');
    const install = body.install as {
      deployment: string;
      installDir: string | null;
      cliVersion: string | null;
    };
    expect(typeof install.deployment).toBe('string');
    expect(body.memoryProfile === 'standard' || body.memoryProfile === 'small').toBe(true);
    expect(Array.isArray(body.ports) || body.ports === undefined).toBe(true);
    if (Array.isArray(body.ports) && body.ports[0]) {
      const row = body.ports[0] as { purpose: string; proto: string; status: string };
      expect(row.status).toBe('unknown');
      expect(row.proto === 'tcp' || row.proto === 'udp').toBe(true);
    }
  });

  test('is registered on the production route table', async () => {
    const res = await handleApiRequest(
      new Request('http://localhost/api/system/facts'),
      undefined,
      handleSystemApiRequest
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { os?: string };
    expect(body.os).toBe(process.platform);
  });

  test('reuses tmux-health and omits empty optional version strings', async () => {
    const probe = spyOn(tmuxHealth, 'getTmuxHealth').mockResolvedValue({
      healthy: false,
      clientVersion: null,
      clientProvenance: null,
      serverVersion: null,
      reason: 'client_unavailable',
    });
    try {
      const facts = await collectSystemFacts();
      expect(facts.tmux).toEqual({ healthy: false, reason: 'client_unavailable' });
      expect(probe).toHaveBeenCalled();
    } finally {
      probe.mockRestore();
    }
  });

  test('does not dump a listening-socket table', async () => {
    const res = await handleSystemApiRequest(
      new Request('http://localhost/api/system/facts'),
      '/api/system/facts'
    );
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body.listenTcp).toBeUndefined();
    expect(body.ss).toBeUndefined();
    expect(body.sockets).toBeUndefined();
  });
});
