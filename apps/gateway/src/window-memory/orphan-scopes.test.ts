import { describe, expect, test } from 'bun:test';

import {
  buildOrphanSweepScript,
  orphanOwnedByServer,
  orphanRejectReason,
  parseOrphanSweep,
  sameMemorySlice,
} from './orphan-scopes';
import type { ListedScope } from './orphan-scopes';

const SLICE = '/user.slice/user-1.slice/user@1.service/app.slice';

function unit(overrides: Partial<ListedScope> = {}): ListedScope {
  return {
    scope: 'tmux-spawn-orphan.scope',
    launcherPid: 99,
    controlGroup: `${SLICE}/tmux-spawn-orphan.scope`,
    high: 100,
    max: 200,
    swapMax: 0,
    treeHit: false,
    ...overrides,
  };
}

describe('orphan scope ownership', () => {
  test('launcher pid is enough even when the server is in another slice', () => {
    const session = '/user.slice/user-1000.slice/session-12.scope';
    const scope = '/user.slice/user-1000.slice/user@1000.service/app.slice/tmux-spawn-orphan.scope';
    expect(orphanOwnedByServer(unit({ controlGroup: scope }), 99, session)).toBe(true);
    expect(
      orphanOwnedByServer(
        unit({ controlGroup: scope, launcherPid: null, treeHit: true }),
        99,
        session
      )
    ).toBe(false);
    expect(orphanOwnedByServer(unit({ launcherPid: 555 }), 99, `${SLICE}/tmux.scope`)).toBe(false);
    expect(sameMemorySlice(`${SLICE}/tmux-spawn-orphan.scope`, `${SLICE}/tmux.scope`)).toBe(true);
  });

  test('reparented scope is still ours when Description names our server', () => {
    expect(orphanOwnedByServer(unit({ treeHit: false }), 99, `${SLICE}/tmux.scope`)).toBe(true);
  });

  test('missing Description can fall back to a process still under our server', () => {
    expect(
      orphanOwnedByServer(unit({ launcherPid: null, treeHit: true }), 99, `${SLICE}/tmux.scope`)
    ).toBe(true);
    expect(
      orphanOwnedByServer(unit({ launcherPid: null, treeHit: false }), 99, `${SLICE}/tmux.scope`)
    ).toBe(false);
  });

  test('parser keeps finite units and rejects a sweep that could not name our server', () => {
    const parsed = parseOrphanSweep(
      [
        'VTORPHAN 1 ok',
        `SERVER\t99\t${SLICE}/tmux.scope`,
        `UNIT\ttmux-spawn-orphan.scope\t99\t${SLICE}/tmux-spawn-orphan.scope\t100\tinfinity\t-\t0`,
        'UNIT\tnot-a-scope\t99\t/tmp/not-a-scope\t100\t100\t100\t0',
      ].join('\n')
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.serverPid).toBe(99);
    expect(parsed.units).toEqual([
      {
        scope: 'tmux-spawn-orphan.scope',
        launcherPid: 99,
        controlGroup: `${SLICE}/tmux-spawn-orphan.scope`,
        high: 100,
        max: 0,
        swapMax: 0,
        treeHit: false,
      },
    ]);
    expect(parseOrphanSweep('VTORPHAN 0 no-server\n').ok).toBe(false);
  });

  test('limited candidates say why they were rejected', () => {
    const server = `${SLICE}/tmux.scope`;
    expect(orphanRejectReason(unit({ launcherPid: 555, treeHit: false }), 99, server)).toBe(
      'no-tree'
    );
    expect(orphanRejectReason(unit({ launcherPid: null, treeHit: false }), 99, server)).toBe(
      'launcher'
    );
    expect(
      orphanRejectReason(
        unit({
          launcherPid: 555,
          treeHit: true,
          controlGroup: '/system.slice/tmux-spawn-orphan.scope',
        }),
        99,
        server
      )
    ).toBe('slice');
  });

  test('uint64 infinity reads as unlimited and does not drop the unit', () => {
    const parsed = parseOrphanSweep(
      [
        'VTORPHAN 1 ok',
        `SERVER\t99\t${SLICE}/tmux.scope`,
        `UNIT\ttmux-spawn-orphan.scope\t99\t${SLICE}/tmux-spawn-orphan.scope\t18446744073709551615\t100\t-\t0`,
      ].join('\n')
    );
    expect(parsed.units[0]).toEqual(expect.objectContaining({ high: 0, max: 100, swapMax: 0 }));
  });

  test('sweep script batches show, skips live scopes, and checks limited before the process walk', async () => {
    const script = buildOrphanSweepScript([4242, 99], ['tmux-spawn-abc.scope']);
    expect(script).toContain('VTORPHAN_SWEEP');
    expect(script).toContain('4242');
    expect(script).toContain('launched by process');
    expect(script).toContain('cgroup.procs');
    expect(script).toContain('mixed-server');
    expect(script).toContain("live_pat='tmux-spawn-abc.scope'");
    expect(script.match(/systemctl --user show/g)).toHaveLength(1);
    expect(script.indexOf('mem_limited')).toBeLessThan(script.indexOf('tree_owns "$cg"'));
    expect(script.indexOf('export XDG_RUNTIME_DIR=')).toBeGreaterThanOrEqual(0);
    expect(script.indexOf('DBUS_SESSION_BUS_ADDRESS')).toBeLessThan(script.indexOf('systemctl'));
    const proc = Bun.spawn(['sh', '-n', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  });
});
