import type { StartUpgradeRequest } from '@tmex/shared';
import { t } from '../i18n';
import { MESH_VIA_SELF, getMeshRequestContext } from '../mesh/mesh-deps';
import { requestDispatchContext } from '../mesh/types';
import { getAccessAddresses } from '../system/access-addresses';
import { MANAGED_EXTERNALLY, getSystemInfo, isManagedExternally } from '../system/info-public';
import { STAGED_PACKAGE_MAX_BYTES } from '../system/upgrade';
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

function isManaged(): boolean {
  return isManagedBuild() || isManagedExternally();
}

export function handleSystemApiRequest(
  req: Request,
  path: string
): Response | Promise<Response> | undefined {
  if (path === '/api/system/info' && req.method === 'GET') {
    return json({
      ...getSystemInfo(),
      upgradeCapabilities: [
        'staged-package',
        'upgrade-cancel',
        'uninstall',
        'staged-package-resume',
      ],
    });
  }

  if (path === '/api/system/addresses' && req.method === 'GET') {
    return json(getAccessAddresses());
  }

  const upgrade = handleUpgradeApiRequest(req, path);
  if (upgrade !== undefined) return upgrade;

  return handleUninstallApiRequest(req, path);
}

function handleUpgradeApiRequest(
  req: Request,
  path: string
): Response | Promise<Response> | undefined {
  if (path === '/api/system/update-check') {
    if (req.method !== 'GET') return undefined;
    if (isManaged()) return managedExternallyResponse();
    return handleUpdateCheckOpen();
  }
  if (path === '/api/system/upgrade') return dispatchUpgradeCollection(req);
  if (path === '/api/system/upgrade/package') return dispatchUpgradePackage(req);
  return undefined;
}

function dispatchUpgradeCollection(req: Request): Response | Promise<Response> | undefined {
  if (req.method === 'GET') {
    if (isManaged()) return managedExternallyResponse();
    return handleUpgradeStatusOpen();
  }
  if (req.method === 'POST') {
    if (isManaged()) return managedExternallyResponse();
    return handleStartUpgradeOpen(req);
  }
  if (req.method === 'DELETE') {
    if (isManaged()) return managedExternallyResponse();
    return handleCancelUpgradeOpen();
  }
  return undefined;
}

function dispatchUpgradePackage(req: Request): Response | Promise<Response> | undefined {
  if (req.method === 'PUT') {
    if (isManaged()) return managedExternallyResponse();
    return handleStagePackageOpen(req);
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (isManaged()) return managedExternallyResponse();
    return handleStagedPackageStatusOpen(req);
  }
  if (req.method === 'DELETE') {
    if (isManaged()) return managedExternallyResponse();
    return handleDeleteStagedPackageOpen(req);
  }
  return undefined;
}

