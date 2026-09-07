import { MeshRelayStore } from '../../../../apps/gateway/src/auth/mesh-relay-store';
import { nodeIdentity } from '../../../../apps/gateway/src/db/schema';
import type { MeshRuntime } from '../../../../apps/gateway/src/mesh/mesh-runtime';
import { computeRecordHash, encodeBase64url } from '../../../shared/src/auth';
import type { LocalAuthContext } from '../lib/local-auth';
import type { AssembledFetch } from './assemble-routes';

function diagnosticUser(auth: LocalAuthContext) {
  const identity = auth.db.select({ userId: nodeIdentity.userId }).from(nodeIdentity).get();
  return (
    (identity?.userId ? auth.userStore.getById(identity.userId) : null) ??
    auth.userStore.listUsers()[0]
  );
}

type DiagnosticKeyLogHead = { seq: number; hash: string };
type DiagnosticKeyLogStatus = {
  userId: string | null;
  local: DiagnosticKeyLogHead | null;
  remote: DiagnosticKeyLogHead | null;
  remoteKind: 'hub' | 'relay' | null;
  localAtRemote: string | null;
  remoteAtLocal: string | null;
  error?: string;
};

async function readDiagnosticKeyLogStatus(
  auth: LocalAuthContext,
  mesh: MeshRuntime | null
): Promise<DiagnosticKeyLogStatus> {
  const user = diagnosticUser(auth);
  const local = user ? auth.keyLogStore.head(user.id) : null;
  const status: DiagnosticKeyLogStatus = {
    userId: user?.id ?? null,
    local: local ? { seq: Number(local.seq), hash: encodeBase64url(local.hash) } : null,
    remote: null,
    remoteKind: mesh ? new MeshRelayStore(auth.db).uplinkKind() : null,
    localAtRemote: null,
    remoteAtLocal: null,
  };
  if (!local || !user) return { ...status, error: 'local_head_unavailable' };
  if (!mesh) return { ...status, error: 'mesh_unavailable' };
  try {
    const remote = await mesh.uplink.queryHubHead();
    if (!remote) return { ...status, error: 'remote_head_unavailable' };
    status.remote = { seq: Number(remote.seq), hash: encodeBase64url(remote.hash) };
    if (BigInt(remote.seq) < local.seq) {
      const common = auth.keyLogStore.getAtSeq(user.id, Number(remote.seq));
      if (!common) return { ...status, error: 'common_head_unavailable' };
      status.localAtRemote = encodeBase64url(common.hash);
    } else if (BigInt(remote.seq) > local.seq) {
      const common = await mesh.uplink.queryKeyLogAt(local.seq);
      if (!common) return { ...status, error: 'common_head_unavailable' };
      status.remoteAtLocal = encodeBase64url(computeRecordHash(common.bytes, common.sig));
    }
    return status;
  } catch {
    return { ...status, error: 'uplink_unavailable' };
  }
}

export function withRuntimeDiagnostics(
  dispatch: AssembledFetch,
  auth: LocalAuthContext,
  mesh: MeshRuntime | null,
  degraded: 'master_key_mismatch' | null
): AssembledFetch {
  return async (req, server) => {
    const path = new URL(req.url).pathname;
    if (path === '/api/mesh/keylog/status') {
      const address = server.requestIP?.(req)?.address;
      const forwarded = ['forwarded', 'x-forwarded-for', 'x-real-ip', 'cf-connecting-ip'].some(
        (name) => req.headers.has(name)
      );
      if (
        forwarded ||
        (address !== '::1' && !/^(?:::ffff:)?127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(address ?? ''))
      ) {
        return Response.json({ error: { code: 'LOOPBACK_REQUIRED' } }, { status: 403 });
      }
      if (req.method !== 'GET')
        return Response.json({ error: { code: 'METHOD_NOT_ALLOWED' } }, { status: 405 });
      return Response.json(await readDiagnosticKeyLogStatus(auth, mesh));
    }
    const response = await dispatch(req, server);
    if (!degraded || req.method !== 'GET' || path !== '/healthz' || !response?.ok) return response;
    const body = await response.json();
    return Response.json(
      { ...body, degraded },
      { status: response.status, headers: response.headers }
    );
  };
}
