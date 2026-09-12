import { afterEach, describe, expect, test } from 'bun:test';
import { isMeshNodePaused } from '@/node/merge-nodes';
import {
  getMeshNodesState,
  resetMeshNodesStateForTest,
  setMeshNodesStateForTest,
} from '@/node/mesh-nodes';
import type { MeshNode } from '@vibeterm/api-client/auth/index';
import { createPauseIo, toggleNodePause } from './use-node-pause';

type PauseCall = { id: string; action: 'pause' | 'resume' };

afterEach(() => resetMeshNodesStateForTest());

function mesh(id: string, paused = false): MeshNode {
  return {
    id,
    name: id,
    publicKey: 'AAAA',
    online: true,
    reach: 'lan',
    version: '1.2.0',
    direct_capable: false,
    inventory: null,
    loggedIn: true,
    ...(paused ? { paused: true } : {}),
  } as MeshNode;
}

describe('createPauseIo', () => {
  test('优先走 AuthApi.pauseNode / resumeNode', async () => {
    const calls: string[] = [];
    const io = createPauseIo({
      pauseNode: async (id) => {
        calls.push(`pause:${id}`);
      },
      resumeNode: async (id) => {
        calls.push(`resume:${id}`);
      },
    });
    await io.post('n1', 'pause');
    await io.post('n1', 'resume');
    expect(calls).toEqual(['pause:n1', 'resume:n1']);
  });

  test('API 尚未导出时退回 POST /api/mesh/nodes/:id/pause|resume', async () => {
    const calls: Array<{ path: string; method?: string }> = [];
    const io = createPauseIo({}, async (path, init) => {
      calls.push({ path, method: init?.method });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    await io.post('n1', 'pause');
    await io.post('n1', 'resume');
    expect(calls).toEqual([
      { path: '/api/mesh/nodes/n1/pause', method: 'POST' },
      { path: '/api/mesh/nodes/n1/resume', method: 'POST' },
    ]);
  });

  test('非 2xx 把 code 抛出去', async () => {
    const io = createPauseIo({}, async () => {
      return new Response(JSON.stringify({ code: 'CANNOT_PAUSE_SELF' }), { status: 400 });
    });
    await expect(io.post('self', 'pause')).rejects.toThrow('CANNOT_PAUSE_SELF');
  });
});

describe('toggleNodePause', () => {
  test('成功：乐观翻转后 POST，再 refresh', async () => {
    setMeshNodesStateForTest({ nodes: [mesh('n1')] });
    const posts: PauseCall[] = [];
    const refreshes: number[] = [];
    await toggleNodePause(
      { id: 'n1', paused: undefined },
      {
        post: async (id, action) => {
          posts.push({ id, action });
        },
      },
      () => {
        refreshes.push(1);
      }
    );
    expect(posts).toEqual([{ id: 'n1', action: 'pause' }]);
    expect(refreshes).toHaveLength(1);
    expect(isMeshNodePaused(getMeshNodesState().nodes[0])).toBe(true);
  });

  test('失败：回滚旗标并抛错', async () => {
    setMeshNodesStateForTest({ nodes: [mesh('n1', true)] });
    await expect(
      toggleNodePause(
        { id: 'n1', paused: true },
        {
          post: async () => {
            throw new Error('boom');
          },
        }
      )
    ).rejects.toThrow('boom');
    expect(isMeshNodePaused(getMeshNodesState().nodes[0])).toBe(true);
  });
});
