import { describe, expect, test } from 'bun:test';
import { RemotePaneRuntime, RemotePaneUnreachableError } from './remote-pane-runtime';

const PANE_INFO = {
  cols: 80,
  rows: 24,
  cursorX: 1,
  cursorY: 2,
  alternateScreen: false,
  currentCommand: 'nvim',
  title: 'edit',
};

describe('RemotePaneRuntime', () => {
  test('pane-info / capture / send-input 走 forwarder 路径', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const runtime = new RemotePaneRuntime('peer-1', 'dev-1', async (nodeId, path, body) => {
      expect(nodeId).toBe('peer-1');
      calls.push({ path, body });
      if (path.endsWith('/pane-info')) {
        return Response.json({
          info: PANE_INFO,
          snapshot: {
            title: 'edit',
            currentPath: '/tmp',
            windowName: 'main',
            windowId: '@1',
            sessionId: '$0',
            sessionName: 'tmex',
            splitPaneCount: 1,
          },
          snapshotExists: true,
        });
      }
      if (path.endsWith('/capture')) {
        return Response.json({ text: 'screen' });
      }
      return Response.json({ ok: true });
    });

    const info = await runtime.getPaneInfo('%2');
    expect(info.currentCommand).toBe('nvim');
    const lookup = runtime.findPaneInSnapshot('%2');
    expect(lookup.found).toBe(true);
    if (lookup.found) {
      expect(lookup.context.currentPath).toBe('/tmp');
    }
    expect(await runtime.capturePaneText('%2', { historyLines: 10 })).toBe('screen');
    await runtime.sendInput('%2', 'ls\n');
    expect(calls.map((c) => c.path)).toEqual([
      '/api/mesh-internal/tmux/pane-info',
      '/api/mesh-internal/tmux/capture',
      '/api/mesh-internal/tmux/send-input',
    ]);
    expect(calls[2]?.body).toEqual({ deviceId: 'dev-1', paneId: '%2', data: 'ls\n' });
  });

  test('503 / getLink 失败映射为 NODE_UNREACHABLE', async () => {
    const unreachable = new RemotePaneRuntime('peer-down', 'dev', async () => {
      return new Response(JSON.stringify({ code: 'NODE_UNREACHABLE' }), { status: 503 });
    });
    await expect(unreachable.capturePaneText('%1')).rejects.toBeInstanceOf(
      RemotePaneUnreachableError
    );

    const throwing = new RemotePaneRuntime('peer-down', 'dev', async () => {
      throw new Error('link down');
    });
    await expect(throwing.sendInput('%1', 'x')).rejects.toMatchObject({ code: 'NODE_UNREACHABLE' });
  });
});

describe('RemotePaneRuntime 授权', () => {
  function forbidden(code: string): Response {
    return new Response(JSON.stringify({ error: code, code }), { status: 403 });
  }

  test('每次 RPC 都带上授权', async () => {
    const bodies: unknown[] = [];
    const runtime = new RemotePaneRuntime(
      'peer-1',
      'dev-1',
      async (_nodeId, _path, body) => {
        bodies.push(body);
        return Response.json({ ok: true, text: '' });
      },
      { load: async () => ({ grantId: 'g1', token: 't1' }), reject: () => {} }
    );
    await runtime.sendInput('%2', 'ls\n');
    await runtime.capturePaneText('%2');
    expect(bodies[0]).toEqual({
      deviceId: 'dev-1',
      paneId: '%2',
      data: 'ls\n',
      grant: { grantId: 'g1', token: 't1' },
    });
    expect(bodies[1]).toMatchObject({ grant: { grantId: 'g1', token: 't1' } });
  });

  test('被拒 → 标记重签；补签后原地重试一次', async () => {
    let rejected = 0;
    let current = { grantId: 'g1', token: 't1' };
    const seen: string[] = [];
    const runtime = new RemotePaneRuntime(
      'peer-1',
      'dev-1',
      async (_nodeId, _path, body) => {
        const grant = (body as { grant?: { grantId: string } }).grant;
        seen.push(grant?.grantId ?? 'none');
        return grant?.grantId === 'g2'
          ? Response.json({ ok: true })
          : forbidden('PANE_GRANT_INVALID');
      },
      {
        load: async () => current,
        reject: () => {
          rejected += 1;
          current = { grantId: 'g2', token: 't2' };
        },
      }
    );
    await runtime.sendInput('%2', 'x');
    expect(rejected).toBe(1);
    expect(seen).toEqual(['g1', 'g2']);
  });

  test('补不上新授权 → 抛出目标节点给的码', async () => {
    const runtime = new RemotePaneRuntime(
      'peer-1',
      'dev-1',
      async () => forbidden('PANE_GRANT_REQUIRED'),
      { load: async () => null, reject: () => {} }
    );
    await expect(runtime.sendInput('%2', 'x')).rejects.toThrow('PANE_GRANT_REQUIRED');
  });

  test('非授权类 403 不触发重签', async () => {
    let rejected = 0;
    const runtime = new RemotePaneRuntime('peer-1', 'dev-1', async () => forbidden('FORBIDDEN'), {
      load: async () => ({ grantId: 'g1', token: 't1' }),
      reject: () => {
        rejected += 1;
      },
    });
    await expect(runtime.capturePaneText('%2')).rejects.toThrow('FORBIDDEN');
    expect(rejected).toBe(0);
  });
});
