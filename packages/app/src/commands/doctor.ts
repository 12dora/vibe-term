import { defaultInstallDir } from '../constants';
import { t } from '../i18n';
import { readExplicitBunPath } from '../lib/bun';
import {
  type DepInstallPlan,
  type InstallCommand,
  executeDependencyInstall,
  planBunInstall,
  planTmuxInstall,
} from '../lib/dep-install';
import { pathExists } from '../lib/fs-utils';
import { type InstallLayout, createInstallLayout, resolveInstallDir } from '../lib/install-layout';
import { readJsonFile } from '../lib/json-file';
import { asBoolean, asString } from '../lib/validate';
import type { DoctorCheck, InstallMeta, ParsedArgs } from '../types';
import {
  type DoctorEnvironmentResult,
  checkDependencies,
  checkEnvironment,
  checkHealth,
  checkService,
  renderDoctorResult,
} from './doctor-checks';

const DEP_FIX_REQUIRED_VERSION = {
  bun: '>= 1.3.0',
  tmux: '>= 3.0',
} as const;

export interface DoctorRunContext {
  parsed: ParsedArgs;
  json: boolean;
  fix: boolean;
  installDir: string;
  installLayout: InstallLayout;
  meta: InstallMeta | null;
  environment?: DoctorEnvironmentResult;
}

export interface DoctorCheckStep<T = DoctorRunContext> {
  id: string;
  collect: (ctx: T) => Promise<DoctorCheck[]>;
}

export interface DoctorReporter {
  render: (checks: DoctorCheck[], json: boolean) => void;
  log: (line: string) => void;
  setExitCode: (code: number) => void;
}

export interface DoctorFixPlanners {
  bun: () => InstallCommand[];
  tmux: () => Promise<InstallCommand[]>;
}

export type DoctorFixPlan =
  | { kind: 'skip'; id: string }
  | { kind: 'install'; plan: DepInstallPlan };

export type DoctorRunAction = 'fix' | 'hint' | 'done';

const defaultDoctorReporter: DoctorReporter = {
  render: renderDoctorResult,
  log: (line) => {
    console.log(line);
  },
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

const defaultFixPlanners: DoctorFixPlanners = {
  bun: planBunInstall,
  tmux: planTmuxInstall,
};

async function ensureEnvironment(ctx: DoctorRunContext): Promise<DoctorEnvironmentResult> {
  if (!ctx.environment) {
    ctx.environment = await checkEnvironment({
      installDir: ctx.installDir,
      envPath: ctx.installLayout.envPath,
    });
  }
  return ctx.environment;
}

export const DOCTOR_CHECK_TABLE: DoctorCheckStep[] = [
  {
    id: 'platform',
    collect: async (ctx) => (await ensureEnvironment(ctx)).platformChecks,
  },
  {
    id: 'dependencies',
    collect: async (ctx) =>
      checkDependencies({
        explicitBunPath: readExplicitBunPath(ctx.parsed.flags),
        metaBunPath: ctx.meta?.bunPath,
      }),
  },
  {
    id: 'install',
    collect: async (ctx) => (await ensureEnvironment(ctx)).installChecks,
  },
  {
    id: 'service',
    collect: async (ctx) =>
      checkService({
        serviceName: ctx.meta?.serviceName || asString(ctx.parsed.flags['service-name']) || 'tmex',
        installDir: ctx.installDir,
      }),
  },
  {
    id: 'health',
    collect: async (ctx) => {
      const env = await ensureEnvironment(ctx);
      return checkHealth(env.healthHost, env.healthPort);
    },
  },
];

export async function runCheckTable<T>(
  ctx: T,
  table: ReadonlyArray<DoctorCheckStep<T>>
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const step of table) {
    checks.push(...(await step.collect(ctx)));
  }
  return checks;
}

async function collectDoctorChecks(ctx: DoctorRunContext): Promise<DoctorCheck[]> {
  return runCheckTable(ctx, DOCTOR_CHECK_TABLE);
}

export function filterFixableFailures(checks: DoctorCheck[]): DoctorCheck[] {
  return checks.filter((check) => check.level === 'fail' && check.fixable);
}

