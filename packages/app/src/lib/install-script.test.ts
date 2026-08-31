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

  test('tmex_parse_tag_name takes the first tag_name, not one embedded in the body', () => {
    const result = sourceEval(
      `tmex_parse_tag_name '{"tag_name":"v1.1.0","body":"mentions \\"tag_name\\": \\"v9.9.9\\""}'`
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('v1.1.0');
  });

  test('tmex_tag_from_location_headers reads the last path segment case-insensitively', () => {
    const result = sourceEval(`tmex_tag_from_location_headers "$(cat <<'HDR'
HTTP/2 302
Content-Type: text/html
Location: https://github.com/12dora/tmex-enhanced/releases/tag/v1.4.0
HDR
)"`);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('v1.4.0');

    const lower = sourceEval(`tmex_tag_from_location_headers "$(cat <<'HDR'
HTTP/1.1 302 Found
location: https://github.com/12dora/tmex-enhanced/releases/tag/v2.0.0-rc.1

HDR
)"`);
    expect(lower.status).toBe(0);
    expect(lower.stdout.trim()).toBe('v2.0.0-rc.1');
  });

  test('tmex_is_semver accepts strict versions and rejects traversal', () => {
    const result = sourceEval(
      'tmex_is_semver 1.2.3 && tmex_is_semver 1.2.3-beta.1 && ! tmex_is_semver ../etc && ! tmex_is_semver 1.2 && echo ok'
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
  });

  test('tmex_resolve_version validates TMEX_VERSION', () => {
    const ok = sourceEval('tmex_resolve_version', 'TMEX_VERSION=v1.2.3');
    expect(ok.status).toBe(0);
    expect(ok.stdout.trim()).toBe('1.2.3');

    const bad = sourceEval('tmex_resolve_version', 'TMEX_VERSION=../etc/passwd');
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/invalid TMEX_VERSION/i);
  });

  test('tmex_node_version_ok requires major >= 20', () => {
    const result = sourceEval(
      'tmex_node_version_ok v20.0.0 && tmex_node_version_ok v22.11.1 && ! tmex_node_version_ok v18.20.0 && ! tmex_node_version_ok && echo ok'
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
  });

  test('tmex_version_from_tag strips a leading v', () => {
    const result = sourceEval(
      'tmex_version_from_tag v1.1.0; printf "\\n"; tmex_version_from_tag 1.1.0'
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['1.1.0', '1.1.0']);
  });

  test('tmex_classify_checksum_http only treats 404 as unpublished', () => {
    const result = sourceEval(
      'tmex_classify_checksum_http 404; printf "\\n"; tmex_classify_checksum_http 200; printf "\\n"; tmex_classify_checksum_http 500'
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['missing', 'ok', 'error']);
  });
});
