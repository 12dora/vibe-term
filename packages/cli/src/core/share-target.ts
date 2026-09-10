// 分享目标：把 `[<node>/]<device>:<window>` 解成 deviceId + windowId。

import { flagString } from './args';
import type { FlagValues } from './args';
import type { CliContext } from './context';
import { UsageError } from './errors';
import { parseTarget } from './resolve';

export interface ResolvedShareTarget {
  nodeId: string;
  deviceId: string;
  windowId: string;
  deviceName: string;
}

export async function resolveShareTarget(
  ctx: CliContext,
  raw: string | undefined,
  flags: FlagValues
): Promise<ResolvedShareTarget> {
  const windowFlag = flagString(flags, 'window-id');
  if (!raw && !windowFlag) {
    throw new UsageError(
      'missing target',
      'use <node>/<device>:<window> or --window-id @N with a device'
    );
  }
  if (!raw) {
    throw new UsageError('missing device target when using --window-id');
  }
  const parsed = parseTarget(raw);
  const node = await ctx.resolver.resolveNode(parsed.node ?? ctx.globals.node);
  const device = await ctx.resolver.resolveDevice(node.id, parsed.device);
  const windowId = windowFlag ?? parsed.window?.raw ?? parsed.location;
  if (!windowId) {
    throw new UsageError(
      'missing window',
      'append :<window> (tmux id like @1 or a name) or pass --window-id @N'
    );
  }
  return { nodeId: node.id, deviceId: device.id, windowId, deviceName: device.name };
}

export function sharePath(id: string, suffix = ''): string {
  return `/api/share/${encodeURIComponent(id)}${suffix}`;
}
