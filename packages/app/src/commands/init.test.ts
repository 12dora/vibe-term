import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SERVICE_NAME, defaultDatabasePath, defaultInstallDir } from '../constants';
import { parseArgs } from '../lib/args';
import { buildAppEnvValues } from '../lib/install';
import { resolveInstallDir } from '../lib/install-layout';
import { DEFAULT_PEER_PORT } from '../lib/roles';
import type { DirectEnableResult } from './direct';
import {
  type PortFallback,
  applyPublicPort,
  buildInitConfig,
  enableDirectAfterInit,
  initPortPlanList,
  normalizeRelayPublicUrl,
  prepareInitConfig,
  resolveInitStunServers,
} from './init';
import { resolveInstallTarget } from './init-target';

describe('resolveInitStunServers', () => {
  const envBase = {
    host: '127.0.0.1',
    port: 9883,
    databasePath: '/tmp/vibeterm.db',
    masterKey: 'key',
  };

  test('does not write VIBETERM_STUN_SERVERS without --stun-servers', () => {
    const flags = parseArgs(['init', '--host', '127.0.0.1']).flags;
    expect(resolveInitStunServers(flags)).toBeUndefined();
    expect(
      buildAppEnvValues({ ...envBase, stunServers: resolveInitStunServers(flags) })
        .VIBETERM_STUN_SERVERS
    ).toBeUndefined();
  });

  test('writes an explicit --stun-servers override including none', () => {
    expect(resolveInitStunServers(parseArgs(['init', '--stun-servers', 'none']).flags)).toBe(
      'none'
    );
    expect(
      buildAppEnvValues({
        ...envBase,
        stunServers: resolveInitStunServers(
          parseArgs(['init', '--stun-servers', 'stun:custom.example:3478']).flags
        ),
      }).VIBETERM_STUN_SERVERS
    ).toBe('stun:custom.example:3478');
  });
});

describe('normalizeRelayPublicUrl', () => {
  test('归一化 https 地址', () => {
    expect(normalizeRelayPublicUrl(' https://Relay.Example.com:443/ ')).toBe(
      'https://relay.example.com'
    );
    expect(normalizeRelayPublicUrl('http://127.0.0.1:19883')).toBe('http://127.0.0.1:19883');
  });

  test('拒绝空值与非 https 的公网地址', () => {
    expect(() => normalizeRelayPublicUrl('')).toThrow('cannot be empty');
    expect(() => normalizeRelayPublicUrl('   ')).toThrow('cannot be empty');
    expect(() => normalizeRelayPublicUrl('http://relay.example.com')).toThrow(
      'invalid relay public URL'
    );
    expect(() => normalizeRelayPublicUrl('relay.example.com')).toThrow('invalid relay public URL');
  });
});

describe('applyPublicPort', () => {
  test('地址没写端口时补上选定的公网端口', () => {
    expect(applyPublicPort('https://relay.example.com', 13443)).toBe(
      'https://relay.example.com:13443'
    );
    expect(applyPublicPort(' relay.example.com ', 13443)).toBe('https://relay.example.com:13443');
  });

  test('显式端口与 443 都原样返回', () => {
    expect(applyPublicPort('https://relay.example.com:8443', 13443)).toBe(
      'https://relay.example.com:8443'
    );
    expect(applyPublicPort('https://relay.example.com', 443)).toBe('https://relay.example.com');
    expect(applyPublicPort('', 13443)).toBe('');
  });

  test('无法解析的地址原样交给后面的校验', () => {
    expect(applyPublicPort('ftp://relay.example.com', 13443)).toBe('ftp://relay.example.com');
  });
});

