import { describe, expect, test } from 'bun:test';
import {
  ExternalTunnelDetector,
  hostnamesFromLog,
  parseArgv,
  parseCloudflaredConfigYml,
  parsePlistProgramArguments,
  parseProcessList,
  parseTunnelToken,
  serviceHitsOrigin,
} from './external-detect';

describe('external tunnel parsing', () => {
  test('parses token-file / logfile flags and token payload without exposing the secret', () => {
    const parsed = parseProcessList(
      '42 /opt/homebrew/bin/cloudflared tunnel --logfile /tmp/cf.log run --token-file /tmp/token\n'
    );
    expect(parsed[0]).toMatchObject({
      pid: '42',
      tokenFile: '/tmp/token',
    });
    const payload = parseTunnelToken(
      Buffer.from(JSON.stringify({ a: 'acct', t: 'tun-id', s: 'super-secret' })).toString('base64')
    );
    expect(payload).toEqual({ accountId: 'acct', tunnelId: 'tun-id' });
    expect(JSON.stringify(payload)).not.toContain('super-secret');
  });

  test('parses config.yml ingress and keeps hostnames whose service hits originPort', () => {
    const yml = parseCloudflaredConfigYml(`
tunnel: 550e8400-e29b-41d4-a716-446655440000
credentials-file: /tmp/cred.json
ingress:
  - hostname: tmex.example.com
    service: http://127.0.0.1:19883
  - hostname: other.example.com
    service: http://127.0.0.1:80
  - service: http_status:404
`);
    expect(yml.tunnel).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(yml.credentialsFile).toBe('/tmp/cred.json');
    expect(
      yml.ingress.filter((row) => serviceHitsOrigin(row.service, 19883)).map((r) => r.hostname)
    ).toEqual(['tmex.example.com']);
  });

  test('parses launchd ProgramArguments and logfile ingress JSON', () => {
    const args = parsePlistProgramArguments(`<?xml version="1.0"?>
<plist><dict>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/cloudflared</string>
    <string>tunnel</string>
    <string>--logfile</string>
    <string>/tmp/cf.log</string>
    <string>run</string>
    <string>--token-file</string>
    <string>/tmp/token</string>
  </array>
</dict></plist>`);
    expect(args[0]).toContain('cloudflared');
    expect(args).toContain('--token-file');
    const hosts = hostnamesFromLog(
      'noise\n{"ingress":[{"hostname":"old.example","service":"http://127.0.0.1:1"}]}\nfinal {"ingress":[{"hostname":"tmex.example.com","service":"http://127.0.0.1:19883"}]}\n',
      19883
    );
    expect(hosts).toEqual(['tmex.example.com']);
  });

  test('keeps launchd token-file paths that contain spaces', () => {
    const args = parsePlistProgramArguments(`<?xml version="1.0"?>
<plist><dict>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/cloudflared</string>
    <string>tunnel</string>
    <string>--logfile</string>
    <string>/Users/me/Library/Application Support/tmex-cloudflared/cloudflared.log</string>
    <string>run</string>
    <string>--token-file</string>
    <string>/Users/me/Library/Application Support/tmex-cloudflared/token</string>
  </array>
</dict></plist>`);
    expect(parseArgv(args).tokenFile).toBe(
      '/Users/me/Library/Application Support/tmex-cloudflared/token'
    );
  });

  test('detector prefers launchd + sibling hostname file and caches for 30s', async () => {
    const files = new Map<string, string>([
      [
        '/Users/me/Library/LaunchAgents/com.tmex.cloudflared.plist',
        `<plist><dict><key>ProgramArguments</key><array>
          <string>/opt/homebrew/bin/cloudflared</string><string>tunnel</string>
          <string>--logfile</string><string>/tmp/cf.log</string>
          <string>run</string><string>--token-file</string><string>/tmp/tmex-cf/token</string>
        </array></dict></plist>`,
      ],
      [
        '/tmp/tmex-cf/token',
        Buffer.from(JSON.stringify({ a: 'acct', t: 'tid', s: 'secret' })).toString('base64'),
      ],
      ['/tmp/tmex-cf/hostname', 'tmex.example.org\n'],
      ['/tmp/tmex-cf/tunnel-id', 'tid\n'],
    ]);
    const dirs = new Map<string, string[]>([
      ['/Users/me/Library/LaunchAgents', ['com.tmex.cloudflared.plist']],
      ['/Library/LaunchDaemons', []],
    ]);
    let now = 1_000;
    const d = new ExternalTunnelDetector({
      originPort: 19883,
      now: () => now,
      homedir: () => '/Users/me',
      platform: 'darwin',
      listProcesses: async () =>
        '9 /opt/homebrew/bin/cloudflared tunnel --logfile /tmp/cf.log run --token-file /tmp/tmex-cf/token\n',
      readFile: async (path) => files.get(path) ?? null,
      listDir: async (path) => dirs.get(path) ?? [],
    });
    const first = await d.detect();
    expect(first).toMatchObject({
      detected: true,
      source: 'launchd',
      running: true,
      tunnelId: 'tid',
      hostnames: ['tmex.example.org'],
    });
    now += 10_000;
    files.delete('/tmp/tmex-cf/hostname');
    const cached = await d.detect();
    expect(cached.hostnames).toEqual(['tmex.example.org']);
  });

  test('uses Cloudflare tunnel API for hostname and name when no sibling file', async () => {
    const d = new ExternalTunnelDetector({
      originPort: 19883,
      now: () => 1,
      homedir: () => '/no-home',
      platform: 'linux',
      listProcesses: async () => '7 /usr/bin/cloudflared tunnel run --token-file /tmp/token\n',
      readFile: async (path) => {
        if (path === '/tmp/token') {
          return Buffer.from(JSON.stringify({ a: 'acct', t: 'tid', s: 'super-secret' })).toString(
            'base64'
          );
        }
        return null;
      },
      listDir: async () => [],
      getCredentials: async () => ({ accountId: 'acct', apiToken: 'tok' }),
      accessClient: {
        getTunnelIngress: async () => [
          { hostname: 'api.example.com', service: 'http://127.0.0.1:19883' },
          { hostname: 'other.example.com', service: 'http://127.0.0.1:80' },
        ],
        getTunnel: async () => ({ id: 'tid', name: 'tmex-ext' }),
      },
    });
    const found = await d.detect();
    expect(found).toMatchObject({
      detected: true,
      source: 'process',
      tunnelId: 'tid',
      tunnelName: 'tmex-ext',
      hostnames: ['api.example.com'],
      tokenAccountId: 'acct',
    });
    expect(JSON.stringify(found)).not.toContain('super-secret');
  });
});
