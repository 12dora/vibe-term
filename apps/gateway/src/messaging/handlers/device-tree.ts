import type { CommandResult } from '@tmex/shared/messaging';
import type { CommandContext } from '../context';
import { errorResult } from '../context';
import { resolveDeviceRef } from '../resolve-refs';

export function deviceError(
  ctx: CommandContext,
  resolved: Exclude<ReturnType<typeof resolveDeviceRef>, { ok: true }>
): CommandResult {
  if (resolved.error === 'ambiguous') {
    return errorResult(ctx, 'messaging.error.ambiguousDevice', {
      input: resolved.input,
      candidates: resolved.candidates.join(', '),
    });
  }
  return errorResult(ctx, 'messaging.error.unknownDevice', { input: resolved.input });
}

export function requireDevice(input: string | undefined, ctx: CommandContext) {
  if (!input) {
    return {
      ok: false as const,
      result: errorResult(ctx, 'messaging.error.missingArg', { name: 'device' }),
    };
  }
  const resolved = resolveDeviceRef(input, ctx.listDevices());
  if (!resolved.ok) return { ok: false as const, result: deviceError(ctx, resolved) };
  const windows = ctx.getWindows(resolved.device.id);
  if (!windows) {
    return {
      ok: false as const,
      result: errorResult(ctx, 'messaging.error.deviceDisconnected', {
        name: resolved.device.name,
      }),
    };
  }
  return { ok: true as const, device: resolved.device, windows };
}
