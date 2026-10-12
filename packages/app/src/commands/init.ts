import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { canonicalPublicUrl } from '../../../shared/src/auth';
import {
  DEFAULT_PUBLIC_HTTPS_PORT,
  DEFAULT_TLS_PORT,
  parseProbeTarget,
  pickSuggestedPortAvoiding,
} from '../../../shared/src/net';
import { normalizeRelayUrl } from '../../../shared/src/relay';
import { DEFAULT_SERVICE_NAME, defaultDatabasePath, defaultHost, defaultPort } from '../constants';
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
import { type CanBind, canBindPort, pickFreePort } from '../lib/free-port';
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
  resolvePackageLayout,
} from '../lib/install-layout';
import { detectInstallSource } from '../lib/install-source';
import { detectServiceManager } from '../lib/platform';
import { promptConfirm, promptText } from '../lib/prompt';
import { DEFAULT_PEER_PORT, parseVibeTermRoleName } from '../lib/roles';
import { installService, serviceHint } from '../lib/service';
import { checkTmuxVersion } from '../lib/tmux';
import { repairUpgrade, withUpgradeLock } from '../lib/upgrade-apply';
import { readJournal } from '../lib/upgrade-state';
import { switchCurrent } from '../lib/upgrade-switch';
import { asBoolean, asString, parsePort } from '../lib/validate';
import { readPackageVersion } from '../lib/version';
import { formatPortPlanForEnv } from '../runtime/local-port-plan';
import type { InitConfig, InstallMeta, ParsedArgs } from '../types';
import { type DirectOnboardingDeps, enableDirectForOnboarding } from './direct';
import {
  type InitPlan,
  explicitString,
  planInstallTarget,
  resolveInstallTarget,
} from './init-target';

const PEER_PROBE_HOST = '0.0.0.0';

export type { InitConfig };
export { DEFAULT_PUBLIC_HTTPS_PORT };

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

async function directoryHasContent(path: string): Promise<boolean> {
  if (!(await pathExists(path))) {
    return false;
  }

  const items = await readdir(path);
  return items.length > 0;
}

type InitAsk = (message: string, fallback: string) => Promise<string>;

export type PortFallback = { from: number; to: number };

export interface InitDeps {
  canBind?: CanBind;
  /** 仅 relay 角色的公网端口与地址会提问。 */
  ask?: InitAsk;
  /** 默认端口被占用而改用其他端口时回调，由调用方决定何时提示。 */
  onPortFallback?: (fallback: PortFallback) => void;
}

type ResolvedInitDeps = Required<InitDeps>;

function resolveInitDeps(deps: InitDeps): ResolvedInitDeps {
  return {
    canBind: deps.canBind ?? canBindPort,
    ask:
      deps.ask ?? ((message, fallback) => promptText({ nonInteractive: false }, message, fallback)),
    onPortFallback: deps.onPortFallback ?? (() => {}),
  };
}

function explicitBoolean(flags: ParsedArgs['flags'], key: string, fallback: boolean): boolean {
  const raw = flags[key];
  if (raw === undefined) return fallback;
  const value = asBoolean(raw);
  if (value === undefined) {
    throw new Error(t('errors.args.invalidFlag', { flag: key, value: String(raw) }));
  }
  return value;
}

/** 给了端口就原样使用；`--force` 重装沿用旧 app.env 的端口；都没有则从默认端口起探测第一个可绑定的。 */
async function resolvePort(input: {
  flags: ParsedArgs['flags'];
  key: string;
  preferred: number;
  reuse: number | undefined;
  host: string;
  avoid: readonly number[];
  deps: ResolvedInitDeps;
}): Promise<number> {
  const explicit = explicitString(input.flags, input.key);
  if (explicit !== undefined) return parsePort(explicit);
  if (input.reuse !== undefined) return input.reuse;
  const port = await pickFreePort(input.preferred, input.host, {
    flag: input.key,
    canBind: input.deps.canBind,
    avoid: input.avoid,
  });
  if (port !== input.preferred) input.deps.onPortFallback({ from: input.preferred, to: port });
  return port;
}

export async function prepareInitConfig(
  parsed: ParsedArgs,
  initDeps: InitDeps = {}
): Promise<InitConfig> {
  const plan = await planInstallTarget(resolveInstallTarget(parsed.flags));
  return buildInitConfig(parsed, plan, initDeps);
}

export async function buildInitConfig(
  parsed: ParsedArgs,
  plan: InitPlan,
  initDeps: InitDeps = {}
): Promise<InitConfig> {
  const flags = parsed.flags;
  const deps = resolveInitDeps(initDeps);
  const { installDir } = plan;
  const host = explicitString(flags, 'host') ?? defaultHost();
  const port = await resolvePort({
    flags,
    key: 'port',
    preferred: defaultPort(),
    reuse: plan.reusePorts.port,
    host,
    avoid: [],
    deps,
  });
  const uplink = await buildUplinkConfig(parsed, port, plan.reusePorts.peerPort, deps);
  return {
    installDir,
    host,
    port,
    databasePath: resolve(explicitString(flags, 'db-path') ?? defaultDatabasePath(installDir)),
    autostart: explicitBoolean(flags, 'autostart', true),
    serviceName: explicitString(flags, 'service-name') ?? DEFAULT_SERVICE_NAME,
    force: plan.force,
    nonInteractive: flags['no-interactive'] === true,
    installDeps: asBoolean(flags['install-deps']) ?? false,
    skipDepCheck: asBoolean(flags['skip-dep-check']) ?? false,
    ...uplink,
    stunServers: resolveInitStunServers(flags) ?? '',
    noService: asBoolean(flags['no-service']) ?? false,
  };
}

