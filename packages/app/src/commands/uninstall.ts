import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import { defaultInstallDir } from '../constants';
import { t } from '../i18n';
import { removeTmexShims } from '../lib/cli-shim';
import { readEnvFile } from '../lib/env-file';
import { pathExists, resolvePath } from '../lib/fs-utils';
import { createInstallLayout, resolveInstallDir } from '../lib/install-layout';
import { readJsonFile } from '../lib/json-file';
import { promptConfirm } from '../lib/prompt';
import { uninstallService } from '../lib/service';
import { asBoolean, asString } from '../lib/validate';
import type { InstallMeta, ParsedArgs } from '../types';

export type UninstallCommandDeps = {
  uninstallService?: (opts: { serviceName: string; installDir: string }) => Promise<void>;
  removeShims?: (opts: { installDir: string }) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  argv1?: string;
  tmpdir?: () => string;
  log?: (message: string) => void;
  shimDirs?: { localBinDir: string; bunBinDir: string };
};

async function removeIfExists(path: string): Promise<void> {
  if (await pathExists(path)) {
    await rm(path, { recursive: true, force: true });
  }
}

function parseDelayMs(raw: string | boolean | undefined): number {
  if (typeof raw !== 'string') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function isInsideDir(target: string, root: string): boolean {
  const resolvedTarget = resolve(target);
  const resolvedRoot = resolve(root);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + sep);
}

function tempUninstallCopyRoot(argv1: string, tmp: string): string | null {
  const copyRoot = dirname(dirname(resolve(argv1)));
  if (!basename(copyRoot).startsWith('tmex-uninstall-')) return null;
  if (!isInsideDir(copyRoot, tmp)) return null;
  return copyRoot;
}

export async function runUninstall(
  parsed: ParsedArgs,
  deps: UninstallCommandDeps = {}
): Promise<void> {
  const installDir = resolveInstallDir(
    asString(parsed.flags['install-dir']) || defaultInstallDir(process.platform)
  );
  const installLayout = createInstallLayout(installDir);
  const yes = asBoolean(parsed.flags.yes) ?? false;
  const purge = asBoolean(parsed.flags.purge) ?? false;
  const delayMs = parseDelayMs(parsed.flags['delay-ms']);
  const log = deps.log ?? ((message: string) => console.error(`[tmex] uninstall: ${message}`));
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));

  let serviceName = asString(parsed.flags['service-name']) || 'tmex';
  if (await pathExists(installLayout.metaPath)) {
    const meta = await readJsonFile<InstallMeta>(installLayout.metaPath);
    serviceName = meta.serviceName;
  }

  const ask = async (message: string, defaultValue: boolean): Promise<boolean> => {
    if (yes) return defaultValue;
    return await promptConfirm({ nonInteractive: false }, message, defaultValue);
  };

  if (delayMs > 0) {
    log(`delay ${delayMs}ms`);
    await sleep(delayMs);
  }

  const removeService = await ask(t('uninstall.prompt.removeService'), true);
  const removeProgram = await ask(t('uninstall.prompt.removeProgram'), true);
  const removeEnv = await ask(t('uninstall.prompt.removeEnv'), purge);
  const removeDatabase = await ask(t('uninstall.prompt.removeDatabase'), purge);

  let databasePath: string | undefined;
  if (await pathExists(installLayout.envPath)) {
    const env = await readEnvFile(installLayout.envPath).catch(
      () => ({}) as Record<string, string>
    );
    databasePath = env.DATABASE_URL;
  }

  if (removeService) {
    log('service');
    const uninstall = deps.uninstallService ?? uninstallService;
    try {
      await uninstall({ serviceName, installDir });
    } catch (err) {
      log(`service failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (removeProgram) {
    log('files');
    await removeIfExists(installLayout.runtimeDir);
    await removeIfExists(installLayout.resourcesDir);
    await removeIfExists(installLayout.cliDir);
    await removeIfExists(installLayout.versionsDir);
    await removeIfExists(installLayout.currentLink);
    await removeIfExists(installLayout.stagingDir);
    await removeIfExists(installLayout.backupsDir);
    await removeIfExists(installLayout.journalPath);
    await removeIfExists(installLayout.lockPath);
    await removeIfExists(installLayout.runScriptPath);
    await removeIfExists(installLayout.metaPath);
    const removeShims =
      deps.removeShims ??
      ((opts: { installDir: string }) =>
        removeTmexShims({
          installDir: opts.installDir,
          localBinDir: deps.shimDirs?.localBinDir,
          bunBinDir: deps.shimDirs?.bunBinDir,
        }));
    log('shims');
    try {
      await removeShims({ installDir });
    } catch (err) {
      log(`shims failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (removeEnv) {
    log('env');
    await removeIfExists(installLayout.envPath);
  }

  if (removeDatabase) {
    log('database');
    if (databasePath) {
      const resolvedDb = isAbsolute(databasePath)
        ? resolvePath(databasePath)
        : resolve(installDir, databasePath);
      if (isInsideDir(resolvedDb, installDir)) {
        await removeIfExists(resolvedDb);
        await removeIfExists(`${resolvedDb}-wal`);
        await removeIfExists(`${resolvedDb}-shm`);
      } else {
        log(`skip database outside installDir: ${resolvedDb}`);
      }
    }
  }

  if (purge) {
    log('install-dir');
    await removeIfExists(installLayout.installDir);
  }

  const argv1 = deps.argv1 ?? process.argv[1];
  if (argv1) {
    const copyRoot = tempUninstallCopyRoot(argv1, deps.tmpdir?.() ?? tmpdir());
    if (copyRoot) {
      log('self-copy');
      await rm(copyRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  console.log(`[tmex] ${t('uninstall.done')}`);
  console.log(`- ${t('uninstall.summary.installDir')}: ${installLayout.installDir}`);
  console.log(`- ${t('uninstall.summary.serviceName')}: ${serviceName}`);
}
