import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import type { MeshNode } from '@vibeterm/api-client/auth/types';
import { NODE, jsonResponse, meshNode, testContext } from '../commands/cli-test-harness';
import { AuthError } from './errors';
import {
  cancelNodeUpgrade,
  isBatchEligible,
  orderUpgradeGroups,
  parseUpgradeIds,
  pollNodeUpgrade,
  runUpgradeBatch,
  startNodeUpgrade,
  upgradeExitCode,
} from './nodes-upgrade';

function row(partial: Record<string, unknown> = {}): MeshNode {
  return meshNode(partial) as MeshNode;
}

describe('nodes-upgrade batch policy', () => {
  test('isBatchEligible matches GUI: online, logged in, version < latest', () => {
    const latest = '2.0.9';
    expect(isBatchEligible(row({ version: '2.0.8' }), latest, NODE)).toBe(true);
    expect(isBatchEligible(row({ version: '2.0.9' }), latest, NODE)).toBe(false);
    expect(isBatchEligible(row({ online: false, version: '2.0.8' }), latest, NODE)).toBe(false);
    expect(
      isBatchEligible(row({ id: 'b'.repeat(32), loggedIn: false, version: '2.0.8' }), latest, NODE)
    ).toBe(false);
    expect(isBatchEligible(row({ loggedIn: false, version: '2.0.8' }), latest, NODE)).toBe(true);
    expect(isBatchEligible(row({ version: '1.0.9' }), latest, NODE)).toBe(false);
    expect(isBatchEligible(row({ version: '2.0.8' }), null, NODE)).toBe(false);
  });

  test('isBatchEligible treats a live CLI jar session as logged in', () => {
    const latest = '2.0.9';
    const peer = 'b'.repeat(32);
    const logged = new Set([peer]);
    expect(
      isBatchEligible(row({ id: peer, loggedIn: false, version: '2.0.8' }), latest, NODE, (id) =>
        logged.has(id)
      )
    ).toBe(true);
    expect(
      isBatchEligible(
        row({ id: peer, loggedIn: false, version: '2.0.8' }),
        latest,
        NODE,
        () => false
      )
    ).toBe(false);
    expect(
      isBatchEligible(
        row({ id: peer, loggedIn: true, version: '2.0.8' }),
        latest,
        NODE,
        () => false
      )
    ).toBe(true);
  });

  test('orderUpgradeGroups is others → hub → self', () => {
    const self = row({ id: NODE, name: 'self' });
    const hub = row({ id: 'c'.repeat(32), name: 'hub', isHub: true });
    const other = row({ id: 'b'.repeat(32), name: 'peer' });
    const groups = orderUpgradeGroups([self, hub, other], NODE);
    expect(groups.map((group) => group.map((row) => row.name))).toEqual([
      ['peer'],
      ['hub'],
      ['self'],
    ]);
  });

  test('parseUpgradeIds splits and rejects empty', () => {
    expect(parseUpgradeIds('a, b ,c')).toEqual(['a', 'b', 'c']);
    expect(() => parseUpgradeIds(' , , ')).toThrow();
  });

  test('upgradeExitCode is 1 for failed/timeout/unconfirmed', () => {
    expect(upgradeExitCode([{ node: NODE, name: 'n', outcome: 'done' }])).toBe(0);
    expect(upgradeExitCode([{ node: NODE, name: 'n', outcome: 'alreadyLatest' }])).toBe(0);
    expect(upgradeExitCode([{ node: NODE, name: 'n', outcome: 'unconfirmed' }])).toBe(1);
    expect(upgradeExitCode([{ node: NODE, name: 'n', outcome: 'timeout' }])).toBe(1);
    expect(upgradeExitCode([{ node: NODE, name: 'n', outcome: 'failed' }])).toBe(1);
  });
});

