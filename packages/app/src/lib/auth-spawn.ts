import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { defaultInstallDir } from '../constants';
import type { InstallMeta, ParsedArgs } from '../types';
import { checkBunVersion, readExplicitBunPath } from './bun';
import { readEnvFile } from './env-file';
import { pathExists } from './fs-utils';
import { createInstallLayout } from './install-layout';
import { readJsonFile } from './json-file';
import type { runCommand } from './process';
import { asString } from './validate';

export const AUTH_COMMANDS = new Set([
  'hub.user.add',
  'hub.user.passwd',
  'hub.user.totp',
  'hub.user.reset',
  'hub.join',
  'hub.leave',
  'mesh.reset-root',
  'enroll',
]);

export type AuthSpawnPlan = {
  bunBin: string;
  cliAuthPath: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
};

export type AuthSpawnDeps = {
  bunBin?: string;
  cliAuthPath?: string;
  env?: NodeJS.ProcessEnv;
  run?: typeof runCommand;
  stdio?: 'inherit' | 'pipe';
  stdin?: 'inherit' | 'ignore';
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
};

function sourceCliAuthEntry(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'cli-auth-entry.ts');
}

export async function resolveAuthSpawnPlan(
  parsed: ParsedArgs,
  argv: string[],
  deps: AuthSpawnDeps = {}
): Promise<AuthSpawnPlan> {
  const installDir = asString(parsed.flags['install-dir']) || defaultInstallDir(process.platform);
  const layout = createInstallLayout(installDir);
  if (!(await pathExists(layout.envPath))) {
    throw new Error(`config file not found: ${layout.envPath}. run tmex init first`);
  }
  const appEnv = await readEnvFile(layout.envPath);

  let bunBin = deps.bunBin || asString(parsed.flags['bun-path']);
  if (!bunBin) {
    let metaBunPath: string | undefined;
    if (await pathExists(layout.metaPath)) {
      const meta = await readJsonFile<InstallMeta>(layout.metaPath);
      metaBunPath = meta.bunPath;
    }
    const checked = await checkBunVersion(undefined, {
      explicitPath: readExplicitBunPath(parsed.flags),
      metaBunPath,
    });
    if (!checked.ok || !checked.path) {
      throw new Error(checked.reason ?? 'bun not found');
    }
    bunBin = checked.path;
  }

  let cliAuthPath = deps.cliAuthPath;
  if (!cliAuthPath) {
    if (existsSync(layout.runtimeCliAuthPath)) {
      cliAuthPath = layout.runtimeCliAuthPath;
    } else {
      const source = sourceCliAuthEntry();
      if (existsSync(source)) {
        cliAuthPath = source;
      } else {
        throw new Error(`auth runtime missing: ${layout.runtimeCliAuthPath}`);
      }
    }
  }

  return {
    bunBin,
    cliAuthPath,
    argv,
    env: {
      ...process.env,
      ...appEnv,
      ...deps.env,
    },
  };
}

function waitChildClose(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
}

function collectAndForward(
  source: Readable | null | undefined,
  dest: NodeJS.WritableStream | null
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!source) {
      resolve(Buffer.alloc(0));
      return;
    }
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      if (!dest) return;
      if (!dest.write(buf)) {
        source.pause();
        dest.once('drain', () => source.resume());
      }
    };
    source.on('data', onData);
    source.once('error', (error) => {
      source.off('data', onData);
      reject(error);
    });
    source.once('end', () => {
      source.off('data', onData);
      resolve(Buffer.concat(chunks));
    });
  });
}

export async function spawnAuthCli(
  plan: AuthSpawnPlan,
  deps: AuthSpawnDeps = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (deps.run) {
    return await deps.run(plan.bunBin, [plan.cliAuthPath, ...plan.argv], {
      stdio: deps.stdio ?? 'inherit',
      env: plan.env,
    });
  }

  const stdin = deps.stdin ?? (process.stdin.isTTY ? 'inherit' : 'ignore');
  const stdoutDest = deps.stdout ?? (deps.stdio === 'pipe' ? null : process.stdout);
  const stderrDest = deps.stderr ?? (deps.stdio === 'pipe' ? null : process.stderr);
  const child = spawn(plan.bunBin, [plan.cliAuthPath, ...plan.argv], {
    env: plan.env,
    stdio: [stdin, 'pipe', 'pipe'],
  });

  const [code, stdout, stderr] = await Promise.all([
    waitChildClose(child),
    collectAndForward(child.stdout, stdoutDest),
    collectAndForward(child.stderr, stderrDest),
  ]);

  return {
    code,
    stdout: stdout.toString('utf8'),
    stderr: stderr.toString('utf8'),
  };
}
