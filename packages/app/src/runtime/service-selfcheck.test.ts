import { describe, expect, test } from 'bun:test';
import {
  SYSTEMD_KILL_MODE_WARNING,
  buildSystemdServiceContent,
  systemdUnitLacksKillModeProcess,
} from '../lib/service';
import { warnOnStaleSystemdUnit } from './service-selfcheck';

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
