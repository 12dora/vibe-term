import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  DEFAULT_TURN_PORT,
  DEFAULT_TURN_RELAY_RANGE_TEXT,
} from '../../../../apps/gateway/src/relay/relay-turn-config';
import { DEFAULT_TLS_PORT } from '../../../../apps/gateway/src/tls/types';
import { canonicalHubUrl } from '../../../shared/src/auth';
import {
  isLoopbackHostname,
  parseProbeTarget,
  pickSuggestedPortAvoiding,
} from '../../../shared/src/net/port-candidates';
import { normalizeRelayUrl } from '../../../shared/src/relay';
import {
  DEFAULT_SERVICE_NAME,
  defaultDatabasePath,
  defaultHost,
  defaultInstallDir,
  defaultPort,
} from '../constants';
import { t } from '../i18n';
import { checkBunVersion, readExplicitBunPath } from '../lib/bun';
import { defaultShimDirs, deployCliAndShim } from '../lib/cli-shim';
import {
  type DepInstallPlan,
  executeDependencyInstall,
  getInstallHintAsync,
  planBunInstall,
  planTmuxInstall,
} from '../lib/dep-install';
import { writeEnvFile } from '../lib/env-file';
import { errorMessage } from '../lib/error-message';
import { ensureDir, pathExists } from '../lib/fs-utils';
import {
  buildAppEnvValues,
  deployRuntimeFiles,
  ensureInstallDir,
  generateMasterKey,
  writeInstallMeta,
  writeRunScript,
} from '../lib/install';
import {
  createInstallLayout,
  createVersionLayout,
  resolveInstallDir,
  resolvePackageLayout,
} from '../lib/install-layout';
import { detectInstallSource } from '../lib/install-source';
import { detectServiceManager } from '../lib/platform';
import { promptConfirm, promptText } from '../lib/prompt';
import {
  DEFAULT_PEER_PORT,
  parseVibeTermRoleName,
  rolesFromName,
  validateRoles,
} from '../lib/roles';
import { installService, serviceHint } from '../lib/service';
import { checkTmuxVersion } from '../lib/tmux';
import { repairUpgrade, withUpgradeLock } from '../lib/upgrade-apply';
import { readJournal } from '../lib/upgrade-state';
import { switchCurrent } from '../lib/upgrade-switch';
import { asBoolean, asString, assertNonEmpty, parsePort } from '../lib/validate';
import { readPackageVersion } from '../lib/version';
import type { InitConfig, InstallMeta, ParsedArgs } from '../types';
import { type DirectOnboardingDeps, enableDirectForOnboarding } from './direct';

export type { InitConfig };

/** `--stun-servers` 显式覆盖才写入 app.env；缺省或空白表示使用发行版内置列表。 */
export function resolveInitStunServers(flags: ParsedArgs['flags']): string | undefined {
  const raw = asString(flags['stun-servers'])?.trim();
  return raw || undefined;
}

export type EnableDirectAfterInitDeps = DirectOnboardingDeps;

export async function enableDirectAfterInit(
  config: Pick<InitConfig, 'role' | 'installDir'>,
  deps: EnableDirectAfterInitDeps = {}
): Promise<void> {
  await enableDirectForOnboarding(config.installDir, deps);
}

function mustGetStringFlag(flags: ParsedArgs['flags'], key: string): string {
  const value = asString(flags[key]);
  if (!value) {
    throw new Error(t('errors.args.missingFlag', { flag: key }));
  }
  return value;
}

function mustGetBooleanFlag(flags: ParsedArgs['flags'], key: string): boolean {
  const value = asBoolean(flags[key]);
  if (value === undefined) {
    throw new Error(t('errors.args.invalidFlag', { flag: key, value: String(flags[key]) }));
  }
  return value;
}

async function directoryHasContent(path: string): Promise<boolean> {
  if (!(await pathExists(path))) {
    return false;
  }

  const items = await readdir(path);
  return items.length > 0;
}

