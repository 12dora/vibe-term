import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_SERVICE_NAME, defaultInstallDir } from '../constants';
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
  checkLegacyLeftovers,
  checkPasskeyOrigins,
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
  serviceRunning?: boolean;
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

export const LOOP_WATCHDOG_LOG_NAME = 'loop-watchdog.log';
export const LOOP_WATCHDOG_LOG_READ_CAP = 64 * 1024;

export interface LoopWatchdogLogEntry {
  ts: string;
  pid: number;
  version: string;
  phase: string;
  stalledSec: number;
  thresholdSec: number;
  signal: string;
  rssBytes: number;
  uptimeSec: number;
  staleTicks?: number;
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function requiredNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function requiredTs(value: unknown): string | null {
  const text = requiredString(value);
  if (text) return text;
  const n = requiredNumber(value);
  return n === null ? null : String(n);
}

function pickLoopWatchdogEntry(o: Record<string, unknown>): LoopWatchdogLogEntry | null {
  const ts = requiredTs(o.ts);
  const version = requiredString(o.version);
  const phase = requiredString(o.phase);
  const signal = requiredString(o.signal);
  const pid = requiredNumber(o.pid);
  const stalledSec = requiredNumber(o.stalledSec);
  const thresholdSec = requiredNumber(o.thresholdSec);
  const rssBytes = requiredNumber(o.rssBytes);
  const uptimeSec = requiredNumber(o.uptimeSec);
  if (ts === null) return null;
  if (version === null) return null;
  if (phase === null) return null;
  if (signal === null) return null;
  if (pid === null) return null;
  if (stalledSec === null) return null;
  if (thresholdSec === null) return null;
  if (rssBytes === null) return null;
  if (uptimeSec === null) return null;
  const entry: LoopWatchdogLogEntry = {
    ts,
    pid,
    version,
    phase,
    stalledSec,
    thresholdSec,
    signal,
    rssBytes,
    uptimeSec,
  };
  const staleTicks = requiredNumber(o.staleTicks);
  if (staleTicks !== null) entry.staleTicks = staleTicks;
  return entry;
}

export function parseLoopWatchdogLine(line: string): LoopWatchdogLogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  return pickLoopWatchdogEntry(raw as Record<string, unknown>);
}

export function parseLoopWatchdogLogText(
  text: string,
  dropFirstLine = false
): LoopWatchdogLogEntry[] {
  const lines = text.split(/\r?\n/);
  if (dropFirstLine) lines.shift();
  const entries: LoopWatchdogLogEntry[] = [];
  for (const line of lines) {
    const entry = parseLoopWatchdogLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

async function readLoopWatchdogLog(logPath: string): Promise<LoopWatchdogLogEntry[]> {
  const st = await stat(logPath);
  const start = Math.max(0, st.size - LOOP_WATCHDOG_LOG_READ_CAP);
  const fh = await open(logPath, 'r');
  try {
    const buf = Buffer.alloc(st.size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    return parseLoopWatchdogLogText(buf.subarray(0, bytesRead).toString('utf8'), start > 0);
  } finally {
    await fh.close();
  }
}

export async function checkLoopWatchdogLog(installDir: string): Promise<DoctorCheck[]> {
  try {
    const logPath = join(installDir, LOOP_WATCHDOG_LOG_NAME);
    if (!(await pathExists(logPath))) return [];
    const entries = await readLoopWatchdogLog(logPath);
    if (entries.length === 0) return [];
    const last = entries[entries.length - 1];
    return [
      {
        id: 'loop-watchdog',
        level: 'warn',
        message: t('doctor.loopWatchdog.killed', {
          count: entries.length,
          ts: last.ts,
          stalledSec: last.stalledSec,
          phase: last.phase,
          version: last.version,
        }),
      },
    ];
  } catch {
    return [];
  }
}

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
    collect: async (ctx) => {
      const checks = await checkService({
        serviceName:
          ctx.meta?.serviceName ||
          asString(ctx.parsed.flags['service-name']) ||
          DEFAULT_SERVICE_NAME,
        installDir: ctx.installDir,
      });
      ctx.serviceRunning = checks.some((check) => check.id === 'service' && check.level === 'pass');
      return checks;
    },
  },
  {
    id: 'legacy-layout',
    collect: async (ctx) =>
      checkLegacyLeftovers({
        serviceName:
          ctx.meta?.serviceName ||
          asString(ctx.parsed.flags['service-name']) ||
          DEFAULT_SERVICE_NAME,
        installDir: ctx.installDir,
      }),
  },
  {
    id: 'health',
    collect: async (ctx) => {
      const env = await ensureEnvironment(ctx);
      return checkHealth(env.healthHost, env.healthPort, {
        serviceRunning: ctx.serviceRunning === true,
        installDir: ctx.installDir,
      });
    },
  },
  {
    id: 'loop-watchdog',
    collect: async (ctx) => checkLoopWatchdogLog(ctx.installDir),
  },
  {
    id: 'passkey-origin',
    collect: async (ctx) => {
      const env = await ensureEnvironment(ctx);
      return checkPasskeyOrigins({
        healthHost: env.healthHost,
        healthPort: env.healthPort,
        baseUrl: env.baseUrl,
      });
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
    reporter.log(`\n[vibeterm] ${t('doctor.fix.hint')}`);
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
    console.log(`[vibeterm] ${t('doctor.fix.skip', { id: planned.id })}`);
    return;
  }
  const nonInteractive = asBoolean(parsed.flags['no-interactive']) ?? false;
  await executeDependencyInstall(planned.plan, {
    nonInteractive,
    autoConfirm: nonInteractive,
  });
}

async function applyDoctorFixes(checks: DoctorCheck[], parsed: ParsedArgs): Promise<void> {
  console.log(`\n[vibeterm] ${t('doctor.fix.header')}`);
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
