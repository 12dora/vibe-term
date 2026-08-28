// 采集「入口主机」环境事实，注入 system prompt。
// 注意：local 设备的 gateway 进程即入口主机，可读 os/shell；ssh 设备只知接入参数，
// 远端真实环境未知（pane 可能进一步 ssh 到别处），由 prompt 引导 agent 自行探测。

import type { Device } from '@tmex/shared';
import { AGENT_ENV_RESOLVERS, type EnvCollectContext } from './environment-fields';

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

export function collectAgentEnvironment(device: Device | null): AgentEnvironmentInfo {
  const ctx: EnvCollectContext = { device, isLocal: device?.type === 'local' };
  return {
    deviceName: AGENT_ENV_RESOLVERS.deviceName(ctx),
    deviceType: AGENT_ENV_RESOLVERS.deviceType(ctx),
    host: AGENT_ENV_RESOLVERS.host(ctx),
    username: AGENT_ENV_RESOLVERS.username(ctx),
    port: AGENT_ENV_RESOLVERS.port(ctx),
    tmuxSession: AGENT_ENV_RESOLVERS.tmuxSession(ctx),
    timezone: AGENT_ENV_RESOLVERS.timezone(ctx),
    nowIso: AGENT_ENV_RESOLVERS.nowIso(ctx),
    gatewayOs: AGENT_ENV_RESOLVERS.gatewayOs(ctx),
    gatewayShell: AGENT_ENV_RESOLVERS.gatewayShell(ctx),
    term: AGENT_ENV_RESOLVERS.term(ctx),
    termProgram: AGENT_ENV_RESOLVERS.termProgram(ctx),
    locale: AGENT_ENV_RESOLVERS.locale(ctx),
    encoding: AGENT_ENV_RESOLVERS.encoding(ctx),
  };
}