function handleUninstallApiRequest(
  req: Request,
  path: string
): Response | Promise<Response> | undefined {
  if (path !== '/api/system/uninstall') return undefined;
  if (req.method === 'GET') return handleUninstallStatusOpen(req);
  if (req.method === 'POST') {
    if (!requestIsStagedAuthenticated(req)) {
      return json({ code: 'UNAUTHORIZED' }, 401);
    }
    if (isManaged()) {
      return json({ code: 'UNINSTALL_NOT_ALLOWED', reason: 'managed' }, 409);
    }
    return handleStartUninstallOpen(req);
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

function requestIsStagedAuthenticated(req: Request): boolean {
  const dispatch = requestDispatchContext.get(req);
  if (dispatch) {
    if (dispatch.viaNodeId !== MESH_VIA_SELF) return true;
    if (dispatch.uid) return true;
  }
  const ctx = getMeshRequestContext(req);
  return Boolean(ctx.sid && ctx.uid);
}

function stagedRequiresAuth(): Response {
  return json({ code: 'UPGRADE_NOT_ALLOWED', reason: 'staged_requires_auth' }, 403);
}

type StartUpgradeParsed =
  | { error: Response }
  | { version: string; source: 'release' | 'staged'; sha256?: string };

async function parseStartUpgradeRequest(req: Request): Promise<StartUpgradeParsed> {
  let version = '';
  let source: 'release' | 'staged' = 'release';
  let sha256: string | undefined;
  try {
    const body = (await req.json()) as StartUpgradeRequest;
    version = (body?.version ?? '').trim();
    if (body?.source !== undefined && body.source !== 'staged' && body.source !== 'release') {
      return { error: json({ error: t('apiError.upgradeVersionRequired') }, 400) };
    }
    if (body?.source === 'staged' || body?.source === 'release') source = body.source;
    if (typeof body?.sha256 === 'string' && body.sha256.trim()) sha256 = body.sha256.trim();
  } catch {
    version = '';
  }
  if (!version || !isReleaseVersion(version)) {
    return { error: json({ error: t('apiError.upgradeVersionRequired') }, 400) };
  }
  return { version, source, sha256 };
}

async function handleStartUpgradeOpen(req: Request): Promise<Response> {
  const parsed = await parseStartUpgradeRequest(req);
  if ('error' in parsed) return parsed.error;
  if (parsed.source === 'staged' && !requestIsStagedAuthenticated(req)) {
    return stagedRequiresAuth();
  }
  const { startLocalUpgradeAttempt } = await import('../system/upgrade-service');
  const result = await startLocalUpgradeAttempt(parsed.version, {
    source: parsed.source,
    sha256: parsed.sha256,
  });
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

async function handleCancelUpgradeOpen(): Promise<Response> {
  const { upgradeController } = await import('../system/upgrade');
  const result = await upgradeController.cancel();
  if (!result.ok) {
    return json({ code: result.code, ...result.status }, 409);
  }
  return json(result.status);
}

async function handleDeleteStagedPackageOpen(req: Request): Promise<Response> {
  if (!requestIsStagedAuthenticated(req)) {
    return stagedRequiresAuth();
  }
  const info = getSystemInfo();
  if (!info.canSelfUpdate) {
    return json({ error: t('apiError.upgradeNotAllowed') }, 403);
  }
  const url = new URL(req.url);
  const version = (url.searchParams.get('version') ?? '').trim();
  if (!version || !isReleaseVersion(version)) {
    return json({ error: t('apiError.upgradeVersionRequired') }, 400);
  }
  const { upgradeController } = await import('../system/upgrade');
  const result = await upgradeController.removeStagedPackage(version);
  if (!result.ok) {
    return json({ code: 'PACKAGE_NOT_STAGED' }, 404);
  }
  return json({ ok: true });
}

const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

type StagedPackageQuery = { error: Response } | { version: string; sha256: string };

function parseStagedPackageQuery(req: Request): StagedPackageQuery {
  const url = new URL(req.url);
  const version = (url.searchParams.get('version') ?? '').trim();
  const sha256 = (url.searchParams.get('sha256') ?? '').trim();
  if (!version || !isReleaseVersion(version) || !SHA256_HEX.test(sha256)) {
    return { error: json({ error: t('apiError.upgradeVersionRequired') }, 400) };
  }
  return { version, sha256: sha256.toLowerCase() };
}

/** `offset` 缺省 / 0 = 从头写；非法值一律按 0 处理，服务端再用 409 纠偏。 */
function parseStagedPackageOffset(req: Request): number {
  const raw = new URL(req.url).searchParams.get('offset');
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}

function emptyBodyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

function rejectStagedPackageRequest(req: Request): Response | null {
  if (!requestIsStagedAuthenticated(req)) return stagedRequiresAuth();
  if (!getSystemInfo().canSelfUpdate) {
    return json({ error: t('apiError.upgradeNotAllowed') }, 403);
  }
  return null;
}

async function handleStagedPackageStatusOpen(req: Request): Promise<Response> {
  const blocked = rejectStagedPackageRequest(req);
  if (blocked) return blocked;
  const parsed = parseStagedPackageQuery(req);
  if ('error' in parsed) return parsed.error;
  const { upgradeController } = await import('../system/upgrade');
  const result = await upgradeController.stagedPackageStatus(parsed.version, parsed.sha256);
  if (!result.ok) return json({ code: result.code }, result.status);
  return json({
    version: result.version,
    sha256: result.sha256,
    receivedBytes: result.receivedBytes,
    complete: result.complete,
  });
}

async function handleStagePackageOpen(req: Request): Promise<Response> {
  const blocked = rejectStagedPackageRequest(req);
  if (blocked) return blocked;
  const parsed = parseStagedPackageQuery(req);
  if ('error' in parsed) return parsed.error;
  const offset = parseStagedPackageOffset(req);
  const declared = Number(req.headers.get('content-length') ?? '');
  const hasLength = Number.isFinite(declared) && declared > 0;
  if (hasLength && declared + offset > STAGED_PACKAGE_MAX_BYTES) {
    return json({ code: 'PACKAGE_TOO_LARGE' }, 413);
  }
  // offset > 0 且没有请求体：整长度 `.part` 的收尾校验，走空流让它照常校验 sha256 并提交
  const body = req.body ?? (offset > 0 ? emptyBodyStream() : null);
  const { upgradeController } = await import('../system/upgrade');
  const result = await upgradeController.stagePackage(parsed.version, parsed.sha256, body, {
    offset,
    expectedBytes: hasLength ? offset + declared : undefined,
  });
  if (
    !result.ok &&
    (result.code === 'UPGRADE_OFFSET_MISMATCH' || result.code === 'PACKAGE_INCOMPLETE')
  ) {
    return json({ code: result.code, receivedBytes: result.receivedBytes }, result.status);
  }
  if (!result.ok) {
    return json({ code: result.code }, result.status);
  }
  return json({ version: result.version, sha256: result.sha256, bytes: result.bytes });
}

async function handleStartUninstallOpen(req: Request): Promise<Response> {
  const { startLocalUninstall } = await import('../system/uninstall');
  return startLocalUninstall(req);
}

async function handleUninstallStatusOpen(req: Request): Promise<Response> {
  const { readLocalUninstallStatus, requireUninstallAuth } = await import('../system/uninstall');
  if (!requireUninstallAuth(req)) {
    return json({ code: 'UNAUTHORIZED' }, 401);
  }
  return json(readLocalUninstallStatus());
}
