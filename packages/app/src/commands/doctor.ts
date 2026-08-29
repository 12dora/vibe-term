import { defaultInstallDir } from '../constants';
import { t } from '../i18n';
import { readExplicitBunPath } from '../lib/bun';
import { executeDependencyInstall, planBunInstall, planTmuxInstall } from '../lib/dep-install';
import { pathExists } from '../lib/fs-utils';
import { createInstallLayout, resolveInstallDir } from '../lib/install-layout';
import { readJsonFile } from '../lib/json-file';
import { asBoolean, asString } from '../lib/validate';
import type { DoctorCheck, InstallMeta, ParsedArgs } from '../types';
import {
  checkDependencies,
  checkEnvironment,
  checkHealth,
  checkService,
  renderDoctorResult,
} from './doctor-checks';
import {
  type DoctorFixerRegistry,
  createDoctorFixers,
  executeDoctorFixer,
  lookupDoctorFixer,
} from './doctor-fixes';

export interface RunDoctorDeps {
  collectChecks: (parsed: ParsedArgs) => Promise<DoctorCheck[]>;
  renderDoctorResult: (checks: DoctorCheck[], json: boolean) => void;
  executeDependencyInstall: typeof executeDependencyInstall;
  planBunInstall: typeof planBunInstall;
  planTmuxInstall: typeof planTmuxInstall;
  fixers: DoctorFixerRegistry;
}

async function collectDoctorChecks(parsed: ParsedArgs): Promise<DoctorCheck[]> {
  const installDirFlag = asString(parsed.flags['install-dir']);
  const installDir = resolveInstallDir(installDirFlag || defaultInstallDir(process.platform));
  const installLayout = createInstallLayout(installDir);

  const meta = (await pathExists(installLayout.metaPath))
    ? await readJsonFile<InstallMeta>(installLayout.metaPath).catch(() => null)
    : null;

  const environment = await checkEnvironment({
    installDir,
    envPath: installLayout.envPath,
  });
  const dependencies = await checkDependencies({
    explicitBunPath: readExplicitBunPath(parsed.flags),
    metaBunPath: meta?.bunPath,
  });
  const service = await checkService({
    serviceName: meta?.serviceName || asString(parsed.flags['service-name']) || 'tmex',
    installDir,
  });
  const health = await checkHealth(environment.healthHost, environment.healthPort);

  return [
    ...environment.platformChecks,
    ...dependencies,
    ...environment.installChecks,
    ...service,
    ...health,
  ];
}

function resolveDoctorDeps(deps: Partial<RunDoctorDeps>): RunDoctorDeps {
  const planBun = deps.planBunInstall ?? planBunInstall;
  const planTmux = deps.planTmuxInstall ?? planTmuxInstall;
  return {
    collectChecks: deps.collectChecks ?? collectDoctorChecks,
    renderDoctorResult: deps.renderDoctorResult ?? renderDoctorResult,
    executeDependencyInstall: deps.executeDependencyInstall ?? executeDependencyInstall,
    planBunInstall: planBun,
    planTmuxInstall: planTmux,
    fixers:
      deps.fixers ?? createDoctorFixers({ planBunInstall: planBun, planTmuxInstall: planTmux }),
  };
}

function isFixableFailure(check: DoctorCheck): boolean {
  return check.level === 'fail' && Boolean(check.fixable);
}

function hasFailingCheck(checks: DoctorCheck[]): boolean {
  return checks.some((check) => check.level === 'fail');
}

function shouldPrintFixHint(fix: boolean, json: boolean, hasFixable: boolean): boolean {
  return !fix && hasFixable && !json;
}

async function repairFixableFailures(
  fixableFailures: DoctorCheck[],
  parsed: ParsedArgs,
  resolved: RunDoctorDeps,
  deps: Partial<RunDoctorDeps>
): Promise<void> {
  console.log(`\n[tmex] ${t('doctor.fix.header')}`);
  for (const check of fixableFailures) {
    const fixer = lookupDoctorFixer(check.id, resolved.fixers);
    if (!fixer) {
      console.log(`[tmex] ${t('doctor.fix.skip', { id: check.id })}`);
      continue;
    }
    await executeDoctorFixer(fixer, check, parsed, resolved.executeDependencyInstall);
  }
  console.log('');
  await runDoctor({ ...parsed, flags: { ...parsed.flags, fix: false } }, deps);
}

export async function runDoctor(
  parsed: ParsedArgs,
  deps: Partial<RunDoctorDeps> = {}
): Promise<void> {
  const resolved = resolveDoctorDeps(deps);
  const json = asBoolean(parsed.flags.json) ?? false;
  const fix = asBoolean(parsed.flags.fix) ?? false;
  const checks = await resolved.collectChecks(parsed);
  resolved.renderDoctorResult(checks, json);

  const fixableFailures = checks.filter(isFixableFailure);
  if (fix && fixableFailures.length > 0) {
    await repairFixableFailures(fixableFailures, parsed, resolved, deps);
    return;
  }

  if (shouldPrintFixHint(fix, json, fixableFailures.length > 0)) {
    console.log(`\n[tmex] ${t('doctor.fix.hint')}`);
  }
  if (hasFailingCheck(checks)) {
    process.exitCode = 1;
  }
}