type UplinkConfig = Pick<InitConfig, 'role' | 'relayPublicUrl' | 'peerPort'>;

async function buildUplinkConfig(
  parsed: ParsedArgs,
  gatewayPort: number,
  reusePeerPort: number | undefined,
  deps: ResolvedInitDeps
): Promise<UplinkConfig> {
  const flags = parsed.flags;
  const nonInteractive = flags['no-interactive'] === true;
  const role = parseVibeTermRoleName(explicitString(flags, 'role') ?? 'standalone');
  const peerPort = await resolvePort({
    flags,
    key: 'peer-port',
    preferred: DEFAULT_PEER_PORT,
    reuse: reusePeerPort,
    host: PEER_PROBE_HOST,
    avoid: [gatewayPort, DEFAULT_TLS_PORT],
    deps,
  });
  if (role !== 'relay' && role !== 'relay,node') {
    return { role, relayPublicUrl: '', peerPort };
  }
  const publicPort = await resolvePublicHttpsPort(parsed, nonInteractive, deps.ask, [
    gatewayPort,
    peerPort,
    DEFAULT_TLS_PORT,
  ]);
  const relayPublicUrl = await resolveRelayPublicUrl(
    nonInteractive,
    deps.ask,
    asString(flags['relay-public-url']) || '',
    publicPort
  );
  return { role, relayPublicUrl, peerPort };
}

/**
 * 公网 HTTPS 端口。运营商封 443 时改用高位端口；建议值避开本机已占用的端口。
 * 非交互不提问：`--public-port` 给了就用，没给沿用 443（地址里已写端口时它不生效）。
 */
async function resolvePublicHttpsPort(
  parsed: ParsedArgs,
  nonInteractive: boolean,
  ask: InitAsk,
  used: number[]
): Promise<number> {
  const flag = asString(parsed.flags['public-port']);
  if (flag) return parsePort(flag);
  if (nonInteractive) return DEFAULT_PUBLIC_HTTPS_PORT;
  const suggested = pickSuggestedPortAvoiding(used);
  const answer = await ask(
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
    return canonicalPublicUrl(url.toString());
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
  ask: InitAsk,
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
    ask,
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
  ask: InitAsk;
  label: string;
  current: string;
  publicPort: number;
  normalize: (raw: string) => string;
}): Promise<string | null> {
  let answer = applyPublicPort(input.current, input.publicPort);
  for (let attempt = 0; attempt < RELAY_PUBLIC_URL_ATTEMPTS; attempt++) {
    answer = await input.ask(input.label, answer);
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
  }
  const list = initPortPlanList(config);
  if (list) {
    console.log(`- ${t('init.summary.ports')}: ${list}`);
    console.log(`- ${t('init.summary.portsHint')}`);
  }
}

export function initPortPlanList(
  config: Pick<InitConfig, 'role' | 'host' | 'port' | 'peerPort' | 'relayPublicUrl'>
): string {
  return formatPortPlanForEnv({
    VIBETERM_ROLES: config.role,
    GATEWAY_PORT: String(config.port),
    VIBETERM_BIND_HOST: config.host,
    VIBETERM_PEER_PORT: String(config.peerPort),
    VIBETERM_RELAY_PUBLIC_URL: config.relayPublicUrl,
  });
}

async function confirmNonEmptyInstallDir(config: InitConfig): Promise<void> {
  if (!(await directoryHasContent(config.installDir))) return;
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

async function repairInterruptedUpgrade(installDir: string, bunPath: string): Promise<void> {
  if (!(await readJournal(installDir))) return;
  await withUpgradeLock(installDir, () =>
    repairUpgrade(installDir, bunPath, { shimDirs: defaultShimDirs() })
  );
}

export async function runInit(parsed: ParsedArgs): Promise<void> {
  const portFallbacks: PortFallback[] = [];
  const config = await prepareInitConfig(parsed, {
    onPortFallback: (fallback) => portFallbacks.push(fallback),
  });
  const manager = await detectServiceManager();
  if (manager === 'none' && !config.noService) {
    throw new Error(t('init.error.noServiceManager', { platform: process.platform }));
  }

  const bun = await checkInitDependencies(config, parsed);

  if (!config.force) {
    await repairInterruptedUpgrade(config.installDir, bun.path);
    await confirmNonEmptyInstallDir(config);
  }
  for (const fallback of portFallbacks) {
    console.log(`[vibeterm] ${t('init.port.fallback', fallback)}`);
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
    peerPort: config.peerPort,
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
