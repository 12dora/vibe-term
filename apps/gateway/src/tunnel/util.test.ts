import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { originUrlFromBindHost, resolveTunnelDir } from '../config';
import { TunnelError, tunnelHttpStatus } from './errors';
import { FakeSpawner } from './fake-spawn';
import { defaultTunnelName, normalizeTunnelHostname, normalizeTunnelName } from './hostname';
import { LogRingBuffer } from './log-buffer';
import { cloudflaredDownloadSpec, isTunnelPlatformSupported } from './platform';
import {
  CloudflaredProvider,
  credentialsPathFor,
  parseCreateOutput,
  parseLoginUrl,
  parseQuickUrl,
  parseTunnelList,
  parseVersion,
} from './provider';
import { redactSecrets } from './redact';

describe('normalizeTunnelHostname', () => {
  test('accepts RFC 1123 lowercase names and rejects junk', () => {
    expect(normalizeTunnelHostname('Tmex.Example.COM')).toBe('tmex.example.com');
    expect(normalizeTunnelHostname('localhost')).toBe('localhost');
    expect(normalizeTunnelHostname('')).toBeNull();
    expect(normalizeTunnelHostname('-bad.com')).toBeNull();
    expect(normalizeTunnelHostname('not_a_host')).toBeNull();
  });

  test('default tunnel name uses the first label', () => {
    expect(defaultTunnelName('remote.example.com')).toBe('tmex-remote');
  });

  test('default tunnel name stays within the identifier length limit', () => {
    const long = `${'a'.repeat(63)}.example.com`;
    const name = defaultTunnelName(long);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(normalizeTunnelName(name)).toBe(name);
  });
});

describe('normalizeTunnelName', () => {
  test('accepts cloudflared-safe identifiers and rejects traversal', () => {
    expect(normalizeTunnelName('tmex-remote')).toBe('tmex-remote');
    expect(normalizeTunnelName('Tmex_Remote1')).toBe('tmex_remote1');
    expect(normalizeTunnelName('../../x')).toBeNull();
    expect(normalizeTunnelName('/abs')).toBeNull();
    expect(normalizeTunnelName('foo\nbar')).toBeNull();
    expect(normalizeTunnelName('a'.repeat(64))).toBeNull();
    expect(normalizeTunnelName('a'.repeat(63))).toBe('a'.repeat(63));
    expect(normalizeTunnelName('')).toBeNull();
  });
});

describe('redactSecrets', () => {
  test('redacts hex and base64 tokens of at least 32 characters', () => {
    const hex = 'a'.repeat(32);
    const b64 = `${'A'.repeat(40)}==`;
    expect(redactSecrets(`token=${hex} keep`)).toBe('token=*** keep');
    expect(redactSecrets(`secret ${b64}`)).toBe('secret ***');
    expect(redactSecrets('short abcdef1234567890')).toBe('short abcdef1234567890');
  });

  test('redacts Cloudflare authorization URLs before they are stored', () => {
    const dash = 'Please visit https://dash.cloudflare.com/argotunnel?aud=xyz&token=abc keep';
    expect(redactSecrets(dash)).not.toContain('aud=xyz');
    expect(redactSecrets(dash)).not.toContain('token=abc');
    expect(redactSecrets(dash)).toContain('https://dash.cloudflare.com/***');
    const other = 'open https://example.com/login?token=secret-value now';
    expect(redactSecrets(other)).not.toContain('secret-value');
    expect(redactSecrets(other)).toContain('token=***');
  });

  test('masks URL userinfo and every query-parameter value', () => {
    expect(redactSecrets('redis://admin:s3cr3tP@ss@10.0.0.5:6379/db')).toBe(
      'redis://***@10.0.0.5:6379/db'
    );
    expect(redactSecrets('https://user:pass@example.com/path?foo=bar&id=1')).toBe(
      'https://***@example.com/path?foo=***&id=***'
    );
  });

  test('masks short tokens, base64url, Bearer/Basic, and secret key=value pairs', () => {
    expect(redactSecrets('token=abc password=hunter2 api_key=k jwt=short')).toBe(
      'token=*** password=*** api_key=*** jwt=***'
    );
    const b64url = `eyJhbGciOiJIUzI1NiJ9.${'ab-_CD'.repeat(6)}`;
    expect(redactSecrets(`Authorization: Bearer ${b64url}`)).toContain('Bearer ***');
    expect(redactSecrets(`Authorization: Bearer ${b64url}`)).not.toContain(b64url);
    expect(redactSecrets('Authorization: Basic dXNlcjpwYXNz')).toBe('Authorization: Basic ***');
    expect(redactSecrets('cookie=sid123 session=abc credential=x')).toBe(
      'cookie=*** session=*** credential=***'
    );
  });

  test('masks JSON-format and text-format cloudflared secret lines', () => {
    const jsonLine =
      '{"level":"error","token":"shorttok","password":"hunter2","error":"token=abc"}';
    const jsonOut = redactSecrets(jsonLine);
    expect(jsonOut).not.toContain('shorttok');
    expect(jsonOut).not.toContain('hunter2');
    expect(jsonOut).not.toContain('token=abc');
    expect(jsonOut).toContain('"token":"***"');
    expect(jsonOut).toContain('"password":"***"');
    expect(jsonOut).toContain('token=***');
    const textLine =
      '2026-09-02T12:00:01Z ERR Unable to establish connection token=abc api-key=xyz';
    const textOut = redactSecrets(textLine);
    expect(textOut).not.toContain('token=abc');
    expect(textOut).not.toContain('xyz');
    expect(textOut).toContain('token=***');
    expect(textOut).toContain('api-key=***');
  });
});

