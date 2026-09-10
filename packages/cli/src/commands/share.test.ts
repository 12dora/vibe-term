import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotFoundError, UsageError } from '../core/errors';
import type { FetchLike } from '../core/http';
import {
  FAKE_DEVICE_ID,
  FAKE_DEVICE_NAME,
  type FakeTermContext,
  createFakeTermContext,
  fakeSession,
} from '../core/term-test-fakes';
import { routeFetch, testContext } from './cli-test-harness';
import { command as share } from './share';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const device = {
  id: FAKE_DEVICE_ID,
  name: FAKE_DEVICE_NAME,
  type: 'local',
  authMode: 'auto',
  sortOrder: 0,
  createdAt: '',
  updatedAt: '',
  lastSeenAt: null,
  lastError: null,
  lastErrorType: null,
  tmuxAvailable: true,
};

const record = {
  id: 's-1',
  name: 'pair',
  deviceId: FAKE_DEVICE_ID,
  windowId: '@1',
  state: 'active',
  url: 'https://x/s/s-1',
};

const ORIGIN = 'https://share.example.com';
const ORIGINS = {
  candidates: [
    { url: ORIGIN, kind: 'site', label: 'share.example.com', accessUrl: ORIGIN },
    {
      url: 'https://hub.example.com',
      kind: 'hub',
      label: 'hub.example.com',
      accessUrl: 'https://hub.example.com',
    },
  ],
  recommended: ORIGIN,
  nodePrefix: null,
};

async function restCtx(routes: Parameters<typeof routeFetch>[0]) {
  const built = await testContext(routeFetch(routes), { json: true });
  dirs.push(built.dir);
  return built;
}

interface CreateBox {
  events: string[];
  closedAtCreate: number;
  closed: () => number;
  body: string;
}

async function createHarness(
  routes: Parameters<typeof routeFetch>[0] = {},
  options: { json?: boolean } = {}
): Promise<FakeTermContext & { box: CreateBox }> {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-cli-share-'));
  dirs.push(dir);
  const box: CreateBox = { events: [], closedAtCreate: -1, closed: () => 0, body: '' };
  const routed = routeFetch({
    'GET /api/devices': () => ({ devices: [device] }),
    'GET /api/share/origins': () => ORIGINS,
    'POST /api/share': (_url, init) => {
      box.events.push('create');
      box.closedAtCreate = box.closed();
      box.body = String(init?.body);
      return { share: record, password: JSON.parse(box.body).password };
    },
    ...routes,
  });
  const fetchImpl: FetchLike = async (input, init) => routed(input, init);
  const harnessed = createFakeTermContext({
    session: fakeSession(),
    configDir: dir,
    json: options.json ?? true,
    timeoutMs: 1_000,
    overrides: { fetchImpl },
  });
  box.closed = harnessed.closed;
  const send = harnessed.transport.send.bind(harnessed.transport);
  harnessed.transport.send = (command) => {
    if (command.type === 'connect-device') box.events.push('connect');
    return send(command);
  };
  return { ...harnessed, box };
}

