import { existsSync, statSync } from 'node:fs';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import { t } from '../i18n';
import {
  type ContentEncoding,
  isCompressiblePath,
  negotiateEncoding,
  resolveEncodedBody,
  variantEtag,
} from './static-compression';

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
  // WebAssembly.instantiateStreaming 只认 application/wasm，MIME 不对会静默退回整包编译
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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
  targetPath: string,
  encoding: ContentEncoding | null
): boolean {
  const hashed = isHashedViteAsset(staticRoot, targetPath);
  headers.set('Cache-Control', hashed ? IMMUTABLE_CACHE : REVALIDATE_CACHE);

  if (hashed && !isCompressiblePath(targetPath)) {
    return false;
  }

  const st = statSync(targetPath);
  const mtimeMs = Math.trunc(st.mtimeMs);
  const etag = variantEtag(st.size, mtimeMs, encoding);
  headers.set('ETag', etag);
  if (!hashed) {
    headers.set('Last-Modified', new Date(mtimeMs).toUTCString());
  }

  const ifNoneMatch = req.headers.get('If-None-Match');
  if (etagMatches(ifNoneMatch, etag)) return true;
  if (!hashed && !ifNoneMatch && encoding === null) {
    return isUnmodifiedSince(req.headers.get('If-Modified-Since'), mtimeMs);
  }
  return false;
}

function hasRangeRequest(req: Request): boolean {
  const range = req.headers.get('Range');
  return range !== null && range.trim() !== '';
}

function pickEncoding(req: Request, compressible: boolean): ContentEncoding | null {
  if (!compressible || hasRangeRequest(req)) return null;
  return negotiateEncoding(req.headers.get('Accept-Encoding'));
}

function lookupStaticFile(req: Request, staticRoot: string): Response | string {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response(t('runtime.methodNotAllowed'), { status: 405 });
  }

  const url = new URL(req.url);
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
  return targetPath;
}

function encodedStaticResponse(
  req: Request,
  headers: Headers,
  staticRoot: string,
  targetPath: string,
  encoding: ContentEncoding | null
): Response {
  const body = resolveEncodedBody(targetPath, encoding);
  if (body.encoding) {
    headers.set('Content-Encoding', body.encoding);
  }

  const notModified = applyCachePolicy(headers, req, staticRoot, targetPath, body.encoding);
  if (notModified) {
    return new Response(null, { status: 304, headers });
  }

  if (body.bytes) {
    headers.set('Content-Length', String(body.bytes.byteLength));
    const payload = req.method === 'HEAD' ? null : new Uint8Array(body.bytes);
    return new Response(payload, { headers });
  }

  const filePath = body.filePath ?? targetPath;
  headers.set('Content-Length', String(statSync(filePath).size));
  if (req.method === 'HEAD') {
    return new Response(null, { headers });
  }
  return new Response(Bun.file(filePath), { headers });
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
  const target = lookupStaticFile(req, staticRoot);
  if (target instanceof Response) return target;

  const headers = new Headers();
  const type = contentTypeByPath(target);
  if (type) {
    headers.set('Content-Type', type);
  }

  const compressible = isCompressiblePath(target);
  if (compressible) {
    headers.set('Vary', 'Accept-Encoding');
  }

  return encodedStaticResponse(req, headers, staticRoot, target, pickEncoding(req, compressible));
}
