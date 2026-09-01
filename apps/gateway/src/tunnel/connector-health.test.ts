import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_METRICS_ADDRS,
  EMPTY_CONNECTOR,
  discoverMetricsAddr,
  extractLastError,
  parseMetricsAddrFromLog,
  probeConnector,
  readLogTail,
} from './connector-health';

const JSON_METRICS =
  '{"level":"info","message":"Starting metrics server on 127.0.0.1:20241/metrics"}';
const TEXT_METRICS = '2026-09-02T12:00:00Z INF Starting metrics server on 127.0.0.1:20243/metrics';

describe('parseMetricsAddrFromLog', () => {
  test('parses JSON and text metrics-server lines', () => {
    expect(parseMetricsAddrFromLog([JSON_METRICS])).toBe('127.0.0.1:20241');
    expect(parseMetricsAddrFromLog([TEXT_METRICS])).toBe('127.0.0.1:20243');
  });

  test('returns the last match when several lines exist', () => {
    expect(parseMetricsAddrFromLog([JSON_METRICS, TEXT_METRICS])).toBe('127.0.0.1:20243');
  });

  test('returns null when no metrics line is present', () => {
    expect(parseMetricsAddrFromLog(['INF Registered tunnel connection connIndex=0'])).toBeNull();
    expect(parseMetricsAddrFromLog([])).toBeNull();
  });
});

describe('discoverMetricsAddr', () => {
  test('prefers spawned addr over argv, log, and the default scan', () => {
    expect(
      discoverMetricsAddr({
        spawnedAddr: '127.0.0.1:41111',
        argvAddr: '127.0.0.1:20241',
        logLines: [JSON_METRICS],
      })
    ).toEqual(['127.0.0.1:41111']);
  });

  test('falls back to argv --metrics then log then the default range', () => {
    expect(
      discoverMetricsAddr({
        spawnedAddr: null,
        argvAddr: '127.0.0.1:19999',
        logLines: [JSON_METRICS],
      })
    ).toEqual(['127.0.0.1:19999']);
    expect(
      discoverMetricsAddr({
        spawnedAddr: null,
        argvAddr: null,
        logLines: [JSON_METRICS],
      })
    ).toEqual(['127.0.0.1:20241']);
    expect(discoverMetricsAddr({ spawnedAddr: null, argvAddr: null, logLines: [] })).toEqual([
      ...DEFAULT_METRICS_ADDRS,
    ]);
  });
});

describe('probeConnector', () => {
  test('treats HTTP 200 JSON /ready as reachable', async () => {
    const result = await probeConnector('127.0.0.1:20241', async (input) => {
      expect(String(input)).toBe('http://127.0.0.1:20241/ready');
      return Response.json({
        status: 200,
        readyConnections: 4,
        connectorId: 'conn-1',
      });
    });
    expect(result.reachable).toBe(true);
    expect(result.metricsAddr).toBe('127.0.0.1:20241');
    expect(result.readyConnections).toBe(4);
    expect(result.connectorId).toBe('conn-1');
    expect(result.checkedAt).toBeTruthy();
  });

  test('treats HTTP 503 JSON /ready with zero connections as reachable', async () => {
    const result = await probeConnector('127.0.0.1:20241', async () =>
      Response.json({ status: 503, readyConnections: 0, connectorId: 'conn-1' }, { status: 503 })
    );
    expect(result.reachable).toBe(true);
    expect(result.readyConnections).toBe(0);
    expect(result.connectorId).toBe('conn-1');
  });

  test('marks a single refused or non-JSON addr as reachable false', async () => {
    const refused = await probeConnector('127.0.0.1:9', async () => {
      throw new Error('connection refused');
    });
    expect(refused.reachable).toBe(false);
    expect(refused.metricsAddr).toBe('127.0.0.1:9');
    expect(refused.readyConnections).toBeNull();

    const nonJson = await probeConnector(
      '127.0.0.1:20241',
      async () => new Response('nope', { status: 200 })
    );
    expect(nonJson.reachable).toBe(false);
    expect(nonJson.metricsAddr).toBe('127.0.0.1:20241');
  });

  test('times out a hanging /ready fetch', async () => {
    const result = await probeConnector(
      '127.0.0.1:20241',
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      { timeoutMs: 20 }
    );
    expect(result.reachable).toBe(false);
    expect(result.metricsAddr).toBe('127.0.0.1:20241');
  });

  test('scanning uses the first addr that answers and null when none do', async () => {
    const tried: string[] = [];
    const hit = await probeConnector(
      ['127.0.0.1:20241', '127.0.0.1:20242', '127.0.0.1:20243'],
      async (input) => {
        const url = String(input);
        tried.push(url);
        if (url.includes('20242')) {
          return Response.json({ readyConnections: 2, connectorId: 'b' });
        }
        throw new Error('connection refused');
      }
    );
    expect(tried).toEqual(['http://127.0.0.1:20241/ready', 'http://127.0.0.1:20242/ready']);
    expect(hit.reachable).toBe(true);
    expect(hit.metricsAddr).toBe('127.0.0.1:20242');
    expect(hit.readyConnections).toBe(2);

    const miss = await probeConnector(['127.0.0.1:20241', '127.0.0.1:20242'], async () => {
      throw new Error('connection refused');
    });
    expect(miss.reachable).toBeNull();
    expect(miss.metricsAddr).toBeNull();
    expect(miss.readyConnections).toBeNull();
    expect(miss.connectorId).toBeNull();
  });
});

