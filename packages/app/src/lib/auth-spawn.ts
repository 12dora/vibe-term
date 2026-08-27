import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultInstallDir } from '../constants';
import type { InstallMeta, ParsedArgs } from '../types';
import { checkBunVersion, readExplicitBunPath } from './bun';
import { readEnvFile } from './env-file';
import { pathExists } from './fs-utils';
import { createInstallLayout } from './install-layout';
import { readJsonFile } from './json-file';
import { runCommand } from './process';
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

export async function spawnAuthCli(
  plan: AuthSpawnPlan,
  deps: AuthSpawnDeps = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  const run = deps.run ?? runCommand;
  return await run(plan.bunBin, [plan.cliAuthPath, ...plan.argv], {
    stdio: deps.stdio ?? 'inherit',
    env: plan.env,
  });
}
