// `tmux move` / `break` / `order-windows` / `order-panes`：布局类 WS 命令。
// 载荷与 GUI 一致（move-pane 见 useSplitDragInteractions.ts 的 src/dst/position）。

import type { TmuxPane, TmuxSession, TmuxWindow } from '@vibeterm/shared';
import type { MovePanePosition } from '@vibeterm/ws-client';
import { resolvePane, resolveWindow } from '@vibeterm/ws-client/canonical-tree';
import { type FlagValues, flagString } from '../core/args';
import type { CliContext } from '../core/context';
import { NotFoundError, UsageError } from '../core/errors';
import { type ParsedTarget, parsePeerTarget } from '../core/resolve';
import { locatePane, locateWindow } from '../core/term-target';
import {
  type OpenedDeviceSession,
  applyTmuxChange,
  firstNew,
  paneById,
  reportPane,
  reportWindow,
  windowById,
  windowIds,
} from '../core/tmux-ops';

export interface TmuxInput {
  ctx: CliContext;
  opened: OpenedDeviceSession;
  rest: string[];
  flags: FlagValues;
}

const POSITIONS = new Set<MovePanePosition>(['left', 'right', 'top', 'bottom']);

export function parseMovePosition(raw: string | undefined): MovePanePosition {
  if (!raw) return 'right';
  if (POSITIONS.has(raw as MovePanePosition)) return raw as MovePanePosition;
  throw new UsageError(`--position must be left|right|top|bottom, got "${raw}"`);
}

export function parseIdList(raw: string | undefined, example: string): string[] {
  if (!raw) throw new UsageError('missing --ids', `pass --ids ${example}`);
  const ids = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (ids.length === 0) throw new UsageError('missing --ids', `pass --ids ${example}`);
  return ids;
}

function sameOpenedDevice(opened: OpenedDeviceSession, dst: ParsedTarget): boolean {
  const deviceOk =
    dst.device === opened.device.id ||
    dst.device.toLowerCase() === opened.device.name.toLowerCase();
  if (!deviceOk) return false;
  if (!dst.node) return true;
  const alias = dst.node.toLowerCase();
  if (
    (alias === 'self' || alias === 'local' || alias === 'entry' || alias === '.') &&
    opened.nodeId === 'self'
  ) {
    return true;
  }
  return alias === opened.nodeName.toLowerCase() || dst.node === opened.nodeId;
}

function requireWindowId(tree: TmuxSession, ref: string): string {
  const result = resolveWindow(tree, ref);
  if (result.ok) return result.value.id;
  if (result.reason === 'ambiguous') {
    throw new UsageError(
      `window "${ref}" is ambiguous: ${result.candidates.map((item) => item.id).join(', ')}`,
      'use the tmux id instead (@<n>)'
    );
  }
  throw new NotFoundError(`no window matches "${ref}"`, 'run: vibeterm tmux windows <target>');
}

function requirePaneId(tree: TmuxSession, window: TmuxWindow, ref: string): string {
  const result = resolvePane(tree, ref);
  if (!result.ok) {
    if (result.reason === 'ambiguous') {
      throw new UsageError(
        `pane "${ref}" is ambiguous: ${result.candidates.map((item) => item.id).join(', ')}`,
        'use the tmux id instead (%<n>)'
      );
    }
    throw new NotFoundError(`no pane matches "${ref}"`, 'run: vibeterm tmux panes <target>');
  }
  if (result.value.windowId !== window.id) {
    throw new UsageError(`pane ${result.value.id} is not in window ${window.id}`);
  }
  return result.value.id;
}

function paneMoved(before: TmuxPane, next: TmuxSession, paneId: string): boolean {
  const now = paneById(next, paneId);
  if (!now) return false;
  return (
    now.windowId !== before.windowId ||
    now.index !== before.index ||
    now.width !== before.width ||
    now.height !== before.height
  );
}

function idsPrefix(actual: readonly string[], wanted: readonly string[]): boolean {
  return wanted.every((id, index) => actual[index] === id);
}

