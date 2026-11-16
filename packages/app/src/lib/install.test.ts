import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildAppEnvValues,
  peerEnvDefaults,
  quotePosixShellArg,
  rewriteLegacyHubInstallEnv,
  writeRunScript,
} from './install';
import { createInstallLayout } from './install-layout';

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('buildAppEnvValues', () => {
  test('brackets IPv6 hosts in VIBETERM_BASE_URL', () => {
    const values = buildAppEnvValues({
      host: '2001:db8::1',
      port: 9883,
      databasePath: '/tmp/vibeterm.db',
      masterKey: 'key',
    });
    expect(values.VIBETERM_BASE_URL).toBe('http://[2001:db8::1]:9883');
    expect(values.VIBETERM_BIND_HOST).toBe('2001:db8::1');
  });

  test('writes peer env keys without hub keys', () => {
    const values = buildAppEnvValues({
      host: '127.0.0.1',
      port: 9883,
      databasePath: '/tmp/vibeterm.db',
      masterKey: 'key',
      role: 'node',
    });
    expect(values.VIBETERM_ROLES).toBe('node');
    expect(values.VIBETERM_HUB_URL).toBeUndefined();
    expect(values.VIBETERM_PEER_PORT).toBe('39001');
    expect(values.VIBETERM_HUB_PUBLIC_URL).toBeUndefined();
    expect(values.VIBETERM_STUN_SERVERS).toBeUndefined();
    expect(values.VIBETERM_DIRECT_ENABLED).toBe('true');
    expect(values.VIBETERM_RTC_PORT_RANGE).toBe('40000-40099');
    expect(values.VIBETERM_TURN_PORT).toBeUndefined();
  });

  test('writes role-aware RTC/TURN port keys', () => {
    const base = {
      host: '127.0.0.1',
      port: 9883,
      databasePath: '/tmp/vibeterm.db',
      masterKey: 'key',
    };
    const node = buildAppEnvValues({ ...base, role: 'node' });
    expect(node.VIBETERM_RTC_PORT_RANGE).toBe('40000-40099');
    expect(node.VIBETERM_TURN_PORT).toBeUndefined();
    expect(node.VIBETERM_TURN_RELAY_PORT_RANGE).toBeUndefined();

    const relay = buildAppEnvValues({ ...base, role: 'relay' });
    expect(relay.VIBETERM_RTC_PORT_RANGE).toBe('40050-40099');
    expect(relay.VIBETERM_TURN_PORT).toBe('40000');
    expect(relay.VIBETERM_TURN_RELAY_PORT_RANGE).toBe('40001-40049');

    const relayNode = buildAppEnvValues({ ...base, role: 'relay,node' });
    expect(relayNode.VIBETERM_RTC_PORT_RANGE).toBe('40050-40099');
    expect(relayNode.VIBETERM_TURN_PORT).toBe('40000');
    expect(relayNode.VIBETERM_TURN_RELAY_PORT_RANGE).toBe('40001-40049');
  });

  test('omits VIBETERM_STUN_SERVERS unless an explicit override is passed', () => {
    const base = {
      host: '127.0.0.1',
      port: 9883,
      databasePath: '/tmp/vibeterm.db',
      masterKey: 'key',
    };
    expect(buildAppEnvValues(base).VIBETERM_STUN_SERVERS).toBeUndefined();
    expect(peerEnvDefaults().VIBETERM_STUN_SERVERS).toBeUndefined();
    expect(
      buildAppEnvValues({ ...base, stunServers: '   ' }).VIBETERM_STUN_SERVERS
    ).toBeUndefined();
    expect(buildAppEnvValues({ ...base, stunServers: 'none' }).VIBETERM_STUN_SERVERS).toBe('none');
    expect(
      buildAppEnvValues({ ...base, stunServers: 'stun:custom.example:3478' }).VIBETERM_STUN_SERVERS
    ).toBe('stun:custom.example:3478');
  });

  test('rewriteLegacyHubInstallEnv maps hub,node to node and strips HUB keys', () => {
    expect(
      rewriteLegacyHubInstallEnv({
        VIBETERM_ROLES: 'hub,node',
        VIBETERM_HUB_URL: 'https://hub.example',
        VIBETERM_HUB_PUBLIC_URL: 'https://pub.example',
        VIBETERM_HUB_MODE: 'active',
        VIBETERM_PEER_PORT: '39001',
        OTHER: 'keep',
      })
    ).toEqual({
      VIBETERM_ROLES: 'node',
      VIBETERM_PEER_PORT: '39001',
      OTHER: 'keep',
    });
    expect(rewriteLegacyHubInstallEnv({ VIBETERM_ROLES: 'hub, node' }).VIBETERM_ROLES).toBe('node');
  });
});

