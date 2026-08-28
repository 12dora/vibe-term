import { describe, expect, test } from 'bun:test';
import type { DoctorCheck } from '../types';
import {
  DOCTOR_CHECK_TABLE,
  type DoctorReporter,
  buildDepFixPlan,
  doctorRunDecision,
  filterFixableFailures,
  isInstallableDep,
  planDoctorFix,
  reportDoctorRun,
  runCheckTable,
  shouldPrintFixHint,
} from './doctor';

const failFixable = (id: string, message = 'missing'): DoctorCheck => ({
  id,
  level: 'fail',
  message,
  fixable: true,
});

const failUnfixable: DoctorCheck = { id: 'env', level: 'fail', message: 'broken' };
const warnCheck: DoctorCheck = { id: 'ssh', level: 'warn', message: 'missing' };
const passCheck: DoctorCheck = { id: 'bun', level: 'pass', message: 'ok' };

function recordingReporter(): DoctorReporter & {
  renders: Array<{ checks: DoctorCheck[]; json: boolean }>;
  lines: string[];
  exitCodes: number[];
} {
  const renders: Array<{ checks: DoctorCheck[]; json: boolean }> = [];
  const lines: string[] = [];
  const exitCodes: number[] = [];
  return {
    renders,
    lines,
    exitCodes,
    render(checks, json) {
      renders.push({ checks, json });
    },
    log(line) {
      lines.push(line);
    },
    setExitCode(code) {
      exitCodes.push(code);
    },
  };
}

describe('DOCTOR_CHECK_TABLE', () => {
  test('runs platform, dependencies, install, service, then health', () => {
    expect(DOCTOR_CHECK_TABLE.map((step) => step.id)).toEqual([
      'platform',
      'dependencies',
      'install',
      'service',
      'health',
    ]);
  });
});

describe('runCheckTable', () => {
  test('concatenates table results in descriptor order', async () => {
    const checks = await runCheckTable({ token: 'ctx' }, [
      {
        id: 'a',
        collect: async (ctx) => {
          expect(ctx.token).toBe('ctx');
          return [passCheck];
        },
      },
      { id: 'b', collect: async () => [warnCheck, failUnfixable] },
    ]);
    expect(checks).toEqual([passCheck, warnCheck, failUnfixable]);
  });
});

describe('filterFixableFailures', () => {
  test('keeps only failed checks marked fixable', () => {
    expect(
      filterFixableFailures([passCheck, warnCheck, failUnfixable, failFixable('bun')])
    ).toEqual([failFixable('bun')]);
  });
});

describe('isInstallableDep', () => {
  test('accepts bun and tmux only', () => {
    expect(isInstallableDep('bun')).toBe(true);
    expect(isInstallableDep('tmux')).toBe(true);
    expect(isInstallableDep('ssh')).toBe(false);
    expect(isInstallableDep('env')).toBe(false);
  });
});

describe('buildDepFixPlan', () => {
  const commands = [{ label: 'x', command: 'echo', requiresSudo: false, packageManager: 'none' }];

  test('builds a bun missing plan', () => {
    expect(buildDepFixPlan('bun', failFixable('bun'), commands)).toEqual({
      dep: 'bun',
      commands,
      requiredVersion: '>= 1.3.0',
      issue: 'missing',
    });
  });

  test('marks tmux version-too-low when the message mentions version', () => {
    expect(
      buildDepFixPlan('tmux', failFixable('tmux', 'tmux version too low: 2.9'), commands)
    ).toEqual({
      dep: 'tmux',
      commands,
      requiredVersion: '>= 3.0',
      issue: 'version-too-low',
    });
  });

  test('marks tmux missing when the message does not mention version', () => {
    expect(buildDepFixPlan('tmux', failFixable('tmux', 'tmux not found'), commands)).toEqual({
      dep: 'tmux',
      commands,
      requiredVersion: '>= 3.0',
      issue: 'missing',
    });
  });
});

describe('planDoctorFix', () => {
  test('skips ids that are not bun or tmux', async () => {
    expect(await planDoctorFix(failFixable('ssh'))).toEqual({ kind: 'skip', id: 'ssh' });
  });

  test('uses injected planners for bun and tmux', async () => {
    const bunCommands = [
      { label: 'bun', command: 'install-bun', requiresSudo: false, packageManager: 'curl' },
    ];
    const tmuxCommands = [
      { label: 'tmux', command: 'install-tmux', requiresSudo: false, packageManager: 'brew' },
    ];
    const planners = {
      bun: () => bunCommands,
      tmux: async () => tmuxCommands,
    };
    expect(await planDoctorFix(failFixable('bun'), planners)).toEqual({
      kind: 'install',
      plan: {
        dep: 'bun',
        commands: bunCommands,
        requiredVersion: '>= 1.3.0',
        issue: 'missing',
      },
    });
    expect(await planDoctorFix(failFixable('tmux', 'tmux version 2.8'), planners)).toEqual({
      kind: 'install',
      plan: {
        dep: 'tmux',
        commands: tmuxCommands,
        requiredVersion: '>= 3.0',
        issue: 'version-too-low',
      },
    });
  });
});

describe('shouldPrintFixHint', () => {
  test('prints only when not fixing, not json, and there are fixable failures', () => {
    expect(shouldPrintFixHint(false, false, 1)).toBe(true);
    expect(shouldPrintFixHint(true, false, 1)).toBe(false);
    expect(shouldPrintFixHint(false, true, 1)).toBe(false);
    expect(shouldPrintFixHint(false, false, 0)).toBe(false);
  });
});

describe('doctorRunDecision', () => {
  test('returns fix without exit code when --fix can apply', () => {
    expect(doctorRunDecision([failFixable('bun')], { json: false, fix: true })).toEqual({
      action: 'fix',
    });
  });

  test('returns hint and exit 1 for fixable failures without --fix', () => {
    expect(doctorRunDecision([failFixable('bun')], { json: false, fix: false })).toEqual({
      action: 'hint',
      exitCode: 1,
    });
  });

  test('skips the hint in json mode but still exits 1', () => {
    expect(doctorRunDecision([failFixable('bun')], { json: true, fix: false })).toEqual({
      action: 'done',
      exitCode: 1,
    });
  });

  test('does not exit on warnings-only results', () => {
    expect(doctorRunDecision([warnCheck, passCheck], { json: false, fix: false })).toEqual({
      action: 'done',
    });
  });
});

describe('reportDoctorRun', () => {
  test('renders, hints, and sets exit code for fixable failures', () => {
    const reporter = recordingReporter();
    const checks = [failFixable('bun')];
    expect(reportDoctorRun(checks, { json: false, fix: false }, reporter)).toBe('done');
    expect(reporter.renders).toEqual([{ checks, json: false }]);
    expect(reporter.lines).toHaveLength(1);
    expect(reporter.exitCodes).toEqual([1]);
  });

  test('returns fix without hint or exit code so the caller can apply repairs', () => {
    const reporter = recordingReporter();
    const checks = [failFixable('tmux')];
    expect(reportDoctorRun(checks, { json: false, fix: true }, reporter)).toBe('fix');
    expect(reporter.renders).toEqual([{ checks, json: false }]);
    expect(reporter.lines).toEqual([]);
    expect(reporter.exitCodes).toEqual([]);
  });
});
