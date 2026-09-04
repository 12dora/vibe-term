import { type StateSnapshotPayload, type TmexRoles, isStandaloneRoles } from '@tmex/shared';
import {
  AgentConfirmationAlreadyDecidedError,
  AgentConfirmationNotFoundError,
  agentSupervisor,
} from '../agent/supervisor';
import { config } from '../config';
import { getSiteSettings } from '../db/site-settings';
import { isPeerReachable } from '../mesh/address-class';
import { pickMeshNodeName } from '../mesh/node-list-projection';
import { getDisplayVersion } from '../system/version';
import { tmuxRuntimeRegistry } from '../tmux-client/registry';
import { getDeviceSnapshot } from '../tmux/snapshot-directory';
import {
  type DecideConfirmationResult,
  type MeshNodeView,
  type MessagingRuntimeHooks,
  type TmuxPaneView,
  type TmuxWindowView,
  type UplinkKind,
  type UplinkStatus,
  loadLocalIdentity,
} from './context';

export type MessagingDeviceRuntime = {
  isConnected(): boolean;
  capturePaneText(paneId: string, opts?: { historyLines?: number }): Promise<string>;
  sendInputBytes(paneId: string, data: Uint8Array): void | Promise<void>;
};

export type MeshListedNode = {
  id: string;
  name: string;
  online: boolean;
  version: string | null;
};

export type MeshPresenceSource = {
  nodeId: string;
  hub: object | null;
  uplink: { readonly state: string };
  attachedHub(): { hubNodeId: string | null } | null;
  lastNodeList: { nodes: ReadonlyArray<MeshListedNode> } | null;
  peers: {
    listReach(): Map<string, 'lan' | 'wan' | 'relay' | null>;
  };
  userStore: {
    listCerts(): Array<{ nodeId: string; revokedLogSeq: number | null }>;
    listNodes(): Array<{ id: string; name: string; version: string | null }>;
  };
};

export type MessagingRuntimeHookDeps = {
  getSnapshot?: (deviceId: string) => StateSnapshotPayload | null;
  acquireRuntime?: (deviceId: string) => Promise<MessagingDeviceRuntime>;
  releaseRuntime?: (deviceId: string, runtime: MessagingDeviceRuntime) => Promise<void>;
  resolveConfirmation?: (confirmationId: string, approved: boolean, reason?: string) => void;
  isStandalone?: () => boolean;
  roles?: () => TmexRoles;
  loadIdentity?: () => {
    nodeId: string | null;
    name: string | null;
    uplinkKind: 'hub' | 'relay' | null;
  };
  getMesh?: () => MeshPresenceSource | null;
  getLocalName?: () => string;
  getVersion?: () => string;
};

type LocalIdentity = ReturnType<NonNullable<MessagingRuntimeHookDeps['loadIdentity']>>;

let meshRuntimeAccessor: (() => MeshPresenceSource | null) | null = null;

export function setMessagingMeshRuntime(
  getRuntime: (() => MeshPresenceSource | null) | null
): void {
  meshRuntimeAccessor = getRuntime;
}

export function stripTrailingBlankLines(text: string): string {
  return text.replace(/(?:\r?\n[ \t]*)+$/, '');
}

export function mapSnapshotToWindows(
  snapshot: StateSnapshotPayload | null
): TmuxWindowView[] | null {
  const session = snapshot?.session;
  if (!session) return null;
  return session.windows.map((window) => {
    const windowName = window.customName?.trim() || window.name;
    const panes: TmuxPaneView[] = window.panes.map((pane) => ({
      id: pane.id,
      index: pane.index,
      windowId: window.id,
      windowIndex: window.index,
      windowName,
      title: pane.customName?.trim() || pane.title,
      active: pane.active,
    }));
    return {
      id: window.id,
      name: windowName,
      index: window.index,
      active: window.active,
      panes,
    };
  });
}

function defaultGetMesh(): MeshPresenceSource | null {
  return meshRuntimeAccessor?.() ?? null;
}

function defaultLocalName(): string {
  return loadLocalIdentity().name?.trim() || getSiteSettings().siteName;
}

function resolveUplinkKind(
  standalone: boolean,
  uplinkKind: 'hub' | 'relay' | null,
  roles: TmexRoles
): UplinkKind {
  if (standalone) return 'none';
  if (uplinkKind === 'hub' || uplinkKind === 'relay') return uplinkKind;
  if (roles.hub) return 'hub';
  if (roles.relay) return 'relay';
  return 'unknown';
}

