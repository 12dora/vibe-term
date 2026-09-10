import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { UsageError } from '../core/errors';
import { routeFetch, testContext } from './cli-test-harness';
import { command as share } from './share';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const device = {
  id: 'd-1',
  name: 'laptop',
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
  deviceId: 'd-1',
  windowId: '@1',
  state: 'active',
  url: 'https://x/s/s-1',
};

async function ctx(routes: Parameters<typeof routeFetch>[0]) {
  const built = await testContext(routeFetch(routes), { json: true });
  dirs.push(built.dir);
  return built;
}

describe('vibeterm share', () => {
  test('create posts deviceId + windowId', async () => {
    let body = '';
    const { ctx: cli, stdout } = await ctx({
      'GET /api/devices': () => ({ devices: [device] }),
      'POST /api/share': (_url, init) => {
        body = String(init?.body);
        return { share: record, password: 'secret1' };
      },
    });
    await share.run(cli, ['create', 'laptop:@1', '--password', 'secret1', '--name', 'pair']);
    expect(JSON.parse(body)).toMatchObject({
      deviceId: 'd-1',
      windowId: '@1',
      name: 'pair',
      password: 'secret1',
    });
    expect(JSON.parse(stdout.text()).password).toBe('secret1');
  });

  test('create without window is a usage error', async () => {
    const { ctx: cli } = await ctx({
      'GET /api/devices': () => ({ devices: [device] }),
    });
    await expect(share.run(cli, ['create', 'laptop', '--password', 'x'])).rejects.toBeInstanceOf(
      UsageError
    );
  });

  test('ls / show / revoke / log', async () => {
    const { ctx: cli, stdout } = await ctx({
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
    const { ctx: cli } = await ctx({
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
    const { ctx: cli } = await ctx({});
    await expect(share.run(cli, ['settings', 'set'])).rejects.toBeInstanceOf(UsageError);
  });

  test('origins', async () => {
    const { ctx: cli, stdout } = await ctx({
      'GET /api/share/origins': () => ({ candidates: [], recommended: null, nodePrefix: null }),
    });
    await share.run(cli, ['origins']);
    expect(JSON.parse(stdout.text()).recommended).toBeNull();
  });
});
