import { wsBorsh } from '@tmex/shared';

import type { CanonicalPaneTarget, CanonicalResizeRequest, ResolvedTarget } from './types';

export interface CanonicalResizeCommand {
  requestId: Uint8Array;
  pane: CanonicalPaneTarget;
  rows: number;
  cols: number;
  geometryReason: number;
  sizeEpoch: bigint;
}

/** v1 `ResizePane` 归一为 reason=change、epoch=0；v1.1 变体原样透传。 */
export function normalizeResizeCommand(
  command: wsBorsh.CanonicalCommand
): CanonicalResizeCommand | null {
  if ('ResizePaneV11' in command) return command.ResizePaneV11;
  if (!('ResizePane' in command)) return null;
  return {
    ...command.ResizePane,
    geometryReason: wsBorsh.CANONICAL_GEOMETRY_REASON_CHANGE,
    sizeEpoch: 0n,
  };
}

export function applyCanonicalResize(
  command: CanonicalResizeCommand,
  target: ResolvedTarget,
  resizePane: ((intent: CanonicalResizeRequest) => void) | undefined
): void {
  if (!resizePane) {
    target.device.runtime.resizePane(target.pane.paneId, command.cols, command.rows);
    return;
  }
  resizePane({
    deviceId: target.device.deviceId,
    paneId: target.pane.paneId,
    cols: command.cols,
    rows: command.rows,
    reason: command.geometryReason,
    sizeEpoch: command.sizeEpoch,
    runtime: target.device.runtime,
  });
}
