import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TmuxSession } from '@vibeterm/shared';
import { NotFoundError, UsageError } from '../core/errors';
import { type FakeTermContext, createFakeTermContext, fakeSession } from '../core/term-test-fakes';
import { parseGeometry, command as tmux } from './tmux';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function harness(options: { json?: boolean; session?: TmuxSession } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-cli-tmux-'));
  dirs.push(dir);
  return createFakeTermContext({
    session: options.session ?? fakeSession(),
    configDir: dir,
    json: options.json ?? false,
    timeoutMs: 1_000,
  });
}

function jsonOf(harnessed: FakeTermContext): unknown {
  return JSON.parse(harnessed.stdout.text().trim());
}

describe('vibeterm tmux ls / windows / panes', () => {
  test('ls --json is the canonical TmuxSession[]', async () => {
    const h = await harness({ json: true });
    await tmux.run(h.ctx, ['ls', 'laptop']);
    expect(jsonOf(h)).toEqual([fakeSession()] as never);
    expect(h.closed()).toBe(1);
  });

  test('ls prints the session tree with an active marker', async () => {
    const h = await harness();
    await tmux.run(h.ctx, ['ls', 'laptop']);
    const text = h.stdout.text();
    expect(text).toContain('session $0 (main)');
    expect(text).toContain('* 0: shell  @0');
    expect(text).toContain('1.1: %2');
  });

  test('windows lists every window', async () => {
    const h = await harness();
    await tmux.run(h.ctx, ['windows', 'laptop']);
    expect(h.stdout.text()).toContain('@1');
  });

  test('panes defaults to the located window', async () => {
    const h = await harness({ json: true });
    await tmux.run(h.ctx, ['panes', 'laptop:build']);
    expect((jsonOf(h) as Array<{ id: string }>).map((pane) => pane.id)).toEqual(['%1', '%2']);
  });

  test('panes --all crosses windows', async () => {
    const h = await harness({ json: true });
    await tmux.run(h.ctx, ['panes', 'laptop', '--all']);
    expect((jsonOf(h) as unknown[]).length).toBe(3);
  });
});

describe('vibeterm tmux control commands', () => {
  test('new-window waits for the window to appear in the tree', async () => {
    const h = await harness({ json: true });
    h.transport.onCommand = (command) => {
      if (command.type !== 'create-window') return;
      const next = fakeSession();
      next.windows.push({ id: '@9', name: 'built', index: 2, active: false, panes: [] });
      queueMicrotask(() => h.transport.emitTree(next));
    };
    await tmux.run(h.ctx, ['new-window', 'laptop', '--name', 'built']);
    expect(jsonOf(h)).toEqual({
      ok: true,
      action: 'created',
      window: { id: '@9', index: 2, name: 'built', active: false, panes: 0 },
    } as never);
    expect(h.transport.commandsOfType('create-window')[0]).toMatchObject({ name: 'built' });
  });

  test('kill-window waits for the window to disappear', async () => {
    const h = await harness();
    h.transport.onCommand = (command) => {
      if (command.type !== 'close-window') return;
      const next = fakeSession();
      next.windows = next.windows.filter((window) => window.id !== command.windowId);
      queueMicrotask(() => h.transport.emitTree(next));
    };
    await tmux.run(h.ctx, ['kill-window', 'laptop:build']);
    expect(h.stdout.text()).toContain('closed window: @1');
  });

  test('split targets the located pane and reports the new one', async () => {
    const h = await harness();
    h.transport.onCommand = (command) => {
      if (command.type !== 'split-pane') return;
      const next = fakeSession();
      next.windows[1].panes.push({
        id: '%7',
        windowId: '@1',
        index: 2,
        active: true,
        width: 40,
        height: 12,
      });
      queueMicrotask(() => h.transport.emitTree(next));
    };
    await tmux.run(h.ctx, ['split', 'laptop:build.0', '--horizontal']);
    expect(h.transport.commandsOfType('split-pane')[0]).toMatchObject({
      paneId: '%1',
      direction: 'right',
    });
    expect(h.stdout.text()).toContain('split: %7');
  });

  test('a change that never lands fails with a network error', async () => {
    const h = await harness();
    await expect(tmux.run(h.ctx, ['kill-pane', 'laptop:build.1'])).rejects.toThrow(
      /timed out waiting for pane %2 to close/
    );
    expect(h.closed()).toBe(1);
  });

  test('--horizontal and --vertical together is a usage error', async () => {
    const h = await harness();
    await expect(
      tmux.run(h.ctx, ['split', 'laptop', '--horizontal', '--vertical'])
    ).rejects.toThrow(UsageError);
  });

  test('an unknown window is a not-found error', async () => {
    const h = await harness();
    await expect(tmux.run(h.ctx, ['select', 'laptop:ghost'])).rejects.toThrow(NotFoundError);
  });
});

describe('vibeterm tmux argument handling', () => {
  test('an unknown subcommand and a missing target are usage errors', async () => {
    const h = await harness();
    await expect(tmux.run(h.ctx, ['frobnicate', 'laptop'])).rejects.toThrow(UsageError);
    await expect(tmux.run(h.ctx, ['ls'])).rejects.toThrow(UsageError);
    await expect(tmux.run(h.ctx, [])).rejects.toThrow(UsageError);
  });

  test('parseGeometry accepts <cols>x<rows> only', () => {
    expect(parseGeometry('80x24')).toEqual({ cols: 80, rows: 24 });
    expect(parseGeometry('80X24')).toEqual({ cols: 80, rows: 24 });
    expect(() => parseGeometry('80')).toThrow(UsageError);
    expect(() => parseGeometry('0x10')).toThrow(UsageError);
    expect(() => parseGeometry(undefined)).toThrow(UsageError);
  });
});
