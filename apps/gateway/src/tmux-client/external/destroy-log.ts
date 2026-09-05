import type { TmuxWindow } from '@tmex/shared';

export type TmuxDestroyReason = 'user' | 'parking';

/** 网关自己发出的窗口/面板销毁一律留痕：出问题时才能把「tab 自己没了」和用户操作区分开。 */
export function formatTmuxDestroyLog(input: {
  command: 'kill-window' | 'kill-pane';
  id: string;
  name: string;
  reason: TmuxDestroyReason;
  session: string;
}): string {
  const name = input.name || 'unknown';
  return `[tmux] ${input.command} id=${input.id} name=${name} reason=${input.reason} session=${input.session}`;
}

export type DestroyLogHost = {
  sessionName: string;
  snapshotWindows: Map<string, TmuxWindow>;
};

function windowNameOf(windows: Map<string, TmuxWindow>, windowId: string): string {
  return windows.get(windowId)?.name || 'unknown';
}

function paneCommandOf(windows: Map<string, TmuxWindow>, paneId: string): string {
  for (const window of windows.values()) {
    const pane = window.panes.find((candidate) => candidate.id === paneId);
    if (pane) {
      return pane.currentCommand || 'unknown';
    }
  }
  return 'unknown';
}

/** 用户发起的窗口/面板销毁：名字取最后一次快照里的窗口名 / 面板当前命令。 */
export function logTmuxDestroy(
  host: DestroyLogHost,
  command: 'kill-window' | 'kill-pane',
  id: string
): void {
  const name =
    command === 'kill-window'
      ? windowNameOf(host.snapshotWindows, id)
      : paneCommandOf(host.snapshotWindows, id);
  console.info(
    formatTmuxDestroyLog({ command, id, name, reason: 'user', session: host.sessionName })
  );
}
