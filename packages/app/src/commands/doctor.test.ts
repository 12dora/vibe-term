import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { setLang, t } from '../i18n';
import type { DepInstallPlan } from '../lib/dep-install';
import type { DoctorCheck, ParsedArgs } from '../types';
import { type RunDoctorDeps, runDoctor } from './doctor';
import { DOCTOR_FIXERS } from './doctor-fixes';

function parsed(flags: ParsedArgs['flags'] = {}): ParsedArgs {
  return { command: 'doctor', positionals: [], flags };
}

function check(partial: DoctorCheck): DoctorCheck {
  return partial;
}

function bunFail(): DoctorCheck {
  return check({
    id: 'bun',
    level: 'fail',
    message: t('doctor.bun.fail', { reason: 'not found' }),
    fixable: true,
  });
}

function bunPass(): DoctorCheck {
  return check({
    id: 'bun',
    level: 'pass',
    message: t('doctor.bun.ok', { version: '1.3.0' }),
  });
}

function tmuxVersionLow(): DoctorCheck {
  return check({
    id: 'tmux',
    level: 'fail',
    message: t('doctor.tmux.versionLow', { version: '2.9' }),
    fixable: true,
  });
}

function tmuxMissing(): DoctorCheck {
  return check({
    id: 'tmux',
    level: 'fail',
    message: t('doctor.tmux.fail'),
    fixable: true,
  });
}

async function runWith(
  flags: ParsedArgs['flags'],
  checksSeries: DoctorCheck[][],
  extras: Partial<RunDoctorDeps> = {}
): Promise<{
  rendered: Array<{ checks: DoctorCheck[]; json: boolean }>;
  plans: DepInstallPlan[];
  logs: string[];
  collectFlags: Array<ParsedArgs['flags']>;
}> {
  const rendered: Array<{ checks: DoctorCheck[]; json: boolean }> = [];
  const plans: DepInstallPlan[] = [];
  const logs: string[] = [];
  const collectFlags: Array<ParsedArgs['flags']> = [];
  let collectIndex = 0;
  const log = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  try {
    await runDoctor(parsed(flags), {
      collectChecks: async (input) => {
        collectFlags.push(input.flags);
        const next = checksSeries[Math.min(collectIndex, checksSeries.length - 1)] ?? [];
        collectIndex += 1;
        return next;
      },
      renderDoctorResult: (checks, json) => {
        rendered.push({ checks, json });
      },
      executeDependencyInstall: async (plan) => {
        plans.push(plan);
        return true;
      },
      planBunInstall: () => [
        {
          label: 'test-bun',
          command: 'echo bun',
          requiresSudo: false,
          packageManager: 'test',
        },
      ],
      planTmuxInstall: async () => [
        {
          label: 'test-tmux',
          command: 'echo tmux',
          requiresSudo: false,
          packageManager: 'test',
        },
      ],
      ...extras,
    });
  } finally {
    console.log = log;
  }
  return { rendered, plans, logs, collectFlags };
}

const previousExitCode = process.exitCode;

beforeEach(() => {
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = previousExitCode ?? 0;
});

