import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
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
  'hub.standby',
  'hub.promote',
  'hub.demote',
  'hub.list',
  'hub.allow',
  'hub.disallow',
  'mesh.reset-root',
  'relay.status',
  'relay.tenants',
  'relay.passwd',
  'relay.kick',
  'relay.remove',
  'relay.quota',
  'relay.label',
  'relay.enroll',
  'relay.reauth',
  'relay.leave',
  'relay.list',
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

const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

function exitCodeFromClose(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal) {
    const number = osConstants.signals[signal];
    if (typeof number === 'number') return 128 + number;
  }
  return 1;
}

function waitChildClose(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(exitCodeFromClose(code, signal)));
  });
}

function isEpipe(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EPIPE';
}

function ignoreEpipe(error: NodeJS.ErrnoException): void {
  if (isEpipe(error)) return;
}

function attachEpipeGuard(stream: NodeJS.WritableStream | null): () => void {
  if (!stream || typeof stream.on !== 'function') return () => {};
  stream.on('error', ignoreEpipe);
  return () => {
    stream.off('error', ignoreEpipe);
  };
}

function installSignalForwarding(child: ChildProcess): () => void {
  const forwarded = new Set<(typeof FORWARDED_SIGNALS)[number]>();
  const handlers = FORWARDED_SIGNALS.map((signal) => {
    const handler = () => {
      if (forwarded.has(signal)) return;
      forwarded.add(signal);
      try {
        child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });

  return () => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  };
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
    let destAlive = dest != null;

    const onDrain = () => source.resume();
    const onDestError = (error: NodeJS.ErrnoException) => {
      if (!isEpipe(error)) return;
      destAlive = false;
      dest?.off('drain', onDrain);
      source.resume();
    };
    dest?.on('error', onDestError);

    const onData = (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      if (!dest || !destAlive) return;
      try {
        if (!dest.write(buf)) {
          source.pause();
          dest.once('drain', onDrain);
        }
      } catch (error) {
        if (!isEpipe(error)) throw error;
        destAlive = false;
        dest.off('drain', onDrain);
        source.resume();
      }
    };
    source.on('data', onData);
    source.once('error', (error) => {
      source.off('data', onData);
      dest?.off('error', onDestError);
      dest?.off('drain', onDrain);
      reject(error);
    });
    source.once('end', () => {
      source.off('data', onData);
      dest?.off('error', onDestError);
      dest?.off('drain', onDrain);
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

  const restoreSignals = installSignalForwarding(child);
  const detachEpipe = [attachEpipeGuard(stdoutDest), attachEpipeGuard(stderrDest)];

  try {
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
  } finally {
    restoreSignals();
    for (const detach of detachEpipe) detach();
  }
}
