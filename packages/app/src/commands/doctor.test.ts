import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setLang, t } from '../i18n';
import { writeEnvFile } from '../lib/env-file';
import type { FetchLike } from '../lib/fetch-like';
import type { DoctorCheck } from '../types';
import {
  DOCTOR_CHECK_TABLE,
  type DoctorReporter,
  LOOP_WATCHDOG_LOG_NAME,
  LOOP_WATCHDOG_LOG_READ_CAP,
  type LoopWatchdogLogEntry,
  buildDepFixPlan,
  checkLoopWatchdogLog,
  doctorRunDecision,
  filterFixableFailures,
  isInstallableDep,
  parseLoopWatchdogLine,
  parseLoopWatchdogLogText,
  planDoctorFix,
  reportDoctorRun,
  runCheckTable,
  shouldPrintFixHint,
} from './doctor';
import {
  HEALTHZ_RETRY_DELAY_MS,
  checkEnvironment,
  checkHealth,
  classifyPasskeyOrigin,
  healthzUrl,
  isDomainOrigin,
  isHealthzTimeoutError,
  loopStallCheck,
  stunServersDoctorCheck,
} from './doctor-checks';

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

const doctorTempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    doctorTempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe('stunServersDoctorCheck', () => {
  test('classifies missing, custom, and disabled STUN env', () => {
    setLang('en');
    expect(stunServersDoctorCheck({}).message).toBe(t('doctor.stun.builtin'));
    expect(stunServersDoctorCheck({}).message).toContain('app.env not set');
    expect(stunServersDoctorCheck({ VIBETERM_STUN_SERVERS: '' }).message).toBe(
      t('doctor.stun.builtin')
    );
    expect(
      stunServersDoctorCheck({ VIBETERM_STUN_SERVERS: 'stun:custom.example:3478' }).message
    ).toBe(t('doctor.stun.custom'));
    expect(stunServersDoctorCheck({ VIBETERM_STUN_SERVERS: 'none' }).message).toBe(
      t('doctor.stun.disabled')
    );
    expect(stunServersDoctorCheck({ VIBETERM_STUN_SERVERS: 'off' }).id).toBe('stun');
    expect(stunServersDoctorCheck({ VIBETERM_STUN_SERVERS: 'off' }).level).toBe('pass');
  });

  test('checkEnvironment includes a STUN row derived from app.env', async () => {
    setLang('en');
    const installDir = await mkdtemp(join(tmpdir(), 'vibeterm-doctor-stun-'));
    doctorTempDirs.push(installDir);
    const envPath = join(installDir, 'app.env');
    await writeEnvFile(envPath, {
      VIBETERM_MASTER_KEY: 'k',
      DATABASE_URL: join(installDir, 'db'),
      GATEWAY_PORT: '9883',
      VIBETERM_BIND_HOST: '127.0.0.1',
      VIBETERM_PEER_PORT: '39991',
      VIBETERM_STUN_SERVERS: 'none',
    });
    const result = await checkEnvironment({ installDir, envPath });
    const stun = result.installChecks.find((check) => check.id === 'stun');
    expect(stun).toEqual({
      id: 'stun',
      level: 'pass',
      message: t('doctor.stun.disabled'),
    });
    const plan = result.installChecks.find((check) => check.id === 'ports.plan');
    expect(plan?.level).toBe('pass');
    expect(plan?.message).toContain('39991/tcp');
  });

  test('checkEnvironment includes a TURN row for relay roles', async () => {
    setLang('en');
    const installDir = await mkdtemp(join(tmpdir(), 'vibeterm-doctor-turn-'));
    doctorTempDirs.push(installDir);
    const envPath = join(installDir, 'app.env');
    await writeEnvFile(envPath, {
      VIBETERM_MASTER_KEY: 'k',
      DATABASE_URL: join(installDir, 'db'),
      GATEWAY_PORT: '9883',
      VIBETERM_BIND_HOST: '127.0.0.1',
      VIBETERM_ROLES: 'relay',
      VIBETERM_TURN_PORT: 'off',
      VIBETERM_RELAY_PUBLIC_URL: 'https://relay.example.com',
    });
    const result = await checkEnvironment({ installDir, envPath });
    const turn = result.installChecks.find((check) => check.id === 'turn');
    expect(turn?.level).toBe('pass');
    expect(turn?.message).toBe(t('doctor.turn.off'));
    expect(turn?.detail).toContain('UDP');
  });
});

