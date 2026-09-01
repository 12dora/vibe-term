import { existsSync, statSync } from 'node:fs';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import { t } from '../i18n';

const MIME_MAP: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const REVALIDATE_CACHE = 'no-cache';
// Vite 默认 assets/[name]-[hash].ext（本仓库未覆盖 rollupOptions.output）
// Rollup 4 的 [hash] 是 base64url 字母表，可含 `_` 与 `-`
const HASHED_ASSET_NAME = /-[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9]+)+$/;

function contentTypeByPath(path: string): string | undefined {
  const ext = extname(path).toLowerCase();
  return MIME_MAP[ext];
}

function isHashedViteAsset(staticRoot: string, targetPath: string): boolean {
  const rel = relative(resolve(staticRoot), targetPath).replaceAll('\\', '/');
  if (rel.startsWith('../') || rel === '..') return false;
  if (!rel.startsWith('assets/')) return false;
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  return HASHED_ASSET_NAME.test(name);
}

function makeEtag(size: number, mtimeMs: number): string {
  return `W/"${size}-${mtimeMs}"`;
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  const strong = etag.startsWith('W/') ? etag.slice(2) : etag;
  for (const raw of header.split(',')) {
    const tag = raw.trim();
    if (tag === '*') return true;
    const tagStrong = tag.startsWith('W/') ? tag.slice(2) : tag;
    if (tag === etag || tagStrong === strong) return true;
  }
  return false;
}

function isUnmodifiedSince(header: string | null, mtimeMs: number): boolean {
  if (!header) return false;
  const since = Date.parse(header);
  if (Number.isNaN(since)) return false;
  return Math.floor(mtimeMs / 1000) <= Math.floor(since / 1000);
}

function applyCachePolicy(
  headers: Headers,
  req: Request,
  staticRoot: string,
  targetPath: string
): boolean {
  if (isHashedViteAsset(staticRoot, targetPath)) {
    headers.set('Cache-Control', IMMUTABLE_CACHE);
    return false;
  }

  const st = statSync(targetPath);
  const mtimeMs = Math.trunc(st.mtimeMs);
  const etag = makeEtag(st.size, mtimeMs);
  headers.set('Cache-Control', REVALIDATE_CACHE);
  headers.set('ETag', etag);
  headers.set('Last-Modified', new Date(mtimeMs).toUTCString());

  const ifNoneMatch = req.headers.get('If-None-Match');
  if (etagMatches(ifNoneMatch, etag)) return true;
  if (!ifNoneMatch && isUnmodifiedSince(req.headers.get('If-Modified-Since'), mtimeMs)) {
    return true;
  }
  return false;
}

export function resolveRequestedFile(staticRoot: string, pathname: string): string | null {
  const root = resolve(staticRoot);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const normalized = normalize(decoded).replace(/^\.\.(\/|\\|$)/, '');
  const requested = normalized === '/' ? '/index.html' : normalized;
  const absolutePath = resolve(root, `.${requested}`);

  if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {
    return null;
  }

  return absolutePath;
}

export async function serveFrontend(req: Request, staticRoot: string): Promise<Response> {
  const url = new URL(req.url);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response(t('runtime.methodNotAllowed'), { status: 405 });
  }

  const requestedPath = resolveRequestedFile(staticRoot, url.pathname);
  if (!requestedPath) {
    try {
      decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
    return new Response(t('runtime.forbidden'), { status: 403 });
  }

  // 带扩展名的请求视为静态资源，未命中直接 404，避免 SPA fallback
  // 把缺失资源（如 manifest 引用的图标）伪装成 200 + index.html
  if (!existsSync(requestedPath) && extname(url.pathname) !== '') {
    return new Response(t('runtime.notFound'), { status: 404 });
  }

  const indexPath = join(staticRoot, 'index.html');
  const targetPath = existsSync(requestedPath) ? requestedPath : indexPath;

  if (!existsSync(targetPath)) {
    return new Response(t('runtime.frontendMissing'), { status: 500 });
  }

  const headers = new Headers();
  const type = contentTypeByPath(targetPath);
  if (type) {
    headers.set('Content-Type', type);
  }

  const notModified = applyCachePolicy(headers, req, staticRoot, targetPath);
  if (notModified) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(Bun.file(targetPath), { headers });
}
