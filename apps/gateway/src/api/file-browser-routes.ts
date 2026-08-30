import { listDirectory, readRawFile, readTextFile, statFile } from '../files/device-storage';
import { browseDirectory } from '../files/directory-browse';
import { t } from '../i18n';
import { codeError } from './file-http';
import { json } from './http';
import { type ApiRoute, route } from './route';

async function handleBrowse(url: URL): Promise<Response> {
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

async function handleRaw(url: URL): Promise<Response> {
  const rootId = url.searchParams.get('rootId');
  const path = url.searchParams.get('path');
  if (!rootId || !path) return json({ error: t('apiError.invalidRequest') }, 400);
  const result = await readRawFile(rootId, path);
  if (!result.ok) return codeError(result.code, result.detail);

  const headers: Record<string, string> = {
    'Content-Type': result.data.mime ?? 'application/octet-stream',
  };
  const download = url.searchParams.get('download');
  if (download === '1' || download === 'true') {
    const encoded = encodeURIComponent(result.data.name);
    const ascii = result.data.name.replace(/["\\\r\n]/g, '_');
    headers['Content-Disposition'] = `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
  }
  return new Response(result.data.data, { status: 200, headers });
}

export const fileBrowserRoutes: ApiRoute[] = [
  route({
    method: 'GET',
    path: '/api/files/browse',
    handler: (req) => handleBrowse(new URL(req.url)),
  }),
  route({ method: 'GET', path: '/api/files/list', handler: (req) => handleList(new URL(req.url)) }),
  route({
    method: 'GET',
    path: '/api/files/content',
    handler: (req) => handleContent(new URL(req.url)),
  }),
  route({ method: 'GET', path: '/api/files/stat', handler: (req) => handleStat(new URL(req.url)) }),
  route({ method: 'GET', path: '/api/files/raw', handler: (req) => handleRaw(new URL(req.url)) }),
];
