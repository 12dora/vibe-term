import { PARKING_WINDOW_NAME } from './constants';
import { formatTmuxDestroyLog } from './destroy-log';
import type { SessionCommandHost } from './session-commands';

/**
 * 控制客户端 attach 前先建一个活动的护盾窗口，让 attach 引发的焦点/尺寸抖动落在它身上，
 * attach 完成后立刻 `last-window` 回到真实窗口并杀掉它。快照与元数据事件都会过滤掉它。
 */
export async function createParkingWindow(host: SessionCommandHost): Promise<string | null> {
  const result = await host.runTmuxAllowFailure([
    'new-window',
    '-t',
    host.sessionName,
    '-n',
    PARKING_WINDOW_NAME,
    '-P',
    '-F',
    '#{window_id}',
    host.getParkingCommand(),
  ]);
  if (result.exitCode !== 0) {
    console.warn(
      `${host.logPrefix} failed to create parking window on ${host.deviceId}, attaching without focus shield`
    );
    return null;
  }
  return result.stdout.trim() || null;
}

export async function removeParkingWindow(
  host: SessionCommandHost,
  windowId: string | null
): Promise<void> {
  if (!windowId) {
    return;
  }
  console.info(
    formatTmuxDestroyLog({
      command: 'kill-window',
      id: windowId,
      name: PARKING_WINDOW_NAME,
      reason: 'parking',
      session: host.sessionName,
    })
  );
  await host.runTmuxAllowFailure(['last-window', '-t', host.sessionName]);
  await host.runTmuxAllowFailure(['kill-window', '-t', windowId]);
}