describe('runDoctor', () => {
  test('no issues: renders checks, does not hint or repair, does not set exit code 1', async () => {
    const { rendered, plans, logs } = await runWith({}, [
      [bunPass(), check({ id: 'platform', level: 'pass', message: 'ok' })],
    ]);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.checks.map((c) => c.id)).toEqual(['bun', 'platform']);
    expect(plans).toEqual([]);
    expect(logs.some((line) => line.includes(t('doctor.fix.hint')))).toBe(false);
    expect(logs.some((line) => line.includes(t('doctor.fix.header')))).toBe(false);
    expect(process.exitCode).toBe(0);
  });

  test('fixable issue is repaired then doctor reruns with fix disabled', async () => {
    const { rendered, plans, logs, collectFlags } = await runWith({ fix: true }, [
      [bunFail()],
      [bunPass()],
    ]);
    expect(logs.some((line) => line.includes(t('doctor.fix.header')))).toBe(true);
    expect(plans).toEqual([
      {
        dep: 'bun',
        commands: [
          {
            label: 'test-bun',
            command: 'echo bun',
            requiresSudo: false,
            packageManager: 'test',
          },
        ],
        requiredVersion: '>= 1.3.0',
        issue: 'missing',
      },
    ]);
    expect(collectFlags).toEqual([{ fix: true }, { fix: false }]);
    expect(rendered).toHaveLength(2);
    expect(rendered[1]?.checks).toEqual([bunPass()]);
    expect(process.exitCode).toBe(0);
  });

  test('unfixable fail sets exit code 1 and does not repair', async () => {
    const { plans, logs } = await runWith({ fix: true }, [
      [
        check({
          id: 'env.TMEX_MASTER_KEY',
          level: 'fail',
          message: 'missing key',
        }),
      ],
    ]);
    expect(plans).toEqual([]);
    expect(logs.some((line) => line.includes(t('doctor.fix.header')))).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  test('fixable non-registry id is skipped then rerun still runs', async () => {
    const { plans, logs, collectFlags } = await runWith({ fix: true }, [
      [
        check({
          id: 'custom-dep',
          level: 'fail',
          message: 'cannot auto-install',
          fixable: true,
        }),
      ],
      [
        check({
          id: 'custom-dep',
          level: 'fail',
          message: 'cannot auto-install',
          fixable: true,
        }),
      ],
    ]);
    expect(plans).toEqual([]);
    expect(logs.some((line) => line.includes(t('doctor.fix.skip', { id: 'custom-dep' })))).toBe(
      true
    );
    expect(collectFlags).toEqual([{ fix: true }, { fix: false }]);
    expect(process.exitCode).toBe(1);
  });

  test('tmux message containing "version" is classified version-too-low', async () => {
    const { plans } = await runWith({ fix: true }, [[tmuxVersionLow()], [tmuxVersionLow()]]);
    expect(plans[0]?.dep).toBe('tmux');
    expect(plans[0]?.requiredVersion).toBe('>= 3.0');
    expect(plans[0]?.issue).toBe('version-too-low');
  });

  test('tmux missing message is classified missing', async () => {
    const { plans } = await runWith({ fix: true }, [[tmuxMissing()], [tmuxMissing()]]);
    expect(plans[0]?.issue).toBe('missing');
  });

  test('without --fix, fixable failures print a hint and set exit code 1', async () => {
    const { plans, logs } = await runWith({}, [[bunFail()]]);
    expect(plans).toEqual([]);
    expect(logs.some((line) => line.includes(t('doctor.fix.hint')))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  test('json mode suppresses the fix hint', async () => {
    const { logs, rendered } = await runWith({ json: true }, [[bunFail()]]);
    expect(rendered[0]?.json).toBe(true);
    expect(logs.some((line) => line.includes(t('doctor.fix.hint')))).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  test('passes no-interactive through to the installer', async () => {
    const options: Array<{ nonInteractive: boolean; autoConfirm: boolean }> = [];
    await runWith({ fix: true, 'no-interactive': true }, [[bunFail()], [bunPass()]], {
      executeDependencyInstall: async (_plan, opts) => {
        options.push(opts);
        return true;
      },
    });
    expect(options).toEqual([{ nonInteractive: true, autoConfirm: true }]);
  });
});

describe('DOCTOR_FIXERS classification', () => {
  afterEach(() => {
    setLang('en');
  });

  test('bun is always missing even if the message mentions version', () => {
    expect(
      DOCTOR_FIXERS.bun.classifyIssue({
        id: 'bun',
        level: 'fail',
        message: 'installed version is too old',
        fixable: true,
      })
    ).toBe('missing');
  });

  test('tmux classifies by whether the localized message contains "version"', () => {
    expect(DOCTOR_FIXERS.tmux.classifyIssue(tmuxVersionLow())).toBe('version-too-low');
    expect(DOCTOR_FIXERS.tmux.classifyIssue(tmuxMissing())).toBe('missing');
  });

  test('zh-CN tmux version-low message does not contain English "version"', () => {
    setLang('zh-CN');
    const message = t('doctor.tmux.versionLow', { version: '2.9' });
    expect(message.includes('version')).toBe(false);
    expect(
      DOCTOR_FIXERS.tmux.classifyIssue({
        id: 'tmux',
        level: 'fail',
        message,
        fixable: true,
      })
    ).toBe('missing');
  });
});
