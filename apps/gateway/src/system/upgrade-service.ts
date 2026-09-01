import { UPGRADE_CANCELLED, type UpgradeState, type UpgradeStatus } from '@tmex/shared';
import { nodeSessionCookieName, parseCookies } from '../auth/cookies';
import type { UserStore } from '../auth/user-store';
import { MESH_VIA_SELF } from '../mesh/mesh-deps';
import { jsonBody, jsonError } from '../mesh/session-middleware';
import { getSystemInfo } from './info-public';
import {
  cancelRemoteUpgradeJob,
  consumeHandedOffJob,
  getRemoteUpgradeJob,
  hasRunningRemoteUpgradeJob,
  startRemoteUpgradeJob,
} from './remote-upgrade-job';
import { compareVersions } from './semver';
import { requireLatestUpgradeRelease } from './update-check';

const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const REMOTE_UPGRADE_JSON_MAX_BYTES = 64 * 1024;
const UPGRADE_STATES = new Set<UpgradeState>(['idle', 'downloading', 'executing']);

export type AuthorizedUpgradeForwardInput = {
  nodeId: string;
  method: string;
  path: string;
  query?: string;
  body?: unknown;
  rawBody?: ReadableStream<Uint8Array>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

export type AuthorizedUpgradeForward = {
  forwardAuthorizedHttp: (req: Request, input: AuthorizedUpgradeForwardInput) => Promise<Response>;
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
  if (local) {
    const blocked = await rejectLocalUpgradePreflight(resolvedId);
    if (blocked) return blocked;
  } else if (!readNodeSession(req, nodeId)) {
    return jsonError('NODE_LOGIN_REQUIRED', 401, { nodeId });
  }

  if (!local && hasRunningRemoteUpgradeJob(resolvedId)) {
    return jsonError('UPGRADE_IN_PROGRESS', 409, { nodeId: resolvedId });
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
  consumeHandedOffJob(nodeId);
  const job = getRemoteUpgradeJob(nodeId);
  if (job?.state === 'running') {
    return jsonBody({
      state: 'downloading' as const,
      targetVersion: job.targetVersion,
      error: null,
      startedAt: job.startedAt,
    });
  }
  if (job?.state === 'failed') {
    return jsonBody({
      state: 'idle' as const,
      targetVersion: null,
      error: job.error,
      startedAt: job.startedAt,
    });
  }
  if (job?.state === 'cancelled') {
    return jsonBody({
      state: 'idle' as const,
      targetVersion: null,
      error: UPGRADE_CANCELLED,
      startedAt: job.startedAt,
    });
  }
  const upstream = await forward.forwardAuthorizedHttp(req, {
    nodeId,
    method: 'GET',
    path: '/api/system/upgrade',
  });
  return mapForwardedUpgradeResponse(nodeId, upstream);
}

export async function handleMeshNodeUpgradeCancel(opts: {
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
  if (local) {
    const { upgradeController } = await import('./upgrade');
    const result = await upgradeController.cancel();
    if (result.ok) return jsonBody(result.status);
    return jsonError(result.code, 409, { ...result.status, nodeId: resolvedId });
  }
  if (!readNodeSession(req, nodeId)) {
    return jsonError('NODE_LOGIN_REQUIRED', 401, { nodeId });
  }

  const jobCancel = await cancelRemoteUpgradeJob({ nodeId, req, forward });
  if (jobCancel.handled === 'unsupported') {
    return jsonError('UPGRADE_CANCEL_UNSUPPORTED', 501, { nodeId });
  }
  if (jobCancel.handled === true) {
    return jsonBody({
      state: 'idle' as const,
      targetVersion: null,
      error: UPGRADE_CANCELLED,
      startedAt: jobCancel.snapshot.startedAt,
    });
  }

  const upstream = await forward.forwardAuthorizedHttp(req, {
    nodeId,
    method: 'DELETE',
    path: '/api/system/upgrade',
  });
  return mapForwardedUpgradeCancelResponse(nodeId, upstream);
}

export async function readLocalUpgradeStatus(): Promise<UpgradeStatus> {
  const { upgradeController } = await import('./upgrade');
  return upgradeController.status();
}

export async function startLocalUpgradeAttempt(
  version: string,
  opts?: { source?: 'release' | 'staged'; sha256?: string }
): Promise<
  | { ok: true; status: UpgradeStatus }
  | {
      ok: false;
      code: 'UPGRADE_NOT_ALLOWED' | 'UPGRADE_IN_PROGRESS' | 'PACKAGE_NOT_STAGED';
      status: UpgradeStatus;
    }
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
  const started = upgradeController.tryStart(version, opts);
  const status = upgradeController.status();
  if (!started.ok) {
    return { ok: false, code: started.code, status };
  }
  return { ok: true, status };
}

async function mapForwardedUpgradeCancelResponse(
  nodeId: string,
  upstream: Response
): Promise<Response> {
  if (upstream.status === 404) {
    discardUpstreamBody(upstream);
    return jsonError('UPGRADE_CANCEL_UNSUPPORTED', 501, { nodeId });
  }
  if (upstream.status === 403) {
    discardUpstreamBody(upstream);
    return jsonError('UPGRADE_NOT_ALLOWED', 403, { nodeId });
  }
  if (upstream.status === 409) {
    const parsed = await readBoundedJsonObject(upstream);
    const extra = parsed.ok ? pickUpgradeStatusFields(parsed.value) : {};
    const rawCode = parsed.ok ? parsed.value.code : null;
    const code =
      rawCode === 'UPGRADE_NOT_CANCELLABLE' || rawCode === 'UPGRADE_NOT_RUNNING'
        ? rawCode
        : 'UPGRADE_NOT_CANCELLABLE';
    return jsonError(code, 409, { ...extra, nodeId });
  }
  return upstream;
}

export async function mapForwardedUpgradeResponse(
  nodeId: string,
  upstream: Response
): Promise<Response> {
  if (upstream.status === 404) {
    discardUpstreamBody(upstream);
    return jsonError('UPGRADE_UNSUPPORTED', 404, { nodeId });
  }
  if (upstream.status === 403) {
    discardUpstreamBody(upstream);
    return jsonError('UPGRADE_NOT_ALLOWED', 403, { nodeId });
  }
  if (upstream.status === 409) {
    const parsed = await readBoundedJsonObject(upstream);
    const extra = parsed.ok ? pickUpgradeStatusFields(parsed.value) : {};
    return jsonError('UPGRADE_IN_PROGRESS', 409, { ...extra, nodeId });
  }
  return upstream;
}

async function rejectLocalUpgradePreflight(nodeId: string): Promise<Response | null> {
  const info = getSystemInfo();
  if (!info.canSelfUpdate) {
    return jsonError('UPGRADE_NOT_ALLOWED', 403, { nodeId });
  }
  const status = await readLocalUpgradeStatus();
  if (status.state !== 'idle') {
    return jsonError('UPGRADE_IN_PROGRESS', 409, { nodeId, ...status });
  }
  return null;
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
  const parsed = await readBoundedJsonObject(infoRes);
  if (!parsed.ok) {
    return jsonError('NODE_UNREACHABLE', 503, { nodeId });
  }
  const info = parsed.value;
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

  if (hasStagedPackageCapability(info.upgradeCapabilities)) {
    const started = startRemoteUpgradeJob({
      nodeId,
      version: latestVersion,
      req,
      forward,
      upgradeCapabilities: readUpgradeCapabilities(info.upgradeCapabilities),
    });
    if (!started.ok) {
      return jsonError('UPGRADE_IN_PROGRESS', 409, { nodeId });
    }
    return jsonBody({
      state: 'downloading',
      targetVersion: latestVersion,
      error: null,
      startedAt: started.snapshot.startedAt,
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

function hasStagedPackageCapability(raw: unknown): boolean {
  return readUpgradeCapabilities(raw).includes('staged-package');
}

function readUpgradeCapabilities(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string');
}

function readNodeSession(req: Request, nodeId: string): string | null {
  return parseCookies(req.headers.get('cookie')).get(nodeSessionCookieName(nodeId)) ?? null;
}

function pickUpgradeStatusFields(raw: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (typeof raw.state === 'string' && UPGRADE_STATES.has(raw.state as UpgradeState)) {
    extra.state = raw.state;
  }
  for (const key of ['targetVersion', 'error', 'startedAt'] as const) {
    const value = raw[key];
    if (typeof value === 'string' || value === null) extra[key] = value;
  }
  return extra;
}

function discardUpstreamBody(res: Response): void {
  void res.body?.cancel().catch(() => {});
}

type BoundedJson = { ok: true; value: Record<string, unknown> } | { ok: false };

async function readBoundedJsonObject(res: Response): Promise<BoundedJson> {
  const raw = await readBodyLimited(res, REMOTE_UPGRADE_JSON_MAX_BYTES);
  if (!raw.ok) return { ok: false };
  try {
    const parsed: unknown = JSON.parse(raw.text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> };
    }
  } catch {
    // unparsable or empty
  }
  return { ok: false };
}

async function readBodyLimited(
  response: Response,
  limit: number
): Promise<{ ok: true; text: string } | { ok: false }> {
  const reader = response.body?.getReader();
  if (!reader) return { ok: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (total + value.byteLength > limit) {
        await reader.cancel().catch(() => {});
        return { ok: false };
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    await reader.cancel().catch(() => {});
    return { ok: false };
  }
  return { ok: true, text: new TextDecoder().decode(Buffer.concat(chunks, total)) };
}
