import { t } from '../i18n';
import { checkBunVersion } from './bun';
import {
  type LinuxDistroInfo,
  type PackageManagerFamily,
  detectLinuxDistro as detectLinuxDistroDefault,
  detectPackageManager,
} from './linux-distro';
import { runCommand } from './process';
import { promptConfirm } from './prompt';
import { checkTmuxVersion } from './tmux';

export type DepName = 'bun' | 'tmux';

export interface InstallCommand {
  label: string;
  command: string;
  requiresSudo: boolean;
  packageManager: string;
}

export interface DepInstallPlan {
  dep: DepName;
  commands: InstallCommand[];
  currentVersion?: string;
  requiredVersion: string;
  issue: 'missing' | 'version-too-low';
}

const TMUX_INSTALL_COMMANDS: Record<PackageManagerFamily, InstallCommand | null> = {
  brew: {
    label: 'Homebrew',
    command: 'brew install tmux',
    requiresSudo: false,
    packageManager: 'brew',
  },
  apt: { label: 'apt', command: 'apt install -y tmux', requiresSudo: true, packageManager: 'apt' },
  dnf: { label: 'dnf', command: 'dnf install -y tmux', requiresSudo: true, packageManager: 'dnf' },
  pacman: {
    label: 'pacman',
    command: 'pacman -S --noconfirm tmux',
    requiresSudo: true,
    packageManager: 'pacman',
  },
  apk: { label: 'apk', command: 'apk add tmux', requiresSudo: true, packageManager: 'apk' },
  zypper: {
    label: 'zypper',
    command: 'zypper install -y tmux',
    requiresSudo: true,
    packageManager: 'zypper',
  },
  unknown: null,
};

export function planBunInstall(): InstallCommand[] {
  return [
    {
      label: 'Official installer',
      command: 'curl -fsSL https://bun.sh/install | bash',
      requiresSudo: false,
      packageManager: 'curl',
    },
  ];
}

export interface PlanTmuxInstallDeps {
  isCommandAvailable?: (command: string) => Promise<boolean>;
  detectLinuxDistro?: () => Promise<LinuxDistroInfo | null>;
}

export async function planTmuxInstall(
  platform: NodeJS.Platform = process.platform,
  deps: PlanTmuxInstallDeps = {}
): Promise<InstallCommand[]> {
  const commandAvailable = deps.isCommandAvailable ?? isCommandAvailable;
  const detectDistro = deps.detectLinuxDistro ?? detectLinuxDistroDefault;

  if (platform === 'darwin') {
    const brewAvailable = await commandAvailable('brew');
    if (!brewAvailable) return [];
    return [TMUX_INSTALL_COMMANDS.brew!];
  }

  if (platform === 'linux') {
    const distro = await detectDistro();
    const pm = detectPackageManager(distro, platform);
    const cmd = TMUX_INSTALL_COMMANDS[pm];
    if (cmd) return [cmd];
    return [];
  }

  return [];
}

export function getInstallHint(dep: DepName, platform: NodeJS.Platform = process.platform): string {
  if (dep === 'bun') {
    return 'curl -fsSL https://bun.sh/install | bash';
  }

  if (platform === 'darwin') {
    return 'brew install tmux';
  }

  return 'apt/dnf/pacman/apk install tmux';
}

export async function getInstallHintAsync(
  dep: DepName,
  platform: NodeJS.Platform = process.platform
): Promise<string> {
  if (dep === 'bun') {
    return 'curl -fsSL https://bun.sh/install | bash';
  }

  if (platform === 'darwin') {
    return 'brew install tmux';
  }

  if (platform === 'linux') {
    const distro = await detectLinuxDistroDefault();
    const pm = detectPackageManager(distro, platform);
    const cmd = TMUX_INSTALL_COMMANDS[pm];
    if (cmd) {
      const prefix = cmd.requiresSudo ? 'sudo ' : '';
      return `${prefix}${cmd.command}`;
    }
  }

  return 'apt/dnf/pacman/apk install tmux';
}

async function isCommandAvailable(command: string): Promise<boolean> {
  const result = await runCommand(command, ['--version'], {
    stdio: 'pipe',
    timeoutMs: 5000,
  }).catch(() => null);
  return result !== null && result.code === 0;
}

