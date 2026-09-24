import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseSamplerOutput } from './sample-parser';
import { buildSamplerScript } from './sampler-script';

describe('buildSamplerScript', () => {
  test('embeds pane ids literally in a quoted heredoc', () => {
    const awkward = [
      { paneId: '%1$foo', pid: 11 },
      { paneId: "%2'bar", pid: 22 },
      { paneId: '%3;rm -rf /', pid: 33 },
      { paneId: '%4`touch /tmp/x`', pid: 44 },
    ];
    const script = buildSamplerScript(awkward);
    expect(script).toContain("done <<'VTMEM_PANES'");
    expect(script).toContain('%1$foo\t11');
    expect(script).toContain("%2'bar\t22");
    expect(script).toContain('%3;rm -rf /\t33');
    expect(script).toContain('%4`touch /tmp/x`\t44');
    expect(script).not.toContain('[[');
    expect(script).not.toContain('local ');
    expect(script).not.toContain('function ');
    expect(script).not.toContain('exit 0');
    expect(script).toContain("swapMax='?'");
    expect(script).toContain('rss_tree()');
    expect(script).toContain('pstab_ok()');
    expect(script).toContain('PSTAB=$(ps -Ao pid=,ppid=,rss= 2>/dev/null)');
    expect(script).toContain('PSTAB=$(ps -o pid=,ppid=,rss= 2>/dev/null)');
    expect(script).toContain('$1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/');
  });

  test('pins cgroup source only after memory.current is actually read', () => {
    const script = buildSamplerScript([]);
    const caseIdx = script.indexOf('tmux-spawn-*.scope)');
    const currentIdx = script.indexOf('current=$(cgroup_num "$cg_dir/memory.current")', caseIdx);
    const sourceIdx = script.indexOf("source='cgroup'", caseIdx);
    expect(caseIdx).toBeGreaterThan(-1);
    expect(currentIdx).toBeGreaterThan(caseIdx);
    expect(sourceIdx).toBeGreaterThan(currentIdx);
    expect(script.slice(currentIdx, sourceIdx)).toContain('[ -n "$current" ]');
  });

  test('cgroup_num distinguishes unread from a real zero', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vtmem-cg-'));
    try {
      writeFileSync(join(dir, 'zero'), '0\n');
      writeFileSync(join(dir, 'value'), '4096\n');
      writeFileSync(join(dir, 'unlimited'), 'max\n');
      writeFileSync(join(dir, 'empty'), '');
      const script = buildSamplerScript([]);
      const start = script.indexOf('cgroup_num() {');
      const end = script.indexOf('\npstab_ok() {');
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const probe = `${script.slice(start, end)}
printf 'missing=[%s]\\n' "$(cgroup_num '${dir}/missing')"
printf 'zero=[%s]\\n' "$(cgroup_num '${dir}/zero')"
printf 'value=[%s]\\n' "$(cgroup_num '${dir}/value')"
printf 'unlimited=[%s]\\n' "$(cgroup_num '${dir}/unlimited')"
printf 'empty=[%s]\\n' "$(cgroup_num '${dir}/empty')"
`;
      const proc = Bun.spawn(['sh', '-c', probe], { stdout: 'pipe', stderr: 'pipe' });
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('missing=[]');
      expect(stdout).toContain('zero=[0]');
      expect(stdout).toContain('value=[4096]');
      expect(stdout).toContain('unlimited=[0]');
      expect(stdout).toContain('empty=[]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('exports XDG_RUNTIME_DIR and DBUS address before systemctl --user', () => {
    const script = buildSamplerScript([]);
    expect(script).toContain('export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$uid}"');
    expect(script).toContain('export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"');
    const dbusIdx = script.indexOf('DBUS_SESSION_BUS_ADDRESS');
    const systemctlIdx = script.indexOf('systemctl --user show-environment');
    expect(dbusIdx).toBeGreaterThan(-1);
    expect(systemctlIdx).toBeGreaterThan(dbusIdx);
    expect(script).toContain('no-cgroup2');
    expect(script).toContain('no-user-systemd');
    expect(script).toContain("printf 'VTMEM 2 %s %s %s\\n'");
  });

  test('falls back to process-tree RSS when the host has no cgroup v2', async () => {
    if (process.platform === 'linux') return;
    const pid = process.pid;
    const script = buildSamplerScript([{ paneId: "%1'oops", pid }]);
    const proc = Bun.spawn(['sh', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exitCode).toBe(0);
    const parsed = parseSamplerOutput(stdout);
    expect(parsed.limitsSupported).toBe(false);
    expect(parsed.reason).toBe('no-cgroup2');
    expect(parsed.panes).toHaveLength(1);
    expect(parsed.panes[0]?.paneId).toBe("%1'oops");
    expect(parsed.panes[0]?.pid).toBe(pid);
    expect(parsed.panes[0]?.source).toBe('rss');
    expect(parsed.panes[0]?.scope).toBeNull();
    expect(parsed.panes[0]?.current).toBeGreaterThan(1024 * 1024);
    expect(parsed.panes[0]?.current).toBeLessThan(8 * 1024 * 1024 * 1024);
  });

  test('live pid is measured and missing pid is none', async () => {
    const script = buildSamplerScript([
      { paneId: '%1', pid: process.pid },
      { paneId: '%2', pid: 999_999_99 },
    ]);
    const proc = Bun.spawn(['sh', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exitCode).toBe(0);
    const parsed = parseSamplerOutput(stdout);
    expect(parsed.panes).toHaveLength(2);
    expect(parsed.panes[0]?.source === 'rss' || parsed.panes[0]?.source === 'cgroup').toBe(true);
    expect(parsed.panes[0]?.current).toBeGreaterThan(1024 * 1024);
    expect(parsed.panes[1]?.source).toBe('none');
    expect(parsed.panes[1]?.current).toBe(0);
  });

  test('rejects BusyBox-style default ps tables and tries the next candidate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vtmem-ps-'));
    const fakePs = join(dir, 'ps');
    writeFileSync(
      fakePs,
      `#!/bin/sh
args="$*"
case "$args" in
  -Ao*|-eo*|ax*)
    echo "  PID USER       VSZ STAT COMMAND"
    echo "    1 root      1548 S    /sbin/init"
    echo "  $$ konata    9999 S    sh"
    exit 0
    ;;
esac
exec /bin/ps -Ao pid=,ppid=,rss=
`
    );
    chmodSync(fakePs, 0o755);
    try {
      const script = buildSamplerScript([{ paneId: '%1', pid: process.pid }]);
      const proc = Bun.spawn(['sh', '-c', script], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? '/bin:/usr/bin'}` },
      });
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(exitCode).toBe(0);
      const parsed = parseSamplerOutput(stdout);
      expect(parsed.panes).toHaveLength(1);
      expect(parsed.panes[0]?.source).toBe('rss');
      expect(parsed.panes[0]?.current).toBeGreaterThan(1024 * 1024);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('all malformed ps tables yield source=none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vtmem-psbad-'));
    const fakePs = join(dir, 'ps');
    writeFileSync(
      fakePs,
      `#!/bin/sh
echo "  PID USER       VSZ STAT COMMAND"
echo "    1 root      1548 S    /sbin/init"
echo "  $$ konata    9999 S    sh"
`
    );
    chmodSync(fakePs, 0o755);
    try {
      const script = buildSamplerScript([{ paneId: '%1', pid: process.pid }]);
      const proc = Bun.spawn(['sh', '-c', script], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? '/bin:/usr/bin'}` },
      });
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(exitCode).toBe(0);
      const parsed = parseSamplerOutput(stdout);
      expect(parsed.panes).toHaveLength(1);
      expect(parsed.panes[0]?.source).toBe('none');
      expect(parsed.panes[0]?.current).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
