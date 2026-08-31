import type { UpgradeStatus } from '@tmex/shared';
import { nodeSessionCookieName, parseCookies } from '../auth/cookies';
import type { UserStore } from '../auth/user-store';
import { MESH_VIA_SELF } from '../mesh/mesh-deps';
import { jsonBody, jsonError } from '../mesh/session-middleware';
import { getSystemInfo } from './info-public';
import { compareVersions } from './semver';
import { requireLatestUpgradeRelease } from './update-check';

const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export type AuthorizedUpgradeForward = {
  forwardAuthorizedHttp: (
    req: Request,
    input: { nodeId: string; method: string; path: string; body?: unknown }
  ) => Promise<Response>;
};

export function isLocalUpgradeNode(localNodeId: string, nodeId: string): boolean {
  return nodeId === localNodeId || nodeId === MESH_VIA_SELF;
}

export function isEnrolledUpgradeableNode(
  localNodeId: string,
  userStore: UserStore,
  nodeId: string
): boolean {
  if (isLocalUpgradeNode(localNodeId, nodeId)) return true;
  const cert = userStore.listCerts().find((row) => row.nodeId === nodeId);
  return cert != null && cert.revokedLogSeq == null;
}

export function isAlreadyAtOrAboveLatest(
  currentVersion: string | null | undefined,
  latestVersion: string
): boolean {
  if (!currentVersion || !RELEASE_VERSION_PATTERN.test(currentVersion.trim())) return false;
  if (!RELEASE_VERSION_PATTERN.test(latestVersion.trim())) return false;
  return compareVersions(currentVersion, latestVersion) >= 0;
}

export async function handleMeshUpgradeLatest(): Promise<Response> {
  try {
    const latest = await requireLatestUpgradeRelease();
    if (!RELEASE_VERSION_PATTERN.test(latest.latestVersion)) {
      return jsonError('RELEASE_UNAVAILABLE', 502);
    }
    return jsonBody(latest);
  } catch {
    return jsonError('RELEASE_UNAVAILABLE', 502);
  }
}

export async function handleMeshNodeUpgradeStart(opts: {
  req: Request;
  nodeId: string;
  localNodeId: string;
  userStore: UserStore;
  forward: AuthorizedUpgradeForward;
}): Promise<Response> {
  const { req, nodeId, localNodeId, userStore, forward } = opts;
  if (!isEnrolledUpgradeableNode(localNodeId, userStore, nodeId)) {
    return jsonError('NOT_FOUND', 404, { nodeId });
  }
  const local = isLocalUpgradeNode(localNodeId, nodeId);
  const resolvedId = local ? localNodeId : nodeId;
  if (!local && !readNodeSession(req, nodeId)) {
    return jsonError('NODE_LOGIN_REQUIRED', 401, { nodeId });
  }

  let latestVersion: string;
  try {
    const latest = await requireLatestUpgradeRelease();
    latestVersion = latest.latestVersion;
  } catch {
    return jsonError('RELEASE_UNAVAILABLE', 502);
  }
  if (!RELEASE_VERSION_PATTERN.test(latestVersion)) {
    return jsonError('RELEASE_UNAVAILABLE', 502);
  }

  if (local) {
    return startLocalMeshUpgrade(resolvedId, latestVersion);
  }
  return startRemoteMeshUpgrade(req, resolvedId, latestVersion, forward);
}

export async function handleMeshNodeUpgradeStatus(opts: {
  req: Request;
  nodeId: string;
  localNodeId: string;
  userStore: UserStore;
  forward: AuthorizedUpgradeForward;
}): Promise<Response> {
  const { req, nodeId, localNodeId, userStore, forward } = opts;
  if (!isEnrolledUpgradeableNode(localNodeId, userStore, nodeId)) {
    return jsonError('NOT_FOUND', 404, { nodeId });
  }
  if (isLocalUpgradeNode(localNodeId, nodeId)) {
    return jsonBody(await readLocalUpgradeStatus());
  }
  if (!readNodeSession(req, nodeId)) {
    return jsonError('NODE_LOGIN_REQUIRED', 401, { nodeId });
  }
  const upstream = await forward.forwardAuthorizedHttp(req, {
    nodeId,
    method: 'GET',
    path: '/api/system/upgrade',
  });
  return mapForwardedUpgradeResponse(nodeId, upstream);
}

