// 一轮 tick 里所有 set-property 合成一段脚本，一次宿主往返、共用一个超时。
// 避免 N 个 pane 各等满 10s，把采样 tick 拖死。

import { HOST_SHELL_TIMEOUT_MS } from './constants';
import { argvToScript, shQuote } from './scope-commands';
import { type PlannedWrite, recordPropertyResult } from './tracker-ops';
import type { HostShellResult, HostShellRunner } from './types';
import { withUserBus } from './user-bus';

export const PROPERTY_BATCH_MARK = 'VTSET_BATCH';

export function buildPropertyBatchScript(writes: readonly PlannedWrite[]): string {
  const body = writes.map(writeCommand).join('\n');
  return withUserBus(`# ${PROPERTY_BATCH_MARK}\n${body}\nexit 0\n`);
}

function writeCommand(write: PlannedWrite): string {
  const scope = shQuote(write.state.scope ?? '');
  const cmdline = argvToScript(write.args);
  return [
    `err=$(${cmdline} 2>&1)`,
    'code=$?',
    "err=$(printf '%s' \"$err\" | tr '\\n\\t' '  ')",
    `printf 'VTSET\\t%s\\t%s\\t%s\\n' ${scope} "$code" "$err"`,
  ].join('\n');
}

export function parsePropertyBatch(stdout: string): Map<string, { code: number; stderr: string }> {
  const rows = new Map<string, { code: number; stderr: string }>();
  for (const line of stdout.split(/\r?\n/)) {
    const row = parseBatchLine(line);
    if (row) rows.set(row.scope, { code: row.code, stderr: row.stderr });
  }
  return rows;
}

function parseBatchLine(line: string): { scope: string; code: number; stderr: string } | null {
  if (!line.startsWith('VTSET\t')) return null;
  const fields = line.split('\t');
  if (fields.length < 3) return null;
  const scope = fields[1] ?? '';
  const code = Number.parseInt(fields[2] ?? '', 10);
  if (!scope || !Number.isInteger(code)) return null;
  return { scope, code, stderr: fields.slice(3).join('\t').trim() };
}

export async function runPropertyBatch(
  host: HostShellRunner,
  deviceId: string,
  writes: readonly PlannedWrite[],
  now: number
): Promise<void> {
  if (writes.length === 0) return;
  const result = await runBatch(host, writes);
  applyBatchResult(deviceId, writes, result, now);
}

async function runBatch(
  host: HostShellRunner,
  writes: readonly PlannedWrite[]
): Promise<HostShellResult> {
  try {
    return await host.runHostShell(buildPropertyBatchScript(writes), {
      timeoutMs: HOST_SHELL_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 1,
    };
  }
}

function applyBatchResult(
  deviceId: string,
  writes: readonly PlannedWrite[],
  result: HostShellResult,
  now: number
): void {
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim() || `exit ${result.exitCode}`;
    for (const write of writes) failWrite(deviceId, write, result.exitCode, stderr, now);
    return;
  }
  const rows = parsePropertyBatch(result.stdout);
  if (rows.size === 0) {
    for (const write of writes) succeedWrite(deviceId, write, now);
    return;
  }
  for (const write of writes) applyRow(deviceId, write, rows, now);
}

function succeedWrite(deviceId: string, write: PlannedWrite, now: number): void {
  recordPropertyResult({
    state: write.state,
    kind: write.kind,
    code: 0,
    stderr: '',
    now,
    deviceId,
  });
}

function failWrite(
  deviceId: string,
  write: PlannedWrite,
  code: number,
  stderr: string,
  now: number
): void {
  recordPropertyResult({ state: write.state, kind: write.kind, code, stderr, now, deviceId });
}

function applyRow(
  deviceId: string,
  write: PlannedWrite,
  rows: Map<string, { code: number; stderr: string }>,
  now: number
): void {
  const row = rows.get(write.state.scope ?? '');
  if (!row) {
    failWrite(deviceId, write, 1, 'no VTSET row', now);
    return;
  }
  recordPropertyResult({
    state: write.state,
    kind: write.kind,
    code: row.code,
    stderr: row.stderr,
    now,
    deviceId,
  });
}
