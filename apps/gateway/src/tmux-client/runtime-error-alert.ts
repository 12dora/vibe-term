import { getDeviceById, updateDeviceRuntimeStatus } from '../db';
import { connectionAlertNotifier } from '../push/connection-alerts';

/**
 * 运行时 tmux 失败的统一上报口：本机与 SSH 必须一致——走连接告警（落库 lastError +
 * lastErrorType、广播设备 error 事件），否则下游按「已上报」去重后用户什么也看不到。
 * 设备行不在时（刚被删）退回只写运行时状态。
 */
export async function notifyDeviceRuntimeError(deviceId: string, message: string): Promise<void> {
  const device = getDeviceById(deviceId);
  if (!device) {
    updateDeviceRuntimeStatus(deviceId, {
      lastSeenAt: new Date().toISOString(),
      tmuxAvailable: false,
      lastError: message,
    });
    return;
  }
  await connectionAlertNotifier.notify({
    device,
    error: new Error(message),
    source: 'runtime',
    silentTelegram: true,
  });
}
