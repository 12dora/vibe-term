import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
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
  options?: { env?: NodeJS.ProcessEnv; setEu?: boolean }
): { status: number; stdout: string; stderr: string } {
  const script = `${options?.setEu ? 'set -eu\n' : ''}${extra}
VIBETERM_INSTALL_LIB=1
. ${JSON.stringify(installSh)}
${fnCall}
`;
  const result = spawnSync('sh', ['-c', script], {
    encoding: 'utf8',
    env: options?.env ? { ...process.env, ...options.env } : process.env,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function hostCmd(name: string): string | null {
  const result = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  const resolved = (result.stdout ?? '').trim().split('\n').pop() ?? '';
  return resolved && existsSync(resolved) ? resolved : null;
}

function isolatedBin(root: string, hostNames: string[]): string {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const name of hostNames) {
    const dest = join(bin, name);
    if (existsSync(dest)) continue;
    const src = hostCmd(name);
    if (src) {
      try {
        symlinkSync(src, dest);
      } catch {
        /* ignore colliding names */
      }
    }
  }
  return bin;
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
  initExitCode?: number;
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
exit "\${FAKE_NODE_EXIT:-0}"
`
  );

  const script = `
VIBETERM_INSTALL_LIB=1
. ${JSON.stringify(installSh)}
vibeterm_install "$@"
`;
  const result = spawnSync('sh', ['-c', script, '--', ...(opts.args ?? [])], {
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
      ...(opts.initExitCode !== undefined ? { FAKE_NODE_EXIT: String(opts.initExitCode) } : {}),
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

const hasBusybox = spawnSync('sh', ['-c', 'command -v busybox'], { encoding: 'utf8' }).status === 0;

describe('install.sh helpers', () => {
  test('sh -n passes', () => {
    const result = spawnSync('sh', ['-n', installSh], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  test.skipIf(!hasBusybox)('busybox sh -n passes', () => {
    const result = spawnSync('busybox', ['sh', '-n', installSh], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  test.skipIf(!hasBusybox)(
    'busybox ash set -eu: missing single UDP does not abort the hint',
    () => {
      const script = `set -eu
VIBETERM_INSTALL_LIB=1
. ${JSON.stringify(installSh)}
vibeterm_print_relay_turn_firewall_hint "Inbound ports: 443/tcp, 9883/tcp"
`;
      const result = spawnSync('busybox', ['sh', '-c', script], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('');
    }
  );

  test('prints the TURN firewall hint for relay-role init args', () => {
    const eu = { setEu: true };
    const relay = sourceEval('vibeterm_init_role_is_relay --role relay --no-interactive', '', eu);
    expect(relay.status).toBe(0);
    const node = sourceEval('vibeterm_init_role_is_relay --role node', '', eu);
    expect(node.status).toBe(1);
    expect(sourceEval('vibeterm_init_role_is_relay --role=relay', '', eu).status).toBe(0);
    expect(sourceEval('vibeterm_init_role_is_relay --role=relay,node', '', eu).status).toBe(0);
    expect(sourceEval('vibeterm_init_role_is_relay --role=node,relay', '', eu).status).toBe(0);
    expect(sourceEval('vibeterm_init_role_is_relay --role node,relay', '', eu).status).toBe(0);
    expect(sourceEval('vibeterm_init_role_is_relay --role=node', '', eu).status).toBe(1);
    const hint = sourceEval(
      'vibeterm_print_relay_turn_firewall_hint "Inbound ports: 443/tcp, 40000/udp, 40001-40049/udp"',
      '',
      eu
    );
    expect(hint.status).toBe(0);
    expect(hint.stdout).toContain('UDP 40000');
    expect(hint.stdout).toContain('UDP 40001-40049');
    const custom = sourceEval(
      'vibeterm_print_relay_turn_firewall_hint "443/tcp, 3479/udp, 50000-50099/udp"',
      '',
      eu
    );
    expect(custom.stdout).toContain('UDP 3479');
    expect(custom.stdout).toContain('UDP 50000-50099');
    const empty = sourceEval('vibeterm_print_relay_turn_firewall_hint', '', eu);
    expect(empty.status).toBe(0);
    expect(empty.stdout.trim()).toBe('');
    const tcpOnly = sourceEval(
      'vibeterm_print_relay_turn_firewall_hint "Inbound ports: 443/tcp, 9883/tcp"',
      '',
      eu
    );
    expect(tcpOnly.status).toBe(0);
    expect(tcpOnly.stdout.trim()).toBe('');
    const rangeOnly = sourceEval(
      'vibeterm_print_relay_turn_firewall_hint "443/tcp, 40001-40049/udp"',
      '',
      eu
    );
    expect(rangeOnly.status).toBe(0);
    expect(rangeOnly.stdout.trim()).toBe('');
  });

  test('running the script (not sourcing it) reaches the installer', () => {
    const result = spawnSync('/bin/sh', [installSh], {
      encoding: 'utf8',
      env: { PATH: '/nonexistent', HOME: '/nonexistent' },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing required command');
  });

  test('install.sh no longer references the GitHub REST API', () => {
    const text = readFileSync(installSh, 'utf8');
    expect(text).not.toContain('api.github.com');
    expect(text).not.toContain('tag_name');
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

  describe('latest resolution via the releases/latest redirect', () => {
    function runLatest(opts: { okOnAttempt: number | null; location?: string }): {
      status: number;
      stdout: string;
      stderr: string;
      attempts: number;
    } {
      const root = mkdtempSync(join(tmpdir(), 'vibeterm-install-latest-'));
      sandboxDirs.push(root);
      const bin = join(root, 'bin');
      mkdirSync(bin);
      const counter = join(root, 'curl.count');
      writeExec(
        join(bin, 'curl'),
        `#!/usr/bin/env bash
n=0
[ -f "$FAKE_CURL_COUNTER" ] && n="$(cat "$FAKE_CURL_COUNTER")"
n=$((n + 1))
printf '%s' "$n" > "$FAKE_CURL_COUNTER"
if [ -n "$FAKE_CURL_OK_ON" ] && [ "$n" -ge "$FAKE_CURL_OK_ON" ]; then
  printf 'HTTP/2 302\\r\\nlocation: %s\\r\\n\\r\\n' "$FAKE_CURL_LOCATION"
  exit 0
fi
printf 'HTTP/2 502\\r\\n\\r\\n'
exit 0
`
      );
      writeExec(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
      const result = sourceEval('vibeterm_resolve_version', 'unset VIBETERM_VERSION TMEX_VERSION', {
        env: {
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          FAKE_CURL_COUNTER: counter,
          FAKE_CURL_OK_ON: opts.okOnAttempt === null ? '' : String(opts.okOnAttempt),
          FAKE_CURL_LOCATION:
            opts.location ?? 'https://github.com/12dora/vibe-term/releases/tag/v2.13.0',
        },
      });
      const attempts = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
      return { ...result, attempts };
    }

    test('reads the version from the 302 Location on the first attempt', () => {
      const result = runLatest({ okOnAttempt: 1 });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('2.13.0');
      expect(result.attempts).toBe(1);
    });

    test('retries transient failures and succeeds on the last retry', () => {
      const result = runLatest({ okOnAttempt: 4 });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('2.13.0');
      expect(result.attempts).toBe(4);
    });

    test('fails after 4 attempts with a VIBETERM_VERSION hint and never calls the API', () => {
      const result = runLatest({ okOnAttempt: null });
      expect(result.status).not.toBe(0);
      expect(result.attempts).toBe(4);
      expect(result.stderr).toContain('VIBETERM_VERSION=<ver>');
      expect(result.stderr).not.toContain('api.github.com');
    });

    test('treats a non-semver redirect target as a failed attempt', () => {
      const result = runLatest({
        okOnAttempt: 1,
        location: 'https://github.com/login?return_to=x',
      });
      expect(result.status).not.toBe(0);
      expect(result.attempts).toBe(4);
    });
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

  test('install.sh uses no regex interval expressions (mawk / BSD awk do not support them)', () => {
    const source = readFileSync(installSh, 'utf8');
    const intervalRe = /(?<!\$)\{\d+(,\d*)?\}|\\\{\d+(,\d*)?\\\}/;
    const hits = source
      .split('\n')
      .map((line, index) => ({ line: index + 1, text: line }))
      .filter(({ text }) => !text.trimStart().startsWith('#') && intervalRe.test(text));
    expect(hits).toEqual([]);

    expect('awk /^[0-9]{64}$/'.match(intervalRe)).not.toBeNull();
    expect('grep "x\\{2,3\\}"'.match(intervalRe)).not.toBeNull();
    expect('"${1}" "${VAR}" -w %{http_code}'.match(intervalRe)).toBeNull();
  });
});

describe('vibeterm_sha256sums_hex_for', () => {
  function lookup(body: string, want = 'vibeterm-cli-1.1.4.tgz') {
    const root = mkdtempSync(join(tmpdir(), 'vibeterm-sums-hex-'));
    sandboxDirs.push(root);
    const sums = join(root, 'SHA256SUMS');
    writeFileSync(sums, body);
    const result = sourceEval(`vibeterm_sha256sums_hex_for ${JSON.stringify(sums)} ${want}`);
    return { status: result.status, hex: result.stdout.trim() };
  }

  test('accepts the exact filename and rejects path-qualified entries', () => {
    const picked = lookup(
      [
        `${'a'.repeat(64)}  /tmp/vibeterm-cli-1.1.4.tgz`,
        `${'b'.repeat(64)}  ../vibeterm-cli-1.1.4.tgz`,
        `${'c'.repeat(64)}  vibeterm-cli-1.1.4.tgz`,
        '',
      ].join('\n')
    );
    expect(picked).toEqual({ status: 0, hex: 'c'.repeat(64) });

    expect(lookup(`${'a'.repeat(64)}  /tmp/vibeterm-cli-1.1.4.tgz\n`).status).not.toBe(0);
    expect(lookup(`${'a'.repeat(64)}  ../vibeterm-cli-1.1.4.tgz\n`).status).not.toBe(0);
  });

  test('lowercases uppercase hex', () => {
    const picked = lookup(`${'AB12CD34'.repeat(8)}  vibeterm-cli-1.1.4.tgz\n`);
    expect(picked).toEqual({ status: 0, hex: 'ab12cd34'.repeat(8) });
  });

  test('strips the leading * binary marker', () => {
    const picked = lookup(`${'d'.repeat(64)} *vibeterm-cli-1.1.4.tgz\n`);
    expect(picked).toEqual({ status: 0, hex: 'd'.repeat(64) });
  });

  test('rejects digests that are not exactly 64 hex characters', () => {
    expect(lookup(`${'a'.repeat(63)}  vibeterm-cli-1.1.4.tgz\n`).status).not.toBe(0);
    expect(lookup(`${'a'.repeat(65)}  vibeterm-cli-1.1.4.tgz\n`).status).not.toBe(0);
    expect(lookup(`${'a'.repeat(63)}g  vibeterm-cli-1.1.4.tgz\n`).status).not.toBe(0);
    const dashed = `${'a'.repeat(32)}-${'a'.repeat(31)}`;
    expect(lookup(`${dashed}  vibeterm-cli-1.1.4.tgz\n`).status).not.toBe(0);
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

  test('passes no init flags of its own and only mentions TTY handling when it adds --no-interactive', () => {
    const result = runInstallPolicy({ version: '1.1.4', sumsCode: '200' });
    expect(result.status).toBe(0);
    const flags = result.initArgs.filter((line) => line.startsWith('--'));
    const addedNonInteractive = flags.includes('--no-interactive');
    expect(flags.filter((flag) => flag !== '--no-interactive')).toEqual([]);
    expect(result.stdout.includes('no TTY; running non-interactively')).toBe(addedNonInteractive);
    expect(result.stdout).not.toContain('attaching /dev/tty');
  });

  test('a failing init aborts with an actionable message and its exit code', () => {
    const result = runInstallPolicy({ version: '1.1.4', sumsCode: '200', initExitCode: 3 });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('init failed (exit 3)');
    expect(result.stderr).toContain('see the message above');
    expect(result.stdout).not.toContain('vibeterm install: done.');
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

describe('vibeterm_bun_release_target', () => {
  function target(
    arch: string,
    cpuinfo: string,
    alpine: string,
    muslGlob: string,
    lddFile: string
  ): { status: number; stdout: string } {
    const args = [arch, cpuinfo, alpine, muslGlob, lddFile].map((value) => JSON.stringify(value));
    const result = sourceEval(`vibeterm_bun_release_target ${args.join(' ')}`);
    return { status: result.status, stdout: result.stdout.trim() };
  }

  test('selects musl and baseline suffixes from injectable paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'vibeterm-bun-target-'));
    sandboxDirs.push(root);
    const alpine = join(root, 'alpine-release');
    const missing = join(root, 'missing');
    const avx2 = join(root, 'cpu-avx2');
    const noAvx = join(root, 'cpu-no-avx');
    const gnu = join(root, 'ldd-gnu');
    const muslLdd = join(root, 'ldd-musl');
    const noGlob = join(root, 'no-ld-musl-*');
    writeFileSync(alpine, '3.20.3\n');
    writeFileSync(avx2, 'flags : fpu sse sse2 avx avx2\n');
    writeFileSync(noAvx, 'flags : fpu sse sse2\n');
    writeFileSync(gnu, 'ldd (GNU libc) 2.39\n');
    writeFileSync(muslLdd, 'musl libc (x86_64)\nVersion 1.2.5\n');
    writeFileSync(join(root, 'ld-musl-x86_64.so.1'), '');

    expect(target('x86_64', noAvx, alpine, noGlob, gnu)).toEqual({
      status: 0,
      stdout: 'linux-x64-musl-baseline',
    });
    expect(target('x86_64', avx2, alpine, noGlob, gnu)).toEqual({
      status: 0,
      stdout: 'linux-x64-musl',
    });
    expect(target('x86_64', noAvx, missing, noGlob, gnu)).toEqual({
      status: 0,
      stdout: 'linux-x64-baseline',
    });
    expect(target('x86_64', avx2, missing, noGlob, gnu)).toEqual({
      status: 0,
      stdout: 'linux-x64',
    });
    expect(target('amd64', avx2, missing, noGlob, gnu).stdout).toBe('linux-x64');
    expect(target('aarch64', avx2, alpine, noGlob, gnu)).toEqual({
      status: 0,
      stdout: 'linux-aarch64-musl',
    });
    expect(target('arm64', noAvx, missing, noGlob, gnu)).toEqual({
      status: 0,
      stdout: 'linux-aarch64',
    });
    expect(target('x86_64', avx2, missing, noGlob, muslLdd).stdout).toBe('linux-x64-musl');
    expect(target('x86_64', avx2, missing, join(root, 'ld-musl-*'), gnu).stdout).toBe(
      'linux-x64-musl'
    );
  });
});

describe('http client selection', () => {
  const wgetStub = `#!/bin/sh
out=""
url=""
timeout=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -O) out="$2"; shift 2 ;;
    --header|-H) shift 2 ;;
    -T) timeout="$2"; shift 2 ;;
    -q|-S|--spider|-s|-L|-f) shift ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [ -n "\${FAKE_WGET_T_MARK:-}" ]; then
  printf '%s' "$timeout" > "\$FAKE_WGET_T_MARK"