describe('initPortPlanList', () => {
  test('relay summary uses the plan (TURN numbers, not literals)', () => {
    expect(
      initPortPlanList({
        role: 'relay',
        host: '127.0.0.1',
        port: 9883,
        peerPort: 39001,
        relayPublicUrl: 'https://relay.example.com',
      })
    ).toBe('443/tcp, 40000/udp, 40001-40049/udp');
  });

  test('relay,node splits ICE away from TURN on the unified UDP segment', () => {
    expect(
      initPortPlanList({
        role: 'relay,node',
        host: '127.0.0.1',
        port: 9883,
        peerPort: 39001,
        relayPublicUrl: 'https://relay.example.com',
      })
    ).toBe('443/tcp, 39001/tcp, 40050-40099/udp, 40000/udp, 40001-40049/udp');
  });

  test('node includes the peer/rtc plan without a public https port', () => {
    expect(
      initPortPlanList({
        role: 'node',
        host: '127.0.0.1',
        port: 9883,
        peerPort: 39002,
        relayPublicUrl: '',
      })
    ).toBe('39002/tcp, 40000-40099/udp');
  });

  test('exposed bind host appends the gateway port', () => {
    expect(
      initPortPlanList({
        role: 'node',
        host: '0.0.0.0',
        port: 19663,
        peerPort: 39001,
        relayPublicUrl: '',
      })
    ).toBe('39001/tcp, 40000-40099/udp, 19663/tcp');
  });
});

describe('enableDirectAfterInit', () => {
  test('calls enableDirect for node role and does not throw on failure', async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    await enableDirectAfterInit(
      { role: 'node', installDir: '/tmp/vibeterm-init-node' },
      {
        enableDirect: async ({ installDir }) => {
          calls.push(installDir);
          return { ok: false, reason: 'fake registry down' };
        },
        log: (message) => logs.push(message),
      }
    );
    expect(calls).toEqual(['/tmp/vibeterm-init-node']);
    expect(logs.join('\n')).toContain('fake registry down');
  });

  test('calls enableDirect for node and logs success', async () => {
    const logs: string[] = [];
    const ok: DirectEnableResult = {
      ok: true,
      platformId: 'darwin-arm64',
      version: '0.33.1',
      addonPath: '/tmp/native/node_datachannel.node',
    };
    await enableDirectAfterInit(
      { role: 'node', installDir: '/tmp/vibeterm-init-node-ok' },
      {
        enableDirect: async () => ok,
        log: (message) => logs.push(message),
      }
    );
    expect(logs.join('\n')).toContain('darwin-arm64');
  });

  test.each(['standalone', 'node', 'relay', 'relay,node'] as const)(
    '角色 %s 默认安装并传入超时信号',
    async (role) => {
      let called = false;
      await enableDirectAfterInit(
        { role, installDir: '/tmp/vibeterm-init-standalone' },
        {
          enableDirect: async ({ signal, skipExisting }) => {
            expect(signal).toBeInstanceOf(AbortSignal);
            expect(signal?.aborted).toBe(false);
            expect(skipExisting).toBe(true);
            called = true;
            return { ok: true, platformId: 'x', version: '1', addonPath: 'y' };
          },
        }
      );
      expect(called).toBe(true);
    }
  );

  test('swallows thrown errors from enableDirect and logs the real message', async () => {
    const logs: string[] = [];
    await enableDirectAfterInit(
      { role: 'node', installDir: '/tmp/vibeterm-init-throw' },
      {
        enableDirect: async () => {
          throw new Error('network exploded');
        },
        log: (message) => logs.push(message),
      }
    );
    expect(logs.join('\n')).toContain('network exploded');
  });
});