export function isRootUid(uid: number | undefined): boolean {
  return uid === 0;
}

export function isRoot(): boolean {
  return isRootUid(process.getuid?.());
}

export async function isSudoAvailable(run: typeof runCommand = runCommand): Promise<boolean> {
  const result = await run('sudo', ['-n', 'true'], {
    stdio: 'pipe',
    timeoutMs: 5000,
  }).catch(() => null);
  return result !== null && result.code === 0;
}

export interface ExecuteDependencyInstallDeps {
  runCommand?: typeof runCommand;
  getuid?: () => number | undefined;
  promptConfirm?: typeof promptConfirm;
  checkBunVersion?: typeof checkBunVersion;
  checkTmuxVersion?: typeof checkTmuxVersion;
  platform?: NodeJS.Platform;
}

function reportInstallFailed(dep: DepName): void {
  console.error(`[tmex] ${t('deps.install.failed', { dep })}`);
  console.error(`[tmex] ${t('deps.install.manual')}`);
}

async function runInstallCommand(run: typeof runCommand, fullCommand: string): Promise<boolean> {
  if (fullCommand.includes('|')) {
    const result = await run('sh', ['-c', fullCommand], { stdio: 'inherit' }).catch(() => null);
    return result !== null && result.code === 0;
  }
  const parts = fullCommand.split(' ');
  const bin = parts[0] ?? '';
  const result = await run(bin, parts.slice(1), { stdio: 'inherit' }).catch(() => null);
  return result !== null && result.code === 0;
}

export function resolveInstallCommand(
  cmd: InstallCommand,
  uid: number | undefined = process.getuid?.()
): string {
  if (!cmd.requiresSudo) return cmd.command;
  if (isRootUid(uid)) return cmd.command;
  return `sudo ${cmd.command}`;
}

export async function executeDependencyInstall(
  plan: DepInstallPlan,
  options: { nonInteractive: boolean; autoConfirm: boolean },
  deps: ExecuteDependencyInstallDeps = {}
): Promise<boolean> {
  const run = deps.runCommand ?? runCommand;
  const uid = (deps.getuid ?? (() => process.getuid?.()))();
  const platform = deps.platform ?? process.platform;
  const confirm = deps.promptConfirm ?? promptConfirm;
  const checkBun = deps.checkBunVersion ?? checkBunVersion;
  const checkTmux = deps.checkTmuxVersion ?? checkTmuxVersion;

  if (plan.commands.length === 0) {
    if (plan.dep === 'tmux' && platform === 'darwin') {
      console.error(`[tmex] ${t('deps.install.brewMissing')}`);
    } else {
      console.error(`[tmex] ${t('deps.install.unknownDistro', { dep: plan.dep })}`);
    }
    console.error(`[tmex] ${t('deps.install.manual')}`);
    return false;
  }

  const cmd = plan.commands[0]!;
  const fullCommand = resolveInstallCommand(cmd, uid);

  if (cmd.requiresSudo && !isRootUid(uid) && options.nonInteractive) {
    const sudoOk = await isSudoAvailable(run);
    if (!sudoOk) {
      console.error(`[tmex] ${t('deps.install.sudoUnavailable')}`);
      return false;
    }
  }

  console.log(`[tmex] ${t('deps.install.hint', { command: fullCommand })}`);

  if (!options.autoConfirm) {
    if (options.nonInteractive) {
      console.error(`[tmex] ${t('deps.install.nonInteractive', { dep: plan.dep })}`);
      return false;
    }

    const confirmed = await confirm(
      { nonInteractive: false },
      t('deps.install.confirm', { dep: plan.dep }),
      true
    );
    if (!confirmed) return false;
  }

  console.log(`[tmex] ${t('deps.install.running', { dep: plan.dep })}`);

  if (!(await runInstallCommand(run, fullCommand))) {
    reportInstallFailed(plan.dep);
    return false;
  }

  const check = plan.dep === 'bun' ? await checkBun() : await checkTmux();
  if (check.ok) {
    console.log(`[tmex] ${t('deps.install.success', { dep: plan.dep })}`);
    return true;
  }

  reportInstallFailed(plan.dep);
  return false;
}
