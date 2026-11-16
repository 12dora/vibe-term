import {
  type DepInstallPlan,
  type DepName,
  type InstallCommand,
  isRootUid,
  resolveInstallCommand,
} from './dep-install-types';
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
  DepInstallPlan,
  DepName,
  DependencyInstallOptions,
  DependencyInstallRunnerDeps,
  InstallCommand,
} from './dep-install-types';
export { isRootUid, isSudoAvailable, resolveInstallCommand } from './dep-install-types';

const BUN_OFFICIAL_INSTALLER: InstallCommand = {
  label: 'Official installer',
  command: 'curl -fsSL https://bun.sh/install | bash',
  requiresSudo: false,
  packageManager: 'curl',
};

const BUN_APK_PREREQS: InstallCommand = {
  label: 'apk',
  command: 'apk add bash curl unzip libstdc++ libgcc',
  requiresSudo: true,
  packageManager: 'apk',
};

export interface PlanBunInstallDeps {
  distro?: LinuxDistroInfo | null;
  packageManager?: PackageManagerFamily;
}

export function planBunInstall(
  platform: NodeJS.Platform = process.platform,
  deps: PlanBunInstallDeps = {}
): InstallCommand[] {
  const family = deps.packageManager ?? detectPackageManager(deps.distro ?? null, platform);
  if (family === 'apk') {
    return [BUN_APK_PREREQS, BUN_OFFICIAL_INSTALLER];
  }
  return [BUN_OFFICIAL_INSTALLER];
}

export async function planBunInstallForHost(
  platform: NodeJS.Platform = process.platform,
  detectDistro: () => Promise<LinuxDistroInfo | null> = detectLinuxDistroDefault
): Promise<InstallCommand[]> {
  const distro = platform === 'linux' ? await detectDistro() : null;
  return planBunInstall(platform, { distro });
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

function formatHint(commands: InstallCommand[]): string {
  return commands
    .map((command) => (command.requiresSudo ? `sudo ${command.command}` : command.command))
    .join(' && ');
}

export function getInstallHint(dep: DepName, platform: NodeJS.Platform = process.platform): string {
  if (dep === 'bun') {
    return BUN_OFFICIAL_INSTALLER.command;
  }

  if (platform === 'darwin') {
    return 'brew install tmux';
  }

  return 'apt/dnf/pacman/apk install tmux';
}

export async function getInstallHintAsync(
  dep: DepName,
  platform: NodeJS.Platform = process.platform,
  detectLinuxDistro: () => Promise<LinuxDistroInfo | null> = detectLinuxDistroDefault
): Promise<string> {
  if (dep === 'bun') {
    if (platform === 'linux') {
      const distro = await detectLinuxDistro();
      return formatHint(planBunInstall(platform, { distro }));
    }
    return BUN_OFFICIAL_INSTALLER.command;
  }

  if (platform === 'darwin') {
    return 'brew install tmux';
  }

  if (platform === 'linux') {
    const distro = await detectLinuxDistro();
    const cmd = TMUX_INSTALL_COMMANDS[detectPackageManager(distro, platform)];
    if (cmd) {
      return formatHint([cmd]);
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

export function isRoot(): boolean {
  return isRootUid(process.getuid?.());
}

async function runInstallCommands(
  dep: DepName,
  commands: InstallCommand[],
  uid: number | undefined,
  deps: DependencyInstallRunnerDeps
): Promise<boolean> {
  for (const command of commands) {
    const fullCommand = resolveInstallCommand(command, uid);
    if (!(await runInstallCommand(dep, fullCommand, deps))) {
      return false;
    }
  }
  return true;
}

export async function executeDependencyInstall(
  plan: DepInstallPlan,
  options: { nonInteractive: boolean; autoConfirm: boolean },
  deps: DependencyInstallRunnerDeps = {}
): Promise<boolean> {
  const resolved = await resolveInstallPlan(plan, options, deps);
  if (!resolved.ok) return false;
  if (!(await confirmInstall(plan, options, deps))) return false;
  const uid = deps.uid ?? process.getuid?.();
  if (!(await runInstallCommands(plan.dep, plan.commands, uid, deps))) return false;
  return verifyInstalledDependency(plan.dep, deps);
}