fi
if [ -n "\${FAKE_WGET_LOCATION:-}" ]; then
  printf '  HTTP/1.1 302 Found\\n  Location: %s\\n' "\$FAKE_WGET_LOCATION" >&2
  exit 0
fi
if [ -n "\${FAKE_WGET_RC:-}" ]; then
  printf '  HTTP/1.1 200 OK\\n' >&2
  if [ -n "\$out" ] && [ "\$out" != /dev/null ] && [ -n "\${FAKE_WGET_BODY:-}" ]; then
    cp "\$FAKE_WGET_BODY" "\$out"
  fi
  exit "\$FAKE_WGET_RC"
fi
if [ -n "\${FAKE_WGET_CODE:-}" ]; then
  printf '  HTTP/1.1 %s x\\n' "\$FAKE_WGET_CODE" >&2
  if [ -n "\$out" ] && [ "\$out" != /dev/null ] && [ -n "\${FAKE_WGET_BODY:-}" ]; then
    cp "\$FAKE_WGET_BODY" "\$out"
  fi
  [ "\$FAKE_WGET_CODE" = 200 ] && exit 0
  exit 8
fi
echo "fake-wget: unexpected url \$url" >&2
exit 1
`;

  test('prefers curl when both curl and wget exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'vibeterm-http-curl-'));
    sandboxDirs.push(root);
    const bin = isolatedBin(root, ['sh']);
    writeExec(join(bin, 'curl'), '#!/bin/sh\nexit 0\n');
    writeExec(join(bin, 'wget'), '#!/bin/sh\nexit 0\n');
    const result = sourceEval('vibeterm_http_client', '', { env: { PATH: bin } });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('curl');
  });

  test('falls back to wget when curl is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'vibeterm-http-wget-'));
    sandboxDirs.push(root);
    const bin = isolatedBin(root, ['sh']);
    writeExec(join(bin, 'wget'), '#!/bin/sh\nexit 0\n');
    const result = sourceEval('vibeterm_http_client', '', { env: { PATH: bin } });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('wget');
  });

  test('fails with a clear message when neither curl nor wget exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'vibeterm-http-none-'));
    sandboxDirs.push(root);
    const bin = isolatedBin(root, ['sh']);
    const result = sourceEval('vibeterm_http_client', '', { env: { PATH: bin } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/curl or wget/i);
  });

  test('wget latest-redirect reads the first Location from -S headers', () => {
    const root = mkdtempSync(join(tmpdir(), 'vibeterm-http-loc-'));
    sandboxDirs.push(root);
    const bin = isolatedBin(root, ['sh', 'grep', 'head', 'tr']);
    writeExec(join(bin, 'wget'), wgetStub);
    const result = sourceEval('vibeterm_tag_from_latest_redirect', '', {
      env: {
        PATH: bin,
        FAKE_WGET_LOCATION: 'https://github.com/12dora/vibe-term/releases/tag/v2.14.0',
      },
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('v2.14.0');
  });

  test('wget get_code reads the last HTTP status from -S output', () => {
    const root = mkdtempSync(join(tmpdir(), 'vibeterm-http-code-'));
    sandboxDirs.push(root);
    const bin = isolatedBin(root, ['sh', 'awk', 'cat', 'tr', 'cp']);
    writeExec(join(bin, 'wget'), wgetStub);
    const dest = join(root, 'body');
    const body = join(root, 'sums');
    writeFileSync(body, 'unused\n');
    const result = sourceEval(
      `vibeterm_http_get_code https://example.test/SHA256SUMS ${JSON.stringify(dest)}`,
      '',
      { env: { PATH: bin, FAKE_WGET_CODE: '404', FAKE_WGET_BODY: body } }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('404');
  });

  test('wget get_code uses -T 15 and only parses status when wget exits 0 or 8', () => {
    const root = mkdtempSync(join(tmpdir(), 'vibeterm-http-code-rc-'));
    sandboxDirs.push(root);
    const bin = isolatedBin(root, ['sh', 'awk', 'cat', 'tr', 'cp']);
    writeExec(join(bin, 'wget'), wgetStub);
    const dest = join(root, 'body');
    const body = join(root, 'sums');
    const tMark = join(root, 'wget.t');
    writeFileSync(body, 'unused\n');
    const eu = { setEu: true as const };
    const interrupted = sourceEval(
      `vibeterm_http_get_code https://example.test/SHA256SUMS ${JSON.stringify(dest)}`,
      '',
      {
        ...eu,
        env: {
          PATH: bin,
          FAKE_WGET_RC: '4',
          FAKE_WGET_BODY: body,
          FAKE_WGET_T_MARK: tMark,
        },
      }
    );
    expect(interrupted.status).toBe(1);
    expect(interrupted.stdout).toBe('');
    expect(readFileSync(tMark, 'utf8')).toBe('15');

    const httpErr = sourceEval(
      `vibeterm_http_get_code https://example.test/SHA256SUMS ${JSON.stringify(dest)}`,
      '',
      { ...eu, env: { PATH: bin, FAKE_WGET_CODE: '503', FAKE_WGET_BODY: body } }
    );
    expect(httpErr.status).toBe(0);
    expect(httpErr.stdout).toBe('503');

    const ok = sourceEval(
      `vibeterm_http_get_code https://example.test/SHA256SUMS ${JSON.stringify(dest)}`,
      '',
      { ...eu, env: { PATH: bin, FAKE_WGET_CODE: '200', FAKE_WGET_BODY: body } }
    );
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe('200');
  });
});

