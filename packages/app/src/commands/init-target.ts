import { defaultInstallDir } from '../constants';
import { t } from '../i18n';
import { readEnvFile } from '../lib/env-file';
import { pathExists } from '../lib/fs-utils';
import { createInstallLayout, resolveInstallDir } from '../lib/install-layout';
import { readJsonFile } from '../lib/json-file';
import { asBoolean, asString, assertNonEmpty, parsePort } from '../lib/validate';
import type { InstallMeta, ParsedArgs } from '../types';

export function explicitString(flags: ParsedArgs['flags'], key: string): string | undefined {
  const raw = flags[key];
  if (raw === undefined) return undefined;
  const value = asString(raw);
  if (value === undefined) {
    throw new Error(t('errors.args.invalidFlag', { flag: key, value: String(raw) }));
  }
  return assertNonEmpty(value, key);
}

export interface InstallTarget {
  installDir: string;
  force: boolean;
}

/** `--force` 重装时从旧 app.env 沿用的端口，避免探测到自己正在运行的旧服务而顺延。 */
export interface ReusablePorts {
  port?: number;
  peerPort?: number;
}

export interface InitPlan extends InstallTarget {
  reusePorts: ReusablePorts;
}

export function resolveInstallTarget(flags: ParsedArgs['flags']): InstallTarget {
  return {
    installDir: resolveInstallDir(
      explicitString(flags, 'install-dir') ?? defaultInstallDir(process.platform)
    ),
    force: asBoolean(flags.force) ?? false,
  };
}

function validPortOrUndefined(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  try {
    return parsePort(raw);
  } catch {
    return undefined;
  }
}

async function readReusablePorts(installDir: string): Promise<ReusablePorts> {
  const env = await readEnvFile(createInstallLayout(installDir).envPath).catch(() => null);
  if (!env) return {};
  return {
    port: validPortOrUndefined(env.GATEWAY_PORT),
    peerPort: validPortOrUndefined(env.VIBETERM_PEER_PORT),
  };
}

/**
 * 在任何提问、端口探测、依赖安装之前先看安装目录：已有安装且无 `--force` 直接报错；
 * `--force` 则趁目录还没被清空，先读出旧端口。
 */
export async function planInstallTarget(target: InstallTarget): Promise<InitPlan> {
  if (!target.force) {
    await assertNotInstalled(target.installDir);
    return { ...target, reusePorts: {} };
  }
  return { ...target, reusePorts: await readReusablePorts(target.installDir) };
}

/**
 * 已有安装时 init 会换掉主密钥，让原数据库无法解密，所以只引导到 upgrade。
 * `app.env`（含主密钥）先于 `install-meta.json` 写入，所以只要有其一就算已安装。
 */
export async function assertNotInstalled(installDir: string): Promise<void> {
  const { metaPath, envPath } = createInstallLayout(installDir);
  const [hasMeta, hasEnv] = await Promise.all([pathExists(metaPath), pathExists(envPath)]);
  if (!hasMeta && !hasEnv) return;
  const meta = hasMeta
    ? await readJsonFile<Partial<InstallMeta> | null>(metaPath).catch(() => null)
    : null;
  const version = meta?.cliVersion;
  throw new Error(
    version
      ? t('init.error.alreadyInstalled', { version, installDir })
      : t('init.error.alreadyInstalledNoVersion', { installDir })
  );
}
