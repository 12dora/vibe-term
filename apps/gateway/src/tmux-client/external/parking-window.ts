import { LEGACY_PARKING_WINDOW_NAME, PARKING_WINDOW_NAME } from './constants';
import { formatTmuxDestroyLog } from './destroy-log';
import type { SessionCommandHost } from './session-commands';

/**
 * 1.x 崩在 attach 中途会留下 `tmex-park` 窗口：attach 时统一改成新名，
 * 后续过滤 / 清理只认一个名字。
 */
export async function renameLegacyParkingWindows(host: SessionCommandHost): Promise<void> {
  const listed = await host.runTmuxAllowFailure([
    'list-windows',
    '-t',
    host.sessionName,
    '-F',
    '#{window_id}|#{window_name}',
  ]);
  if (listed.exitCode !== 0) return;
  for (const line of listed.stdout.split('\n')) {
    const [windowId, name] = line.trim().split('|');
    if (!windowId || name !== LEGACY_PARKING_WINDOW_NAME) continue;
    await host.runTmuxAllowFailure(['rename-window', '-t', windowId, PARKING_WINDOW_NAME]);
  }
}

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