async function buildInitConfig(parsed: ParsedArgs): Promise<InitConfig> {
  const flags = parsed.flags;
  const ni = flags['no-interactive'] === true;
  const ask = async (
    key: string,
    prompt: string,
    fallback: string,
    required = true
  ): Promise<string> => {
    if (ni) {
      if (required) return assertNonEmpty(mustGetStringFlag(flags, key), key);
      return asString(flags[key]) || fallback;
    }
    const value = await promptText(
      { nonInteractive: false },
      prompt,
      asString(flags[key]) || fallback
    );
    return required ? assertNonEmpty(value, key) : value;
  };

  const installDir = resolveInstallDir(
    await ask('install-dir', t('init.prompt.installDir'), defaultInstallDir(process.platform))
  );
  const host = await ask('host', t('init.prompt.host'), defaultHost());
  const port = parsePort(await ask('port', t('init.prompt.port'), String(defaultPort())));
  const databasePath = resolve(
    await ask('db-path', t('init.prompt.dbPath'), defaultDatabasePath(installDir))
  );
  const autostart = ni
    ? mustGetBooleanFlag(flags, 'autostart')
    : (asBoolean(flags.autostart) ??
      (await promptConfirm({ nonInteractive: false }, t('init.prompt.autostart'), true)));
  const serviceName = assertNonEmpty(
    ni
      ? asString(flags['service-name']) || DEFAULT_SERVICE_NAME
      : await promptText(
          { nonInteractive: false },
          t('init.prompt.serviceName'),
          asString(flags['service-name']) || DEFAULT_SERVICE_NAME
        ),
    'service-name'
  );
  const uplink = await buildUplinkConfig(parsed, ni, ask, port);
  return {
    installDir,
    host,
    port,
    databasePath,
    autostart,
    serviceName,
    force: asBoolean(flags.force) ?? false,
    nonInteractive: ni,
    installDeps: asBoolean(flags['install-deps']) ?? false,
    skipDepCheck: asBoolean(flags['skip-dep-check']) ?? false,
    ...uplink,
    stunServers: resolveInitStunServers(flags) ?? '',
    noService: asBoolean(flags['no-service']) ?? false,
  };
}

type AskFlag = (
  key: string,
  prompt: string,
  fallback: string,
  required?: boolean
) => Promise<string>;

type UplinkConfig = Pick<
  InitConfig,
  'role' | 'hubUrl' | 'hubPublicUrl' | 'relayPublicUrl' | 'peerPort'
>;

async function buildUplinkConfig(
  parsed: ParsedArgs,
  ni: boolean,
  ask: AskFlag,
  gatewayPort: number
): Promise<UplinkConfig> {
  const flags = parsed.flags;
  const role = parseVibeTermRoleName(
    (await ask('role', 'Role (standalone|node|hub,node|relay|relay,node)', 'standalone', false)) ||
      'standalone'
  );
  const invalidRole = validateRoles(rolesFromName(role));
  if (invalidRole) {
    throw new Error(invalidRole);
  }
  const isRelay = role === 'relay' || role === 'relay,node';
  const hubUrl = isRelay
    ? ''
    : await ask('hub-url', 'Hub URL (VIBETERM_HUB_URL, empty allowed)', '', false);
  const peerPort = parsePort(
    (await ask('peer-port', 'Peer port (VIBETERM_PEER_PORT)', String(DEFAULT_PEER_PORT), false)) ||
      String(DEFAULT_PEER_PORT)
  );
  const hubPublicUrlFlag = asString(flags['hub-public-url']) || '';
  const needsPublicUrl = isRelay || role === 'hub,node';
  const publicPort = needsPublicUrl
    ? await resolvePublicHttpsPort(parsed, ni, [gatewayPort, peerPort, DEFAULT_TLS_PORT])
    : DEFAULT_PUBLIC_HTTPS_PORT;
  const hubPublicUrl =
    role === 'hub,node'
      ? await resolveHubPublicUrl(ni, hubPublicUrlFlag, publicPort)
      : hubPublicUrlFlag;
  const relayPublicUrl = isRelay
    ? await resolveRelayPublicUrl(ni, asString(flags['relay-public-url']) || '', publicPort)
    : '';
  return { role, hubUrl, hubPublicUrl, relayPublicUrl, peerPort };
}

