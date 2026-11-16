import { describe, expect, test } from 'bun:test';
import { detectServiceManager, detectServiceManagerDetail } from './platform';

function probeWith(results: Record<string, number | null>) {
  const calls: string[] = [];
  const probe = async (cmd: string, args: string[]) => {
    const key = cmd === 'systemctl' ? args.join(' ') : [cmd, ...args].join(' ');
    calls.push(key);
    const code = results[key];
    return code === null || code === undefined ? null : { code };
  };
  return { probe, calls };
}

function fsWith(paths: string[], pathEnv = '') {
  const set = new Set(paths);
  return { exists: (path: string) => set.has(path), pathEnv };
}

const NO_OPENRC = fsWith([]);
const NO_SYSTEMCTL = { '--version': null };

describe('detectServiceManager', () => {
  test('darwin → launchd without probing', async () => {
    const { probe, calls } = probeWith({});
    expect(await detectServiceManager('darwin', probe, NO_OPENRC)).toBe('launchd');
    expect(calls).toEqual([]);
  });

  test('linux with reachable user manager → systemd-user', async () => {
    const { probe } = probeWith({ '--version': 0, '--user show-environment': 0 });
    const openrc = fsWith(['/sbin/openrc-run', '/run/openrc/softlevel']);
    expect(await detectServiceManager('linux', probe, openrc)).toBe('systemd-user');
  });

  test('linux: systemctl present but user manager unreachable → none', async () => {
    const { probe, calls } = probeWith({ '--version': 0, '--user show-environment': 1 });
    expect(await detectServiceManager('linux', probe, NO_OPENRC)).toBe('none');
    expect(calls).toEqual(['--version', '--user show-environment']);
  });

  test('linux without systemctl → none', async () => {
    const { probe, calls } = probeWith(NO_SYSTEMCTL);
    expect(await detectServiceManager('linux', probe, NO_OPENRC)).toBe('none');
    expect(calls).toEqual(['--version']);
  });

  test('other platforms → none', async () => {
    const { probe } = probeWith({});
    expect(await detectServiceManager('win32', probe, NO_OPENRC)).toBe('none');
  });
});

describe('detectServiceManagerDetail: OpenRC', () => {
  test('booted OpenRC without systemctl → openrc', async () => {
    const { probe, calls } = probeWith(NO_SYSTEMCTL);
    const openrc = fsWith(['/sbin/openrc-run', '/run/openrc', '/run/openrc/softlevel']);
    expect(await detectServiceManagerDetail('linux', probe, openrc)).toEqual({ kind: 'openrc' });
    expect(calls).toEqual(['--version']);
  });

  test('systemd user manager unreachable but OpenRC booted → openrc', async () => {
    const { probe } = probeWith({ '--version': 0, '--user show-environment': 1 });
    const openrc = fsWith(['/sbin/openrc-run', '/run/openrc/softlevel']);
    expect(await detectServiceManager('linux', probe, openrc)).toBe('openrc');
  });

  test('openrc-run found on PATH', async () => {
    const { probe } = probeWith(NO_SYSTEMCTL);
    const paths = ['/usr/bin/openrc-run', '/run/openrc/softlevel'];
    const openrc = fsWith(paths, '/usr/local/bin:/usr/bin');
    expect(await detectServiceManager('linux', probe, openrc)).toBe('openrc');
  });

  test('/run/openrc without softlevel falls back to rc-status', async () => {
    const { probe, calls } = probeWith({ ...NO_SYSTEMCTL, 'rc-status --runlevel': 0 });
    const openrc = fsWith(['/sbin/openrc-run', '/run/openrc']);
    expect(await detectServiceManager('linux', probe, openrc)).toBe('openrc');
    expect(calls).toEqual(['--version', 'rc-status --runlevel']);
  });

  test('/run/openrc present but rc-status fails → none, not booted', async () => {
    const { probe } = probeWith({ ...NO_SYSTEMCTL, 'rc-status --runlevel': 1 });
    const openrc = fsWith(['/sbin/openrc-run', '/run/openrc']);
    expect(await detectServiceManagerDetail('linux', probe, openrc)).toEqual({
      kind: 'none',
      reason: 'openrc-not-booted',
    });
  });

  test('container: openrc installed, never booted → none with reason', async () => {
    const { probe, calls } = probeWith(NO_SYSTEMCTL);
    const openrc = fsWith(['/sbin/openrc-run']);
    expect(await detectServiceManagerDetail('linux', probe, openrc)).toEqual({
      kind: 'none',
      reason: 'openrc-not-booted',
    });
    expect(calls).toEqual(['--version']);
  });

  test('no openrc-run anywhere → plain none', async () => {
    const { probe } = probeWith(NO_SYSTEMCTL);
    const openrc = fsWith(['/run/openrc/softlevel'], '/usr/bin');
    expect(await detectServiceManagerDetail('linux', probe, openrc)).toEqual({ kind: 'none' });
  });
});
