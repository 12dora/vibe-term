import { defaultInstallDir } from '../constants';
import { t } from '../i18n';
import { readExplicitBunPath } from '../lib/bun';
import {
  type DepInstallPlan,
  executeDependencyInstall,
  planBunInstall,
  planTmuxInstall,
} from '../lib/dep-install';
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

export async function runDoctor(parsed: ParsedArgs): Promise<void> {
  const json = asBoolean(parsed.flags.json) ?? false;
  const fix = asBoolean(parsed.flags.fix) ?? false;
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

  const checks: DoctorCheck[] = [
    ...environment.platformChecks,
    ...dependencies,
    ...environment.installChecks,
    ...service,
    ...health,
  ];

  renderDoctorResult(checks, json);

  const fixableFailures = checks.filter((c) => c.level === 'fail' && c.fixable);

  if (fix && fixableFailures.length > 0) {
    console.log(`\n[tmex] ${t('doctor.fix.header')}`);

    for (const check of fixableFailures) {
      const dep = check.id as 'bun' | 'tmux';
      if (dep !== 'bun' && dep !== 'tmux') {
        console.log(`[tmex] ${t('doctor.fix.skip', { id: check.id })}`);
        continue;
      }

      const commands = dep === 'bun' ? planBunInstall() : await planTmuxInstall();
      const plan: DepInstallPlan = {
        dep,
        commands,
        requiredVersion: dep === 'tmux' ? '>= 3.0' : '>= 1.3.0',
        issue:
          check.id === 'tmux' && check.message.includes('version') ? 'version-too-low' : 'missing',
      };

      const nonInteractive = asBoolean(parsed.flags['no-interactive']) ?? false;
      await executeDependencyInstall(plan, {
        nonInteractive,
        autoConfirm: nonInteractive,
      });
    }

    console.log('');
    const rerunParsed = { ...parsed, flags: { ...parsed.flags, fix: false } };
    await runDoctor(rerunParsed);
    return;
  }

  if (!fix && fixableFailures.length > 0 && !json) {
    console.log(`\n[tmex] ${t('doctor.fix.hint')}`);
  }

  const failed = checks.some((check) => check.level === 'fail');
  if (failed) {
    process.exitCode = 1;
  }
}
