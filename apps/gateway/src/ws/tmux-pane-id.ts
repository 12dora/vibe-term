import { wsBorsh } from '@vibeterm/shared';
import { isTmuxPaneId } from '../tmux-client/snapshot-format';

export function assertTmuxPaneId(paneId: string): void {
  if (!isTmuxPaneId(paneId)) {
    throw new wsBorsh.WsBorshError(
      wsBorsh.ERROR_TMUX_TARGET_NOT_FOUND,
      false,
      'invalid tmux pane id'
    );
  }
}
