// 升级 preflight：用临时端口 + 库副本把候选版本真跑起来，健康检查通过才允许切换 current。

import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';
import { formatHttpEndpoint } from '../../../shared/src/network';
import { t } from '../i18n';
import { RUNTIME_MODE_ENV } from '../runtime/mode';
import { readEnvFile } from './env-file';
import { errorMessage } from './error-message';
import { ensureDir, pathExists } from './fs-utils';
import { copyPreflightDb } from './upgrade-db';
import type { HealthCheckFn } from './upgrade-health';
import { pollHealthz } from './upgrade-health';
import { isPidAlive } from './upgrade-lock';
import { commandLineContains, killPidAndWait } from './upgrade-process';
import { type UpgradeJournal, advanceJournal } from './upgrade-state';
import { versionDirPath } from './upgrade-switch';

export const HEALTH_TIMEOUT_MS = 60_000;

export type CandidateHandle = { stop: () => Promise<void>; logTail?: () => string; pid?: number };

export type CandidateRunner = (opts: {
  bunPath: string;
  serverJs: string;
  env: NodeJS.ProcessEnv;
}) => Promise<CandidateHandle>;

export type PreflightDeps = {
  healthCheck?: HealthCheckFn;
  runCandidate?: CandidateRunner;
};

export async function allocateEphemeralPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
    server.on('error', reject);
  });
}

const CANDIDATE_LOG_TAIL_LINES = 20;

export const defaultCandidateRunner: CandidateRunner = async ({ bunPath, serverJs, env }) => {
  const child = spawn(bunPath, [serverJs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tail: string[] = [];
  const collect = (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      tail.push(line);
      if (tail.length > CANDIDATE_LOG_TAIL_LINES) tail.shift();
    }
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  return {
    pid: child.pid,
    logTail: () => tail.join('\n'),
    async stop() {
      if (child.pid && isPidAlive(child.pid)) {
        const ownedPid = child.pid;
        await killPidAndWait(ownedPid, 8_000, {
          assertOwned: () => {
            if (!commandLineContains(ownedPid, serverJs)) {
              throw new Error(t('upgrade.pidNotOwned', { pid: String(ownedPid), installDir: '' }));
            }
          },
        });
      }
    },
  };
};

export async function runPreflight(
  installDir: string,
  toVersion: string,
  bunPath: string,
  txnId: string,
  journal: UpgradeJournal,
  deps: PreflightDeps
): Promise<UpgradeJournal> {
  const healthCheck = deps.healthCheck ?? pollHealthz;
  const runCandidate = deps.runCandidate ?? defaultCandidateRunner;
  const envPath = join(installDir, 'app.env');
  const env = (await pathExists(envPath)) ? await readEnvFile(envPath) : {};
  const versionDir = versionDirPath(installDir, toVersion);
  const port = await allocateEphemeralPort();
  const preflightDir = join(installDir, 'staging', txnId, 'preflight-db');
  const liveDb = env.DATABASE_URL;
  let preflightDb = join(preflightDir, 'vibeterm.db');
  if (liveDb && (await pathExists(liveDb))) {
    await copyPreflightDb(liveDb, preflightDir, bunPath);
    preflightDb = join(preflightDir, basename(liveDb));
  } else {
    await ensureDir(preflightDir);
  }

  const candidateEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
    VIBETERM_BIND_HOST: '127.0.0.1',
    GATEWAY_PORT: String(port),
    VIBETERM_BASE_URL: formatHttpEndpoint('127.0.0.1', port),
    DATABASE_URL: preflightDb,
    VIBETERM_ROLES: 'standalone',
    [RUNTIME_MODE_ENV]: 'preflight',
    VIBETERM_HUB_URL: '',
    VIBETERM_PEER_PORT: String(await allocateEphemeralPort()),
    VIBETERM_FE_DIST_DIR: join(versionDir, 'resources', 'fe-dist'),
    VIBETERM_MIGRATIONS_DIR: join(versionDir, 'resources', 'gateway-drizzle'),
    VIBETERM_NATIVE_DIR: join(versionDir, 'native'),
    NODE_ENV: 'production',
  };

  const handle = await runCandidate({
    bunPath,
    serverJs: join(versionDir, 'runtime', 'server.js'),
    env: candidateEnv,
  });
  let next = journal;
  if (handle.pid) {
    next = await advanceJournal(installDir, journal, 'preflight', {
      candidatePid: handle.pid,
      candidateStartedAt: new Date().toISOString(),
    });
  }
  try {
    await healthCheck({
      url: formatHttpEndpoint('127.0.0.1', port, '/healthz'),
      expectedVersion: toVersion,
      timeoutMs: HEALTH_TIMEOUT_MS,
    });
  } catch (err) {
    const detail = handle.logTail?.();
    const message = errorMessage(err);
    throw new Error(detail ? `${message}\n${detail}` : message);
  } finally {
    await handle.stop();
    await rm(preflightDir, { recursive: true, force: true }).catch(() => null);
  }
  return next;
}
