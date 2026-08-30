import { describe, expect, test } from 'bun:test';
import { handleMeshInternalTmuxRequest } from './mesh-internal-tmux-routes';
import { X_TMEX_MESH_PEER } from './peer-request-marker';

describe('mesh-internal tmux routes', () => {
  test('无 peer 标记 → 403 且不要求 cookie', async () => {
    const res = await handleMeshInternalTmuxRequest(
      new Request('http://localhost/api/mesh-internal/tmux/pane-info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: 'd', paneId: '%1' }),
      })
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'FORBIDDEN' });
  });

  test('有标记但缺字段 → 400', async () => {
    const res = await handleMeshInternalTmuxRequest(
      new Request('http://localhost/api/mesh-internal/tmux/pane-info', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [X_TMEX_MESH_PEER]: 'peer-1',
        },
        body: JSON.stringify({ deviceId: '', paneId: '' }),
      })
    );
    expect(res.status).toBe(400);
  });
});
