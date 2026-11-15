import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

import { isInsideSlice, parseUserRoot, serverScopeName } from './cgroup-paths';
import { CgroupPlacement, readPlacementConfig } from './cgroup-placement';
import type { PlacementIo } from './cgroup-placement-io';

const UID = 1000;
const ROOT = `/user.slice/user-${UID}.slice/user@${UID}.service`;
const APP = `${ROOT}/app.slice`;
const SESSION = `${ROOT}/session.slice`;

type ShellReply = { exitCode: number; stdout?: string; stderr?: string };

interface FakeIo extends PlacementIo {
  files: Map<string, string>;
  scripts: string[];
  sleeps: number;
  /** 模拟 systemd job：第 n 次 sleep 之后才生效。 */
  later(steps: number, run: () => void): void;
}

function fakeIo(
  overrides: Partial<PlacementIo> = {},
  reply: (script: string, io: FakeIo) => ShellReply = () => ({ exitCode: 0 })
): FakeIo {
  const files = new Map<string, string>([
    ['/sys/fs/cgroup/cgroup.controllers', 'memory pids\n'],
    ['/proc/self/cgroup', `0::${SESSION}/vibeterm.service\n`],
  ]);
  const jobs: Array<{ due: number; run: () => void }> = [];
  const io: FakeIo = {
    platform: 'linux',
    uid: UID,
    env: {},
    files,
    scripts: [],
    sleeps: 0,
    later: (steps, run) => {
      jobs.push({ due: io.sleeps + steps, run });
    },
    sleep: async () => {
      io.sleeps += 1;
      for (const job of jobs.splice(0)) {
        if (job.due <= io.sleeps) job.run();
        else jobs.push(job);
      }
    },
    readFile: async (path) => files.get(path) ?? null,
    exists: async (path) => files.has(path),
    runShell: async (script) => {
      io.scripts.push(script);
      if (script.includes("'Version'")) return { exitCode: 0, stdout: 'VTPLACE ok\n', stderr: '' };
      const result = reply(script, io);
      return { stdout: '', stderr: '', ...result };
    },
    ...overrides,
  };
  return io;
}

function addProcess(io: FakeIo, pid: number, cgroup: string, uid = UID, ppid = 1): void {
  io.files.set(`/proc/${pid}/cgroup`, `0::${cgroup}\n`);
  io.files.set(
    `/proc/${pid}/status`,
    `Name:\tx\nPPid:\t${ppid}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`
  );
}

function unitIn(script: string): string {
  return /'(vibeterm-(?:pane|tmux)-[^']+\.scope)'/.exec(script)?.[1] ?? '';
}

function busCalls(io: FakeIo): string[] {
  return io.scripts.filter((script) => script.includes("'call'"));
}

afterEach(() => {
  mock.restore();
});

describe('cgroup path helpers', () => {
  test('user root requires the own uid and nested slices count as inside', () => {
    expect(parseUserRoot(`${APP}/vibeterm.service`, UID)).toBe(ROOT);
    expect(parseUserRoot(`${APP}/vibeterm.service`, 1001)).toBeNull();
    expect(parseUserRoot(`/user.slice/user-${UID}.slice/session-3.scope`, UID)).toBeNull();
    expect(isInsideSlice(`${APP}/app-x.slice/a.scope`, ROOT, 'app.slice')).toBe(true);
    expect(isInsideSlice(`${SESSION}/a.scope`, ROOT, 'app.slice')).toBe(false);
    expect(serverScopeName('/tmp/tmux-1000/default')).toMatch(
      /^vibeterm-tmux-[0-9a-f]{12}\.scope$/
    );
  });
});