function resolveAttached(kind: UplinkKind, mesh: MeshPresenceSource | null): boolean | 'unknown' {
  if (kind === 'none') return false;
  if (!mesh) return 'unknown';
  if (mesh.uplink.state === 'online' || mesh.attachedHub() != null) return true;
  if (kind === 'hub' && mesh.hub != null) return true;
  return false;
}

function hubOnlineIds(mesh: MeshPresenceSource): Set<string> {
  const ids = new Set<string>();
  if (mesh.uplink.state !== 'online' || !mesh.lastNodeList) return ids;
  for (const node of mesh.lastNodeList.nodes) {
    if (node.online) ids.add(node.id);
  }
  return ids;
}

function listedNodesById(mesh: MeshPresenceSource): Map<string, MeshListedNode> {
  return new Map((mesh.lastNodeList?.nodes ?? []).map((node) => [node.id, node]));
}

function collectMeshNodeIds(mesh: MeshPresenceSource): string[] {
  const certs = mesh.userStore.listCerts().filter((cert) => cert.revokedLogSeq == null);
  return [
    ...new Set([
      mesh.nodeId,
      ...certs.map((cert) => cert.nodeId),
      ...(mesh.lastNodeList?.nodes.map((node) => node.id) ?? []),
    ]),
  ];
}

function toMeshNodeView(
  id: string,
  mesh: MeshPresenceSource,
  listed: ReturnType<typeof listedNodesById>,
  registry: Map<string, { name: string; version: string | null }>,
  hubOnline: ReadonlySet<string>,
  reach: Map<string, 'lan' | 'wan' | 'relay' | null>,
  localName: string,
  localVersion: string
): MeshNodeView {
  const isSelf = id === mesh.nodeId;
  const listedNode = listed.get(id);
  const stored = registry.get(id);
  return {
    id,
    name: pickMeshNodeName({
      id,
      isSelf,
      listedName: listedNode?.name,
      registryName: stored?.name,
      selfName: localName,
    }),
    online: isSelf || hubOnline.has(id) || isPeerReachable(reach.get(id)),
    version: listedNode?.version ?? stored?.version ?? (isSelf ? localVersion : null),
    current: isSelf,
  };
}

function listMeshNodesFromMesh(
  mesh: MeshPresenceSource,
  localName: string,
  localVersion: string
): MeshNodeView[] {
  const listed = listedNodesById(mesh);
  const registry = new Map(mesh.userStore.listNodes().map((node) => [node.id, node]));
  const hubOnline = hubOnlineIds(mesh);
  const reach = mesh.peers.listReach();
  return collectMeshNodeIds(mesh).map((id) =>
    toMeshNodeView(id, mesh, listed, registry, hubOnline, reach, localName, localVersion)
  );
}

async function withDeviceRuntime<T>(
  acquire: NonNullable<MessagingRuntimeHookDeps['acquireRuntime']>,
  release: NonNullable<MessagingRuntimeHookDeps['releaseRuntime']>,
  deviceId: string,
  fn: (runtime: MessagingDeviceRuntime) => Promise<T>
): Promise<T> {
  const runtime = await acquire(deviceId);
  try {
    if (!runtime.isConnected()) {
      throw new Error('device-disconnected');
    }
    return await fn(runtime);
  } finally {
    await release(deviceId, runtime);
  }
}

function mapConfirmationError(error: unknown): DecideConfirmationResult {
  if (error instanceof AgentConfirmationNotFoundError) return { ok: false, code: 'notFound' };
  if (error instanceof AgentConfirmationAlreadyDecidedError) {
    return { ok: false, code: 'alreadyDecided' };
  }
  return { ok: false, code: 'unavailable' };
}

function buildGetUplinkStatus(deps: {
  isStandalone: () => boolean;
  roles: () => TmexRoles;
  loadIdentity: () => LocalIdentity;
  getMesh: () => MeshPresenceSource | null;
}): () => UplinkStatus {
  return () => {
    const kind = resolveUplinkKind(
      deps.isStandalone(),
      deps.loadIdentity().uplinkKind,
      deps.roles()
    );
    return { kind, attached: resolveAttached(kind, deps.getMesh()) };
  };
}

