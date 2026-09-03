import { describe, expect, test } from 'bun:test';
import { buildLaunchdPlist, buildSystemdServiceContent } from './service';

describe('buildSystemdServiceContent', () => {
  test('renders absolute WorkingDirectory without wrapping quotes', () => {
    const content = buildSystemdServiceContent({
      serviceName: 'tmex',
      installDir: '/home/krhougs/.local/share/tmex',
      runScriptPath: '/home/krhougs/.local/share/tmex/run.sh',
      autostart: true,
    });

    expect(content).toContain('WorkingDirectory=/home/krhougs/.local/share/tmex');
    expect(content).not.toContain('WorkingDirectory="/home/krhougs/.local/share/tmex"');
    expect(content).toContain(
      'ExecStart=/usr/bin/env bash "/home/krhougs/.local/share/tmex/run.sh"'
    );
    expect(content).toContain('SyslogIdentifier=tmex');
    expect(content).toContain('StandardOutput=journal');
    expect(content).toContain('StandardError=journal');
    expect(content).toContain('KillMode=process');
  });
});

describe('buildLaunchdPlist', () => {
  test('declares AbandonProcessGroup alongside KeepAlive', () => {
    const content = buildLaunchdPlist({
      serviceName: 'tmex',
      installDir: '/Users/krhougs/Library/Application Support/tmex',
      runScriptPath: '/Users/krhougs/Library/Application Support/tmex/run.sh',
      autostart: true,
    });

    expect(content).toContain('<key>KeepAlive</key>');
    expect(content).toContain('<key>AbandonProcessGroup</key>\n  <true/>');
    expect(content).toContain('<key>TMEX_LOG_FILE</key>');
    expect(content).toContain(
      '<string>/Users/krhougs/Library/Application Support/tmex/tmex.log</string>'
    );
    expect(content).toContain('<key>StandardOutPath</key>');
    expect(content).toContain('<key>StandardErrorPath</key>');
  });
});
