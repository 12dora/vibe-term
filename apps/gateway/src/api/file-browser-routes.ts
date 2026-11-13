import { runWithFileAccessPrincipal } from '../auth/token-scope';
import { listDirectory, readRawFile, readTextFile, statFile } from '../files/device-storage';
import { browseDirectory } from '../files/directory-browse';
import { t } from '../i18n';
import { getMeshRequestContext } from '../mesh/mesh-deps';
import { jsonError } from '../mesh/session-middleware';
import { requestDispatchContext } from '../mesh/types';
import { codeError } from './file-http';
import { servePulledFile } from './file-serve';
import { json } from './http';
import { type ApiRoute, route } from './route';

function requestIsTokenPrincipal(req: Request): boolean {
  return Boolean(requestDispatchContext.get(req)?.tokenId ?? getMeshRequestContext(req).tokenId);
}

function withReqFileAccess<T>(req: Request, fn: () => T): T {
  return runWithFileAccessPrincipal(requestIsTokenPrincipal(req) ? 'token' : 'session', fn);
}

async function handleBrowse(req: Request): Promise<Response> {
  if (requestIsTokenPrincipal(req)) {
    return jsonError('TOKEN_SCOPE', 403, { message: 'token scope does not allow this request' });
  }
  const url = new URL(req.url);
  const deviceId = url.searchParams.get('deviceId');
  if (!deviceId) return codeError('invalid');
  const path = url.searchParams.get('path') ?? '';
  const hidden = url.searchParams.get('hidden') === '1';
  const result = await browseDirectory(deviceId, path, hidden);
  if (!result.ok) return codeError(result.code, result.detail);
  return json(result.data);
}

async function handleList(url: URL): Promise<Response> {
  const rootId = url.searchParams.get('rootId');
  if (!rootId) return json({ error: t('apiError.invalidRequest') }, 400);
  const path = url.searchParams.get('path');
  const result = await listDirectory(rootId, path);
  if (!result.ok) return codeError(result.code, result.detail);
  return json(result.data);
}

async function handleContent(url: URL): Promise<Response> {
  const rootId = url.searchParams.get('rootId');
  const path = url.searchParams.get('path');
  if (!rootId || !path) return json({ error: t('apiError.invalidRequest') }, 400);
  const result = await readTextFile(rootId, path);
  if (!result.ok) return codeError(result.code, result.detail);
  return json(result.data);
}

async function handleStat(url: URL): Promise<Response> {
  const rootId = url.searchParams.get('rootId');
  const path = url.searchParams.get('path');
  if (!rootId || !path) return json({ error: t('apiError.invalidRequest') }, 400);
  const result = await statFile(rootId, path);
  if (!result.ok) return codeError(result.code, result.detail);
  return json(result.data);
}

async function handleRaw(req: Request, url: URL): Promise<Response> {
  const rootId = url.searchParams.get('rootId');
  const path = url.searchParams.get('path');
  if (!rootId || !path) return json({ error: t('apiError.invalidRequest') }, 400);
  const result = await readRawFile(rootId, path);
  if (!result.ok) return codeError(result.code, result.detail);

  const download = url.searchParams.get('download');
  return servePulledFile(req, result.data, download === '1' || download === 'true');
}

export const fileBrowserRoutes: ApiRoute[] = [
  route({
    method: 'GET',
    path: '/api/files/browse',
    handler: (req) => handleBrowse(req),
  }),
  route({
    method: 'GET',
    path: '/api/files/list',
    handler: (req) => withReqFileAccess(req, () => handleList(new URL(req.url))),
  }),
  route({
    method: 'GET',
    path: '/api/files/content',
    handler: (req) => withReqFileAccess(req, () => handleContent(new URL(req.url))),
  }),
  route({
    method: 'GET',
    path: '/api/files/stat',
    handler: (req) => withReqFileAccess(req, () => handleStat(new URL(req.url))),
  }),
  route({
    method: 'GET',
    path: '/api/files/raw',
    handler: (req) => withReqFileAccess(req, () => handleRaw(req, new URL(req.url))),
  }),
];