describe('buildInitConfig', () => {
  const noPrompt = async (message: string): Promise<string> => {
    throw new Error(`unexpected prompt: ${message}`);
  };
  const allFree = async (): Promise<boolean> => true;
  const build = async (argv: string[], deps: Parameters<typeof buildInitConfig>[2] = {}) => {
    const parsed = parseArgs(['init', ...argv]);
    const plan = { ...resolveInstallTarget(parsed.flags), reusePorts: {} };
    return buildInitConfig(parsed, plan, { canBind: allFree, ask: noPrompt, ...deps });
  };

  const defaults = () => {
    const installDir = resolveInstallDir(defaultInstallDir(process.platform));
    return {
      installDir,
      host: '127.0.0.1',
      port: 9883,
      databasePath: defaultDatabasePath(installDir),
      autostart: true,
      serviceName: DEFAULT_SERVICE_NAME,
      role: 'standalone',
      peerPort: DEFAULT_PEER_PORT,
      relayPublicUrl: '',
    };
  };

  test.each([[[]], [['--no-interactive']]])(
    '%j asks nothing and yields the defaults',
    async (argv) => {
      const config = await build(argv);
      expect(config).toMatchObject(defaults());
      expect(config.nonInteractive).toBe(argv.length > 0);
    }
  );

  test('explicit flags override the defaults', async () => {
    const config = await build([
      '--no-interactive',
      '--install-dir',
      '/opt/vt-example',
      '--host',
      '0.0.0.0',
      '--port',
      '19000',
      '--db-path',
      '/srv/vt-example/db.sqlite',
      '--autostart',
      'false',
      '--service-name',
      'vt-example',
      '--peer-port',
      '19001',
      '--role',
      'node',
    ]);
    expect(config).toMatchObject({
      installDir: '/opt/vt-example',
      host: '0.0.0.0',
      port: 19000,
      databasePath: '/srv/vt-example/db.sqlite',
      autostart: false,
      serviceName: 'vt-example',
      peerPort: 19001,
      role: 'node',
    });
  });

  test('--autostart without a value means true', async () => {
    expect((await build(['--autostart'])).autostart).toBe(true);
  });

  test.each([
    [['--autostart', 'maybe'], 'Invalid flag value: --autostart=maybe'],
    [['--port', 'abc'], 'abc'],
    [['--peer-port', '70000'], '70000'],
    [['--port'], 'Invalid flag value: --port=true'],
    [['--install-dir'], 'Invalid flag value: --install-dir=true'],
    [['--role', 'bogus'], 'must be one of'],
  ])('rejects the explicit invalid value %j', async (argv, message) => {
    await expect(build(argv)).rejects.toThrow(message);
  });

  test('picks the next free gateway port when the default is occupied', async () => {
    const fallbacks: PortFallback[] = [];
    const probed: Array<[number, string]> = [];
    const config = await build(['--host', '127.0.0.1'], {
      canBind: async (port, host) => {
        probed.push([port, host]);
        return port !== 9883;
      },
      onPortFallback: (fallback) => fallbacks.push(fallback),
    });
    expect(config.port).toBe(9884);
    expect(fallbacks).toEqual([{ from: 9883, to: 9884 }]);
    expect(probed[0]).toEqual([9883, '127.0.0.1']);
  });

  test('picks the next free peer port, avoiding the gateway and TLS ports', async () => {
    const fallbacks: PortFallback[] = [];
    const config = await build(['--port', String(DEFAULT_PEER_PORT + 1)], {
      canBind: async (port) => port !== DEFAULT_PEER_PORT,
      onPortFallback: (fallback) => fallbacks.push(fallback),
    });
    expect(config.peerPort).toBe(DEFAULT_PEER_PORT + 2);
    expect(fallbacks).toEqual([{ from: DEFAULT_PEER_PORT, to: DEFAULT_PEER_PORT + 2 }]);
  });

  test('explicit ports are used as is without probing', async () => {
    const probed: number[] = [];
    const config = await build(['--port', '9883', '--peer-port', '39001'], {
      canBind: async (port) => {
        probed.push(port);
        return false;
      },
    });
    expect(config).toMatchObject({ port: 9883, peerPort: 39001 });
    expect(probed).toEqual([]);
  });

  test('fails clearly when no free port is available', async () => {
    await expect(build([], { canBind: async () => false })).rejects.toThrow('--port');
  });

  test('a probe error other than "occupied" is surfaced as is', async () => {
    const failure = Object.assign(new Error('getaddrinfo ENOTFOUND bad.example'), {
      code: 'ENOTFOUND',
    });
    const canBind = async (): Promise<boolean> => {
      throw failure;
    };
    await expect(build(['--host', 'bad.example'], { canBind })).rejects.toBe(failure);
  });

  test('relay non-interactive keeps requiring --relay-public-url and never prompts', async () => {
    await expect(build(['--role', 'relay', '--no-interactive'])).rejects.toThrow(
      '--relay-public-url'
    );
    const config = await build([
      '--role',
      'relay',
      '--no-interactive',
      '--relay-public-url',
      'https://relay.example.com',
    ]);
    expect(config).toMatchObject({ role: 'relay', relayPublicUrl: 'https://relay.example.com' });
  });

  test('relay interactive asks for the public port and relay address only', async () => {
    const asked: string[] = [];
    const config = await build(['--role', 'relay,node'], {
      ask: async (message, fallback) => {
        asked.push(message);
        return message.includes('Relay public URL') ? 'https://relay.example.com' : fallback;
      },
    });
    expect(asked).toHaveLength(2);
    expect(config.relayPublicUrl).toBe('https://relay.example.com');
  });
});