describe('LogRingBuffer', () => {
  test('keeps the last 200 redacted lines', () => {
    const buf = new LogRingBuffer(3);
    buf.push(`one ${'a'.repeat(32)}`);
    buf.push('two');
    buf.push('three');
    buf.push('four');
    expect(buf.snapshot()).toEqual(['two', 'three', 'four']);
  });
});

describe('platform', () => {
  test('supports darwin/linux x64/arm64 only', () => {
    expect(isTunnelPlatformSupported('darwin', 'arm64')).toBe(true);
    expect(isTunnelPlatformSupported('linux', 'x64')).toBe(true);
    expect(isTunnelPlatformSupported('win32', 'x64')).toBe(false);
    expect(isTunnelPlatformSupported('darwin', 'ia32')).toBe(false);
  });

  test('download URL uses amd64 and darwin tgz', () => {
    expect(cloudflaredDownloadSpec('linux', 'x64')).toEqual({
      url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',
      fileName: 'cloudflared-linux-amd64',
      tgz: false,
    });
    expect(cloudflaredDownloadSpec('darwin', 'arm64').fileName).toBe(
      'cloudflared-darwin-arm64.tgz'
    );
    expect(cloudflaredDownloadSpec('darwin', 'arm64').tgz).toBe(true);
  });
});

describe('cloudflared output parsers', () => {
  test('parses version', () => {
    expect(parseVersion('cloudflared version 2025.8.1 (built 2025-08-01T00:00:00Z)')).toBe(
      '2025.8.1'
    );
    expect(parseVersion('nope')).toBeNull();
  });

  test('parses login URL from mixed output', () => {
    const out = 'Please visit:\nhttps://dash.cloudflare.com/argotunnel?aud=abc\nLeave running\n';
    expect(parseLoginUrl(out)).toBe('https://dash.cloudflare.com/argotunnel?aud=abc');
  });

  test('parses create id and credentials path', () => {
    const out = [
      'Tunnel credentials written to /tmp/tunnel/foo.json. Keep this file secret.',
      'Created tunnel tmex-foo with id 550e8400-e29b-41d4-a716-446655440000',
    ].join('\n');
    expect(parseCreateOutput(out)).toEqual({
      tunnelId: '550e8400-e29b-41d4-a716-446655440000',
      credentialsPath: '/tmp/tunnel/foo.json',
    });
  });

  test('parses trycloudflare URL and list json', () => {
    expect(parseQuickUrl('Visit https://random-words-123.trycloudflare.com now')).toBe(
      'https://random-words-123.trycloudflare.com'
    );
    expect(
      parseTunnelList(JSON.stringify([{ id: 'abc-def', name: 'tmex-foo', created_at: 'x' }]))
    ).toEqual([{ id: 'abc-def', name: 'tmex-foo' }]);
  });
});

describe('resolveTunnelDir', () => {
  test('uses TMEX_TUNNEL_DIR or a tunnel directory next to the sqlite file', () => {
    expect(resolveTunnelDir({ TMEX_TUNNEL_DIR: '/data/tun' })).toBe('/data/tun');
    expect(
      resolveTunnelDir({ DATABASE_URL: '/var/tmex/tmex.db', TMEX_TUNNEL_DIR: undefined })
    ).toBe('/var/tmex/tunnel');
  });
});

describe('originUrlFromBindHost', () => {
  test('maps wildcard and specific bind hosts to a loopback origin URL', () => {
    expect(originUrlFromBindHost('0.0.0.0', 19883)).toBe('http://127.0.0.1:19883');
    expect(originUrlFromBindHost('::', 19883)).toBe('http://[::1]:19883');
    expect(originUrlFromBindHost('[::]', 9443)).toBe('http://[::1]:9443');
    expect(originUrlFromBindHost('127.0.0.1', 80)).toBe('http://127.0.0.1:80');
    expect(originUrlFromBindHost('::1', 8080)).toBe('http://[::1]:8080');
    expect(originUrlFromBindHost('192.168.1.10', 9663)).toBe('http://192.168.1.10:9663');
    expect(originUrlFromBindHost('2001:db8::1', 9663)).toBe('http://[2001:db8::1]:9663');
  });
});

describe('tunnelHttpStatus', () => {
  test('maps connector_down to 503', () => {
    expect(tunnelHttpStatus('connector_down')).toBe(503);
  });
});

describe('CloudflaredProvider metrics flag', () => {
  test('injects --metrics from pickPort on named and quick spawn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tmex-tun-metrics-'));
    const spawner = new FakeSpawner();
    const provider = new CloudflaredProvider(spawner.spawn, dir, async () => 4242);
    const quick = await provider.spawnQuickRun('/usr/bin/cloudflared', 'http://127.0.0.1:19883');
    expect(quick.metricsAddr).toBe('127.0.0.1:4242');
    expect(spawner.calls[0]?.args).toEqual([
      'tunnel',
      '--no-autoupdate',
      '--metrics',
      '127.0.0.1:4242',
      '--url',
      'http://127.0.0.1:19883',
    ]);
    const named = await provider.spawnNamedRun('/usr/bin/cloudflared', join(dir, 'config.yml'));
    expect(named.metricsAddr).toBe('127.0.0.1:4242');
    expect(spawner.calls[1]?.args).toContain('--metrics');
    expect(spawner.calls[1]?.args).toContain('127.0.0.1:4242');
    expect(spawner.calls[1]?.args).toContain('run');
  });
});

describe('credentialsPathFor', () => {
  test('resolves inside tunnelDir and rejects path traversal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tmex-tun-cred-'));
    expect(credentialsPathFor(dir, 'tmex-ok')).toBe(resolve(dir, 'tmex-ok.json'));
    for (const name of ['../../x', '/abs', 'foo/bar']) {
      expect(() => credentialsPathFor(dir, name)).toThrow(TunnelError);
    }
  });
});
