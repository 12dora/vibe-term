import { describe, expect, spyOn, test } from 'bun:test';

import {
  buildOrphanSweepScript,
  orphanOwnedByServer,
  orphanRejectReason,
  parseOrphanSweep,
  sameMemorySlice,
  sweepReleaseOrphans,
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

  test('a dead launcher is rejected even when the process tree claims the scope', () => {
    const server = `${SLICE}/tmux.scope`;
    const dead = unit({ launcherPid: 555, launcherAlive: false, treeHit: true });
    expect(orphanRejectReason(dead, 99, server)).toBe('exited-server');
    expect(orphanOwnedByServer(dead, 99, server)).toBe(false);
    expect(
      orphanRejectReason(unit({ launcherPid: 99, launcherAlive: false }), 99, server)
    ).toBeNull();
    expect(orphanRejectReason(unit({ launcherPid: 555, treeHit: false }), 99, server)).toBe(
      'no-tree'
    );
  });

  test('sweep script batches show, skips live scopes, and checks limited before the process walk', async () => {
    const script = buildOrphanSweepScript([4242, 99], ['tmux-spawn-abc.scope']);
    expect(script).toContain('VTORPHAN_SWEEP');
    expect(script).toContain('4242');
    expect(script).toContain('launched by process');
    expect(script).toContain('cgroup.procs');
    expect(script).toContain('mixed-server');
    expect(script).not.toContain('live_pat');
    expect(script).toContain('tmux-spawn-abc.scope) continue ;;');
    expect(script.match(/systemctl --user show/g)).toHaveLength(1);
    expect(script.indexOf('mem_limited')).toBeLessThan(script.indexOf('tree_owns "$cg"'));
    expect(script.indexOf('export XDG_RUNTIME_DIR=')).toBeGreaterThanOrEqual(0);
    expect(script.indexOf('DBUS_SESSION_BUS_ADDRESS')).toBeLessThan(script.indexOf('systemctl'));
    const proc = Bun.spawn(['sh', '-n', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  });

  test('two live scopes are literal case arms, so sh skips both and keeps the other', async () => {
    const script = buildOrphanSweepScript(
      [1],
      ['tmux-spawn-a.scope', 'tmux-spawn-b.scope', 'tmux-spawn-bad;rm.scope', 'nope']
    );
    expect(script).toContain('tmux-spawn-a.scope|tmux-spawn-b.scope) continue ;;');
    expect(script).not.toContain('live_pat');
    expect(script).not.toContain('bad');
    expect(script).not.toContain('nope');
    const arm = script.match(/ {4}tmux-spawn-[^\n]+\) continue ;;/)?.[0];
    expect(arm).toBe('    tmux-spawn-a.scope|tmux-spawn-b.scope) continue ;;');
    const driver = [
      'for name in tmux-spawn-a.scope tmux-spawn-b.scope tmux-spawn-c.scope; do',
      '  case "$name" in',
      arm ?? '',
      '    *) printf "keep %s\\n" "$name" ;;',
      '  esac',
      'done',
    ].join('\n');
    const proc = Bun.spawn(['sh', '-c', driver], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toBe('keep tmux-spawn-c.scope\n');
  });

  test('an exited tmux server is rejected once and not released', async () => {
    const info = spyOn(console, 'info').mockImplementation(() => {});
    const high = 8192 * 1_048_576;
    const max = 12288 * 1_048_576;
    const swap = 4096 * 1_048_576;
    const stdout = [
      'VTORPHAN 1 ok',
      `SERVER\t99\t${SLICE}/tmux.scope`,
      `UNIT\ttmux-spawn-dead.scope\t50\t${SLICE}/tmux-spawn-dead.scope\t${high}\t${max}\t${swap}\t1\t0`,
    ].join('\n');
    const host = { runHostShell: async () => ({ stdout, stderr: '', exitCode: 0 }) };
    const opts = {
      host,
      deviceId: 'dev',
      now: 0,
      panes: [{ paneId: '%1', windowId: '@1', windowName: 'w', pid: 1 }],
      liveScopes: [] as string[],
      states: new Map(),
      warned: new Set<string>(),
      triples: [{ memoryHighMb: 8192, memoryMaxMb: 12288, memorySwapMaxMb: 4096 }],
    };
    expect(await sweepReleaseOrphans(opts)).toEqual([]);
    expect(await sweepReleaseOrphans(opts)).toEqual([]);
    const lines = info.mock.calls.filter((args) => String(args[0]).includes('exited-server'));
    expect(lines).toHaveLength(1);
    expect(String(lines[0]?.[0])).toContain('launcher pid is not running');
    expect(String(lines[0]?.[0])).toContain('leaving the cap in place');
    info.mockRestore();
  });

  test('unreadable orphan swap matches on high and max; a real zero does not', async () => {
    const info = spyOn(console, 'info').mockImplementation(() => {});
    const high = 8192 * 1_048_576;
    const max = 12288 * 1_048_576;
    const triples = [{ memoryHighMb: 8192, memoryMaxMb: 12288, memorySwapMaxMb: 4096 }];
    const hostFor = (swapField: string) => ({
      runHostShell: async () => ({
        stdout: [
          'VTORPHAN 1 ok',
          `SERVER\t99\t${SLICE}/tmux.scope`,
          `UNIT\ttmux-spawn-noswap.scope\t99\t${SLICE}/tmux-spawn-noswap.scope\t${high}\t${max}\t${swapField}\t0\t1`,
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      }),
    });
    const base = {
      deviceId: 'dev',
      now: 0,
      panes: [{ paneId: '%1', windowId: '@1', windowName: 'w', pid: 1 }],
      liveScopes: [] as string[],
      warned: new Set<string>(),
      triples,
    };
    const unknown = await sweepReleaseOrphans({
      ...base,
      host: hostFor('?'),
      states: new Map(),
    });
    const realZero = await sweepReleaseOrphans({
      ...base,
      host: hostFor('0'),
      states: new Map(),
    });
    expect(unknown.map((write) => write.state.scope)).toEqual(['tmux-spawn-noswap.scope']);
    expect(realZero).toEqual([]);
    info.mockRestore();
  });
});
