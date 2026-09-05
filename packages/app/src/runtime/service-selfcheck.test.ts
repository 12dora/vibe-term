import { describe, expect, test } from 'bun:test';
import {
  SYSTEMD_KILL_MODE_WARNING,
  buildSystemdServiceContent,
  systemdUnitLacksKillModeProcess,
} from '../lib/service';
import { SYSTEMD_OOM_POLICY_WARNING } from '../lib/systemd-oom-policy';
import { warnOnStaleSystemdUnit, warnOnSystemdOomPolicy } from './service-selfcheck';

describe('systemdUnitLacksKillModeProcess', () => {
  test('当前模板不告警', () => {
    const unit = buildSystemdServiceContent({
      serviceName: 'tmex',
      runScriptPath: '/opt/tmex/run.sh',
      installDir: '/opt/tmex',
      autostart: true,
    });
    expect(systemdUnitLacksKillModeProcess(unit)).toBe(false);
  });

  test('旧 unit（无 KillMode）告警', () => {
    expect(systemdUnitLacksKillModeProcess('[Service]\nType=simple\nRestart=always\n')).toBe(true);
  });

  test('KillMode 不是 process 也告警', () => {
    expect(systemdUnitLacksKillModeProcess('[Service]\nKillMode=control-group\n')).toBe(true);
  });

  test('unit 不存在时不告警', () => {
    expect(systemdUnitLacksKillModeProcess(null)).toBe(false);
  });
});

describe('warnOnStaleSystemdUnit', () => {
  test('非 Linux 直接跳过', async () => {
    const lines: string[] = [];
    const warned = await warnOnStaleSystemdUnit({
      platform: 'darwin',
      readUnit: async () => '[Service]\n',
      warn: (line) => lines.push(line),
    });
    expect(warned).toBe(false);
    expect(lines).toEqual([]);
  });

  test('Linux 上旧 unit 打出固定告警', async () => {
    const lines: string[] = [];
    const warned = await warnOnStaleSystemdUnit({
      platform: 'linux',
      readUnit: async () => '[Service]\nRestart=always\n',
      warn: (line) => lines.push(line),
    });
    expect(warned).toBe(true);
    expect(lines).toEqual([SYSTEMD_KILL_MODE_WARNING]);
  });

  test('Linux 上新 unit 不告警', async () => {
    const lines: string[] = [];
    const warned = await warnOnStaleSystemdUnit({
      platform: 'linux',
      readUnit: async () => '[Service]\nKillMode=process\n',
      warn: (line) => lines.push(line),
    });
    expect(warned).toBe(false);
    expect(lines).toEqual([]);
  });
});

describe('warnOnSystemdOomPolicy', () => {
  test('非 Linux 不 spawn systemctl', async () => {
    const calls: string[] = [];
    const warned = await warnOnSystemdOomPolicy({
      platform: 'darwin',
      probe: async (command, args) => {
        calls.push([command, ...args].join(' '));
        return 'DefaultOOMPolicy=stop';
      },
      warn: () => undefined,
    });
    expect(warned).toBe(false);
    expect(calls).toEqual([]);
  });

  test('Linux + stop + tmux 3.6 打出固定告警', async () => {
    const warns: string[] = [];
    const warned = await warnOnSystemdOomPolicy({
      platform: 'linux',
      probe: async (command) => (command === 'tmux' ? 'tmux 3.6\n' : 'DefaultOOMPolicy=stop\n'),
      warn: (line) => warns.push(line),
    });
    expect(warned).toBe(true);
    expect(warns).toEqual([SYSTEMD_OOM_POLICY_WARNING]);
  });

  test('continue 时安静，且不再探测 tmux', async () => {
    const calls: string[] = [];
    const warned = await warnOnSystemdOomPolicy({
      platform: 'linux',
      probe: async (command, args) => {
        calls.push([command, ...args].join(' '));
        return 'DefaultOOMPolicy=continue\n';
      },
      warn: () => undefined,
    });
    expect(warned).toBe(false);
    expect(calls).toEqual(['systemctl --user show -p DefaultOOMPolicy']);
  });

  test('systemctl 探测失败时静默', async () => {
    const warns: string[] = [];
    const warned = await warnOnSystemdOomPolicy({
      platform: 'linux',
      probe: async () => null,
      warn: (line) => warns.push(line),
    });
    expect(warned).toBe(false);
    expect(warns).toEqual([]);
  });
});