describe('init tee path', () => {
  test('preserves a non-zero init exit code without pipefail', () => {
    const root = mkdtempSync(join(tmpdir(), 'vibeterm-init-tee-'));
    sandboxDirs.push(root);
    const bin = isolatedBin(root, ['sh', 'tee', 'cat', 'rm']);
    writeExec(
      join(bin, 'node'),
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo v22.11.0
  exit 0
fi
echo init-output
exit 7
`
    );
    const pkg = join(root, 'pkg');
    mkdirSync(join(pkg, 'bin'), { recursive: true });
    writeFileSync(join(pkg, 'bin', 'vibeterm.js'), 'placeholder\n');
    const log = join(root, 'init.log');
    const result = sourceEval(`vibeterm_run_init ${JSON.stringify(pkg)}`, '', {
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        VIBETERM_INIT_LOG: log,
        VIBETERM_INSTALL_TMP: root,
      },
    });
    expect(result.status).toBe(7);
    expect(result.stdout).toContain('init-output');
    expect(readFileSync(log, 'utf8')).toContain('init-output');
  });
});

describe('vibeterm_install_bun_zip and ensure_bun', () => {
  const isLinux = process.platform === 'linux';

  function bunZipBin(root: string): string {
    const bin = isolatedBin(root, [
      'sh',
      'uname',
      'mktemp',
      'mkdir',
      'mv',
      'chmod',
      'rm',
      'cp',
      'cat',
      'awk',
      'tr',
      'grep',
      'ldd',
      'sha256sum',
      'shasum',
    ]);
    writeExec(
      join(bin, 'unzip'),
      `#!/bin/sh
dest="."
while [ "$#" -gt 0 ]; do
  case "$1" in
    -d) dest="$2"; shift 2 ;;
    -oq|-o|-q) shift ;;
    *) shift ;;
  esac
done
mkdir -p "$dest/bun-$FAKE_BUN_TARGET"
printf '%s\\n' '#!/bin/sh' 'echo 1.3.1' > "$dest/bun-$FAKE_BUN_TARGET/bun"
chmod +x "$dest/bun-$FAKE_BUN_TARGET/bun"
`
    );
    return bin;
  }

  test.skipIf(!isLinux)('reuses VIBETERM_INSTALL_TMP and returns 0 under set -eu', () => {
    const target = sourceEval('vibeterm_bun_release_target "$(uname -m)"').stdout.trim();
    expect(target.length).toBeGreaterThan(0);
    const root = mkdtempSync(join(tmpdir(), 'vibeterm-bun-zip-keep-'));
    sandboxDirs.push(root);
    const home = join(root, 'home');
    const work = join(root, 'keep-tmp');
    mkdirSync(home);
    mkdirSync(work);
    const bin = bunZipBin(root);
    const zip = join(root, 'bun.zip');
    writeFileSync(zip, 'fake-bun-zip\n');
    const sums = join(root, 'SHASUMS256.txt');
    writeFileSync(sums, `${sha256Hex(readFileSync(zip))}  bun-${target}.zip\n`);
    writeExec(
      join(bin, 'curl'),
      `#!/bin/sh
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -H|--header) shift 2 ;;
    -s|-S|-L|-f|-sS|-fsSL|-q) shift ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  *SHASUMS256.txt*) cp "$FAKE_BUN_SUMS" "$out" ;;
  *.zip*) cp "$FAKE_BUN_ZIP" "$out" ;;
  *) echo "fake-curl: $url" >&2; exit 1 ;;
