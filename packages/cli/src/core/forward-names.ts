// 前台转发的临时映射命名与遗留判定：名字带本机标识与进程号，只回收「本机且进程已不存在」的映射。

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

const MACHINE_ID_FILES = ['/etc/machine-id', '/var/lib/dbus/machine-id'];

export const EPHEMERAL_NAME_RE = /^fwd:([0-9a-f]{8}):([0-9a-z]+):[LR]\d+$/;

export function computeHostId(host: string, machineId: string): string {
  return createHash('sha256').update(`${host}\n${machineId}`).digest('hex').slice(0, 8);
}

function readMachineId(): string {
  for (const file of MACHINE_ID_FILES) {
    try {
      const value = readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch {
      // 不可读（macOS / 受限环境）时退化为只用主机名
    }
  }
  return '';
}

let cachedHostId: string | undefined;

/** 本机标识：hostname + machine-id 的 sha256 前 8 位十六进制。 */
export function localHostId(): string {
  cachedHostId ??= computeHostId(hostname(), readMachineId());
  return cachedHostId;
}

export function ephemeralForwardName(kind: 'L' | 'R', port: number): string {
  return `fwd:${localHostId()}:${process.pid.toString(36)}:${kind}${port}`;
}

export type ProcessProbe = (pid: number, signal: 0) => unknown;

/** 仅 ESRCH 算进程不存在；EPERM（别的用户的进程）及其它错误一律按存活处理。 */
export function pidIsDead(pid: number, probe: ProcessProbe = process.kill): boolean {
  try {
    probe(pid, 0);
    return false;
  } catch (error) {
    return (error as { code?: string }).code === 'ESRCH';
  }
}

/** 只有本机创建、且创建它的进程已确认不存在的临时映射才允许回收。 */
export function isReclaimableForward(
  name: string,
  options: { hostId?: string; selfPid?: number; probe?: ProcessProbe } = {}
): boolean {
  const match = EPHEMERAL_NAME_RE.exec(name);
  if (!match) return false;
  if (match[1] !== (options.hostId ?? localHostId())) return false;
  const pid = Number.parseInt(match[2], 36);
  if (pid === (options.selfPid ?? process.pid)) return false;
  return pidIsDead(pid, options.probe);
}