export async function readLocalUpgradeStatus(): Promise<UpgradeStatus> {
  const { upgradeController } = await import('./upgrade');
  return upgradeController.status();
}

export async function startLocalUpgradeAttempt(
  version: string
): Promise<
  | { ok: true; status: UpgradeStatus }
  | { ok: false; code: 'UPGRADE_NOT_ALLOWED' | 'UPGRADE_IN_PROGRESS'; status: UpgradeStatus }
> {
  const info = getSystemInfo();
  if (!info.canSelfUpdate) {
    return {
      ok: false,
      code: 'UPGRADE_NOT_ALLOWED',
      status: { state: 'idle', targetVersion: null, error: null, startedAt: null },
    };
  }
  const { upgradeController } = await import('./upgrade');
  const started = upgradeController.start(version);
  const status = upgradeController.status();
  if (!started) {
    return { ok: false, code: 'UPGRADE_IN_PROGRESS', status };
  }
  return { ok: true, status };
}

export async function mapForwardedUpgradeResponse(
  nodeId: string,
  upstream: Response
): Promise<Response> {
  if (upstream.status === 404) {
    return jsonError('UPGRADE_UNSUPPORTED', 404, { nodeId });
  }
  if (upstream.status === 403) {
    return jsonError('UPGRADE_NOT_ALLOWED', 403, { nodeId });
  }
  if (upstream.status === 409) {
    const extra = await readJsonObject(upstream);
    return jsonError('UPGRADE_IN_PROGRESS', 409, { nodeId, ...extra });
  }
  return upstream;
}

async function startLocalMeshUpgrade(nodeId: string, latestVersion: string): Promise<Response> {
  const info = getSystemInfo();
  if (isAlreadyAtOrAboveLatest(info.baseVersion, latestVersion)) {
    return jsonError('UPGRADE_ALREADY_LATEST', 409, { nodeId, version: info.baseVersion });
  }
  const result = await startLocalUpgradeAttempt(latestVersion);
  if (!result.ok && result.code === 'UPGRADE_NOT_ALLOWED') {
    return jsonError('UPGRADE_NOT_ALLOWED', 403, { nodeId });
  }
  if (!result.ok) {
    return jsonError('UPGRADE_IN_PROGRESS', 409, { nodeId, ...result.status });
  }
  return jsonBody(result.status);
}

async function startRemoteMeshUpgrade(
  req: Request,
  nodeId: string,
  latestVersion: string,
  forward: AuthorizedUpgradeForward
): Promise<Response> {
  const infoRes = await forward.forwardAuthorizedHttp(req, {
    nodeId,
    method: 'GET',
    path: '/api/system/info',
  });
  if (infoRes.status !== 200) {
    return mapForwardedUpgradeResponse(nodeId, infoRes);
  }
  const info = await readJsonObject(infoRes);
  const current = typeof info.baseVersion === 'string' ? info.baseVersion : null;
  if (info.canSelfUpdate === false) {
    return jsonError('UPGRADE_NOT_ALLOWED', 403, { nodeId });
  }
  if (isAlreadyAtOrAboveLatest(current, latestVersion)) {
    return jsonError('UPGRADE_ALREADY_LATEST', 409, {
      nodeId,
      version: current ?? latestVersion,
    });
  }

  const started = await forward.forwardAuthorizedHttp(req, {
    nodeId,
    method: 'POST',
    path: '/api/system/upgrade',
    body: { version: latestVersion },
  });
  return mapForwardedUpgradeResponse(nodeId, started);
}

function readNodeSession(req: Request, nodeId: string): string | null {
  return parseCookies(req.headers.get('cookie')).get(nodeSessionCookieName(nodeId)) ?? null;
}

async function readJsonObject(res: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await res.json();
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return {};
}