describe('quotePosixShellArg', () => {
  test('wraps in single quotes and encodes apostrophes', () => {
    expect(quotePosixShellArg(`a b;'c"$d`)).toBe(`'a b;'\\''c"$d'`);
    expect(quotePosixShellArg('simple')).toBe("'simple'");
    expect(quotePosixShellArg('')).toBe("''");
  });
});

describe('writeRunScript', () => {
  test('writes executable script with safe shell variables', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'vibeterm-install-'));
    tempDirs.push(installDir);

    const installLayout = createInstallLayout(installDir);
    await writeRunScript(installLayout, '/usr/bin/bun');

    const script = await readFile(installLayout.runScriptPath, 'utf8');
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toContain('set -eu');
    expect(script).not.toContain('pipefail');
    expect(script).not.toContain('[[');
    expect(script).toContain('SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"');
    expect(script).toContain('while IFS= read -r line || [ -n "$line" ]; do');
    expect(script).toContain('export "$line"');
    expect(script).toContain(`done < ${posixQuote(installLayout.envPath)}`);
    expect(script).not.toContain('source ');
    expect(script).toContain('export PATH="${HOME}/.bun/bin:${PATH:-}"');
    expect(script).toContain('export VIBETERM_FE_DIST_DIR=');
    expect(script).toContain('export VIBETERM_MIGRATIONS_DIR=');
    expect(script).toContain('export VIBETERM_INSTALL_DIR=');
    expect(script).toContain('printf \'%s\\n\' "$$" > "$SCRIPT_DIR/vibeterm.pid"');
    expect(script).toContain('chmod 600 "$SCRIPT_DIR/vibeterm.pid"');
    // run.sh 只导出 VIBETERM_*：迁移后不支持降级到 2.0 以下，事务回滚会还原旧 run.sh。
    expect(script).not.toContain('TMEX_');
    expect(spawnSync('sh', ['-n', '-c', script], { encoding: 'utf8' }).status).toBe(0);
    expect(script).toContain(
      `export VIBETERM_NATIVE_DIR=${posixQuote(join(installDir, 'current', 'native'))}`
    );
    expect(script).toContain(
      `exec ${posixQuote('/usr/bin/bun')} ${posixQuote(join(installDir, 'current', 'runtime', 'server.js'))}`
    );
    expect(script).not.toContain('BASH_SOURCE');
    expect(script).not.toContain('VIBETERM_GHOSTTY_WASM_PATH');
  });

  test('exports VIBETERM_GHOSTTY_WASM_PATH when runtime assets wasm exists', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'vibeterm-install-'));
    tempDirs.push(installDir);

    const wasmPath = join(installDir, 'current', 'runtime', 'assets', 'ghostty-vt.wasm');
    await mkdir(dirname(wasmPath), { recursive: true });
    await writeFile(wasmPath, 'wasm');

    const installLayout = createInstallLayout(installDir);
    await writeRunScript(installLayout, '/usr/bin/bun');

    const script = await readFile(installLayout.runScriptPath, 'utf8');
    expect(script).toContain(`export VIBETERM_GHOSTTY_WASM_PATH=${posixQuote(wasmPath)}`);
    expect(spawnSync('sh', ['-n', installLayout.runScriptPath], { encoding: 'utf8' }).status).toBe(
      0
    );
  });

  test('POSIX-quotes interpolated paths that contain quotes, $(...), spaces, and apostrophes', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'vibeterm-install-'));
    tempDirs.push(parent);

    const installDir = join(parent, `weird "quotes" and $(echo pwned) and 'sq' dir`);
    await mkdir(installDir, { recursive: true });

    const bunPath = join(parent, `sub "dir" $(id) 'q'`, 'bun');
    await mkdir(dirname(bunPath), { recursive: true });

    const installLayout = createInstallLayout(installDir);
    await writeRunScript(installLayout, bunPath);

    const script = await readFile(installLayout.runScriptPath, 'utf8');

    expect(script).toContain(`done < ${posixQuote(installLayout.envPath)}`);
    expect(script).toContain(
      `export VIBETERM_FE_DIST_DIR=${posixQuote(join(installDir, 'current', 'resources', 'fe-dist'))}`
    );
    expect(script).toContain(
      `export VIBETERM_MIGRATIONS_DIR=${posixQuote(join(installDir, 'current', 'resources', 'gateway-drizzle'))}`
    );
    expect(script).toContain(
      `export VIBETERM_NATIVE_DIR=${posixQuote(join(installDir, 'current', 'native'))}`
    );
    expect(script).toContain(
      `exec ${posixQuote(bunPath)} ${posixQuote(join(installDir, 'current', 'runtime', 'server.js'))}`
    );
    expect(script).toContain(`export PATH=${posixQuote(dirname(bunPath))}:`);

    expect(script).not.toContain(`"${installLayout.envPath}"`);
    expect(script).not.toContain(`"${join(installDir, 'current', 'resources', 'fe-dist')}"`);
    expect(script).not.toContain(`"${bunPath}"`);

    const syntax = spawnSync('sh', ['-n', installLayout.runScriptPath], { encoding: 'utf8' });
    expect(syntax.status).toBe(0);
    expect(syntax.stderr).toBe('');

    await writeFile(installLayout.envPath, 'NODE_ENV=test\n');
    const probePath = join(parent, 'run.probe.sh');
    const probe = script.replace(/^exec (.+)$/m, 'printf "%s\\0%s" $1');
    await writeFile(probePath, probe, { mode: 0o755 });
    const ran = spawnSync('sh', [probePath], { encoding: 'utf8' });
    expect(ran.status).toBe(0);
    expect(ran.stderr).toBe('');
    expect(ran.stdout).toBe(`${bunPath}\0${join(installDir, 'current', 'runtime', 'server.js')}`);
  });

  test('sh executes generated run.sh and exports mixed app.env lines verbatim', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'vibeterm-runsh-posix-'));
    tempDirs.push(installDir);
    const isolatedHome = join(installDir, 'home');
    await mkdir(isolatedHome, { recursive: true });

    const fakeOut = join(installDir, 'fake-bun-out.txt');
    const fakeBun = join(installDir, 'fake-bun');
    await writeFile(
      fakeBun,
      [
        '#!/bin/sh',
        '{',
        '  printf "arg1=%s\\n" "$1"',
        '  printf "VT_G3_SPACE=%s\\n" "$VT_G3_SPACE"',
        '  printf "VT_G3_EQ=%s\\n" "$VT_G3_EQ"',
        '  printf "VT_G3_QUOTE=%s\\n" "$VT_G3_QUOTE"',
        '  printf "VT_G3_CRLF=%s\\n" "$VT_G3_CRLF"',
        '  printf "VT_G3_LF=%s\\n" "$VT_G3_LF"',
        '  printf "VT_G3_HASH=%s\\n" "$VT_G3_HASH"',
        '  printf "COMMENTED=%s\\n" "${COMMENTED-unset}"',
        `} > ${posixQuote(fakeOut)}`,
        '',
      ].join('\n'),
      { mode: 0o755 }
    );

    const installLayout = createInstallLayout(installDir);
    await writeRunScript(installLayout, fakeBun);
    await writeFile(
      installLayout.envPath,
      `${[
        '# leading comment\r',
        '\r',
        'VT_G3_SPACE=hello world\r',
        'VT_G3_EQ=foo=bar=baz\r',
        'VT_G3_QUOTE=it\'s "quoted" value\r',
        'VT_G3_CRLF=crlf-value\r',
        '   \r',
        '  # indented comment\r',
        '# COMMENTED=should-not-appear\r',
        'VT_G3_HASH=foo#bar\r',
        '',
      ].join('\n')}VT_G3_LF=lf-value\n`
    );

    const serverJs = join(installDir, 'current', 'runtime', 'server.js');
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: isolatedHome };
    const expected = [
      `arg1=${serverJs}`,
      'VT_G3_SPACE=hello world',
      'VT_G3_EQ=foo=bar=baz',
      'VT_G3_QUOTE=it\'s "quoted" value',
      'VT_G3_CRLF=crlf-value',
      'VT_G3_LF=lf-value',
      'VT_G3_HASH=foo#bar',
      'COMMENTED=unset',
      '',
    ].join('\n');

    const interpreters: string[][] = [['sh']];
    const busybox = spawnSync('busybox', ['sh', '-c', 'exit 0'], { encoding: 'utf8' });
    if (busybox.status === 0) interpreters.push(['busybox', 'sh']);

    for (const argv of interpreters) {
      await rm(fakeOut, { force: true });
      const ran = spawnSync(argv[0], [...argv.slice(1), installLayout.runScriptPath], {
        encoding: 'utf8',
        env,
      });
      expect(ran.status).toBe(0);
      expect(ran.stderr).toBe('');
      expect(await readFile(fakeOut, 'utf8')).toBe(expected);
      const pidText = await readFile(join(installDir, 'vibeterm.pid'), 'utf8');
      expect(pidText.trim().length).toBeGreaterThan(0);
    }
  });
});
