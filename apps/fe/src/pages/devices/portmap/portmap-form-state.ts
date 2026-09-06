// 新建映射表单的纯逻辑：端口解析、字段校验、探测结果如何影响提交。

import type { PortProbeResponse, TargetPortProbeResponse } from '@tmex/shared';

export const LISTEN_HOST_LOCAL = '127.0.0.1';
export const LISTEN_HOST_ANY = '0.0.0.0';

export interface PortMapFormState {
  listenNodeId: string | null;
  listenHost: string;
  listenPort: string;
  targetNodeId: string | null;
  targetHost: string;
  targetPort: string;
  name: string;
}

export function createPortMapFormState(listenNodeId: string | null): PortMapFormState {
  return {
    listenNodeId,
    listenHost: LISTEN_HOST_LOCAL,
    listenPort: '',
    targetNodeId: null,
    targetHost: LISTEN_HOST_LOCAL,
    targetPort: '',
    name: '',
  };
}

/**
 * 迟到的创建响应不该覆盖用户新改的表单：只有表单还是提交那一刻的那一份才重置。
 * 每次编辑都会生成新的 state 对象，引用相等即「没动过」。
 */
export function resetFormIfUnchanged(
  submitted: PortMapFormState,
  listenNodeId: string | null
): (current: PortMapFormState) => PortMapFormState {
  return (current) => (current === submitted ? createPortMapFormState(listenNodeId) : current);
}

/** 1–65535 的整数；其余（含空串、小数、越界）为 null。 */
export function parsePort(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? port : null;
}

export type PortFieldError = 'range';

export interface PortMapFormErrors {
  listenPort?: PortFieldError;
  targetPort?: PortFieldError;
}

export function validatePortMapForm(state: PortMapFormState): PortMapFormErrors {
  const errors: PortMapFormErrors = {};
  if (state.listenPort.trim() !== '' && parsePort(state.listenPort) === null) {
    errors.listenPort = 'range';
  }
  if (state.targetPort.trim() !== '' && parsePort(state.targetPort) === null) {
    errors.targetPort = 'range';
  }
  return errors;
}

/** 监听端口探测的阻断原因；可用时为 null。 */
export type ProbeBlock = 'inUse' | 'reserved';

export function listenProbeBlock(probe: PortProbeResponse | null): ProbeBlock | null {
  if (!probe) return null;
  if (probe.reserved) return 'reserved';
  return probe.free ? null : 'inUse';
}

/** 目标端口没有服务只是提示，不阻断提交。 */
export function targetProbeHint(probe: TargetPortProbeResponse | null): 'idle' | null {
  if (!probe) return null;
  return probe.listening ? null : 'idle';
}

export type SubmitBlock = 'incomplete' | 'invalidPort' | 'portTaken' | 'sameNode';

export function portMapSubmitBlock(
  state: PortMapFormState,
  listenProbe: PortProbeResponse | null
): SubmitBlock | null {
  const listenPort = parsePort(state.listenPort);
  const targetPort = parsePort(state.targetPort);
  if (state.listenPort.trim() !== '' && listenPort === null) return 'invalidPort';
  if (state.targetPort.trim() !== '' && targetPort === null) return 'invalidPort';
  if (!state.listenNodeId || !state.targetNodeId || listenPort === null || targetPort === null) {
    return 'incomplete';
  }
  if (state.listenNodeId === state.targetNodeId) return 'sameNode';
  if (listenProbeBlock(listenProbe) !== null) return 'portTaken';
  return null;
}

/** 探测请求只在端口本身合法、且与探测结果对得上时才发。 */
export function probeTarget(
  nodeId: string | null,
  host: string,
  port: string
): { nodeId: string; host: string; port: number } | null {
  const parsed = parsePort(port);
  if (!nodeId || parsed === null || host.trim() === '') return null;
  return { nodeId, host: host.trim(), port: parsed };
}