esac
`
    );
    const result = sourceEval(
      `VIBETERM_INSTALL_TMP=${JSON.stringify(work)}\nvibeterm_install_bun_zip`,
      '',
      {
        setEu: true,
        env: {
          PATH: bin,
          HOME: home,
          FAKE_BUN_TARGET: target,
          FAKE_BUN_ZIP: zip,
          FAKE_BUN_SUMS: sums,
        },
      }
    );
    expect(result.status).toBe(0);
    expect(existsSync(work)).toBe(true);
    expect(existsSync(join(home, '.bun/bin/bun'))).toBe(true);
  });

  test.skipIf(!isLinux)('failed download cleans the temp dir via EXIT trap', () => {
    const root = mkdtempSync(join(tmpdir(), 'vibeterm-bun-zip-leak-'));
    sandboxDirs.push(root);
    const tmp = join(root, 'tmp');
    mkdirSync(tmp);
    const bin = bunZipBin(root);
    writeExec(join(bin, 'curl'), '#!/bin/sh\nexit 1\n');
    const result = sourceEval('vibeterm_install_bun_zip', 'unset VIBETERM_INSTALL_TMP', {
      setEu: true,
      env: {
        PATH: bin,
        HOME: join(root, 'home'),
        TMPDIR: tmp,
      },
    });
    expect(result.status).not.toBe(0);
    const leftover = existsSync(tmp)
      ? readdirSync(tmp).filter((name) => name.startsWith('vibeterm-bun.'))
      : [];
    expect(leftover).toEqual([]);
  });

  test('after install, a failing bun --version prints stderr and the libstdc++ hint', () => {
    const root = mkdtempSync(join(tmpdir(), 'vibeterm-bun-ver-'));
    sandboxDirs.push(root);
    const home = join(root, 'home');
    mkdirSync(home);
    const bin = isolatedBin(root, ['sh', 'mkdir', 'chmod', 'cat']);
    writeExec(join(bin, 'bash'), '#!/bin/sh\nexec sh\n');
    writeExec(
      join(bin, 'curl'),
      `#!/bin/sh
cat <<'EOS'
mkdir -p "$HOME/.bun/bin"
cat > "$HOME/.bun/bin/bun" <<'BUN'
#!/bin/sh
echo "Error loading shared library libstdc++.so.6: No such file or directory" >&2
exit 1
BUN
chmod +x "$HOME/.bun/bin/bun"
EOS
`
    );
    const result = sourceEval('vibeterm_ensure_bun', '', {
      setEu: true,
      env: { PATH: bin, HOME: home },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('libstdc++.so.6');
    expect(result.stderr).toContain('apk add libstdc++ libgcc');
    expect(result.stderr).not.toMatch(/Bun unknown is still older/);
  });
});
