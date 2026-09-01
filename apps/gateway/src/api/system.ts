import type { StartUpgradeRequest } from '@tmex/shared';
import { t } from '../i18n';
import { getAccessAddresses } from '../system/access-addresses';
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
    return json({ ...getSystemInfo(), upgradeCapabilities: ['staged-package'] });
  }

  if (path === '/api/system/addresses' && req.method === 'GET') {
    return json(getAccessAddresses());
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

  if (path === '/api/system/upgrade/package' && req.method === 'PUT') {
    if (managed) return managedExternallyResponse();
    return handleStagePackageOpen(req);
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
  const { readLocalUpgradeStatus } = await import('../system/upgrade-service');
  return json(await readLocalUpgradeStatus());
}

export const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function isReleaseVersion(value: string): boolean {
  return RELEASE_VERSION_PATTERN.test(value);
}

async function handleStartUpgradeOpen(req: Request): Promise<Response> {
  let version = '';
  let source: 'release' | 'staged' = 'release';
  let sha256: string | undefined;
  try {
    const body = (await req.json()) as StartUpgradeRequest;
    version = (body?.version ?? '').trim();
    if (body?.source === 'staged' || body?.source === 'release') source = body.source;
    if (typeof body?.sha256 === 'string' && body.sha256.trim()) sha256 = body.sha256.trim();
  } catch {
    version = '';
  }

  if (!version || !isReleaseVersion(version)) {
    return json({ error: t('apiError.upgradeVersionRequired') }, 400);
  }

  const { startLocalUpgradeAttempt } = await import('../system/upgrade-service');
  const result = await startLocalUpgradeAttempt(version, { source, sha256 });
  if (!result.ok && result.code === 'UPGRADE_NOT_ALLOWED') {
    return json({ error: t('apiError.upgradeNotAllowed') }, 403);
  }
  if (!result.ok && result.code === 'PACKAGE_NOT_STAGED') {
    return json({ code: 'PACKAGE_NOT_STAGED' }, 409);
  }
  if (!result.ok) {
    return json({ ...result.status, error: t('apiError.upgradeInProgress') }, 409);
  }
  return json(result.status);
}

const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

async function handleStagePackageOpen(req: Request): Promise<Response> {
  const info = getSystemInfo();
  if (!info.canSelfUpdate) {
    return json({ error: t('apiError.upgradeNotAllowed') }, 403);
  }
  const url = new URL(req.url);
  const version = (url.searchParams.get('version') ?? '').trim();
  const sha256 = (url.searchParams.get('sha256') ?? '').trim();
  if (!version || !isReleaseVersion(version) || !SHA256_HEX.test(sha256)) {
    return json({ error: t('apiError.upgradeVersionRequired') }, 400);
  }
  const { upgradeController } = await import('../system/upgrade');
  const result = await upgradeController.stagePackage(version, sha256, req.body);
  if (!result.ok && result.code === 'UPGRADE_IN_PROGRESS') {
    return json({ code: 'UPGRADE_IN_PROGRESS' }, 409);
  }
  if (!result.ok) {
    return json({ code: result.code }, result.status);
  }
  return json({ version: result.version, sha256: result.sha256, bytes: result.bytes });
}
