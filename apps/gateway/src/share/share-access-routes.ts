import { json, readJsonObjectBody } from '../api/http';
import { type ApiRoute, route } from '../api/route';
import { parseCookies } from '../auth/cookies';
import { clientIpFromRequest } from '../mesh/client-ip';
import { MESH_VIA_SELF, getMeshRequestContext } from '../mesh/mesh-deps';
import { getShareService } from './share-service';
import {
  SHARE_COOKIE_PREFIX,
  X_TMEX_CLEAR_SHARE,
  X_TMEX_SET_SHARE,
  X_TMEX_SET_SHARE_MAX_AGE,
  parseShareToken,
  shareCookieName,
} from './share-token';

export const SHARE_ACCESS_PATH_PREFIX = '/api/share-access/';

/** 优先读本次入口 via 对应的分享 cookie；不匹配时回退扫描任意 `tmex_sh_*`。 */
export function readShareCookieToken(req: Request, shareId: string): string | null {
  const cookies = parseCookies(req.headers.get('cookie'));
  const via = getMeshRequestContext(req).via || MESH_VIA_SELF;
  const primary = cookies.get(shareCookieName(via));
  if (primary && parseShareToken(primary)?.shareId === shareId) return primary;
  for (const [name, value] of cookies) {
    if (!name.startsWith(SHARE_COOKIE_PREFIX)) continue;
    if (parseShareToken(value)?.shareId === shareId) return value;
  }
  return null;
}

function notFound(): Response {
  return json({ error: 'Share not found.', code: 'SHARE_NOT_FOUND' }, 404);
}

export const shareAccessRoutes: ApiRoute[] = [
  route({
    method: 'GET',
    path: '/api/share-access/:id',
    handler: (req, params) => {
      const service = getShareService();
      const share = service.get(params.id);
      if (!share) return notFound();
      const token = readShareCookieToken(req, params.id);
      const verified = token ? service.verifyAccessToken(token) : null;
      const base = {
        id: share.id,
        name: share.name,
        state: share.state,
        expiresAt: share.expiresAt,
        authenticated: Boolean(verified),
      };
      if (!verified) return json(base);
      // 长期分享靠这里滑动续期：只延长服务端 token 的话，浏览器 cookie 仍会在 7 天后消失。
      const renewal: Record<string, string> = {};
      if (token && verified.renewed && verified.maxAgeSec) {
        renewal[X_TMEX_SET_SHARE] = token;
        renewal[X_TMEX_SET_SHARE_MAX_AGE] = String(verified.maxAgeSec);
      }
      return json({ ...base, deviceId: share.deviceId, windowId: share.windowId }, 200, renewal);
    },
  }),
  route({
    method: 'POST',
    path: '/api/share-access/:id/login',
    handler: async (req, params) => {
      const body = await readJsonObjectBody(req);
      const password = typeof body?.password === 'string' ? body.password : '';
      const clientIp = clientIpFromRequest(req) ?? 'local';
      const result = await getShareService().loginAccess(params.id, password, clientIp);
      if (result.ok) {
        return json({ ok: true, expiresAt: result.expiresAt }, 200, {
          [X_TMEX_SET_SHARE]: result.token,
          [X_TMEX_SET_SHARE_MAX_AGE]: String(result.maxAgeSec),
        });
      }
      if (result.code === 'SHARE_NOT_FOUND') return notFound();
      if (result.code === 'SHARE_ENDED') {
        return json({ error: 'Share has ended.', code: 'SHARE_ENDED' }, 410);
      }
      if (result.code === 'SHARE_LOGIN_LOCKED') {
        return json(
          {
            error: 'Too many failed attempts.',
            code: 'SHARE_LOGIN_LOCKED',
            retryAfterMs: result.retryAfterMs ?? 0,
          },
          429,
          { 'retry-after': String(Math.ceil((result.retryAfterMs ?? 0) / 1000)) }
        );
      }
      return json({ error: 'Incorrect password.', code: 'SHARE_PASSWORD_INVALID' }, 401);
    },
  }),
  route({
    method: 'POST',
    path: '/api/share-access/:id/logout',
    handler: (req, params) => {
      const token = readShareCookieToken(req, params.id);
      if (token) getShareService().logoutAccess(token);
      return json({ ok: true }, 200, { [X_TMEX_CLEAR_SHARE]: '1' });
    },
  }),
];
