import { describe, expect, test } from 'bun:test';
import type { DirectEnableResult } from './direct';
import { enableDirectAfterInit } from './init';

describe('enableDirectAfterInit', () => {
  test('calls enableDirect for node role and does not throw on failure', async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    await enableDirectAfterInit(
      { role: 'node', installDir: '/tmp/tmex-init-node' },
      {
        enableDirect: async ({ installDir }) => {
          calls.push(installDir);
          return { ok: false, reason: 'fake registry down' };
        },
        log: (message) => logs.push(message),
      }
    );
    expect(calls).toEqual(['/tmp/tmex-init-node']);
    expect(logs.join('\n')).toContain('fake registry down');
  });

  test('calls enableDirect for hub,node and logs success', async () => {
    const logs: string[] = [];
    const ok: DirectEnableResult = {
      ok: true,
      platformId: 'darwin-arm64',
      version: '0.33.1',
      addonPath: '/tmp/native/node_datachannel.node',
    };
    await enableDirectAfterInit(
      { role: 'hub,node', installDir: '/tmp/tmex-init-hub' },
      {
        enableDirect: async () => ok,
        log: (message) => logs.push(message),
      }
    );
    expect(logs.join('\n')).toContain('darwin-arm64');
  });

  test('does not call enableDirect for standalone', async () => {
    let called = false;
    await enableDirectAfterInit(
      { role: 'standalone', installDir: '/tmp/tmex-init-standalone' },
      {
        enableDirect: async () => {
          called = true;
          return { ok: true, platformId: 'x', version: '1', addonPath: 'y' };
        },
      }
    );
    expect(called).toBe(false);
  });

  test('swallows thrown errors from enableDirect and logs the real message', async () => {
    const logs: string[] = [];
    await enableDirectAfterInit(
      { role: 'node', installDir: '/tmp/tmex-init-throw' },
      {
        enableDirect: async () => {
          throw new Error('network exploded');
        },
        log: (message) => logs.push(message),
      }
    );
    expect(logs.join('\n')).toContain('network exploded');
  });
});
