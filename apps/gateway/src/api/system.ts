import type { StartUpgradeRequest } from '@tmex/shared';
import { t } from '../i18n';
import { MANAGED_EXTERNALLY, getSystemInfo, isManagedExternally } from '../system/info-public';
import { json } from './http';

// 构建期 define：managed compile 为 true，使自更新模块落入死分支并被剔除。
declare const TMEX_MANAGED_BUILD: boolean | undefined;

function isManagedBuild(): boolean {
  return typeof TMEX_MANAGED_BUILD !== 'undefined' && TMEX_MANAGED_BUILD === true;
}

function managedExternallyResponse(status = 403): Response {
  return json(
    {
      error: MANAGED_EXTERNALLY,
      managed: true,
      canSelfUpdate: false,
    },
    status
  );
}

export function handleSystemApiRequest(
  req: Request,
  path: string
): Response | Promise<Response> | undefined {
  if (path === '/api/system/info' && req.method === 'GET') {
    return json(getSystemInfo());
  }

  const managed = isManagedBuild() || isManagedExternally();

  if (path === '/api/system/update-check' && req.method === 'GET') {
    if (managed) return managedExternallyResponse();
    return handleUpdateCheckOpen();
  }

  if (path === '/api/system/upgrade' && req.method === 'GET') {
    if (managed) return managedExternallyResponse();
    return handleUpgradeStatusOpen();
  }

  if (path === '/api/system/upgrade' && req.method === 'POST') {
    if (managed) return managedExternallyResponse();
    return handleStartUpgradeOpen(req);
  }

  return undefined;
}

async function handleUpdateCheckOpen(): Promise<Response> {
  // 仅开源路径：动态加载，managed build 的死分支不编入 update-check。
  try {
    const { checkForUpdate } = await import('../system/update-check');
    return json(await checkForUpdate());
  } catch {
    return json({ error: t('apiError.updateCheckFailed') }, 502);
  }
}

async function handleUpgradeStatusOpen(): Promise<Response> {
  const { upgradeController } = await import('../system/upgrade');
  return json(upgradeController.status());
}

async function handleStartUpgradeOpen(req: Request): Promise<Response> {
  const info = getSystemInfo();
  if (!info.canSelfUpdate) {
    return json({ error: t('apiError.upgradeNotAllowed') }, 403);
  }

  let version = '';
  try {
    const body = (await req.json()) as StartUpgradeRequest;
    version = (body?.version ?? '').trim();
  } catch {
    version = '';
  }

  if (!version) {
    return json({ error: t('apiError.upgradeVersionRequired') }, 400);
  }

  const { upgradeController } = await import('../system/upgrade');
  const started = upgradeController.start(version);
  if (!started) {
    return json({ ...upgradeController.status(), error: t('apiError.upgradeInProgress') }, 409);
  }

  return json(upgradeController.status());
}
