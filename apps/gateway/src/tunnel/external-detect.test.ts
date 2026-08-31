import { describe, expect, test } from 'bun:test';
import {
  EMPTY_EXTERNAL,
  ExternalTunnelDetector,
  hostnamesFromLog,
  parseArgv,
  parseCloudflaredConfigYml,
  parsePlistProgramArguments,
  parseProcessList,
  parseTunnelToken,
  serviceHitsOrigin,
  toExternalStatus,
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

  test('detector prefers launchd + origin-matching log ingress and caches for 30s', async () => {
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
      [
        '/tmp/cf.log',
        '{"ingress":[{"hostname":"tmex.example.org","service":"http://127.0.0.1:19883"}]}\n',
      ],
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
    files.delete('/tmp/cf.log');
    const cached = await d.detect();
    expect(cached.hostnames).toEqual(['tmex.example.org']);
  });

  test('treats sibling hostname file as origin-pointing (tmex managed layout)', async () => {
    const d = new ExternalTunnelDetector({
      originPort: 19883,
      now: () => 1,
      homedir: () => '/no-home',
      platform: 'linux',
      listProcesses: async () => '7 /usr/bin/cloudflared tunnel run --token-file /tmp/token\n',
      readFile: async (path) => {
        if (path === '/tmp/token') {
          return Buffer.from(JSON.stringify({ a: 'acct', t: 'tid', s: 's' })).toString('base64');
        }
        if (path === '/tmp/hostname') return 'tmex.example.org\n';
        return null;
      },
      listDir: async () => [],
    });
    const found = await d.detect();
    expect(found.hostnames).toEqual(['tmex.example.org']);
    expect(found.running).toBe(true);
    expect(found.tunnelId).toBe('tid');
  });

  test('ignores a sibling hostname file that is not a valid hostname', async () => {
    const d = new ExternalTunnelDetector({
      originPort: 19883,
      now: () => 1,
      homedir: () => '/no-home',
      platform: 'linux',
      listProcesses: async () => '7 /usr/bin/cloudflared tunnel run --token-file /tmp/token\n',
      readFile: async (path) => {
        if (path === '/tmp/token') {
          return Buffer.from(JSON.stringify({ a: 'acct', t: 'tid', s: 's' })).toString('base64');
        }
        if (path === '/tmp/hostname') return 'not a host!!!\n';
        return null;
      },
      listDir: async () => [],
    });
    const found = await d.detect();
    expect(found.hostnames).toEqual([]);
  });

  test('reads the --config path declared by the candidate, not ~/.cloudflared/config.yml', async () => {
    const d = new ExternalTunnelDetector({
      originPort: 19883,
      now: () => 1,
      homedir: () => '/home/me',
      platform: 'linux',
      listProcesses: async () => '11 /usr/bin/cloudflared tunnel --config /custom/cf.yml run\n',
      readFile: async (path) => {
        if (path === '/home/me/.cloudflared/config.yml') {
          return 'tunnel: other\ningress:\n  - hostname: wrong.example.com\n    service: http://127.0.0.1:19883\n';
        }
        if (path === '/custom/cf.yml') {
          return `tunnel: 550e8400-e29b-41d4-a716-446655440000
ingress:
  - hostname: custom.example.com
    service: http://127.0.0.1:19883
`;
        }
        return null;
      },
      listDir: async () => [],
    });
    const found = await d.detect();
    expect(found.configPath).toBe('/custom/cf.yml');
    expect(found.hostnames).toEqual(['custom.example.com']);
    expect(found.running).toBe(true);
  });

  test('does not mark a candidate running based on an unrelated cloudflared process', async () => {
    const d = new ExternalTunnelDetector({
      originPort: 19883,
      now: () => 1,
      homedir: () => '/Users/me',
      platform: 'darwin',
      listProcesses: async () =>
        '9 /opt/homebrew/bin/cloudflared tunnel run --token-file /tmp/other/token\n',
      readFile: async (path) => {
        if (path === '/Users/me/Library/LaunchAgents/com.tmex.cloudflared.plist') {
          return `<plist><dict><key>ProgramArguments</key><array>
            <string>/opt/homebrew/bin/cloudflared</string><string>tunnel</string>
            <string>--config</string><string>/tmp/tmex/config.yml</string>
            <string>run</string>
          </array></dict></plist>`;
        }
        if (path === '/tmp/tmex/config.yml') {
          return `tunnel: 550e8400-e29b-41d4-a716-446655440000
ingress:
  - hostname: tmex.example.com
    service: http://127.0.0.1:19883
`;
        }
        if (path === '/tmp/other/token') {
          return Buffer.from(JSON.stringify({ a: 'a', t: 'other-id', s: 's' })).toString('base64');
        }
        return null;
      },
      listDir: async (path) =>
        path === '/Users/me/Library/LaunchAgents' ? ['com.tmex.cloudflared.plist'] : [],
    });
    const found = await d.detect();
    expect(found.source).toBe('launchd');
    expect(found.hostnames).toEqual(['tmex.example.com']);
    expect(found.running).toBe(false);
  });

  test('prefers the running candidate when multiple tunnels exist', async () => {
    const d = new ExternalTunnelDetector({
      originPort: 19883,
      now: () => 1,
      homedir: () => '/home/me',
      platform: 'linux',
      listProcesses: async () => '22 /usr/bin/cloudflared tunnel --config /run/cf.yml run\n',
      readFile: async (path) => {
        if (path === '/home/me/.cloudflared/config.yml') {
          return `tunnel: 11111111-1111-1111-1111-111111111111
ingress:
  - hostname: stopped.example.com
    service: http://127.0.0.1:19883
`;
        }
        if (path === '/run/cf.yml') {
          return `tunnel: 22222222-2222-2222-2222-222222222222
ingress:
  - hostname: live.example.com
    service: http://127.0.0.1:19883
`;
        }
        return null;
      },
      listDir: async () => [],
    });
    const found = await d.detect();
    expect(found.running).toBe(true);
    expect(found.hostnames).toEqual(['live.example.com']);
    expect(found.configPath).toBe('/run/cf.yml');
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

  test('invalidate drops the per-instance cache', async () => {
    let scans = 0;
    const d = new ExternalTunnelDetector({
      originPort: 19883,
      now: () => 1,
      homedir: () => '/no-home',
      platform: 'linux',
      listProcesses: async () => {
        scans += 1;
        return '';
      },
      readFile: async () => null,
      listDir: async () => [],
    });
    await d.detect();
    await d.detect();
    expect(scans).toBe(1);
    d.invalidate();
    await d.detect();
    expect(scans).toBe(2);
  });
});

describe('toExternalStatus', () => {
  test('projects DetectedTunnel onto TunnelExternalStatus and copies hostnames', () => {
    const detected = {
      ...EMPTY_EXTERNAL,
      detected: true,
      source: 'process' as const,
      tunnelId: 'tid',
      tunnelName: 'tmex',
      hostnames: ['tmex.example.com'],
      hasOriginCert: true,
      running: true,
    };
    const status = toExternalStatus(detected);
    expect(status).toEqual({
      detected: true,
      source: 'process',
      configPath: null,
      tunnelId: 'tid',
      tunnelName: 'tmex',
      hostnames: ['tmex.example.com'],
      hasOriginCert: true,
      running: true,
      externalAccess: {
        checked: false,
        hostnameMatch: false,
        appId: null,
        aud: null,
        teamDomain: null,
      },
    });
    expect(status.hostnames).not.toBe(detected.hostnames);
    status.hostnames.push('other.example.com');
    expect(detected.hostnames).toEqual(['tmex.example.com']);
  });
});

function escapedConfigLogLine(hostname: string, port: number): string {
  const inner = JSON.stringify({
    ingress: [
      { hostname, originRequest: {}, service: `http://127.0.0.1:${port}` },
      { service: 'http_status:404' },
    ],
    'warp-routing': { enabled: false },
  });
  return JSON.stringify({
    level: 'info',
    version: 1,
    config: inner,
    time: '2026-08-31T00:00:00Z',
    message: 'Updated to new configuration',
  });
}

describe('token-tunnel log + Access probe', () => {
  test('parses escaped config JSON string from token-tunnel logs', () => {
    const line = escapedConfigLogLine('tmex.example.org', 9883);
    expect(line).toContain('\\"ingress\\"');
    expect(hostnamesFromLog(line, 9883)).toEqual(['tmex.example.org']);
    expect(hostnamesFromLog(line, 19883)).toEqual([]);
  });

  test('prefers the last escaped ingress in a tailed multi-MB log', () => {
    const prefix = `${'noise\n'.repeat(20_000)}${'x'.repeat(200_000)}\n`;
    const old = escapedConfigLogLine('old.example.com', 19883);
    const latest = escapedConfigLogLine('tmex.example.org', 19883);
    expect(hostnamesFromLog(`${prefix}${old}\n${latest}\n`, 19883)).toEqual(['tmex.example.org']);
  });

  test('detector uses escaped log ingress when token tunnel has no config.yml', async () => {
    const d = new ExternalTunnelDetector({
      originPort: 9883,
      now: () => 1,
      homedir: () => '/Users/me',
      platform: 'darwin',
      listProcesses: async () =>
        '42 /opt/homebrew/bin/cloudflared tunnel --logfile /tmp/cf.log run --token-file /tmp/tmex-cf/token\n',
      readFile: async (path) => {
        if (path === '/tmp/tmex-cf/token') {
          return Buffer.from(JSON.stringify({ a: 'acct', t: 'tid', s: 'secret' })).toString(
            'base64'
          );
        }
        if (path === '/tmp/cf.log') return `${escapedConfigLogLine('tmex.example.org', 9883)}\n`;
        return null;
      },
      listDir: async () => [],
    });
    const found = await d.detect();
    expect(found.hostnames).toEqual(['tmex.example.org']);
    expect(found.running).toBe(true);
  });

  test('falls through to log parse when tunnel API returns 403', async () => {
    const d = new ExternalTunnelDetector({
      originPort: 9883,
      now: () => 1,
      homedir: () => '/no-home',
      platform: 'linux',
      listProcesses: async () =>
        '7 /usr/bin/cloudflared tunnel --logfile /tmp/cf.log run --token-file /tmp/token\n',
      readFile: async (path) => {
        if (path === '/tmp/token') {
          return Buffer.from(JSON.stringify({ a: 'acct', t: 'tid', s: 's' })).toString('base64');
        }
        if (path === '/tmp/cf.log')
          return `${escapedConfigLogLine('from-log.example.com', 9883)}\n`;
        return null;
      },
      listDir: async () => [],
      getCredentials: async () => ({ accountId: 'acct', apiToken: 'tok' }),
      accessClient: {
        getTunnelIngress: async () => {
          throw new Error('Cloudflare API HTTP 403');
        },
        getTunnel: async () => {
          throw new Error('Cloudflare API HTTP 403');
        },
      },
    });
    const found = await d.detect();
    expect(found.hostnames).toEqual(['from-log.example.com']);
  });

  test('external Access probe: no credentials → cannot check', async () => {
    const d = new ExternalTunnelDetector({
      originPort: 19883,
      now: () => 1,
      homedir: () => '/no-home',
      platform: 'linux',
      listProcesses: async () => '7 /usr/bin/cloudflared tunnel run --token-file /tmp/token\n',
      readFile: async (path) => {
        if (path === '/tmp/token') {
          return Buffer.from(JSON.stringify({ a: 'acct', t: 'tid', s: 's' })).toString('base64');
        }
        if (path === '/tmp/hostname') return 'tmex.example.com\n';
        return null;
      },
      listDir: async () => [],
    });
    const found = await d.detect();
    expect(found.externalAccess).toEqual({
      checked: false,
      hostnameMatch: false,
      appId: null,
      aud: null,
      teamDomain: null,
    });
  });

  test('external Access probe: hostname match + team domain', async () => {
    const d = new ExternalTunnelDetector({
      originPort: 19883,
      now: () => 1,
      homedir: () => '/no-home',
      platform: 'linux',
      listProcesses: async () => '7 /usr/bin/cloudflared tunnel run --token-file /tmp/token\n',
      readFile: async (path) => {
        if (path === '/tmp/token') {
          return Buffer.from(JSON.stringify({ a: 'acct', t: 'tid', s: 's' })).toString('base64');
        }
        if (path === '/tmp/hostname') return 'tmex.example.com\n';
        return null;
      },
      listDir: async () => [],
      getCredentials: async () => ({ accountId: 'acct', apiToken: 'tok' }),
      accessClient: {
        getTunnelIngress: async () => [],
        listApps: async () => [
          { id: 'app-1', aud: 'aud-1', name: 'tmex', domain: 'tmex.example.com' },
          { id: 'other', aud: 'aud-x', name: 'other', domain: 'other.example.com' },
        ],
        getOrganization: async () => ({ teamDomain: 'team.cloudflareaccess.com' }),
      },
    });
    const found = await d.detect();
    expect(found.externalAccess).toEqual({
      checked: true,
      hostnameMatch: true,
      appId: 'app-1',
      aud: 'aud-1',
      teamDomain: 'team.cloudflareaccess.com',
    });
  });

  test('external Access probe: checked but no hostname match', async () => {
    const d = new ExternalTunnelDetector({
      originPort: 19883,
      now: () => 1,
      homedir: () => '/no-home',
      platform: 'linux',
      listProcesses: async () => '7 /usr/bin/cloudflared tunnel run --token-file /tmp/token\n',
      readFile: async (path) => {
        if (path === '/tmp/token') {
          return Buffer.from(JSON.stringify({ a: 'acct', t: 'tid', s: 's' })).toString('base64');
        }
        if (path === '/tmp/hostname') return 'tmex.example.com\n';
        return null;
      },
      listDir: async () => [],
      getCredentials: async () => ({ accountId: 'acct', apiToken: 'tok' }),
      accessClient: {
        getTunnelIngress: async () => [],
        listApps: async () => [
          { id: 'other', aud: 'aud-x', name: 'other', domain: 'other.example.com' },
        ],
      },
    });
    const found = await d.detect();
    expect(found.externalAccess).toEqual({
      checked: true,
      hostnameMatch: false,
      appId: null,
      aud: null,
      teamDomain: null,
    });
  });

  test('external Access probe matches a configured hostname when none were detected', async () => {
    const d = new ExternalTunnelDetector({
      originPort: 19883,
      now: () => 1,
      homedir: () => '/no-home',
      platform: 'linux',
      listProcesses: async () => '',
      readFile: async () => null,
      listDir: async () => [],
      configuredHostnames: () => ['tmex.example.com'],
      getCredentials: async () => ({ accountId: 'acct', apiToken: 'tok' }),
      accessClient: {
        getTunnelIngress: async () => [],
        listApps: async () => [
          { id: 'app-1', aud: 'aud-1', name: 'tmex', domain: 'tmex.example.com' },
        ],
      },
    });
    const found = await d.detect();
    expect(found.detected).toBe(false);
    expect(found.externalAccess).toEqual({
      checked: true,
      hostnameMatch: true,
      appId: 'app-1',
      aud: 'aud-1',
      teamDomain: null,
    });
  });

  test('external Access probe: API error degrades to cannot-check without throwing', async () => {
    const warnings: string[] = [];
    const d = new ExternalTunnelDetector({
      originPort: 19883,
      now: () => 1,
      homedir: () => '/no-home',
      platform: 'linux',
      listProcesses: async () => '7 /usr/bin/cloudflared tunnel run --token-file /tmp/token\n',
      readFile: async (path) => {
        if (path === '/tmp/token') {
          return Buffer.from(JSON.stringify({ a: 'acct', t: 'tid', s: 's' })).toString('base64');
        }
        if (path === '/tmp/hostname') return 'tmex.example.com\n';
        return null;
      },
      listDir: async () => [],
      warn: (message) => warnings.push(message),
      getCredentials: async () => ({ accountId: 'acct', apiToken: 'tok' }),
      accessClient: {
        getTunnelIngress: async () => [],
        listApps: async () => {
          throw new Error('Cloudflare API HTTP 403');
        },
      },
    });
    const found = await d.detect();
    expect(found.detected).toBe(true);
    expect(found.externalAccess).toEqual({
      checked: false,
      hostnameMatch: false,
      appId: null,
      aud: null,
      teamDomain: null,
    });
    expect(warnings.some((w) => /403/.test(w))).toBe(true);
  });
});
