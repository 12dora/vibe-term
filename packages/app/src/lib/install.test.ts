import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildAppEnvValues, quotePosixShellArg, writeRunScript } from './install';
import { createInstallLayout } from './install-layout';

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('buildAppEnvValues', () => {
  test('brackets IPv6 hosts in TMEX_BASE_URL', () => {
    const values = buildAppEnvValues({
      host: '2001:db8::1',
      port: 9883,
      databasePath: '/tmp/tmex.db',
      masterKey: 'key',
    });
    expect(values.TMEX_BASE_URL).toBe('http://[2001:db8::1]:9883');
    expect(values.TMEX_BIND_HOST).toBe('2001:db8::1');
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
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-install-'));
    tempDirs.push(installDir);

    const installLayout = createInstallLayout(installDir);
    await writeRunScript(installLayout, '/usr/bin/bun');

    const script = await readFile(installLayout.runScriptPath, 'utf8');
    expect(script).toContain('#!/usr/bin/env bash');
    expect(script).toContain('SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"');
    expect(script).toContain('while IFS= read -r line || [[ -n "$line" ]]; do');
    expect(script).toContain('export "$line"');
    expect(script).toContain(`done < ${posixQuote(installLayout.envPath)}`);
    expect(script).not.toContain('source ');
    expect(script).toContain('export PATH="${HOME}/.bun/bin:${PATH:-}"');
    expect(script).toContain('export TMEX_FE_DIST_DIR=');
    expect(script).toContain('export TMEX_MIGRATIONS_DIR=');
    expect(script).toContain(
      `exec ${posixQuote('/usr/bin/bun')} ${posixQuote(installLayout.runtimeServerPath)}`
    );
    expect(script).not.toContain('BASH_SOURCE');
  });

  test('POSIX-quotes interpolated paths that contain quotes, $(...), spaces, and apostrophes', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'tmex-install-'));
    tempDirs.push(parent);

    const installDir = join(parent, `weird "quotes" and $(echo pwned) and 'sq' dir`);
    await mkdir(installDir, { recursive: true });

    const bunPath = join(parent, `sub "dir" $(id) 'q'`, 'bun');
    await mkdir(dirname(bunPath), { recursive: true });

    const installLayout = createInstallLayout(installDir);
    await writeRunScript(installLayout, bunPath);

    const script = await readFile(installLayout.runScriptPath, 'utf8');

    expect(script).toContain(`done < ${posixQuote(installLayout.envPath)}`);
    expect(script).toContain(`export TMEX_FE_DIST_DIR=${posixQuote(installLayout.feDir)}`);
    expect(script).toContain(`export TMEX_MIGRATIONS_DIR=${posixQuote(installLayout.drizzleDir)}`);
    expect(script).toContain(
      `exec ${posixQuote(bunPath)} ${posixQuote(installLayout.runtimeServerPath)}`
    );
    expect(script).toContain(`export PATH=${posixQuote(dirname(bunPath))}:`);

    expect(script).not.toContain(`"${installLayout.envPath}"`);
    expect(script).not.toContain(`"${installLayout.feDir}"`);
    expect(script).not.toContain(`"${bunPath}"`);

    const syntax = spawnSync('bash', ['-n', installLayout.runScriptPath], { encoding: 'utf8' });
    expect(syntax.status).toBe(0);
    expect(syntax.stderr).toBe('');

    await writeFile(installLayout.envPath, 'NODE_ENV=test\n');
    const probePath = join(parent, 'run.probe.sh');
    const probe = script.replace(/^exec (.+)$/m, 'printf "%s\\0%s" $1');
    await writeFile(probePath, probe, { mode: 0o755 });
    const ran = spawnSync('bash', [probePath], { encoding: 'utf8' });
    expect(ran.status).toBe(0);
    expect(ran.stderr).toBe('');
    expect(ran.stdout).toBe(`${bunPath}\0${installLayout.runtimeServerPath}`);
  });
});