describe('readPlacementConfig', () => {
  test('defaults, off switch, test default and slice validation', () => {
    expect(readPlacementConfig({})).toEqual({
      mode: 'auto',
      protectedSlice: 'session.slice',
      workloadSlice: 'app.slice',
    });
    expect(readPlacementConfig({ NODE_ENV: 'test' }).mode).toBe('off');
    expect(readPlacementConfig({ NODE_ENV: 'test', VIBETERM_CGROUP_PLACEMENT: 'auto' }).mode).toBe(
      'auto'
    );
    expect(readPlacementConfig({ VIBETERM_CGROUP_PLACEMENT: 'off' }).mode).toBe('off');
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const bad = readPlacementConfig({
      VIBETERM_PROTECTED_SLICE: 'a/b.slice',
      VIBETERM_WORKLOAD_SLICE: 'heavy.scope',
    });
    expect(bad.protectedSlice).toBe('session.slice');
    expect(bad.workloadSlice).toBe('app.slice');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(readPlacementConfig({ VIBETERM_WORKLOAD_SLICE: 'heavy.slice' }).workloadSlice).toBe(
      'heavy.slice'
    );
  });
});

describe('probePlacementSupport', () => {
  test('supported on linux + cgroup2 + busctl + user manager', async () => {
    const placement = new CgroupPlacement(fakeIo());
    expect(await placement.probePlacementSupport()).toEqual({
      supported: true,
      userRoot: ROOT,
      ownCgroup: `${SESSION}/vibeterm.service`,
    });
    expect(placement.modeLabel()).toBe('auto');
  });

  test('result is cached per process', async () => {
    const io = fakeIo();
    const placement = new CgroupPlacement(io);
    await placement.probePlacementSupport();
    await placement.probePlacementSupport();
    expect(io.scripts).toHaveLength(1);
  });

  test.each([
    ['not-linux', { platform: 'darwin' as NodeJS.Platform }],
    ['off', { env: { VIBETERM_CGROUP_PLACEMENT: 'off' } }],
  ])('%s', async (reason, overrides) => {
    const io = fakeIo(overrides);
    const placement = new CgroupPlacement(io);
    expect(await placement.probePlacementSupport()).toEqual({ supported: false, reason });
    expect(io.scripts).toHaveLength(0);
  });

  test('no cgroup2', async () => {
    const io = fakeIo();
    io.files.delete('/sys/fs/cgroup/cgroup.controllers');
    const placement = new CgroupPlacement(io);
    expect(await placement.probePlacementSupport()).toEqual({
      supported: false,
      reason: 'no-cgroup2',
    });
    expect(placement.modeLabel()).toBe('unsupported:no-cgroup2');
  });

  test('gateway not under the user manager', async () => {
    const io = fakeIo();
    io.files.set('/proc/self/cgroup', `0::/user.slice/user-${UID}.slice/session-4.scope\n`);
    const placement = new CgroupPlacement(io);
    expect(await placement.probePlacementSupport()).toEqual({
      supported: false,
      reason: 'not-user-manager',
    });
  });

  test('no busctl / no user manager / shell failure', async () => {
    for (const [stdout, reason] of [
      ['VTPLACE no-busctl\n', 'no-busctl'],
      ['VTPLACE no-user-manager\n', 'no-user-manager'],
      ['', 'probe-failed'],
    ]) {
      const io = fakeIo({
        runShell: async () => ({ exitCode: 0, stdout: stdout ?? '', stderr: '' }),
      });
      const placement = new CgroupPlacement(io);
      expect(await placement.probePlacementSupport()).toEqual({ supported: false, reason });
    }
    const throwing = new CgroupPlacement(
      fakeIo({
        runShell: async () => {
          throw new Error('spawn failed');
        },
      })
    );
    expect(await throwing.probePlacementSupport()).toEqual({
      supported: false,
      reason: 'probe-failed',
    });
  });
});