describe('DOCTOR_CHECK_TABLE', () => {
  test('runs platform, dependencies, install, service, legacy-layout, health, loop-watchdog, passkey-origin', () => {
    expect(DOCTOR_CHECK_TABLE.map((step) => step.id)).toEqual([
      'platform',
      'dependencies',
      'install',
      'service',
      'legacy-layout',
      'health',
      'loop-watchdog',
      'passkey-origin',
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

describe('passkey origin check', () => {
  test('only domain origins are classifiable', () => {
    expect(isDomainOrigin('https://term.example.com')).toBe(true);
    expect(isDomainOrigin('http://localhost:9883')).toBe(false);
    expect(isDomainOrigin('http://127.0.0.1:9883')).toBe(false);
    expect(isDomainOrigin('http://[::1]:9883')).toBe(false);
    expect(isDomainOrigin('not-a-url')).toBe(false);
  });

  test('warns only when the domain has no passkey while others do', () => {
    const origin = 'https://term.example.com';
    expect(
      classifyPasskeyOrigin({
        origin,
        mode: { passkeysForThisOrigin: false, passkeysRegisteredElsewhere: true },
      })
    ).toHaveLength(1);

    expect(
      classifyPasskeyOrigin({
        origin,
        mode: { passkeysForThisOrigin: true, passkeysRegisteredElsewhere: false },
      })
    ).toEqual([]);
    expect(classifyPasskeyOrigin({ origin, mode: null })).toEqual([]);
    // 对外地址是回环时判断不出来，不产生噪音。
    expect(
      classifyPasskeyOrigin({
        origin: 'http://127.0.0.1:9883',
        mode: { passkeysRegisteredElsewhere: true },
      })
    ).toEqual([]);
  });

  test('the wording follows the two-step verification state', () => {
    const origin = 'https://term.example.com';
    for (const lang of ['en', 'zh-CN'] as const) {
      setLang(lang);
      const plain = classifyPasskeyOrigin({
        origin,
        mode: { passkeysRegisteredElsewhere: true, totpEnabled: false },
      })[0]?.message;
      const guarded = classifyPasskeyOrigin({
        origin,
        mode: { passkeysRegisteredElsewhere: true, totpEnabled: true },
      })[0]?.message;
      expect(plain).toBeTruthy();
      expect(guarded).toBeTruthy();
      expect(plain).not.toBe(guarded);
      expect(plain).toContain(origin);
      expect(guarded).toContain(origin);
      expect(guarded).toContain('vibeterm mesh passkey remove-all');
    }
    setLang('en');
    const plainEn = classifyPasskeyOrigin({
      origin,
      mode: { passkeysRegisteredElsewhere: true, totpEnabled: false },
    })[0]?.message;
    const guardedEn = classifyPasskeyOrigin({
      origin,
      mode: { passkeysRegisteredElsewhere: true, totpEnabled: true },
    })[0]?.message;
    expect(plainEn).toContain('password alone');
    expect(guardedEn).toContain('two-step verification');
  });
});

const STALL_URL = 'http://127.0.0.1:9883/healthz';
const STALL_INSTALL_DIR = '/opt/vibeterm';

const noSleep = async () => {};

function timeoutError(): DOMException {
  return new DOMException('The operation timed out.', 'TimeoutError');
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function refusedError(): Error {
  return Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), {
    code: 'ConnectionRefused',
  });
}

function failingFetch(): FetchLike {
  return async () => {
    throw new Error('unreachable');
  };
}

function okFetch(): FetchLike {
  return async () => new Response('ok', { status: 200 });
}

function sequenceFetch(results: Array<Response | Error>): FetchLike {
  let i = 0;
  return async () => {
    const next = results[i] ?? results[results.length - 1];
    i += 1;
    if (next instanceof Error) throw next;
    return next;
  };
}

describe('isHealthzTimeoutError', () => {
  test('matches Bun AbortSignal.timeout TimeoutError and AbortError, not refused', () => {
    expect(isHealthzTimeoutError(timeoutError())).toBe(true);
    expect(isHealthzTimeoutError(abortError())).toBe(true);
    expect(isHealthzTimeoutError(refusedError())).toBe(false);
    expect(isHealthzTimeoutError(Object.assign(new Error('dns'), { code: 'ENOTFOUND' }))).toBe(
      false
    );
    expect(isHealthzTimeoutError(new Error('unreachable'))).toBe(false);
  });
});

describe('loopStallCheck', () => {
  test('running+healthy does not emit a stall', () => {
    expect(
      loopStallCheck({
        serviceRunning: true,
        timedOut: false,
        url: STALL_URL,
        installDir: STALL_INSTALL_DIR,
      })
    ).toEqual([]);
  });

  test('running+timedOut emits a fail loop-stall item', () => {
    const checks = loopStallCheck({
      serviceRunning: true,
      timedOut: true,
      url: STALL_URL,
      installDir: STALL_INSTALL_DIR,
    });
    expect(checks).toEqual([
      {
        id: 'loop-stall',
        level: 'fail',
        message: t('doctor.health.loopStall', { url: STALL_URL, installDir: STALL_INSTALL_DIR }),
      },
    ]);
    expect(checks[0]?.message).toContain(STALL_URL);
    expect(checks[0]?.message).toContain(`${STALL_INSTALL_DIR}/loop-watchdog.log`);
  });

  test('running+not-timed-out does not emit a stall (boot window / refused)', () => {
    expect(
      loopStallCheck({
        serviceRunning: true,
        timedOut: false,
        url: STALL_URL,
        installDir: STALL_INSTALL_DIR,
      })
    ).toEqual([]);
  });

  test('stopped+timedOut does not emit a stall (health stays warn)', () => {
    expect(
      loopStallCheck({
        serviceRunning: false,
        timedOut: true,
        url: STALL_URL,
        installDir: STALL_INSTALL_DIR,
      })
    ).toEqual([]);
  });

  test('stopped+healthy does not emit a stall', () => {
    expect(
      loopStallCheck({
        serviceRunning: false,
        timedOut: false,
        url: STALL_URL,
        installDir: STALL_INSTALL_DIR,
      })
    ).toEqual([]);
  });
});

describe('checkHealth correlation and retry', () => {
  test('running+healthy is pass without loop-stall', async () => {
    const checks = await checkHealth('127.0.0.1', '1', {
      fetchImpl: okFetch(),
      serviceRunning: true,
      installDir: STALL_INSTALL_DIR,
      sleep: noSleep,
    });
    expect(checks.find((check) => check.id === 'healthz')).toMatchObject({
      id: 'healthz',
      level: 'pass',
    });
    expect(checks.some((check) => check.id === 'loop-stall')).toBe(false);
  });

  test('timeout-both while running emits healthz warn and loop-stall fail; doctor exits 1', async () => {
    const checks = await checkHealth('127.0.0.1', '9883', {
      fetchImpl: sequenceFetch([timeoutError(), timeoutError()]),
      serviceRunning: true,
      installDir: STALL_INSTALL_DIR,
      sleep: noSleep,
    });
    expect(checks.map((check) => ({ id: check.id, level: check.level }))).toEqual([
      { id: 'healthz', level: 'warn' },
      { id: 'loop-stall', level: 'fail' },
    ]);
    expect(checks[0]?.message).toBe(
      t('doctor.health.fail', { url: healthzUrl('127.0.0.1', '9883') })
    );
    expect(doctorRunDecision(checks, { json: false, fix: false })).toEqual({
      action: 'done',
      exitCode: 1,
    });
    const reporter = recordingReporter();
    expect(reportDoctorRun(checks, { json: false, fix: false }, reporter)).toBe('done');
    expect(reporter.exitCodes).toEqual([1]);
  });

  test('refused-both while running keeps healthz warn without loop-stall', async () => {
    const checks = await checkHealth('127.0.0.1', '9883', {
      fetchImpl: sequenceFetch([refusedError(), refusedError()]),
      serviceRunning: true,
      installDir: STALL_INSTALL_DIR,
      sleep: noSleep,
    });
    expect(checks.map((check) => ({ id: check.id, level: check.level }))).toEqual([
      { id: 'healthz', level: 'warn' },
    ]);
    expect(doctorRunDecision(checks, { json: false, fix: false })).toEqual({ action: 'done' });
  });

  test('timeout then 200 is pass without loop-stall', async () => {
    let attempts = 0;
    const fetchImpl: FetchLike = async () => {
      attempts += 1;
      if (attempts === 1) throw timeoutError();
      return new Response('ok', { status: 200 });
    };
    const checks = await checkHealth('127.0.0.1', '1', {
      fetchImpl,
      serviceRunning: true,
      installDir: STALL_INSTALL_DIR,
      sleep: noSleep,
    });
    expect(attempts).toBe(2);
    expect(checks.find((check) => check.id === 'healthz')?.level).toBe('pass');
    expect(checks.some((check) => check.id === 'loop-stall')).toBe(false);
  });

  test('refused then timeout is warn only (not both timeouts)', async () => {
    const checks = await checkHealth('127.0.0.1', '9883', {
      fetchImpl: sequenceFetch([refusedError(), timeoutError()]),
      serviceRunning: true,
      installDir: STALL_INSTALL_DIR,
      sleep: noSleep,
    });
    expect(checks.map((check) => ({ id: check.id, level: check.level }))).toEqual([
      { id: 'healthz', level: 'warn' },
    ]);
    expect(doctorRunDecision(checks, { json: false, fix: false })).toEqual({ action: 'done' });
  });

  test('running+generic-throw is healthz warn without loop-stall', async () => {
    const checks = await checkHealth('127.0.0.1', '9883', {
      fetchImpl: failingFetch(),
      serviceRunning: true,
      installDir: STALL_INSTALL_DIR,
      sleep: noSleep,
    });
    expect(checks.map((check) => ({ id: check.id, level: check.level }))).toEqual([
      { id: 'healthz', level: 'warn' },
    ]);
  });

  test('HTTP non-2xx both attempts is healthz warn without loop-stall', async () => {
    const checks = await checkHealth('127.0.0.1', '9883', {
      fetchImpl: async () => new Response('no', { status: 503 }),
      serviceRunning: true,
      installDir: STALL_INSTALL_DIR,
      sleep: noSleep,
    });
    expect(checks.map((check) => ({ id: check.id, level: check.level }))).toEqual([
      { id: 'healthz', level: 'warn' },
    ]);
  });

  test('stopped+unreachable keeps healthz as warn without loop-stall', async () => {
    const checks = await checkHealth('127.0.0.1', '9883', {
      fetchImpl: failingFetch(),
      serviceRunning: false,
      installDir: STALL_INSTALL_DIR,
      sleep: noSleep,
    });
    expect(checks).toEqual([
      {
        id: 'healthz',
        level: 'warn',
        message: t('doctor.health.fail', { url: healthzUrl('127.0.0.1', '9883') }),
      },
    ]);
    expect(doctorRunDecision(checks, { json: false, fix: false })).toEqual({ action: 'done' });
  });

  test('stopped+healthy is pass without loop-stall', async () => {
    const checks = await checkHealth('127.0.0.1', '1', {
      fetchImpl: okFetch(),
      serviceRunning: false,
      installDir: STALL_INSTALL_DIR,
      sleep: noSleep,
    });
    expect(checks.find((check) => check.id === 'healthz')?.level).toBe('pass');
    expect(checks.some((check) => check.id === 'loop-stall')).toBe(false);
  });

  test('retries healthz once after the first failure then passes', async () => {
    let attempts = 0;
    const fetchImpl: FetchLike = async () => {
      attempts += 1;
      if (attempts === 1) return new Response('no', { status: 503 });
      return new Response('ok', { status: 200 });
    };
    const checks = await checkHealth('127.0.0.1', '1', { fetchImpl, sleep: noSleep });
    expect(attempts).toBe(2);
    expect(checks[0]).toMatchObject({ id: 'healthz', level: 'pass' });
  });

  test('declares unreachable after two failed attempts', async () => {
    let attempts = 0;
    const fetchImpl: FetchLike = async () => {
      attempts += 1;
      throw new Error('timeout');
    };
    const checks = await checkHealth('127.0.0.1', '9883', {
      fetchImpl,
      serviceRunning: false,
      sleep: noSleep,
    });
    expect(attempts).toBe(2);
    expect(checks).toEqual([
      {
        id: 'healthz',
        level: 'warn',
        message: t('doctor.health.fail', { url: healthzUrl('127.0.0.1', '9883') }),
      },
    ]);
  });

  test('sleeps 1s between the two probe attempts', async () => {
    const slept: number[] = [];
    await checkHealth('127.0.0.1', '9883', {
      fetchImpl: sequenceFetch([timeoutError(), timeoutError()]),
      serviceRunning: true,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(slept).toEqual([HEALTHZ_RETRY_DELAY_MS]);
  });
});

function watchdogEntry(over: Partial<LoopWatchdogLogEntry> = {}): LoopWatchdogLogEntry {
  return {
    ts: '2026-09-15T12:00:00.000Z',
    pid: 42,
    version: '2.4.2',
    phase: 'running',
    stalledSec: 31,
    thresholdSec: 30,
    signal: 'SIGABRT',
    rssBytes: 123456,
    uptimeSec: 3600,
    ...over,
  };
}

function watchdogLine(over: Partial<LoopWatchdogLogEntry> = {}): string {
  return JSON.stringify(watchdogEntry(over));
}

describe('loop-watchdog log', () => {
  test('parseLoopWatchdogLogText returns no entries for 0 lines', () => {
    expect(parseLoopWatchdogLogText('')).toEqual([]);
    expect(parseLoopWatchdogLogText('\n\n')).toEqual([]);
    expect(parseLoopWatchdogLine('not json')).toBeNull();
    expect(parseLoopWatchdogLine('{"ts":"x"}')).toBeNull();
  });

  test('parses 3 lines with one malformed and uses last valid fields', () => {
    const first = watchdogLine({ ts: '2026-09-15T10:00:00.000Z', pid: 1, stalledSec: 40 });
    const last = watchdogLine({
      ts: '2026-09-15T12:00:00.000Z',
      pid: 99,
      version: '2.6.1',
      phase: 'boot',
      stalledSec: 181,
      thresholdSec: 180,
      signal: 'SIGKILL',
      rssBytes: 999,
      uptimeSec: 12,
    });
    const entries = parseLoopWatchdogLogText(`${first}\nnot-json\n${last}\n`);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toEqual({
      ts: '2026-09-15T12:00:00.000Z',
      pid: 99,
      version: '2.6.1',
      phase: 'boot',
      stalledSec: 181,
      thresholdSec: 180,
      signal: 'SIGKILL',
      rssBytes: 999,
      uptimeSec: 12,
    });
  });

  test('optional staleTicks is kept; unknown or invalid extra fields are ignored', () => {
    const withTicks = { ...watchdogEntry(), staleTicks: 30, extra: 'ignore-me' };
    expect(parseLoopWatchdogLine(JSON.stringify(withTicks))).toEqual({
      ...watchdogEntry(),
      staleTicks: 30,
    });
    expect(
      parseLoopWatchdogLine(JSON.stringify({ ...watchdogEntry(), staleTicks: 'nope' }))
    ).toEqual(watchdogEntry());
    expect(parseLoopWatchdogLine(JSON.stringify(watchdogEntry()))?.staleTicks).toBeUndefined();
  });

  test('missing log file is silent', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'vibeterm-doctor-wd-missing-'));
    doctorTempDirs.push(installDir);
    expect(await checkLoopWatchdogLog(installDir)).toEqual([]);
  });

  test('empty or all-malformed log is silent', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'vibeterm-doctor-wd-empty-'));
    doctorTempDirs.push(installDir);
    await writeFile(join(installDir, LOOP_WATCHDOG_LOG_NAME), '');
    expect(await checkLoopWatchdogLog(installDir)).toEqual([]);
    await writeFile(join(installDir, LOOP_WATCHDOG_LOG_NAME), 'nope\n{bad}\n');
    expect(await checkLoopWatchdogLog(installDir)).toEqual([]);
  });

  test('warns with the valid line count and last-line fields', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'vibeterm-doctor-wd-log-'));
    doctorTempDirs.push(installDir);
    const last = watchdogEntry({
      ts: '2026-09-15T13:00:00.000Z',
      version: '2.4.2',
      phase: 'running',
      stalledSec: 45,
    });
    await writeFile(
      join(installDir, LOOP_WATCHDOG_LOG_NAME),
      `${watchdogLine({ ts: '2026-09-15T11:00:00.000Z' })}\nbroken\n${JSON.stringify(last)}\n`
    );
    const checks = await checkLoopWatchdogLog(installDir);
    expect(checks).toEqual([
      {
        id: 'loop-watchdog',
        level: 'warn',
        message: t('doctor.loopWatchdog.killed', {
          count: 2,
          ts: last.ts,
          stalledSec: last.stalledSec,
          phase: last.phase,
          version: last.version,
        }),
      },
    ]);
  });

  test('reads only the last 64 KiB so older lines outside the window are dropped', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'vibeterm-doctor-wd-cap-'));
    doctorTempDirs.push(installDir);
    const old = watchdogLine({ ts: 'old', pid: 1 });
    const recent = watchdogLine({ ts: 'new', pid: 2, version: '2.6.1', stalledSec: 50 });
    const padding = 'x'.repeat(LOOP_WATCHDOG_LOG_READ_CAP);
    await writeFile(join(installDir, LOOP_WATCHDOG_LOG_NAME), `${old}\n${padding}\n${recent}\n`);
    const checks = await checkLoopWatchdogLog(installDir);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.message).toContain('at least 1 kill');
    expect(checks[0]?.message).toContain('64 KiB');
    expect(checks[0]?.message).toContain('last at new');
    expect(checks[0]?.message).toContain('stalled 50s');
    expect(checks[0]?.message).not.toContain('last at old');
  });

  test('read error is silent', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'vibeterm-doctor-wd-eisdir-'));
    doctorTempDirs.push(installDir);
    await mkdir(join(installDir, LOOP_WATCHDOG_LOG_NAME));
    expect(await checkLoopWatchdogLog(installDir)).toEqual([]);
  });

  test('zh-CN stall and watchdog messages avoid 你/您', () => {
    setLang('zh-CN');
    const stall = t('doctor.health.loopStall', { url: STALL_URL, installDir: STALL_INSTALL_DIR });
    const killed = t('doctor.loopWatchdog.killed', {
      count: 2,
      ts: '2026-09-15T12:00:00.000Z',
      stalledSec: 31,
      phase: 'running',
      version: '2.4.2',
    });
    expect(stall).not.toBe('doctor.health.loopStall');
    expect(killed).not.toBe('doctor.loopWatchdog.killed');
    expect(stall).not.toContain('你');
    expect(stall).not.toContain('您');
    expect(killed).not.toContain('你');
    expect(killed).not.toContain('您');
    setLang('en');
  });
});