function buildListMeshNodes(deps: {
  getMesh: () => MeshPresenceSource | null;
  getLocalName: () => string;
  getVersion: () => string;
}): () => MeshNodeView[] {
  return () => {
    const mesh = deps.getMesh();
    if (!mesh) return [];
    return listMeshNodesFromMesh(mesh, deps.getLocalName(), deps.getVersion());
  };
}

function buildDeviceTreeHook(
  getSnapshot: (deviceId: string) => StateSnapshotPayload | null
): (deviceId: string) => TmuxWindowView[] | null {
  return (deviceId) => mapSnapshotToWindows(getSnapshot(deviceId));
}

function buildCapturePaneHook(
  getSnapshot: (deviceId: string) => StateSnapshotPayload | null,
  acquire: NonNullable<MessagingRuntimeHookDeps['acquireRuntime']>,
  release: NonNullable<MessagingRuntimeHookDeps['releaseRuntime']>
): (deviceId: string, paneId: string, lines: number) => Promise<string> {
  return async (deviceId, paneId, lines) => {
    if (!getSnapshot(deviceId)?.session) {
      throw new Error('capture-unavailable');
    }
    return withDeviceRuntime(acquire, release, deviceId, async (runtime) => {
      const text = await runtime.capturePaneText(paneId, { historyLines: lines });
      return stripTrailingBlankLines(text);
    });
  };
}

function buildSendKeysHook(
  getSnapshot: (deviceId: string) => StateSnapshotPayload | null,
  acquire: NonNullable<MessagingRuntimeHookDeps['acquireRuntime']>,
  release: NonNullable<MessagingRuntimeHookDeps['releaseRuntime']>
): (deviceId: string, paneId: string, text: string) => Promise<void> {
  return async (deviceId, paneId, text) => {
    if (!getSnapshot(deviceId)?.session) {
      throw new Error('send-unavailable');
    }
    await withDeviceRuntime(acquire, release, deviceId, async (runtime) => {
      await runtime.sendInputBytes(paneId, new TextEncoder().encode(text));
    });
  };
}

function buildDecideConfirmationHook(
  resolveConfirmation: NonNullable<MessagingRuntimeHookDeps['resolveConfirmation']>
): (confirmationId: string, approved: boolean, reason?: string) => DecideConfirmationResult {
  return (confirmationId, approved, reason) => {
    try {
      resolveConfirmation(confirmationId, approved, reason);
      return { ok: true };
    } catch (error) {
      return mapConfirmationError(error);
    }
  };
}

export function createMessagingRuntimeHooks(
  overrides: MessagingRuntimeHookDeps = {}
): MessagingRuntimeHooks {
  const getSnapshot = overrides.getSnapshot ?? getDeviceSnapshot;
  const acquireRuntime =
    overrides.acquireRuntime ?? ((deviceId) => tmuxRuntimeRegistry.acquire(deviceId));
  const releaseRuntime =
    overrides.releaseRuntime ??
    ((deviceId, runtime) => tmuxRuntimeRegistry.release(deviceId, runtime));
  const resolveConfirmation =
    overrides.resolveConfirmation ??
    ((confirmationId, approved, reason) => {
      agentSupervisor.resolveConfirmation(confirmationId, approved, reason);
    });
  const isStandalone = overrides.isStandalone ?? (() => isStandaloneRoles(config.roles));
  const roles = overrides.roles ?? (() => config.roles);
  const loadIdentity = overrides.loadIdentity ?? loadLocalIdentity;
  const getMesh = overrides.getMesh ?? defaultGetMesh;
  const getLocalName = overrides.getLocalName ?? defaultLocalName;
  const getVersion = overrides.getVersion ?? getDisplayVersion;

  return {
    getUplinkStatus: buildGetUplinkStatus({ isStandalone, roles, loadIdentity, getMesh }),
    listMeshNodes: buildListMeshNodes({ getMesh, getLocalName, getVersion }),
    getDeviceTree: buildDeviceTreeHook(getSnapshot),
    capturePane: buildCapturePaneHook(getSnapshot, acquireRuntime, releaseRuntime),
    sendKeys: buildSendKeysHook(getSnapshot, acquireRuntime, releaseRuntime),
    decideConfirmation: buildDecideConfirmationHook(resolveConfirmation),
  };
}