describe('protectTmuxServer', () => {
  test('server in a workload scope moves alone into the protected slice', async () => {
    const io = fakeIo({}, (script, fake) => {
      if (script.includes('StartTransientUnit')) {
        const unit = unitIn(script);
        fake.later(3, () => addProcess(fake, 500, `${SESSION}/${unit}`));
      }
      return { exitCode: 0 };
    });
    addProcess(io, 500, `${APP}/tmux-spawn-1.scope`);
    const placement = new CgroupPlacement(io);
    const result = await placement.protectTmuxServer(500, '/tmp/tmux-1000/default');
    const unit = serverScopeName('/tmp/tmux-1000/default');
    expect(result).toEqual({ action: 'moved', cgroup: `${SESSION}/${unit}` });
    expect(io.sleeps).toBe(3);
    const [call] = busCalls(io);
    expect(call).toContain(
      `'StartTransientUnit' 'ssa(sv)a(sa(sv))' '${unit}' 'fail' '5' 'PIDs' 'au' '1' '500' 'Slice' 's' 'session.slice' 'CollectMode' 's' 'inactive-or-failed'`
    );
    expect(call).toContain("'Delegate' 'b' 'true' '0'");
    expect(call).toContain('DBUS_SESSION_BUS_ADDRESS');
    expect(placement.getStatus().movedServers).toBe(1);
  });

  test('existing server scope falls back to AttachProcessesToUnit', async () => {
    const io = fakeIo({}, (script, fake) => {
      if (script.includes('StartTransientUnit')) {
        return { exitCode: 1, stderr: 'Unit vibeterm-tmux-x.scope already exists.' };
      }
      addProcess(fake, 500, `${SESSION}/${serverScopeName('/s')}`);
      return { exitCode: 0 };
    });
    addProcess(io, 500, `${APP}/tmux-server-1.scope`);
    const placement = new CgroupPlacement(io);
    expect(await placement.protectTmuxServer(500, '/s')).toEqual({
      action: 'moved',
      cgroup: `${SESSION}/${serverScopeName('/s')}`,
    });
    expect(busCalls(io)[1]).toContain(
      `'AttachProcessesToUnit' 'ssau' '${serverScopeName('/s')}' '/' '1' '500'`
    );
  });

  test('server in a workload service is not moved and logs advice once', async () => {
    const info = spyOn(console, 'info').mockImplementation(() => {});
    const io = fakeIo();
    addProcess(io, 500, `${APP}/vibeterm.service`);
    const placement = new CgroupPlacement(io);
    expect((await placement.protectTmuxServer(500, '/s')).action).toBe('service');
    expect((await placement.protectTmuxServer(500, '/s')).action).toBe('service');
    expect(busCalls(io)).toHaveLength(0);
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toContain('Slice=session.slice');
  });

  test('already protected server is left alone', async () => {
    const io = fakeIo();
    addProcess(io, 500, `${SESSION}/vibeterm.service`);
    const placement = new CgroupPlacement(io);
    expect(await placement.protectTmuxServer(500, '/s')).toEqual({
      action: 'kept',
      cgroup: `${SESSION}/vibeterm.service`,
    });
    expect(busCalls(io)).toHaveLength(0);
  });

  test('foreign uid is never moved', async () => {
    const io = fakeIo();
    addProcess(io, 500, `${APP}/tmux-spawn-1.scope`, 0);
    const placement = new CgroupPlacement(io);
    expect((await placement.protectTmuxServer(500, '/s')).action).toBe('skipped');
    expect(busCalls(io)).toHaveLength(0);
  });

  test('busctl failure warns once and never throws', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const io = fakeIo({}, () => ({ exitCode: 1, stderr: 'Access denied' }));
    addProcess(io, 500, `${APP}/tmux-spawn-1.scope`);
    const placement = new CgroupPlacement(io);
    expect((await placement.protectTmuxServer(500, '/s')).action).toBe('failed');
    expect((await placement.protectTmuxServer(500, '/s')).action).toBe('failed');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('Access denied');
  });
});

