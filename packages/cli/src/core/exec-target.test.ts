import { describe, expect, test } from 'bun:test';
import { ENTRY, NODE, jsonResponse, meshNode, testContext } from '../commands/cli-test-harness';
import { NotFoundError, UsageError } from './errors';
import { ExecTargets, legacyTargetText, planExecTarget } from './exec-target';
import { TargetCache, bareKey, nodeKey } from './target-cache';

function meshFetch(nodes: unknown[], counter: { mesh: number }) {
  return async (input: string): Promise<Response> => {
    const path = new URL(input).pathname;
    if (path === '/api/mesh/nodes') {
      counter.mesh += 1;
      return jsonResponse({ nodes });
    }
    if (path === '/api/auth/mode') return jsonResponse({ nodeId: 'self', mode: 'none' });
    return jsonResponse({ error: 'Not found' }, 404);
  };
}

describe('planExecTarget', () => {
  test('a single word is a bare target', async () => {
    const { ctx } = await testContext(meshFetch([], { mesh: 0 }));
    expect(planExecTarget(ctx, 'box')).toEqual({ kind: 'bare', token: 'box' });
  });

  test('node/device is explicit', async () => {
    const { ctx } = await testContext(meshFetch([], { mesh: 0 }));
    expect(planExecTarget(ctx, 'office/db')).toEqual({
      kind: 'explicit',
      nodeRef: 'office',
      device: 'db',
    });
  });

  test('the node override and --node make a single word a device on that node', async () => {
    const { ctx } = await testContext(meshFetch([], { mesh: 0 }));
    expect(planExecTarget(ctx, 'db', 'office')).toEqual({
      kind: 'explicit',
      nodeRef: 'office',
      device: 'db',
    });
    const { ctx: withNode } = await testContext(meshFetch([], { mesh: 0 }), { node: 'lab' });
    expect(planExecTarget(withNode, 'db')).toEqual({
      kind: 'explicit',
      nodeRef: 'lab',
      device: 'db',
    });
  });

  test('an explicit node prefix beats the override', async () => {
    const { ctx } = await testContext(meshFetch([], { mesh: 0 }));
    expect(planExecTarget(ctx, 'office/db', 'lab')).toMatchObject({ nodeRef: 'office' });
  });

  test('window / pane locations are rejected', async () => {
    const { ctx } = await testContext(meshFetch([], { mesh: 0 }));
    expect(() => planExecTarget(ctx, 'box:1.0')).toThrow(UsageError);
  });

  test('legacyTargetText rebuilds the REST-side target', async () => {
    const { ctx } = await testContext(meshFetch([], { mesh: 0 }));
    expect(legacyTargetText(planExecTarget(ctx, 'office/db'))).toBe('office/db');
    expect(legacyTargetText(planExecTarget(ctx, 'db', 'office'))).toBe('office/db');
    expect(legacyTargetText(planExecTarget(ctx, 'db'))).toBe('db');
  });
});

describe('ExecTargets', () => {
  const explicit = { kind: 'explicit', nodeRef: 'office', device: 'db' } as const;

  test('explicit routes resolve once, then come from targets.json', async () => {
    const counter = { mesh: 0 };
    const { ctx, dir } = await testContext(meshFetch([meshNode()], counter));
    const first = await new ExecTargets(ctx).explicitRoute(explicit, false);
    expect(first).toEqual({
      route: { nodeId: NODE, nodeName: 'office', device: 'db' },
      cached: false,
    });
    expect(counter.mesh).toBe(1);
    expect(TargetCache.open(dir, ENTRY).get(nodeKey('office'))?.nodeId).toBe(NODE);

    const second = await new ExecTargets(ctx).explicitRoute(explicit, false);
    expect(second.cached).toBe(true);
    expect(second.route).toEqual({
      nodeId: NODE,
      nodeName: 'office',
      device: 'db',
      expectName: 'office',
    });
    expect(counter.mesh).toBe(1);
  });

  test('cached routes carry an expected name only for named nodes', async () => {
    const { ctx, dir } = await testContext(meshFetch([], { mesh: 0 }));
    const cache = TargetCache.open(dir, ENTRY);
    cache.set(nodeKey(NODE), { nodeId: NODE, name: 'office' });
    cache.set(nodeKey('lab'), { nodeId: NODE, name: NODE });
    const byId = { kind: 'explicit', nodeRef: NODE, device: 'db' } as const;
    const unnamed = { kind: 'explicit', nodeRef: 'lab', device: 'db' } as const;
    const targets = new ExecTargets(ctx);
    expect((await targets.explicitRoute(byId, false)).route).not.toHaveProperty('expectName');
    expect((await targets.explicitRoute(unnamed, false)).route).not.toHaveProperty('expectName');
  });

  test('fresh skips the cache and rewrites it', async () => {
    const counter = { mesh: 0 };
    const { ctx, dir } = await testContext(meshFetch([meshNode()], counter));
    TargetCache.open(dir, ENTRY).set(nodeKey('office'), { nodeId: 'b'.repeat(32), name: 'old' });
    const result = await new ExecTargets(ctx).explicitRoute(explicit, true);
    expect(result.cached).toBe(false);
    expect(result.route.nodeId).toBe(NODE);
    expect(TargetCache.open(dir, ENTRY).get(nodeKey('office'))?.nodeId).toBe(NODE);
  });

  test('the self alias is never cached', async () => {
    const { ctx, dir } = await testContext(meshFetch([], { mesh: 0 }));
    const route = await new ExecTargets(ctx).explicitRoute(
      { kind: 'explicit', nodeRef: 'self', device: 'db' },
      false
    );
    expect(route.route.nodeId).toBe('self');
    expect(TargetCache.open(dir, ENTRY).get(nodeKey('self'))).toBeNull();
  });

  test('a bare node route is cached and has no device', async () => {
    const counter = { mesh: 0 };
    const { ctx, dir } = await testContext(meshFetch([meshNode()], counter));
    const targets = new ExecTargets(ctx);
    expect(targets.cachedBareRoute('office')).toBeNull();
    expect(await targets.bareNodeRoute('office')).toEqual({ nodeId: NODE, nodeName: 'office' });
    expect(TargetCache.open(dir, ENTRY).get(bareKey('office'))?.nodeId).toBe(NODE);
    expect(new ExecTargets(ctx).cachedBareRoute('office')).toEqual({
      nodeId: NODE,
      nodeName: 'office',
      expectName: 'office',
    });
  });

  test('a bare token that is no node reports device-or-node not found', async () => {
    const { ctx } = await testContext(meshFetch([meshNode()], { mesh: 0 }));
    const error = await new ExecTargets(ctx).bareNodeRoute('nope').catch((err) => err);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).message).toContain('unknown device or node: nope');
  });

  test('forget drops the cached row of the plan', async () => {
    const { ctx, dir } = await testContext(meshFetch([meshNode()], { mesh: 0 }));
    const targets = new ExecTargets(ctx);
    await targets.bareNodeRoute('office');
    targets.forget({ kind: 'bare', token: 'office' });
    expect(TargetCache.open(dir, ENTRY).get(bareKey('office'))).toBeNull();
  });
});
