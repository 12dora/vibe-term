import { ChallengeStore } from '../../../../apps/gateway/src/auth/challenge-store';
import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import { NodeIdentityStore } from '../../../../apps/gateway/src/auth/node-identity-store';
import { config as gatewayConfig } from '../../../../apps/gateway/src/config';
import { CryptoDecryptError } from '../../../../apps/gateway/src/crypto/errors';
import { getStoredSiteSettings, updateSiteSettings } from '../../../../apps/gateway/src/db';
import {
  LocalAuthStore,
  readLocalAuthEffective,
} from '../../../../apps/gateway/src/db/local-auth-settings';
import { nodeIdentity } from '../../../../apps/gateway/src/db/schema';
import { MeshHttpRuntime } from '../../../../apps/gateway/src/mesh/mesh-http';
import type {
  CreateMeshRuntimeOptions,
  MeshRuntime,
} from '../../../../apps/gateway/src/mesh/mesh-runtime';
import type { LoadNative } from '../../../../apps/gateway/src/mesh/rtc';
import type { GatewayRuntime } from '../../../../apps/gateway/src/runtime';
import { broadcastSettingsUpdate } from '../../../../apps/gateway/src/settings/broadcaster';
import { resolveInstallDir as resolveGatewayInstallDir } from '../../../../apps/gateway/src/system/install-info';
import { decodeCertificate } from '../../../shared/src/auth';
import { type LocalAuthContext, createAuthContextFromDb } from '../lib/local-auth';
import { loadNodeDatachannel } from '../lib/native-datachannel';
import type { VibeTermRoles } from '../lib/roles';
import type { TlsService } from '../tls/tls-service';
import { advertisedTlsInfo } from './assemble-routes';
import { resolveSetupEnvPath } from './setup-service';

export const MASTER_KEY_RECOVERY_HINT =
  'Restore VIBETERM_MASTER_KEY from backups/app.env.* and restart; if the key is lost, run vibeterm mesh reset-identity and re-join. Reconfigure other affected encrypted credentials locally.';

/** `relay` 单跑（不带 node）：无前端、无用户存储、无 tmux 依赖。 */
export function isRelayOnly(roles: VibeTermRoles): boolean {
  return roles.relay && !roles.node;
}

type AssembleAuthOpts = {
  roles?: VibeTermRoles;
  loadNative?: LoadNative;
  nativeDir?: string;
  localAuthEffective?: () => boolean;
};

async function standaloneNodeKeys(identityStore: LocalAuthContext['identityStore']) {
  try {
    return await ensureNodeIdentity(identityStore);
  } catch {
    return { nodeIdHex: '00'.repeat(16), edPublicKey: new Uint8Array(32) };
  }
}

async function createStandaloneAuthHttp(input: {
  roles: VibeTermRoles;
  gateway: GatewayRuntime;
  auth: LocalAuthContext;
  localAuthEffective?: () => boolean;
  tlsSlot: { service?: TlsService };
  keys?: { nodeIdHex: string; edPublicKey: Uint8Array };
}): Promise<MeshHttpRuntime> {
  const keys = input.keys ?? (await standaloneNodeKeys(input.auth.identityStore));
  const runtime = new MeshHttpRuntime({
    roles: input.roles,
    nodeId: keys.nodeIdHex,
    nodePk: keys.edPublicKey,
    userStore: input.auth.userStore,
    keyLogService: input.auth.userKeys,
    challengeStore: new ChallengeStore(),
    nodeSessionStore: input.auth.nodeSessionStore,
    publisher: { publish() {} },
    authSurfaceOnly: true,
    trustProxy: gatewayConfig.trustProxy,
    localAuth: new LocalAuthStore(input.gateway.db),
    localAuthEffective: input.localAuthEffective,
  });
  runtime.auth.setTlsInfo(() => advertisedTlsInfo(input.tlsSlot.service));
  return runtime;
}

export function syncLocalSiteNameFromMesh(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const current = getStoredSiteSettings();
  if (current.siteName === trimmed) return;
  updateSiteSettings({ siteName: trimmed });
  broadcastSettingsUpdate('site');
}

