import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import {
  GATEWAY_CAPABILITY_WINDOW_MEMORY_V1,
  type TmuxSession,
  WINDOW_MEMORY_SETTINGS_DEFAULTS,
  formatBytes,
} from '@vibeterm/shared';
import type { GatewayTransportCommand, GatewayTransportEvent } from '@vibeterm/ws-client';
import type { CliContext } from '../core/context';
import { UsageError } from '../core/errors';
import type { WindowMemoryTransportEvent } from '../core/sessions-memory';
import { NODE, routeFetch, testContext } from './cli-test-harness';
import { command as sessions } from './sessions';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const PAYLOAD = {
  devices: [
    {
      deviceId: 'dev-linux',
      deviceName: 'linux',
      connected: true,
      supported: true,
      limitsSupported: true,
      windows: [
        {
          windowId: '@1',
          windowName: 'build',
          panes: 2,
          scopes: ['tmux-spawn-aaa.scope', 'tmux-spawn-bbb.scope'],
          current: 1024 ** 3,
          high: 8 * 1024 ** 3,
          max: 12 * 1024 ** 3,
          swapMax: 4 * 1024 ** 3,
          oomKills: 3,
          oomFlag: true,
          sampledAt: Date.now(),
          source: 'cgroup',
        },
        {
          windowId: '@2',
          windowName: 'main',
          panes: 1,
          scopes: ['tmux-spawn-ccc.scope'],
          current: 512,
          high: 0,
          max: 0,
          swapMax: 0,
          oomKills: 0,
          oomFlag: false,
          sampledAt: Date.now(),
          source: 'cgroup',
        },
      ],
    },
    {
      deviceId: 'dev-mac',
      deviceName: 'macbook',
      connected: true,
      supported: false,
      limitsSupported: false,
      windows: [],
    },
  ],
};

function deviceJson(id: string, name: string) {
  return { id, name, type: 'local', session: 'main' };
}

function treeOf(id: string, name: string, panes = 1): TmuxSession {
  return {
    id: '$0',
    name: 'main',
    windows: [
      {
        id,
        name,
        index: 0,
        active: true,
        panes: Array.from({ length: panes }, (_, index) => ({
          id: `%${index}`,
          windowId: id,
          index,
          active: index === 0,
          width: 80,
          height: 24,
        })),
      },
    ],
  };
}

function memoryEvent(
  deviceId: string,
  windowId: string,
  current = 2048
): WindowMemoryTransportEvent {
  return {
    type: 'window-memory',
    deviceId,
    windowId,
    current,
    high: 8 * 1024 ** 3,
    max: 12 * 1024 ** 3,
    swapMax: 0,
    oomKills: 1,
    oomFlag: true,
    panes: 1,
    sampledAt: Date.now(),
    source: 'cgroup',
  };
}

class SessionsFakeTransport {
  serverCapabilities: readonly string[] = [GATEWAY_CAPABILITY_WINDOW_MEMORY_V1];
  trees = new Map<string, TmuxSession>();
  memoryEvents: GatewayTransportEvent[] = [];
  live = 0;
  maxLive = 0;
  closes = 0;
  private readonly handlers = new Set<(event: GatewayTransportEvent) => void>();

