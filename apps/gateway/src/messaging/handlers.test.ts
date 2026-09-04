import { describe, expect, test } from 'bun:test';
import type { CommandInvocation } from '@tmex/shared/messaging';
import { handleApprove, handleDeny } from './handlers/approve';
import { handleDevices } from './handlers/devices';
import { handleHelp } from './handlers/help';
import { handleNodes } from './handlers/nodes';
import { handlePanes } from './handlers/panes';
import { handleRun } from './handlers/run';
import { handleStatus } from './handlers/status';
import { handleTail } from './handlers/tail';
import { handleWindows } from './handlers/windows';
import { createTestContext } from './test-context';

const actor = {
  platform: 'telegram' as const,
  accountId: 'bot',
  conversationId: 'chat',
  userId: '1',
};

function inv(
  command: string,
  args: string[] = [],
  extra: Partial<CommandInvocation> = {}
): CommandInvocation {
  return { command, args, rawText: command, actor, ...extra };
}

const sampleWindows = [
  {
    id: '@1',
    name: 'main',
    index: 1,
    active: true,
    panes: [
      {
        id: '%1',
        index: 0,
        windowId: '@1',
        windowIndex: 1,
        windowName: 'main',
        title: 'zsh',
        active: true,
      },
      {
        id: '%2',
        index: 1,
        windowId: '@1',
        windowIndex: 1,
        windowName: 'main',
        title: 'vim',
        active: false,
      },
    ],
  },
];

const deviceCtx = () =>
  createTestContext({
    devices: [{ id: 'dev-1', name: 'laptop', type: 'local', connected: true, lastError: null }],
    windowsByDevice: { 'dev-1': sampleWindows },
  });

describe('handlers', () => {
  test('help lists registered commands', async () => {
    const result = await handleHelp(inv('help'), createTestContext());
    const lines = result.sections?.[0]?.lines ?? [];
    expect(lines.some((line) => line.startsWith('help'))).toBe(true);
    expect(lines.some((line) => line.startsWith('run '))).toBe(true);
  });

  test('status reports name, version, roles and uplink', async () => {
    const result = await handleStatus(inv('status'), createTestContext());
    const text = result.sections?.[0]?.lines.join('\n') ?? '';
    expect(text).toContain('Home');
    expect(text).toContain('1.1.24');
    expect(text).toContain('node');
  });

  test('nodes standalone vs mesh', async () => {
    const standalone = await handleNodes(
      inv('nodes'),
      createTestContext({ meshMode: 'standalone' })
    );
    expect(standalone.text).toBe('messaging.nodes.standalone');
    const listed = await handleNodes(
      inv('nodes'),
      createTestContext({
        nodes: [
          { id: 'local-id', name: 'Home', online: true, version: '1', current: true },
          { id: 'p2', name: 'Office', online: false, version: null, current: false },
        ],
      })
    );
    const lines = listed.sections?.[0]?.lines ?? [];
    expect(lines[0]).toContain('Home');
    expect(lines[1]).toContain('Office');
  });

  test('devices lists name type and connection', async () => {
    const result = await handleDevices(inv('devices'), deviceCtx());
    expect(result.sections?.[0]?.lines[0]).toContain('laptop');
    expect(result.sections?.[0]?.lines[0]).toContain('local');
  });

  test('windows and panes resolve device name', async () => {
    const ctx = deviceCtx();
    const windows = await handleWindows(inv('windows', ['laptop']), ctx);
    expect(windows.sections?.[0]?.lines[0]).toContain('main');
    const panes = await handlePanes(inv('panes', ['laptop', '1']), ctx);
    expect(panes.sections?.[0]?.lines.some((line) => line.includes('%1'))).toBe(true);
  });

  test('windows reports unknown device', async () => {
    const result = await handleWindows(inv('windows', ['nope']), deviceCtx());
    expect(result.error?.code).toBe('messaging.error.unknownDevice');
  });

  test('tail captures by pane id and index', async () => {
    const ctx = deviceCtx();
    const byId = await handleTail(inv('tail', ['laptop', '%1', '10']), ctx);
    expect(byId.sections?.[0]?.code).toBe(true);
    expect(byId.sections?.[0]?.lines[0]).toBe('captured');
    const byIndex = await handleTail(inv('tail', ['dev-1', '1.1']), ctx);
    expect(byIndex.sections?.[0]?.lines[0]).toBe('captured');
  });

  test('tail rejects invalid line counts', async () => {
    const result = await handleTail(inv('tail', ['laptop', '%1', '999']), deviceCtx());
    expect(result.error?.code).toBe('messaging.error.invalidLines');
  });

  test('run sends keys with enter and requires a tail', async () => {
    const sent: Array<[string, string, string]> = [];
    const ctx = createTestContext({
      devices: [{ id: 'dev-1', name: 'laptop', type: 'local', connected: true, lastError: null }],
      windowsByDevice: { 'dev-1': sampleWindows },
      sendKeys: async (deviceId, paneId, text) => {
        sent.push([deviceId, paneId, text]);
      },
    });
    const missing = await handleRun(inv('run', ['laptop', '%1']), ctx);
    expect(missing.error?.code).toBe('messaging.error.missingTail');
    const ok = await handleRun(inv('run', ['laptop', '%1'], { tail: 'echo hi' }), ctx);
    expect(ok.text).toBe('messaging.run.sent');
    expect(sent).toEqual([['dev-1', '%1', 'echo hi\r']]);
  });

  test('approve and deny', async () => {
    const calls: Array<[string, boolean, string | undefined]> = [];
    const ctx = createTestContext({
      decideConfirmation: (id, approved, reason) => {
        calls.push([id, approved, reason]);
        return { ok: true };
      },
    });
    expect((await handleApprove(inv('approve', ['c1']), ctx)).text).toBe('messaging.approve.ok');
    expect((await handleDeny(inv('deny', ['c1', 'nope']), ctx)).text).toBe('messaging.deny.ok');
    expect(calls).toEqual([
      ['c1', true, undefined],
      ['c1', false, 'nope'],
    ]);
  });

  test('pane ambiguity lists candidates', async () => {
    const ctx = createTestContext({
      devices: [{ id: 'dev-1', name: 'laptop', type: 'local', connected: true, lastError: null }],
      windowsByDevice: {
        'dev-1': [
          sampleWindows[0]!,
          {
            ...sampleWindows[0]!,
            id: '@2',
            index: 1,
            panes: sampleWindows[0]!.panes.map((pane) => ({ ...pane, windowId: '@2' })),
          },
        ],
      },
    });
    const result = await handleTail(inv('tail', ['laptop', '1.0']), ctx);
    expect(result.error?.code).toBe('messaging.error.ambiguousPane');
  });
});
