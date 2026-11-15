import type { Device } from '@vibeterm/shared';
import { getDeviceById, getDeviceRuntimeStatus, updateDeviceRuntimeStatus } from '../db';
import { connectionAlertNotifier } from '../push/connection-alerts';
import { classifySshError, isTmuxBusyError, sanitizeTmuxErrorMessage } from '../ws/error-classify';
import type { ControlHealthEvent } from './control-health';

export const TMUX_BUSY_DEBOUNCE_MS = 15_000;

export type TmuxBusyTimers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
};

const defaultTimers: TmuxBusyTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => {
    clearTimeout(id as ReturnType<typeof setTimeout>);
  },
};

let timers: TmuxBusyTimers = defaultTimers;
const pending = new Map<string, unknown>();
const raised = new Set<string>();
const rememberedDevices = new Map<string, Device>();

export function setTmuxBusyTimersForTest(next: TmuxBusyTimers | null): void {
  timers = next ?? defaultTimers;
}

export function resetTmuxBusyIncidentsForTest(): void {
  for (const id of pending.values()) timers.clearTimeout(id);
  pending.clear();
  raised.clear();
  rememberedDevices.clear();
}

/**
 * 运行时 tmux 失败的统一上报口：本机与 SSH 必须一致——走连接告警（落库 lastError +
 * lastErrorType、广播设备 error 事件），否则下游按「已上报」去重后用户什么也看不到。
 * 设备行不在时（刚被删）退回只写运行时状态。
 */
export async function notifyDeviceRuntimeError(deviceId: string, message: string): Promise<void> {
  const error = new Error(message);
  if (considerTmuxBusyError(deviceId, error)) return;
  const device = getDeviceById(deviceId);
  if (!device) {
    updateDeviceRuntimeStatus(deviceId, {
      lastSeenAt: new Date().toISOString(),
      tmuxAvailable: false,
      lastError: sanitizeTmuxErrorMessage(message),
    });
    return;
  }
  await connectionAlertNotifier.notify({
    device,
    error,
    source: 'runtime',
    silentTelegram: true,
  });
}

export function considerTmuxBusyError(
  deviceId: string,
  error: Error,
  device?: Device | null
): boolean {
  if (!isTmuxBusyError(error)) return false;
  scheduleBusyAlert(deviceId, error, device);
  return true;
}

export function handleControlHealth(event: ControlHealthEvent): void {
  if (event.kind === 'recovered') {
    clearControlChannelError(event.deviceId);
    return;
  }
  const error = new Error(
    event.kind === 'stalled' ? 'tmux control channel stalled' : 'tmux control channel slow'
  );
  if (event.kind === 'stalled') {
    raiseBusyAlertNow(event.deviceId, error);
    return;
  }
  scheduleBusyAlert(event.deviceId, error);
}

export function noteControlChannelProgress(deviceId: string): void {
  clearControlChannelError(deviceId);
}

export function isClearableControlError(
  lastErrorType: string | null,
  lastError: string | null
): boolean {
  if (lastErrorType === 'tmux_busy') return true;
  if (lastErrorType && lastErrorType !== 'unknown') return false;
  return Boolean(lastError && isTmuxBusyError(new Error(lastError)));
}

export function clearControlChannelError(deviceId: string): void {
  cancelPending(deviceId);
  raised.delete(deviceId);
  const status = getDeviceRuntimeStatus(deviceId);
  if (!isClearableControlError(status.lastErrorType, status.lastError)) return;
  updateDeviceRuntimeStatus(deviceId, {
    lastSeenAt: new Date().toISOString(),
    lastError: null,
    lastErrorType: null,
  });
  connectionAlertNotifier.broadcastDeviceRecovered(deviceId);
}

function rememberDevice(deviceId: string, device?: Device | null): void {
  if (device) rememberedDevices.set(deviceId, device);
}

function scheduleBusyAlert(deviceId: string, error: Error, device?: Device | null): void {
  rememberDevice(deviceId, device);
  if (raised.has(deviceId) || pending.has(deviceId)) return;
  const timer = timers.setTimeout(() => {
    pending.delete(deviceId);
    void fireBusyAlert(deviceId, error);
  }, TMUX_BUSY_DEBOUNCE_MS);
  pending.set(deviceId, timer);
}

function raiseBusyAlertNow(deviceId: string, error: Error): void {
  cancelPending(deviceId);
  void fireBusyAlert(deviceId, error);
}

function cancelPending(deviceId: string): void {
  const timer = pending.get(deviceId);
  if (timer === undefined) return;
  pending.delete(deviceId);
  timers.clearTimeout(timer);
}

async function fireBusyAlert(deviceId: string, error: Error): Promise<void> {
  if (raised.has(deviceId)) return;
  raised.add(deviceId);
  const sanitized = new Error(sanitizeTmuxErrorMessage(error.message));
  const device = rememberedDevices.get(deviceId) ?? getDeviceById(deviceId);
  rememberedDevices.delete(deviceId);
  if (!device) {
    persistBusyWithoutDevice(deviceId, sanitized);
    return;
  }
  await connectionAlertNotifier.notify({
    device,
    error: sanitized,
    source: 'runtime',
  });
}

function persistBusyWithoutDevice(deviceId: string, error: Error): void {
  const classified = classifySshError(error);
  updateDeviceRuntimeStatus(deviceId, {
    lastSeenAt: new Date().toISOString(),
    lastError: error.message,
    lastErrorType: classified.type,
  });
}
