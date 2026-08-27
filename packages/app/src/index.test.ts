import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/args';
import { resolveAuthSpawnPlan, spawnAuthCli } from './lib/auth-spawn';
import { stringifyEnv } from './lib/env-file';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(SRC_DIR, '../../../apps/gateway/drizzle');
const BUN_BIN = process.execPath;
const MASTER_KEY = 'tGd9gPmdUkJrpRQK+db60sc+NkxymxgGqKrReDU4Kus=';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('cli-node entry', () => {
  test('re-exports main from index', async () => {
    const entry = await import('./cli-node');
    const index = await import('./index');
    expect(entry.main).toBe(index.main);
    expect(typeof entry.main).toBe('function');
  });
});

describe('auth command bun spawn', () => {
  test('Node dispatch forwards hub user add argv to the bun auth entry', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-cli-spawn-'));
    tempDirs.push(installDir);
    await writeFile(
      join(installDir, 'app.env'),
      stringifyEnv({
        NODE_ENV: 'test',
        TMEX_MASTER_KEY: MASTER_KEY,
        DATABASE_URL: join(installDir, 'tmex.db'),
        TMEX_ROLES: 'hub,node',
      })
    );
    const fakeBun = join(installDir, 'fake-bun');
    await writeFile(
      fakeBun,
      `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then
  echo "1.3.0"
  exit 0
fi
echo "FAKE_BUN_ARGV=$(printf '%q ' "$@")"
`
    );
    await chmod(fakeBun, 0o755);
    const cliAuthPath = join(installDir, 'runtime', 'cli-auth.js');
    const argv = [
      'hub',
      'user',
      'add',
      '--help',
      '--install-dir',
      installDir,
      '--bun-path',
      fakeBun,
    ];
    const parsed = parseArgs(argv);
    const plan = await resolveAuthSpawnPlan(parsed, argv, {
      bunBin: fakeBun,
      cliAuthPath,
    });
    expect(plan.bunBin).toBe(fakeBun);
    expect(plan.cliAuthPath).toBe(cliAuthPath);
    expect(plan.argv).toEqual(argv);
    expect(plan.env.TMEX_MASTER_KEY).toBe(MASTER_KEY);
    const result = await spawnAuthCli(plan, { stdio: 'pipe' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('hub');
    expect(result.stdout).toContain('user');
    expect(result.stdout).toContain('add');
    expect(result.stdout).toContain('--help');
    expect(result.stdout).toContain(cliAuthPath);
  });

  test('node-built cli-node forwards auth argv to fake bun', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-cli-node-spawn-'));
    tempDirs.push(installDir);
    await writeFile(
      join(installDir, 'app.env'),
      stringifyEnv({
        NODE_ENV: 'test',
        TMEX_MASTER_KEY: MASTER_KEY,
        DATABASE_URL: join(installDir, 'tmex.db'),
        TMEX_ROLES: 'hub,node',
      })
    );
    const fakeBun = join(installDir, 'fake-bun');
    await writeFile(
      fakeBun,
      `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then
  echo "1.3.0"
  exit 0
fi
echo "NODE_SPAWN $(printf '%q ' "$@")"
`
    );
    await chmod(fakeBun, 0o755);

    await mkdir(join(installDir, 'runtime'), { recursive: true });
    await writeFile(join(installDir, 'runtime', 'cli-auth.js'), 'export {}\n');

    const outfile = join(installDir, 'cli-node.js');
    const wrapper = join(installDir, 'tmex.js');
    const build = Bun.spawnSync(
      [
        BUN_BIN,
        'build',
        join(SRC_DIR, 'cli-node.ts'),
        '--outfile',
        outfile,
        '--target',
        'node',
        '--format',
        'esm',
      ],
      { cwd: join(SRC_DIR, '..'), stdout: 'pipe', stderr: 'pipe' }
    );
    expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0);
    await writeFile(
      wrapper,
      `#!/usr/bin/env node
import { main } from './cli-node.js';
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
`
    );

    const argv = [
      'hub',
      'user',
      'add',
      '--help',
      '--install-dir',
      installDir,
      '--bun-path',
      fakeBun,
    ];
    const proc = Bun.spawn(['node', wrapper, ...argv], {
      cwd: installDir,
      env: { ...process.env, NODE_ENV: 'test' },
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode, `stderr=${stderr}\nstdout=${stdout}`).toBe(0);
    expect(stdout).toContain('hub');
    expect(stdout).toContain('user');
    expect(stdout).toContain('add');
    expect(stdout).toContain('--help');
  }, 60_000);
});

