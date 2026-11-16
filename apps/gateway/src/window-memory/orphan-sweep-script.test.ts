import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOrphanSweepScript } from './orphan-sweep-script';

function extractProcHelpers(script: string): string {
  const start = script.indexOf('read_ppid() {');
  const end = script.indexOf('\nserver_pid=');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end);
}

describe('orphan sweep /proc helpers', () => {
  test('script reads ppid from /proc/stat and only uses ps -p as fallback', () => {
    const script = buildOrphanSweepScript([4242], ['tmux-spawn-abc.scope']);
    expect(script).toContain('read_ppid() {');
    expect(script).toContain('read_comm() {');
    expect(script).toContain('ppid=$(read_ppid "$pane_pid")');
    expect(script).toContain('comm=$(read_comm "$ppid")');
    expect(script).toContain('_walk=$(read_ppid "$_walk")');
    expect(script).toContain('${_stat##*)}');
    expect(script.indexOf('read_ppid()')).toBeLessThan(script.indexOf('ps -o ppid= -p'));
    expect(script.indexOf('/stat"')).toBeLessThan(script.indexOf('ps -o ppid= -p'));
  });

  test('read_ppid and read_comm parse comms that contain spaces and parentheses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vt-orphan-proc-'));
    const script = buildOrphanSweepScript([99]);
    const helpers = extractProcHelpers(script);
    try {
      mkdirSync(join(dir, '99'));
      mkdirSync(join(dir, '7'));
      writeFileSync(join(dir, '99', 'stat'), '99 (sh) S 7 7 7 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n');
      writeFileSync(
        join(dir, '7', 'stat'),
        '7 (tmux: server) S 1 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n'
      );
      const probe = `PROC_FS='${dir}'
${helpers}
printf 'ppid=[%s]\\n' "$(read_ppid 99)"
printf 'comm=[%s]\\n' "$(read_comm 7)"
printf 'nested=[%s]\\n' "$(read_comm 99)"
`;
      const proc = Bun.spawn(['sh', '-c', probe], { stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toContain('ppid=[7]');
      expect(stdout).toContain('comm=[tmux: server]');
      expect(stdout).toContain('nested=[sh]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('falls back to ps when /proc/stat is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vt-orphan-ps-'));
    const fakePs = join(dir, 'ps');
    writeFileSync(
      fakePs,
      `#!/bin/sh
printf '  11\\n'
`
    );
    chmodSync(fakePs, 0o755);
    const helpers = extractProcHelpers(buildOrphanSweepScript([5]));
    try {
      const probe = `PROC_FS='${join(dir, 'no-proc')}'
PATH='${dir}:/bin:/usr/bin'
${helpers}
printf 'ppid=[%s]\\n' "$(read_ppid 5)"
`;
      const proc = Bun.spawn(['sh', '-c', probe], { stdout: 'pipe', stderr: 'pipe' });
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('ppid=[11]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('generated script is valid POSIX sh', async () => {
    const script = buildOrphanSweepScript([4242, 99], ['tmux-spawn-abc.scope']);
    const proc = Bun.spawn(['sh', '-n', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  });
});
