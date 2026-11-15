import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

import type { CgroupPlacement, PlacementProbe } from '../../tmux/cgroup-placement';
import {
  type PlacementWiringHost,
  placeCreatedPane,
  startConnectPlacement,
  withPanePidOutput,
} from './cgroup-placement-wiring';
import type { CommandResult } from './types';

function stubPlacement(probe: PlacementProbe) {
  const enabled = new Set<string>();
  const protectedCalls: Array<[number, string]> = [];
  const placed: Array<[string, number[]]> = [];
  const placement = {
    config: { mode: 'auto', protectedSlice: 'session.slice', workloadSlice: 'app.slice' },
    probePlacementSupport: async () => probe,
    modeLabel: () => (probe.supported ? 'auto' : `unsupported:${probe.reason}`),
    enableDevice: (id: string) => enabled.add(id),
    disableDevice: (id: string) => enabled.delete(id),
    isDeviceEnabled: (id: string) => enabled.has(id),
    protectTmuxServer: async (pid: number, socket: string) => {
      protectedCalls.push([pid, socket]);
      return { action: 'moved', cgroup: '/x/session.slice/vibeterm-tmux-1.scope' };
    },
    placePanes: async (id: string, pids: number[]) => {
      placed.push([id, pids]);
      return enabled.has(id) ? pids.length : 0;
    },
  } as unknown as CgroupPlacement;
  return { placement, enabled, protectedCalls, placed };
}

function host(logPrefix: string, replies: Record<string, CommandResult> = {}) {
  const calls: string[] = [];
  const value: PlacementWiringHost = {
    deviceId: 'dev-1',
    logPrefix,
    runTmuxAllowFailure: async (argv) => {
      calls.push(argv.join(' '));
      return replies[argv.join(' ')] ?? { exitCode: 1, stdout: '', stderr: 'no' };
    },
  };
  return { host: value, calls };
}

const ok = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
const SUPPORTED: PlacementProbe = { supported: true, userRoot: '/u', ownCgroup: '/u/s' };

afterEach(() => {
  mock.restore();
});

describe('startConnectPlacement', () => {
  test('local connect protects the server, enables the device and places all panes', async () => {
    const info = spyOn(console, 'info').mockImplementation(() => {});
    const stub = stubPlacement(SUPPORTED);
    const { host: local, calls } = host('[local]', {
      'display-message -p #{pid}\t#{socket_path}': ok('500\t/tmp/tmux-1/default\n'),
      'list-panes -a -F #{pane_pid}': ok('700\n701\nbad\n'),
    });
    await startConnectPlacement(local, stub.placement);
    expect(calls).toEqual([
      'display-message -p #{pid}\t#{socket_path}',
      'list-panes -a -F #{pane_pid}',
    ]);
    expect(stub.protectedCalls).toEqual([[500, '/tmp/tmux-1/default']]);
    expect(stub.placed).toEqual([['dev-1', [700, 701]]]);
    const line = String(info.mock.calls.at(-1)?.[0]);
    expect(line).toContain('[tmux] placement server_cgroup=/x/session.slice/vibeterm-tmux-1.scope');
    expect(line).toContain('panes_slice=app.slice mode=auto');
  });

  test('ssh connections never issue placement commands', async () => {
    const stub = stubPlacement(SUPPORTED);
    const { host: ssh, calls } = host('[ssh]');
    await startConnectPlacement(ssh, stub.placement);
    expect(calls).toEqual([]);
    expect(stub.enabled.size).toBe(0);
  });

  test('unsupported host logs the mode and runs no tmux command', async () => {
    const info = spyOn(console, 'info').mockImplementation(() => {});
    const stub = stubPlacement({ supported: false, reason: 'no-busctl' });
    const { host: local, calls } = host('[local]');
    await startConnectPlacement(local, stub.placement);
    expect(calls).toEqual([]);
    expect(String(info.mock.calls[0]?.[0])).toContain('mode=unsupported:no-busctl');
  });
});

describe('created pane helpers', () => {
  test('new-window asks for the pane pid only when the device is enabled', () => {
    const stub = stubPlacement(SUPPORTED);
    const { host: local } = host('[local]');
    expect(withPanePidOutput(local, ['new-window'], stub.placement)).toEqual(['new-window']);
    stub.enabled.add('dev-1');
    expect(withPanePidOutput(local, ['new-window'], stub.placement)).toEqual([
      'new-window',
      '-P',
      '-F',
      '#{pane_pid}',
    ]);
  });

  test('placeCreatedPane forwards a valid pid and ignores garbage', async () => {
    const stub = stubPlacement(SUPPORTED);
    const { host: local } = host('[local]');
    expect(await placeCreatedPane(local, '4321\n', stub.placement)).toBe(0);
    expect(await placeCreatedPane(local, undefined, stub.placement)).toBe(0);
    expect(await placeCreatedPane(local, '%8', stub.placement)).toBe(0);
    expect(stub.placed).toEqual([['dev-1', [4321]]]);
  });
});
