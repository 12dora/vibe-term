import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchCli } from '../index';
import { parseArgs } from './args';
import {
  CLIENT_CLI_COMMANDS,
  clientCliCandidates,
  isClientCliCommand,
  resolveClientCliPath,
  runClientCli,
} from './client-cli';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-client-cli-'));
  dirs.push(dir);
  return dir;
}

describe('client cli dispatch table', () => {
  test('covers the groups @vibeterm/cli registers', () => {
    expect([...CLIENT_CLI_COMMANDS].sort()).toEqual(
      [
        'api',
        'cp',
        'devices',
        'files',
        'login',
        'logout',
        'nodes',
        'port',
        'settings',
        'share',
        'term',
        'tmux',
        'watch',
        'whoami',
      ].sort()
    );
  });

  test('does not swallow the packages/app commands', () => {
    for (const own of [
      'init',
      'doctor',
      'upgrade',
      'uninstall',
      'hub',
      'relay',
      'mesh',
      'enroll',
    ]) {
      expect(isClientCliCommand(own)).toBe(false);
    }
    expect(isClientCliCommand(null)).toBe(false);
  });
});

describe('bundle discovery', () => {
  test('the packaged layout finds the sibling bundle first', () => {
    const candidates = clientCliCandidates('/app/dist', false);
    expect(candidates[0]).toBe('/app/dist/cli.js');
  });

  test('the dev source layout reaches packages/cli/dist', () => {
    const candidates = clientCliCandidates('/repo/packages/app/src/lib', false);
    expect(candidates).toContain('/repo/packages/cli/dist/cli.js');
  });

  test('the .ts source entry is only offered under bun', () => {
    expect(clientCliCandidates('/repo/packages/app/src/lib', true)).toContain(
      '/repo/packages/cli/src/main.ts'
    );
    expect(
      clientCliCandidates('/repo/packages/app/src/lib', false).some((p) => p.endsWith('.ts'))
    ).toBe(false);
  });

  test('VIBETERM_CLI_BUNDLE overrides discovery', async () => {
    const dir = await tempDir();
    const bundle = join(dir, 'cli.js');
    await writeFile(bundle, 'export const runCli = async () => 0;\n');
    expect(resolveClientCliPath(dir, { VIBETERM_CLI_BUNDLE: bundle })).toBe(bundle);
  });

  test('a missing override is reported instead of silently falling back', async () => {
    const dir = await tempDir();
    expect(() => resolveClientCliPath(dir, { VIBETERM_CLI_BUNDLE: join(dir, 'nope.js') })).toThrow(
      /does not exist/
    );
  });

  test('a missing bundle names the build command', async () => {
    const dir = await tempDir();
    expect(() => resolveClientCliPath(dir, {})).toThrow(/bun run --filter @vibeterm\/cli build/);
  });
});

describe('runClientCli', () => {
  test('calls runCli with the argv and returns its exit code', async () => {
    const dir = await tempDir();
    const bundle = join(dir, 'cli.js');
    await writeFile(
      bundle,
      `export async function runCli(argv) {
  globalThis.__vibetermClientCliArgv = argv;
  return argv.includes('--fail') ? 3 : 0;
}\n`
    );
    expect(await runClientCli(['whoami', '--json'], { path: bundle })).toBe(0);
    expect((globalThis as { __vibetermClientCliArgv?: string[] }).__vibetermClientCliArgv).toEqual([
      'whoami',
      '--json',
    ]);
    expect(await runClientCli(['login', '--fail'], { path: bundle })).toBe(3);
  });

  test('a bundle without runCli is a clear error', async () => {
    const dir = await tempDir();
    const bundle = join(dir, 'not-a-cli.js');
    await writeFile(bundle, 'export const nothing = 1;\n');
    expect(runClientCli([], { path: bundle })).rejects.toThrow(/missing runCli/);
  });
});

describe('dispatchCli routing', () => {
  test('routes a client command to the bundle and propagates its exit code', async () => {
    const dir = await tempDir();
    const bundle = join(dir, 'cli.js');
    await writeFile(
      bundle,
      `export async function runCli(argv) {
  globalThis.__vibetermDispatchArgv = argv;
  return 4;
}\n`
    );
    const previousBundle = process.env.VIBETERM_CLI_BUNDLE;
    const previousExit = process.exitCode;
    process.env.VIBETERM_CLI_BUNDLE = bundle;
    try {
      const argv = ['api', 'GET', '/api/system/info', '--json'];
      await dispatchCli(parseArgs(argv), 'en', { argv });
      expect((globalThis as { __vibetermDispatchArgv?: string[] }).__vibetermDispatchArgv).toEqual(
        argv
      );
      expect(process.exitCode).toBe(4);
    } finally {
      process.exitCode = previousExit;
      if (previousBundle === undefined) delete process.env.VIBETERM_CLI_BUNDLE;
      else process.env.VIBETERM_CLI_BUNDLE = previousBundle;
    }
  });

  test('an unregistered command is still an unknown-command error', async () => {
    const argv = ['definitely-not-a-command'];
    expect(dispatchCli(parseArgs(argv), 'en', { argv })).rejects.toThrow(
      /definitely-not-a-command/
    );
  });
});
