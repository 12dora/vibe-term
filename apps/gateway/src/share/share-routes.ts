import type { ShareSettings } from '@tmex/shared/share';
import { json, readJsonObjectBody } from '../api/http';
import { type ApiRoute, route } from '../api/route';
import { getShareService } from './share-service';
import type { ShareErrorCode } from './types';

const ERROR_STATUS: Record<ShareErrorCode, number> = {
  SHARE_NOT_FOUND: 404,
  SHARE_WINDOW_NOT_FOUND: 404,
  SHARE_PASSWORD_TOO_SHORT: 400,
  SHARE_ORIGIN_INVALID: 400,
  SHARE_ENDED: 409,
};

const ERROR_MESSAGE: Record<ShareErrorCode, string> = {
  SHARE_NOT_FOUND: 'Share not found.',
  SHARE_WINDOW_NOT_FOUND: 'Terminal window not found on this device.',
  SHARE_PASSWORD_TOO_SHORT: 'Share password is too short.',
  SHARE_ORIGIN_INVALID: 'Share address is not publicly reachable.',
  SHARE_ENDED: 'Share has already ended.',
};

export function shareError(code: ShareErrorCode): Response {
  return json({ error: ERROR_MESSAGE[code], code }, ERROR_STATUS[code]);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseExpiresInMs(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function parseSettingsPatch(body: Record<string, unknown>): Partial<ShareSettings> {
  const patch: Partial<ShareSettings> = {};
  if (typeof body.recordLogs === 'boolean') patch.recordLogs = body.recordLogs;
  if (typeof body.logRetentionDays === 'number') patch.logRetentionDays = body.logRetentionDays;
  if (typeof body.logMaxBytes === 'number') patch.logMaxBytes = body.logMaxBytes;
  if (body.defaultOrigin === null) patch.defaultOrigin = null;
  else if (typeof body.defaultOrigin === 'string') patch.defaultOrigin = body.defaultOrigin;
  return patch;
}

export const shareRoutes: ApiRoute[] = [
  route({
    method: 'GET',
    path: '/api/share/settings',
    handler: () => json(getShareService().getSettings()),
  }),
  route({
    method: 'PUT',
    path: '/api/share/settings',
    handler: async (req) => {
      const body = await readJsonObjectBody(req);
      if (!body) return json({ error: 'Invalid request body.', code: 'INVALID_BODY' }, 400);
      return json(getShareService().updateSettings(parseSettingsPatch(body)));
    },
  }),
  route({
    method: 'GET',
    path: '/api/share/origins',
    handler: () => json(getShareService().listOrigins()),
  }),
  route({
    method: 'GET',
    path: '/api/share',
    handler: (req) => {
      const url = new URL(req.url);
      const deviceId = optionalString(url.searchParams.get('deviceId'));
      const windowId = optionalString(url.searchParams.get('windowId'));
      return json(
        getShareService().list({
          ...(deviceId ? { deviceId } : {}),
          ...(windowId ? { windowId } : {}),
        })
      );
    },
  }),
  route({
    method: 'POST',
    path: '/api/share',
    handler: async (req) => {
      const body = await readJsonObjectBody(req);
      if (!body) return json({ error: 'Invalid request body.', code: 'INVALID_BODY' }, 400);
      const deviceId = optionalString(body.deviceId);
      const windowId = optionalString(body.windowId);
      const password = typeof body.password === 'string' ? body.password : '';
      const expiresInMs = parseExpiresInMs(body.expiresInMs);
      if (!deviceId || !windowId || expiresInMs === undefined) {
        return json({ error: 'Invalid share request.', code: 'INVALID_BODY' }, 400);
      }
      const result = await getShareService().create({
        deviceId,
        windowId,
        name: optionalString(body.name) ?? null,
        password,
        expiresInMs,
        origin: optionalString(body.origin) ?? null,
      });
      if (!result.ok) return shareError(result.code);
      return json({ share: result.share, password: result.password });
    },
  }),
  route({
    method: 'GET',
    path: '/api/share/:id/log',
    handler: (req, params) => {
      const url = new URL(req.url);
      const after = Number(url.searchParams.get('after') ?? '0');
      const limitRaw = url.searchParams.get('limit');
      const page = getShareService().readLog(params.id, {
        after: Number.isFinite(after) ? after : 0,
        ...(limitRaw && Number.isFinite(Number(limitRaw)) ? { limit: Number(limitRaw) } : {}),
      });
      return page ? json(page) : shareError('SHARE_NOT_FOUND');
    },
  }),
  route({
    method: 'POST',
    path: '/api/share/:id/revoke',
    handler: (_req, params) => {
      const share = getShareService().revoke(params.id);
      return share ? json({ share }) : shareError('SHARE_NOT_FOUND');
    },
  }),
  route({
    method: 'DELETE',
    path: '/api/share/:id',
    handler: (_req, params) => {
      const service = getShareService();
      const existing = service.get(params.id);
      if (!existing) return shareError('SHARE_NOT_FOUND');
      if (existing.state !== 'ended') {
        return json({ error: 'Share is still active.', code: 'SHARE_ACTIVE' }, 409);
      }
      service.remove(params.id);
      return json({ ok: true });
    },
  }),
];
