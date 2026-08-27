import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
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

function contentTypeByPath(path: string): string | undefined {
  const ext = extname(path).toLowerCase();
  return MIME_MAP[ext];
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

  return new Response(Bun.file(targetPath), { headers });
}