describe('prepareInitConfig ordering', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = '';
  });

  function recorder() {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        canBind: async (port: number): Promise<boolean> => {
          calls.push(`canBind:${port}`);
          return true;
        },
        ask: async (message: string, fallback: string): Promise<string> => {
          calls.push(`ask:${message}`);
          return message.includes('Relay public URL') ? 'https://relay.example.com' : fallback;
        },
      },
    };
  }
  const prepare = (argv: string[], deps: Parameters<typeof prepareInitConfig>[1]) =>
    prepareInitConfig(parseArgs(['init', '--install-dir', dir, ...argv]), deps);
  const makeDir = async (files: Record<string, string>) => {
    dir = await mkdtemp(join(tmpdir(), 'vibeterm-init-'));
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content);
    }
  };

  test('an existing install fails before any question or port probe', async () => {
    await makeDir({ 'install-meta.json': JSON.stringify({ cliVersion: '2.3.4' }) });
    const { calls, deps } = recorder();
    await expect(prepare(['--role', 'relay,node'], deps)).rejects.toThrow('vibeterm upgrade');
    expect(calls).toEqual([]);
  });

  test('a directory with only app.env is refused before any question or port probe', async () => {
    await makeDir({ 'app.env': 'VIBETERM_MASTER_KEY=example\n' });
    const { calls, deps } = recorder();
    await expect(prepare(['--role', 'relay'], deps)).rejects.toThrow('already installed');
    expect(calls).toEqual([]);
  });

  test('a directory with unrelated content passes the guard and probes ports', async () => {
    await makeDir({ 'notes.txt': 'x' });
    const { calls, deps } = recorder();
    const config = await prepare([], deps);
    expect(config.force).toBe(false);
    expect(calls).toEqual(['canBind:9883', `canBind:${DEFAULT_PEER_PORT}`]);
  });

  test('--force bypasses the guard', async () => {
    await makeDir({ 'install-meta.json': JSON.stringify({ cliVersion: '2.3.4' }) });
    const { deps } = recorder();
    const config = await prepare(['--force'], deps);
    expect(config).toMatchObject({ force: true, installDir: resolveInstallDir(dir) });
  });

  test('--force reuses the ports of the old app.env without probing', async () => {
    await makeDir({ 'app.env': 'GATEWAY_PORT=19123\nVIBETERM_PEER_PORT=19124\n' });
    const { calls, deps } = recorder();
    const fallbacks: PortFallback[] = [];
    const config = await prepare(['--force'], {
      ...deps,
      onPortFallback: (fallback) => fallbacks.push(fallback),
    });
    expect(config).toMatchObject({ port: 19123, peerPort: 19124 });
    expect(calls).toEqual([]);
    expect(fallbacks).toEqual([]);
  });

  test('explicit ports beat the old app.env; invalid old values fall back to probing', async () => {
    await makeDir({ 'app.env': 'GATEWAY_PORT=19123\nVIBETERM_PEER_PORT=abc\n' });
    const { calls, deps } = recorder();
    const config = await prepare(['--force', '--port', '19200'], deps);
    expect(config).toMatchObject({ port: 19200, peerPort: DEFAULT_PEER_PORT });
    expect(calls).toEqual([`canBind:${DEFAULT_PEER_PORT}`]);
  });

  test('--force on a fresh directory probes the default ports', async () => {
    await makeDir({});
    const { calls, deps } = recorder();
    await prepare(['--force'], deps);
    expect(calls).toEqual(['canBind:9883', `canBind:${DEFAULT_PEER_PORT}`]);
  });
});