export const DEFAULT_PUBLIC_HTTPS_PORT = 443;

/**
 * 公网 HTTPS 端口。运营商封 443 时改用高位端口；建议值避开本机已占用的端口。
 * 非交互不提问：`--public-port` 给了就用，没给沿用 443（地址里已写端口时它不生效）。
 */
async function resolvePublicHttpsPort(
  parsed: ParsedArgs,
  nonInteractive: boolean,
  used: number[]
): Promise<number> {
  const flag = asString(parsed.flags['public-port']);
  if (flag) return parsePort(flag);
  if (nonInteractive) return DEFAULT_PUBLIC_HTTPS_PORT;
  const suggested = pickSuggestedPortAvoiding(used);
  const answer = await promptText(
    { nonInteractive: false },
    t('init.prompt.publicPort', { suggested }),
    String(DEFAULT_PUBLIC_HTTPS_PORT)
  );
  return parsePort(answer);
}

/** 地址自己写了端口就以它为准；否则补上选定的公网端口。 */
export function applyPublicPort(raw: string, port: number): string {
  const value = raw.trim();
  if (!value || port === DEFAULT_PUBLIC_HTTPS_PORT) return value;
  try {
    const target = parseProbeTarget(value);
    if (target.explicitPort !== null) return value;
    const url = new URL(target.base);
    url.port = String(port);
    return canonicalHubUrl(url.toString());
  } catch {
    return value;
  }
}

const RELAY_PUBLIC_URL_ATTEMPTS = 3;

/**
 * 中继的公开地址是节点 uplink 的目标，写坏了整台中继就没人能接入；空值/非 https 一律
 * 在落任何配置之前就拦下（`normalizeRelayUrl` 与 join 串、`set-relays` 同一套规则）。
 */
async function resolveRelayPublicUrl(
  nonInteractive: boolean,
  current: string,
  publicPort: number
): Promise<string> {
  if (nonInteractive) {
    if (!current) {
      throw new Error('init --role relay requires --relay-public-url in non-interactive mode');
    }
    return normalizeRelayPublicUrl(applyPublicPort(current, publicPort));
  }
  const answer = await promptPublicUrl({
    label: 'Relay public URL (VIBETERM_RELAY_PUBLIC_URL)',
    current,
    publicPort,
    normalize: normalizeRelayPublicUrl,
  });
  if (answer !== null) return answer;
  throw new Error('init --role relay requires a valid https --relay-public-url');
}

/** 提问 → 补端口 → 校验，最多重试 `RELAY_PUBLIC_URL_ATTEMPTS` 次；全失败返回 `null`。 */
async function promptPublicUrl(input: {
  label: string;
  current: string;
  publicPort: number;
  normalize: (raw: string) => string;
}): Promise<string | null> {
  let answer = applyPublicPort(input.current, input.publicPort);
  for (let attempt = 0; attempt < RELAY_PUBLIC_URL_ATTEMPTS; attempt++) {
    answer = await promptText({ nonInteractive: false }, input.label, answer);
    try {
      return input.normalize(applyPublicPort(answer, input.publicPort));
    } catch (error) {
      console.error(errorMessage(error));
    }
  }
  return null;
}

export function normalizeRelayPublicUrl(raw: string): string {
  const value = raw.trim();
  if (!value) {
    throw new Error('relay public URL cannot be empty');
  }
  try {
    return normalizeRelayUrl(value);
  } catch (error) {
    throw new Error(`invalid relay public URL: ${errorMessage(error)}`);
  }
}

/** Hub 公网地址与中继同一套规则：https（回环允许 http），写坏了没有节点能加入。 */
export function normalizeHubPublicUrl(raw: string): string {
  const value = raw.trim();
  if (!value) {
    throw new Error('hub public URL cannot be empty');
  }
  let canonical: string;
  try {
    canonical = canonicalHubUrl(value);
  } catch (error) {
    throw new Error(`invalid hub public URL: ${errorMessage(error)}`);
  }
  const url = new URL(canonical);
  if (url.protocol === 'https:') return canonical;
  if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return canonical;
  throw new Error('invalid hub public URL: must be https (http allowed for loopback only)');
}

