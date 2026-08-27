import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/args';
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

describe('dispatchCli auth env load', () => {
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
import { dispatchCli } from ${JSON.stringify(join(SRC_DIR, 'index.ts'))};
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
  await dispatchCli(parsed, 'en');
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
