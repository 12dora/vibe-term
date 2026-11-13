import { isMeshInternalPath } from './mesh-internal-tmux-routes';

const STATIC_PREFIXES = ['/assets/', '/static/', '/favicon', '/manifest'];
/** 登录页需要的公开 API：PWA manifest 只含站点名与图标。 */
const PUBLIC_LOCAL_API_PATHS = new Set(['/api/manifest.webmanifest']);

/** 本地 UI 守卫直接放行的路径：登录页、静态资源、公开 API 与 mesh 内部路径。 */
export function isUnguardedLocalUiPath(path: string, method: string): boolean {
  if (path === '/login' || path.startsWith('/login/')) return true;
  if (!path.startsWith('/api/') && isStaticAsset(path)) return true;
  if (PUBLIC_LOCAL_API_PATHS.has(path) && (method === 'GET' || method === 'HEAD')) return true;
  return isMeshInternalPath(path);
}

function isStaticAsset(path: string): boolean {
  for (const prefix of STATIC_PREFIXES) {
    if (path === prefix.slice(0, -1) || path.startsWith(prefix)) return true;
  }
  const last = path.split('/').pop() ?? '';
  return last.includes('.') && !last.startsWith('.');
}