async function resolveHubPublicUrl(
  nonInteractive: boolean,
  current: string,
  publicPort: number
): Promise<string> {
  if (nonInteractive) {
    if (!current) {
      throw new Error('init --role hub,node requires --hub-public-url in non-interactive mode');
    }
    return normalizeHubPublicUrl(applyPublicPort(current, publicPort));
  }
  const answer = await promptPublicUrl({
    label: 'Hub public URL (VIBETERM_HUB_PUBLIC_URL)',
    current,
    publicPort,
    normalize: normalizeHubPublicUrl,
  });
  if (answer !== null) return answer;
  throw new Error('init --role hub,node requires a valid https --hub-public-url');
}

async function handleDepFailure(
  dep: 'bun' | 'tmux',
  config: InitConfig,
  errorMessage: string
): Promise<void> {
  const hint = await getInstallHintAsync(dep);
  const commands = dep === 'bun' ? planBunInstall() : await planTmuxInstall();
  const plan: DepInstallPlan = {
    dep,
    commands,
    requiredVersion: dep === 'tmux' ? '>= 3.0' : '>= 1.3.0',
    issue: 'missing',
  };

  if (config.installDeps || !config.nonInteractive) {
    const installed = await executeDependencyInstall(plan, {
      nonInteractive: config.nonInteractive,
      autoConfirm: config.installDeps && config.nonInteractive,
    });
    if (installed) return;
    throw new Error(errorMessage);
  }

  throw new Error(`${errorMessage}\n${t('deps.install.hint', { command: hint })}`);
}

async function checkInitDependencies(
  config: InitConfig,
  parsed: ParsedArgs
): Promise<{ path: string; version?: string; ok: boolean; reason?: string }> {
  if (!config.skipDepCheck && config.role !== 'relay') {
    const tmux = await checkTmuxVersion();
    if (!tmux.ok) {
      const reason =
        tmux.reason === 'version-too-low'
          ? t('tmux.versionTooLow', { version: tmux.versionRaw || '' })
          : t('tmux.notFound');
      await handleDepFailure('tmux', config, reason);
    }
  }

  const explicitBunPath = readExplicitBunPath(parsed.flags);
  const bun = await checkBunVersion(undefined, { explicitPath: explicitBunPath });
  if (!bun.ok || !bun.path) {
    const reason = bun.reason || t('bun.checkFailed');
    if (!config.skipDepCheck) {
      await handleDepFailure('bun', config, reason);
      const bunRetry = await checkBunVersion(undefined, { explicitPath: explicitBunPath });
      if (!bunRetry.ok || !bunRetry.path) {
        throw new Error(bunRetry.reason || t('bun.checkFailed'));
      }
      return { ...bunRetry, path: bunRetry.path };
    }
    throw new Error(reason);
  }
  return { ...bun, path: bun.path };
}

async function startInstalledRuntime(config: InitConfig, runScriptPath: string): Promise<void> {
  if (!config.noService) {
    await installService({
      serviceName: config.serviceName,
      installDir: config.installDir,
      runScriptPath,
      autostart: config.autostart,
    });
    return;
  }
  const { createDirectProcessControl, pidFilePath } = await import('../lib/upgrade-apply');
  await createDirectProcessControl({
    runScriptPath,
    pidPath: pidFilePath(config.installDir),
    installDir: config.installDir,
  }).start();
}