describe('placePane', () => {
  const spawnScope = `${SESSION}/tmux-spawn-11111111-2222-3333-4444-555555555555.scope`;
  const procs = `/sys/fs/cgroup${spawnScope}/cgroup.procs`;

  test('pane in a protected tmux-spawn scope moves with all pids, leftovers attached', async () => {
    let started = '';
    const io = fakeIo({}, (script, fake) => {
      if (script.includes('StartTransientUnit')) {
        started = unitIn(script);
        fake.later(2, () => {
          addProcess(fake, 700, `${APP}/${started}`, UID, 500);
          addProcess(fake, 701, `${APP}/${started}`);
          addProcess(fake, 703, spawnScope);
          fake.files.set(procs, '702\n703\n');
        });
      }
      return { exitCode: 0 };
    });
    addProcess(io, 700, spawnScope, UID, 500);
    addProcess(io, 701, spawnScope);
    addProcess(io, 702, spawnScope, 0);
    io.files.set(procs, '700\n701\n702\n');
    const placement = new CgroupPlacement(io);
    expect(await placement.placePane(700)).toBe(true);
    const [start, attach] = busCalls(io);
    expect(start).toContain("'PIDs' 'au' '2' '700' '701' 'Slice' 's' 'app.slice'");
    expect(start).toContain("'tmux child pane 700 launched by process 500'");
    expect(started).toMatch(/^vibeterm-pane-[0-9a-f-]{36}\.scope$/);
    expect(start).toContain("'Delegate' 'b' 'true'");
    expect(attach).toContain(`'AttachProcessesToUnit' 'ssau' '${started}' '/' '1' '703'`);
    expect(busCalls(io)).toHaveLength(2);
    expect(io.sleeps).toBe(2);
    expect(placement.getStatus().movedPanes).toBe(1);
  });

  test('a job that never lands times out after 1.5 s of polling, without attach', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const io = fakeIo();
    addProcess(io, 700, spawnScope);
    io.files.set(procs, '700\n');
    const placement = new CgroupPlacement(io);
    expect(await placement.placePane(700)).toBe(false);
    expect(busCalls(io)).toHaveLength(1);
    expect(io.sleeps).toBe(30);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('pane-wait');
    expect(placement.getStatus().movedPanes).toBe(0);
  });

  test('no leftover means no attach call', async () => {
    const io = fakeIo({}, (script, fake) => {
      if (script.includes('StartTransientUnit')) {
        addProcess(fake, 700, `${APP}/${unitIn(script)}`);
        fake.files.delete(procs);
      }
      return { exitCode: 0 };
    });
    addProcess(io, 700, spawnScope);
    io.files.set(procs, '700\n');
    const placement = new CgroupPlacement(io);
    expect(await placement.placePane(700)).toBe(true);
    expect(busCalls(io)).toHaveLength(1);
  });

  test('pane already in the workload slice or not a tmux-spawn scope stays', async () => {
    const io = fakeIo();
    addProcess(io, 700, `${APP}/tmux-spawn-1.scope`);
    addProcess(io, 701, `${SESSION}/vibeterm-pane-1.scope`);
    addProcess(io, 702, `/user.slice/user-${UID}.slice/session-2.scope`);
    const placement = new CgroupPlacement(io);
    expect(await placement.placePane(700)).toBe(false);
    expect(await placement.placePane(701)).toBe(false);
    expect(await placement.placePane(702)).toBe(false);
    expect(busCalls(io)).toHaveLength(0);
  });

  test('busctl failure warns once per kind and returns false', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const io = fakeIo({}, () => ({ exitCode: 124, stderr: 'timeout' }));
    addProcess(io, 700, spawnScope);
    addProcess(io, 701, spawnScope);
    io.files.set(procs, '700\n701\n');
    const placement = new CgroupPlacement(io);
    expect(await placement.placePane(700)).toBe(false);
    expect(await placement.placePane(701)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('placePanes is gated by the device and skips seen pids', async () => {
    const io = fakeIo();
    addProcess(io, 700, `${APP}/tmux-spawn-1.scope`);
    const placement = new CgroupPlacement(io);
    expect(await placement.placePanes('dev', [700])).toBe(0);
    expect(io.scripts).toHaveLength(0);
    placement.enableDevice('dev');
    await placement.placePanes('dev', [700, 700]);
    const reads = io.scripts.length;
    await placement.placePanes('dev', [700]);
    expect(io.scripts.length).toBe(reads);
  });
});
