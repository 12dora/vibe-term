import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TmuxSession } from '@vibeterm/shared';
import { NotFoundError, UsageError } from '../core/errors';
import { type FakeTermContext, createFakeTermContext, fakeSession } from '../core/term-test-fakes';
import { parseGeometry, command as tmux } from './tmux';
import { parseIdList, parseMovePosition } from './tmux-layout';

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

describe('vibeterm tmux rename normalisation', () => {
  test('the predicate uses the gateway normalisation (trim + 64 chars)', async () => {
    const h = await harness();
    h.transport.onCommand = (command) => {
      if (command.type !== 'rename-window') return;
      const next = fakeSession();
      // 网关侧 renameWindow 存的是 trim + slice(0,64) 之后的值。
      next.windows[1].customName = command.name.trim().slice(0, 64);
      queueMicrotask(() => h.transport.emitTree(next));
    };
    await tmux.run(h.ctx, ['rename-window', 'laptop:build', '  deploy  ']);
    expect(h.transport.commandsOfType('rename-window')[0].name).toBe('deploy');
    expect(h.stdout.text()).toContain('deploy');
  });

  test('an empty name clears the custom name', async () => {
    const h = await harness();
    h.transport.onCommand = (command) => {
      if (command.type !== 'rename-pane') return;
      queueMicrotask(() => h.transport.emitTree(fakeSession()));
    };
    await tmux.run(h.ctx, ['rename-pane', 'laptop:build.1', '--name', '   ']);
    expect(h.transport.commandsOfType('rename-pane')[0].name).toBe('');
    expect(h.stdout.text()).toContain('renamed: %2');
  });
});

describe('vibeterm tmux when the session disappears', () => {
  test('kill-window succeeds when closing the last window destroys the session', async () => {
    const h = await harness();
    h.transport.onCommand = (command) => {
      if (command.type !== 'close-window') return;
      queueMicrotask(() => h.transport.emitTree(null));
    };
    await tmux.run(h.ctx, ['kill-window', 'laptop:build']);
    expect(h.stdout.text()).toContain('closed window: @1');
  });

  test('a rename against a destroyed session is a not-found error, not a timeout', async () => {
    const h = await harness();
    h.transport.onCommand = (command) => {
      if (command.type !== 'rename-window') return;
      queueMicrotask(() => h.transport.emitTree(null));
    };
    await expect(tmux.run(h.ctx, ['rename-window', 'laptop:build', 'x'])).rejects.toThrow(
      NotFoundError
    );
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

describe('vibeterm tmux move / break / reorder', () => {
  test('move sends WS move-pane with GUI payload fields', async () => {
    const h = await harness({ json: true });
    h.transport.onCommand = (command) => {
      if (command.type !== 'move-pane') return;
      const next = fakeSession();
      const [first, second] = next.windows[1].panes;
      first.index = 1;
      second.index = 0;
      next.windows[1].panes = [second, first];
      queueMicrotask(() => h.transport.emitTree(next));
    };
    await tmux.run(h.ctx, ['move', 'laptop:build.0', 'laptop:build.1', '--position', 'left']);
    expect(h.transport.commandsOfType('move-pane')[0]).toMatchObject({
      srcPaneId: '%1',
      dstPaneId: '%2',
      position: 'left',
    });
    expect((jsonOf(h) as { action: string }).action).toBe('moved');
  });

  test('move accepts a pane-id shorthand on the same device and defaults position to right', async () => {
    const h = await harness();
    h.transport.onCommand = (command) => {
      if (command.type !== 'move-pane') return;
      const next = fakeSession();
      next.windows[1].panes[0].width = 40;
      queueMicrotask(() => h.transport.emitTree(next));
    };
    await tmux.run(h.ctx, ['move', 'laptop:build.0', '%2']);
    expect(h.transport.commandsOfType('move-pane')[0]).toMatchObject({
      srcPaneId: '%1',
      dstPaneId: '%2',
      position: 'right',
    });
  });

  test('move rejects the same pane and an unknown position', async () => {
    const h = await harness();
    await expect(tmux.run(h.ctx, ['move', 'laptop:build.0', '%1'])).rejects.toThrow(UsageError);
    await expect(
      tmux.run(h.ctx, ['move', 'laptop:build.0', '%2', '--position', 'middle'])
    ).rejects.toThrow(UsageError);
  });

  test('break sends WS break-pane and reports the new window', async () => {
    const h = await harness({ json: true });
    h.transport.onCommand = (command) => {
      if (command.type !== 'break-pane') return;
      const next = fakeSession();
      const pane = next.windows[1].panes.pop();
      if (!pane) return;
      pane.windowId = '@9';
      pane.index = 0;
      next.windows.push({ id: '@9', name: 'build', index: 2, active: true, panes: [pane] });
      queueMicrotask(() => h.transport.emitTree(next));
    };
    await tmux.run(h.ctx, ['break', 'laptop:build.1']);
    expect(h.transport.commandsOfType('break-pane')[0]).toMatchObject({ paneId: '%2' });
    expect(jsonOf(h)).toMatchObject({
      ok: true,
      action: 'broke',
      window: { id: '@9' },
    });
  });

  test('order-windows sends WS reorder-windows', async () => {
    const h = await harness({ json: true });
    h.transport.onCommand = (command) => {
      if (command.type !== 'reorder-windows') return;
      const next = fakeSession();
      next.windows = [next.windows[1], next.windows[0]];
      queueMicrotask(() => h.transport.emitTree(next));
    };
    await tmux.run(h.ctx, ['order-windows', 'laptop', '--ids', '@1,@0']);
    expect(h.transport.commandsOfType('reorder-windows')[0]).toMatchObject({
      windowIds: ['@1', '@0'],
    });
    expect((jsonOf(h) as { windowIds: string[] }).windowIds).toEqual(['@1', '@0']);
  });

  test('order-panes sends WS reorder-panes for the located window', async () => {
    const h = await harness();
    h.transport.onCommand = (command) => {
      if (command.type !== 'reorder-panes') return;
      const next = fakeSession();
      next.windows[1].panes = [next.windows[1].panes[1], next.windows[1].panes[0]];
      queueMicrotask(() => h.transport.emitTree(next));
    };
    await tmux.run(h.ctx, ['order-panes', 'laptop:build', '--ids', '%2,%1']);
    expect(h.transport.commandsOfType('reorder-panes')[0]).toMatchObject({
      windowId: '@1',
      paneIds: ['%2', '%1'],
    });
    expect(h.stdout.text()).toContain('reordered panes: %2,%1');
  });

  test('parseMovePosition / parseIdList reject empty or unknown values', () => {
    expect(parseMovePosition(undefined)).toBe('right');
    expect(parseMovePosition('top')).toBe('top');
    expect(() => parseMovePosition('side')).toThrow(UsageError);
    expect(parseIdList('@1,@2', '@1,@2')).toEqual(['@1', '@2']);
    expect(() => parseIdList(undefined, '@1,@2')).toThrow(UsageError);
    expect(() => parseIdList(' , ', '@1,@2')).toThrow(UsageError);
  });
});
