import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildLaunchdPlist,
  buildLegacyLaunchdPlist,
  buildSystemdServiceContent,
  legacyLaunchdPlistPaths,
  removeLegacyLaunchdJob,
} from './service';

describe('buildSystemdServiceContent', () => {
  test('renders absolute WorkingDirectory without wrapping quotes', () => {
    const content = buildSystemdServiceContent({
      serviceName: 'vibeterm',
      installDir: '/home/krhougs/.local/share/vibeterm',
      runScriptPath: '/home/krhougs/.local/share/vibeterm/run.sh',
      autostart: true,
    });

    expect(content).toContain('WorkingDirectory=/home/krhougs/.local/share/vibeterm');
    expect(content).not.toContain('WorkingDirectory="/home/krhougs/.local/share/vibeterm"');
    expect(content).toContain(
      'ExecStart=/usr/bin/env bash "/home/krhougs/.local/share/vibeterm/run.sh"'
    );
    expect(content).toContain('SyslogIdentifier=vibeterm');
    expect(content).toContain('StandardOutput=journal');
    expect(content).toContain('StandardError=journal');
    expect(content).toContain('KillMode=process');
  });
});

describe('buildLaunchdPlist', () => {
  test('declares AbandonProcessGroup alongside KeepAlive', () => {
    const content = buildLaunchdPlist({
      serviceName: 'vibeterm',
      installDir: '/Users/krhougs/Library/Application Support/vibeterm',
      runScriptPath: '/Users/krhougs/Library/Application Support/vibeterm/run.sh',
      autostart: true,
    });

    expect(content).toContain('<key>KeepAlive</key>');
    expect(content).toContain('<key>AbandonProcessGroup</key>\n  <true/>');
    expect(content).toContain('<key>VIBETERM_LOG_FILE</key>');
    expect(content).toContain(
      '<string>/Users/krhougs/Library/Application Support/vibeterm/vibeterm.log</string>'
    );
    expect(content).toContain('<key>StandardOutPath</key>');
    expect(content).toContain('<key>StandardErrorPath</key>');
  });
});

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('pre-rename launchd job cleanup', () => {
  test('legacy plist paths use the com.tmex.<service> label', () => {
    expect(legacyLaunchdPlistPaths('tmex', '/opt/install')).toEqual([
      join(homedir(), 'Library', 'LaunchAgents', 'com.tmex.tmex.plist'),
      '/opt/install/com.tmex.tmex.plist',
    ]);
    expect(legacyLaunchdPlistPaths('tmex')).toHaveLength(1);
  });

  test('boots out and deletes the legacy plist that lives in the install dir', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'vibeterm-relabel-'));
    tempDirs.push(installDir);
    const legacyPlist = join(installDir, 'com.tmex.tmex.plist');
    await writeFile(legacyPlist, '<plist/>');
    const calls: string[][] = [];

    const removed = await removeLegacyLaunchdJob('tmex', installDir, {
      run: async (command, args) => {
        calls.push([command, ...args]);
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    expect(removed).toEqual([legacyPlist]);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('launchctl');
    expect(calls[0][1]).toBe('bootout');
    expect(calls[0][3]).toBe(legacyPlist);
    expect(await Bun.file(legacyPlist).exists()).toBe(false);
  });

  test('does nothing when no legacy plist exists', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'vibeterm-relabel-none-'));
    tempDirs.push(installDir);
    const calls: string[][] = [];

    const removed = await removeLegacyLaunchdJob('vibeterm', installDir, {
      run: async (command, args) => {
        calls.push([command, ...args]);
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    expect(removed).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('the legacy plist keeps the old label, log names and env keys', () => {
    const content = buildLegacyLaunchdPlist({
      serviceName: 'tmex',
      installDir: '/opt/install',
      runScriptPath: '/opt/install/run.sh',
      autostart: true,
    });
    expect(content).toContain('<string>com.tmex.tmex</string>');
    expect(content).toContain('<key>TMEX_LOG_FILE</key>');
    expect(content).toContain('<string>/opt/install/tmex.log</string>');
    expect(content).toContain('<string>/opt/install/tmex.err.log</string>');
  });
});
