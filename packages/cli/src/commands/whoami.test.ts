import { describe, expect, test } from 'bun:test';
import { NODE, jsonResponse, meshNode, routeFetch, testContext } from './cli-test-harness';
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
  });
});