describe('vibeterm share create', () => {
  test('connects the device before POSTing, and keeps the socket open until then', async () => {
    const h = await createHarness();
    await share.run(h.ctx, ['create', 'laptop:@1', '--password', 'secret1', '--name', 'pair']);
    expect(h.box.events).toEqual(['connect', 'create']);
    expect(h.box.closedAtCreate).toBe(0);
    expect(h.closed()).toBe(1);
    expect(JSON.parse(h.box.body)).toMatchObject({
      deviceId: FAKE_DEVICE_ID,
      windowId: '@1',
      name: 'pair',
      password: 'secret1',
      origin: ORIGIN,
    });
    expect(JSON.parse(h.stdout.text()).password).toBe('secret1');
  });

  test('resolves a window name to @id', async () => {
    const h = await createHarness();
    await share.run(h.ctx, ['create', 'laptop:build', '--password', 'secret1']);
    expect(JSON.parse(h.box.body).windowId).toBe('@1');
  });

  test('--window-id overrides the target window', async () => {
    const h = await createHarness();
    await share.run(h.ctx, [
      'create',
      'laptop:build',
      '--window-id',
      '@0',
      '--password',
      'secret1',
    ]);
    expect(JSON.parse(h.box.body).windowId).toBe('@0');
  });

  test('--origin overrides the recommended default', async () => {
    const h = await createHarness();
    await share.run(h.ctx, [
      'create',
      'laptop:@1',
      '--password',
      'secret1',
      '--origin',
      'https://own.example',
    ]);
    expect(JSON.parse(h.box.body).origin).toBe('https://own.example');
  });

  test('prints the default origin on stderr', async () => {
    const h = await createHarness({}, { json: false });
    await share.run(h.ctx, ['create', 'laptop:@1', '--password', 'secret1']);
    expect(h.stderr.text()).toContain(`using origin ${ORIGIN}`);
  });

  test('generates a password when none is given', async () => {
    const h = await createHarness();
    await share.run(h.ctx, ['create', 'laptop:@1']);
    const posted = JSON.parse(h.box.body) as { password: string };
    expect(posted.password.length).toBeGreaterThanOrEqual(6);
    expect(JSON.parse(h.stdout.text()).password).toBe(posted.password);
  });

  test('create without window is a usage error', async () => {
    const h = await createHarness();
    await expect(share.run(h.ctx, ['create', 'laptop', '--password', 'x'])).rejects.toBeInstanceOf(
      UsageError
    );
    expect(h.box.events).toEqual([]);
  });

  test('unknown window is not found and still closes the socket', async () => {
    const h = await createHarness();
    await expect(
      share.run(h.ctx, ['create', 'laptop:nope', '--password', 'x'])
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(h.closed()).toBe(1);
    expect(h.box.events).toEqual(['connect']);
  });

  test('no origin candidates is a usage error', async () => {
    const h = await createHarness({
      'GET /api/share/origins': () => ({ candidates: [], recommended: null, nodePrefix: null }),
    });
    await expect(
      share.run(h.ctx, ['create', 'laptop:@1', '--password', 'secret1'])
    ).rejects.toBeInstanceOf(UsageError);
    expect(h.closed()).toBe(1);
  });
});

describe('vibeterm share', () => {
  test('ls / show / revoke / log', async () => {
    const { ctx: cli, stdout } = await restCtx({
      'GET /api/share': () => ({ active: [record], history: [] }),
      'POST /api/share/s-1/revoke': () => ({ share: { ...record, state: 'ended' } }),
      'GET /api/share/s-1/log': () => ({
        entries: [{ seq: 1, kind: 'out', data: 'YWI=', paneId: '%0' }],
        nextAfter: null,
        total: 1,
        truncated: false,
      }),
    });
    await share.run(cli, ['ls']);
    expect(JSON.parse(stdout.text()).active[0].id).toBe('s-1');
  });

  test('password GET and --end-sessions posts a new password', async () => {
    const posts: unknown[] = [];
    const { ctx: cli } = await restCtx({
      'GET /api/share/s-1/password': () => ({ password: 'secret1' }),
      'POST /api/share/s-1/password': (_url, init) => {
        posts.push(JSON.parse(String(init?.body)));
        return { share: record, endedSessions: 2 };
      },
    });
    await share.run(cli, ['password', 's-1']);
    await share.run(cli, ['password', 's-1', '--password', 'next-pass-1', '--end-sessions']);
    expect(posts[0]).toEqual({ password: 'next-pass-1', endSessions: true });
  });

  test('settings set requires --body', async () => {
    const { ctx: cli } = await restCtx({});
    await expect(share.run(cli, ['settings', 'set'])).rejects.toBeInstanceOf(UsageError);
  });

  test('origins', async () => {
    const { ctx: cli, stdout } = await restCtx({
      'GET /api/share/origins': () => ({ candidates: [], recommended: null, nodePrefix: null }),
    });
    await share.run(cli, ['origins']);
    expect(JSON.parse(stdout.text()).recommended).toBeNull();
  });
});