export function isInstallableDep(id: string): id is 'bun' | 'tmux' {
  return id === 'bun' || id === 'tmux';
}

export function shouldPrintFixHint(fix: boolean, json: boolean, fixableCount: number): boolean {
  return !fix && fixableCount > 0 && !json;
}

export function buildDepFixPlan(
  dep: 'bun' | 'tmux',
  check: DoctorCheck,
  commands: InstallCommand[]
): DepInstallPlan {
  return {
    dep,
    commands,
    requiredVersion: DEP_FIX_REQUIRED_VERSION[dep],
    issue: dep === 'tmux' && check.message.includes('version') ? 'version-too-low' : 'missing',
  };
}

export async function planDoctorFix(
  check: DoctorCheck,
  planners: DoctorFixPlanners = defaultFixPlanners
): Promise<DoctorFixPlan> {
  if (!isInstallableDep(check.id)) {
    return { kind: 'skip', id: check.id };
  }
  const commands = check.id === 'bun' ? planners.bun() : await planners.tmux();
  return { kind: 'install', plan: buildDepFixPlan(check.id, check, commands) };
}

export function doctorRunDecision(
  checks: DoctorCheck[],
  options: { json: boolean; fix: boolean }
): { action: DoctorRunAction; exitCode?: number } {
  const fixableCount = filterFixableFailures(checks).length;
  if (options.fix && fixableCount > 0) {
    return { action: 'fix' };
  }
  const exitCode = checks.some((check) => check.level === 'fail') ? 1 : undefined;
  if (shouldPrintFixHint(options.fix, options.json, fixableCount)) {
    return { action: 'hint', exitCode };
  }
  return { action: 'done', exitCode };
}

export function reportDoctorRun(
  checks: DoctorCheck[],
  options: { json: boolean; fix: boolean },
  reporter: DoctorReporter = defaultDoctorReporter
): 'fix' | 'done' {
  reporter.render(checks, options.json);
  const decision = doctorRunDecision(checks, options);
  if (decision.action === 'hint') {
    reporter.log(`\n[tmex] ${t('doctor.fix.hint')}`);
  }
  if (decision.exitCode !== undefined) {
    reporter.setExitCode(decision.exitCode);
  }
  return decision.action === 'fix' ? 'fix' : 'done';
}

async function loadDoctorContext(parsed: ParsedArgs): Promise<DoctorRunContext> {
  const json = asBoolean(parsed.flags.json) ?? false;
  const fix = asBoolean(parsed.flags.fix) ?? false;
  const installDirFlag = asString(parsed.flags['install-dir']);
  const installDir = resolveInstallDir(installDirFlag || defaultInstallDir(process.platform));
  const installLayout = createInstallLayout(installDir);
  const meta = (await pathExists(installLayout.metaPath))
    ? await readJsonFile<InstallMeta>(installLayout.metaPath).catch(() => null)
    : null;
  return { parsed, json, fix, installDir, installLayout, meta };
}

async function applyOneDoctorFix(check: DoctorCheck, parsed: ParsedArgs): Promise<void> {
  const planned = await planDoctorFix(check);
  if (planned.kind === 'skip') {
    console.log(`[tmex] ${t('doctor.fix.skip', { id: planned.id })}`);
    return;
  }
  const nonInteractive = asBoolean(parsed.flags['no-interactive']) ?? false;
  await executeDependencyInstall(planned.plan, {
    nonInteractive,
    autoConfirm: nonInteractive,
  });
}

async function applyDoctorFixes(checks: DoctorCheck[], parsed: ParsedArgs): Promise<void> {
  console.log(`\n[tmex] ${t('doctor.fix.header')}`);
  for (const check of filterFixableFailures(checks)) {
    await applyOneDoctorFix(check, parsed);
  }
  console.log('');
}

export async function runDoctor(parsed: ParsedArgs): Promise<void> {
  const ctx = await loadDoctorContext(parsed);
  const checks = await collectDoctorChecks(ctx);
  if (reportDoctorRun(checks, { json: ctx.json, fix: ctx.fix }) !== 'fix') {
    return;
  }
  await applyDoctorFixes(checks, parsed);
  await runDoctor({ ...parsed, flags: { ...parsed.flags, fix: false } });
}
