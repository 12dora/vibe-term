// 目标定位：`[<node>/]<device>[:<window>[.<pane>]]` → node / device / window / pane。
//
// window 与 pane 的定位一律交给 `@vibeterm/ws-client/canonical-tree` 的纯函数
// （`%id`/`@id` > `窗口.pane 序号` > 序号 > 名字），这里只决定「先按窗口解释还是先按 pane 解释」：
// 语法里 `:` 之后没有 `.` 时写的是窗口，有 `.` 时写的是 pane。

import type { DeviceWithRuntime } from '@vibeterm/api-client/devices';
import type { TmuxPane, TmuxSession, TmuxWindow } from '@vibeterm/shared';
import {
  type CanonicalResolution,
  activePane,
  activeWindow,
  resolvePane,
  resolveWindow,
} from '@vibeterm/ws-client/canonical-tree';
import type { CliContext } from './context';
import { NotFoundError, UsageError } from './errors';
import { type ParsedTarget, parseTarget } from './resolve';

export interface ResolvedTargetDevice {
  target: ParsedTarget;
  nodeId: string;
  nodeName: string;
  device: DeviceWithRuntime;
}

/** 解析目标里的 node 与 device（只打 REST，不建 WS）。`--node` 只在目标没写 node 时生效。 */
export async function resolveTargetDevice(
  ctx: CliContext,
  raw: string
): Promise<ResolvedTargetDevice> {
  const target = parseTarget(raw);
  const node = target.node
    ? await ctx.resolver.resolveNode(target.node)
    : await ctx.resolver.resolveNode(ctx.globals.node);
  const device = await ctx.resolver.resolveDevice(node.id, target.device);
  return { target, nodeId: node.id, nodeName: node.name, device };
}

export interface LocatedPane {
  window: TmuxWindow;
  pane: TmuxPane;
}

function windowOfPane(session: TmuxSession, pane: TmuxPane): TmuxWindow {
  const window = session.windows.find((item) => item.id === pane.windowId);
  if (!window) throw new NotFoundError(`pane ${pane.id} has no window in the session tree`);
  return window;
}

function ambiguous(kind: string, ref: string, names: readonly string[]): UsageError {
  return new UsageError(
    `${kind} "${ref}" is ambiguous: ${names.join(', ')}`,
    'use the tmux id instead (@<n> for a window, %<n> for a pane)'
  );
}

function windowFailure(ref: string, result: CanonicalResolution<TmuxWindow>): UsageError {
  return ambiguous(
    'window',
    ref,
    result.ok ? [] : result.candidates.map((item) => `${item.id}(${item.name})`)
  );
}

function paneFailure(ref: string, result: CanonicalResolution<TmuxPane>): UsageError {
  return ambiguous(
    'pane',
    ref,
    result.ok ? [] : result.candidates.map((item) => `${item.id}(${item.title ?? ''})`)
  );
}

/** 定位窗口。目标没写位置时取活动窗口。 */
export function locateWindow(session: TmuxSession, target: ParsedTarget): TmuxWindow {
  const ref = target.location;
  if (!ref) {
    const window = activeWindow(session);
    if (!window) throw new NotFoundError(`session ${session.name} has no window`);
    return window;
  }
  const byWindow = resolveWindow(session, ref);
  if (byWindow.ok) return byWindow.value;
  if (byWindow.reason === 'ambiguous') throw windowFailure(ref, byWindow);
  const byPane = resolvePane(session, ref);
  if (byPane.ok) return windowOfPane(session, byPane.value);
  if (byPane.reason === 'ambiguous') throw paneFailure(ref, byPane);
  throw new NotFoundError(
    `no window matches "${ref}" in session ${session.name}`,
    'run: vibeterm tmux windows <target>'
  );
}

/**
 * 定位 pane。写了 `.` 就先按 pane 解释（`2.1`、`main.0`、`%7`），
 * 没写 `.` 时先按窗口解释再退回 pane 名，最后取窗口的活动 pane。
 */
export function locatePane(session: TmuxSession, target: ParsedTarget): LocatedPane {
  const ref = target.location;
  if (!ref) {
    const window = locateWindow(session, target);
    return { window, pane: requireActivePane(session, window) };
  }
  const paneFirst = target.pane !== null;
  const pane = paneFirst ? resolvePane(session, ref) : null;
  if (pane?.ok) return { window: windowOfPane(session, pane.value), pane: pane.value };
  if (pane && !pane.ok && pane.reason === 'ambiguous') throw paneFailure(ref, pane);

  const window = resolveWindow(session, ref);
  if (window.ok) return { window: window.value, pane: requireActivePane(session, window.value) };
  if (window.reason === 'ambiguous') throw windowFailure(ref, window);

  const fallback = paneFirst ? null : resolvePane(session, ref);
  if (fallback?.ok) return { window: windowOfPane(session, fallback.value), pane: fallback.value };
  if (fallback && !fallback.ok && fallback.reason === 'ambiguous') throw paneFailure(ref, fallback);
  throw new NotFoundError(
    `no pane matches "${ref}" in session ${session.name}`,
    'run: vibeterm tmux panes <target>'
  );
}

function requireActivePane(session: TmuxSession, window: TmuxWindow): TmuxPane {
  const pane = activePane(window);
  if (!pane) throw new NotFoundError(`window ${window.name} in ${session.name} has no pane`);
  return pane;
}
