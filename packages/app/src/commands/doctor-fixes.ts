import {
  type DepInstallPlan,
  type InstallCommand,
  planBunInstall,
  planTmuxInstall,
} from '../lib/dep-install';
import { asBoolean } from '../lib/validate';
import type { DoctorCheck, ParsedArgs } from '../types';

export type DoctorFixerId = 'bun' | 'tmux';

export interface DoctorFixer {
  dep: DoctorFixerId;
  requiredVersion: string;
  createPlan: () => InstallCommand[] | Promise<InstallCommand[]>;
  classifyIssue: (check: DoctorCheck) => DepInstallPlan['issue'];
}

export type DoctorFixerRegistry = Record<DoctorFixerId, DoctorFixer>;

export function createDoctorFixers(plans?: {
  planBunInstall?: () => InstallCommand[];
  planTmuxInstall?: () => Promise<InstallCommand[]>;
}): DoctorFixerRegistry {
  const planBun = plans?.planBunInstall ?? planBunInstall;
  const planTmux = plans?.planTmuxInstall ?? planTmuxInstall;
  return {
    bun: {
      dep: 'bun',
      requiredVersion: '>= 1.3.0',
      createPlan: () => planBun(),
      classifyIssue: () => 'missing',
    },
    tmux: {
      dep: 'tmux',
      requiredVersion: '>= 3.0',
      createPlan: () => planTmux(),
      classifyIssue: (check) => (check.message.includes('version') ? 'version-too-low' : 'missing'),
    },
  };
}

export const DOCTOR_FIXERS = createDoctorFixers();

export function lookupDoctorFixer(
  id: string,
  registry: DoctorFixerRegistry = DOCTOR_FIXERS
): DoctorFixer | undefined {
  if (id === 'bun' || id === 'tmux') return registry[id];
  return undefined;
}

export async function executeDoctorFixer(
  fixer: DoctorFixer,
  check: DoctorCheck,
  parsed: ParsedArgs,
  execute: (
    plan: DepInstallPlan,
    options: { nonInteractive: boolean; autoConfirm: boolean }
  ) => Promise<boolean>
): Promise<void> {
  const commands = await fixer.createPlan();
  const plan: DepInstallPlan = {
    dep: fixer.dep,
    commands,
    requiredVersion: fixer.requiredVersion,
    issue: fixer.classifyIssue(check),
  };
  const nonInteractive = asBoolean(parsed.flags['no-interactive']) ?? false;
  await execute(plan, { nonInteractive, autoConfirm: nonInteractive });
}
