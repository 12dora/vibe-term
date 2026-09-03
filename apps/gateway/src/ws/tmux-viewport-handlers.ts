import { wsBorsh } from '@tmex/shared';
import { type BorshDispatchHost, type BorshKindHandler, schemaHandler } from './borsh-kind-types';

export function createTmuxViewportHandlers(
  host: BorshDispatchHost
): Array<[number, BorshKindHandler<unknown>]> {
  return [
    [
      wsBorsh.KIND_TMUX_RESIZE_PANE,
      schemaHandler(wsBorsh.schema.TmuxResizePaneSchema, (_ws, decoded) => {
        host.handleResizePaneById(
          decoded.deviceId,
          decoded.paneId,
          decoded.cols ?? undefined,
          decoded.rows ?? undefined
        );
      }),
    ],
    [
      wsBorsh.KIND_TMUX_APPLY_STACKED_LAYOUT,
      schemaHandler(wsBorsh.schema.TmuxApplyStackedLayoutSchema, (_ws, decoded) => {
        host.handleApplyStackedLayout(
          decoded.deviceId,
          decoded.windowId,
          decoded.cols,
          decoded.rows
        );
      }),
    ],
    [
      wsBorsh.KIND_TERM_RESIZE,
      schemaHandler(wsBorsh.schema.TermResizeSchema, (ws, decoded) => {
        host.handleTermResize(ws, decoded.deviceId, decoded.paneId, decoded.cols, decoded.rows);
      }),
    ],
    [
      wsBorsh.KIND_TERM_SYNC_SIZE,
      schemaHandler(wsBorsh.schema.TermSyncSizeSchema, (ws, decoded) => {
        host.handleTermResize(ws, decoded.deviceId, decoded.paneId, decoded.cols, decoded.rows);
      }),
    ],
    [
      wsBorsh.KIND_TERM_VIEWPORT,
      schemaHandler(wsBorsh.schema.TermViewportSchema, (ws, decoded) => {
        host.handleTermViewport(ws, decoded);
      }),
    ],
  ];
}
