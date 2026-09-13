import { describe, expect, test } from 'bun:test';
import { AuthError } from '../core/errors';
import { ENTRY, NODE, jsonResponse, meshNode, routeFetch, testContext } from './cli-test-harness';
import { command as whoami } from './whoami';

const PEER = 'b'.repeat(32);

describe('vibeterm whoami READY', () => {
  test('prints READY and a login hint when SESSION=no ONLINE=yes', async () => {
    const { ctx, stdout, stderr } = await testContext(
      routeFetch({
        'GET /api/auth/mode': () => ({
          mode: 'mesh',
          nodeId: NODE,
          uid: 'u-1',
          username: 'root',
        }),
        'GET /api/mesh/nodes': () => ({
          nodes: [
            meshNode({ id: NODE, name: 'entry', loggedIn: true, online: true }),
            meshNode({ id: PEER, name: 'office', loggedIn: false, online: true }),
          ],
        }),
      })
    );
    ctx.http.jar.set('self', 'sid', Date.now() + 60_000);
    await whoami.run(ctx, []);
    expect(stdout.text()).toContain('READY');
    expect(stderr.text()).toContain('vibeterm login --node office');
  });

  test('--json includes ready on each node', async () => {
    const { ctx, stdout } = await testContext(
      routeFetch({
        'GET /api/auth/mode': () => ({
          mode: 'mesh',
          nodeId: NODE,
          uid: 'u-1',
          username: 'root',
        }),
        'GET /api/mesh/nodes': () => ({
          nodes: [meshNode({ id: PEER, name: 'office', loggedIn: false, online: true })],
        }),
      }),
      { json: true }
    );
    ctx.http.jar.set('self', 'sid', Date.now() + 60_000);
    await whoami.run(ctx, []);
    const payload = JSON.parse(stdout.text()) as {
      nodes: Array<{ node: string; ready: boolean; loggedIn: boolean }>;
    };
    expect(payload.nodes.find((row) => row.node === 'self')?.ready).toBe(true);
    expect(payload.nodes.find((row) => row.node === PEER)).toMatchObject({
      loggedIn: false,
      ready: false,
    });
    expect(payload).toMatchObject({ loggedIn: true });
    expect(typeof (payload as { sessionFile?: string }).sessionFile).toBe('string');
  });

  test('without a session prints nothing on stdout and throws AuthError', async () => {
    const { ctx, stdout } = await testContext(
      routeFetch({
        'GET /api/auth/mode': () => ({
          mode: 'mesh',
          nodeId: NODE,
          uid: 'u-1',
          username: 'root',
        }),
      })
    );
    const error = (await whoami.run(ctx, []).catch((err) => err)) as AuthError;
    expect(error).toBeInstanceOf(AuthError);
    expect(error.exitCode).toBe(3);
    expect(error.message).toBe(`not logged in to ${ENTRY}`);
    expect(error.hint).toBe('run: vibeterm login');
    expect(stdout.text()).toBe('');
  });

  test('--json without a session prints loggedIn false and returns 3', async () => {
    const { ctx, stdout } = await testContext(
      routeFetch({
        'GET /api/auth/mode': () => ({
          mode: 'mesh',
          nodeId: NODE,
          uid: 'u-1',
          username: 'root',
        }),
      }),
      { json: true }
    );
    const code = await whoami.run(ctx, []);
    expect(code).toBe(3);
    expect(JSON.parse(stdout.text())).toEqual({
      loggedIn: false,
      entry: ENTRY,
      hint: 'vibeterm login',
    });
  });

  test('a stale self cookie (GET /api/mesh/nodes → 401) is not logged in', async () => {
    const { ctx, stdout } = await testContext(
      routeFetch({
        'GET /api/auth/mode': () => ({
          mode: 'mesh',
          nodeId: NODE,
          uid: 'u-1',
          username: 'root',
        }),
        'GET /api/mesh/nodes': () => jsonResponse({ error: 'UNAUTHORIZED' }, 401),
      })
    );
    ctx.http.jar.set('self', 'stale-sid', Date.now() + 60_000);
    const error = (await whoami.run(ctx, []).catch((err) => err)) as AuthError;
    expect(error).toBeInstanceOf(AuthError);
    expect(error.exitCode).toBe(3);
    expect(error.message).toBe(`not logged in to ${ENTRY}`);
    expect(stdout.text()).toBe('');
  });

  test('403 via_mismatch on /api/mesh/nodes is not logged in', async () => {
    const { ctx, stdout } = await testContext(
      routeFetch({
        'GET /api/auth/mode': () => ({
          mode: 'mesh',
          nodeId: NODE,
          uid: 'u-1',
          username: 'root',
        }),
        'GET /api/mesh/nodes': () => jsonResponse({ error: 'via_mismatch' }, 403),
      })
    );
    ctx.http.jar.set('self', 'stale-sid', Date.now() + 60_000);
    const error = (await whoami.run(ctx, []).catch((err) => err)) as AuthError;
    expect(error).toBeInstanceOf(AuthError);
    expect(error.exitCode).toBe(3);
    expect(error.message).toBe(`not logged in to ${ENTRY}`);
    expect(stdout.text()).toBe('');
  });

  test('--json stale cookie omits sessionFile and user', async () => {
    const { ctx, stdout } = await testContext(
      routeFetch({
        'GET /api/auth/mode': () => ({
          mode: 'mesh',
          nodeId: NODE,
          uid: 'u-1',
          username: 'root',
        }),
        'GET /api/mesh/nodes': () => jsonResponse({ error: 'UNAUTHORIZED' }, 401),
      }),
      { json: true }
    );
    ctx.http.jar.set('self', 'stale-sid', Date.now() + 60_000);
    const code = await whoami.run(ctx, []);
    expect(code).toBe(3);
    const payload = JSON.parse(stdout.text()) as Record<string, unknown>;
    expect(payload).toEqual({ loggedIn: false, entry: ENTRY, hint: 'vibeterm login' });
    expect(payload.sessionFile).toBeUndefined();
    expect(payload.user).toBeUndefined();
  });
});
