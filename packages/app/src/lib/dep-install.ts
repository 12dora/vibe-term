import {
  type DependencyInstallRunnerDeps,
  confirmInstall,
  resolveInstallPlan,
  runInstallCommand,
  verifyInstalledDependency,
} from './dependency-install-runner';
import {
  type LinuxDistroInfo,
  type PackageManagerFamily,
  detectLinuxDistro as detectLinuxDistroDefault,
  detectPackageManager,
} from './linux-distro';
import { runCommand } from './process';

export type {
  DependencyInstallOptions,
  DependencyInstallRunnerDeps,
} from './dependency-install-runner';

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
    const brew = TMUX_INSTALL_COMMANDS.brew;
    if (!brewAvailable || !brew) return [];
    return [brew];
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

export async function isSudoAvailable(): Promise<boolean> {
  const result = await runCommand('sudo', ['-n', 'true'], {
    stdio: 'pipe',
    timeoutMs: 5000,
  }).catch(() => null);
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
  deps: DependencyInstallRunnerDeps = {}
): Promise<boolean> {
  const resolved = await resolveInstallPlan(plan, options, deps);
  if (!resolved.ok) return false;
  if (!(await confirmInstall(plan, options, deps))) return false;
  if (!(await runInstallCommand(plan.dep, resolved.fullCommand, deps))) return false;
  return verifyInstalledDependency(plan.dep, deps);
}
