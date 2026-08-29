// 采集「入口主机」环境事实，注入 system prompt。
// 注意：local 设备的 gateway 进程即入口主机，可读 os/shell；ssh 设备只知接入参数，
// 远端真实环境未知（pane 可能进一步 ssh 到别处），由 prompt 引导 agent 自行探测。

import os from 'node:os';
import type { Device } from '@tmex/shared';

export interface AgentEnvironmentInfo {
  deviceName: string | null;
  deviceType: 'local' | 'ssh' | null;
  host: string | null;
  username: string | null;
  port: number | null;
  tmuxSession: string | null;
  timezone: string;
  nowIso: string;
  /** 仅 local 设备可知：gateway 主机即入口主机 */
  gatewayOs: string | null;
  gatewayShell: string | null;
  term: string | null;
  termProgram: string | null;
  locale: string | null;
  encoding: string | null;
}

type DeviceIdentity = Pick<
  AgentEnvironmentInfo,
  'deviceName' | 'deviceType' | 'host' | 'username' | 'port' | 'tmuxSession'
>;

type LocalHostFacts = Pick<
  AgentEnvironmentInfo,
  'gatewayOs' | 'gatewayShell' | 'term' | 'termProgram' | 'locale' | 'encoding'
>;

const ABSENT_LOCAL_FACTS: LocalHostFacts = {
  gatewayOs: null,
  gatewayShell: null,
  term: null,
  termProgram: null,
  locale: null,
  encoding: null,
};

function readHostTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  } catch {
    return 'UTC';
  }
}

function collectDeviceIdentity(device: Device | null): DeviceIdentity {
  return {
    deviceName: device?.name ?? null,
    deviceType: device?.type ?? null,
    host: device?.host ?? null,
    username: device?.username ?? null,
    port: device?.port ?? null,
    tmuxSession: device?.session ?? null,
  };
}

function collectLocalHostFacts(isLocal: boolean): LocalHostFacts {
  if (!isLocal) {
    return ABSENT_LOCAL_FACTS;
  }
  return {
    gatewayOs: `${os.platform()} ${os.release()} (${os.arch()})`,
    gatewayShell: process.env.SHELL ?? null,
    term: process.env.TERM ?? null,
    termProgram: process.env.TERM_PROGRAM ?? null,
    locale: process.env.LANG ?? process.env.LC_ALL ?? null,
    encoding: 'utf-8',
  };
}

export function collectAgentEnvironment(device: Device | null): AgentEnvironmentInfo {
  return {
    ...collectDeviceIdentity(device),
    timezone: readHostTimezone(),
    nowIso: new Date().toISOString(),
    ...collectLocalHostFacts(device?.type === 'local'),
  };
}
