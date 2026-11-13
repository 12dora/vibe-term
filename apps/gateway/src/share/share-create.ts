import { buildShareUrl, normalizeShareOrigin } from '@vibeterm/shared/share';
import { MESH_VIA_SELF } from '../mesh/mesh-deps';
import type { ShareOriginContext } from './share-origins';
import { resolveSharePrefix } from './share-origins';
import type { ShareRow } from './share-store';
import type { ShareCreateInput } from './types';

type ShareWindowName = { name: string; customName?: string | null };

export function resolveCreatedShareOrigin(
  requested: string | null | undefined,
  context: ShareOriginContext
): string | null {
  return requested ? normalizeShareOrigin(requested) : (context.candidates[0]?.url ?? null);
}

export function buildActiveShareRow(args: {
  id: string;
  input: ShareCreateInput;
  window: ShareWindowName;
  origin: string;
  context: ShareOriginContext;
  recordLog: boolean;
  now: number;
}): ShareRow {
  const windowName = args.window.customName?.trim() || args.window.name;
  return {
    id: args.id,
    name: args.input.name?.trim() || windowName,
    deviceId: args.input.deviceId,
    windowId: args.input.windowId,
    windowName,
    state: 'active',
    endReason: null,
    origin: args.origin,
    url: buildShareUrl(args.origin, resolveSharePrefix(args.context, args.origin), args.id),
    recordLog: args.recordLog,
    logBytes: 0,
    logTruncated: false,
    logSeq: 0,
    logPurgedAt: null,
    createdAt: args.now,
    expiresAt:
      args.input.expiresInMs === null ? null : args.now + Math.max(0, args.input.expiresInMs),
    endedAt: null,
    issuedVia: args.input.issuedVia ?? MESH_VIA_SELF,
  };
}
