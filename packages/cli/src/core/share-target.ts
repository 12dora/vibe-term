// 分享目标：把 `[<node>/]<device>:<window>` 解成 deviceId + windowId。
// 网关只按窗口 @id 匹配，且需要一份热 snapshot，所以这里先连设备、等会话树，
// 再用 `resolveWindow` 把 @id / 序号 / 名字收成 @id。socket 由调用方在 POST 返回后再关。

import type { TmuxSession, TmuxWindow } from '@vibeterm/shared';
import { type CanonicalResolution, resolveWindow } from '@vibeterm/ws-client/canonical-tree';
import { flagString } from './args';
import type { FlagValues } from './args';
import type { CliContext } from './context';
import { NotFoundError, UsageError } from './errors';
import { parseTarget } from './resolve';
import { openDeviceSession } from './tmux-ops';

export interface ResolvedShareTarget {
  nodeId: string;
  deviceId: string;
  windowId: string;
  deviceName: string;
  close(): void;
}

export interface ShareOriginsView {
  candidates?: Array<{ url: string }>;
  recommended?: string | null;
}

/** 与 GUI `pickDefaultShareOrigin` 一致：推荐地址须在候选里，否则退第一个。 */
export function pickShareOrigin(view: ShareOriginsView): string | null {
  const candidates = view.candidates ?? [];
  const recommended = view.recommended ?? null;
  if (recommended && candidates.some((item) => item.url === recommended)) return recommended;
  return candidates[0]?.url ?? null;
}

function windowFailure(ref: string, result: CanonicalResolution<TmuxWindow>): UsageError {
  const names = result.ok ? [] : result.candidates.map((item) => `${item.id}(${item.name})`);
  return new UsageError(
    `window "${ref}" is ambiguous: ${names.join(', ')}`,
    'use the tmux id instead (@<n>) or pass --window-id @N'
  );
}

/** 窗口引用：`@id` > 序号 > 名字。撞车报用法错误。 */
export function locateShareWindow(session: TmuxSession, ref: string): TmuxWindow {
  const result = resolveWindow(session, ref);
  if (result.ok) return result.value;
  if (result.reason === 'ambiguous') throw windowFailure(ref, result);
  throw new NotFoundError(
    `no window matches "${ref}" in session ${session.name}`,
    'run: vibeterm tmux windows <target>'
  );
}

function windowRef(raw: string, flags: FlagValues): string {
  const windowFlag = flagString(flags, 'window-id');
  if (windowFlag) return windowFlag;
  const parsed = parseTarget(raw);
  if (parsed.location) return parsed.location;
  throw new UsageError(
    'missing window',
    'append :<window> (tmux id like @1, an index, or a name) or pass --window-id @N'
  );
}

export async function resolveShareTarget(
  ctx: CliContext,
  raw: string | undefined,
  flags: FlagValues
): Promise<ResolvedShareTarget> {
  if (!raw) {
    throw new UsageError(
      flagString(flags, 'window-id')
        ? 'missing device target when using --window-id'
        : 'missing target',
      'use <node>/<device>:<window> or --window-id @N with a device'
    );
  }
  const ref = windowRef(raw, flags);
  const opened = await openDeviceSession(ctx, raw);
  try {
    const window = locateShareWindow(opened.tree, ref);
    return {
      nodeId: opened.nodeId,
      deviceId: opened.device.id,
      windowId: window.id,
      deviceName: opened.device.name,
      close: opened.close,
    };
  } catch (error) {
    opened.close();
    throw error;
  }
}

export async function resolveShareOrigin(
  ctx: CliContext,
  nodeId: string,
  flags: FlagValues
): Promise<string> {
  const override = flagString(flags, 'origin');
  if (override) return override;
  const view = await ctx.http.json<ShareOriginsView>(nodeId, 'GET', '/api/share/origins');
  const origin = pickShareOrigin(view);
  if (!origin) {
    throw new UsageError(
      'no public share origin is configured',
      'pass --origin <url> or run: vibeterm share origins'
    );
  }
  ctx.out.info(`using origin ${origin}`);
  return origin;
}

export function sharePath(id: string, suffix = ''): string {
  return `/api/share/${encodeURIComponent(id)}${suffix}`;
}