describe('extractLastError', () => {
  test('prefers JSON error field then message, and text ERR lines', () => {
    const token = 'a'.repeat(32);
    expect(
      extractLastError([
        '{"level":"info","message":"ok"}',
        `{"level":"error","error":"TLS handshake ${token}","message":"Unable to establish connection with Cloudflare edge"}`,
        'INF Registered tunnel connection connIndex=0',
      ])
    ).toBe('TLS handshake ***');

    expect(
      extractLastError([
        '{"level":"error","message":"Unable to establish connection with Cloudflare edge"}',
      ])
    ).toBe('Unable to establish connection with Cloudflare edge');

    expect(
      extractLastError([
        '2026-09-02T12:00:00Z INF hello',
        '2026-09-02T12:00:01Z ERR Unable to establish connection with Cloudflare edge',
      ])
    ).toBe('Unable to establish connection with Cloudflare edge');
  });

  test('returns null when no error line exists', () => {
    expect(extractLastError(['INF Starting metrics server on 127.0.0.1:20241/metrics'])).toBeNull();
    expect(extractLastError([])).toBeNull();
  });
});

describe('readLogTail', () => {
  test('reads the last bytes, drops a partial first line, and redacts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tmex-logtail-'));
    try {
      const path = join(dir, 'cloudflared.log');
      const secret = 'b'.repeat(32);
      const body = [
        'DROPPED-PARTIAL',
        'keep-one',
        `token ${secret}`,
        'keep-three',
        'keep-four',
      ].join('\n');
      await writeFile(path, body, 'utf8');
      const prefix = 'DROPPED-PARTIAL\n';
      const maxBytes = Buffer.byteLength(body, 'utf8') - Buffer.byteLength('DROP', 'utf8');
      const lines = await readLogTail(path, { maxBytes, maxLines: 200 });
      expect(lines[0]).not.toContain('DROPPED');
      expect(prefix.length).toBeGreaterThan(0);
      expect(lines.join('\n')).toContain('keep-one');
      expect(lines.join('\n')).toContain('keep-four');
      expect(lines.join('\n')).toContain('***');
      expect(lines.join('\n')).not.toContain(secret);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('keeps the first line when the file is fully read and returns [] on missing files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tmex-logtail-full-'));
    try {
      const path = join(dir, 'cloudflared.log');
      await writeFile(path, 'alpha\nbeta\n', 'utf8');
      expect(await readLogTail(path, { maxBytes: 64 * 1024, maxLines: 200 })).toEqual([
        'alpha',
        'beta',
      ]);
      expect(await readLogTail(join(dir, 'missing.log'), { maxBytes: 64, maxLines: 10 })).toEqual(
        []
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('EMPTY_CONNECTOR', () => {
  test('is the unverified placeholder', () => {
    expect(EMPTY_CONNECTOR).toEqual({
      reachable: null,
      metricsAddr: null,
      readyConnections: null,
      connectorId: null,
      checkedAt: null,
      lastError: null,
    });
  });
});
