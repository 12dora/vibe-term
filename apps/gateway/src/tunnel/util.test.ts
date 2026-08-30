import { describe, expect, test } from 'bun:test';
import { resolveTunnelDir } from '../config';
import { defaultTunnelName, normalizeTunnelHostname } from './hostname';
import { LogRingBuffer } from './log-buffer';
import { cloudflaredDownloadSpec, isTunnelPlatformSupported } from './platform';
import {
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
});

describe('redactSecrets', () => {
  test('redacts hex and base64 tokens of at least 32 characters', () => {
    const hex = 'a'.repeat(32);
    const b64 = `${'A'.repeat(40)}==`;
    expect(redactSecrets(`token=${hex} keep`)).toBe('token=*** keep');
    expect(redactSecrets(`secret ${b64}`)).toBe('secret ***');
    expect(redactSecrets('short abcdef1234567890')).toBe('short abcdef1234567890');
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