describe('dispatchAuthCli auth env load', () => {
  test('hub user add loads install env before gateway config captures TMEX_MASTER_KEY', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-cli-auth-'));
    tempDirs.push(installDir);
    const databaseUrl = join(installDir, 'tmex.db');
    await writeFile(
      join(installDir, 'app.env'),
      stringifyEnv({
        NODE_ENV: 'test',
        TMEX_MASTER_KEY: MASTER_KEY,
        DATABASE_URL: databaseUrl,
        TMEX_MIGRATIONS_DIR: MIGRATIONS,
        TMEX_ROLES: 'hub,node',
        GATEWAY_PORT: '17991',
        TMEX_BIND_HOST: '127.0.0.1',
      })
    );

    const scriptPath = join(installDir, 'probe-dispatch.ts');
    await writeFile(
      scriptPath,
      `
import { dispatchAuthCli } from ${JSON.stringify(join(SRC_DIR, 'cli-auth-entry.ts'))};
import { parseArgs } from ${JSON.stringify(join(SRC_DIR, 'lib/args.ts'))};

const parsed = parseArgs([
  'hub',
  'user',
  'add',
  'alice',
  '--install-dir',
  ${JSON.stringify(installDir)},
]);

let dispatchError: string | null = null;
try {
  await dispatchAuthCli(parsed, 'en');
} catch (error) {
  dispatchError = error instanceof Error ? error.message : String(error);
}

const { config } = await import(${JSON.stringify(resolve(SRC_DIR, '../../../apps/gateway/src/config.ts'))});
console.log(
  'PROBE ' +
    JSON.stringify({
      masterKey: config.masterKey ?? null,
      databaseUrl: config.databaseUrl,
      dispatchError,
    })
);
`
    );

    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => key !== 'TMEX_MASTER_KEY' && key !== 'DATABASE_URL'
        )
      ),
      NODE_ENV: 'test',
      TMEX_PASSWORD: 'tmex-test-pass',
      TMEX_PASSWORD_CONFIRM: 'tmex-test-pass',
    };

    const proc = Bun.spawn([BUN_BIN, scriptPath], {
      cwd: installDir,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const probeLine = stdout
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('PROBE '));
    expect(exitCode, `stderr=${stderr}\nstdout=${stdout}`).toBe(0);
    expect(probeLine).toBeTruthy();
    if (!probeLine) {
      throw new Error(`missing PROBE line\nstdout=${stdout}\nstderr=${stderr}`);
    }
    const probe = JSON.parse(probeLine.slice('PROBE '.length)) as {
      masterKey: string | null;
      databaseUrl: string;
      dispatchError: string | null;
    };
    expect(probe.masterKey).toBe(MASTER_KEY);
    expect(probe.databaseUrl).toBe(databaseUrl);
    expect(probe.dispatchError).toBeNull();
  }, 30_000);

  test('dispatchCli accepts parsed hub user add argv', () => {
    const parsed = parseArgs(['hub', 'user', 'add', 'alice', '--install-dir', '/tmp/tmex-x']);
    expect(parsed.command).toBe('hub');
    expect(parsed.positionals).toEqual(['user', 'add', 'alice']);
    expect(parsed.flags['install-dir']).toBe('/tmp/tmex-x');
  });
});