export async function moveCommand({ ctx, opened, rest, flags }: TmuxInput): Promise<void> {
  const dstRaw = rest[0];
  if (!dstRaw) throw new UsageError('missing destination pane');
  if (rest[1]) throw new UsageError(`unexpected argument: ${rest[1]}`);
  const dstTarget = parsePeerTarget(dstRaw, opened.target);
  if (!sameOpenedDevice(opened, dstTarget)) {
    throw new UsageError('move requires both panes on the same device');
  }
  const src = locatePane(opened.tree, opened.target);
  const dst = locatePane(opened.tree, dstTarget);
  if (src.pane.id === dst.pane.id) {
    throw new UsageError('source and destination pane must differ');
  }
  const position = parseMovePosition(flagString(flags, 'position'));
  const tree = await applyTmuxChange(
    opened,
    {
      type: 'move-pane',
      deviceId: opened.device.id,
      srcPaneId: src.pane.id,
      dstPaneId: dst.pane.id,
      position,
    },
    (next) => paneMoved(src.pane, next, src.pane.id),
    `pane ${src.pane.id} to move`,
    ctx.globals.timeoutMs
  );
  const moved = paneById(tree, src.pane.id);
  if (!moved) throw new NotFoundError(`pane ${src.pane.id} disappeared while moving`);
  reportPane(ctx, 'moved', moved);
}

export async function breakCommand({ ctx, opened, rest }: TmuxInput): Promise<void> {
  if (rest[0]) throw new UsageError(`unexpected argument: ${rest[0]}`);
  const { pane } = locatePane(opened.tree, opened.target);
  const before = windowIds(opened.tree);
  const tree = await applyTmuxChange(
    opened,
    { type: 'break-pane', deviceId: opened.device.id, paneId: pane.id },
    (next) => firstNew(before, windowIds(next)) !== null,
    `pane ${pane.id} to break into a window`,
    ctx.globals.timeoutMs
  );
  const created = firstNew(before, windowIds(tree));
  const window = created ? windowById(tree, created) : null;
  if (!window) throw new NotFoundError('the new window vanished before it could be reported');
  reportWindow(ctx, 'broke', window);
}

export async function orderWindowsCommand({ ctx, opened, rest, flags }: TmuxInput): Promise<void> {
  if (rest[0]) throw new UsageError(`unexpected argument: ${rest[0]}`);
  const windowIdsWanted = parseIdList(flagString(flags, 'ids'), '@1,@2').map((ref) =>
    requireWindowId(opened.tree, ref)
  );
  const tree = await applyTmuxChange(
    opened,
    {
      type: 'reorder-windows',
      deviceId: opened.device.id,
      windowIds: windowIdsWanted,
    },
    (next) =>
      idsPrefix(
        next.windows.map((window) => window.id),
        windowIdsWanted
      ),
    'windows to reorder',
    ctx.globals.timeoutMs
  );
  if (ctx.out.json) {
    ctx.out.data({
      ok: true,
      action: 'reordered-windows',
      windowIds: tree.windows.map((window) => window.id),
    });
    return;
  }
  ctx.out.line(`reordered windows: ${tree.windows.map((window) => window.id).join(',')}`);
}

export async function orderPanesCommand({ ctx, opened, rest, flags }: TmuxInput): Promise<void> {
  if (rest[0]) throw new UsageError(`unexpected argument: ${rest[0]}`);
  const window = locateWindow(opened.tree, opened.target);
  const paneIdsWanted = parseIdList(flagString(flags, 'ids'), '%0,%1').map((ref) =>
    requirePaneId(opened.tree, window, ref)
  );
  const tree = await applyTmuxChange(
    opened,
    {
      type: 'reorder-panes',
      deviceId: opened.device.id,
      windowId: window.id,
      paneIds: paneIdsWanted,
    },
    (next) => {
      const updated = windowById(next, window.id);
      return (
        updated !== null &&
        idsPrefix(
          updated.panes.map((pane) => pane.id),
          paneIdsWanted
        )
      );
    },
    `panes of ${window.id} to reorder`,
    ctx.globals.timeoutMs
  );
  const updated = windowById(tree, window.id) ?? window;
  if (ctx.out.json) {
    ctx.out.data({
      ok: true,
      action: 'reordered-panes',
      windowId: updated.id,
      paneIds: updated.panes.map((pane) => pane.id),
    });
    return;
  }
  ctx.out.line(`reordered panes: ${updated.panes.map((pane) => pane.id).join(',')}`);
}
