import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const installSh = resolve(import.meta.dir, '../../../../install.sh');
const sandboxDirs: string[] = [];

afterEach(() => {
  for (const dir of sandboxDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sourceEval(
  fnCall: string,
  extra = '',
  options?: { env?: NodeJS.ProcessEnv }
): { status: number; stdout: string; stderr: string } {
  const script = `${extra}
source ${JSON.stringify(installSh)}
${fnCall}
`;
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: options?.env ? { ...process.env, ...options.env } : process.env,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeExec(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function runInstallPolicy(opts: {
  version: string;
  sumsCode: string;
  sumsBody?: string;
  args?: string[];
  legacyAssetOnly?: boolean;
  legacyBinOnly?: boolean;
  prepare?: (ctx: { root: string; payloadHex: string }) => { sumsBody: string };
}): {
  status: number;
  stdout: string;
  stderr: string;
  tarCalled: boolean;
  initArgs: string[];
} {
  const root = mkdtempSync(join(tmpdir(), 'vibeterm-install-policy-'));
  sandboxDirs.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const tgzSrc = join(root, 'payload.tgz');
  writeFileSync(tgzSrc, `fake-tarball-${opts.version}\n`);
  const hex = sha256Hex(readFileSync(tgzSrc));
  const sumsFile = join(root, 'SHA256SUMS.body');
  const prepared = opts.prepare?.({ root, payloadHex: hex });
  const sumsBody =
    prepared?.sumsBody ??
    opts.sumsBody ??
    (opts.sumsCode === '200'
      ? `${hex}  ${opts.legacyAssetOnly ? 'tmex' : 'vibeterm'}-cli-${opts.version}.tgz\n`
      : 'not published\n');
  writeFileSync(sumsFile, sumsBody);

  const tarMark = join(root, 'tar.called');
  const initLog = join(root, 'init.args');

  writeExec(
    join(bin, 'curl'),
    `#!/usr/bin/env bash
out=""
url=""
http_write=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) http_write="$2"; shift 2 ;;
    -H) shift 2 ;;
    -s|-S|-L|-f|-sS|-fsSL|-sSL|-sL|-fsL) shift ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [[ "$url" == *"/SHA256SUMS" ]]; then
  if [ -n "$out" ]; then
    cp "$FAKE_CURL_SUMS_BODY_FILE" "$out"
  fi
  if [ -n "$http_write" ]; then
    printf '%s' "$FAKE_CURL_SUMS_CODE"
  fi
  exit 0
fi
if [[ "$url" == *vibeterm-cli-*.tgz ]]; then
  if [ -n "$FAKE_CURL_ONLY_LEGACY" ]; then
    exit 22
  fi
  cp "$FAKE_CURL_TGZ" "$out"
  exit 0
fi
if [[ "$url" == *tmex-cli-*.tgz ]]; then
  cp "$FAKE_CURL_TGZ" "$out"
  exit 0
fi
echo "fake-curl: unexpected url $url" >&2
exit 1
`
  );

  writeExec(
    join(bin, 'tar'),
    `#!/usr/bin/env bash
printf '1' > "$FAKE_TAR_MARK"
dest="."
while [ "$#" -gt 0 ]; do
  case "$1" in
    -C) dest="$2"; shift 2 ;;
    *) shift ;;
  esac
done
mkdir -p "$dest/package/bin"
printf '%s\\n' '#!/usr/bin/env node' > "$dest/package/bin/tmex.js"
if [ -z "$FAKE_TAR_LEGACY_BIN_ONLY" ]; then
  printf '%s\\n' '#!/usr/bin/env node' > "$dest/package/bin/vibeterm.js"
fi
`
  );

  writeExec(
    join(bin, 'node'),
    `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "v22.11.0"
  exit 0
fi
printf '%s\\n' "$@" > "$FAKE_NODE_LOG"
exit 0
`
  );

  const script = `
source ${JSON.stringify(installSh)}
vibeterm_install "$@"
`;
  const result = spawnSync('bash', ['-c', script, '--', ...(opts.args ?? [])], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      TMPDIR: root,
      VIBETERM_VERSION: opts.version,
      FAKE_CURL_TGZ: tgzSrc,
      FAKE_CURL_SUMS_CODE: opts.sumsCode,
      FAKE_CURL_SUMS_BODY_FILE: sumsFile,
      FAKE_TAR_MARK: tarMark,
      FAKE_NODE_LOG: initLog,
      ...(opts.legacyAssetOnly ? { FAKE_CURL_ONLY_LEGACY: '1' } : {}),
      ...(opts.legacyBinOnly ? { FAKE_TAR_LEGACY_BIN_ONLY: '1' } : {}),
    },
  });

  let initArgs: string[] = [];
  if (existsSync(initLog)) {
    initArgs = readFileSync(initLog, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.length > 0);
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    tarCalled: existsSync(tarMark),
    initArgs,
  };
}

describe('install.sh helpers', () => {
  test('bash -n passes', () => {
    const result = spawnSync('bash', ['-n', installSh], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  test('prints the TURN firewall hint for relay-role init args', () => {
    const relay = sourceEval('vibeterm_init_role_is_relay --role relay --no-interactive');
    expect(relay.status).toBe(0);
    const node = sourceEval('vibeterm_init_role_is_relay --role node');
    expect(node.status).toBe(1);
    const hint = sourceEval('vibeterm_print_relay_turn_firewall_hint');
    expect(hint.status).toBe(0);
    expect(hint.stdout).toContain('UDP 3478');
    expect(hint.stdout).toContain('UDP 49160-49259');
  });

  test('vibeterm_parse_tag_name reads compact and pretty GitHub JSON', () => {
    const compact = sourceEval(`vibeterm_parse_tag_name '{"tag_name":"v1.1.0","name":"x"}'`);
    expect(compact.status).toBe(0);
    expect(compact.stdout.trim()).toBe('v1.1.0');

    const pretty = sourceEval(`vibeterm_parse_tag_name "$(cat <<'JSON'
{
  "url": "https://api.github.com/repos/12dora/vibe-term/releases/1",
  "tag_name": "v2.3.4",
  "assets": []
}
JSON
)"`);
    expect(pretty.status).toBe(0);
    expect(pretty.stdout.trim()).toBe('v2.3.4');
  });

  test('vibeterm_parse_tag_name takes the first tag_name, not one embedded in the body', () => {
    const result = sourceEval(
      `vibeterm_parse_tag_name '{"tag_name":"v1.1.0","body":"mentions \\"tag_name\\": \\"v9.9.9\\""}'`
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('v1.1.0');
  });

  test('vibeterm_tag_from_location_headers reads the last path segment case-insensitively', () => {
    const result = sourceEval(`vibeterm_tag_from_location_headers "$(cat <<'HDR'
HTTP/2 302
Content-Type: text/html
Location: https://github.com/12dora/vibe-term/releases/tag/v1.4.0
HDR
)"`);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('v1.4.0');

    const lower = sourceEval(`vibeterm_tag_from_location_headers "$(cat <<'HDR'
HTTP/1.1 302 Found
location: https://github.com/12dora/vibe-term/releases/tag/v2.0.0-rc.1

HDR
)"`);
    expect(lower.status).toBe(0);
    expect(lower.stdout.trim()).toBe('v2.0.0-rc.1');
  });

  test('vibeterm_is_semver accepts strict versions and rejects traversal', () => {
    const result = sourceEval(
      'vibeterm_is_semver 1.2.3 && vibeterm_is_semver 1.2.3-beta.1 && ! vibeterm_is_semver ../etc && ! vibeterm_is_semver 1.2 && echo ok'
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
  });

  test('vibeterm_resolve_version validates VIBETERM_VERSION', () => {
    const ok = sourceEval('vibeterm_resolve_version', 'VIBETERM_VERSION=v1.2.3');
    expect(ok.status).toBe(0);
    expect(ok.stdout.trim()).toBe('1.2.3');

    const legacyAlias = sourceEval('vibeterm_resolve_version', 'TMEX_VERSION=v1.2.4');
    expect(legacyAlias.status).toBe(0);
    expect(legacyAlias.stdout.trim()).toBe('1.2.4');

    const bad = sourceEval('vibeterm_resolve_version', 'VIBETERM_VERSION=../etc/passwd');
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/invalid VIBETERM_VERSION/i);
  });

  test('vibeterm_node_version_ok requires major >= 20', () => {
    const result = sourceEval(
      'vibeterm_node_version_ok v20.0.0 && vibeterm_node_version_ok v22.11.1 && ! vibeterm_node_version_ok v18.20.0 && ! vibeterm_node_version_ok && echo ok'
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
  });

  test('vibeterm_version_from_tag strips a leading v', () => {
    const result = sourceEval(
      'vibeterm_version_from_tag v1.1.0; printf "\\n"; vibeterm_version_from_tag 1.1.0'
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['1.1.0', '1.1.0']);
  });

  test('vibeterm_classify_checksum_http only treats 404 as unpublished', () => {
    const result = sourceEval(
      'vibeterm_classify_checksum_http 404; printf "\\n"; vibeterm_classify_checksum_http 200; printf "\\n"; vibeterm_classify_checksum_http 500'
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['missing', 'ok', 'error']);
  });

  test('vibeterm_sha256sums_hex_for accepts exact filename and rejects path-qualified entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'vibeterm-sums-hex-'));
    sandboxDirs.push(root);
    const sums = join(root, 'SHA256SUMS');
    const hex = 'a'.repeat(64);
    writeFileSync(
      sums,
      [
        `${hex}  /tmp/vibeterm-cli-1.1.4.tgz`,
        `${'b'.repeat(64)}  ../vibeterm-cli-1.1.4.tgz`,
        `${'c'.repeat(64)}  vibeterm-cli-1.1.4.tgz`,
        '',
      ].join('\n')
    );
    const exact = sourceEval(
      `vibeterm_sha256sums_hex_for ${JSON.stringify(sums)} vibeterm-cli-1.1.4.tgz`
    );
    expect(exact.status).toBe(0);
    expect(exact.stdout.trim()).toBe('c'.repeat(64));

    writeFileSync(sums, `${hex}  /tmp/vibeterm-cli-1.1.4.tgz\n`);
    const abs = sourceEval(
      `vibeterm_sha256sums_hex_for ${JSON.stringify(sums)} vibeterm-cli-1.1.4.tgz`
    );
    expect(abs.status).not.toBe(0);

    writeFileSync(sums, `${hex}  ../vibeterm-cli-1.1.4.tgz\n`);
    const rel = sourceEval(
      `vibeterm_sha256sums_hex_for ${JSON.stringify(sums)} vibeterm-cli-1.1.4.tgz`
    );
    expect(rel.status).not.toBe(0);
  });
});

describe('install.sh download checksum policy', () => {
  test('HTTP 404 for 1.1.4+ aborts and does not extract', () => {
    const result = runInstallPolicy({ version: '1.1.4', sumsCode: '404' });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /requires SHA256SUMS|Refusing to continue/i
    );
    expect(result.tarCalled).toBe(false);
    expect(result.initArgs).toEqual([]);
  });

  test('HTTP 404 for 1.1.4+ aborts even with --allow-unverified', () => {
    const result = runInstallPolicy({
      version: '1.1.4',
      sumsCode: '404',
      args: ['--allow-unverified'],
    });
    expect(result.status).not.toBe(0);
    expect(result.tarCalled).toBe(false);
  });

  test('HTTP 404 for older versions aborts without --allow-unverified', () => {
    const result = runInstallPolicy({ version: '1.1.0', sumsCode: '404' });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/has no SHA256SUMS|--allow-unverified/i);
    expect(result.tarCalled).toBe(false);
  });

  test('HTTP 404 for older versions continues only with --allow-unverified and strips the flag', () => {
    const result = runInstallPolicy({
      version: '1.1.0',
      sumsCode: '404',
      args: ['--allow-unverified', '--no-interactive'],
    });
    expect(result.status).toBe(0);
    expect(result.tarCalled).toBe(true);
    expect(result.initArgs.some((line) => line.includes('--allow-unverified'))).toBe(false);
    expect(result.initArgs.join(' ')).toContain('--no-interactive');
  });

  test('HTTP 200 with digest mismatch aborts before extract', () => {
    const result = runInstallPolicy({
      version: '1.1.4',
      sumsCode: '200',
      sumsBody: `${'0'.repeat(64)}  vibeterm-cli-1.1.4.tgz\n`,
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/sha256 mismatch/i);
    expect(result.tarCalled).toBe(false);
  });

  test('HTTP 200 with no exact tarball entry aborts before extract', () => {
    const result = runInstallPolicy({
      version: '1.1.4',
      sumsCode: '200',
      sumsBody: `${'a'.repeat(64)}  other-file.tgz\n`,
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/does not list|missing an entry/i);
    expect(result.tarCalled).toBe(false);
  });

  test('HTTP 200 with matching digest extracts and runs init', () => {
    const result = runInstallPolicy({ version: '1.1.4', sumsCode: '200' });
    expect(result.status).toBe(0);
    expect(result.tarCalled).toBe(true);
    expect(result.initArgs.length).toBeGreaterThan(0);
    expect(result.initArgs.some((line) => line.includes('vibeterm.js'))).toBe(true);
  });

  test('falls back to the legacy asset name and its SHA256SUMS entry', () => {
    const result = runInstallPolicy({
      version: '1.1.4',
      sumsCode: '200',
      legacyAssetOnly: true,
      args: ['--no-interactive'],
    });
    expect(result.status).toBe(0);
    expect(result.tarCalled).toBe(true);
    expect(`${result.stdout}`).toMatch(/retrying with .*tmex-cli-1\.1\.4\.tgz/);
  });

  test('accepts a tarball that only ships the legacy bin', () => {
    const result = runInstallPolicy({
      version: '1.1.4',
      sumsCode: '200',
      legacyBinOnly: true,
      args: ['--no-interactive'],
    });
    expect(result.status).toBe(0);
    expect(result.initArgs.some((line) => line.includes('bin/tmex.js'))).toBe(true);
  });

  test('HTTP 200 with an absolute-path manifest line is rejected', () => {
    const result = runInstallPolicy({
      version: '1.1.4',
      sumsCode: '200',
      prepare: ({ root }) => {
        const decoy = join(root, 'evil', 'vibeterm-cli-1.1.4.tgz');
        mkdirSync(join(root, 'evil'));
        writeFileSync(decoy, 'decoy-not-the-download\n');
        return { sumsBody: `${sha256Hex(readFileSync(decoy))}  ${decoy}\n` };
      },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/does not list|missing an entry/i);
    expect(result.tarCalled).toBe(false);
  });

  test('HTTP 200 with a ../ path-qualified manifest line is rejected', () => {
    const result = runInstallPolicy({
      version: '1.1.4',
      sumsCode: '200',
      prepare: ({ root }) => {
        const decoy = join(root, 'vibeterm-cli-1.1.4.tgz');
        writeFileSync(decoy, 'decoy-parent-file\n');
        return { sumsBody: `${sha256Hex(readFileSync(decoy))}  ../vibeterm-cli-1.1.4.tgz\n` };
      },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/does not list|missing an entry/i);
    expect(result.tarCalled).toBe(false);
  });
});