  onEvent(handler: (event: GatewayTransportEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(event: GatewayTransportEvent): void {
    for (const handler of [...this.handlers]) handler(event);
  }

  send(command: GatewayTransportCommand): boolean {
    if (command.type !== 'connect-device') return true;
    const tree = this.trees.get(command.deviceId) ?? { id: '$0', name: 'main', windows: [] };
    queueMicrotask(() => {
      this.emit({ type: 'device-connected', deviceId: command.deviceId });
      this.emit({
        type: 'metadata-snapshot',
        snapshot: { deviceId: command.deviceId, session: tree },
      });
      for (const event of this.memoryEvents) {
        if (event.type === 'window-memory' && event.deviceId === command.deviceId) this.emit(event);
      }
    });
    return true;
  }

  bind(ctx: CliContext): CliContext {
    return {
      ...ctx,
      openSocket: async (nodeId) => {
        this.live += 1;
        this.maxLive = Math.max(this.maxLive, this.live);
        return {
          connection: { transport: this } as never,
          nodeId,
          cid: () => 'cid',
          close: () => {
            this.live -= 1;
            this.closes += 1;
          },
        };
      },
    };
  }
}

async function jsonCtx(routes: Parameters<typeof routeFetch>[0], options: { node?: string } = {}) {
  const built = await testContext(routeFetch(routes), { json: true, ...options });
  dirs.push(built.dir);
  return built;
}

async function humanCtx(routes: Parameters<typeof routeFetch>[0]) {
  const built = await testContext(routeFetch(routes), { json: false });
  Object.assign(built.stdout.stream, { isTTY: true });
  dirs.push(built.dir);
  return built;
}

describe('vibeterm sessions', () => {
  test('USAGE names the group', () => {
    expect(sessions.usage).toContain('vibeterm sessions');
    expect(sessions.name).toBe('sessions');
    expect(sessions.usage).toContain('(limits unavailable)');
    expect(sessions.usage).toContain('(cannot sample memory)');
    expect(sessions.usage).not.toContain('(memory limits unsupported on this host)');
    expect(sessions.usage).toContain('SOURCE, MEM, HIGH, MAX, and OOM print `-`');
  });

  test('table without --memory lists DEVICE WINDOW PANES', async () => {
    const { ctx, stdout } = await humanCtx({
      'GET /api/sessions/memory': () => PAYLOAD,
    });
    await sessions.run(ctx, []);
    const text = stdout.text();
    expect(text).toContain('DEVICE');
    expect(text).toContain('WINDOW');
    expect(text).toContain('PANES');
    expect(text).not.toContain('SCOPE');
    expect(text).not.toContain('MEM');
    expect(text).toContain('linux');
    expect(text).toContain('@1 build');
    expect(text).toContain('@2 main');
    expect(text).not.toContain('(memory limits unsupported on this host)');
    expect(text).not.toContain('(cannot sample memory)');
    expect(text).not.toContain('(limits unavailable)');
    expect(text).not.toContain('macbook');
  });

  test('table with --memory adds SCOPE SOURCE MEM HIGH MAX OOM', async () => {
    const { ctx, stdout } = await humanCtx({
      'GET /api/sessions/memory': () => PAYLOAD,
    });
    await sessions.run(ctx, ['--memory']);
    const text = stdout.text();
    expect(text).toContain('SCOPE');
    expect(text).toContain('SOURCE');
    expect(text).toContain('MEM');
    expect(text).toContain('HIGH');
    expect(text).toContain('MAX');
    expect(text).toContain('OOM');
    expect(text).toContain('cgroup');
    expect(text).toContain('tmux-spawn-aaa.scope+1');
    expect(text).toContain('tmux-spawn-ccc.scope');
    expect(text).toContain(formatBytes(1024 ** 3));
    expect(text).toContain(formatBytes(8 * 1024 ** 3));
    expect(text).toContain('∞');
    expect(text).toContain('3!');
    expect(text).toMatch(/\b0\b/);
  });

  test('limitsSupported:false is preferred over supported:false for the device note', async () => {
    const { ctx, stdout } = await humanCtx({
      'GET /api/sessions/memory': () => PAYLOAD,
    });
    await sessions.run(ctx, ['--memory']);
    const text = stdout.text();
    expect(text).toContain('macbook');
    expect(text).toContain('(limits unavailable)');
    expect(text).not.toContain('(memory limits unsupported on this host)');
    expect(text).not.toContain('(cannot sample memory)');
    const linuxIdx = text.indexOf('linux');
    const macIdx = text.indexOf('macbook');
    const noteIdx = text.indexOf('(limits unavailable)');
    expect(linuxIdx).toBeGreaterThanOrEqual(0);
    expect(macIdx).toBeGreaterThan(linuxIdx);
    expect(noteIdx).toBeGreaterThan(macIdx);
  });

  test('supported:false with limits still available prints (cannot sample memory)', async () => {
    const { ctx, stdout } = await humanCtx({
      'GET /api/sessions/memory': () => ({
        devices: [
          {
            deviceId: 'dev-miss',
            deviceName: 'miss-host',
            connected: true,
            supported: false,
            limitsSupported: true,
            windows: [
              {
                windowId: '@1',
                windowName: 'shell',
                panes: 1,
                scopes: ['tmux-spawn-aaa.scope'],
                current: 0,
                high: 0,
                max: 0,
                swapMax: 0,
                oomKills: 0,
                oomFlag: true,
                sampledAt: 0,
                source: 'cgroup',
              },
            ],
          },
        ],
      }),
    });
    await sessions.run(ctx, ['--memory']);
    const text = stdout.text();
    expect(text).toContain('miss-host');
    expect(text).toContain('(cannot sample memory)');
    expect(text).not.toContain('(limits unavailable)');
    expect(text).not.toContain('(memory limits unsupported on this host)');
    expect(text).not.toContain('0 B');
    expect(text).not.toContain('∞');
    expect(text).not.toContain('0!');
  });

  test('stale samples print - for MEM HIGH MAX, not the old cap', async () => {
    const { ctx, stdout } = await humanCtx({
      'GET /api/sessions/memory': () => ({
        devices: [
          {
            deviceId: 'dev-stale',
            deviceName: 'stale-host',
            connected: true,
            supported: true,
            limitsSupported: true,
            windows: [
              {
                windowId: '@4',
                windowName: 'old',
                panes: 1,
                scopes: ['tmux-spawn-old.scope'],
                current: 400 * 1024 ** 2,
                high: 8 * 1024 ** 3,
                max: 12 * 1024 ** 3,
                swapMax: 4 * 1024 ** 3,
                oomKills: 2,
                oomFlag: true,
                sampledAt: 1_700_000_000_000,
                source: 'cgroup',
                stale: true,
              },
            ],
          },
        ],
      }),
    });
    await sessions.run(ctx, ['--memory']);
    const text = stdout.text();
    expect(text).toContain('@4 old');
    expect(text).not.toContain('8.00 GB');
    expect(text).not.toContain('12.00 GB');
    expect(text).not.toContain('∞');
    expect(text).toContain('tmux-spawn-old.scope');
  });

  test('old targets without sampledAgeMs hide limits once sampledAt is past the local threshold', async () => {
    const { ctx, stdout } = await humanCtx({
      'GET /api/sessions/memory': () => ({
        devices: [
          {
            deviceId: 'dev-old',
            deviceName: 'old-gw',
            connected: true,
            supported: true,
            limitsSupported: true,
            windows: [
              {
                windowId: '@4',
                windowName: 'frozen',
                panes: 1,
                scopes: ['tmux-spawn-old.scope'],
                current: 400 * 1024 ** 2,
                high: 8 * 1024 ** 3,
                max: 12 * 1024 ** 3,
                swapMax: 0,
                oomKills: 1,
                oomFlag: false,
                sampledAt: Date.now() - 7 * 24 * 60 * 60 * 1000,
                source: 'cgroup',
              },
            ],
          },
        ],
      }),
    });
    await sessions.run(ctx, ['--memory']);
    const text = stdout.text();
    expect(text).toContain('@4 frozen');
    expect(text).not.toContain('8.00 GB');
    expect(text).not.toContain('12.00 GB');
    expect(text).not.toContain('∞');
  });

  test('sampledAgeMs overrides the local clock, both directions', async () => {
    const freshAge = {
      windowId: '@1',
      windowName: 'skewed',
      panes: 1,
      scopes: ['tmux-spawn-a.scope'],
      current: 4096,
      high: 8 * 1024 ** 3,
      max: 12 * 1024 ** 3,
      swapMax: 0,
      oomKills: 0,
      oomFlag: false,
      sampledAt: 1_700_000_000_000,
      sampledAgeMs: 1_000,
      source: 'cgroup',
    };
    const oldAge = {
      ...freshAge,
      windowId: '@2',
      windowName: 'aged',
      sampledAt: Date.now(),
      sampledAgeMs: 120_000,
    };
    const { ctx, stdout } = await humanCtx({
      'GET /api/sessions/memory': () => ({
        devices: [
          {
            deviceId: 'dev-age',
            deviceName: 'aged-host',
            connected: true,
            supported: true,
            limitsSupported: true,
            windows: [freshAge, oldAge],
          },
        ],
      }),
    });
    await sessions.run(ctx, ['--memory']);
    const text = stdout.text();
    const skewed = text.split('\n').find((line) => line.includes('@1 skewed'));
    const aged = text.split('\n').find((line) => line.includes('@2 aged'));
    expect(skewed).toContain('8.00 GB');
    expect(aged).toBeDefined();
    expect(aged).not.toContain('8.00 GB');
    expect(aged).toMatch(/aged\s+1\s+\S+\s+-\s+-\s+-\s+-\s+-$/);
  });

  test('unsampled windows print - for MEM HIGH MAX OOM, not 0 B', async () => {
    const { ctx, stdout } = await humanCtx({
      'GET /api/sessions/memory': () => ({
        devices: [
          {
            deviceId: 'dev-mix',
            deviceName: 'mixed',
            connected: true,
            supported: true,
            limitsSupported: true,
            windows: [
              {
                windowId: '@1',
                windowName: 'live',
                panes: 1,
                scopes: ['tmux-spawn-aaa.scope'],
                current: 4096,
                high: 8 * 1024 ** 3,
                max: 12 * 1024 ** 3,
                swapMax: 0,
                oomKills: 1,
                oomFlag: true,
                sampledAt: Date.now(),
                source: 'cgroup',
              },
              {
                windowId: '@2',
                windowName: 'gone',
                panes: 1,
                scopes: [],
                current: 0,
                high: 0,
                max: 0,
                swapMax: 0,
                oomKills: 0,
                oomFlag: true,
                sampledAt: 0,
                source: 'cgroup',
              },
            ],
          },
        ],
      }),
    });
    await sessions.run(ctx, ['--memory']);
    const text = stdout.text();
    expect(text).toContain('@1 live');
    expect(text).toContain('@2 gone');
    expect(text).toContain(formatBytes(4096));
    expect(text).toContain('1!');
    expect(text).not.toContain('0 B');
    const goneLine = text.split('\n').find((line) => line.includes('@2 gone'));
    expect(goneLine).toBeDefined();
    expect(goneLine).toMatch(/gone\s+1\s+-\s+-\s+-\s+-\s+-\s+-$/);
  });

  test('limitsSupported:false prints (limits unavailable) and SOURCE=RSS', async () => {
    const { ctx, stdout } = await humanCtx({
      'GET /api/sessions/memory': () => ({
        devices: [
          {
            deviceId: 'dev-rss',
            deviceName: 'old-tmux',
            connected: true,
            supported: true,
            limitsSupported: false,
            windows: [
              {
                windowId: '@1',
                windowName: 'shell',
                panes: 1,
                scopes: [],
                current: 4096,
                high: 0,
                max: 0,
                swapMax: 0,
                oomKills: 0,
                oomFlag: false,
                sampledAt: Date.now(),
                source: 'rss',
              },
            ],
          },
        ],
      }),
    });
    await sessions.run(ctx, ['--memory']);
    const text = stdout.text();
    expect(text).toContain('old-tmux');
    expect(text).toContain('RSS');
    expect(text).toContain('(limits unavailable)');
    expect(text).not.toContain('(memory limits unsupported on this host)');
    expect(text).not.toContain('(cannot sample memory)');
  });

  test('--json prints the gateway payload unchanged', async () => {
    const { ctx, stdout } = await jsonCtx({
      'GET /api/sessions/memory': () => PAYLOAD,
    });
    await sessions.run(ctx, ['--memory']);
    expect(JSON.parse(stdout.text())).toEqual(PAYLOAD);
  });

  test('--json keeps sampledAt:0 numeric zeros for unsampled HTTP windows', async () => {
    const payload = {
      devices: [
        {
          deviceId: 'dev-mix',
          deviceName: 'mixed',
          connected: true,
          supported: true,
          limitsSupported: true,
          windows: [
            {
              windowId: '@2',
              windowName: 'gone',
              panes: 1,
              scopes: [],
              current: 0,
              high: 0,
              max: 0,
              swapMax: 0,
              oomKills: 0,
              oomFlag: true,
              sampledAt: 0,
              source: 'cgroup',
            },
          ],
        },
      ],
    };
    const { ctx, stdout } = await jsonCtx({
      'GET /api/sessions/memory': () => payload,
    });
    await sessions.run(ctx, ['--memory']);
    expect(JSON.parse(stdout.text())).toEqual(payload);
  });

  test('non-TTY stdout defaults to JSON', async () => {
    const { ctx, stdout } = await testContext(
      routeFetch({
        'GET /api/sessions/memory': () => PAYLOAD,
      }),
      { json: false }
    );
    dirs.push(ctx.configDir);
    await sessions.run(ctx, []);
    expect(JSON.parse(stdout.text())).toEqual(PAYLOAD);
  });

  test('--node prefixes /n/<id>', async () => {
    let url = '';
    const built = await testContext(
      async (requested) => {
        url = requested;
        return new Response(JSON.stringify({ devices: [] }), {
          headers: { 'content-type': 'application/json' },
        });
      },
      { json: true, node: NODE }
    );
    dirs.push(built.dir);
    await sessions.run(built.ctx, []);
    expect(url).toBe(`http://entry.example:9883/n/${NODE}/api/sessions/memory`);
  });

  test('unexpected arguments are a usage error', async () => {
    const { ctx } = await jsonCtx({
      'GET /api/sessions/memory': () => PAYLOAD,
    });
    await expect(sessions.run(ctx, ['ls'])).rejects.toBeInstanceOf(UsageError);
  });

  test('connected:false fills windows from a device session', async () => {
    const transport = new SessionsFakeTransport();
    transport.trees.set('dev-off', treeOf('@7', 'idle', 2));
    const { ctx, stdout } = await humanCtx({
      'GET /api/sessions/memory': () => ({
        devices: [
          {
            deviceId: 'dev-off',
            deviceName: 'office',
            connected: false,
            supported: false,
            windows: [],
          },
        ],
      }),
      'GET /api/devices': () => ({ devices: [deviceJson('dev-off', 'office')] }),
    });
    await sessions.run(transport.bind(ctx), []);
    const text = stdout.text();
    expect(text).toContain('office');
    expect(text).toContain('@7 idle');
    expect(text).toContain('2');
    expect(transport.closes).toBe(1);
  });

  test('connected:false --memory collects window-memory events', async () => {
    const transport = new SessionsFakeTransport();
    transport.trees.set('dev-off', treeOf('@7', 'idle'));
    transport.memoryEvents = [memoryEvent('dev-off', '@7', 4096)];
    const { ctx, stdout } = await humanCtx({
      'GET /api/sessions/memory': () => ({
        devices: [
          {
            deviceId: 'dev-off',
            deviceName: 'office',
            connected: false,
            supported: false,
            windows: [],
          },
        ],
      }),
      'GET /api/devices': () => ({ devices: [deviceJson('dev-off', 'office')] }),
      'GET /api/settings/window-memory': () => ({
        ...WINDOW_MEMORY_SETTINGS_DEFAULTS,
        sampleIntervalSec: 2,
      }),
    });
    await sessions.run(transport.bind(ctx), ['--memory']);
    const text = stdout.text();
    expect(text).toContain(formatBytes(4096));
    expect(text).toContain('1!');
    expect(text).not.toContain('(memory limits unsupported on this host)');
    expect(text).not.toContain('(cannot sample memory)');
  });

  test('connected:false --memory is unsupported without window-memory-v1', async () => {
    const transport = new SessionsFakeTransport();
    transport.serverCapabilities = [];
    transport.trees.set('dev-off', treeOf('@7', 'idle'));
    const { ctx, stdout } = await humanCtx({
      'GET /api/sessions/memory': () => ({
        devices: [
          {
            deviceId: 'dev-off',
            deviceName: 'office',
            connected: false,
            supported: false,
            windows: [],
          },
        ],
      }),
      'GET /api/devices': () => ({ devices: [deviceJson('dev-off', 'office')] }),
      'GET /api/settings/window-memory': () => WINDOW_MEMORY_SETTINGS_DEFAULTS,
    });
    await sessions.run(transport.bind(ctx), ['--memory']);
    const text = stdout.text();
    expect(text).toContain('@7 idle');
    expect(text).toContain('(limits unavailable)');
    expect(text).not.toContain('(memory limits unsupported on this host)');
    expect(text).not.toContain('(cannot sample memory)');
    expect(text).not.toContain('0 B');
    expect(text).toContain('-');
  });

  test('missing connected is treated as connected when windows or supported', async () => {
    const transport = new SessionsFakeTransport();
    const { ctx } = await jsonCtx({
      'GET /api/sessions/memory': () => ({
        devices: [
          {
            deviceId: 'dev-linux',
            deviceName: 'linux',
            supported: true,
            windows: PAYLOAD.devices[0].windows,
          },
        ],
      }),
    });
    await sessions.run(transport.bind(ctx), []);
    expect(transport.closes).toBe(0);
  });

  test('disconnected --json omits source on windows that never got a sample', async () => {
    const transport = new SessionsFakeTransport();
    transport.trees.set('dev-off', {
      id: '$0',
      name: 'main',
      windows: [
        {
          id: '@1',
          name: 'live',
          index: 0,
          active: true,
          panes: [{ id: '%0', windowId: '@1', index: 0, active: true, width: 80, height: 24 }],
        },
        {
          id: '@2',
          name: 'dead',
          index: 1,
          active: false,
          panes: [{ id: '%1', windowId: '@2', index: 0, active: true, width: 80, height: 24 }],
        },
      ],
    });
    transport.memoryEvents = [
      {
        ...memoryEvent('dev-off', '@1', 4096),
        source: 'rss',
        high: 0,
        max: 0,
        oomKills: 0,
        oomFlag: false,
      },
    ];
    const { ctx, stdout } = await jsonCtx({
      'GET /api/sessions/memory': () => ({
        devices: [
          {
            deviceId: 'dev-off',
            deviceName: 'office',
            connected: false,
            supported: false,
            windows: [],
          },
        ],
      }),
      'GET /api/devices': () => ({ devices: [deviceJson('dev-off', 'office')] }),
      'GET /api/settings/window-memory': () => ({
        ...WINDOW_MEMORY_SETTINGS_DEFAULTS,
        sampleIntervalSec: 0.05,
      }),
    });
    await sessions.run(transport.bind(ctx), ['--memory']);
    const body = JSON.parse(stdout.text()) as {
      devices: Array<{ limitsSupported: boolean | null; windows: Array<Record<string, unknown>> }>;
    };
    expect(body.devices[0]?.limitsSupported).toBe(false);
    const live = body.devices[0]?.windows.find((window) => window.windowId === '@1');
    const dead = body.devices[0]?.windows.find((window) => window.windowId === '@2');
    expect(live?.source).toBe('rss');
    expect(typeof live?.sampledAt).toBe('number');
    expect(live?.sampledAt).not.toBe(0);
    expect(dead?.sampledAt).toBe(0);
    expect(dead).not.toHaveProperty('source');
  }, 10_000);

  test('holds at most 4 device sessions at once', async () => {
    const transport = new SessionsFakeTransport();
    const devices = [1, 2, 3, 4, 5].map((n) => ({
      deviceId: `dev-${n}`,
      deviceName: `d${n}`,
      connected: false,
      supported: false,
      windows: [],
    }));
    for (const device of devices) {
      transport.trees.set(device.deviceId, treeOf(`@${device.deviceId}`, device.deviceName));
    }
    const { ctx } = await jsonCtx({
      'GET /api/sessions/memory': () => ({ devices }),
      'GET /api/devices': () => ({
        devices: devices.map((device) => deviceJson(device.deviceId, device.deviceName)),
      }),
    });
    await sessions.run(transport.bind(ctx), []);
    expect(transport.maxLive).toBeLessThanOrEqual(4);
    expect(transport.closes).toBe(5);
  });
});
