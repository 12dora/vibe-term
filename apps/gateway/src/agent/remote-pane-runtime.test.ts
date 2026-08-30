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