function printInitSummary(
  config: InitConfig,
  bun: { path: string; version?: string },
  serviceHintText: string,
  shim: { shimDeployed: boolean; shimPath: string; pathHint: string | null }
): void {
  console.log(`[vibeterm] ${t('init.done')}`);
  console.log(`- ${t('init.summary.installDir')}: ${config.installDir}`);
  console.log(`- ${t('init.summary.serviceName')}: ${config.serviceName}`);
  console.log(`- ${t('init.summary.bun')}: ${bun.version} (${bun.path})`);
  console.log(
    `- ${t('init.summary.autostart')}: ${config.autostart ? t('init.summary.autostart.on') : t('init.summary.autostart.off')}`
  );
  console.log(`- ${t('init.summary.serviceHint')}: ${serviceHintText}`);
  if (shim.shimDeployed) console.log(`- ${t('cli.shim.ready', { shimPath: shim.shimPath })}`);
  if (shim.pathHint) {
    console.log(`- ${shim.pathHint}`);
  }
  if (config.role === 'relay' || config.role === 'relay,node') {
    console.log(
      `- relay admin token: VIBETERM_RELAY_ADMIN_TOKEN in ${join(config.installDir, 'app.env')}`
    );
    console.log('- run "vibeterm relay status" on this machine to manage tenants');
    console.log(
      `- ${t('init.summary.turnFirewall', { port: DEFAULT_TURN_PORT, range: DEFAULT_TURN_RELAY_RANGE_TEXT })}`
    );
  }
}

export async function runInit(parsed: ParsedArgs): Promise<void> {
  const config = await buildInitConfig(parsed);
  const manager = await detectServiceManager();
  if (manager === 'none' && !config.noService) {
    throw new Error(t('init.error.noServiceManager', { platform: process.platform }));
  }

  const bun = await checkInitDependencies(config, parsed);

  if (!config.force) {
    const journal = await readJournal(config.installDir);
    if (journal) {
      await withUpgradeLock(config.installDir, () =>
        repairUpgrade(config.installDir, bun.path, { shimDirs: defaultShimDirs() })
      );
    }
  }

  if (!config.force && (await directoryHasContent(config.installDir))) {
    if (config.nonInteractive) {
      throw new Error(t('init.error.installDirNotEmpty', { installDir: config.installDir }));
    }

    const confirmed = await promptConfirm(
      { nonInteractive: false },
      t('init.prompt.dirExistsConfirm', { installDir: config.installDir }),
      false
    );

    if (!confirmed) {
      throw new Error(t('common.cancelled'));
    }
  }

  const packageLayout = await resolvePackageLayout(import.meta.url);
  const cliVersion = await readPackageVersion(packageLayout.packageRoot);

  await ensureInstallDir(config.installDir, config.force);
  await ensureDir(dirname(config.databasePath));

  const versionLayout = createVersionLayout(config.installDir, cliVersion);
  await deployRuntimeFiles(packageLayout, versionLayout);
  await switchCurrent(config.installDir, cliVersion);
  const installLayout = createInstallLayout(config.installDir);
  const [localBinDir, bunBinDir] = defaultShimDirs();
  const shim = await deployCliAndShim(packageLayout, installLayout, bun.path, {
    localBinDir,
    bunBinDir,
    force: asBoolean(parsed.flags['replace-shim']) ?? false,
  });
  await enableDirectAfterInit(config);

  const masterKey = generateMasterKey();
  const envValues = buildAppEnvValues({
    host: config.host,
    port: config.port,
    databasePath: config.databasePath,
    masterKey,
    role: config.role,
    hubUrl: config.hubUrl,
    peerPort: config.peerPort,
    hubPublicUrl: config.hubPublicUrl,
    relayPublicUrl: config.relayPublicUrl,
    stunServers: config.stunServers,
  });
  await writeEnvFile(installLayout.envPath, envValues);
  await writeRunScript(installLayout, bun.path);
  await startInstalledRuntime(config, installLayout.runScriptPath);

  const meta: InstallMeta = {
    serviceName: config.serviceName,
    platform: process.platform,
    autostart: config.autostart,
    installDir: config.installDir,
    updatedAt: new Date().toISOString(),
    cliVersion,
    bunPath: bun.path,
    serviceMode: config.noService ? 'none' : 'managed',
    installSource: detectInstallSource(),
  };
  await writeInstallMeta(installLayout, meta);

  printInitSummary(config, bun, await serviceHint(config.serviceName), shim);
}