async function createNodeMesh(input: {
  roles: VibeTermRoles;
  gateway: GatewayRuntime;
  createMesh: (opts: CreateMeshRuntimeOptions) => Promise<MeshRuntime>;
  loadNative?: LoadNative;
  nativeDir?: string;
  tlsSlot: { service?: TlsService };
  onLocalNodeName?: (name: string) => void;
}): Promise<MeshRuntime> {
  const nativeDir = input.nativeDir ?? process.env.VIBETERM_NATIVE_DIR ?? '';
  const identity = await new NodeIdentityStore(input.gateway.db).load();
  const opts: CreateMeshRuntimeOptions = {
    db: input.gateway.db,
    gateway: input.gateway,
    config: {
      roles: input.roles,
      peerPort: gatewayConfig.peerPort,
      stunServers: gatewayConfig.stunServers,
      stunSource: gatewayConfig.stunSource,
      turnUrl: gatewayConfig.turnUrl,
      turnUsername: gatewayConfig.turnUsername,
      turnCredential: gatewayConfig.turnCredential,
      bindHost: process.env.VIBETERM_BIND_HOST || '127.0.0.1',
      peerBindHost: gatewayConfig.peerBindHost,
    },
    canLoadNative: () =>
      process.env.VIBETERM_DIRECT_ENABLED !== 'false' &&
      (input.loadNative !== undefined || nativeDir.length > 0),
    loadNative:
      input.loadNative ??
      (async () =>
        process.env.VIBETERM_DIRECT_ENABLED === 'false' || !nativeDir
          ? null
          : loadNodeDatachannel({ nativeDir })),
    userId: identity?.userId ?? undefined,
    tlsInfo: () => advertisedTlsInfo(input.tlsSlot.service),
    onLocalNodeName: input.onLocalNodeName,
  };
  return input.createMesh(opts);
}

function assembleAuthEnv(): Record<string, string> {
  return {
    VIBETERM_ROLES: process.env.VIBETERM_ROLES ?? '',
  };
}

async function createDegradedNodeAuth(input: {
  roles: VibeTermRoles;
  gateway: GatewayRuntime;
  auth: LocalAuthContext;
  tlsSlot: { service?: TlsService };
}): Promise<MeshHttpRuntime> {
  const row = input.gateway.db.select({ nodeId: nodeIdentity.nodeId }).from(nodeIdentity).get();
  const cert = row ? input.auth.userStore.getCert(row.nodeId) : null;
  return createStandaloneAuthHttp({
    roles: input.roles,
    gateway: input.gateway,
    auth: input.auth,
    tlsSlot: input.tlsSlot,
    keys: {
      nodeIdHex: row?.nodeId ?? '00'.repeat(16),
      edPublicKey: cert ? decodeCertificate(cert.certificateBytes).ed_pk : new Uint8Array(32),
    },
  });
}

async function createNodeAuthSurface(input: {
  roles: VibeTermRoles;
  gateway: GatewayRuntime;
  auth: LocalAuthContext;
  opts: AssembleAuthOpts;
  createMesh: (opts: CreateMeshRuntimeOptions) => Promise<MeshRuntime>;
  tlsSlot: { service?: TlsService };
  onLocalNodeName?: (name: string) => void;
}): Promise<{
  mesh: MeshRuntime | null;
  authHttp: MeshHttpRuntime | null;
  degraded: 'master_key_mismatch' | null;
}> {
  try {
    const mesh = await createNodeMesh({
      roles: input.roles,
      gateway: input.gateway,
      createMesh: input.createMesh,
      loadNative: input.opts.loadNative,
      nativeDir: input.opts.nativeDir,
      tlsSlot: input.tlsSlot,
      onLocalNodeName: input.onLocalNodeName,
    });
    return { mesh, authHttp: null, degraded: null };
  } catch (error) {
    if (!(error instanceof CryptoDecryptError) || error.context.scope !== 'node_identity') {
      throw error;
    }
    console.error(
      `[vibeterm][mesh] master_key_mismatch; mesh disabled, local login remains available. ${MASTER_KEY_RECOVERY_HINT}`,
      error
    );
    return {
      mesh: null,
      authHttp: await createDegradedNodeAuth(input),
      degraded: 'master_key_mismatch',
    };
  }
}

export function resolveLocalAuthEffective(
  injected: (() => boolean) | undefined,
  authHttp: MeshHttpRuntime | null
): () => boolean {
  if (injected) return injected;
  if (!authHttp) return readLocalAuthEffective;
  return () => {
    try {
      return authHttp.auth.isLocalAuthEffective();
    } catch {
      return false;
    }
  };
}

export async function createAssembleAuthSurface(input: {
  roles: VibeTermRoles;
  gateway: GatewayRuntime;
  opts: AssembleAuthOpts;
  createMesh: (opts: CreateMeshRuntimeOptions) => Promise<MeshRuntime>;
  tlsSlot: { service?: TlsService };
  onLocalNodeName?: (name: string) => void;
}) {
  const auth = await createAuthContextFromDb(input.gateway.db, {
    installDir: resolveGatewayInstallDir(),
    envPath: resolveSetupEnvPath(),
    env: assembleAuthEnv(),
  });
  if (isRelayOnly(input.roles)) {
    return {
      auth,
      mesh: null,
      authHttp: null,
      degraded: null,
    };
  }
  if (input.roles.node) {
    const surface = await createNodeAuthSurface({ ...input, auth });
    return {
      auth,
      ...surface,
    };
  }
  const authHttp = await createStandaloneAuthHttp({
    roles: input.roles,
    gateway: input.gateway,
    auth,
    localAuthEffective: input.opts.localAuthEffective,
    tlsSlot: input.tlsSlot,
  });
  return { auth, mesh: null, authHttp, degraded: null };
}
