import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const installSh = resolve(import.meta.dir, '../../../../install.sh');

function sourceEval(
  fnCall: string,
  extra = ''
): { status: number; stdout: string; stderr: string } {
  const script = `${extra}
source ${JSON.stringify(installSh)}
${fnCall}
`;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe('install.sh helpers', () => {
  test('bash -n passes', () => {
    const result = spawnSync('bash', ['-n', installSh], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  test('tmex_parse_tag_name reads compact and pretty GitHub JSON', () => {
    const compact = sourceEval(`tmex_parse_tag_name '{"tag_name":"v1.1.0","name":"x"}'`);
    expect(compact.status).toBe(0);
    expect(compact.stdout.trim()).toBe('v1.1.0');

    const pretty = sourceEval(`tmex_parse_tag_name "$(cat <<'JSON'
{
  "url": "https://api.github.com/repos/12dora/tmex-enhanced/releases/1",
  "tag_name": "v2.3.4",
  "assets": []
}
JSON
)"`);
    expect(pretty.status).toBe(0);
    expect(pretty.stdout.trim()).toBe('v2.3.4');
  });

  test('tmex_version_from_tag strips a leading v', () => {
    const result = sourceEval(
      'tmex_version_from_tag v1.1.0; printf "\\n"; tmex_version_from_tag 1.1.0'
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['1.1.0', '1.1.0']);
  });

  test('tmex_version_ge compares dotted versions', () => {
    const ge = sourceEval(
      'tmex_version_ge 1.3.0 1.3.0 && tmex_version_ge 1.3.1 1.3.0 && ! tmex_version_ge 1.2.9 1.3.0 && echo ok'
    );
    expect(ge.status).toBe(0);
    expect(ge.stdout.trim()).toBe('ok');
  });
});
