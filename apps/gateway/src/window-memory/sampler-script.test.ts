import { describe, expect, test } from 'bun:test';

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
  });

  test('reports unsupported on hosts without cgroup v2', async () => {
    if (process.platform === 'linux') return;
    const script = buildSamplerScript([{ paneId: "%1'oops", pid: 1 }]);
    const proc = Bun.spawn(['sh', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exitCode).toBe(0);
    const parsed = parseSamplerOutput(stdout);
    expect(parsed.supported).toBe(false);
    expect(parsed.panes).toEqual([]);
  });
});
