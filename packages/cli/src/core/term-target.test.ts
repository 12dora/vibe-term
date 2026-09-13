import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TmuxSession } from '@vibeterm/shared';
import { buildContext } from './context';
import { NotFoundError, UsageError } from './errors';
import type { FetchLike } from './http';
import { parseTarget } from './resolve';
import { locatePane, locateWindow, resolveTargetDevice } from './term-target';
import { fakeSession } from './term-test-fakes';

const session = fakeSession();

function target(raw: string) {
  return parseTarget(raw);
}

describe('locateWindow', () => {
  test('no location means the active window', () => {
    expect(locateWindow(session, target('laptop')).id).toBe('@0');
  });

  test('index, @id and name all resolve', () => {
    expect(locateWindow(session, target('laptop:1')).id).toBe('@1');
    expect(locateWindow(session, target('laptop:@1')).id).toBe('@1');
    expect(locateWindow(session, target('laptop:build')).id).toBe('@1');
  });

  test('a pane reference resolves to its window', () => {
    expect(locateWindow(session, target('laptop:%2')).id).toBe('@1');
  });

  test('an unknown window is a not-found error', () => {
    expect(() => locateWindow(session, target('laptop:nope'))).toThrow(NotFoundError);
  });
});

describe('locatePane', () => {
  test('no location means the active pane of the active window', () => {
    expect(locatePane(session, target('laptop')).pane.id).toBe('%0');
  });

  test('a window reference lands on that window active pane', () => {
    const located = locatePane(session, target('laptop:build'));
    expect(located.window.id).toBe('@1');
    expect(located.pane.id).toBe('%1');
  });

  test('window.pane addresses a pane by index inside that window', () => {
    expect(locatePane(session, target('laptop:1.1')).pane.id).toBe('%2');
    expect(locatePane(session, target('laptop:build.0')).pane.id).toBe('%1');
  });

  test('%id wins over everything else', () => {
    expect(locatePane(session, target('laptop:%2')).pane.id).toBe('%2');
  });

  test('a window name containing a dot still resolves', () => {
    const dotted: TmuxSession = {
      ...session,
      windows: [{ ...session.windows[0], name: 'api.v2' }],
    };
    expect(locatePane(dotted, target('laptop:api.v2')).window.name).toBe('api.v2');
  });

  test('an unknown pane is a not-found error', () => {
    expect(() => locatePane(session, target('laptop:1.9'))).toThrow(NotFoundError);
  });

  test('an ambiguous window name is a usage error', () => {
    const twins: TmuxSession = {
      ...session,
      windows: session.windows.map((window) => ({ ...window, name: 'same' })),
    };
    expect(() => locateWindow(twins, target('laptop:same'))).toThrow(UsageError);
  });
});

describe('resolveTargetDevice', () => {
  const ENTRY = 'http://entry.example:9883';
  const ORACLE = 'c'.repeat(32);
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  function fakeDevice(id: string, name: string, type: 'local' | 'ssh' = 'local') {
    return {
      id,
      name,
      type,
      sortOrder: 0,
      authMode: 'auto',
      createdAt: '',
      updatedAt: '',
      lastSeenAt: null,
      lastError: null,
      lastErrorType: null,
      tmuxAvailable: true,
    };
  }

  async function targetContext(options: { node?: string | null } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-cli-target-'));
    dirs.push(dir);
    const requests: Array<{ method: string; path: string }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      requests.push({ method, path: url.pathname });
      if (url.pathname === '/api/mesh/nodes') {
        return Response.json({
          nodes: [{ id: ORACLE, name: 'oracle-jp', publicKey: 'pk', online: true }],
        });
      }
      if (url.pathname === `/n/${ORACLE}/api/devices`) {
        return Response.json({
          devices: [fakeDevice('d-box', 'box'), fakeDevice('d-ssh', 'remote', 'ssh')],
        });
      }
      if (url.pathname === '/api/devices') {
        return Response.json({ devices: [fakeDevice('d-self', 'jiefa-app')] });
      }
      if (url.pathname === '/api/auth/mode') {
        return Response.json({ nodeId: 'e'.repeat(32) });
      }
      return new Response('not found', { status: 404 });
    };
    const ctx = buildContext({
      entryFlag: ENTRY,
      node: options.node ?? null,
      json: false,
      quiet: false,
      noColor: true,
      configDir: dir,
      installEntry: null,
      env: {},
      fetchImpl,
    });
    return { ctx, requests };
  }

  test('--node oracle-jp local does not fall back to self', async () => {
    const { ctx, requests } = await targetContext({ node: 'oracle-jp' });
    const error = (await resolveTargetDevice(ctx, 'local').catch((err) => err)) as NotFoundError;
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.exitCode).toBe(4);
    expect(error.message).toBe('device "local" not found on node oracle-jp');
    expect(error.hint).toContain('box');
    expect(error.hint).toContain('remote');
    expect(error.hint).toContain('did you mean: vibeterm exec oracle-jp/<device>');
    expect(requests.some((row) => row.method === 'POST')).toBe(false);
    expect(requests.filter((row) => row.path === '/api/devices')).toHaveLength(0);
  });

  test('unknown device lists (+N more) when more than 5 devices exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-cli-target-'));
    dirs.push(dir);
    const extras = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta'];
    const fetchImpl: FetchLike = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/mesh/nodes') {
        return Response.json({
          nodes: [{ id: ORACLE, name: 'oracle-jp', publicKey: 'pk', online: true }],
        });
      }
      if (url.pathname === `/n/${ORACLE}/api/devices`) {
        return Response.json({
          devices: extras.map((name, index) => fakeDevice(`d-${index}`, name)),
        });
      }
      if (url.pathname === '/api/auth/mode') {
        return Response.json({ nodeId: 'e'.repeat(32) });
      }
      return new Response('not found', { status: 404 });
    };
    const ctx = buildContext({
      entryFlag: ENTRY,
      node: 'oracle-jp',
      json: false,
      quiet: false,
      noColor: true,
      configDir: dir,
      installEntry: null,
      env: {},
      fetchImpl,
    });
    const error = (await resolveTargetDevice(ctx, 'nope').catch((err) => err)) as NotFoundError;
    expect(error.hint).toContain('alpha, beta, gamma, delta, epsilon');
    expect(error.hint).toContain('(+2 more)');
    expect(error.hint).not.toContain('zeta');
    expect(error.hint).toContain('did you mean: vibeterm exec oracle-jp/<device>');
  });

  test('bare mesh node name still falls back to that node first local device', async () => {
    const { ctx } = await targetContext();
    const resolved = await resolveTargetDevice(ctx, 'oracle-jp');
    expect(resolved.nodeName).toBe('oracle-jp');
    expect(resolved.device.name).toBe('box');
  });
});
