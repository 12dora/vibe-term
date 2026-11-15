// 设备错误徽标的展示模型：类型 → 文案键、色调与 tooltip，保持与渲染解耦以便单测。

export type DeviceBadgeTone = 'error' | 'warning';

export interface DeviceErrorLike {
  type: string;
  message?: string;
  rawMessage?: string;
}

export interface DeviceErrorBadgeModel {
  label: string;
  tooltip: string;
  tone: DeviceBadgeTone;
}

type Translate = (key: string) => string;

const ERROR_TYPE_TO_BADGE_KEY: Record<string, string> = {
  auth_failed: 'authFailed',
  agent_unavailable: 'agentUnavailable',
  agent_no_identity: 'agentNoIdentity',
  ssh_config_ref_not_supported: 'configRefNotSupported',
  network_unreachable: 'networkUnreachable',
  connection_refused: 'connectionRefused',
  timeout: 'timeout',
  host_not_found: 'hostNotFound',
  handshake_failed: 'handshakeFailed',
  tmux_unavailable: 'tmuxUnavailable',
  connection_closed: 'connectionClosed',
  tmux_busy: 'tmux_busy',
};

/** 主机繁忙属于可自行恢复的状态：用告警色，tooltip 只给固定说明，不附带原始 tmux 信息。 */
const SELF_RECOVERING_TYPES = new Set(['tmux_busy']);

export function buildDeviceErrorBadge(error: DeviceErrorLike, t: Translate): DeviceErrorBadgeModel {
  const badgeKey = ERROR_TYPE_TO_BADGE_KEY[error.type] ?? 'unknown';
  const label = t(`deviceStatus.errorBadge.${badgeKey}`);
  if (SELF_RECOVERING_TYPES.has(error.type)) {
    return { label, tooltip: t(`sshError.${badgeKey}`), tone: 'warning' };
  }
  const tooltip = [label, error.message, error.rawMessage].filter(Boolean).join('\n');
  return { label, tooltip, tone: 'error' };
}