describe('nodes-upgrade entry cookies', () => {
  const dirs: string[] = [];
  const peer = 'b'.repeat(32);

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function seeded(fetchImpl: Parameters<typeof testContext>[0]) {
    const built = await testContext(fetchImpl, { json: true });
    dirs.push(built.dir);
    built.ctx.http.jar.set('self', 'sid-self', 0);
    built.ctx.http.jar.set(peer, 'sid-peer', 0);
    return built;
  }

  function expectSelfAndPeerCookies(cookie: string | null) {
    expect(cookie).toContain('vibeterm_s_self=sid-self');
    expect(cookie).toContain(`vibeterm_s_${peer}=sid-peer`);
    expect(cookie).toContain(`tmex_s_${peer}=sid-peer`);
  }

  test('start/status/cancel attach both self and target node cookies', async () => {
    const seen: Array<{ method: string; path: string; cookie: string | null }> = [];
    const { ctx } = await seeded(async (url, init) => {
      const parsed = new URL(url);
      seen.push({
        method: (init?.method ?? 'GET').toUpperCase(),
        path: parsed.pathname,
        cookie: new Headers(init?.headers).get('cookie'),
      });
      return jsonResponse({ state: 'idle' });
    });

    await startNodeUpgrade(ctx, peer);
    await pollNodeUpgrade(ctx, peer);
    await cancelNodeUpgrade(ctx, peer);

    expect(seen.map((row) => `${row.method} ${row.path}`)).toEqual([
      `POST /api/mesh/nodes/${peer}/upgrade`,
      `GET /api/mesh/nodes/${peer}/upgrade`,
      `DELETE /api/mesh/nodes/${peer}/upgrade`,
    ]);
    for (const row of seen) expectSelfAndPeerCookies(row.cookie);
  });

  test('NODE_LOGIN_REQUIRED on start is an AuthError with login --node', async () => {
    const { ctx } = await seeded(async () =>
      jsonResponse({ code: 'NODE_LOGIN_REQUIRED', nodeId: peer }, 401)
    );
    const error = (await startNodeUpgrade(ctx, peer).catch((err) => err)) as AuthError;
    expect(error).toBeInstanceOf(AuthError);
    expect(error.exitCode).toBe(3);
    expect(error.hint).toBe(`run: vibeterm login --node ${peer}`);
  });
});

describe('nodes-upgrade batch auth isolation', () => {
  const dirs: string[] = [];
  const first = 'b'.repeat(32);
  const second = 'c'.repeat(32);
  const targets = [row({ id: first, name: 'peer-a' }), row({ id: second, name: 'peer-b' })];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function built(fetchImpl: Parameters<typeof testContext>[0]) {
    const result = await testContext(fetchImpl, { json: true });
    dirs.push(result.dir);
    return result;
  }

  test('first-node 401 still upgrades the second and keeps both outcomes', async () => {
    const posted: string[] = [];
    const { ctx } = await built(async (url, init) => {
      const parsed = new URL(url);
      if ((init?.method ?? 'GET').toUpperCase() !== 'POST') {
        return jsonResponse({ error: 'Not found' }, 404);
      }
      posted.push(parsed.pathname);
      if (parsed.pathname.includes(first)) {
        return jsonResponse({ code: 'NODE_LOGIN_REQUIRED', nodeId: first }, 401);
      }
      return jsonResponse({ code: 'UPGRADE_ALREADY_LATEST' }, 409);
    });

    const outcomes = await runUpgradeBatch(ctx, targets, '2.0.9');
    expect(posted).toEqual([
      `/api/mesh/nodes/${first}/upgrade`,
      `/api/mesh/nodes/${second}/upgrade`,
    ]);
    expect(outcomes).toEqual([
      {
        node: first,
        name: 'peer-a',
        outcome: 'failed',
        error: 'NODE_LOGIN_REQUIRED',
        hint: `run: vibeterm login --node ${first}`,
      },
      {
        node: second,
        name: 'peer-b',
        outcome: 'alreadyLatest',
        version: '2.0.8',
        error: 'UPGRADE_ALREADY_LATEST',
      },
    ]);
    expect(upgradeExitCode(outcomes)).toBe(1);
  });

  test('first-node 401 during poll still upgrades the second', async () => {
    const posted: string[] = [];
    const { ctx } = await built(async (url, init) => {
      const parsed = new URL(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (!parsed.pathname.endsWith('/upgrade')) return jsonResponse({ error: 'Not found' }, 404);
      if (parsed.pathname.includes(first)) {
        if (method === 'POST') return jsonResponse({ state: 'downloading' });
        return jsonResponse({ code: 'NODE_LOGIN_REQUIRED', nodeId: first }, 401);
      }
      if (method === 'POST') {
        posted.push(parsed.pathname);
        return jsonResponse({ code: 'UPGRADE_ALREADY_LATEST' }, 409);
      }
      return jsonResponse({ state: 'idle' });
    });

    const outcomes = await runUpgradeBatch(ctx, targets, '2.0.9', undefined, true);
    expect(posted).toEqual([`/api/mesh/nodes/${second}/upgrade`]);
    expect(outcomes[0]).toEqual({
      node: first,
      name: 'peer-a',
      outcome: 'failed',
      error: 'NODE_LOGIN_REQUIRED',
      hint: `run: vibeterm login --node ${first}`,
    });
    expect(outcomes[1]).toMatchObject({ node: second, name: 'peer-b', outcome: 'alreadyLatest' });
    expect(upgradeExitCode(outcomes)).toBe(1);
  });

  test('single-target 401 still throws AuthError', async () => {
    const { ctx } = await built(async () =>
      jsonResponse({ code: 'NODE_LOGIN_REQUIRED', nodeId: first }, 401)
    );
    const error = (await runUpgradeBatch(ctx, [targets[0]], '2.0.9').catch(
      (err) => err
    )) as AuthError;
    expect(error).toBeInstanceOf(AuthError);
    expect(error.exitCode).toBe(3);
    expect(error.hint).toBe(`run: vibeterm login --node ${first}`);
  });
});
